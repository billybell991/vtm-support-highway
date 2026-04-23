/**
 * content-jira.js — Injected into Jira Server issue pages.
 * Adds a "Clone to Zendesk" button on SUP tickets.
 */
(function () {
  'use strict';

  // Only run on issue pages: /browse/SUP-XXXXX
  const match = window.location.pathname.match(/\/browse\/(SUP-\d+)/);
  if (!match) return;

  const issueKey = match[1];
  let btnInjected = false;

  function injectButton() {
    if (btnInjected) return;
    // Jira Server toolbar: look for the operations bar or toolbar area
    const toolbar =
      document.querySelector('#opsbar-jira\\.issue\\.tools .aui-toolbar2-primary') ||
      document.querySelector('.aui-toolbar2-primary') ||
      document.querySelector('#stalker .command-bar') ||
      document.querySelector('#opsbar-opsbar-transitions');

    if (!toolbar) return; // page not ready yet

    btnInjected = true;

    // Create button group
    const group = document.createElement('div');
    group.className = 'aui-toolbar2-group vtm-clone-group';

    const btn = document.createElement('a');
    btn.id = 'vtm-clone-to-zd';
    btn.className = 'aui-button toolbar-trigger vtm-clone-btn';
    btn.href = '#';
    btn.title = 'Clone this SUP ticket to Zendesk (VTM Support Highway)';
    btn.innerHTML = '<span class="vtm-icon">⇄</span> Clone to Zendesk';

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      startClone();
    });

    group.appendChild(btn);
    toolbar.appendChild(group);
    console.log('[VTM] Injected "Clone to Zendesk" button on ' + issueKey);
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
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(injectButton, 500); });
  } else {
    setTimeout(injectButton, 500);
  }

  // Also watch for AJAX-loaded content (Jira uses a lot of dynamic rendering)
  const observer = new MutationObserver(function () {
    if (!btnInjected) injectButton();
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
