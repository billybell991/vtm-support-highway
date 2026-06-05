/**
 * content-zendesk.js — Injected into Zendesk Agent ticket pages.
 * Adds "Clone to Support Bug" and "Clone to Tech Request" buttons on ticket views.
 */
(function () {
  'use strict';

  let currentTicketId = null;
  let btnsInjected = false;

  function getTicketId() {
    const m = window.location.pathname.match(/\/agent\/tickets\/(\d+)/);
    return m ? m[1] : null;
  }

  function injectButtons() {
    const ticketId = getTicketId();
    if (!ticketId) return;

    // SPA navigation: tear down old buttons if ticket changed
    if (ticketId !== currentTicketId) {
      const old = document.getElementById('vtm-clone-wrap');
      if (old) old.remove();
      btnsInjected = false;
      currentTicketId = ticketId;
    }

    if (btnsInjected) return;
    if (document.getElementById('vtm-clone-wrap')) { btnsInjected = true; return; }

    // Try multiple header selectors for different ZD versions
    const header =
      document.querySelector('[data-test-id="ticket-pane-header"]') ||
      document.querySelector('[data-test-id="header-toolbar"]') ||
      document.querySelector('.pane_header') ||
      document.querySelector('[role="banner"]') ||
      document.querySelector('header');

    if (!header) return;

    btnsInjected = true;
    header.appendChild(buildWrap(false));
    console.log('[VTM] Injected clone buttons on ZD ticket ' + ticketId);
  }

  function injectFloatingButtons() {
    const ticketId = getTicketId();
    if (!ticketId || btnsInjected) return;
    currentTicketId = ticketId;
    btnsInjected = true;
    const wrap = buildWrap(true);
    document.body.appendChild(wrap);
    console.log('[VTM] Injected floating clone buttons on ZD ticket ' + ticketId);
  }

  function buildWrap(floating) {
    const wrap = document.createElement('div');
    wrap.id = 'vtm-clone-wrap';
    wrap.className = 'vtm-zd-clone-wrap' + (floating ? ' vtm-zd-floating-wrap' : '');

    const btnDefect = document.createElement('button');
    btnDefect.id = 'vtm-clone-to-jira';
    btnDefect.className = 'vtm-zd-clone-btn vtm-btn-defect';
    btnDefect.title = 'Clone to Jira Cloud CRMS — Support Defect';
    btnDefect.innerHTML = '<span class="vtm-icon">⇄</span> Clone to Support Bug';
    btnDefect.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); startClone('jira'); });

    const btnTech = document.createElement('button');
    btnTech.id = 'vtm-clone-to-jira-onprem';
    btnTech.className = 'vtm-zd-clone-btn vtm-btn-tech';
    btnTech.title = 'Clone to On-Prem Jira SUP — Technical Request';
    btnTech.innerHTML = '<span class="vtm-icon">⇄</span> Clone to Tech Request';
    btnTech.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); startClone('jira-onprem'); });

    wrap.appendChild(btnDefect);
    wrap.appendChild(btnTech);
    return wrap;
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

  // ── Open popup window for a specific target ──
  function startClone(targetSystem) {
    const ticketId = getTicketId();
    if (!ticketId) return;
    chrome.runtime.sendMessage({
      type: 'openPopupWindow',
      sourceSystem: 'zendesk',
      sourceKey: ticketId,
      targetSystem: targetSystem
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
    // Only inject on ticket URLs
    if (!getTicketId()) return;
    if (btnsInjected) return;
    attempts++;
    injectButtons();
    if (!btnsInjected && attempts >= 10) {
      injectFloatingButtons();
    }
    if (!btnsInjected && attempts < maxAttempts) {
      setTimeout(tryInject, 1000);
    }
  }

  function kickoff() {
    attempts = 0;
    btnsInjected = false;
    const old = document.getElementById('vtm-clone-wrap');
    if (old) old.remove();
    setTimeout(tryInject, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(tryInject, 1500); });
  } else {
    setTimeout(tryInject, 1500);
  }

  // Watch for SPA navigation — multiple strategies for reliability
  let lastUrl = window.location.href;

  function onUrlMaybeChanged() {
    if (window.location.href === lastUrl) return;
    lastUrl = window.location.href;
    const newTicketId = getTicketId();
    if (newTicketId && newTicketId !== currentTicketId) {
      kickoff();
    } else if (!newTicketId) {
      // Left a ticket view — clean up
      const old = document.getElementById('vtm-clone-wrap');
      if (old) old.remove();
      btnsInjected = false;
      currentTicketId = null;
    }
  }

  // 1) DOM mutations (catches client-side route changes)
  const urlObserver = new MutationObserver(onUrlMaybeChanged);
  urlObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });

  // 2) History API hooks (catches pushState/replaceState immediately)
  ['pushState', 'replaceState'].forEach(function (fn) {
    const orig = history[fn];
    history[fn] = function () {
      const ret = orig.apply(this, arguments);
      setTimeout(onUrlMaybeChanged, 0);
      return ret;
    };
  });
  window.addEventListener('popstate', onUrlMaybeChanged);

  // 3) Periodic safety net in case other observers miss it
  setInterval(onUrlMaybeChanged, 1500);
})();
