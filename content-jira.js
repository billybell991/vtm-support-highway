/**
 * content-jira.js — Injected into Jira Cloud issue pages.
 * Adds a floating "Clone to Zendesk" button on any CRMS or project ticket.
 */
(function () {
  'use strict';

  // Match any Jira issue key: /browse/CRMS-37, /browse/SUP-123, etc.
  const match = window.location.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i);
  if (!match) return;

  const issueKey = match[1].toUpperCase();
  let btnInjected = false;

  function injectButton() {
    if (btnInjected) return;

    // Jira Cloud (React-based) selectors — try multiple in priority order
    const toolbar =
      document.querySelector('[data-testid="issue-header-actions"]') ||
      document.querySelector('[data-testid="issue.views.issue-base.foundation.breadcrumbs.breadcrumb-current-issue-container"]') ||
      document.querySelector('[data-testid="issue.views.issue-base.foundation.breadcrumbs"]') ||
      document.querySelector('#jira-issue-header') ||
      // Jira Server / classic Cloud fallbacks
      document.querySelector('#opsbar-jira\\.issue\\.tools .aui-toolbar2-primary') ||
      document.querySelector('.aui-toolbar2-primary') ||
      document.querySelector('#stalker .command-bar');

    if (toolbar) {
      btnInjected = true;
      const btn = document.createElement('button');
      btn.id = 'vtm-clone-to-zd';
      btn.className = 'vtm-clone-btn';
      btn.title = 'Clone this ticket to Zendesk (VTM Support Highway)';
      btn.innerHTML = '<span class="vtm-icon">⇄</span> Clone to ZD';
      btn.addEventListener('click', function (e) { e.preventDefault(); startClone(); });
      toolbar.appendChild(btn);
      console.log('[VTM] Injected "Clone to Zendesk" button (toolbar) on ' + issueKey);
      return;
    }

    // Fallback: floating button anchored to viewport (always works regardless of DOM changes)
    if (!document.getElementById('vtm-clone-to-zd')) {
      btnInjected = true;
      const btn = document.createElement('button');
      btn.id = 'vtm-clone-to-zd';
      btn.className = 'vtm-clone-btn vtm-clone-floating';
      btn.title = 'Clone this ticket to Zendesk (VTM Support Highway)';
      btn.innerHTML = '<span class="vtm-icon">⇄</span> Clone to ZD';
      btn.addEventListener('click', function (e) { e.preventDefault(); startClone(); });
      document.body.appendChild(btn);
      console.log('[VTM] Injected "Clone to Zendesk" floating button on ' + issueKey);
    }
  }

  // ── Toast notification ──
  function showToast(message, type) {
    let toast = document.getElementById('vtm-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'vtm-toast';
      document.body.appendChild(toast);
    }
    toast.className = 'vtm-toast vtm-toast-' + (type || 'info');
    toast.innerHTML = message;
    toast.style.display = 'block';
    toast.style.opacity = '1';

    if (type === 'done' || type === 'error') {
      setTimeout(function () {
        toast.style.opacity = '0';
        setTimeout(function () { toast.style.display = 'none'; }, 400);
      }, 8000);
    }
  }

  // ── Open popup window ──
  function startClone() {
    chrome.runtime.sendMessage({
      type: 'openPopupWindow',
      sourceSystem: 'jira',
      sourceKey: issueKey,
      targetSystem: 'zendesk'
    }, function (resp) {
      if (chrome.runtime.lastError) {
        showToast('Extension error: ' + chrome.runtime.lastError.message, 'error');
      }
    });
  }

  // ── Inject when DOM is ready ──
  // Jira Cloud renders lazily via React — retry several times before giving up on toolbar
  // and falling back to a floating button.
  let retryCount = 0;
  function tryInject() {
    injectButton();
    if (!btnInjected && retryCount < 20) {
      retryCount++;
      setTimeout(tryInject, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(tryInject, 300); });
  } else {
    setTimeout(tryInject, 300);
  }

  // Also watch for AJAX-loaded content (Jira Cloud SPA navigation)
  const observer = new MutationObserver(function () {
    if (!btnInjected) injectButton();
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
