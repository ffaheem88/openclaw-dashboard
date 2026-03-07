# OpenClaw Dashboard

A web dashboard for monitoring and managing your [OpenClaw](https://github.com/openclaw/openclaw) agent.

![Node.js](https://img.shields.io/badge/Node.js-18+-green) ![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Live Dashboard** — Real-time agent status, session monitoring, token usage stats
- **Agent Orchestration** — View active sessions, sub-agents, cron jobs; kill/manage sessions
- **Neural Memory** — Visualize memory graph, search/recall, view memory stats
- **Mail** — Read agent email inbox (via Himalaya CLI)
- **Logs** — Live-tail agent logs, service status
- **Settings** — Model configuration, budget tracking, provider health checks
- **Identity** — Agent identity and personality viewer
- **Cost Tracking** — Per-model cost breakdown and daily summaries

## Quick Start

```bash
# Clone
git clone https://github.com/ffaheem88/openclaw-dashboard.git
cd openclaw-dashboard

# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env with your settings

# Run
node server.js
```

Dashboard will be available at `http://localhost:3000`

## Requirements

- Node.js 18+
- A running [OpenClaw](https://github.com/openclaw/openclaw) instance
- Optional: Himalaya CLI (for mail), nmem (for neural memory), pymssql (for VIS integration)

## Pages

| Page | Description |
|------|-------------|
| `/` | Main dashboard — sessions, stats, health |
| `/agents.html` | Agent orchestration — sessions, crons, sub-agents |
| `/neural.html` | Neural memory graph and recall |
| `/mail.html` | Email inbox viewer |
| `/logs.html` | Live log viewer |
| `/settings.html` | Model config, budgets, provider health |
| `/identity.html` | Agent identity viewer |

## Authentication

Default login is `admin` / password set on first run. Change via Settings page or by editing `config/dashboard-auth.json`.

## Environment Variables

See `.env.example` for all options. The dashboard auto-detects OpenClaw paths if installed in the standard location (`~/.openclaw/`).

## License

MIT
