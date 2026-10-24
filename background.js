/**
 * Claude Auto-Resume — Background Service Worker
 *
 * Three-track resume system (all run in parallel):
 *  Track 1 — Cloud Server : POST "continue" to Claude.ai API — works with PC OFF ✅
 *  Track 2 — Local Alarm  : reopen tab in browser — requires browser open
 *  Track 3 — ntfy Push    : phone notification — requires manual tap (backup)
 *
 * Works with Claude Free plan and Claude Pro plan.
 */

const ALARM   = 'carResume';
const STORE   = 'carState';

/* ── Helpers ───────────────────────────────────────────────────────────── */
const getState  = async ()      => ((await chrome.storage.local.get(STORE))[STORE] ?? {});
const setState  = async (patch) => { const s = await getState(); await chrome.storage.local.set({ [STORE]: { ...s, ...patch } }); };
const getCfg    = ()            => chrome.storage.local.get(['carServerUrl', 'carApiKey', 'carNtfyTopic']);

async function getSessionCookies() {
  const all = await chrome.cookies.getAll({ url: 'https://claude.ai' });
  // Try known session cookie names (Claude.ai has used several over time)
  for (const name of ['sessionKey', '__Secure-next-auth.session-token', 'next-auth.session-token', 'CF_Authorization']) {
    const c = all.find(x => x.name === name);
    if (c?.value) return { cookieHeader: `${name}=${c.value}`, found: name };
  }
  // Fall back to all cookies as a single header string
  const cookieHeader = all.map(c => `${c.name}=${c.value}`).join('; ');
  return { cookieHeader, found: 'all' };
}

/* ── Track 1: Cloud server ─────────────────────────────────────────────── */
async function scheduleOnServer({ serverUrl, apiKey, sessionCookies, apiCapture, chatUrl, resumeAt, label, ntfyTopic }) {
  if (!serverUrl) return { ok: false, reason: 'no_server' };

  const body = {
    cookieHeader:  sessionCookies.cookieHeader,
    cookieFound:   sessionCookies.found,
    orgId:         apiCapture?.orgId         ?? null,
    convId:        apiCapture?.convId        ?? null,
    apiUrl:        apiCapture?.apiUrl        ?? null,
    parentMsgUuid: apiCapture?.parentMsgUuid ?? null,
    timezone:      apiCapture?.timezone      ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    renderingMode: apiCapture?.renderingMode ?? 'raw',
    payloadTpl:    apiCapture?.payloadTemplate ?? null,
    chatUrl,
    resumeAt,
    label,
    ntfyTopic: ntfyTopic ?? null
  };

  try {
    const res  = await fetch(`${serverUrl.replace(/\/$/, '')}/schedule`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey ?? '' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(10_000)
    });
    const json = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, jobId: json.jobId } : { ok: false, reason: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/* ── Track 3: ntfy.sh push (backup) ────────────────────────────────────── */
async function scheduleNtfy({ ntfyTopic, resumeAt, chatUrl, label }) {
  if (!ntfyTopic) return { ok: false };
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(ntfyTopic)}`, {
      method:  'POST',
      headers: {
        'Title':         '✅ Claude Cooldown Over',
        'At':            new Date(resumeAt).toISOString(),
        'Priority':      'high',
        'Tags':          'robot,white_check_mark',
        'Click':         chatUrl,
        'Actions':       `view, Open Claude, ${chatUrl}`,
        'Content-Type':  'text/plain'
      },
      body: `Your Claude session (${label ?? 'cooldown'}) is ready.\nTap to open your chat.`,
      signal: AbortSignal.timeout(8_000)
    });
    return { ok: res.ok };
  } catch (_) { return { ok: false }; }
}

/* ── Track 2: Local alarm handler ─────────────────────────────────────── */
chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (name !== ALARM) return;
  const state = await getState();
  const url   = state.chatUrl ?? 'https://claude.ai';
  await setState({ pendingResume: true, cooldownActive: false });

  const existing = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  if (existing.length) {
    chrome.tabs.update(existing[0].id, { active: true, url });
    chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url });
  }

  chrome.notifications.create({
    type: 'basic', iconUrl: 'icons/icon48.png',
    title: '✅ Claude Cooldown Over', message: 'Resuming your session now…'
  }).catch(() => {});
});

/* ── Message router ────────────────────────────────────────────────────── */
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  switch (msg.action) {

    case 'setCooldown': {
      const { durationMs, chatUrl, cooldownLabel } = msg;
      const resumeAt = Date.now() + durationMs;

      (async () => {
        await setState({ cooldownActive: true, pendingResume: false, resumeAt, cooldownLabel, chatUrl });

        // Track 2 — local alarm
        await chrome.alarms.clear(ALARM);
        chrome.alarms.create(ALARM, { when: resumeAt + 5_000 });

        const cfg      = await getCfg();
        const { carServerUrl: serverUrl, carApiKey: apiKey, carNtfyTopic: ntfyTopic } = cfg;

        const [sessionCookies, captureRaw] = await Promise.all([
          getSessionCookies(),
          chrome.storage.local.get('carApiCapture').then(d => d.carApiCapture ?? null)
        ]);

        // Track 1 — server
        const serverResult = await scheduleOnServer({ serverUrl, apiKey, sessionCookies, apiCapture: captureRaw, chatUrl, resumeAt, label: cooldownLabel, ntfyTopic });

        // Track 3 — ntfy
        const ntfyResult = await scheduleNtfy({ ntfyTopic, resumeAt, chatUrl, label: cooldownLabel });

        await setState({
          serverStatus: serverResult.ok ? 'scheduled' : (serverUrl ? 'failed' : 'not_configured'),
          ntfyStatus:   ntfyResult.ok   ? 'scheduled' : (ntfyTopic ? 'failed' : 'not_configured'),
          serverJobId:  serverResult.jobId ?? null,
          hasCapture:   !!captureRaw
        });

        reply({ ok: true, serverScheduled: serverResult.ok, ntfyScheduled: ntfyResult.ok });
      })();
      return true;
    }

    case 'getStatus':
      getState().then(reply);
      return true;

    case 'clearResume':
      setState({ pendingResume: false, cooldownActive: false }).then(() => reply({ ok: true }));
      return true;

    case 'cancelCooldown':
      chrome.alarms.clear(ALARM);
      (async () => {
        const [state, cfg] = await Promise.all([getState(), getCfg()]);
        if (cfg.carServerUrl && state.serverJobId) {
          fetch(`${cfg.carServerUrl.replace(/\/$/, '')}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.carApiKey ?? '' },
            body: JSON.stringify({ jobId: state.serverJobId })
          }).catch(() => {});
        }
        await setState({ cooldownActive: false, pendingResume: false, serverStatus: 'cancelled', ntfyStatus: 'cancelled' });
        reply({ ok: true });
      })();
      return true;

    case 'saveConfig':
      chrome.storage.local.set({
        carServerUrl:  msg.serverUrl  ?? '',
        carApiKey:     msg.apiKey     ?? '',
        carNtfyTopic:  msg.ntfyTopic  ?? ''
      }).then(() => reply({ ok: true }));
      return true;

    case 'getConfig':
      getCfg().then(c => reply({ serverUrl: c.carServerUrl ?? '', apiKey: c.carApiKey ?? '', ntfyTopic: c.carNtfyTopic ?? '' }));
      return true;

    case 'testServer':
      (async () => {
        const cfg = await getCfg();
        if (!cfg.carServerUrl) { reply({ ok: false, reason: 'No server URL saved' }); return; }
        try {
          const r = await fetch(`${cfg.carServerUrl.replace(/\/$/, '')}/ping`, {
            headers: { 'x-api-key': cfg.carApiKey ?? '' },
            signal: AbortSignal.timeout(8_000)
          });
          const json = await r.json().catch(() => ({}));
          reply({ ok: r.ok, status: r.status, message: json.message });
        } catch (e) { reply({ ok: false, reason: e.message }); }
      })();
      return true;

    case 'testNtfy':
      (async () => {
        const { carNtfyTopic: topic } = await getCfg();
        if (!topic) { reply({ ok: false, reason: 'No topic configured' }); return; }
        try {
          const r = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
            method: 'POST',
            headers: { 'Title': '🧪 Claude Auto-Resume Test', 'Tags': 'white_check_mark', 'Content-Type': 'text/plain' },
            body: 'Connected! You will be notified when Claude cooldown ends.'
          });
          reply({ ok: r.ok });
        } catch (e) { reply({ ok: false, reason: e.message }); }
      })();
      return true;
  }
});

chrome.runtime.onInstalled.addListener(() => console.log('[CAR] Extension installed — v1.0.0'));
