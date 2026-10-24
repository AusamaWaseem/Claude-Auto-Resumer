# 🤖 Claude Auto-Resume

> Automatically resumes your Claude.ai session after a usage-limit cooldown —
> even when your PC is completely off.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue?logo=google-chrome)](extension/)
[![Works with Free Plan](https://img.shields.io/badge/Claude-Free%20%26%20Pro-orange)](https://claude.ai)

---

## How it works

When Claude.ai hits your usage limit, the extension detects the cooldown timer,
schedules a job on your cloud server, and when the timer expires the **server
sends "continue" directly to Claude.ai** — no interaction needed on your end.

```
You hit a limit on claude.ai
        │
        ▼
Extension detects cooldown & captures:
  • Session token  • Conversation ID  • Cooldown duration
        │
        ├──► Track 1: Cloud Server (Render.com — FREE)
        │           Waits, then POSTs "continue" to Claude.ai API
        │           ✅ Works even when PC is OFF
        │
        ├──► Track 2: Local Alarm (browser must stay open)
        │           Reopens the Claude tab and types "continue"
        │
        └──► Track 3: ntfy Push (phone backup)
                    Sends a notification — you tap once to open Claude
```

All three tracks run in parallel. If the server is configured, **you never
have to touch anything**.

---

## Features

- ✅ Works with **Claude Free plan** and **Claude Pro plan**
- ✅ Detects all known limit messages automatically
- ✅ Sends `"continue"` via Claude's internal API — no UI automation tricks
- ✅ Three-track fallback system — server → local alarm → phone notification
- ✅ Badge in the corner shows status and estimated resume time
- ✅ Safe to close the tab and the browser once cooldown is scheduled
- ✅ One-click server deployment to Render.com (free tier)
- ✅ Cancel any time from the extension popup

---

## Repository structure

```
claude-auto-resume/
├── extension/          # Chrome Extension (load unpacked)
│   ├── manifest.json
│   ├── background.js   # Service worker — alarm, server, ntfy coordination
│   ├── content.js      # Cooldown detection, badge UI, local resume
│   ├── fetch-interceptor.js  # Captures Claude.ai internal API format
│   ├── popup.html / popup.js # Extension popup with status + setup tabs
│   └── icons/
├── server/             # Node.js server — deploy to Render.com
│   ├── server.js
│   ├── package.json
│   └── .env.example
├── .github/
│   └── ISSUE_TEMPLATE/
├── LICENSE
└── README.md
```

---

## Quick Start

### Step 1 — Install the Chrome Extension

1. Clone or [download this repo as ZIP](../../archive/refs/heads/main.zip)
2. Open Chrome → go to `chrome://extensions`
3. Toggle **Developer mode** ON (top-right)
4. Click **Load unpacked** → select the `extension/` folder
5. The Claude Auto-Resume icon appears in your toolbar

### Step 2 — Deploy the Server (free, ~3 minutes)

The server is what sends `"continue"` when your PC is off.

#### Option A — Render.com (recommended, free tier)

1. Fork this repository to your GitHub account
2. Go to [render.com](https://render.com) → **New** → **Web Service**
3. Connect your GitHub account and select this repo
4. Set the **Root Directory** to `server`
5. Set **Build Command** to `npm install`
6. Set **Start Command** to `npm start`
7. Add these **Environment Variables**:

   | Key | Value |
   |-----|-------|
   | `API_KEY` | Any secret string you choose, e.g. `my-secret-42` |
   | `PORT` | `3000` |

8. Click **Create Web Service** — Render gives you a free URL like `https://your-app.onrender.com`

> **Keep-alive (important for Render free tier):** Render free instances sleep after
> 15 minutes of inactivity. Sign up for [UptimeRobot](https://uptimerobot.com) (free)
> and add a monitor pointing to `https://your-app.onrender.com/ping` every 5 minutes
> to keep it awake.

#### Option B — Railway.app

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
2. Select this repo, set root to `server/`
3. Add env vars: `API_KEY` and `PORT=3000`
4. Railway provides `$5/month` free credit — enough for this server

#### Option C — Run locally (only works if PC stays on)

```bash
cd server
cp .env.example .env
# Edit .env and set API_KEY
npm install
npm start
```

### Step 3 — Connect the Extension to Your Server

1. Click the Claude Auto-Resume icon in Chrome
2. Go to the **🌐 Server** tab
3. Enter your server URL (e.g. `https://your-app.onrender.com`)
4. Enter your API key (the one you set in the env vars)
5. Click **Save & Test Connection** — you should see ✅

### Step 4 (Optional) — Phone Notifications via ntfy

For a backup notification if the server fails:

1. Install the **ntfy** app on your phone ([iOS](https://apps.apple.com/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy))
2. Tap **+** in the app and subscribe to a unique topic, e.g. `claude-yourname-42`
3. In the extension popup → **📱 Phone** tab → enter the same topic → Save
4. Tap **Send Test Notification** to confirm it works

---

## Usage

Once everything is set up, just use Claude normally. When you hit a usage limit:

1. A badge appears in the corner of your Claude tab showing the resume time
2. The extension schedules the job on your server
3. **You can close the tab, the browser, and even your PC**
4. At the scheduled time, the server POSTs `"continue"` to your Claude conversation
5. Claude resumes generating exactly where it left off

---

## How the extension captures Claude's API

`fetch-interceptor.js` runs in the page's MAIN world and wraps the browser's
`fetch()` function. Every time you send a message on Claude.ai, it captures:

- The exact API endpoint URL (`/api/organizations/{orgId}/chat_conversations/{convId}/completion`)
- Your organisation ID and conversation ID
- The `parent_message_uuid` (needed to chain the reply correctly)
- The full payload template (timezone, rendering mode, etc.)

This data is stored locally and sent to the server when a cooldown is detected.
The server then replays the request with `prompt: "continue"`.

### What if I haven't sent any messages yet in this session?

The server falls back to reconstructing the API URL from the conversation ID
in the chat URL. It also tries three strategies with progressively simpler
payloads, so even without a captured template it has a good chance of working.

---

## Configuration reference

### Extension storage keys

| Key | Description |
|-----|-------------|
| `carServerUrl` | Your cloud server URL |
| `carApiKey` | API key for the server |
| `carNtfyTopic` | ntfy.sh topic name |
| `carApiCapture` | Last captured Claude.ai API details |
| `carState` | Current cooldown / job state |

### Server environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `API_KEY` | Yes | Secret key — must match the extension popup |
| `PORT` | No (default 3000) | HTTP port |
| `LOG_LEVEL` | No | Set to `verbose` for detailed logs |

### Server endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/ping` | Health check — returns `{ ok, message, activeJobs }` |
| `POST` | `/schedule` | Schedule a resume job |
| `POST` | `/cancel` | Cancel a scheduled job by `jobId` |
| `GET` | `/jobs` | List all active jobs |

All endpoints require the `x-api-key` header to match `API_KEY`.

---

## Supported cooldown messages

The extension detects all of the following (case-insensitive):

- `usage limit` / `message limit` / `rate limit`
- `free plan limit` / `daily limit` / `hourly limit`
- `you've reached` / `you have reached`
- `try again in` / `come back in` / `available in` / `available again in`
- `resets in` / `resets at`
- `claude is at capacity` / `claude.ai is at capacity`
- `limit reached` / `plan limit`

Time formats handled: `5 hours`, `4 hours 30 minutes`, `4h 30m`, `30 minutes`,
`tomorrow` (estimates midnight + 5 min).

---

## Security notes

- Your Claude.ai **session token** is sent to your own server over HTTPS.
  Never use a shared or public server — only your own deployment.
- The `API_KEY` protects your server endpoints — treat it like a password.
- Session tokens are **held in memory only** — never written to disk or logged.
- This project uses Claude.ai's **internal API**, which is not officially
  documented. Anthropic may change it at any time. If auto-resume stops
  working, check for updates in this repo.

---

## Troubleshooting

**Server test shows ❌**
- Double-check the URL has no trailing slash
- Make sure `API_KEY` in the extension matches the one in your server env vars
- Check your Render/Railway logs for startup errors

**"continue" is sent but Claude doesn't respond**
- Your session may have expired (Claude.ai sessions typically last days/weeks)
- Try reloading Claude.ai — if you're logged out, log in and the next cooldown will capture a fresh token

**Cooldown not detected**
- Refresh the Claude.ai page with the extension installed — it needs to be active on the page
- Check if the limit message on Claude.ai contains any of the phrases in the list above

**Render instance asleep when cooldown ends**
- Set up UptimeRobot to ping `/ping` every 5 minutes (see setup guide above)

---

## Contributing

Pull requests welcome. Please:
- Keep the server dependency-free except for `express`
- Test on both Free and Pro Claude accounts if possible
- Update this README if you add new features

---

## Disclaimer

This project is not affiliated with or endorsed by Anthropic. It uses
Claude.ai's internal API for personal automation. Use at your own risk
and in accordance with [Anthropic's Terms of Service](https://www.anthropic.com/legal/consumer-terms).

---

## License

[MIT](LICENSE) © Ausama Waseem
