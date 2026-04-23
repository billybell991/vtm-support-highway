/**
 * settings.js — Config persistence via chrome.storage.local + JSON export/import.
 */

const Settings = (() => {
  const STORAGE_KEY = 'vtm_highway_config_v2';

  const DEFAULTS = {
    jiraUrl: 'http://atlassian.versaterm.com:8080',
    jiraUser: '',
    jiraPass: '',
    zdUrl: 'https://versatermhelp.zendesk.com',
    zdEmail: '',
    zdToken: '',
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
      // Only URL required — user/pass optional if logged into Jira in browser
      const ok = !!cfg.jiraUrl;
      if (!ok) console.warn('[isConfigured:jira] FAIL — url:', !!cfg.jiraUrl);
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
