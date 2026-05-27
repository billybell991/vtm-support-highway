/**
 * content-zendesk-autoonline.js — Injected into every Zendesk page.
 * Automatically flips your Zendesk agent status to "Online" whenever we have
 * good reason to believe you're actively at your computer.
 *
 * Strategy: find the agent profile menu button, read its current status from
 * the aria-labelledby label, and if it isn't already "Online", open the menu
 * and click the "Online" menuitemradio.
 *
 * Selectors verified against Zendesk Support (Garden DS v9.14) — May 2026.
 *   Trigger:  button[data-test-id="toolbar-profile-menu-button"]
 *             aria-labelledby points at an element whose textContent is
 *             e.g. "Bill BellOnline" / "Bill BellOffline" — we read that to
 *             detect the current status without opening the menu.
 *   Options:  li[role="menuitemradio"][data-test-id="profile-menu-agent-status"]
 *             five of them, distinguished by visible text:
 *               "Online", "Away", "Transfers only", "Offline", "Out of Office…"
 */
(() => {
  const LOG_PREFIX = '[Zendesk Auto-Online]';
  const TRIGGER_SELECTOR = '[data-test-id="toolbar-profile-menu-button"]';
  const OPTION_SELECTOR =
    'li[role="menuitemradio"][data-test-id="profile-menu-agent-status"]';

  let lastRunAt = 0;
  const COOLDOWN_MS = 4000;

  function getTrigger() {
    return document.querySelector(TRIGGER_SELECTOR);
  }

  function getCurrentStatusText(trigger = getTrigger()) {
    if (!trigger) return null;
    const labelledBy = trigger.getAttribute('aria-labelledby');
    const labelEl = labelledBy ? document.getElementById(labelledBy) : null;
    const raw = (
      (labelEl && labelEl.textContent) ||
      trigger.getAttribute('aria-label') ||
      trigger.textContent ||
      ''
    ).toLowerCase();
    // Label is concatenated like "Bill BellOnline" — no word boundary between
    // "Bell" and "Online", so plain substring checks are required. Order
    // matters: check the more specific phrases before the generic ones.
    if (raw.includes('out of office')) return 'out of office';
    if (raw.includes('transfers')) return 'transfers only';
    if (raw.includes('away')) return 'away';
    if (raw.includes('offline')) return 'offline';
    if (raw.includes('online')) return 'online';
    return null;
  }

  function findOnlineOption() {
    const opts = document.querySelectorAll(OPTION_SELECTOR);
    for (const el of opts) {
      const txt = (el.textContent || '').trim().toLowerCase();
      if (txt === 'online') return el;
    }
    return null;
  }

  function waitFor(fn, { timeout = 3000, interval = 80 } = {}) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const result = fn();
        if (result) return resolve(result);
        if (Date.now() - start >= timeout) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  function toast(title, message) {
    try {
      chrome.runtime.sendMessage({ type: 'autoOnlineNotify', title, message });
    } catch (_) {
      // extension context invalidated, ignore
    }
  }

  async function setOnline(reason = 'manual') {
    const now = Date.now();
    if (now - lastRunAt < COOLDOWN_MS) return;
    lastRunAt = now;

    const trigger = getTrigger();
    if (!trigger) {
      console.debug(LOG_PREFIX, 'profile menu button not found yet', { reason });
      return;
    }

    const current = getCurrentStatusText(trigger);
    if (current === 'online') {
      console.debug(LOG_PREFIX, 'already online', { reason });
      return;
    }

    console.log(LOG_PREFIX, 'setting Online', { reason, current });
    trigger.click();

    const onlineItem = await waitFor(findOnlineOption, { timeout: 3000 });
    if (!onlineItem) {
      document.body.click(); // close the menu we opened
      console.warn(LOG_PREFIX, 'Online menuitem not found after opening menu');
      return;
    }

    onlineItem.click();
    toast(
      'Zendesk Auto-Online',
      'Status set to Online (was ' + (current || 'unknown') + ').'
    );
  }

  chrome.runtime.onMessage.addListener((request) => {
    if (request && request.type === 'autoOnlineForce') {
      setOnline(request.reason || 'message');
    }
  });

  // Run on first load (React mounts the header after hydration).
  waitFor(getTrigger, { timeout: 20000 }).then((el) => {
    if (el) setOnline('initial-load');
  });

  // Run when the tab becomes visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setOnline('visibilitychange');
  });
})();
