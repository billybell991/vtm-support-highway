/**
 * background.js — MV3 service worker for VTM Support Highway.
 * Runs ticket creation, comment/attachment copying, cross-linking, and resync
 * so work continues even when the popup is closed.
 */

importScripts('api.js', 'settings.js');

const JOB_KEY = 'vtm_highway_job';

/** Update job state in storage (popup reads this to show progress/results) */
async function setJob(state) {
  return chrome.storage.local.set({ [JOB_KEY]: state });
}

// ────── Message Listener ──────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ping') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }

  if (msg.type === 'createTicket') {
    handleCreateTicket(msg).catch(err => {
      console.error('[BG] createTicket error:', err);
      setJob({ status: 'error', error: err.message, target: msg.target });
    });
    sendResponse({ ok: true, started: true });
    return false;
  }

  if (msg.type === 'resyncTicket') {
    handleResync(msg).catch(err => {
      console.error('[BG] resync error:', err);
      setJob({ status: 'error', error: err.message, target: msg.targetSystem });
    });
    sendResponse({ ok: true, started: true });
    return false;
  }

  if (msg.type === 'clearJob') {
    chrome.storage.local.remove(JOB_KEY);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'quickClone') {
    handleQuickClone(msg, _sender).catch(err => {
      console.error('[BG] quickClone error:', err);
      if (_sender.tab) {
        chrome.tabs.sendMessage(_sender.tab.id, { type: 'quickCloneResult', error: err.message });
      }
    });
    sendResponse({ ok: true, started: true });
    return false;
  }

  if (msg.type === 'openPopupWindow') {
    const params = new URLSearchParams({
      source: msg.sourceSystem,
      ticketId: msg.sourceKey,
      target: msg.targetSystem || ''
    });
    chrome.windows.create({
      url: chrome.runtime.getURL('popup.html?' + params.toString()),
      type: 'popup',
      width: 560,
      height: 660,
      focused: true
    });
    sendResponse({ ok: true });
    return false;
  }

  // ────── Zendesk Auto-Online: toast notifications from content script ──────
  if (msg && msg.type === 'autoOnlineNotify' && msg.title && msg.message) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: msg.title,
      message: msg.message,
      priority: 0
    });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[VTM Support Highway] Extension installed/updated.');
  nudgeAllZendeskTabs('installed');
});

// ══════════════════════════════════════════════════════════════════════════
// Zendesk Auto-Online watchdog — pokes any open Zendesk tab to set status to
// Online whenever we have good reason to believe the user is actively at
// their computer.
// ══════════════════════════════════════════════════════════════════════════

const ZENDESK_URL_FILTER = 'https://*.zendesk.com/*';
const ZENDESK_URL_RE = /^https:\/\/[^/]+\.zendesk\.com\//;

// Detect "active" sooner than the 60s default.
try { chrome.idle.setDetectionInterval(30); } catch (_) {}

function nudgeAllZendeskTabs(reason) {
  chrome.tabs.query({ url: ZENDESK_URL_FILTER }, (tabs) => {
    if (!tabs || tabs.length === 0) return;
    for (const tab of tabs) {
      chrome.tabs.sendMessage(
        tab.id,
        { type: 'autoOnlineForce', reason },
        () => void chrome.runtime.lastError
      );
    }
  });
}

// 1. Wake from sleep / return from idle
chrome.idle.onStateChanged.addListener((newState) => {
  if (newState === 'active') nudgeAllZendeskTabs('idle->active');
});

// 2. Browser startup
chrome.runtime.onStartup.addListener(() => nudgeAllZendeskTabs('startup'));

// 3. Tab finished loading or URL changed
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !ZENDESK_URL_RE.test(tab.url)) return;
  chrome.tabs.sendMessage(
    tabId,
    { type: 'autoOnlineForce', reason: 'tab-loaded' },
    () => void chrome.runtime.lastError
  );
});

// 4. Tab focused (covers alt-tab + switching tabs).
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab || !tab.url) return;
    if (!ZENDESK_URL_RE.test(tab.url)) return;
    chrome.tabs.sendMessage(
      tabId,
      { type: 'autoOnlineForce', reason: 'tab-activated' },
      () => void chrome.runtime.lastError
    );
  });
});

// ────── Create Ticket (runs in background) ──────
async function handleCreateTicket(msg) {
  const { target, fields, options, sourceInfo } = msg;
  const warnings = [];

  console.log('[BG] ══ CREATE TICKET ══');
  console.log('[BG]   source = ' + sourceInfo.source + ':' + sourceInfo.ticketId);
  console.log('[BG]   target = ' + target);
  console.log('[BG]   (only these tickets will be touched)');

  const cfg = await Settings.load();

  // Step 1: Duplicate check
  await setJob({ status: 'working', step: 'Checking for existing clone…', target, sourceInfo });

  let existing = null;
  try {
    if (target === 'zendesk') {
      existing = await API.findExistingZdClone(cfg, sourceInfo.ticketId);
    } else if (target === 'jira') {
      const searchKey = sourceInfo.source === 'zendesk' ? 'ZD-' + sourceInfo.ticketId : sourceInfo.ticketId;
      console.log('[BG] Duplicate check: searching Jira Cloud for "' + searchKey + '"');
      existing = await API.findExistingJiraClone(cfg, searchKey);
      console.log('[BG] Duplicate check result:', existing ? existing.key : 'none found');
    } else if (target === 'jira-onprem') {
      const searchKey = sourceInfo.source === 'zendesk' ? 'ZD-' + sourceInfo.ticketId : sourceInfo.ticketId;
      console.log('[BG] Duplicate check: searching on-prem Jira for "' + searchKey + '"');
      existing = await API.findExistingOnPremJiraClone(cfg, searchKey);
      console.log('[BG] On-prem duplicate check result:', existing ? existing.key : 'none found');
    }
  } catch (e) {
    console.warn('[BG] Duplicate check failed:', e);
  }

  if (existing) {
    await setJob({ status: 'working', step: 'Clone found — full resync…', target, sourceInfo });
    const resyncStats = await doResync(cfg, target, existing.key, sourceInfo);
    // Ensure cross-links exist (idempotent — adds if missing)
    let crosslinked = false;
    if (options.crosslink) {
      try {
        await doCrossLink(cfg, target, existing, sourceInfo);
        crosslinked = true;
      } catch (e) {
        warnings.push('Cross-link failed: ' + e.message);
        console.error('[BG] Cross-link on resync:', e);
      }
    }
    await setJob({ status: 'done', target, sourceInfo, wasResync: true, result: existing, resyncStats, crosslinked, warnings });
    return;
  }

  // Step 2: Create ticket
  await setJob({ status: 'working', step: 'Creating ' + target + ' ticket…', target, sourceInfo });

  let result;
  if (target === 'jira') {
    result = await API.createJiraTicket(cfg, fields);
  } else if (target === 'jira-onprem') {
    result = await API.createOnPremJiraTicket(cfg, fields);
  } else if (target === 'zendesk') {
    // If source is Jira, upload inline images as proper ZD attachments
    if (sourceInfo.source === 'jira' && fields.description) {
      try {
        const inlineResult = await preUploadInlineImages(cfg, sourceInfo.ticketId, fields.description);
        if (inlineResult.tokens.length > 0) {
          fields.uploads = inlineResult.tokens;
          // Clean wiki markup for description text (images will show as attachments)
          fields.description = inlineResult.cleanText;
        }
      } catch (e) {
        warnings.push('Inline image upload failed: ' + e.message);
        console.error('[BG] preUploadInlineImages:', e);
      }
    }
    result = await API.createZdTicket(cfg, fields);
  }

  // Step 3: Copy comments & attachments
  let copyStats = { comments: 0, attachments: 0 };
  if (options.copyComments || options.copyAttachments) {
    await setJob({ status: 'working', step: 'Copying comments & attachments…', target, sourceInfo, result });
    try {
      copyStats = await doCopyCommentsAndAttachments(cfg, target, result, sourceInfo, options.copyComments, options.copyAttachments);
    } catch (e) {
      warnings.push('Copy failed: ' + e.message);
      console.error('[BG] Copy failed:', e);
    }
  }

  // Step 4: Cross-link
  let crosslinked = false;
  if (options.crosslink && result) {
    await setJob({ status: 'working', step: 'Cross-linking…', target, sourceInfo, result });
    try {
      crosslinked = await doCrossLink(cfg, target, result, sourceInfo);
    } catch (e) {
      warnings.push('Cross-link failed: ' + e.message);
      console.error('[BG] Cross-link failed:', e);
    }
  }

  await setJob({ status: 'done', target, sourceInfo, result, copyStats, crosslinked, wasResync: false, warnings });
}

// ────── Resync (runs in background) ──────
async function handleResync(msg) {
  const { targetSystem, targetKey, targetUrl, sourceInfo } = msg;
  const cfg = await Settings.load();
  const resultObj = { key: targetKey, url: targetUrl || '', id: targetKey.replace('ZD-', '') };
  const warnings = [];

  await setJob({ status: 'working', step: 'Resyncing fields, comments & attachments…', target: targetSystem, sourceInfo });
  const stats = await doResync(cfg, targetSystem, targetKey, sourceInfo);

  // Ensure cross-links exist
  let crosslinked = false;
  try {
    await doCrossLink(cfg, targetSystem, resultObj, sourceInfo);
    crosslinked = true;
  } catch (e) {
    warnings.push('Cross-link failed: ' + e.message);
    console.error('[BG] Cross-link on resync:', e);
  }

  await setJob({
    status: 'done', target: targetSystem, sourceInfo, wasResync: true,
    result: resultObj, resyncStats: stats, crosslinked, warnings
  });
}

// ────── Quick Clone (from content script button) ──────
async function handleQuickClone(msg, sender) {
  const { sourceSystem, sourceKey, targetSystem } = msg;
  const tabId = sender.tab && sender.tab.id;
  const notify = (payload) => {
    if (tabId) chrome.tabs.sendMessage(tabId, { type: 'quickCloneResult', ...payload });
  };

  console.log('[BG] ══ QUICK CLONE ══');
  console.log('[BG]   source = ' + sourceSystem + ':' + sourceKey);
  console.log('[BG]   target = ' + targetSystem);

  const cfg = await Settings.load();
  if (!Settings.isConfigured(cfg, targetSystem)) {
    notify({ error: targetSystem + ' not configured. Open extension settings.' });
    return;
  }

  notify({ step: 'Checking for existing clone…' });

  // Duplicate check
  let existing = null;
  try {
    if (targetSystem === 'zendesk') {
      existing = await API.findExistingZdClone(cfg, sourceKey);
    } else if (targetSystem === 'jira') {
      const searchKey = sourceSystem === 'zendesk' ? 'ZD-' + sourceKey : sourceKey;
      existing = await API.findExistingJiraClone(cfg, searchKey);
    }
  } catch (e) {
    console.warn('[BG] Quick clone duplicate check failed:', e);
  }

  if (existing) {
    notify({ step: 'Clone found (' + existing.key + ') — resyncing…' });
    const resyncStats = await doResync(cfg, targetSystem, existing.key, { source: sourceSystem, ticketId: sourceKey });
    try { await doCrossLink(cfg, targetSystem, existing, { source: sourceSystem, ticketId: sourceKey }); } catch (_) {}
    notify({ done: true, wasResync: true, key: existing.key, url: existing.url, stats: resyncStats });
    return;
  }

  // Fetch source ticket
  notify({ step: 'Fetching source ticket…' });
  let source;
  if (sourceSystem === 'jira') {
    source = await API.fetchJiraTicket(cfg, sourceKey);
  } else {
    source = await API.fetchZdTicket(cfg, sourceKey);
  }

  // Build target fields with sensible defaults
  notify({ step: 'Creating ' + targetSystem + ' ticket…' });
  let result;
  const sourceInfo = { source: sourceSystem, ticketId: sourceKey };

  if (targetSystem === 'zendesk') {
    const desc = source.description || source.originalSubmittal || source.summary || 'No description';
    let zdDesc = desc;
    // Pre-upload inline images from Jira wiki markup
    if (sourceSystem === 'jira' && desc) {
      try {
        const inlineResult = await preUploadInlineImages(cfg, sourceKey, desc);
        if (inlineResult.tokens.length > 0) {
          zdDesc = inlineResult.cleanText;
        }
      } catch (e) { console.warn('[BG] Quick clone inline upload:', e); }
    }
    result = await API.createZdTicket(cfg, {
      summary: '[' + sourceKey + '] ' + source.summary,
      description: sourceSystem === 'jira' ? jiraWikiToHtml(zdDesc) : zdDesc,
      type: 'problem',
      priority: source.priorityZd || 'normal',
      tags: sourceKey + ', jira-clone',
      external_id: sourceKey
    });
  } else if (targetSystem === 'jira') {
    // Jira target — fetch create meta to know allowed fields
    const issueType = 'Support'; // default for SUP
    const metaResult = await API.fetchJiraCreateMeta(cfg, 'SUP', issueType);
    const meta = metaResult.fields;
    const onScreen = (fid) => fid in meta;
    const fields = {
      project: 'SUP',
      issueType: issueType,
      summary: '[ZD-' + sourceKey + '] ' + source.summary,
      // On-prem Tech Requests: customer message goes in Original Submittal, not Description.
      description: '',
      originalSubmittal: source.description || '',
      priority: source.priorityJira || 'Medium'
    };
    result = await API.createJiraTicket(cfg, fields);
  }

  // Copy comments + attachments
  notify({ step: 'Copying comments & attachments…' });
  let copyStats = { comments: 0, attachments: 0 };
  try {
    copyStats = await doCopyCommentsAndAttachments(cfg, targetSystem, result, sourceInfo, true, true);
  } catch (e) {
    console.error('[BG] Quick clone copy failed:', e);
  }

  // Cross-link
  notify({ step: 'Cross-linking…' });
  try {
    await doCrossLink(cfg, targetSystem, result, sourceInfo);
  } catch (e) {
    console.error('[BG] Quick clone cross-link failed:', e);
  }

  notify({ done: true, key: result.key, url: result.url, copyStats });
}

// ────── Shared work functions ──────

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Convert Jira wiki markup to HTML for Zendesk consumption */
function jiraWikiToHtml(wiki) {
  if (!wiki) return '';
  // Process line-by-line for block-level elements, then inline
  const lines = wiki.split('\n');
  const out = [];
  let inNoformat = false;
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // {noformat} / {code} toggle
    if (/^\{noformat\}/.test(line.trim()) || /^\{code(?::[^}]*)?\}/.test(line.trim())) {
      if (inNoformat || inCode) {
        out.push('</pre>');
        inNoformat = false; inCode = false;
      } else {
        out.push('<pre>');
        if (line.trim().startsWith('{code')) inCode = true;
        else inNoformat = true;
      }
      continue;
    }
    if (inNoformat || inCode) { out.push(escapeHtml(line)); continue; }

    // Horizontal rule
    if (/^----+\s*$/.test(line)) { out.push('<hr>'); continue; }

    // Headings h1. through h6.
    const hMatch = line.match(/^h([1-6])\.\s*(.*)$/);
    if (hMatch) {
      out.push('<h' + hMatch[1] + '>' + escapeHtml(hMatch[2]) + '</h' + hMatch[1] + '>');
      continue;
    }

    // Escape HTML for remaining lines
    line = escapeHtml(line);

    // Inline images → remove (they're uploaded as attachments)
    line = line.replace(/!([^|!\s]+(?:\|[^!]*)?)!/g, '');

    // Bold *text*
    line = line.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
    // Italic _text_
    line = line.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '<em>$1</em>');
    // Strikethrough -text-
    line = line.replace(/(?<!\w)-([^-\n]+)-(?!\w)/g, '<del>$1</del>');
    // Monospace {{text}}
    line = line.replace(/\{\{([^}]+)\}\}/g, '<code>$1</code>');
    // Links [title|url]
    line = line.replace(/\[([^|\]]+)\|([^\]]+)\]/g, '<a href="$2">$1</a>');
    // Links [url]
    line = line.replace(/\[([^\]]+)\]/g, '<a href="$1">$1</a>');

    // Numbered list # item
    if (/^#\s+/.test(line)) {
      line = '<li>' + line.replace(/^#\s+/, '') + '</li>';
    }
    // Bullet list * item (only at start of line with space after)
    else if (/^\*\s+/.test(line)) {
      line = '<li>' + line.replace(/^\*\s+/, '') + '</li>';
    }

    // Skip blank lines left over from stripped images
    if (line.trim() === '') { out.push('<br>'); continue; }

    out.push(line);
  }

  if (inNoformat || inCode) out.push('</pre>');
  return out.join('<br>');
}

/**
 * Upload Jira inline images (!filename.png!) to Zendesk as attachments.
 * Returns upload tokens (to attach to the ticket comment) and cleaned-up
 * description text with wiki markup replaced by readable plaintext.
 * The images will appear as native ZD attachments on the ticket.
 */
async function preUploadInlineImages(cfg, jiraIssueKey, description) {
  // Find all !filename.png! or !filename.png|options! references
  const imageRe = /!([^|!\s]+?)(?:\|[^!]*)?!/g;
  const filenames = [];
  let match;
  while ((match = imageRe.exec(description)) !== null) {
    const fn = match[1];
    if (!filenames.includes(fn)) filenames.push(fn);
  }

  if (filenames.length === 0) {
    return { cleanText: description, tokens: [] };
  }

  console.log('[BG] Found ' + filenames.length + ' inline image(s) in Jira description:', filenames);

  // Fetch the Jira issue's attachment metadata to find download URLs
  const jiraAttachments = await API.fetchJiraAttachments(cfg, jiraIssueKey);
  const attMap = {};
  for (const a of jiraAttachments) {
    attMap[a.filename] = a;
  }

  // Download from Jira → upload to ZD, collect tokens
  const tokens = [];
  const uploaded = [];
  for (const fn of filenames) {
    const att = attMap[fn];
    if (!att) {
      console.warn('[BG] Inline image "' + fn + '" not found in Jira attachments. Available:', Object.keys(attMap));
      continue;
    }
    try {
      console.log('[BG] Downloading Jira attachment: ' + fn + ' from ' + att.contentUrl);
      const blob = await API.downloadJiraAttachment(cfg, att.contentUrl);
      console.log('[BG] Uploading to Zendesk: ' + fn + ' (' + blob.size + ' bytes)');
      const upload = await API.uploadZdAttachment(cfg, fn, blob);
      tokens.push(upload.token);
      uploaded.push(fn);
      console.log('[BG] Uploaded ' + fn + ' → token: ' + upload.token);
    } catch (e) {
      console.error('[BG] Failed to transfer inline image "' + fn + '":', e);
    }
  }

  // Clean up wiki markup: remove image references entirely (images are now ZD attachments)
  let cleanText = description.replace(/!([^|!\s]+?)(?:\|[^!]*)?!/g, '');
  // Remove blank lines left by stripped image references
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n');

  console.log('[BG] Pre-upload complete: ' + uploaded.length + '/' + filenames.length + ' images uploaded');
  return { cleanText, tokens };
}

async function doCopyCommentsAndAttachments(cfg, target, result, sourceInfo, doCopyComments, doCopyAttachments) {
  let comments = [];
  let attachments = [];
  let copiedComments = 0;
  let copiedAttachments = 0;
  const zdTicketId = result.id || result.key.replace('ZD-', '');

  if (sourceInfo.source === 'zendesk') {
    const zdComments = await API.fetchZdComments(cfg, sourceInfo.ticketId);
    comments = zdComments.slice(1);
    for (const c of zdComments) {
      for (const a of (c.attachments || [])) attachments.push(a);
    }
  } else if (sourceInfo.source === 'jira') {
    comments = await API.fetchJiraComments(cfg, sourceInfo.ticketId);
    attachments = await API.fetchJiraAttachments(cfg, sourceInfo.ticketId);
  }

  // ── Resolve ZD user IDs to names (batch, cached) ──
  if (sourceInfo.source === 'zendesk' && comments.length > 0) {
    const uniqueIds = [...new Set(comments.map(c => c.author_id).filter(Boolean))];
    console.log('[BG] Resolving ' + uniqueIds.length + ' ZD user IDs…');
    for (const uid of uniqueIds) {
      await API.resolveZdUserName(cfg, uid); // populates cache
    }
    for (const c of comments) {
      if (c.author_id && !c.author) {
        c.author = await API.resolveZdUserName(cfg, c.author_id) || ('User #' + c.author_id);
      }
    }
  }

  // ── Copy comments ──
  if (doCopyComments && (target === 'jira' || target === 'jira-onprem')) {
    for (const c of comments) {
      const prefix = c.author ? ('*' + c.author + '* (' + (c.created || '') + '):\n') : '';
      const marker = '\n{color:#ffffff}{vtm-sync:comment-' + c.id + '}{color}';
      if (target === 'jira') {
        await API.addJiraComment(cfg, result.key, prefix + (c.body || '') + marker);
      } else {
        await API.addOnPremJiraComment(cfg, result.key, prefix + (c.body || '') + marker);
      }
      copiedComments++;
    }
  } else if (doCopyComments && target === 'zendesk') {
    for (const c of comments) {
      const prefix = c.author ? '<strong>' + escapeHtml(c.author) + '</strong> (' + escapeHtml(c.created || '') + '):<br>' : '';
      // Convert Jira wiki markup → HTML when source is Jira
      const body = sourceInfo.source === 'jira' ? jiraWikiToHtml(c.body || '') : escapeHtml(c.body || '');
      const marker = '<!-- vtm-sync:comment-' + c.id + ' -->';
      await API.addZdComment(cfg, zdTicketId, prefix + body + marker, [], false);
      copiedComments++;
    }
  }

  // ── Copy attachments ──
  console.log('[BG] Attachments to copy: ' + attachments.length + ' (doCopyAttachments=' + doCopyAttachments + ')');
  if (attachments.length > 0) {
    console.log('[BG] Attachment list:', attachments.map(a => a.filename + ' (' + (a.contentUrl || 'no-url') + ')').join(', '));
  }
  if (doCopyAttachments && attachments.length > 0) {
    // Upload all attachments first, collecting tokens (Zendesk) or uploading directly (Jira)
    const uploadTokens = [];
    const uploadedNames = [];
    for (const a of attachments) {
      try {
        let blob;
        if (sourceInfo.source === 'zendesk') {
          blob = await API.downloadZdAttachment(cfg, a.contentUrl);
        } else {
          blob = await API.downloadJiraAttachment(cfg, a.contentUrl);
        }
        if (target === 'jira') {
          await API.uploadJiraAttachment(cfg, result.key, a.filename, blob);
        } else if (target === 'jira-onprem') {
          await API.uploadOnPremJiraAttachment(cfg, result.key, a.filename, blob);
        } else if (target === 'zendesk') {
          const upload = await API.uploadZdAttachment(cfg, a.filename, blob);
          uploadTokens.push(upload.token);
          uploadedNames.push(a.filename);
        }
        copiedAttachments++;
      } catch (e) {
        console.warn('[BG] Failed to copy attachment ' + a.filename + ':', e);
      }
    }

    // Zendesk: batch all uploaded attachments into ONE comment (no verbose listing)
    if (target === 'zendesk' && uploadTokens.length > 0) {
      const marker = '<!-- vtm-sync:attachments -->';
      await API.addZdComment(cfg, zdTicketId, marker, uploadTokens, false);
    }
  }

  return { comments: copiedComments, attachments: copiedAttachments };
}

async function doCrossLink(cfg, target, result, sourceInfo) {
  console.log('[BG] Cross-linking: source=' + sourceInfo.source + ':' + sourceInfo.ticketId + ' ↔ target=' + target + ':' + result.key);
  const jiraUrl = cfg.jiraUrl.replace(/\/+$/, '');
  const zdUrl = cfg.zdUrl.replace(/\/+$/, '');

  if (sourceInfo.source === 'zendesk' && target === 'jira') {
    // Link on source ZD ticket → new Jira Cloud ticket (internal note)
    const zdComments = await API.fetchZdComments(cfg, sourceInfo.ticketId);
    const linkSignature = 'Jira ticket created:</strong>';
    const alreadyLinkedZd = zdComments.some(c => (c.html_body || '').includes(linkSignature) && (c.html_body || '').includes(result.key));
    if (!alreadyLinkedZd) {
      const html = '<p><strong>Jira ticket created:</strong> <a href="' + escapeHtml(result.url) + '">' + escapeHtml(result.key) + '</a></p>';
      await API.addZdInternalNote(cfg, sourceInfo.ticketId, html);
      console.log('[BG] Added ZD internal note linking to ' + result.key);
    } else {
      console.log('[BG] ZD already has link note for ' + result.key + ', skipping');
    }
    // Link on new Jira Cloud ticket → source ZD ticket (remote link in Links section)
    const sourceUrl = zdUrl + '/agent/tickets/' + sourceInfo.ticketId;
    await addRemoteLinkIfMissing(cfg, result.key, sourceUrl, 'ZD-' + sourceInfo.ticketId, 'Zendesk');
    return true;

  } else if (sourceInfo.source === 'zendesk' && target === 'jira-onprem') {
    // Link on source ZD ticket → new on-prem Jira ticket (internal note)
    const zdComments = await API.fetchZdComments(cfg, sourceInfo.ticketId);
    const linkSignature = 'Jira ticket created:</strong>';
    const alreadyLinkedZd = zdComments.some(c => (c.html_body || '').includes(linkSignature) && (c.html_body || '').includes(result.key));
    if (!alreadyLinkedZd) {
      const html = '<p><strong>Jira ticket created:</strong> <a href="' + escapeHtml(result.url) + '">' + escapeHtml(result.key) + '</a></p>';
      await API.addZdInternalNote(cfg, sourceInfo.ticketId, html);
      console.log('[BG] Added ZD internal note linking to on-prem ' + result.key);
    } else {
      console.log('[BG] ZD already has link note for ' + result.key + ', skipping');
    }
    // Link on new on-prem Jira ticket → source ZD ticket (remote link in Links section)
    const onPremSourceUrl = zdUrl + '/agent/tickets/' + sourceInfo.ticketId;
    await addOnPremRemoteLinkIfMissing(cfg, result.key, onPremSourceUrl, 'ZD-' + sourceInfo.ticketId, 'Zendesk');
    return true;

  } else if (sourceInfo.source === 'jira' && target === 'zendesk') {
    // Link on source Jira ticket → new ZD ticket (remote link in Links section)
    await addRemoteLinkIfMissing(cfg, sourceInfo.ticketId, result.url, result.key, 'Zendesk');
    // Link on new ZD ticket → source Jira ticket (internal note)
    const zdTicketId = result.id || result.key.replace('ZD-', '');
    const zdComments = await API.fetchZdComments(cfg, zdTicketId);
    const linkSignature = 'Created from Jira:</strong>';
    const alreadyLinkedZd = zdComments.some(c => (c.html_body || '').includes(linkSignature) && (c.html_body || '').includes(sourceInfo.ticketId));
    if (!alreadyLinkedZd) {
      const sourceUrl = jiraUrl + '/browse/' + sourceInfo.ticketId;
      const zdHtml = '<p><strong>Created from Jira:</strong> <a href="' + escapeHtml(sourceUrl) + '">' + escapeHtml(sourceInfo.ticketId) + '</a></p>';
      await API.addZdInternalNote(cfg, zdTicketId, zdHtml);
      console.log('[BG] Added ZD internal note linking to ' + sourceInfo.ticketId);
    } else {
      console.log('[BG] ZD already has link note for ' + sourceInfo.ticketId + ', skipping');
    }
    return true;
  }
  return false;
}

/** Add a Jira Cloud remote link only if one with the same URL doesn't already exist */
async function addRemoteLinkIfMissing(cfg, issueKey, url, title, appName) {
  try {
    const existing = await API.getJiraRemoteLinks(cfg, issueKey);
    const alreadyLinked = (existing || []).some(l => l.object && l.object.url === url);
    if (alreadyLinked) return;
  } catch (e) {
    // If we can't read links, try to add anyway
    console.warn('[BG] Could not read remote links for ' + issueKey + ':', e);
  }
  await API.addJiraRemoteLink(cfg, issueKey, url, title, appName);
}

/** Add an on-prem Jira remote link only if one with the same URL doesn't already exist */
async function addOnPremRemoteLinkIfMissing(cfg, issueKey, url, title, appName) {
  try {
    const existing = await API.getOnPremJiraRemoteLinks(cfg, issueKey);
    const alreadyLinked = (existing || []).some(l => l.object && l.object.url === url);
    if (alreadyLinked) return;
  } catch (e) {
    console.warn('[BG] Could not read on-prem remote links for ' + issueKey + ':', e);
  }
  await API.addOnPremJiraRemoteLink(cfg, issueKey, url, title, appName);
}

async function doResync(cfg, targetSystem, targetKey, sourceInfo) {
  const stats = { fieldsUpdated: false, comments: 0, attachments: 0 };
  const zdTargetId = targetKey.replace('ZD-', '');

  console.log('[BG] ══ RESYNC START ══');
  console.log('[BG]   target = ' + targetSystem + ':' + targetKey);
  console.log('[BG]   source = ' + sourceInfo.source + ':' + sourceInfo.ticketId);
  console.log('[BG]   (only these two tickets will be touched)');

  // ── Step 1: Re-fetch source ticket and overwrite target fields ──
  let source;
  if (sourceInfo.source === 'zendesk') {
    source = await API.fetchZdTicket(cfg, sourceInfo.ticketId);
  } else if (sourceInfo.source === 'jira') {
    source = await API.fetchJiraTicket(cfg, sourceInfo.ticketId);
  }

  if (source && targetSystem === 'jira') {
    console.log('[BG] Updating fields on Jira ' + targetKey);
    const updateFields = {
      summary: '[ZD-' + sourceInfo.ticketId + '] ' + source.summary,
      description: source.description || source.summary,
      priority: source.priorityJira || 'Medium'
    };
    // Only update Original Submittal if we have content (ZD description maps to it)
    const os = source.originalSubmittal || source.description || '';
    if (os) updateFields.originalSubmittal = os;
    await API.updateJiraTicket(cfg, targetKey, updateFields);
    stats.fieldsUpdated = true;
  } else if (source && targetSystem === 'jira-onprem') {
    console.log('[BG] Updating fields on on-prem Jira ' + targetKey);
    const updateFields = {
      summary: '[ZD-' + sourceInfo.ticketId + '] ' + source.summary,
      description: source.description || source.summary,
      priority: source.priorityJira || 'Medium'
    };
    const os = source.originalSubmittal || source.description || '';
    if (os) updateFields.originalSubmittal = os;
    await API.updateOnPremJiraTicket(cfg, targetKey, updateFields);
    stats.fieldsUpdated = true;
  } else if (source && targetSystem === 'zendesk') {
    console.log('[BG] Updating fields on ZD-' + zdTargetId);
    await API.updateZdTicket(cfg, zdTargetId, {
      summary: '[' + sourceInfo.ticketId + '] ' + source.summary,
      priority: source.priorityZd || source.priority || 'normal',
      type: source.type || 'incident',
      tags: source.tags || ''
    });
    stats.fieldsUpdated = true;
  }

  // ── Step 2: Sync comments (incremental — uses hidden markers to skip already-synced) ──
  // NOTE: Zendesk API does NOT support deleting comments, so we track what's
  // already been synced with <!-- vtm-sync:comment-{id} --> markers in html_body.
  let sourceComments = [];
  if (sourceInfo.source === 'zendesk') {
    const zdComments = await API.fetchZdComments(cfg, sourceInfo.ticketId);
    sourceComments = zdComments.slice(1); // skip source description
  } else if (sourceInfo.source === 'jira') {
    sourceComments = await API.fetchJiraComments(cfg, sourceInfo.ticketId);
  }

  // Scan target for sync markers AND collect bodies for content-based dedup.
  // Content-based dedup handles comments synced by older code (before markers existed).
  const alreadySyncedIds = new Set();
  const targetBodies = [];  // html_body strings of all target comments
  if (targetSystem === 'zendesk') {
    const targetComments = await API.fetchZdComments(cfg, zdTargetId);
    for (const tc of targetComments) {
      const html = tc.html_body || tc.body || '';
      targetBodies.push(html);
      const m = html.match(/<!-- vtm-sync:comment-(\S+?) -->/);
      if (m) alreadySyncedIds.add(m[1]);
    }
  } else if (targetSystem === 'jira' || targetSystem === 'jira-onprem') {
    const targetComments = targetSystem === 'jira'
      ? await API.fetchJiraComments(cfg, targetKey)
      : await API.fetchOnPremJiraComments(cfg, targetKey);
    for (const tc of targetComments) {
      const txt = tc.body || '';
      targetBodies.push(txt);
      const m = txt.match(/\{vtm-sync:comment-(\S+?)\}/);
      if (m) alreadySyncedIds.add(m[1]);
    }
  }

  const newComments = sourceComments.filter(c => {
    // Check 1: marker match (new-style synced comments)
    if (alreadySyncedIds.has(String(c.id))) return false;
    // Check 2: content match (old-style synced comments without markers)
    // Our synced comments always contain a snippet of the original body.
    // Match on first 80 chars of the converted body to detect pre-marker copies.
    let bodySnippet;
    if (targetSystem === 'zendesk') {
      bodySnippet = (sourceInfo.source === 'jira' ? jiraWikiToHtml(c.body || '') : escapeHtml(c.body || '')).substring(0, 80);
    } else {
      bodySnippet = (c.body || '').substring(0, 80);
    }
    if (bodySnippet.length > 20 && targetBodies.some(b => b.includes(bodySnippet))) return false;
    return true;
  });
  console.log('[BG] Comments: ' + sourceComments.length + ' on source, ' +
    (sourceComments.length - newComments.length) + ' already synced (marker+content), ' +
    newComments.length + ' new to copy');

  for (const c of newComments) {
    if (targetSystem === 'jira' || targetSystem === 'jira-onprem') {
      // Resolve ZD user names if needed
      if (c.author_id && !c.author) {
        c.author = await API.resolveZdUserName(cfg, c.author_id) || ('User #' + c.author_id);
      }
      const prefix = c.author ? ('*' + c.author + '* (' + (c.created || '') + '):\n') : '';
      const marker = '\n{color:#ffffff}{vtm-sync:comment-' + c.id + '}{color}';
      if (targetSystem === 'jira') {
        await API.addJiraComment(cfg, targetKey, prefix + (c.body || '') + marker);
      } else {
        await API.addOnPremJiraComment(cfg, targetKey, prefix + (c.body || '') + marker);
      }
    } else {
      const prefix = c.author ? '<strong>' + escapeHtml(c.author) + '</strong> (' + escapeHtml(c.created || '') + '):<br>' : '';
      const body = sourceInfo.source === 'jira' ? jiraWikiToHtml(c.body || '') : escapeHtml(c.body || '');
      const marker = '<!-- vtm-sync:comment-' + c.id + ' -->';
      await API.addZdComment(cfg, zdTargetId, prefix + body + marker, [], false);
    }
    stats.comments++;
  }

  // ── Step 3: Sync attachments (only add missing ones by filename) ──
  let sourceAttachments = [];
  if (sourceInfo.source === 'jira') {
    sourceAttachments = await API.fetchJiraAttachments(cfg, sourceInfo.ticketId);
  } else if (sourceInfo.source === 'zendesk') {
    const allComments = await API.fetchZdComments(cfg, sourceInfo.ticketId);
    for (const c of allComments) {
      for (const a of (c.attachments || [])) sourceAttachments.push(a);
    }
  }

  // Check what's already on the target
  const existingNames = new Set();
  if (targetSystem === 'jira') {
    const targetAtts = await API.fetchJiraAttachments(cfg, targetKey);
    targetAtts.forEach(a => existingNames.add(a.filename));
  } else if (targetSystem === 'jira-onprem') {
    const targetAtts = await API.fetchOnPremJiraAttachments(cfg, targetKey);
    targetAtts.forEach(a => existingNames.add(a.filename));
  } else {
    const targetAllComments = await API.fetchZdComments(cfg, zdTargetId);
    for (const c of targetAllComments) {
      for (const a of (c.attachments || [])) existingNames.add(a.filename);
    }
  }

  const newAttachments = sourceAttachments.filter(a => !existingNames.has(a.filename));
  console.log('[BG] Attachments: ' + sourceAttachments.length + ' on source, ' +
    existingNames.size + ' already on target, ' + newAttachments.length + ' new to copy');

  const uploadTokens = [];
  const uploadedNames = [];

  for (const a of newAttachments) {
    try {
      let blob;
      if (sourceInfo.source === 'zendesk') {
        blob = await API.downloadZdAttachment(cfg, a.contentUrl);
      } else {
        blob = await API.downloadJiraAttachment(cfg, a.contentUrl);
      }
      if (targetSystem === 'jira') {
        await API.uploadJiraAttachment(cfg, targetKey, a.filename, blob);
      } else if (targetSystem === 'jira-onprem') {
        await API.uploadOnPremJiraAttachment(cfg, targetKey, a.filename, blob);
      } else {
        const upload = await API.uploadZdAttachment(cfg, a.filename, blob);
        uploadTokens.push(upload.token);
        uploadedNames.push(a.filename);
      }
      stats.attachments++;
    } catch (e) {
      console.warn('[BG] Resync: failed to copy attachment ' + a.filename + ':', e);
    }
  }

  // Zendesk: batch all new attachments into one comment (no verbose listing)
  if (targetSystem === 'zendesk' && uploadTokens.length > 0) {
    const marker = '<!-- vtm-sync:attachments-' + Date.now() + ' -->';
    await API.addZdComment(cfg, zdTargetId, marker, uploadTokens, false);
  }

  console.log('[BG] ══ RESYNC DONE ══ ' + JSON.stringify(stats));
  return stats;
}
