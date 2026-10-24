/* ── Tab switching ──────────────────────────────────────────────────── */
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab, .panel').forEach(el => el.classList.remove('active'));
  t.classList.add('active');
  document.getElementById('panel-' + t.dataset.p).classList.add('active');
}));

const $  = id => document.getElementById(id);
const msg = (id, text, type) => { const el = $(id); el.className = `notice n-${type}`; el.style.display = 'block'; el.innerHTML = text; };

/* ── Status panel ───────────────────────────────────────────────────── */
const TRACK_MAP = {
  scheduled:      '✅ Scheduled',
  failed:         '❌ Failed — check setup',
  not_configured: '⚪ Not configured',
  cancelled:      '🚫 Cancelled'
};

function renderStatus(s) {
  const idle = !s?.cooldownActive && !s?.pendingResume;

  if (idle) {
    $('overallStatus').innerHTML = '<span class="dot dot-z"></span>Idle — no cooldown active';
    ['tracksCard','timerCard','urlCard'].forEach(id => $(id).style.display = 'none');
    $('cancelBtn').disabled = true;
    return;
  }
  if (s.pendingResume) {
    $('overallStatus').innerHTML = '<span class="dot dot-g"></span>Resuming session…';
    $('cancelBtn').disabled = false;
    return;
  }
  $('overallStatus').innerHTML = `<span class="dot dot-a"></span>Cooldown — ${s.cooldownLabel ?? 'waiting'}`;
  $('cancelBtn').disabled = false;
  $('tracksCard').style.display = 'block';

  $('tServer').textContent = TRACK_MAP[s.serverStatus] ?? '—';
  $('tLocal').textContent  = 'Scheduled (browser must stay open)';
  $('tNtfy').textContent   = TRACK_MAP[s.ntfyStatus]   ?? '—';

  if (s.resumeAt) { $('timerCard').style.display = 'block'; $('resumeTime').textContent = new Date(s.resumeAt).toLocaleTimeString(); }
  if (s.chatUrl)  {
    $('urlCard').style.display = 'block';
    try { const u = new URL(s.chatUrl); $('chatUrl').textContent = u.pathname.length > 40 ? '…' + u.pathname.slice(-40) : u.pathname; }
    catch (_) { $('chatUrl').textContent = s.chatUrl; }
  }
}

chrome.runtime.sendMessage({ action: 'getStatus' }, renderStatus);
$('cancelBtn').addEventListener('click', () => chrome.runtime.sendMessage({ action: 'cancelCooldown' }, () => renderStatus({})));

/* ── Server panel ───────────────────────────────────────────────────── */
chrome.runtime.sendMessage({ action: 'getConfig' }, cfg => {
  if (cfg?.serverUrl)  $('serverUrl').value  = cfg.serverUrl;
  if (cfg?.apiKey)     $('apiKey').value     = cfg.apiKey;
  if (cfg?.ntfyTopic)  $('ntfyTopic').value  = cfg.ntfyTopic;
});

$('saveServerBtn').addEventListener('click', () => {
  const serverUrl = $('serverUrl').value.trim();
  const apiKey    = $('apiKey').value.trim();
  if (!serverUrl) { msg('serverNotice', 'Please enter a server URL.', 'err'); return; }

  $('saveServerBtn').disabled    = true;
  $('saveServerBtn').textContent = 'Testing…';

  chrome.runtime.sendMessage({ action: 'saveConfig', serverUrl, apiKey, ntfyTopic: $('ntfyTopic').value.trim() }, () => {
    chrome.runtime.sendMessage({ action: 'testServer' }, res => {
      $('saveServerBtn').disabled    = false;
      $('saveServerBtn').textContent = 'Save & Test Connection';
      if (res?.ok) msg('serverNotice', '✅ Connected! Server will send "continue" automatically.', 'ok');
      else         msg('serverNotice', `❌ ${res?.reason ?? 'Could not reach server — check the URL and API key.'}`, 'err');
    });
  });
});

/* ── Phone/ntfy panel ───────────────────────────────────────────────── */
$('saveNtfyBtn').addEventListener('click', () => {
  const ntfyTopic = $('ntfyTopic').value.trim();
  if (!ntfyTopic) { msg('ntfyNotice', 'Enter a topic name first.', 'err'); return; }
  chrome.runtime.sendMessage({ action: 'saveConfig', ntfyTopic, serverUrl: $('serverUrl').value.trim(), apiKey: $('apiKey').value.trim() },
    () => msg('ntfyNotice', '✅ Topic saved.', 'ok'));
});

$('testNtfyBtn').addEventListener('click', () => {
  const ntfyTopic = $('ntfyTopic').value.trim();
  if (!ntfyTopic) { msg('ntfyNotice', 'Save a topic first.', 'err'); return; }
  $('testNtfyBtn').disabled = true; $('testNtfyBtn').textContent = 'Sending…';
  chrome.runtime.sendMessage({ action: 'saveConfig', ntfyTopic, serverUrl: $('serverUrl').value.trim(), apiKey: $('apiKey').value.trim() }, () => {
    chrome.runtime.sendMessage({ action: 'testNtfy' }, res => {
      $('testNtfyBtn').disabled = false; $('testNtfyBtn').textContent = 'Send Test Notification';
      if (res?.ok) msg('ntfyNotice', '✅ Notification sent — check your phone!', 'ok');
      else         msg('ntfyNotice', `❌ Failed: ${res?.reason ?? 'check your topic name'}.`, 'err');
    });
  });
});
