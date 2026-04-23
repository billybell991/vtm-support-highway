/**
 * api.js — Direct REST API clients for Jira Server, Zendesk, and Aha.
 * No backend needed. Credentials come from chrome.storage.local via Settings.
 */

const API = (() => {
  // ────── Helpers ──────
  function jiraHeaders(cfg) {
    const headers = { 'Accept': 'application/json' };
    if (cfg.jiraUser && cfg.jiraPass) {
      headers['Authorization'] = 'Basic ' + btoa(cfg.jiraUser + ':' + cfg.jiraPass);
    }
    // If no user/pass, rely on browser cookies (active Jira session)
    return headers;
  }

  function zdHeaders(cfg) {
    const headers = { 'Accept': 'application/json' };
    if (cfg.zdToken) {
      // API token auth
      headers['Authorization'] = 'Basic ' + btoa(cfg.zdEmail + '/token:' + cfg.zdToken);
    }
    // If no token, rely on browser cookies (SSO session) — no Authorization header needed
    return headers;
  }

  function zdMutateHeaders(cfg) {
    const headers = {
      ...zdHeaders(cfg),
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest'   // helps bypass CSRF for AJAX
    };
    return headers;
  }

  /** Fetch Zendesk CSRF token from the agent page (needed for session/cookie auth) */
  let _zdCsrfToken = null;
  async function getZdCsrfToken(cfg) {
    // If API token is configured, no CSRF needed
    if (cfg.zdToken) return null;
    if (_zdCsrfToken) return _zdCsrfToken;

    // Try fetching CSRF from the agent HTML page
    const pages = ['/agent/', '/'];
    for (const page of pages) {
      try {
        const resp = await fetch(cfg.zdUrl.replace(/\/+$/, '') + page, {
          credentials: 'include'
        });
        const html = await resp.text();
        // Try multiple meta tag patterns
        const match = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/) ||
                      html.match(/name="csrf-token"\s+content="([^"]+)"/) ||
                      html.match(/"authenticity_token"\s*:\s*"([^"]+)"/) ||
                      html.match(/"csrf_token"\s*:\s*"([^"]+)"/);
        if (match) {
          _zdCsrfToken = match[1];
          return _zdCsrfToken;
        }
      } catch (e) { /* try next page */ }
    }
    return null;
  }

  /** Clear cached CSRF token (call on auth failure retry) */
  function clearZdCsrfCache() { _zdCsrfToken = null; }

  // Priority maps (from AION codebase)
  const ZD_TO_JIRA_PRIORITY = { urgent: 'Critical', high: 'High', normal: 'Medium', low: 'Low' };
  const JIRA_TO_ZD_PRIORITY = { Blocker: 'urgent', Critical: 'urgent', Highest: 'urgent', High: 'high', Medium: 'normal', Low: 'low', Lowest: 'low' };

  // ────── JIRA SERVER ──────
  async function jiraGet(cfg, path) {
    const resp = await fetch(cfg.jiraUrl.replace(/\/+$/, '') + path, {
      headers: jiraHeaders(cfg),
      credentials: 'include'  // send cookies for active Jira session
    });
    if (!resp.ok) throw new Error('Jira GET ' + path + ' → ' + resp.status + ' ' + resp.statusText);
    return resp.json();
  }

  async function jiraPost(cfg, path, body) {
    const resp = await fetch(cfg.jiraUrl.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: { ...jiraHeaders(cfg), 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const text = await resp.text();
      let detail = resp.statusText;
      try { detail = JSON.parse(text).errors || JSON.parse(text).errorMessages || text; } catch (_) { detail = text; }
      throw new Error('Jira POST ' + path + ' → ' + resp.status + ': ' + JSON.stringify(detail));
    }
    return resp.json();
  }

  async function jiraPut(cfg, path, body) {
    const resp = await fetch(cfg.jiraUrl.replace(/\/+$/, '') + path, {
      method: 'PUT',
      headers: { ...jiraHeaders(cfg), 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const text = await resp.text();
      let detail = resp.statusText;
      try { detail = JSON.parse(text).errors || JSON.parse(text).errorMessages || text; } catch (_) { detail = text; }
      throw new Error('Jira PUT ' + path + ' → ' + resp.status + ': ' + JSON.stringify(detail));
    }
    // Jira PUT /issue returns 204 No Content on success
    if (resp.status === 204) return {};
    return resp.json();
  }

  /** Fetch a Jira issue by key (e.g. SUP-12345) */
  async function fetchJiraTicket(cfg, key) {
    const data = await jiraGet(cfg, '/rest/api/2/issue/' + encodeURIComponent(key) + '?expand=renderedFields');
    const f = data.fields || {};
    return {
      source: 'jira',
      key: data.key,
      id: data.id,
      summary: f.summary || '',
      description: f.description || '',
      originalSubmittal: (f.customfield_11106 || ''),
      priority: (f.priority && f.priority.name) || 'Medium',
      priorityZd: JIRA_TO_ZD_PRIORITY[(f.priority && f.priority.name)] || 'normal',
      issueType: (f.issuetype && f.issuetype.name) || 'Bug',
      status: (f.status && f.status.name) || '',
      project: (f.project && f.project.key) || '',
      labels: (f.labels || []).join(', '),
      components: (f.components || []).map(c => c.name).join(', '),
      reporter: (f.reporter && f.reporter.displayName) || '',
      assignee: (f.assignee && f.assignee.displayName) || '',
      url: cfg.jiraUrl.replace(/\/+$/, '') + '/browse/' + data.key,
      raw: data
    };
  }

  /** Fetch the create-screen field keys for a project + issue type */
  async function fetchJiraCreateMeta(cfg, projectKey, issueTypeName) {
    const path = '/rest/api/2/issue/createmeta'
      + '?projectKeys=' + encodeURIComponent(projectKey)
      + '&issuetypeNames=' + encodeURIComponent(issueTypeName)
      + '&expand=projects.issuetypes.fields';
    const data = await jiraGet(cfg, path);
    const proj = (data.projects || [])[0];
    const itype = proj && (proj.issuetypes || [])[0];
    const fieldMap = (itype && itype.fields) || {};
    console.log('[API] createMeta for ' + projectKey + '/' + issueTypeName + ' — fields on screen:', Object.keys(fieldMap).join(', '));
    return fieldMap; // keys are field IDs, values have { required, name, schema, allowedValues, ... }
  }

  /** Create a Jira issue */
  async function createJiraTicket(cfg, fields) {
    console.log('[API] createJiraTicket fields:', JSON.stringify(fields));

    // Query create-meta to know exactly which fields are on the screen
    const meta = await fetchJiraCreateMeta(cfg, fields.project, fields.issueType || 'Support');
    const onScreen = (fid) => fid in meta;

    const body = {
      fields: {
        project: { key: fields.project },
        summary: fields.summary,
        description: fields.description || '',
        issuetype: { name: fields.issueType || 'Support' },
        priority: { name: fields.priority || 'Medium' }
      }
    };

    // Optional fields — only include if they're on the create screen
    if (fields.components && onScreen('components')) {
      const names = typeof fields.components === 'string'
        ? fields.components.split(',').map(s => s.trim()).filter(Boolean)
        : [fields.components].filter(Boolean);
      body.fields.components = names.map(n => ({ name: n }));
    }
    if (fields.originalSubmittal && onScreen('customfield_11106')) {
      body.fields.customfield_11106 = fields.originalSubmittal;
    }
    if (fields.client && onScreen('customfield_10000')) {
      body.fields.customfield_10000 = Array.isArray(fields.client)
        ? fields.client : [fields.client];
    }
    if (fields.contact && onScreen('customfield_10001')) {
      body.fields.customfield_10001 = fields.contact;
    }
    if (fields.severity && onScreen('customfield_10506')) {
      body.fields.customfield_10506 = { value: fields.severity };
    }
    if (fields.refNumber && onScreen('customfield_10904')) {
      body.fields.customfield_10904 = fields.refNumber;
    }
    if (fields.product && onScreen('customfield_11105')) {
      body.fields.customfield_11105 = { value: fields.product };
    }

    console.log('[API] Jira POST body:', JSON.stringify(body));
    const data = await jiraPost(cfg, '/rest/api/2/issue', body);
    return {
      key: data.key,
      id: data.id,
      url: cfg.jiraUrl.replace(/\/+$/, '') + '/browse/' + data.key
    };
  }

  /** Update fields on an existing Jira issue */
  async function updateJiraTicket(cfg, issueKey, fields) {
    const body = { fields: {} };
    if (fields.summary !== undefined) body.fields.summary = fields.summary;
    if (fields.description !== undefined) body.fields.description = fields.description;
    if (fields.priority) body.fields.priority = { name: fields.priority };
    if (fields.components) {
      const names = typeof fields.components === 'string'
        ? fields.components.split(',').map(s => s.trim()).filter(Boolean)
        : [fields.components].filter(Boolean);
      body.fields.components = names.map(n => ({ name: n }));
    }
    if (fields.originalSubmittal !== undefined) {
      body.fields.customfield_11106 = fields.originalSubmittal;
    }
    return jiraPut(cfg, '/rest/api/2/issue/' + encodeURIComponent(issueKey), body);
  }

  /** Add a comment to a Jira issue */
  async function addJiraComment(cfg, issueKey, commentBody) {
    return jiraPost(cfg, '/rest/api/2/issue/' + encodeURIComponent(issueKey) + '/comment', {
      body: commentBody
    });
  }

  /** Add a remote link to the Links section of a Jira issue */
  async function addJiraRemoteLink(cfg, issueKey, url, title, appName) {
    return jiraPost(cfg, '/rest/api/2/issue/' + encodeURIComponent(issueKey) + '/remotelink', {
      object: {
        url: url,
        title: title || url,
        icon: {
          url16x16: (new URL(url)).origin + '/favicon.ico',
          title: appName || 'External'
        }
      }
    });
  }

  /** Get existing remote links for a Jira issue (for duplicate check) */
  async function getJiraRemoteLinks(cfg, issueKey) {
    return jiraGet(cfg, '/rest/api/2/issue/' + encodeURIComponent(issueKey) + '/remotelink');
  }

  /** Fetch components for a Jira project */
  async function fetchJiraComponents(cfg, projectKey) {
    const data = await jiraGet(cfg, '/rest/api/2/project/' + encodeURIComponent(projectKey) + '/components');
    return (data || []).map(c => ({ id: c.id, name: c.name }));
  }

  /** Fetch issue types available for a Jira project */
  async function fetchJiraIssueTypes(cfg, projectKey) {
    const data = await jiraGet(cfg, '/rest/api/2/project/' + encodeURIComponent(projectKey));
    return (data.issueTypes || [])
      .filter(t => !t.subtask)
      .map(t => ({ id: t.id, name: t.name }));
  }

  // ────── ZENDESK ──────
  async function zdGet(cfg, path) {
    const resp = await fetch(cfg.zdUrl.replace(/\/+$/, '') + path, {
      headers: zdHeaders(cfg),
      credentials: 'include'  // send cookies for SSO session auth
    });
    if (!resp.ok) throw new Error('Zendesk GET ' + path + ' → ' + resp.status + ' ' + resp.statusText);
    return resp.json();
  }

  async function zdPost(cfg, path, body) {
    const headers = zdMutateHeaders(cfg);
    const csrf = await getZdCsrfToken(cfg);
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const resp = await fetch(cfg.zdUrl.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: headers,
      credentials: 'include',
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      if (resp.status === 403) clearZdCsrfCache(); // token may have expired
      const text = await resp.text();
      throw new Error('Zendesk POST ' + path + ' → ' + resp.status + ': ' + text);
    }
    return resp.json();
  }

  async function zdPut(cfg, path, body) {
    const headers = zdMutateHeaders(cfg);
    const csrf = await getZdCsrfToken(cfg);
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const resp = await fetch(cfg.zdUrl.replace(/\/+$/, '') + path, {
      method: 'PUT',
      headers: headers,
      credentials: 'include',
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      if (resp.status === 403) clearZdCsrfCache();
      const text = await resp.text();
      throw new Error('Zendesk PUT ' + path + ' → ' + resp.status + ': ' + text);
    }
    return resp.json();
  }

  async function zdDelete(cfg, path) {
    const headers = zdMutateHeaders(cfg);
    const csrf = await getZdCsrfToken(cfg);
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const resp = await fetch(cfg.zdUrl.replace(/\/+$/, '') + path, {
      method: 'DELETE',
      headers: headers,
      credentials: 'include'
    });
    if (!resp.ok) {
      if (resp.status === 403) clearZdCsrfCache();
      const text = await resp.text();
      throw new Error('Zendesk DELETE ' + path + ' → ' + resp.status + ': ' + text);
    }
    // DELETE returns 204 No Content on success
    return {};
  }

  /** Fetch a Zendesk ticket by ID (enriched with requester + org) */
  async function fetchZdTicket(cfg, ticketId) {
    const data = await zdGet(cfg, '/api/v2/tickets/' + encodeURIComponent(ticketId) + '.json');
    const t = data.ticket || {};

    // Fetch requester details (name + email for Contact field)
    let requesterName = '', requesterEmail = '', orgName = '';
    if (t.requester_id) {
      try {
        const uData = await zdGet(cfg, '/api/v2/users/' + t.requester_id + '.json');
        const u = uData.user || {};
        requesterName = u.name || '';
        requesterEmail = u.email || '';
        if (u.organization_id) {
          try {
            const oData = await zdGet(cfg, '/api/v2/organizations/' + u.organization_id + '.json');
            orgName = (oData.organization && oData.organization.name) || '';
          } catch (e) { /* org fetch optional */ }
        }
      } catch (e) { /* requester fetch optional */ }
    }

    return {
      source: 'zendesk',
      id: t.id,
      key: 'ZD-' + t.id,
      summary: t.subject || '',
      description: t.description || '',
      priority: t.priority || 'normal',
      priorityJira: ZD_TO_JIRA_PRIORITY[t.priority] || 'Medium',
      status: t.status || '',
      tags: (t.tags || []).join(', '),
      requester_id: t.requester_id,
      requesterName: requesterName,
      requesterEmail: requesterEmail,
      organization: orgName,
      url: cfg.zdUrl.replace(/\/+$/, '') + '/agent/tickets/' + t.id,
      raw: t
    };
  }

  /** Create a Zendesk ticket */
  /** Auto-detect current Zendesk user's default group and brand from session */
  let _zdSessionInfo = null;
  async function getZdSessionInfo(cfg) {
    if (_zdSessionInfo) return _zdSessionInfo;
    try {
      const me = await zdGet(cfg, '/api/v2/users/me.json');
      const user = me.user || {};
      _zdSessionInfo = {
        userId: user.id,
        email: user.email,
        name: user.name,
        defaultGroupId: user.default_group_id || null
      };
      // Also get the first brand we have access to
      try {
        const brands = await zdGet(cfg, '/api/v2/brands.json');
        if (brands.brands && brands.brands.length > 0) {
          // Prefer the default brand, otherwise first active one
          const dflt = brands.brands.find(b => b.default) || brands.brands.find(b => b.active) || brands.brands[0];
          _zdSessionInfo.brandId = dflt.id;
        }
      } catch (e) { /* brands endpoint may not be accessible */ }
      console.log('[ZD session]', JSON.stringify(_zdSessionInfo));
      return _zdSessionInfo;
    } catch (e) {
      console.warn('Failed to get ZD session info:', e);
      return null;
    }
  }

  /** Resolve a Zendesk user ID by email address */
  async function resolveZdUserId(cfg, email) {
    if (!email) return null;
    try {
      const data = await zdGet(cfg, '/api/v2/users/search.json?query=' + encodeURIComponent(email));
      if (data.users && data.users.length > 0) return data.users[0].id;
    } catch (e) {
      console.warn('ZD user lookup failed for', email, e);
    }
    return null;
  }

  /** Resolve a Zendesk user ID → display name (cached) */
  const _zdUserCache = {};
  async function resolveZdUserName(cfg, authorId) {
    if (!authorId) return null;
    if (_zdUserCache[authorId]) return _zdUserCache[authorId];
    try {
      const data = await zdGet(cfg, '/api/v2/users/' + encodeURIComponent(authorId) + '.json');
      const name = data.user && data.user.name;
      if (name) _zdUserCache[authorId] = name;
      return name || null;
    } catch (e) {
      console.warn('[API] ZD user lookup failed for ID ' + authorId, e);
      return null;
    }
  }

  async function createZdTicket(cfg, fields) {
    // Auto-detect session defaults (brand, group, user)
    const session = await getZdSessionInfo(cfg);

    const comment = { body: fields.description || 'No description provided' };
    if (fields.uploads && fields.uploads.length) {
      comment.uploads = fields.uploads;
    }
    const body = {
      ticket: {
        subject: fields.summary,
        comment: comment,
        priority: fields.priority || 'normal',
        type: fields.type || 'incident',
        external_id: fields.external_id || ''
      }
    };

    // Brand: use config override, else auto-detected from session
    const brandId = cfg.zdBrandId || (session && session.brandId);
    if (brandId) body.ticket.brand_id = parseInt(brandId, 10);

    // Group: use session default group so ticket lands somewhere you can see
    if (session && session.defaultGroupId) {
      body.ticket.group_id = session.defaultGroupId;
    }

    // Assignee: config override, else assign to self
    if (cfg.zdAssigneeEmail) {
      const assigneeId = await resolveZdUserId(cfg, cfg.zdAssigneeEmail);
      if (assigneeId) body.ticket.assignee_id = assigneeId;
    } else if (session && session.userId) {
      body.ticket.assignee_id = session.userId;
    }

    // Tags
    if (fields.tags) {
      body.ticket.tags = fields.tags.split(',').map(s => s.trim()).filter(Boolean);
    }

    const data = await zdPost(cfg, '/api/v2/tickets.json', body);
    const t = data.ticket || {};
    return {
      id: t.id,
      key: 'ZD-' + t.id,
      url: cfg.zdUrl.replace(/\/+$/, '') + '/agent/tickets/' + t.id
    };
  }

  /** Update fields on an existing Zendesk ticket */
  async function updateZdTicket(cfg, ticketId, fields) {
    const ticket = {};
    if (fields.summary !== undefined) ticket.subject = fields.summary;
    if (fields.priority) ticket.priority = fields.priority;
    if (fields.type) ticket.type = fields.type;
    if (fields.tags) {
      ticket.tags = typeof fields.tags === 'string'
        ? fields.tags.split(',').map(s => s.trim()).filter(Boolean) : fields.tags;
    }
    return zdPut(cfg, '/api/v2/tickets/' + encodeURIComponent(ticketId) + '.json', { ticket });
  }

  /** Add an internal note to a Zendesk ticket */
  async function addZdInternalNote(cfg, ticketId, htmlBody) {
    return zdPut(cfg, '/api/v2/tickets/' + encodeURIComponent(ticketId) + '.json', {
      ticket: {
        comment: {
          html_body: htmlBody,
          public: false
        }
      }
    });
  }

  /** Delete a comment from a Zendesk ticket (cannot delete the first comment/description) */
  async function deleteZdComment(cfg, ticketId, commentId) {
    return zdDelete(cfg, '/api/v2/tickets/' + encodeURIComponent(ticketId) + '/comments/' + encodeURIComponent(commentId) + '.json');
  }

  /** Permanently delete an upload/attachment from Zendesk */
  async function deleteZdAttachment(cfg, attachmentId) {
    return zdDelete(cfg, '/api/v2/attachments/' + encodeURIComponent(attachmentId) + '.json');
  }

  /** Fetch groups the current user can assign tickets to */
  async function fetchZdGroups(cfg) {
    const data = await zdGet(cfg, '/api/v2/groups.json');
    return (data.groups || []).map(g => ({ id: g.id, name: g.name }));
  }

  // ────── DUPLICATE DETECTION ──────

  /** Check if a Zendesk ticket already exists for this source ticket (by external_id or subject search) */
  async function findExistingZdClone(cfg, sourceKey) {
    // First: check by external_id (most reliable)
    try {
      const data = await zdGet(cfg, '/api/v2/tickets.json?external_id=' + encodeURIComponent(sourceKey));
      if (data.tickets && data.tickets.length > 0) {
        const t = data.tickets[0];
        return { id: t.id, key: 'ZD-' + t.id, url: cfg.zdUrl.replace(/\/+$/, '') + '/agent/tickets/' + t.id };
      }
    } catch (e) { /* fall through to search */ }

    // Fallback: search by subject containing the source key
    try {
      const data = await zdGet(cfg, '/api/v2/search.json?query=' + encodeURIComponent('type:ticket subject:"[' + sourceKey + ']"'));
      if (data.results && data.results.length > 0) {
        const t = data.results[0];
        return { id: t.id, key: 'ZD-' + t.id, url: cfg.zdUrl.replace(/\/+$/, '') + '/agent/tickets/' + t.id };
      }
    } catch (e) { /* not found */ }

    return null;
  }

  /** Check if a Jira ticket already exists for this source ticket (by JQL summary search) */
  async function findExistingJiraClone(cfg, sourceKey) {
    try {
      const jql = 'summary ~ "\\[' + sourceKey + '\\]" ORDER BY created DESC';
      console.log('[API] Jira clone search JQL:', jql);
      const data = await jiraGet(cfg, '/rest/api/2/search?jql=' + encodeURIComponent(jql) + '&maxResults=1&fields=summary');
      console.log('[API] Jira clone search result:', data.total, 'hits', data.issues && data.issues.length ? '→ ' + data.issues[0].key : '→ none');
      if (data.issues && data.issues.length > 0) {
        const issue = data.issues[0];
        return { key: issue.key, id: issue.id, url: cfg.jiraUrl.replace(/\/+$/, '') + '/browse/' + issue.key };
      }
    } catch (e) {
      console.error('[API] Jira clone search failed:', e);
    }
    return null;
  }

  // ────── AHA (Phase 2 placeholder) ──────
  async function fetchAhaIdea(cfg, ideaRef) {
    throw new Error('Aha integration is Phase 2 — not yet implemented');
  }
  async function createAhaIdea(cfg, fields) {
    throw new Error('Aha integration is Phase 2 — not yet implemented');
  }

  // ────── JIRA: COMMENTS & ATTACHMENTS ──────

  /** Fetch all comments for a Jira issue */
  async function fetchJiraComments(cfg, issueKey) {
    const data = await jiraGet(cfg, '/rest/api/2/issue/' + encodeURIComponent(issueKey) + '/comment');
    return (data.comments || []).map(c => ({
      id: c.id,
      author: (c.author && c.author.displayName) || 'Unknown',
      body: c.body || '',
      created: c.created,
      updated: c.updated
    }));
  }

  /** Fetch attachment metadata for a Jira issue */
  async function fetchJiraAttachments(cfg, issueKey) {
    const data = await jiraGet(cfg, '/rest/api/2/issue/' + encodeURIComponent(issueKey) + '?fields=attachment');
    return ((data.fields && data.fields.attachment) || []).map(a => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      contentUrl: a.content,  // direct download URL
      author: (a.author && a.author.displayName) || '',
      created: a.created
    }));
  }

  /** Download a Jira attachment as a Blob */
  async function downloadJiraAttachment(cfg, contentUrl) {
    const resp = await fetch(contentUrl, {
      headers: jiraHeaders(cfg),
      credentials: 'include'
    });
    if (!resp.ok) throw new Error('Download failed: ' + resp.status);
    return resp.blob();
  }

  /** Upload an attachment to a Jira issue */
  async function uploadJiraAttachment(cfg, issueKey, filename, blob) {
    const form = new FormData();
    form.append('file', blob, filename);
    const hdrs = { ...jiraHeaders(cfg), 'X-Atlassian-Token': 'no-check' };
    delete hdrs['Content-Type']; // let browser set multipart boundary
    const resp = await fetch(
      cfg.jiraUrl.replace(/\/+$/, '') + '/rest/api/2/issue/' + encodeURIComponent(issueKey) + '/attachments',
      { method: 'POST', headers: hdrs, credentials: 'include', body: form }
    );
    if (!resp.ok) throw new Error('Jira attach upload failed: ' + resp.status);
    return resp.json();
  }

  // ────── ZENDESK: COMMENTS & ATTACHMENTS ──────

  /** Fetch all comments for a Zendesk ticket */
  async function fetchZdComments(cfg, ticketId) {
    const data = await zdGet(cfg, '/api/v2/tickets/' + encodeURIComponent(ticketId) + '/comments.json');
    return (data.comments || []).map(c => ({
      id: c.id,
      author_id: c.author_id,
      body: c.body || '',
      html_body: c.html_body || '',
      public: c.public,
      created: c.created_at,
      attachments: (c.attachments || []).map(a => ({
        id: a.id,
        filename: a.file_name,
        contentUrl: a.content_url,
        mimeType: a.content_type,
        size: a.size
      }))
    }));
  }

  /** Download a Zendesk attachment as a Blob */
  async function downloadZdAttachment(cfg, contentUrl) {
    // Don't send Accept: application/json — CDN returns 406 for non-JSON accepts
    const resp = await fetch(contentUrl, {
      credentials: 'include'
    });
    if (!resp.ok) throw new Error('Download failed: ' + resp.status);
    return resp.blob();
  }

  /** Upload a file to Zendesk and get an upload token */
  async function uploadZdAttachment(cfg, filename, blob) {
    const hdrs = {
      ...zdHeaders(cfg),
      'Content-Type': blob.type || 'application/octet-stream',
      'X-Requested-With': 'XMLHttpRequest'
    };
    const csrf = await getZdCsrfToken(cfg);
    if (csrf) hdrs['X-CSRF-Token'] = csrf;
    const resp = await fetch(
      cfg.zdUrl.replace(/\/+$/, '') + '/api/v2/uploads.json?filename=' + encodeURIComponent(filename),
      {
        method: 'POST',
        headers: hdrs,
        credentials: 'include',
        body: blob
      }
    );
    if (!resp.ok) throw new Error('Zendesk upload failed: ' + resp.status);
    const data = await resp.json();
    const att = (data.upload.attachment || data.upload.attachments && data.upload.attachments[0]) || {};
    return {
      token: data.upload.token,
      contentUrl: att.content_url || '',
      filename: att.file_name || filename
    };
  }

  /** Add a comment to Zendesk with optional attachment tokens */
  async function addZdComment(cfg, ticketId, body, uploadTokens, isPublic) {
    const comment = {
      html_body: body,
      public: isPublic !== undefined ? isPublic : false
    };
    if (uploadTokens && uploadTokens.length) {
      comment.uploads = uploadTokens;
    }
    return zdPut(cfg, '/api/v2/tickets/' + encodeURIComponent(ticketId) + '.json', {
      ticket: { comment }
    });
  }

  // ────── PUBLIC API ──────
  return {
    fetchJiraTicket, createJiraTicket, updateJiraTicket, addJiraComment, addJiraRemoteLink, getJiraRemoteLinks, fetchJiraComponents, fetchJiraIssueTypes, fetchJiraCreateMeta,
    fetchJiraComments, fetchJiraAttachments, downloadJiraAttachment, uploadJiraAttachment,
    fetchZdTicket, createZdTicket, updateZdTicket, addZdInternalNote, deleteZdComment, deleteZdAttachment, resolveZdUserId, resolveZdUserName,
    fetchZdComments, downloadZdAttachment, uploadZdAttachment, addZdComment,
    fetchZdGroups, findExistingZdClone, findExistingJiraClone,
    fetchAhaIdea, createAhaIdea,
    ZD_TO_JIRA_PRIORITY, JIRA_TO_ZD_PRIORITY
  };
})();
