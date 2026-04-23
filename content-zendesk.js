/**
 * content-zendesk.js — Injected into Zendesk Agent ticket pages.
 * Adds a "Clone to Jira" button on ticket views.
 */
(function () {
  'use strict';

  let currentTicketId = null;
  let btnInjected = false;

  function getTicketId() {
    // URL: /agent/tickets/3669
    const m = window.location.pathname.match(/\/agent\/tickets\/(\d+)/);
    return m ? m[1] : null;
  }

  function injectButton() {
    const ticketId = getTicketId();
    if (!ticketId) return;

    // If ticket changed (SPA navigation), reset
    if (ticketId !== currentTicketId) {
      const old = document.getElementById('vtm-clone-to-jira');
      if (old) old.closest('.vtm-zd-clone-wrap').remove();
      btnInjected = false;
      currentTicketId = ticketId;
    }

    if (btnInjected) return;

    // Find Zendesk's header area — try multiple selectors for different ZD versions
    const header =
      document.querySelector('[data-test-id="ticket-pane-header"]') ||
      document.querySelector('[data-test-id="header-toolbar"]') ||
      document.querySelector('.pane_header') ||
      document.querySelector('[role="banner"]') ||
      document.querySelector('header');

    if (!header) return;

    btnInjected = true;

    const wrap = document.createElement('div');
    wrap.className = 'vtm-zd-clone-wrap';

    const btn = document.createElement('button');
    btn.id = 'vtm-clone-to-jira';
    btn.className = 'vtm-zd-clone-btn';
    btn.title = 'Clone this Zendesk ticket to Jira SUP (VTM Support Highway)';
    btn.innerHTML = '<span class="vtm-icon">⇄</span> Clone to Jira';

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      startClone();
    });

    wrap.appendChild(btn);
    header.appendChild(wrap);
    console.log('[VTM] Injected "Clone to Jira" button on ZD ticket ' + ticketId);
  }

  // ── Floating button fallback — if header injection fails ──
  function injectFloatingButton() {
    const ticketId = getTicketId();
    if (!ticketId || btnInjected) return;

    currentTicketId = ticketId;
    btnInjected = true;

    const btn = document.createElement('button');
    btn.id = 'vtm-clone-to-jira';
    btn.className = 'vtm-zd-clone-btn vtm-zd-floating';
    btn.title = 'Clone this Zendesk ticket to Jira SUP (VTM Support Highway)';
    btn.innerHTML = '<span class="vtm-icon">⇄</span> Clone to Jira';

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      startClone();
    });

    const wrap = document.createElement('div');
    wrap.className = 'vtm-zd-clone-wrap';
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
    console.log('[VTM] Injected floating "Clone to Jira" button on ZD ticket ' + ticketId);
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
    const ticketId = getTicketId();
    if (!ticketId) return;

    chrome.runtime.sendMessage({
      type: 'openPopupWindow',
      sourceSystem: 'zendesk',
      sourceKey: ticketId,
      targetSystem: 'jira'
    }, function (resp) {
      if (chrome.runtime.lastError) {
        showToast('Extension error: ' + chrome.runtime.lastError.message, 'error');
      }
    });
  }

  // ── Injection with retry — Zendesk is a heavy SPA ──
  let attempts = 0;
  const maxAttempts = 30;

  function tryInject() {
    if (btnInjected) return;
    attempts++;
    injectButton();
    if (!btnInjected && attempts >= 10) {
      // Fallback to floating button after 10 failed attempts
      injectFloatingButton();
    }
    if (!btnInjected && attempts < maxAttempts) {
      setTimeout(tryInject, 1000);
    }
  }

  // Start injection
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(tryInject, 1500); });
  } else {
    setTimeout(tryInject, 1500);
  }

  // Watch for SPA navigation (Zendesk is a single-page app)
  let lastUrl = window.location.href;
  const urlObserver = new MutationObserver(function () {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      btnInjected = false;
      attempts = 0;
      setTimeout(tryInject, 1500);
    }
  });
  urlObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
