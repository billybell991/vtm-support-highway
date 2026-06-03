/**
 * settings.js — Config persistence via chrome.storage.local + JSON export/import.
 */

const Settings = (() => {
  const STORAGE_KEY = 'vtm_highway_config_v3';

  const DEFAULTS = {
    jiraUrl: 'https://versaterminc.atlassian.net',
    jiraUser: '',   // Jira Cloud: each user enters their own email address
    jiraPass: '',   // Jira Cloud: shared API token (pre-configured; injected from secrets.local.json at build time)
    onPremJiraUrl: 'http://atlassian.versaterm.com:8080',
    onPremJiraUser: '',
    onPremJiraPass: '',
    onPremJiraTechProject: 'SUP',
    zdUrl: 'https://versatermhelp.zendesk.com',
    zdEmail: '',    // each user enters their own email address
    zdToken: '',    // uses browser session (cookie) auth — no token needed
    zdBrandId: '',
    zdAssigneeEmail: '',
    ahaUrl: '',
    ahaKey: ''
  };

  /** Load config from chrome.storage.local */
  async function load() {
    return new Promise(resolve => {
      chrome.storage.local.get(STORAGE_KEY, result => {
        const stored = result[STORAGE_KEY] || {};
        // Merge: only use stored values that are non-empty (don't let "" override defaults)
        const cfg = { ...DEFAULTS };
        for (const [k, v] of Object.entries(stored)) {
          if (v !== undefined && v !== '') cfg[k] = v;
        }
        console.log('[Settings.load]', JSON.stringify({ ...cfg, jiraPass: cfg.jiraPass ? '***' : '', zdToken: cfg.zdToken ? '***' : '' }));
        resolve(cfg);
      });
    });
  }

  /** Save config to chrome.storage.local */
  async function save(cfg) {
    console.log('[Settings.save]', JSON.stringify({ ...cfg, jiraPass: cfg.jiraPass ? '***' : '', zdToken: cfg.zdToken ? '***' : '' }));
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEY]: cfg }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
  }

  /** Export config as downloadable JSON file */
  function exportJson(cfg) {
    // Strip sensitive fields for sharing — user re-enters their own creds
    const shareable = { ...cfg };
    delete shareable.jiraPass;
    delete shareable.zdToken;
    delete shareable.ahaKey;

    const blob = new Blob([JSON.stringify(shareable, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vtm-highway-config.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Import config from a JSON file (merges, does not overwrite secrets) */
  async function importJson(file) {
    const text = await file.text();
    const imported = JSON.parse(text);
    const current = await load();
    // Merge: imported values override except blank secrets
    const merged = { ...current };
    for (const [k, v] of Object.entries(imported)) {
      if (k in DEFAULTS && v !== undefined && v !== '') {
        merged[k] = v;
      }
    }
    await save(merged);
    return merged;
  }

  /** Populate settings form from stored config */
  async function populateForm() {
    const cfg = await load();
    document.getElementById('cfg-jira-url').value = cfg.jiraUrl;
    document.getElementById('cfg-jira-user').value = cfg.jiraUser;
    document.getElementById('cfg-jira-pass').value = cfg.jiraPass;
    document.getElementById('cfg-onprem-jira-url').value = cfg.onPremJiraUrl;
    document.getElementById('cfg-onprem-jira-user').value = cfg.onPremJiraUser;
    document.getElementById('cfg-onprem-jira-pass').value = cfg.onPremJiraPass;
    document.getElementById('cfg-onprem-jira-tech-project').value = cfg.onPremJiraTechProject;
    document.getElementById('cfg-zd-url').value = cfg.zdUrl;
    document.getElementById('cfg-zd-email').value = cfg.zdEmail;
    document.getElementById('cfg-zd-token').value = cfg.zdToken;
    document.getElementById('cfg-zd-brand').value = cfg.zdBrandId;
    document.getElementById('cfg-zd-assignee').value = cfg.zdAssigneeEmail;
    document.getElementById('cfg-aha-url').value = cfg.ahaUrl;
    document.getElementById('cfg-aha-key').value = cfg.ahaKey;
  }

  /** Read config values from the form */
  function readForm() {
    return {
      jiraUrl: document.getElementById('cfg-jira-url').value.trim(),
      jiraUser: document.getElementById('cfg-jira-user').value.trim(),
      jiraPass: document.getElementById('cfg-jira-pass').value,
      onPremJiraUrl: document.getElementById('cfg-onprem-jira-url').value.trim(),
      onPremJiraUser: document.getElementById('cfg-onprem-jira-user').value.trim(),
      onPremJiraPass: document.getElementById('cfg-onprem-jira-pass').value,
      onPremJiraTechProject: document.getElementById('cfg-onprem-jira-tech-project').value.trim(),
      zdUrl: document.getElementById('cfg-zd-url').value.trim(),
      zdEmail: document.getElementById('cfg-zd-email').value.trim(),
      zdToken: document.getElementById('cfg-zd-token').value,
      zdBrandId: document.getElementById('cfg-zd-brand').value.trim(),
      zdAssigneeEmail: document.getElementById('cfg-zd-assignee').value.trim(),
      ahaUrl: document.getElementById('cfg-aha-url').value.trim(),
      ahaKey: document.getElementById('cfg-aha-key').value
    };
  }

  /** Check if minimum config is present for a given source */
  function isConfigured(cfg, source) {
    if (source === 'jira') {
      // Jira Cloud requires email + API token (no session-cookie auth)
      const ok = !!(cfg.jiraUrl && cfg.jiraUser && cfg.jiraPass);
      if (!ok) console.warn('[isConfigured:jira] FAIL — url:', !!cfg.jiraUrl, 'user:', !!cfg.jiraUser, 'token:', !!cfg.jiraPass);
      return ok;
    }
    if (source === 'jira-onprem') {
      // Accept either username+password OR PAT-only (password field holds the token).
      const ok = !!(cfg.onPremJiraUrl && cfg.onPremJiraPass);
      if (!ok) console.warn('[isConfigured:jira-onprem] FAIL — url:', !!cfg.onPremJiraUrl, 'user:', !!cfg.onPremJiraUser, 'pass/PAT:', !!cfg.onPremJiraPass);
      return ok;
    }
    if (source === 'zendesk') {
      // Only URL required — session cookies handle auth if logged in
      const ok = !!cfg.zdUrl;
      if (!ok) console.warn('[isConfigured:zendesk] FAIL — url:', !!cfg.zdUrl);
      return ok;
    }
    if (source === 'aha') return !!(cfg.ahaUrl && cfg.ahaKey);
    return false;
  }

  return { load, save, exportJson, importJson, populateForm, readForm, isConfigured, DEFAULTS };
})();
