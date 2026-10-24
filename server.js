/**
 * Claude Auto-Resume — Cloud Server
 *
 * Receives cooldown schedules from the Chrome extension, waits out the
 * cooldown period, then sends "continue" directly to Claude.ai's API
 * using the user's session token. Works for both Free and Pro plans.
 *
 * Deployment: Render.com (free tier) — see README for full guide.
 *
 * Environment variables:
 *   API_KEY   Required. Secret key matching the one in the extension popup.
 *   PORT      Optional. Defaults to 3000.
 *   LOG_LEVEL Optional. "verbose" for full request logging.
 */

'use strict';

const express   = require('express');
const crypto    = require('crypto');

const app     = express();
const PORT    = parseInt(process.env.PORT    ?? '3000', 10);
const API_KEY = process.env.API_KEY ?? '';
const VERBOSE = process.env.LOG_LEVEL === 'verbose';

if (!API_KEY) console.warn('[CAR] ⚠️  API_KEY not set — server is open to anyone!');

app.use(express.json({ limit: '64kb' }));

/* ── Logging ──────────────────────────────────────────────────────────── */
function log(level, ...args) {
  const ts = new Date().toISOString();
  if (level === 'verbose' && !VERBOSE) return;
  console.log(`[CAR ${ts}]`, ...args);
}

/* ── In-memory job store ──────────────────────────────────────────────── */
// Map<jobId, { timer, meta }>
const jobs = new Map();

/* ── Auth middleware ──────────────────────────────────────────────────── */
function auth(req, res, next) {
  if (!API_KEY) return next();
  if ((req.headers['x-api-key'] ?? '') !== API_KEY)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/* ═══════════════════════════════════════════════════════════════════════
   Claude.ai API helper
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Build the Claude.ai completion endpoint URL from available data.
 * Tries three strategies in order of reliability.
 */
function buildApiUrl({ apiUrl, orgId, convId, chatUrl }) {
  // Strategy 1: use the exact URL captured by the extension
  if (apiUrl) return apiUrl;

  // Strategy 2: reconstruct from org + conv IDs
  if (orgId && convId)
    return `https://claude.ai/api/organizations/${orgId}/chat_conversations/${convId}/completion`;

  // Strategy 3: extract conv ID from the chat URL
  const convMatch = (chatUrl ?? '').match(/\/chat\/([a-f0-9-]{36})/i);
  if (convMatch)
    return `https://claude.ai/api/chat_conversations/${convMatch[1]}/completion`;

  return null;
}

/**
 * Build the request body for a "continue" message.
 * Merges the captured payload template with our override fields.
 */
function buildPayload({ payloadTpl, parentMsgUuid, timezone, renderingMode }) {
  const base = {
    prompt:               'continue',
    parent_message_uuid:  parentMsgUuid ?? null,
    timezone:             timezone      ?? 'UTC',
    attachments:          [],
    files:                [],
    rendering_mode:       renderingMode ?? 'raw',
    personalized_styles:  []
  };

  if (!payloadTpl) return base;

  // Merge: keep template values except for the fields we always override
  return {
    ...payloadTpl,
    prompt:              'continue',
    parent_message_uuid: payloadTpl.parent_message_uuid ?? parentMsgUuid ?? null,
    timezone:            payloadTpl.timezone ?? timezone ?? 'UTC',
    attachments:         payloadTpl.attachments ?? [],
    files:               payloadTpl.files       ?? []
  };
}

/**
 * Attempt to send "continue" to Claude.ai.
 * Returns { ok, status, reason }.
 *
 * Tries up to 3 strategies:
 *  A. Full payload with parent_message_uuid
 *  B. Payload without parent_message_uuid (fallback)
 *  C. Different endpoint format (fallback)
 */
async function sendContinue(job) {
  const { cookieHeader, orgId, convId, apiUrl, parentMsgUuid, timezone, renderingMode, payloadTpl, chatUrl } = job;

  const endpoint = buildApiUrl({ apiUrl, orgId, convId, chatUrl });
  if (!endpoint) return { ok: false, reason: 'Could not determine API endpoint — no orgId/convId/apiUrl captured' };

  const commonHeaders = {
    'Content-Type':               'application/json',
    'Cookie':                     cookieHeader,
    'Origin':                     'https://claude.ai',
    'Referer':                    chatUrl ?? 'https://claude.ai',
    'User-Agent':                 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'anthropic-client-platform':  'web_claude_ai',
    'Accept':                     'text/event-stream',
    'Accept-Language':            'en-US,en;q=0.9',
    'Cache-Control':              'no-cache'
  };

  const strategies = [
    // A — exact payload with parent UUID
    () => buildPayload({ payloadTpl, parentMsgUuid, timezone, renderingMode }),
    // B — minimal payload without parent UUID
    () => ({ prompt: 'continue', timezone: timezone ?? 'UTC', attachments: [], files: [], rendering_mode: renderingMode ?? 'raw' }),
    // C — bare minimum
    () => ({ prompt: 'continue' })
  ];

  for (let i = 0; i < strategies.length; i++) {
    const payload = strategies[i]();
    log('verbose', `Strategy ${String.fromCharCode(65 + i)} → ${endpoint}`);

    try {
      const res = await fetch(endpoint, {
        method:  'POST',
        headers: commonHeaders,
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(25_000)
      });

      // Drain a bit of the SSE stream then close
      if (res.body) {
        const reader = res.body.getReader();
        const drain  = async () => {
          const { done } = await reader.read();
          if (!done) await reader.read(); // read one more chunk then cancel
          reader.cancel().catch(() => {});
        };
        drain().catch(() => {});
      }

      if (res.ok || res.status === 200) {
        log('info', `✅ Strategy ${String.fromCharCode(65 + i)} succeeded (HTTP ${res.status})`);
        return { ok: true, status: res.status, strategy: String.fromCharCode(65 + i) };
      }

      log('info', `Strategy ${String.fromCharCode(65 + i)} got HTTP ${res.status} — trying next`);

      // 401/403 means session expired — no point retrying other strategies
      if (res.status === 401 || res.status === 403)
        return { ok: false, status: res.status, reason: `Session expired or invalid (HTTP ${res.status})` };

    } catch (err) {
      log('info', `Strategy ${String.fromCharCode(65 + i)} threw: ${err.message}`);
      if (i === strategies.length - 1)
        return { ok: false, reason: err.message };
    }
  }

  return { ok: false, reason: 'All strategies exhausted' };
}

/* ── ntfy.sh notification ─────────────────────────────────────────────── */
async function sendNtfy(topic, chatUrl, message) {
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method:  'POST',
      headers: {
        'Title':         '✅ Claude Auto-Resume',
        'Tags':          'robot',
        'Priority':      'high',
        'Click':         chatUrl ?? 'https://claude.ai',
        'Content-Type':  'text/plain'
      },
      body:    message,
      signal:  AbortSignal.timeout(8_000)
    });
    log('verbose', `ntfy sent to topic "${topic}"`);
  } catch (e) { log('verbose', `ntfy failed: ${e.message}`); }
}

/* ═══════════════════════════════════════════════════════════════════════
   Routes
   ═══════════════════════════════════════════════════════════════════════ */

/** Health check — also used by the extension's "Test Connection" button */
app.get('/ping', auth, (_req, res) => {
  res.json({ ok: true, message: 'Claude Auto-Resume server is running ✅', activeJobs: jobs.size });
});

/** Schedule a resume job */
app.post('/schedule', auth, (req, res) => {
  const {
    cookieHeader, cookieFound,
    orgId, convId, apiUrl, parentMsgUuid,
    timezone, renderingMode, payloadTpl,
    chatUrl, resumeAt, label, ntfyTopic
  } = req.body;

  /* Validation */
  if (!cookieHeader) return res.status(400).json({ error: 'cookieHeader is required' });
  if (!resumeAt)     return res.status(400).json({ error: 'resumeAt (unix ms) is required' });
  if (!chatUrl && !orgId && !convId && !apiUrl)
    return res.status(400).json({ error: 'At least one of chatUrl / orgId+convId / apiUrl is required' });

  const delay  = Math.max(1000, resumeAt - Date.now());
  const jobId  = crypto.randomUUID();
  const fireAt = new Date(resumeAt).toISOString();

  log('info', `📅 Job ${jobId} scheduled — fires in ${Math.round(delay / 60_000)} min (${fireAt}) [cookie: ${cookieFound}]`);

  const timer = setTimeout(async () => {
    log('info', `🚀 Job ${jobId} firing — sending "continue" to Claude.ai…`);
    jobs.delete(jobId);

    const result = await sendContinue({ cookieHeader, orgId, convId, apiUrl, parentMsgUuid, timezone, renderingMode, payloadTpl, chatUrl });

    if (result.ok) {
      log('info', `✅ Job ${jobId} done — Claude received "continue"`);
      await sendNtfy(ntfyTopic, chatUrl, '✅ "continue" sent to Claude automatically!');
    } else {
      log('info', `❌ Job ${jobId} failed — ${result.reason}`);
      await sendNtfy(ntfyTopic, chatUrl,
        `⚠️ Auto-resume failed: ${result.reason}\nPlease open Claude and continue manually.`);
    }
  }, delay);

  jobs.set(jobId, { timer, meta: { chatUrl, label, resumeAt: fireAt } });

  res.json({ ok: true, jobId, firesAt: fireAt, delayMinutes: Math.round(delay / 60_000) });
});

/** Cancel a scheduled job */
app.post('/cancel', auth, (req, res) => {
  const { jobId } = req.body;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  clearTimeout(job.timer);
  jobs.delete(jobId);
  log('info', `🚫 Job ${jobId} cancelled`);
  res.json({ ok: true });
});

/** List active jobs (useful for debugging) */
app.get('/jobs', auth, (_req, res) => {
  const list = [...jobs.entries()].map(([id, { meta }]) => ({ jobId: id, ...meta }));
  res.json({ ok: true, count: list.length, jobs: list });
});

/* ── Start ────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  log('info', `🟢 Server running on port ${PORT}`);
  log('info', `🔑 API key: ${API_KEY ? '***configured***' : 'NOT SET — open access!'}`);
});
