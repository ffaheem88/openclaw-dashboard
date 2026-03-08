# OpenClaw Dashboard Audit Report

## Critical Issues (must fix)
- [server.js:79-87, 2965-3056, 3173-3250] Pre-setup takeover: the app intentionally allows every `/api/setup/*` route before setup completes, and `POST /api/setup/save` lets the first unauthenticated caller set the admin password. `GET /api/setup/detect` also leaks local install paths, service names, and masked provider keys before auth. Snippet: `if (req.path.startsWith('/api/setup/')) { if (!isSetupComplete()) return next(); }`. Suggested fix: require a bootstrap token, bind setup routes to localhost only, or require an out-of-band setup secret.
- [server.js:575-639] Cron mutation APIs are both broken and shell-injectable. `POST /api/crons` and `PUT /api/crons/:id` never mount `express.json()`, so `req.body` is usually `undefined`; they then interpolate user input into shell commands and call `cache.delete(...)`, but the cache class only implements `del(...)`. Snippet: `const { name, ... } = req.body; ... let cmd = \`openclaw cron add --name "${name...}"\`; ... cache.delete('crons_simple');`. In production this yields failed cron edits plus command injection risk via `schedule`, `tz`, `model`, `to`, and `:id`. Suggested fix: add JSON body parsing, validate every field against a strict schema, and use `spawn/execFile` with argv arrays.
- [server.js:2485-2489] `GET /api/neural/recall` is directly command-injectable. Only double quotes are escaped before building `execSync(\`nmem recall "${escaped}"\`)`; command substitution and shell metacharacters inside double quotes still execute. Suggested fix: use `execFile('nmem', ['recall', q])` or `spawn`.
- [server.js:3254-3310] `POST /api/setup/install` is also command-injectable before auth. `openclawHome` is copied into `nmem train ...` and the generated crontab line without shell-safe escaping. Because setup is unauthenticated pre-bootstrap, a remote caller can combine this with the setup takeover above. Snippet: ``execSync(`nmem train ${sources.join(' ')} 2>&1`)`` and ``const cronLine = `... ${openclawHome}/workspace/...` ``.
- [server.js:3521-3538] Saving a workspace file returns 500 after already mutating disk. The route writes the file, then calls nonexistent `cache.clear()`, which throws after the write succeeds. Snippet: `fs.writeFileSync(abs, content, 'utf8'); ... cache.clear();`. Production symptom: users see "save failed" while content has actually changed. Suggested fix: replace with targeted `cache.del(...)` calls and only write the success response after cache invalidation succeeds.
- [server.js:1384-1418] "Kill session" does not kill a running session. The API just renames the JSONL file and deletes the `sessions.json` entry; it never signals OpenClaw or the underlying process. Snippet: `fs.renameSync(sessionFile, deletedName); delete sessIndex[sessionKey];`. Production symptom: the dashboard claims the session was killed while the agent may continue running invisibly. Suggested fix: call the real OpenClaw/session termination mechanism and only update metadata after a confirmed stop.

## High Priority (should fix)
- [server.js:56-60, 116-118, 122-130, 3124-3170, 3488-3517] Session/auth security is too weak for an exposed admin dashboard. Issues include a hard-coded fallback secret (`change-me-in-production`), insecure cookies (`secure: false`), the default in-memory session store, no CSRF protection on state-changing POSTs, and logout over GET. Suggested fix: require a strong secret, set `secure/sameSite/httpOnly`, use a persistent store, add CSRF tokens or same-site protections, and make logout POST-only.
- [server.js:103-110, public/login.html:236-248] The login redirect flow is broken and unsafe. `POST /login` trusts `req.query.next` and calls `res.redirect(next)` without origin validation, but the login form hardcodes `action="/login"` so the normal UI drops `next` completely. Snippet: `const next = req.query.next || '/'; return res.redirect(next);`. Result: deep-link redirect does not work, while hand-crafted POSTs can produce open redirects. Suggested fix: persist `next` in a hidden input, and only allow same-origin relative paths.
- [server.js:36, 3575-3577, bin/cli.js:119-128] Port and host settings are effectively dead. `server.js` hardcodes `const PORT = 3000;` and listens on `'0.0.0.0'`, so `PORT`, setup-saved port, and CLI `--port/--host` do not change runtime behavior. Production symptom: the service always binds to 3000 regardless of CLI or saved config. Suggested fix: read `process.env.PORT` and `process.env.HOST` at startup and validate them.
- [server.js:1789-1803, 2182-2205] Provider/model discovery has multiple logic errors. The fallback `grep` strings are malformed literals (`' + (process.env.OPENCLAW_HOME ...`) and therefore never read keys from disk; OpenAI/Codex health checks do not send any auth header; Anthropic health treats 401/403 as "up". Suggested fix: parse `openclaw.json` as JSON instead of shelling out, and treat auth failures as configuration errors, not healthy provider responses.
- [server.js:2740-2833, public/files.html:169-217, public/identity.html:671-708, public/memory.html:172-190] The workspace APIs do not match the file explorer UX. `/api/workspace/files` only exposes a tiny allowlist (core files + `memory/*.md`), and `/api/workspace/search` only searches `*.md` and `*.json`, while the UI advertises general workspace browsing and editing for `.sh`, `.js`, `.py`, `.yml`, etc. Production symptom: files exist on disk but never appear in the tree or search results. Suggested fix: either broaden the API to a real safe workspace index or narrow the UI copy to match actual scope.
- [server.js:2890-2918] Network status is hard-coded to one deployment. `TUNNEL_ID`, `https://arc.net.pk`, and `https://dashboard.arc.net.pk` are compiled into the health API. Suggested fix: move them to config/env and make the checks optional per install.
- [public/analytics.html:114-176] The analytics page is wired to an old response shape. It expects `data.sessions`, `data.models`, and `data.daily`, but `/api/costs/summary` returns `sessions` (array), `modelTotals`, and `sevenDayBreakdown`. Snippet: `document.getElementById('totalSessions').textContent = data.sessions || '—';`. Production symptom: `totalSessions` becomes `[object Object]` and the charts render empty.
- [public/channels.html:149-182] Provider/network cards use response shapes the backend does not return. The page expects `data.providers` and `data.tunnel.status/data.dns`, while `/api/health/providers` returns a keyed object and `/api/network/status` returns `tunnel.active`, `port`, `arc`, and `dashboard`. Production symptom: "Provider check unavailable" or misleading "unknown" tunnel states on every refresh.
- [public/conv-analytics.html:113-183] The conversation analytics heatmap is broken against the current hourly API. The page reads `data[h]`, but the backend returns `hourBuckets` and `toolBuckets`. Snippet: `var val = data[h] || 0; var max = Math.max.apply(null, Object.values(data)...);`. Result: all-zero bars or `NaN` heatmap intensity.
- [public/crons.html:427-449] The heartbeat editor cannot work because it calls nonexistent endpoints: `/api/files/read?path=HEARTBEAT.md` and `/api/files/write`. The backend only implements `/api/workspace/file` GET/POST. Production symptom: the heartbeat tab always falls back to default text and save fails. Suggested fix: point the page at `/api/workspace/file`.
- [public/files.html:302-318] Markdown preview creates executable links from untrusted file content. After basic escaping, it rewrites Markdown links into raw `<a href="$2" target="_blank">`, so `[x](javascript:alert(1))` becomes a clickable JavaScript URL. Suggested fix: sanitize URLs and add `rel="noopener noreferrer"`.
- [public/neural.html:1212-1239, 1264-1269, 1532-1539] The neural graph detail panel writes DB-derived values straight into `innerHTML` without escaping (`node.type`, `node.tags`, connection labels, hot concept labels in attributes). Because neural memory can contain user-derived text, this is a stored DOM XSS vector. Suggested fix: render with `textContent` or escape every field before concatenation.
- [public/responsive.css:207-249] The shared mobile stylesheet has an unmatched closing brace at line 249. A simple brace scan goes negative there. Production symptom: browser-dependent CSS parsing after that point, especially around `header-nav`/cron mobile rules. Suggested fix: fix the brace structure and re-test all mobile layouts.

## Medium Priority (nice to fix)
- [server.js:1291-1330] Session detail truncates the wrong end of the transcript. The API returns `messages.slice(0, 100)`, which keeps the oldest 100 entries instead of the latest 100 the UI expects. Production symptom: the detail drawer misses the most recent messages and errors.
- [server.js:2928-2939] Admin cache stats show broken disk values because two shell commands are malformed template literals: ``du -sh ' + SESSIONS_DIR + '`` and ``du -sh ' + os.homedir() + '/.neuralmemory``. Result: `sessions` and `neural` disk usage stay `?`.
- [server.js:3110-3120, 3124-3147, 3173-3247] Config/env writes are fragile. Values are written raw as `KEY=value` with no escaping or newline filtering, so pasted values can inject extra env vars or corrupt `.env`; clearing a field does not unset the process env because only truthy values are copied back into `process.env`. Suggested fix: escape multiline values, validate input, and explicitly delete removed keys.
- [server.js:3173-3247] `POST /api/setup/save` returns `{ restart: false }`, but most runtime paths (`WORKSPACE`, `SESSIONS_DIR`, service lists, allowed services) are captured in constants at process start. Production symptom: setup appears complete, but many routes keep reading the old paths until a restart. Suggested fix: either restart automatically or recompute all derived paths from `process.env` per request.
- [server.js:154-167] The unauthenticated `mobile-log` and `contact` endpoints append directly to workspace files synchronously and without rate limits or sanitization. Production symptom: easy disk spam, log forging, and request-thread blocking under abuse.
- [server.js:2776-2787, 3521-3538] Workspace file read/write only rejects `..` and absolute paths; it does not resolve symlinks. A symlink inside the workspace can escape the intended root. Suggested fix: use `realpath` and enforce the resolved path remains under `WORKSPACE`.
- [bin/cli.js:148-159] `openclaw-dashboard status` is misleading. It probes `/api/health`, which is auth-protected after setup, then prints `j.uptime`, but the real payload nests uptime under `system.uptime`. Production symptom: "Dashboard running" with `Uptime: unknown` even when the HTTP response is just `{"error":"Unauthorized"}`.
- [bin/cli.js:177-179] The `setup` command sets `FORCE_SETUP=1`, but `server.js` never reads it. The command is effectively identical to `start`.
- [public/setup.html:207-208, 460-466, server.js:3176] Password policy is both weak and inconsistent. Setup allows 4-character passwords, but the change-password API later requires 6 characters. Suggested fix: pick one strong minimum everywhere.
- [public/setup.html:478-490, 575-582] The setup page injects raw form and health-check values into `innerHTML`. A crafted path/service name can break the DOM or execute script in the browser before auth is configured. Suggested fix: render summaries with `textContent`.
- [public/live.html:177-189, public/agents-control.html:180-182] `agents-control.html` links to `/live.html?session=...`, but `live.html` never reads that query param. Production symptom: clicking "View" does not open the intended session.
- [public/files.html:329-344, public/memory.html:164-166] The memory page sends users to `/files.html?open=...`, but the files page never consumes `?open=`. Production symptom: the "Open" button does not open the selected file.
- [public/memory.html:147-169, 194-205] The page promises "semantic" search and neural concept stats, but it actually calls text grep (`/api/workspace/search`) and displays `data.concepts`, which the backend never returns. Production symptom: search quality is poor and "Concepts" always shows `0`.
- [public/alerts.html:148-152, server.js:3502-3517] The alerts page is largely a stub. The backend only stores `alerts-config.json`; there is no alert scheduler, delivery worker, log API, or recent-alert feed. Production symptom: users can save thresholds but never see any alerts fire.
- [public/logs.html:193-197] Service tabs are hard-coded to `openclaw`, `clawdbot-dashboard`, `cloudflared-dashboard`, `searxng`, and `ollama`, even though the backend allows configurable service names. Production symptom: after saving custom service names in settings, the logs page still points at the old tabs.
- [public/mail.html:749-764] The mail list renderer duplicates nearly identical HTML generation twice (`loadEmails` and `silentRefresh`) and inserts `e.date` unescaped into HTML. This is mostly maintainability debt, but it is also an avoidable DOM-injection surface.

## Low Priority (polish)
- [server.js:5] `spawn` is imported but unused.
- [server.js:3448-3484] `GET /api/live/session` does not clamp `limit`; a large query can force much bigger reads than the UI ever needs.
- [public/settings.html:1119] `showTestToast` uses `innerHTML`; the success path escapes data, but the error path passes raw `d.error`/`e.message`. Safer to build the toast with text nodes.
- [public/*] Mobile-nav logic is duplicated in almost every page (`toggleMobileNav()` with slightly different selectors). This is easy to drift and hard to fix globally.
- [public/*] Many pages rely on large inline-style HTML strings, which makes escaping mistakes and API drift much easier than componentized rendering.

## Per-Page Notes

### server.js
- [56-60] Insecure default session config: fallback secret, insecure cookies, default MemoryStore.
- [79-87] Setup APIs are fully unauthenticated before bootstrap.
- [103-110] `next` redirect is trusted without validation.
- [154-167] Public append-only log endpoints can be abused for spam and blocking I/O.
- [575-639] Cron create/edit/delete routes are missing `express.json()`, use shell interpolation, and call nonexistent `cache.delete`.
- [1291-1330] Session detail returns the oldest 100 messages, not the newest.
- [1384-1418] "Kill" hides a session; it does not terminate it.
- [1789-1803] OpenRouter key fallback is malformed and silently broken.
- [2182-2205] Provider health checks mis-detect auth failures as healthy.
- [2740-2833] Workspace listing/search are much narrower than the UI implies.
- [2890-2918] Tunnel ID and public URLs are hard-coded to one environment.
- [2928-2939] Cache stats disk commands contain malformed template literals.
- [3173-3247] Setup claims no restart is needed even though most derived paths are already frozen.
- [3254-3310] Setup install shells out with unescaped `openclawHome`.
- [3521-3538] File save writes to disk, then throws on `cache.clear()`.

### bin/cli.js
- [119-128] `--port` and `--host` are ignored by the server because `server.js` hardcodes its bind settings.
- [148-159] `status` checks an auth-protected route and reads the wrong uptime field.
- [177-179] `FORCE_SETUP` is dead code; `setup` does not actually force setup mode.

### index.html
- [1044-1052, 1378-1418] The dashboard mostly works, but several cards inherit backend misreports from `/api/health/providers` and `/api/network/status`.
- [1218-1223] Budget banners are inserted with `innerHTML`; current data is numeric, but safer rendering would reduce future XSS risk.

### agents.html
- [1217-1237] Session rows and action buttons embed raw IDs/keys inside inline `onclick` handlers; `escapeHtml()` is not sufficient for JavaScript-string contexts.
- [1335-1339, 1418-1423, 1589-1595] Cron/live controls rely on current APIs, but inline handler construction with `j.id`, `j.name`, and `s.key` is fragile and XSS-prone if any value contains quotes.
- [1376-1378, 1400-1401] Error text is written into `innerHTML` without escaping.

### agents-control.html
- [147-176] Session labels, origins, and types are written into HTML without escaping.
- [161-163] `viewLive()` and `openSteer()` use raw keys in inline handlers.
- [181-182] The `?session=` deep link points at a live page feature that does not exist.

### alerts.html
- [148-152] "Recent Alerts" is static placeholder content; the page never fetches alert history.
- [183-214] The page only saves JSON config. There is no backend job that evaluates thresholds or sends notifications.

### analytics.html
- [114-123] Expects `data.sessions`, `data.models`, and `data.daily`, but the backend returns different keys.
- [117] `textContent = data.sessions` coerces an array into `[object Object]`.
- [176-182] Reads hourly data as `data[h]` instead of `data.hourBuckets[h]`.

### channels.html
- [149-166] Expects `data.providers` array; current backend returns a keyed object, so the provider section falls into the error state.
- [169-181] Expects `data.tunnel.status` and `data.dns`, but backend returns `tunnel.active`, `arc`, and `dashboard`.

### conv-analytics.html
- [138-158] Creates charts without reusing/destroying chart instances if the function is ever called again.
- [170-183] Misreads `/api/sessions/hourly`; the heatmap and chart use the wrong shape and can produce all-zero or `NaN` output.

### crons.html
- [222-229] `switchTab()` depends on implicit global `event`, which is brittle outside legacy inline-handler behavior.
- [294-333] Cron cards render raw IDs/names into inline handlers.
- [430-449] Heartbeat read/write calls nonexistent `/api/files/read` and `/api/files/write` endpoints, so the editor cannot load or save real data.

### files.html
- [195-208, 338-340] File paths are inserted into inline `onclick` handlers without JS-string escaping.
- [302-318] Markdown preview allows unsafe `href` values such as `javascript:`.
- [329-344] Search results show only `md/json` matches because the backend search is narrower than the editor UI.
- [1-359] The page never reads `?open=...`, so deep links from `memory.html` do nothing.

### identity.html
- [680-706, 846-866] File paths are written into inline handlers with HTML escaping, not JavaScript escaping; apostrophes can break the handler.
- [756-757, 866] The page relies heavily on `innerHTML`, so any escaping regression in the markdown renderer becomes high impact.

### live.html
- [165-169] Session keys are embedded raw into inline `onclick`.
- [177-189] The page ignores the `?session=` parameter entirely.
- [193-203] Polling keeps running indefinitely once a session is selected; there is no visibility/unload cleanup.

### login.html
- [236-248] The form posts to `/login` and drops any `next` value from the original redirect URL.
- [254-258] Only the error banner is client-side; there is no client-side rate-limit UX or lockout indicator for repeated failures.

### logs.html
- [193-197] Service tabs are hard-coded and can drift from saved dashboard settings.
- [332-349] Log fetch errors are displayed, but there is no handling for 401/redirect responses beyond generic error text.

### mail.html
- [749-764] Mail list HTML is duplicated twice, increasing drift risk.
- [749, 764] `e.date` is inserted unescaped into HTML.
- [747-810] Auto-refresh never invalidates `emailCache`, so changed message contents remain stale until reload.

### memory.html
- [153-169] Search is plain text grep despite the "semantic" wording.
- [164-165, 185-187] File paths are embedded into inline handlers without JS-string escaping.
- [165] "Open" deep-links to `/files.html?open=...`, but the target page ignores it.
- [201-205] `data.concepts` is not returned by the backend, so the Concepts stat is always `0`.

### neural.html
- [1212, 1239, 1264-1269, 1532-1539] DB-derived fields are concatenated into `innerHTML` without escaping.
- [1398-1511, 1593-1600] The page rebuilds a large graph on a 30-second interval, which is expensive on weaker devices and can cause jank.

### responsive.css
- [207-249] There is an unmatched `}` at line 249.
- [189-192] Global `button` rules are very broad and can override page-specific sizing unexpectedly.

### settings.html
- [1102-1105] Model/provider rendering still trusts current backend shapes and injects values into inline handlers.
- [1119] `showTestToast()` uses `innerHTML`; the error path is not escaped.
- [1241-1288] Feature toggles are inferred from detected binaries, not persisted dashboard feature config, so the page can show features as enabled when they are merely installed.
- [1316-1338] The UI warns that restart is required, but many backend routes still use frozen startup constants and some settings (port/host) never apply even after restart.

### setup.html
- [207-208, 460-466] Weak 4-character password policy.
- [478-490] Summary panel writes raw user input into `innerHTML`.
- [543-588] Install progress never clears `healthGrid` before appending, so re-running setup duplicates status cards.
- [575-582] Health-check names/details are rendered with `innerHTML` without escaping.
