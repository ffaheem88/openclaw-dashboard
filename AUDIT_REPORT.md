# OpenClaw Dashboard Audit Report

Audited: `@ffaheem88/openclaw-dashboard@1.0.4`  
Files: 21 (server.js + 18 HTML + 1 CSS + cli.js)  
Total lines: ~15,770

---

## 🔴 Critical Issues (must fix)

### 1. Command Injection in Cron CRUD (server.js:579-584)
User input (`name`, `schedule`, `message`, `description`) is interpolated into shell commands with only `"` escaping. Backticks, `$()`, and `\n` bypass this:
```js
let cmd = `openclaw cron add --name "${name.replace(/"/g, '\\"')}" --schedule "${schedule}"...`
```
**Fix:** Use `execFile` with array args, or validate inputs against strict patterns (alphanumeric + safe chars only).

### 2. Command Injection in Cron Enable/Disable/Run/Delete (server.js:612-637)
`req.params.id` is passed directly to shell commands with NO validation:
```js
const result = exec(`openclaw cron enable ${req.params.id} 2>&1`);
const result = exec(`openclaw cron rm ${req.params.id} --yes 2>&1`);
```
**Fix:** Validate cron ID against `/^[a-zA-Z0-9_-]+$/` before using in commands.

### 3. Missing Body Parsers on Cron Routes (server.js:575-637)
`POST /api/crons`, `PUT /api/crons/:id` etc. read `req.body` but have no `express.json()` middleware. `req.body` is always `undefined`:
```js
app.post('/api/crons', (req, res) => {
  const { name, description, schedule } = req.body; // undefined!
```
**Fix:** Add `express.json()` to each route, or add `app.use(express.json())` globally.

### 4. `cache.delete()` doesn't exist — should be `cache.del()` (server.js:585,604,613,622,638...)
TTLCache has `.del(k)` method, but code calls `.delete()` which is undefined (no-op):
```js
cache.delete('crons_simple'); // silently does nothing
```
12+ occurrences. Cache never invalidates after cron operations.
**Fix:** Change all `cache.delete(...)` to `cache.del(...)`.

### 5. `cache.clear()` doesn't exist (server.js:3540)
Same issue — `cache.clear()` after workspace file save does nothing.
**Fix:** Add a `clear()` method to TTLCache, or call `.del()` on specific keys.

### 6. Hardcoded PORT=3000, env var ignored (server.js:36)
```js
const PORT = 3000;
```
`process.env.PORT` is never read. The `--port` CLI flag and `PORT` env var have no effect.
**Fix:** `const PORT = parseInt(process.env.PORT) || 3000;`

---

## 🟠 High Priority (should fix)

### 7. XSS via innerHTML in 8+ pages
Session names, agent tasks, file paths, and search results from the backend are inserted via `innerHTML` without escaping:
- `agents-control.html`: 3 innerHTML, 0 escapeHtml
- `channels.html`: 7 innerHTML, 0 escapeHtml  
- `conv-analytics.html`: 3 innerHTML, 0 escapeHtml
- `analytics.html`: 2 innerHTML, 0 escapeHtml
- `agents.html`: 20+ innerHTML including error messages

**Fix:** Add `escapeHtml()` function to all pages (like `live.html` and `memory.html` already have), use it for all dynamic content.

### 8. Path Traversal in Workspace Search (server.js:2794+)
While `..` is blocked in `/api/workspace/file`, the search endpoint uses `grep` with user query:
```js
const raw = exec(`grep -rni "${safeQuery}" ${WORKSPACE} ...`);
```
Even with character filtering, symlinks inside WORKSPACE could escape the boundary.
**Fix:** Resolve absolute path and verify it starts with WORKSPACE after resolution.

### 9. No CSRF Protection
All state-changing operations (POST/PUT/DELETE) have no CSRF tokens. Since session cookies are used, any site could make cross-origin requests to the dashboard.
**Fix:** Add CSRF middleware (e.g., `csurf`) or use `SameSite=Strict` on session cookie.

### 10. Default Session Secret (server.js:57)
```js
secret: process.env.SESSION_SECRET || 'change-me-in-production'
```
If no env var is set, all sessions use a known secret. Setup wizard generates a random one, but users who skip setup or use `openclaw-dashboard start` directly get the default.
**Fix:** Auto-generate and persist a random secret on first run if not configured.

### 11. Mobile Debug Log — Unauthenticated Write (server.js:154-157)
```js
app.post('/api/mobile-log', express.json(), (req, res) => {
  fs.appendFileSync(path.join(WORKSPACE, 'tradeiators/mobile-debug.log'), entry);
```
Unauthenticated endpoint writes arbitrary JSON to disk. Can fill disk or write misleading data. Also hardcoded to `tradeiators/` path — won't exist on other installs.
**Fix:** Remove or gate behind auth. At minimum, add rate limiting and size cap.

### 12. Contact Form — Unauthenticated Write (server.js:161-167)
Similar to above — writes to `arc-consultancy/inquiries.log`. Path is hardcoded and specific to one install.
**Fix:** Make configurable or remove. Add rate limiting.

### 13. VIS-Specific Code in Generic Package (server.js:725-755)
SQL Server connection, VIS database queries, `pymssql` — all hardcoded for one specific deployment. Will error on every other install.
**Fix:** Move behind feature flag or plugin system. Return `{unavailable: true}` if VIS env vars not set.

---

## 🟡 Medium Priority (nice to fix)

### 14. Full Session Files Read Into Memory (server.js:940-1050)
`/api/orchestration/sessions` reads ALL .jsonl files (last 30 days) entirely into memory, parsing every line:
```js
const rawContent = fs.readFileSync(fullPath, 'utf8').trim();
const lines = rawContent.split('\n');
```
With many sessions or large logs, this can use 100s of MB of RAM.
**Fix:** Use streaming/tail approach (already have `tailLinesSync`), or read only first/last N lines per file.

### 15. Synchronous File I/O Everywhere
Every API route uses `fs.readFileSync`, `execSync`, `fs.writeFileSync`. Under concurrent requests, the event loop blocks.
**Fix:** For MVP this is acceptable, but add `async/await` with `fs.promises` for high-traffic routes.

### 16. ARC Website Routing Hardcoded (server.js:136-150)
```js
const ARC_HOSTS = ['arc.net.pk', 'www.arc.net.pk'];
```
Hardcoded domain routing for a specific website. Other users get unexpected behavior.
**Fix:** Make virtual host routing configurable, or disable if ARC_SITE directory doesn't exist.

### 17. `agents-control.html` — Steer API May Not Work
`POST /api/agent/steer` writes to a JSON file, but nothing reads it back. The agent won't see steer requests.
**Fix:** Either use OpenClaw's actual `sessions_send` mechanism, or document that steer is a placeholder.

### 18. `conv-analytics.html` — Missing `origin` and `chatType` Fields
The page assumes sessions have `origin` and `chatType` properties from `/api/live/sessions`, but sessions.json doesn't typically contain these. All sessions likely show as "unknown" channel.
**Fix:** Parse channel info from session keys (e.g., `agent:voice:whatsapp:...` → whatsapp).

### 19. `memory.html` — Search Calls Non-Existent API
`/api/workspace/search` exists but returns grep results with `{file, line}` format. The frontend expects `{results: [{file, line, text}]}`:
```js
data.results.forEach(function(r) { ... r.file + ':' + r.line ... });
```
Need to verify API response shape matches frontend expectations.

### 20. `analytics.html` — API Endpoints May Not Exist
References `/api/costs/summary`, `/api/costs/by-model`, `/api/sessions/hourly`, `/api/sessions/errors-summary`. Need to verify these all exist in server.js.

### 21. `alerts.html` — Alert System is Config-Only
Save/load works, but nothing actually monitors thresholds or sends alerts. It's a UI without a backend engine.
**Fix:** Document as "coming soon" or implement a heartbeat-based alerting loop.

### 22. Neural DB Path Hardcoded (server.js:43)
```js
const NEURAL_DB_PATH = path.resolve(os.homedir(), '.neuralmemory/brains/default.db');
```
Not configurable via env var. Different nmem installations may use different paths.
**Fix:** Add `NEURAL_DB_PATH` env var option.

### 23. Setup Wizard — Overwrites .env Completely (server.js:3234-3240)
The setup save endpoint writes a fresh `.env`, losing any custom env vars the user had:
```js
fs.writeFileSync(envPath, envLines.join('\n') + '\n');
```
**Fix:** Merge with existing .env instead of overwriting.

---

## 🔵 Low Priority (polish)

### 24. No Rate Limiting
No rate limiting on login attempts or API calls. Brute-force attacks possible.

### 25. Inconsistent Error Responses
Some routes return `{error: "msg"}`, others return `{ok: false, error: "msg"}`, others use HTTP status codes. No consistent error format.

### 26. Dead Code — Duplicate Mobile-Log Route
Comment at server.js:3580 mentions a removed duplicate, but the original unauthenticated route at line 154 is still there.

### 27. `bin/cli.js` — Install Command Copies Files Naively
The `install` command copies files one by one with `fs.copyFileSync`. If the npm package adds new files, the install command won't know about them.
**Fix:** Use `fs.cpSync` (recursive) or rsync approach.

### 28. `responsive.css` — Hamburger Menu Inconsistency
Some pages have `toggleMobileNav()` inline, others don't. Menu toggle behavior varies across pages.

### 29. No 404 Page
Missing routes fall through to Express's default handler. Custom 404 page would match the theme.

### 30. `index.html` — Old `agents.html` Link
```html
<a href="/agents.html" class="nav-link">🎛️ Agents</a>
```
Should point to `/agents-control.html` (both exist but serve different purposes — confusing).

### 31. HTTP Only — No HTTPS Config
Dashboard only listens on HTTP. In production, relies on reverse proxy (Cloudflare tunnel) for HTTPS. If accessed directly, cookies and passwords travel in cleartext.

### 32. Session Store is In-Memory
Express sessions use the default MemoryStore. Server restart = all users logged out. Not suitable for production with multiple workers.

### 33. No Health Check for Dependencies
`/api/health` checks system metrics but not critical dependencies (SQLite access, session dir readability, OpenClaw process health).

---

## Per-Page Summary

| Page | Issues | Severity |
|------|--------|----------|
| `server.js` | Command injection (×2), missing body parsers, cache.delete bug, hardcoded port, sync I/O, VIS-specific code | Critical |
| `agents-control.html` | XSS via innerHTML, steer API placeholder | High |
| `agents.html` | 20+ innerHTML without escaping, error messages in HTML | High |
| `analytics.html` | Missing escapeHtml, unclear API dependency | Medium |
| `channels.html` | 7 innerHTML without escaping | High |
| `conv-analytics.html` | Missing origin/chatType data, XSS | Medium |
| `memory.html` | Search API shape mismatch | Medium |
| `alerts.html` | Config-only, no backend engine | Medium |
| `crons.html` | Depends on broken cron CRUD routes | Critical |
| `live.html` | Decent — has escapeHtml ✅ | Low |
| `login.html` | No rate limiting, no CSRF | Medium |
| `setup.html` | Overwrites .env | Medium |
| `settings.html` | Large file (1364 lines), otherwise OK | Low |
| `files.html` | OK — path validation present ✅ | Low |
| `identity.html` | OK | Low |
| `neural.html` | OK — graceful degradation ✅ | Low |
| `mail.html` | OK — folder allowlist ✅ | Low |
| `logs.html` | OK | Low |
| `index.html` | Old agents.html link | Low |
| `responsive.css` | Hamburger inconsistency across pages | Low |
| `bin/cli.js` | Naive file copy in install | Low |

---

## Top 5 Fixes (Biggest Impact)

1. **Fix PORT** — one-liner, unblocks `--port` and env var (line 36)
2. **Fix `cache.delete` → `cache.del`** — find-replace, unbreaks all cache invalidation (12 occurrences)
3. **Add body parsers to cron routes** — cron CRUD is completely broken without them
4. **Validate cron IDs** — regex check before shell exec prevents injection
5. **Add `escapeHtml` to all pages** — prevents XSS across the board
