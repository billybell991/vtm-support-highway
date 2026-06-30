/**
 * api.js — Direct REST API clients for Jira Cloud, Zendesk, and Aha.
 * No backend needed. Credentials come from chrome.storage.local via Settings.
 *
 * Jira Cloud auth: Basic with email:api_token (base64-encoded).
 * Jira Cloud does NOT support session-cookie auth from extensions.
 */

const API = (() => {
  // ────── Helpers ──────
  function jiraHeaders(cfg) {
    const headers = { 'Accept': 'application/json' };
    if (cfg.jiraUser && cfg.jiraPass) {
      // Jira Cloud: Basic with email:api_token. Jira Server/DC: Basic with username:password.
      headers['Authorization'] = 'Basic ' + btoa(cfg.jiraUser + ':' + cfg.jiraPass);
    } else if (cfg.jiraPass) {
      // Jira Server/DC Personal Access Token — no username, send as Bearer.
      headers['Authorization'] = 'Bearer ' + cfg.jiraPass;
    }
    return headers;
  }

  /** Build a richer error string for Jira non-OK responses, including
   *  Server/DC auth-denial reasons (CAPTCHA lockout, etc.) when present. */
  function jiraErrorDetail(resp, bodyText) {
    const reason = resp.headers.get('X-Authentication-Denied-Reason') ||
                   resp.headers.get('X-Seraph-LoginReason') || '';
    let detail = resp.statusText || '';
    if (bodyText) {
      try {
        const j = JSON.parse(bodyText);
        detail = j.errorMessages && j.errorMessages.length ? j.errorMessages.join('; ')
               : (j.errors ? JSON.stringify(j.errors) : (j.message || bodyText));
      } catch (_) { detail = bodyText; }
    }
    if (resp.status === 401) {
      if (/CAPTCHA/i.test(reason)) {
        detail = 'Jira CAPTCHA lockout — open ' + resp.url.split('/rest/')[0] + ' in your browser, log in & solve the CAPTCHA, then retry.';
      } else if (reason) {
        detail = 'Auth denied (' + reason + ') — check on-prem Jira credentials / PAT in Settings.';
      } else if (!detail || detail === 'Unauthorized') {
        detail = 'Unauthorized — check on-prem Jira username/password (or Personal Access Token) in Settings.';
      }
    }
    return detail;
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
  const ZD_TO_JIRA_PRIORITY = { urgent: 'P1', high: 'P2', normal: 'P3', low: 'P4' };
  const JIRA_TO_ZD_PRIORITY = { P1: 'urgent', P2: 'high', P3: 'normal', P4: 'low', P5: 'low', Blocker: 'urgent', Critical: 'urgent', Highest: 'urgent', High: 'high', Medium: 'normal', Low: 'low', Lowest: 'low' };

  /**
   * Resolve a requested Jira priority name against the project's actual allowed
   * priority values (which can be renamed/restricted by admins via priority schemes).
   * Returns the wire-format object to send (preferring {id} when available) or
   * null if no reasonable match exists — in which case the caller should omit
   * the priority field entirely so Jira applies the scheme default.
   */
  function resolveJiraPriority(meta, requested) {
    const allowed = (meta && meta.priority && meta.priority.allowedValues) || [];
    if (!allowed.length) {
      // Field not on screen, or admin returned no list — pass name through unvalidated
      return requested ? { name: requested } : null;
    }
    const want = String(requested || 'Medium').toLowerCase().trim();

    // Common cross-scheme synonyms so renamed/rebranded schemes still work
    const SYNONYMS = {
      blocker:  ['blocker', 'highest', 'critical', 'urgent', 'p1', 'severity 1', 'sev 1'],
      highest:  ['highest', 'blocker', 'critical', 'urgent', 'p1', 'severity 1', 'sev 1'],
      critical: ['critical', 'highest', 'blocker', 'urgent', 'p1', 'severity 1', 'sev 1'],
      urgent:   ['urgent', 'critical', 'highest', 'blocker', 'p1'],
      high:     ['high', 'major', 'p2', 'severity 2', 'sev 2'],
      medium:   ['medium', 'normal', 'moderate', 'standard', 'p3', 'severity 3', 'sev 3'],
      normal:   ['normal', 'medium', 'moderate', 'standard', 'p3', 'severity 3', 'sev 3'],
      low:      ['low', 'minor', 'p4', 'severity 4', 'sev 4'],
      lowest:   ['lowest', 'trivial', 'low', 'minor', 'p5', 'severity 5', 'sev 5'],
      trivial:  ['trivial', 'lowest', 'low', 'minor', 'p5']
    };

    // 1) Exact (case-insensitive) match
    let hit = allowed.find(a => a.name && a.name.toLowerCase() === want);
    // 2) Synonym match in either direction
    if (!hit) {
      const wantSyns = SYNONYMS[want] || [want];
      hit = allowed.find(a => {
        const an = a.name && a.name.toLowerCase();
        if (!an) return false;
        if (wantSyns.includes(an)) return true;
        const aSyns = SYNONYMS[an] || [];
        return aSyns.includes(want);
      });
    }
    // 3) Sensible default: pick the middle of the list when nothing matches
    if (!hit && allowed.length) {
      const mid = allowed[Math.floor(allowed.length / 2)];
      console.warn('[API] Priority "' + requested + '" not in allowed list ['
        + allowed.map(a => a.name).join(', ') + '] — falling back to "' + mid.name + '"');
      hit = mid;
    }
    if (!hit) return null;
    // Prefer id when available (more robust against rename) — fall back to name
    return hit.id ? { id: String(hit.id) } : { name: hit.name };
  }


  // ────── JIRA SERVER ──────
  async function jiraGet(cfg, path) {
    const resp = await fetch(cfg.jiraUrl.replace(/\/+$/, '') + path, {
      headers: jiraHeaders(cfg)
    });
    if (!resp.ok) {
      let text = '';
      try { text = await resp.text(); } catch (_) {}
      throw new Error('Jira GET ' + path + ' → ' + resp.status + ': ' + jiraErrorDetail(resp, text));
    }
    return resp.json();
  }

  async function jiraPost(cfg, path, body) {
    const resp = await fetch(cfg.jiraUrl.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: { ...jiraHeaders(cfg), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error('Jira POST ' + path + ' → ' + resp.status + ': ' + jiraErrorDetail(resp, text));
    }
    return resp.json();
  }

  async function jiraPut(cfg, path, body) {
    const resp = await fetch(cfg.jiraUrl.replace(/\/+$/, '') + path, {
      method: 'PUT',
      headers: { ...jiraHeaders(cfg), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error('Jira PUT ' + path + ' → ' + resp.status + ': ' + jiraErrorDetail(resp, text));
    }
    // Jira PUT /issue returns 204 No Content on success
    if (resp.status === 204) return {};
    return resp.json();
  }

  /** Fetch a Jira issue by key (e.g. CRMS-37) */
  async function fetchJiraTicket(cfg, key) {
    const data = await jiraGet(cfg, '/rest/api/2/issue/' + encodeURIComponent(key) + '?expand=renderedFields');
    const f = data.fields || {};
    // Client/Contact are option arrays: [{value:"Saskatoon",...}]
    const clientVal = (f.customfield_10844 || []).map(v => v.value).join(', ');
    const contactVal = (f.customfield_10845 || []).map(v => v.value).join(', ');
    return {
      source: 'jira',
      key: data.key,
      id: data.id,
      summary: f.summary || '',
      description: f.description || '',
      originalSubmittal: (f.customfield_10843 || ''),
      stepsToReproduce: (f.customfield_10847 || ''),
      fixBuild: (f.customfield_10842 || ''),
      client: clientVal,
      contact: contactVal,
      severity: (f.customfield_10505 && f.customfield_10505.value) || 'Normal',
      component: (f.customfield_10809 && f.customfield_10809.value) || '',
      priority: (f.priority && f.priority.name) || 'P3',
      priorityZd: JIRA_TO_ZD_PRIORITY[(f.priority && f.priority.name)] || 'normal',
      issueType: (f.issuetype && f.issuetype.name) || 'Support Defect',
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

  /** Fetch the create-screen field keys for a project + issue type.
   * Tries the Jira Cloud paginated endpoint first; falls back to the legacy
   * expand-based endpoint for compatibility.
   */
  async function fetchJiraCreateMeta(cfg, projectKey, issueTypeName) {
    // Step 1: find the issue type ID by name
    try {
      const typesData = await jiraGet(cfg,
        '/rest/api/2/issue/createmeta/' + encodeURIComponent(projectKey) + '/issuetypes?maxResults=50');
      const types = typesData.values || typesData.issueTypes || [];
      const itype = types.find(t => t.name === issueTypeName) || types[0];
      if (itype && itype.id) {
        // Step 2: fetch fields for this issue type
        const fieldsData = await jiraGet(cfg,
          '/rest/api/2/issue/createmeta/' + encodeURIComponent(projectKey)
          + '/issuetypes/' + encodeURIComponent(itype.id) + '?maxResults=200');
        const fieldArr = fieldsData.values || fieldsData.fields || [];
        const fieldMap = {};
        for (const f of fieldArr) { if (f.fieldId) fieldMap[f.fieldId] = f; }
        console.log('[API] createMeta (Cloud) for ' + projectKey + '/' + itype.name + ' — fields:', Object.keys(fieldMap).join(', '));
        return { fields: fieldMap, resolvedIssueType: itype.name };
      }
    } catch (e) {
      console.warn('[API] Cloud createMeta endpoint failed, falling back:', e.message);
    }

    // Fallback: legacy endpoint (Jira Server / older Cloud)
    const path = '/rest/api/2/issue/createmeta'
      + '?projectKeys=' + encodeURIComponent(projectKey)
      + '&issuetypeNames=' + encodeURIComponent(issueTypeName)
      + '&expand=projects.issuetypes.fields';
    const data = await jiraGet(cfg, path);
    const proj = (data.projects || [])[0];
    const itype2 = proj && (proj.issuetypes || [])[0];
    const fieldMap = (itype2 && itype2.fields) || {};
    const resolvedName = (itype2 && itype2.name) || issueTypeName;
    console.log('[API] createMeta (legacy) for ' + projectKey + '/' + resolvedName + ' — fields:', Object.keys(fieldMap).join(', '));
    return { fields: fieldMap, resolvedIssueType: resolvedName };
  }

  /** Create a Jira issue */
  async function createJiraTicket(cfg, fields) {
    console.log('[API] createJiraTicket fields:', JSON.stringify(fields));

    // Query create-meta to know exactly which fields are on the screen
    const metaResult = await fetchJiraCreateMeta(cfg, fields.project, fields.issueType || 'Support Defect');
    const meta = metaResult.fields;
    const resolvedIssueType = metaResult.resolvedIssueType || fields.issueType || 'Support Defect';
    const onScreen = (fid) => fid in meta;

    /** Find the best matching allowed value for an option field (case-insensitive, partial match).
     *  Returns the exact string to send, or null if nothing matches. */
    function matchOption(fieldId, input) {
      const allowed = (meta[fieldId] && meta[fieldId].allowedValues) || [];
      if (!allowed.length) return input; // no list to validate against — pass through
      const lower = input.toLowerCase();
      // 1. Exact match
      let hit = allowed.find(a => a.value.toLowerCase() === lower);
      // 2. Input contains the allowed value (e.g. "Ottawa Police" matches "Ottawa")
      if (!hit) hit = allowed.find(a => lower.includes(a.value.toLowerCase()) && a.value.length > 3);
      // 3. Allowed value contains the input
      if (!hit) hit = allowed.find(a => a.value.toLowerCase().includes(lower) && lower.length > 3);
      // 4. Token-based match: handles Zendesk org names vs Jira short codes
      if (!hit) {
        const tokenize = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(t => t.length > 0);
        const inTokens = tokenize(input);
        hit = allowed.find(a => {
          const candTokens = tokenize(a.value);
          if (!candTokens.length) return false;
          return candTokens.every(ct => inTokens.some(it => it === ct || it.startsWith(ct) || ct.startsWith(it)));
        });
      }
      if (hit) return hit.value;
      console.warn('[API] No allowed match for', fieldId, '=', JSON.stringify(input), '— skipping field');
      return null;
    }

    const body = {
      fields: {
        project: { key: fields.project },
        summary: fields.summary,
        description: fields.description || '',
        issuetype: { name: resolvedIssueType }
      }
    };
    // Priority — only set if we can resolve to an allowed value for this scheme.
    // Omitting it lets Jira apply the project's default priority instead of 400-ing.
    const pri = resolveJiraPriority(meta, fields.priority);
    if (pri) body.fields.priority = pri;
    else console.warn('[API] Priority field omitted (not on screen or unresolvable)');

    // Helper: find a field in the create meta by its display name (handles different IDs per Jira instance)
    function findByName(displayName) {
      const lower = displayName.toLowerCase().trim();
      const entry = Object.entries(meta).find(([, f]) => f.name && f.name.toLowerCase().trim() === lower);
      return entry ? entry[0] : null;
    }

    // Helper: set a field by ID using the schema to determine the correct wire format
    function setOptionField(fid, rawInputs) {
      const inputs = Array.isArray(rawInputs) ? rawInputs
        : typeof rawInputs === 'string' ? rawInputs.split(',').map(s => s.trim()).filter(Boolean)
        : [rawInputs].filter(Boolean);
      const schema = (meta[fid] && meta[fid].schema) || {};
      const allowed = (meta[fid] && meta[fid].allowedValues) || [];
      const matched = allowed.length ? inputs.map(v => matchOption(fid, v)).filter(Boolean) : inputs;
      if (!matched.length) return;
      let value;
      if (schema.type === 'array') {
        value = schema.items === 'option' ? matched.map(v => ({ value: v })) : matched;
      } else if (schema.type === 'option') {
        value = { value: matched[0] };
      } else {
        // string, textarea, any other type — plain string
        value = matched[0];
      }
      body.fields[fid] = value;
      console.log('[API] setOptionField', fid, JSON.stringify(schema), '→', JSON.stringify(value));
    }

    // Optional fields — only include if they're on the create screen
    if (fields.components && onScreen('components')) {
      const names = typeof fields.components === 'string'
        ? fields.components.split(',').map(s => s.trim()).filter(Boolean)
        : [fields.components].filter(Boolean);
      body.fields.components = names.map(n => ({ name: n }));
    }
    // Original Submittal (Cloud: customfield_10843, On-Prem: customfield_11106)
    if (fields.originalSubmittal) {
      const fid = findByName('original submittal') || (onScreen('customfield_10843') ? 'customfield_10843' : null);
      if (fid) body.fields[fid] = fields.originalSubmittal;
    }
    // Client (Cloud: customfield_10844 option array, On-Prem: customfield_10000)
    if (fields.client) {
      const fid = findByName('client') || (onScreen('customfield_10844') ? 'customfield_10844' : null);
      if (fid) setOptionField(fid, fields.client);
    }
    // Contact (Cloud: customfield_10845 option array)
    if (fields.contact) {
      const fid = findByName('contact') || (onScreen('customfield_10845') ? 'customfield_10845' : null);
      if (fid) setOptionField(fid, fields.contact);
    }
    // Severity (Cloud: customfield_10505)
    if (fields.severity) {
      const fid = findByName('severity') || (onScreen('customfield_10505') ? 'customfield_10505' : null);
      if (fid) setOptionField(fid, fields.severity);
    }
    // Component custom field (Cloud: customfield_10809 — feature area e.g. BOLO)
    if (fields.component && onScreen('customfield_10809')) {
      const cv = matchOption('customfield_10809', fields.component);
      if (cv) body.fields.customfield_10809 = { value: cv };
    }
    // Fix Build (Cloud: customfield_10842)
    if (fields.fixBuild) {
      const fid = findByName('fix build') || (onScreen('customfield_10842') ? 'customfield_10842' : null);
      if (fid) body.fields[fid] = fields.fixBuild;
    }
    // Steps to Reproduce (Cloud: customfield_10847)
    if (fields.stepsToReproduce) {
      const fid = findByName('steps to reproduce') || (onScreen('customfield_10847') ? 'customfield_10847' : null);
      if (fid) body.fields[fid] = fields.stepsToReproduce;
    }
    // Product (On-Prem: customfield_11105 — option or text)
    if (fields.product) {
      const fid = findByName('product');
      if (fid) setOptionField(fid, fields.product);
    }
    // Service Category (field ID varies per Jira instance)
    if (fields.serviceCategory) {
      const fid = findByName('service category');
      if (fid) {
        const sv = matchOption(fid, fields.serviceCategory);
        if (sv) body.fields[fid] = { value: sv };
        console.log('[API] Service Category field:', fid, '=', sv || '(no match)');
      } else {
        console.warn('[API] Service Category field not found in create meta');
      }
    }

    console.log('[API] Jira POST body:', JSON.stringify(body));
    let data;
    try {
      data = await jiraPost(cfg, '/rest/api/2/issue', body);
    } catch (e) {
      // If Jira rejects specifically because of priority (renamed scheme, removed value,
      // or priority not on the create screen at all), retry once without it.
      const msg = String(e && e.message || '');
      if (body.fields.priority && /priority/i.test(msg)) {
        console.warn('[API] Jira create failed with priority error — retrying without priority. Original error:', msg);
        const retryBody = { fields: { ...body.fields } };
        delete retryBody.fields.priority;
        data = await jiraPost(cfg, '/rest/api/2/issue', retryBody);
      } else {
        throw e;
      }
    }
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
    if (fields.priority) {
      // Resolve against the live issue's edit-meta priorities so renames don't break updates.
      try {
        const edit = await jiraGet(cfg, '/rest/api/2/issue/' + encodeURIComponent(issueKey) + '/editmeta');
        const editMeta = (edit && edit.fields) || {};
        const pri = resolveJiraPriority(editMeta, fields.priority);
        if (pri) body.fields.priority = pri;
        else console.warn('[API] updateJiraTicket: priority "' + fields.priority + '" unresolvable, leaving unchanged');
      } catch (e) {
        // Fall back to name if editmeta isn't accessible
        body.fields.priority = { name: fields.priority };
      }
    }
    if (fields.components) {
      const names = typeof fields.components === 'string'
        ? fields.components.split(',').map(s => s.trim()).filter(Boolean)
        : [fields.components].filter(Boolean);
      body.fields.components = names.map(n => ({ name: n }));
    }
    if (fields.originalSubmittal !== undefined) {
      body.fields.customfield_10843 = fields.originalSubmittal;
    }
    if (fields.stepsToReproduce !== undefined) {
      body.fields.customfield_10847 = fields.stepsToReproduce;
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

  /** Hardcoded VRM/EJU Product field ID (id=46648241536531) and value->name map.
   *  Using the same direct-lookup approach as Sherlock's scope-filter.js —
   *  no extra ticket_fields.json API call needed. */
  const _VRM_PRODUCT_FIELD_ID = 46648241536531;
  const _VRM_PRODUCT_NAMES = {
    'vrm_product_us_rms':  'US RMS',
    'vrm_product_can_rms': 'CAN RMS',
    'vrm_product_ejust':   'eJust',
    'vrm_product_us_mre':  'US MRE',
    'vrm_product_can_mre': 'CAN MRE',
    'vrm_product_vdm':     'VDM',
    'vrm_product_other':   'Other'
  };

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

    // Extract VRM/EJU Product directly by hardcoded field ID (Sherlock pattern — no extra API call)
    const _productCf = (t.custom_fields || []).find(f => Number(f.id) === _VRM_PRODUCT_FIELD_ID);
    const product = (_productCf && _productCf.value && _VRM_PRODUCT_NAMES[_productCf.value]) || '';

    return {
      source: 'zendesk',
      id: t.id,
      key: 'ZD-' + t.id,
      summary: t.subject || '',
      description: t.description || '',
      priority: t.priority || 'normal',
      priorityJira: ZD_TO_JIRA_PRIORITY[t.priority] || 'P3',
      status: t.status || '',
      tags: (t.tags || []).join(', '),
      requester_id: t.requester_id,
      requesterName: requesterName,
      requesterEmail: requesterEmail,
      organization: orgName,
      product: product,
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
      const jql = 'summary ~ "[' + sourceKey + ']" ORDER BY created DESC';
      console.log('[API] Jira clone search JQL:', jql);
      const data = await jiraGet(cfg, '/rest/api/3/search/jql?jql=' + encodeURIComponent(jql) + '&maxResults=1&fields=summary');
      console.log('[API] Jira clone search result:', data.issues ? data.issues.length : 0, 'hits', data.issues && data.issues.length ? '→ ' + data.issues[0].key : '→ none');
      if (data.issues && data.issues.length > 0) {
        const issue = data.issues[0];
        return { key: issue.key, id: issue.id, url: cfg.jiraUrl.replace(/\/+$/, '') + '/browse/' + issue.key };
      }
    } catch (e) {
      console.error('[API] Jira clone search failed:', e);
    }
    return null;
  }

  // ────── ON-PREM JIRA (wrappers — re-use existing Jira functions with different config keys) ──────

  /** Build a config object that maps on-prem credentials onto the standard jira* keys */
  function onPremCfg(cfg) {
    return { ...cfg, jiraUrl: cfg.onPremJiraUrl || '', jiraUser: cfg.onPremJiraUser || '', jiraPass: cfg.onPremJiraPass || '' };
  }

  async function fetchOnPremJiraTicket(cfg, key)                   { return fetchJiraTicket(onPremCfg(cfg), key); }
  async function createOnPremJiraTicket(cfg, fields)               { return createJiraTicket(onPremCfg(cfg), fields); }
  async function updateOnPremJiraTicket(cfg, key, fields)          { return updateJiraTicket(onPremCfg(cfg), key, fields); }
  async function addOnPremJiraComment(cfg, key, body)              { return addJiraComment(onPremCfg(cfg), key, body); }
  async function addOnPremJiraRemoteLink(cfg, key, url, title, app){ return addJiraRemoteLink(onPremCfg(cfg), key, url, title, app); }
  async function getOnPremJiraRemoteLinks(cfg, key)                { return getJiraRemoteLinks(onPremCfg(cfg), key); }
  async function fetchOnPremJiraComponents(cfg, pk)                { return fetchJiraComponents(onPremCfg(cfg), pk); }
  async function fetchOnPremJiraIssueTypes(cfg, pk)                { return fetchJiraIssueTypes(onPremCfg(cfg), pk); }
  async function fetchOnPremJiraCreateMeta(cfg, pk, it)            { return fetchJiraCreateMeta(onPremCfg(cfg), pk, it); }
  async function fetchOnPremJiraComments(cfg, key)                 { return fetchJiraComments(onPremCfg(cfg), key); }
  async function fetchOnPremJiraAttachments(cfg, key)              { return fetchJiraAttachments(onPremCfg(cfg), key); }
  async function downloadOnPremJiraAttachment(cfg, url)            { return downloadJiraAttachment(onPremCfg(cfg), url); }
  async function uploadOnPremJiraAttachment(cfg, key, fn, blob)    { return uploadJiraAttachment(onPremCfg(cfg), key, fn, blob); }

  async function findExistingOnPremJiraClone(cfg, searchKey) {
    const oc = onPremCfg(cfg);
    try {
      const jql = 'summary ~ "\\[' + searchKey + '\\]" ORDER BY created DESC';
      console.log('[API] On-prem Jira clone search JQL:', jql);
      const data = await jiraGet(oc, '/rest/api/2/search?jql=' + encodeURIComponent(jql) + '&maxResults=1&fields=summary');
      if (data.issues && data.issues.length > 0) {
        const issue = data.issues[0];
        return { key: issue.key, id: issue.id, url: oc.jiraUrl.replace(/\/+$/, '') + '/browse/' + issue.key };
      }
    } catch (e) {
      console.error('[API] On-prem Jira clone search failed:', e);
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
    fetchOnPremJiraTicket, createOnPremJiraTicket, updateOnPremJiraTicket, addOnPremJiraComment, addOnPremJiraRemoteLink, getOnPremJiraRemoteLinks,
    fetchOnPremJiraComponents, fetchOnPremJiraIssueTypes, fetchOnPremJiraCreateMeta,
    fetchOnPremJiraComments, fetchOnPremJiraAttachments, downloadOnPremJiraAttachment, uploadOnPremJiraAttachment, findExistingOnPremJiraClone,
    fetchZdTicket, createZdTicket, updateZdTicket, addZdInternalNote, deleteZdComment, deleteZdAttachment, resolveZdUserId, resolveZdUserName,
    fetchZdComments, downloadZdAttachment, uploadZdAttachment, addZdComment,
    fetchZdGroups, findExistingZdClone, findExistingJiraClone,
    fetchAhaIdea, createAhaIdea,
    ZD_TO_JIRA_PRIORITY, JIRA_TO_ZD_PRIORITY
  };
})();
