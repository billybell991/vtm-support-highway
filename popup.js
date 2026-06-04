/**
 * popup.js — Main popup logic for VTM Support Highway.
 * Detects current page source, fetches ticket data, shows editable preview,
 * creates tickets in target systems, and cross-links.
 */

// ────── URL detection patterns ──────
const JIRA_RE     = /\/browse\/([A-Z][A-Z0-9]+-\d+)/i;
const ZENDESK_RE  = /\/agent\/tickets\/(\d+)/;
const AHA_RE      = /\/features\/([A-Z]+-[A-Z]*-?\d+)/i;

// ────── State ──────
let currentSource = null;   // 'jira' | 'zendesk' | 'aha' | null
let currentTicketId = null; // key or id
let ticketData = null;      // normalized ticket object
let cfg = null;             // settings
let paramTarget = null;     // target pre-selected from content-script button ('jira' | 'jira-onprem' | null)

const JOB_KEY = 'vtm_highway_job';

// ────── DOM refs ──────
const $ = id => document.getElementById(id);

// ────── Init ──────
document.addEventListener('DOMContentLoaded', async () => {
  cfg = await Settings.load();
  wireSettingsPanel();
  wireActionButtons();

  // Stamp the popup with the running extension version (from manifest)
  try {
    const m = chrome.runtime.getManifest();
    const el = document.getElementById('ext-version');
    if (el && m && m.version) el.textContent = 'v' + m.version;
  } catch (_) { /* non-fatal */ }

  // Check for URL params (passed when opened from content script button)
  const urlParams = new URLSearchParams(window.location.search);
  const paramSource = urlParams.get('source');
  const paramTicketId = urlParams.get('ticketId');
  paramTarget = urlParams.get('target') || null;

  let tabSource = null, tabTicketId = null;

  if (paramSource && paramTicketId) {
    // Opened from an in-page button — use the params directly
    tabSource = paramSource;
    tabTicketId = paramTicketId;
  } else {
    // Opened from extension icon — detect from active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const jiraMatch = tab.url.match(JIRA_RE);
      const zdMatch = tab.url.match(ZENDESK_RE);
      const ahaMatch = tab.url.match(AHA_RE);
      if (jiraMatch)    { tabSource = 'jira';    tabTicketId = jiraMatch[1]; }
      else if (zdMatch) { tabSource = 'zendesk'; tabTicketId = zdMatch[1]; }
      else if (ahaMatch){ tabSource = 'aha';     tabTicketId = ahaMatch[1]; }
    }
  }

  // Check for an active/completed background job
  const job = await getJob();
  const jobMatchesTab = job && job.sourceInfo &&
    job.sourceInfo.source === tabSource &&
    job.sourceInfo.ticketId === tabTicketId;

  if (job && job.status === 'working') {
    // Always show an in-progress job (don't interrupt it)
    if (job.sourceInfo) {
      currentSource = job.sourceInfo.source;
      currentTicketId = job.sourceInfo.ticketId;
    }
    renderJobState(job);
    chrome.storage.onChanged.addListener(onJobChanged);
  } else if (job && (job.status === 'done' || job.status === 'error') && jobMatchesTab) {
    // Show completed/error job only if it matches the current tab
    currentSource = job.sourceInfo.source;
    currentTicketId = job.sourceInfo.ticketId;
    renderJobState(job);
    chrome.storage.onChanged.addListener(onJobChanged);
  } else {
    // Different tab or no job — clear stale job state and detect fresh
    if (job && !jobMatchesTab) {
      chrome.storage.local.remove(JOB_KEY);
    }
    await detectCurrentTab();
  }
});

/** Read job state from storage */
async function getJob() {
  return new Promise(resolve => {
    chrome.storage.local.get(JOB_KEY, r => resolve(r[JOB_KEY] || null));
  });
}

/** Handle live storage changes while popup is open */
function onJobChanged(changes, area) {
  if (area === 'local' && changes[JOB_KEY]) {
    const job = changes[JOB_KEY].newValue;
    if (job) renderJobState(job);
  }
}

/** Render UI based on background job state */
function renderJobState(job) {
  if (job.status === 'working') {
    // Show the working state
    $('preview-section').style.display = 'none';
    $('preview-footer').style.display = 'none';
    $('result-section').style.display = 'none';
    $('manual-entry').style.display = 'none';
    if (job.sourceInfo) {
      showDetected(job.sourceInfo.source, job.sourceInfo.ticketId, '');
    }
    showStatus(job.step || 'Working…', 'loading');
  } else if (job.status === 'done') {
    hideStatus();
    if (job.sourceInfo) {
      showDetected(job.sourceInfo.source, job.sourceInfo.ticketId, '');
    }
    showResult(job.result, job.target, job.crosslinked, job.copyStats, job.wasResync, job.resyncStats);
    // Show warnings if any
    if (job.warnings && job.warnings.length) {
      showStatus('Warnings: ' + job.warnings.join('; '), 'error');
    }
  } else if (job.status === 'error') {
    $('preview-section').style.display = 'none';
    $('preview-footer').style.display = 'none';
    $('result-section').style.display = 'none';
    showStatus('Error: ' + (job.error || 'Unknown error'), 'error');
  }
}

// ────── Tab Detection ──────
async function detectCurrentTab() {
  try {
    // Check URL params first (opened from content script button)
    const urlParams = new URLSearchParams(window.location.search);
    const paramSource = urlParams.get('source');
    const paramTicketId = urlParams.get('ticketId');

    if (paramSource && paramTicketId) {
      currentSource = paramSource;
      currentTicketId = paramTicketId;
      showDetected(currentSource, currentTicketId, '');
      $('detect-hint-text').textContent = 'Opened from in-page button';
      await fetchAndPreview();
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) { showManualEntry(); return; }

    const url = tab.url;
    const jiraMatch = url.match(JIRA_RE);
    const zdMatch = url.match(ZENDESK_RE);
    const ahaMatch = url.match(AHA_RE);

    if (jiraMatch) {
      currentSource = 'jira';
      currentTicketId = jiraMatch[1];
    } else if (zdMatch) {
      currentSource = 'zendesk';
      currentTicketId = zdMatch[1];
    } else if (ahaMatch) {
      currentSource = 'aha';
      currentTicketId = ahaMatch[1];
    } else {
      showManualEntry();
      return;
    }

    showDetected(currentSource, currentTicketId, tab.title);
    await fetchAndPreview();
  } catch (e) {
    showManualEntry();
  }
}

function showDetected(source, ticketId, tabTitle) {
  const badge = $('source-badge');
  badge.textContent = source === 'jira' ? ticketId : source === 'zendesk' ? 'ZD-' + ticketId : ticketId;
  badge.className = 'badge ' + source;

  // Extract meaningful title from tab title
  let title = tabTitle || '';
  title = title.replace(/\[.*?\]\s*/, '').replace(/\s*-\s*Jira\s*$/i, '').replace(/\s*[|·].*/g, '').trim();
  $('ticket-title').textContent = title;

  $('detect-hint-text').textContent = 'Auto-detected ' + source + ' ticket from current tab';
  $('manual-entry').style.display = 'none';
}

function showManualEntry() {
  $('source-badge').textContent = 'No ticket detected';
  $('source-badge').className = 'badge none';
  $('ticket-title').textContent = '';
  $('detect-hint-text').textContent = 'Navigate to a ticket page, or enter details below';
  $('manual-entry').style.display = 'flex';
}

// ────── Fetch & Preview ──────
async function fetchAndPreview() {
  showStatus('Fetching ticket details…', 'loading');

  try {
    cfg = await Settings.load();

    if (currentSource === 'jira') {
      if (!Settings.isConfigured(cfg, 'jira')) { showStatus('Jira not configured. Open Settings.', 'error'); return; }
      ticketData = await API.fetchJiraTicket(cfg, currentTicketId);
    } else if (currentSource === 'zendesk') {
      if (!Settings.isConfigured(cfg, 'zendesk')) { showStatus('Zendesk not configured. Open Settings.', 'error'); return; }
      ticketData = await API.fetchZdTicket(cfg, currentTicketId);
    } else if (currentSource === 'aha') {
      showStatus('Aha ticket fetch is Phase 2. Use manual entry for now.', 'info');
      return;
    }

    hideStatus();
    populatePreview();

    // ── Early duplicate check ──
    checkForExistingClone();
  } catch (err) {
    showStatus('Failed to fetch: ' + err.message, 'error');
  }
}

let existingClone = null; // { key, url, system }

async function checkForExistingClone() {
  existingClone = null;
  $('clone-alert').style.display = 'none';
  console.log('[Popup] Checking for existing clone. source=' + currentSource + ' ticketId=' + currentTicketId);

  try {
    if (currentSource === 'zendesk') {
      // Check if a Jira clone already exists (search by summary [ZD-XXXX])
      const searchKey = 'ZD-' + currentTicketId;
      console.log('[Popup] Searching Jira for clone with key: ' + searchKey);
      const found = await API.findExistingJiraClone(cfg, searchKey);
      console.log('[Popup] Jira clone search result:', found);
      if (found) {
        existingClone = { ...found, system: 'jira' };
      }
    } else if (currentSource === 'jira') {
      // First: check if this Jira ticket was cloned FROM a ZD ticket (summary contains [ZD-XXXX])
      const zdMatch = (ticketData && ticketData.summary || '').match(/\[ZD-(\d+)\]/);
      if (zdMatch) {
        const zdId = zdMatch[1];
        console.log('[Popup] This Jira ticket was cloned from ZD-' + zdId + ' (detected from summary)');
        existingClone = {
          key: 'ZD-' + zdId,
          id: zdId,
          url: cfg.zdUrl.replace(/\/+$/, '') + '/agent/tickets/' + zdId,
          system: 'zendesk'
        };
      } else {
        // Check if a ZD clone exists (by external_id or subject)
        console.log('[Popup] Searching ZD for clone of: ' + currentTicketId);
        const found = await API.findExistingZdClone(cfg, currentTicketId);
        console.log('[Popup] ZD clone search result:', found);
        if (found) {
          existingClone = { ...found, system: 'zendesk' };
        }
      }
    }
  } catch (e) {
    console.error('[Popup] Clone check failed:', e);
  }

  if (existingClone) {
    const alert = $('clone-alert');
    const link = $('clone-alert-link');
    link.href = existingClone.url;
    link.textContent = existingClone.key;
    alert.style.display = 'flex';

    $('btn-resync-existing').onclick = () => {
      triggerResync(existingClone.system, existingClone.key, existingClone.url);
    };
  }
}

function populatePreview() {
  const section = $('preview-section');
  section.style.display = 'block';
  $('preview-footer').style.display = '';

  // Update heading based on source — show available targets
  updatePreviewHeading();

  // Common fields
  $('fld-summary').value = ticketData.summary || '';

  let desc = ticketData.description || '';
  if (desc.length > 2000) desc = desc.substring(0, 2000) + '\n\n[… truncated]';
  $('fld-description').value = desc;

  // Show target-specific fields based on source
  if (currentSource === 'jira') {
    // Creating TO Zendesk — show ZD fields, hide Jira fields
    $('jira-target-fields').style.display = 'none';
    $('zd-target-fields').style.display = '';

    // Auto-prefix summary
    if (!$('fld-summary').value.startsWith('[' + ticketData.key + ']')) {
      $('fld-summary').value = '[' + ticketData.key + '] ' + $('fld-summary').value;
    }

    // Map Jira priority → Zendesk priority
    const zdPri = API.JIRA_TO_ZD_PRIORITY[ticketData.priority] || 'normal';
    $('fld-priority-zd').value = zdPri;

    // Default type to problem
    $('fld-zd-type').value = 'problem';

    // Pre-fill tags from Jira key
    const tags = [ticketData.key, 'jira-clone'];
    $('fld-zd-tags').value = tags.filter(Boolean).join(', ');

    // Set ZD description from Jira description or Original Submittal
    $('fld-zd-description').value = desc || ticketData.originalSubmittal || '';

  } else if (currentSource === 'zendesk') {
    // Creating TO Jira — show Jira fields, hide ZD fields
    $('jira-target-fields').style.display = '';
    $('zd-target-fields').style.display = 'none';

    // Map Zendesk priority → Jira priority
    $('fld-priority-jira').value = ticketData.priorityJira || 'Medium';

    // Pre-fill Original Submittal from ZD description (the customer's original message)
    $('fld-original-submittal').value = ticketData.description || '';

    // Description left empty — user fills in the Jira-specific brief summary
    $('fld-description').value = '';

    // Default project + issue type based on target
    if (paramTarget === 'jira-onprem') {
      // On-prem Tech Request: project fixed to SUP.
      // Issue Type, Severity, and Cloud Components don't apply — hide them.
      $('fld-project').value = cfg.onPremJiraTechProject || 'SUP';
      $('lbl-issuetype').style.display  = 'none';
      $('lbl-severity').style.display   = 'none';
      $('lbl-components').style.display = 'none';
      $('lbl-product').style.display    = '';
    } else {
      $('lbl-issuetype').style.display  = '';
      $('lbl-severity').style.display   = '';
      $('lbl-components').style.display = '';
      $('lbl-product').style.display    = 'none';
      // Auto-select project based on ZD ticket's VRM/EJU Product field
      $('fld-project').value = ticketData.product === 'US RMS' ? 'URMS' : 'CRMS';
      $('fld-issuetype').dataset.preferredType = 'Bug';

      // Load components and issue types from Jira Cloud
      updateIssueTypes($('fld-project').value || 'CRMS');
      loadComponents($('fld-project').value || 'CRMS');

      $('fld-project').onchange = () => {
        const pk = $('fld-project').value;
        updateIssueTypes(pk);
        loadComponents(pk);
      };
    }

    // Auto-fill fields from ZD requester/org data
    if (ticketData.requesterName || ticketData.requesterEmail) {
      const contact = ticketData.requesterName
        ? ticketData.requesterName + (ticketData.requesterEmail ? ' <' + ticketData.requesterEmail + '>' : '')
        : ticketData.requesterEmail;
      $('fld-contact').value = contact;
    }
    if (ticketData.organization) {
      $('fld-client').value = ticketData.organization;
    }

  } else {
    // Unknown/Aha — show both
    $('jira-target-fields').style.display = '';
    $('zd-target-fields').style.display = '';
  }

  // Show/hide action buttons based on source
  updateActionButtons();
}

async function updateIssueTypes(projectKey) {
  const sel = $('fld-issuetype');
  if (!projectKey) {
    sel.innerHTML = '<option value="">— select project first —</option>';
    return;
  }
  const prev = sel.value;
  sel.innerHTML = '<option value="">— loading —</option>';
  try {
    const types = await API.fetchJiraIssueTypes(cfg, projectKey);
    sel.innerHTML = '';
    if (!types.length) {
      sel.innerHTML = '<option value="">— no types found —</option>';
      return;
    }
    types.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name;
      sel.appendChild(opt);
    });
    // Preferred type from data attribute (set when opened from a ZD button)
    const preferred = sel.dataset.preferredType || prev;
    if (types.some(t => t.name === preferred)) sel.value = preferred;
    else if (types.some(t => t.name === 'Bug')) sel.value = 'Bug';
    else sel.value = types[0].name;
    console.log('[Popup] Issue types for ' + projectKey + ':', types.map(t => t.name));
  } catch (e) {
    console.error('[Popup] Failed to load issue types:', e);
    sel.innerHTML = '<option value="">— error loading —</option>';
  }
}

async function loadComponents(projectKey) {
  const sel = $('fld-components');
  if (!projectKey) {
    sel.innerHTML = '<option value="">— select project first —</option>';
    return;
  }
  sel.innerHTML = '<option value="">— loading —</option>';
  try {
    const components = await API.fetchJiraComponents(cfg, projectKey);
    sel.innerHTML = '<option value="">— none —</option>' +
      components.map(c => '<option value="' + escapeHtml(c.name) + '">' + escapeHtml(c.name) + '</option>').join('');
    // Pre-select if ticket had a component
    if (ticketData && ticketData.components) {
      const first = ticketData.components.split(',')[0].trim();
      if (first) sel.value = first;
    }
  } catch (e) {
    sel.innerHTML = '<option value="">— failed to load —</option>';
    console.warn('Component load failed:', e);
  }
}

async function loadZdGroups() {
  const sel = $('fld-zd-group');
  sel.innerHTML = '<option value="">— loading —</option>';
  try {
    const groups = await API.fetchZdGroups(cfg);
    sel.innerHTML = '<option value="">— default —</option>' +
      groups.map(g => '<option value="' + g.id + '">' + escapeHtml(g.name) + '</option>').join('');
    // Try to pre-select "Support" or first group with "support" in the name
    const supportGroup = groups.find(g => /support/i.test(g.name));
    if (supportGroup) sel.value = supportGroup.id;
  } catch (e) {
    sel.innerHTML = '<option value="">— failed to load —</option>';
    console.warn('Group load failed:', e);
  }
}

function updatePreviewHeading() {
  const heading = $('preview-heading');
  if (currentSource === 'zendesk') {
    if (paramTarget === 'jira-onprem') {
      heading.textContent = 'Clone to Tech Request — On-Prem Jira (SUP)';
    } else if (paramTarget === 'jira') {
      heading.textContent = 'Clone to Bug — Jira Cloud (CRMS)';
    } else {
      heading.textContent = 'Create from Zendesk → Jira Cloud / On-Prem Jira / Aha';
    }
  } else if (currentSource === 'jira') {
    heading.textContent = 'Create from Jira → Zendesk / Aha';
  } else if (currentSource === 'aha') {
    heading.textContent = 'Create from Aha → Jira / Zendesk';
  } else {
    heading.textContent = 'Create Ticket';
  }
}

function updateActionButtons() {
  // Show buttons for target systems (not the source system)
  // When opened from a ZD page button with a specific target, show only that button
  const showDefect  = (currentSource !== 'jira') && (paramTarget === null || paramTarget === 'jira');
  const showTech    = (currentSource === 'zendesk') && (paramTarget === null || paramTarget === 'jira-onprem');
  const showZd      = (currentSource !== 'zendesk') && !paramTarget;

  $('btn-create-jira').style.display        = showDefect ? '' : 'none';
  $('btn-create-jira-onprem').style.display  = showTech   ? '' : 'none';
  $('btn-create-zendesk').style.display      = showZd     ? '' : 'none';
  $('btn-create-aha').style.display          = paramTarget ? 'none' : ''; // hide Aha when pre-targeted
}

// ────── Settings Panel ──────
function wireSettingsPanel() {
  $('btn-settings').addEventListener('click', async () => {
    const panel = $('settings-panel');
    panel.classList.toggle('visible');
    if (panel.classList.contains('visible')) {
      await Settings.populateForm();
    }
  });

  $('btn-close-settings').addEventListener('click', () => {
    $('settings-panel').classList.remove('visible');
  });

  $('btn-save-settings').addEventListener('click', async () => {
    try {
      const newCfg = Settings.readForm();
      await Settings.save(newCfg);
      cfg = newCfg;
      showSettingsStatus('Settings saved!', 'success');
      setTimeout(() => $('settings-panel').classList.remove('visible'), 800);
    } catch (e) {
      showSettingsStatus('Save failed: ' + e.message, 'error');
    }
  });

  $('btn-export-settings').addEventListener('click', async () => {
    const current = await Settings.load();
    Settings.exportJson(current);
  });

  $('btn-import-settings').addEventListener('click', () => {
    $('import-file').click();
  });

  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      cfg = await Settings.importJson(file);
      await Settings.populateForm();
      showSettingsStatus('Config imported!', 'success');
    } catch (err) {
      showSettingsStatus('Import failed: ' + err.message, 'error');
    }
    e.target.value = '';
  });
}

function showSettingsStatus(msg, type) {
  const el = $('settings-status');
  el.textContent = msg;
  el.className = 'status ' + type;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// ────── Action Buttons ──────
function wireActionButtons() {
  // Manual fetch
  $('btn-fetch-manual').addEventListener('click', async () => {
    const source = $('manual-source').value;
    const ticket = $('manual-ticket').value.trim();
    if (!ticket) { showStatus('Enter a ticket number or key.', 'error'); return; }
    currentSource = source;
    currentTicketId = ticket;
    showDetected(source, ticket, ticket);
    await fetchAndPreview();
  });

  // Create Jira Cloud (Bug)
  $('btn-create-jira').addEventListener('click', () => createTicket('jira'));

  // Create On-Prem Jira (Tech Request)
  $('btn-create-jira-onprem').addEventListener('click', () => createTicket('jira-onprem'));

  // Create Zendesk
  $('btn-create-zendesk').addEventListener('click', () => createTicket('zendesk'));

  // Create another — clears job, re-detects tab, fresh fetch & preview
  $('btn-another').addEventListener('click', async () => {
    chrome.runtime.sendMessage({ type: 'clearJob' });
    $('result-section').style.display = 'none';
    $('preview-section').style.display = 'none';
    hideStatus();
    currentSource = null;
    currentTicketId = null;
    ticketData = null;
    await detectCurrentTab();
  });
}

async function createTicket(target) {
  const btn = target === 'jira' ? $('btn-create-jira') : target === 'jira-onprem' ? $('btn-create-jira-onprem') : $('btn-create-zendesk');
  btn.disabled = true;

  cfg = await Settings.load();

  if (!Settings.isConfigured(cfg, target)) {
    showStatus(target + ' not configured. Open Settings.', 'error');
    btn.disabled = false;
    return;
  }

  const fields = readFormFields();

  // Build the fields payload for the target system
  let targetFields;
  if (target === 'jira') {
    if (!fields.project) { showStatus('Select a Jira project key.', 'error'); btn.disabled = false; return; }
    if (!fields.issueType) { showStatus('Select a Jira issue type.', 'error'); btn.disabled = false; return; }
    targetFields = {
      project: fields.project,
      issueType: fields.issueType,
      priority: fields.priorityJira || 'Medium',
      summary: fields.summary,
      description: fields.description,
      originalSubmittal: fields.originalSubmittal,
      components: fields.components,
      severity: fields.severity,
      client: fields.client,
      contact: fields.contact,
      component: fields.component,
      fixBuild: fields.fixBuild,
      stepsToReproduce: fields.stepsToReproduce
    };
  } else if (target === 'jira-onprem') {
    const techProject = cfg.onPremJiraTechProject || 'SUP';
    if (!techProject) { showStatus('On-Prem Tech Project Key not configured. Open Settings.', 'error'); btn.disabled = false; return; }
    if (!fields.product) { showStatus('Product is required for on-prem Jira tickets.', 'error'); btn.disabled = false; return; }
    targetFields = {
      project: techProject,
      issueType: 'Support',
      priority: fields.priorityJira || 'Medium',
      summary: fields.summary,
      // On-prem Tech Requests put the customer's message in Original Submittal only.
      // Leave Description blank unless the user typed something into the Description field.
      description: fields.description || '',
      originalSubmittal: fields.originalSubmittal,
      client: fields.client,
      contact: fields.contact,
      component: fields.component,
      fixBuild: fields.fixBuild,
      stepsToReproduce: fields.stepsToReproduce,
      product: fields.product,
      serviceCategory: 'Technical request'
    };
  } else if (target === 'zendesk') {
    const zdDesc = fields.zdDescription || fields.summary || 'No description provided';
    targetFields = {
      summary: fields.summary,
      description: zdDesc,
      type: fields.zdType || 'incident',
      priority: fields.priorityZd || 'normal',
      tags: fields.zdTags || '',
      external_id: currentTicketId || ''
    };
  }

  // Send to background worker — it persists and survives popup close
  chrome.runtime.sendMessage({
    type: 'createTicket',
    target,
    fields: targetFields,
    options: {
      copyComments: $('chk-copy-comments').checked,
      copyAttachments: $('chk-copy-attachments').checked,
      crosslink: $('chk-crosslink').checked
    },
    sourceInfo: {
      source: currentSource,
      ticketId: currentTicketId
    }
  });

  // Listen for job state updates
  chrome.storage.onChanged.addListener(onJobChanged);

  // Show immediate feedback
  showStatus('Checking for existing clone…', 'loading');
  $('preview-section').style.display = 'none';
  $('preview-footer').style.display = 'none';
}

/** Trigger a resync via the background worker */
function triggerResync(targetSystem, targetKey, targetUrl) {
  chrome.runtime.sendMessage({
    type: 'resyncTicket',
    targetSystem,
    targetKey,
    targetUrl,
    sourceInfo: {
      source: currentSource,
      ticketId: currentTicketId
    }
  });
  chrome.storage.onChanged.addListener(onJobChanged);
  showStatus('Resyncing…', 'loading');
}

function readFormFields() {
  return {
    // Common
    summary: $('fld-summary').value.trim(),
    description: $('fld-description').value.trim(),
    // Jira-target fields
    project: $('fld-project').value,
    issueType: $('fld-issuetype').value,
    priorityJira: $('fld-priority-jira').value,
    originalSubmittal: $('fld-original-submittal').value.trim(),
    components: $('fld-components').value,
    severity: $('fld-severity').value,
    client: $('fld-client').value.trim(),
    contact: $('fld-contact').value.trim(),
    component: $('fld-component') ? $('fld-component').value.trim() : '',
    fixBuild: $('fld-fixbuild') ? $('fld-fixbuild').value.trim() : '',
    stepsToReproduce: $('fld-steps') ? $('fld-steps').value.trim() : '',
    product: $('fld-product').value,
    // Zendesk-target fields
    zdDescription: $('fld-zd-description').value.trim(),
    zdType: $('fld-zd-type').value,
    priorityZd: $('fld-priority-zd').value,
    zdTags: $('fld-zd-tags').value.trim()
  };
}

function showResult(result, target, crosslinked, copyStats, wasResync, resyncStats) {
  $('preview-section').style.display = 'none';
  $('preview-footer').style.display = 'none';
  $('result-section').style.display = 'block';
  hideStatus();

  const targetLabel = target === 'jira' ? 'Jira Cloud' : target === 'jira-onprem' ? 'On-Prem Jira' : 'Zendesk';
  if (wasResync) {
    $('result-title').textContent = targetLabel + ' Clone — Full Resync';
    let detail = result.key + ' updated.';
    if (resyncStats) {
      const parts = [];
      if (resyncStats.fieldsUpdated) parts.push('fields overwritten');
      if (resyncStats.comments) parts.push(resyncStats.comments + ' new comment(s) synced');
      if (resyncStats.attachments) parts.push(resyncStats.attachments + ' new attachment(s) synced');
      if (parts.length) detail += ' ' + parts.join(', ') + '.';
      else detail += ' Already up to date.';
    }
    $('result-detail').textContent = detail;
  } else {
    $('result-title').textContent = targetLabel + ' Ticket Created';
    let detail = result.key + ' created successfully.';
    if (copyStats && (copyStats.comments || copyStats.attachments)) {
      detail += ' Copied ' + copyStats.comments + ' comment(s), ' + copyStats.attachments + ' attachment(s).';
    }
    $('result-detail').textContent = detail;
  }
  $('result-link').href = result.url;
  $('result-link').textContent = 'Open ' + result.key + ' →';

  if (crosslinked) {
    $('crosslink-result').style.display = 'flex';
    $('crosslink-detail').textContent = 'Links added to both source and target tickets.';
  } else {
    $('crosslink-result').style.display = 'none';
  }

  // Wire resync button — uses background worker
  const resyncBtn = $('btn-resync');
  resyncBtn.style.display = '';
  resyncBtn.onclick = () => triggerResync(target, result.key, result.url);
}

// ────── Utilities ──────
function showStatus(msg, type) {
  const el = $('status');
  el.style.display = 'block';
  el.className = 'status ' + type;
  if (type === 'loading') {
    el.innerHTML = '<span class="spinner"></span> ' + escapeHtml(msg);
  } else {
    el.textContent = msg;
  }
}

function hideStatus() {
  $('status').style.display = 'none';
}

function escapeHtml(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
