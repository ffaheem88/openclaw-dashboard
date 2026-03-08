# OpenClaw Dashboard — Feature Roadmap

> Collaboratively designed by ClawBot & VISbot, approved by Faisal.

## Phase 1: Quick Wins (UI work, existing backend data)

### 1. ⏰ Cron & Heartbeat Manager
**Assignee:** VISbot  
**Priority:** High  
**Effort:** Medium  

Create/edit/toggle/delete cron jobs and heartbeat tasks from the dashboard UI.
- CRUD interface for cron jobs (pattern, model, task, channel)
- Execution history timeline with success/failure indicators
- Next-run countdown timers
- Heartbeat task editor (edit HEARTBEAT.md content)
- Pause/resume individual crons without deleting

**Backend:** Read/write `~/.openclaw/openclaw.json` cron config, parse cron execution logs.

---

### 2. 🗂️ Workspace File Manager
**Assignee:** ClawBot  
**Priority:** High  
**Effort:** Medium  

Browse, view, and edit workspace files directly from the dashboard.
- File tree browser for `~/.openclaw/workspace/`
- Markdown preview for `.md` files (SOUL.md, MEMORY.md, AGENTS.md, etc.)
- Syntax highlighting for code files
- Create/rename/delete files
- In-browser editor with save functionality
- Diff view for recent changes

**Backend:** New Express routes for file CRUD operations on workspace directory.

---

### 3. 📱 Mobile Responsive
**Assignee:** ClawBot  
**Priority:** High  
**Effort:** Medium  

Full responsive redesign of all dashboard pages.
- Collapsible sidebar navigation
- Swipeable cards for mobile
- Touch-friendly controls and buttons
- Responsive charts and tables
- Bottom navigation bar on mobile
- Test across iOS Safari, Android Chrome

**Backend:** None — pure CSS/JS frontend work.

---

## Phase 2: Core Value (new SSE infrastructure, new API endpoints)

### 4. 📊 Analytics & Cost Dashboard
**Assignee:** VISbot  
**Priority:** Critical  
**Effort:** Large  

Comprehensive analytics page with historical trends and cost tracking.
- Per-model token usage over time (line charts)
- Daily/weekly/monthly cost breakdown
- Budget threshold alerts with configurable limits
- Most-used tools ranking
- Busiest hours heatmap
- Exportable CSV/JSON data
- Cost comparison across models

**Backend:** Parse `token-history.jsonl`, aggregate stats, new `/api/analytics/*` endpoints.

---

### 5. 🔴 Live Operations View
**Assignee:** ClawBot  
**Priority:** Critical  
**Effort:** Large  

Real-time session viewer showing messages, tool calls, and token consumption as they happen.
- SSE-based live message stream (no polling)
- Token burn counter updating in real-time
- Tool call visualization (name, duration, result)
- Multi-agent tree view showing parent→child hierarchies
- Kill/steer controls for any active session
- Session filtering and search

**Backend:** SSE endpoint streaming gateway logs, WebSocket fallback option.

---

### 6. 💬 Channel & Plugin Status Board
**Assignee:** VISbot  
**Priority:** High  
**Effort:** Medium  

Health status dashboard for all connected channels and plugins.
- Green/yellow/red status indicators per channel
- Last message timestamp per channel
- Reconnect/restart buttons
- Error log viewer per channel
- Plugin version info
- Connection uptime tracking

**Backend:** New `/api/channels/status` endpoint, parse gateway service logs.

---

## Phase 3: Polish (advanced features)

### 7. 🧠 Enhanced Memory Explorer
**Assignee:** ClawBot  
**Priority:** Medium  
**Effort:** Large  

Upgrade existing Neural page with search, edit, and prune capabilities.
- Semantic search across all memories
- Inline edit/delete individual memories
- Visual knowledge graph with entity connections
- Memory timeline (when was each memory created)
- Memory categories and tagging
- Import/export memory snapshots

**Backend:** Extend nmem CLI integration, add memory CRUD endpoints.

---

### 8. 🔔 Alert System
**Assignee:** VISbot  
**Priority:** Medium  
**Effort:** Medium  

Configurable push notifications for important events.
- Budget threshold warnings
- Error spike detection
- Agent offline alerts
- Disk space warnings
- Delivery to WhatsApp, email, ntfy, or webhook
- Alert history and acknowledgment
- Quiet hours configuration

**Backend:** Alert evaluation engine, notification dispatch service.

---

### 9. 🔐 Audit Log
**Assignee:** VISbot  
**Priority:** Medium  
**Effort:** Medium  

Comprehensive logging of all dashboard and agent actions.
- Every tool call logged with timestamp, caller, result
- File access tracking
- External API call log
- Search and filter by action type, date range
- Flag sensitive actions (deletions, config changes)
- Retention policy configuration

**Backend:** SQLite audit table, middleware to capture actions.

---

### 10. 👥 Multi-User Auth
**Assignee:** ClawBot  
**Priority:** Low  
**Effort:** Large  

Role-based access control for multi-user deployments.
- Admin role: full access (create/edit/delete)
- Viewer role: read-only dashboard access
- API key scoping per user
- Session management (force logout)
- Invite link generation
- OAuth provider support (GitHub, Google)

**Backend:** Extend existing auth system, add roles table, permission middleware.

---

## Work Distribution Summary

| # | Feature | Assignee | Phase | Effort |
|---|---------|----------|-------|--------|
| 1 | Cron & Heartbeat Manager | VISbot | 1 | Medium |
| 2 | Workspace File Manager | ClawBot | 1 | Medium |
| 3 | Mobile Responsive | ClawBot | 1 | Medium |
| 4 | Analytics & Cost Dashboard | VISbot | 2 | Large |
| 5 | Live Operations View | ClawBot | 2 | Large |
| 6 | Channel & Plugin Status Board | VISbot | 2 | Medium |
| 7 | Enhanced Memory Explorer | ClawBot | 3 | Large |
| 8 | Alert System | VISbot | 3 | Medium |
| 9 | Audit Log | VISbot | 3 | Medium |
| 10 | Multi-User Auth | ClawBot | 3 | Large |

**ClawBot:** #2, #3, #5, #7, #10 (frontend-heavy)  
**VISbot:** #1, #4, #6, #8, #9 (backend-heavy)
