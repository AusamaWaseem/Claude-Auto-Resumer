/**
 * Claude Auto-Resume — Content Script (Isolated World)
 * Detects usage-limit cooldowns on both Free and Pro Claude plans,
 * stores captured API data, and triggers local resume when the browser stays open.
 */
(function () {
  'use strict';

  const RESUME_TEXT = 'continue';
  const POLL_MS     = 5000;
  let   scheduled   = false;
  let   resumeSent  = false;

  /* ── Capture API info from fetch interceptor ─────────────────────────── */
  window.addEventListener('__car_capture__', ({ detail }) => {
    if (!detail?.orgId || !detail?.convId) return;
    chrome.storage.local.set({ carApiCapture: detail });
  });

  /* ── Badge UI ─────────────────────────────────────────────────────────── */
  function badge(html, bg) {
    let el = document.getElementById('car-badge');
    if (!el) {
      el = Object.assign(document.createElement('div'), { id: 'car-badge' });
      Object.assign(el.style, {
        position: 'fixed', bottom: '20px', right: '20px', zIndex: '2147483647',
        padding: '12px 16px', borderRadius: '12px', fontSize: '13px',
        fontFamily: 'system-ui, -apple-system, sans-serif', fontWeight: '600',
        color: '#fff', boxShadow: '0 4px 24px rgba(0,0,0,.5)',
        lineHeight: '1.6', maxWidth: '310px', transition: 'background .3s',
        backdropFilter: 'blur(8px)'
      });
      document.body?.appendChild(el);
    }
    el.style.background = bg;
    el.innerHTML = html;
  }
  const removeBadge = () => document.getElementById('car-badge')?.remove();

  /* ── Cooldown detection (Free + Pro + all known limit messages) ───────── */
  const LIMIT_PHRASES = [
    'usage limit', 'message limit', 'rate limit',
    'free plan limit', "you've reached", 'you have reached',
    'try again in', 'come back in', 'available in', 'available again in',
    'resets in', 'resets at', 'claude is at capacity', 'claude.ai is at capacity',
    'limit reached', 'daily limit', 'hourly limit', 'plan limit'
  ];

  function isCooldownPage() {
    const t = (document.body?.innerText ?? '').toLowerCase();
    return LIMIT_PHRASES.some(p => t.includes(p));
  }

  /* ── Duration parsing ────────────────────────────────────────────────── */
  function extractLabel() {
    const text = document.body?.innerText ?? '';
    const patterns = [
      /(\d+\s*hours?\s*(?:and\s*)?\d+\s*minutes?)/i,
      /(\d+\s*hours?\s*\d+\s*min(?:utes?)?)/i,
      /(\d+\s*hours?)/i,
      /(\d+\s*minutes?)/i,
      /(\d+h\s*\d+m)/i,
      /(\d+h)/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1].trim();
    }
    // "resets tomorrow" / "available tomorrow"
    if (/tomorrow/i.test(text)) return 'until tomorrow';
    return null;
  }

  function parseDurationMs(label) {
    if (!label) return 0;
    if (/tomorrow/i.test(label)) {
      const now = new Date();
      const midnight = new Date(now); midnight.setHours(24, 5, 0, 0);
      return midnight - now;
    }
    const l = label.toLowerCase();
    let ms = 0;
    const h = l.match(/(\d+)\s*h/); if (h) ms += +h[1] * 3_600_000;
    const m = l.match(/(\d+)\s*m/); if (m) ms += +m[1] *    60_000;
    return ms;
  }

  /* ── Local resume (when browser stays open) ──────────────────────────── */
  function getInput() {
    return document.querySelector('div[contenteditable="true"]')
        ?? document.querySelector('textarea:not([disabled])');
  }

  function localSendContinue() {
    const el = getInput();
    if (!el) return false;
    el.focus();
    if (el.isContentEditable) {
      el.innerHTML = '';
      document.execCommand('insertText', false, RESUME_TEXT);
      if (!el.innerText.trim()) {
        el.innerText = RESUME_TEXT;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
    } else {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      nativeSetter?.call(el, RESUME_TEXT);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    setTimeout(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      (document.querySelector('button[aria-label*="send" i]')
       ?? document.querySelector('button[type="submit"]')
       ?? document.querySelector('button[data-testid*="send" i]'))
        ?.click();
    }, 600);
    return true;
  }

  async function checkPendingResume() {
    if (resumeSent) return;
    try {
      const state = await chrome.runtime.sendMessage({ action: 'getStatus' });
      if (!state?.pendingResume) return;
      const interval = setInterval(() => {
        if (!getInput()) return;
        clearInterval(interval);
        badge('✅ Cooldown over — resuming session…', '#15803d');
        setTimeout(() => {
          if (localSendContinue()) {
            resumeSent = true;
            chrome.runtime.sendMessage({ action: 'clearResume' });
            setTimeout(removeBadge, 4000);
          }
        }, 1500);
      }, 800);
      setTimeout(() => clearInterval(interval), 30_000);
    } catch (_) {}
  }

  /* ── Main poll loop ──────────────────────────────────────────────────── */
  async function poll() {
    if (isCooldownPage() && !scheduled) {
      const label      = extractLabel();
      const durationMs = label ? parseDurationMs(label) : 5 * 3_600_000;
      if (durationMs <= 0) return;

      try {
        const result = await chrome.runtime.sendMessage({
          action: 'setCooldown',
          durationMs,
          cooldownLabel: label ?? '~5 hours',
          chatUrl: window.location.href
        });

        scheduled = true;
        const resumeAt = new Date(Date.now() + durationMs);

        const tracks = [];
        if (result?.serverScheduled) tracks.push('🌐 Server will auto-send "continue"');
        else                          tracks.push('⚠️ <a href="#" style="color:#fbbf24">Set up server</a> for full auto-resume');
        if (result?.ntfyScheduled)    tracks.push('📱 Phone notification scheduled');

        badge(
          `<div>⏳ <strong>Cooldown detected</strong></div>
           <div style="font-weight:400;font-size:12px;margin-top:4px">
             ${label ?? '~5 hours'} — resume at <strong>${resumeAt.toLocaleTimeString()}</strong><br>
             ${tracks.join('<br>')}
             <em style="opacity:.7"> — safe to close this tab</em>
           </div>`,
          '#92400e'
        );
      } catch (_) {}
    }

    if (!isCooldownPage() && !resumeSent) checkPendingResume();
  }

  setTimeout(checkPendingResume, 1500);
  setInterval(poll, POLL_MS);
})();
