const express = require('express');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const os = require('os');
const Database = require('better-sqlite3');
const session = require('express-session');
const bcrypt = require('bcryptjs');

// ── Simple TTL cache ───────────────────────────────────────────────────────
class TTLCache {
  constructor() { this._s = {}; }
  get(k) {
    const e = this._s[k];
    if (!e) return null;
    if (Date.now() > e.exp) { delete this._s[k]; return null; }
    return e.v;
  }
  set(k, v, ttlMs) { this._s[k] = { v, exp: Date.now() + ttlMs }; return v; }
  del(k) { delete this._s[k]; }
}
const cache = new TTLCache();

// ── System metrics ring buffer (last 20 data points, sampled on each /api/health call) ──
const METRICS_HISTORY_MAX = 20;
const metricsHistory = []; // [{ts, cpuLoad, memPct}]
function pushMetricsSample(cpuLoad, memPct) {
  metricsHistory.push({ ts: Date.now(), cpuLoad: parseFloat(cpuLoad) || 0, memPct: parseFloat(memPct) || 0 });
  if (metricsHistory.length > METRICS_HISTORY_MAX) metricsHistory.shift();
}

const app = express();
const PORT = 3000;
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.resolve(os.homedir(), '.openclaw/workspace');
const NEURAL_DB_PATH = require('path').resolve(require('os').homedir(), '.neuralmemory/brains/default.db');

const AUTH_CONFIG_PATH = path.join(WORKSPACE, 'config/dashboard-auth.json');
function getAuthConfig() {
  try { return JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, 'utf8')); }
  catch { return { username: 'admin', passwordHash: '$2a$10$placeholder' }; }
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24h
}));

// Auth middleware — protect everything except /login and /api/auth/*
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  // API routes return 401 JSON
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized', redirect: '/login' });
  // Page routes redirect to login
  res.redirect('/login?next=' + encodeURIComponent(req.path));
}

// GET /login
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/');
  res.sendFile('login.html', { root: path.join(WORKSPACE, 'dashboard/public') });
});

// POST /login
app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const { username, password } = req.body || {};
  const cfg = getAuthConfig();
  if (username === cfg.username && bcrypt.compareSync(password, cfg.passwordHash)) {
    req.session.authenticated = true;
    req.session.username = username;
    const next = req.query.next || '/';
    return res.redirect(next);
  }
  res.redirect('/login?error=1');
});

// GET /logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// POST /api/auth/change-password
app.post('/api/auth/change-password', express.json(), requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const cfg = getAuthConfig();
  if (!bcrypt.compareSync(currentPassword, cfg.passwordHash)) {
    return res.json({ error: 'Current password incorrect' });
  }
  if (!newPassword || newPassword.length < 6) return res.json({ error: 'New password too short' });
  cfg.passwordHash = bcrypt.hashSync(newPassword, 10);
  fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  res.json({ ok: true });
});

// ARC website bypass — serve arc.net.pk WITHOUT auth (public site)
const ARC_SITE = path.join(WORKSPACE, 'arc-consultancy');
const ARC_HOSTS = ['arc.net.pk', 'www.arc.net.pk'];

app.use((req, res, next) => {
  const host = (req.headers.host || '').split(':')[0];
  if (ARC_HOSTS.includes(host)) {
    return express.static(ARC_SITE)(req, res, next);
  }
  next();
});
app.get('/', (req, res, next) => {
  const host = (req.headers.host || '').split(':')[0];
  if (ARC_HOSTS.includes(host)) {
    return res.sendFile(path.join(ARC_SITE, 'index.html'));
  }
  next();
});

// Mobile app remote logging (before auth)
app.post('/api/mobile-log', express.json(), (req, res) => {
  const entry = `[${new Date().toISOString()}] ${JSON.stringify(req.body)}\n`;
  fs.appendFileSync(path.join(WORKSPACE, 'tradeiators/mobile-debug.log'), entry);
  res.json({ok:true});
});

// ARC contact form (before auth — public)
app.post('/api/contact', express.json(), (req, res) => {
  const { name, email, company, service, message } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  const entry = `[${new Date().toISOString()}] NAME: ${name} | EMAIL: ${email} | COMPANY: ${company || 'N/A'} | SERVICE: ${service} | MSG: ${message}\n`;
  fs.appendFileSync(path.join(WORKSPACE, 'arc-consultancy/inquiries.log'), entry);
  console.log('[ARC Contact]', entry.trim());
  res.json({ ok: true });
});

// Apply auth to ALL subsequent routes (login/logout above are exempt, ARC above is exempt)
app.use(requireAuth);

let neuralGraphCache = {};
let neuralDb;
function getNeuralDb() {
  if (!neuralDb) {
    if (!fs.existsSync(NEURAL_DB_PATH)) {
      throw new Error(`Neural DB not found at ${NEURAL_DB_PATH}`);
    }
    neuralDb = new Database(NEURAL_DB_PATH, { readonly: true });
  }
  return neuralDb;
}

function parseJsonArray(v) {
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function neuralLastTrainedIso(db) {
  const row = db.prepare("SELECT MAX(last_activated) AS last_activated FROM neuron_states").get();
  if (!row?.last_activated) return null;
  const dt = new Date(row.last_activated);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

// Helpers
function exec(cmd, fallback = '') {
  try { return execSync(cmd, { timeout: 5000, encoding: 'utf8' }).trim(); } catch { return fallback; }
}
function readFile(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}
function fileAge(p) {
  try { return Date.now() - fs.statSync(p).mtimeMs; } catch { return null; }
}

function truncateText(v, n = 140) {
  const s = (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.substring(0, n - 1) + '…' : s;
}

function tailLinesSync(filePath, maxLines = 200, chunkSize = 64 * 1024) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return [];

    let pos = size;
    let remainder = '';
    const out = [];

    while (pos > 0 && out.length < maxLines) {
      const readSize = Math.min(chunkSize, pos);
      pos -= readSize;
      const buf = Buffer.allocUnsafe(readSize);
      fs.readSync(fd, buf, 0, readSize, pos);
      const text = buf.toString('utf8');
      const merged = text + remainder;
      const parts = merged.split('\n');
      remainder = parts.shift() || '';
      for (let i = parts.length - 1; i >= 0 && out.length < maxLines; i--) {
        const ln = parts[i].trim();
        if (ln) out.push(ln);
      }
    }

    if (remainder.trim() && out.length < maxLines) out.push(remainder.trim());
    return out.reverse();
  } finally {
    fs.closeSync(fd);
  }
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(x => {
        if (!x) return '';
        if (typeof x === 'string') return x;
        return x.text || '';
      })
      .filter(Boolean)
      .join(' ');
  }
  if (content && typeof content === 'object') return content.text || '';
  return '';
}

function firstContentPart(content) {
  if (Array.isArray(content)) return content[0] || null;
  return content || null;
}

function toolDescription(toolName, input) {
  const tool = String(toolName || '').trim();
  const t = tool.toLowerCase();
  const fp = input?.file_path || input?.path || input?.filePath || input?.old_file_path;

  if (t === 'edit') return { icon: '🔧', description: `🔧 Edited ${fp || 'file'}` };
  if (t === 'write') return { icon: '📝', description: `📝 Wrote ${fp || 'file'}` };
  if (t === 'read') return { icon: '📖', description: `📖 Read ${fp || 'file'}` };
  if (t === 'exec') return { icon: '⚡', description: `⚡ Ran: ${truncateText(input?.command || '', 60)}` };
  if (t === 'sessions_spawn') return { icon: '🚀', description: `🚀 Spawned: ${truncateText(input?.label || input?.name || input?.task || 'sub-agent', 60)}` };
  if (t === 'gateway') return { icon: '⚙️', description: `⚙️ Gateway: ${truncateText(input?.action || 'action', 40)}` };
  if (t === 'web_search') return { icon: '🔍', description: `🔍 Searched: ${truncateText(input?.query || '', 60)}` };
  if (t === 'web_fetch') return { icon: '🌐', description: `🌐 Fetched: ${truncateText(input?.url || '', 60)}` };
  if (t === 'message') return { icon: '💬', description: '💬 Sent message' };
  if (t === 'cron') return { icon: '⏰', description: `⏰ Cron: ${truncateText(input?.action || '', 40)}` };
  if (t === 'memory_search') return { icon: '🧠', description: `🧠 Memory search: ${truncateText(input?.query || '', 60)}` };
  return { icon: '🔧', description: `🔧 ${tool || 'tool'}` };
}

// API: system health
app.get('/api/health', (req, res) => {
  const hit = cache.get('health');
  if (hit) return res.json(hit);

  const uptime = os.uptime();
  const load = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  
  const diskRaw = exec("df -h / | tail -1 | awk '{print $2,$3,$4,$5}'");
  const [diskTotal, diskUsed, diskFree, diskPct] = diskRaw.split(' ');
  
  const cpuCount = os.cpus().length;
  const cpuModel = os.cpus()[0]?.model || 'Unknown';
  
  // OpenClaw process
  const oclawPid = exec("pgrep -f 'openclaw.*gateway' | head -1");
  const oclawVersion = exec("openclaw --version 2>/dev/null");
  const oclawUptime = oclawPid ? exec(`ps -p ${oclawPid} -o etimes= 2>/dev/null`) : null;
  
  // Docker
  const dockerContainers = exec("docker ps --format '{{.Names}}:{{.Status}}' 2>/dev/null");
  
  const memPct = ((usedMem/totalMem)*100).toFixed(1);
  const data = {
    system: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      uptime,
      cpu: { model: cpuModel, count: cpuCount, load },
      memory: { total: totalMem, used: usedMem, free: freeMem, pct: memPct },
      disk: { total: diskTotal, used: diskUsed, free: diskFree, pct: diskPct }
    },
    openclaw: {
      version: oclawVersion,
      pid: oclawPid,
      uptime: oclawUptime ? parseInt(oclawUptime) : null
    },
    docker: dockerContainers ? dockerContainers.split('\n').map(c => {
      const [name, ...status] = c.split(':');
      return { name, status: status.join(':') };
    }) : []
  };
  // Record sample in metrics history ring buffer
  pushMetricsSample(load[0], memPct);
  cache.set('health', data, 20000); // cache 20s
  res.json(data);
});

// API: system metrics history (ring buffer — last 20 data points)
app.get('/api/metrics/history', (req, res) => {
  res.json({ history: metricsHistory, maxPoints: METRICS_HISTORY_MAX });
});

// API: identity & soul
app.get('/api/identity', (req, res) => {
  const soul = readFile(path.join(WORKSPACE, 'SOUL.md'));
  const identity = readFile(path.join(WORKSPACE, 'IDENTITY.md'));
  const memory = readFile(path.join(WORKSPACE, 'MEMORY.md'));
  
  // Extract key sections from MEMORY.md
  const lines = memory.split('\n');
  const sections = {};
  let currentSection = '';
  for (const line of lines) {
    if (line.startsWith('## ')) {
      currentSection = line.replace('## ', '').trim();
      sections[currentSection] = [];
    } else if (currentSection && line.trim()) {
      sections[currentSection].push(line);
    }
  }
  
  res.json({ soul, identity, memorySections: Object.keys(sections) });
});

// API: recent activity - pulls from multiple live sources
app.get('/api/activity', (req, res) => {
  const hit = cache.get('activity');
  if (hit) return res.json(hit);
  const memDir = path.join(WORKSPACE, 'memory');
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  
  // Memory logs (manual notes)
  const todayLog = readFile(path.join(memDir, `${today}.md`));
  const yesterdayLog = readFile(path.join(memDir, `${yesterday}.md`));
  
  // Live: recent sessions (last 24h)
  const sessDir = path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions');
  const recentSessions = [];
  try {
    // Load sessions index for labels
    const sessIndex = {};
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(sessDir, 'sessions.json'), 'utf8'));
      for (const [key, val] of Object.entries(idx)) {
        if (val.sessionId) sessIndex[val.sessionId] = { key, label: val.label || '', modelOverride: val.modelOverride || '' };
      }
    } catch(e) { console.error('[activity] index error:', e.message); }

    const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(sessDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 30)
      .map(f => f.name);
    for (const f of files) {
      const fullPath = path.join(sessDir, f);
      const stat = fs.statSync(fullPath);
      if (Date.now() - stat.mtimeMs > 86400000 * 2) continue;
      const lines = fs.readFileSync(fullPath, 'utf8').trim().split('\n');
      let task = '', model = '', kind = 'session';
      const id = f.replace('.jsonl', '');
      let startTime = null;
      
      // Get label from sessions index
      const indexEntry = sessIndex[id];
      if (indexEntry) {
        task = indexEntry.label || '';
        const k = indexEntry.key || '';
        if (k.includes(':cron:')) kind = 'cron';
        else if (k.includes(':subagent:')) kind = 'subagent';
        else if (k === 'agent:main:main' || k === 'agent:voice:main') kind = 'main';
        else if (k.includes(':whatsapp:')) { kind = 'session'; if (!task) task = 'WhatsApp Chat'; }
      }

      for (let i = 0; i < Math.min(lines.length, 10); i++) {
        try {
          const d = JSON.parse(lines[i]);
          if (d.timestamp && !startTime) startTime = d.timestamp;
          if (d.type === 'model_change' && d.modelId) model = d.modelId;
          if (!task && d.type === 'message' && d.message && d.message.role === 'user') {
            const c = d.message.content;
            if (Array.isArray(c) && c[0] && c[0].text) task = c[0].text.substring(0, 150);
            else if (typeof c === 'string') task = c.substring(0, 150);
          }
        } catch {}
      }
      
      recentSessions.push({ id: id.substring(0, 12), kind, task, model, time: startTime || stat.mtime.toISOString(), messages: lines.length });
    }
    recentSessions.sort((a, b) => new Date(b.time) - new Date(a.time));
  } catch {}
  
  // Live: systemd service statuses
  const services = {};
  for (const svc of ['clawdbot-dashboard', 'cloudflared-dashboard', 'searxng', 'ollama']) {
    const status = exec(`systemctl is-active ${svc} 2>/dev/null`, 'unknown');
    const since = exec(`systemctl show ${svc} --property=ActiveEnterTimestamp --value 2>/dev/null`);
    services[svc] = { status, since };
  }
  
  // Live: recent git commits in workspace
  const gitLog = exec(`cd ${WORKSPACE} && git log --oneline --since="2 days ago" -10 2>/dev/null`);
  
  // Live: OpenClaw journal (last 20 entries today)
  const journal = exec(`journalctl -u openclaw --since today --no-pager -q --output=short-iso 2>/dev/null | tail -15`);
  
  // Truncate logs — only last 40 lines each (dashboard cards don't need full logs)
  const truncate = (text, lines = 40) => text.split('\n').slice(-lines).join('\n');
  const result = {
    today: { date: today, log: truncate(todayLog) },
    yesterday: { date: yesterday, log: truncate(yesterdayLog, 20) },
    recentSessions: recentSessions.slice(0, 15),
    services,
    gitLog: gitLog || null,
    journal: journal || null
  };
  cache.set('activity', result, 15000); // cache 15s
  res.json(result);
});

// API: activity feed from main session actions
app.get('/api/activity/feed', (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || '50', 10) || 50, 300));
  const cacheKey = `activity_feed_${limit}`;
  const hit = cache.get(cacheKey);
  if (hit) return res.json(hit);

  const sessDir = path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions');
  const tailCount = Math.max(limit * 2, 200);

  try {
    const sessionsIndexPath = path.join(sessDir, 'sessions.json');
    const sessionsIndex = JSON.parse(fs.readFileSync(sessionsIndexPath, 'utf8'));
    const mainMeta = sessionsIndex['agent:voice:main'] || sessionsIndex['agent:main:main'];
    const sessionId = mainMeta && mainMeta.sessionId;
    if (!sessionId) return res.json({ items: [] });

    const transcriptPath = path.join(sessDir, sessionId + '.jsonl');
    if (!fs.existsSync(transcriptPath)) return res.json({ items: [] });

    const tail = tailLinesSync(transcriptPath, tailCount);
    const items = [];

    for (const line of tail) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== 'message' || !entry.message) continue;

      const msg = entry.message;
      const ts = msg.timestamp || entry.timestamp || new Date().toISOString();

      if (msg.role === 'assistant') {
        const part = firstContentPart(msg.content);
        const partType = part ? (part.type || '').toLowerCase() : '';

        if (part && (partType === 'tool_use' || partType === 'tooluse' || partType === 'toolcall')) {
          const toolName = part.name || part.toolName || msg.toolName || 'tool';
          const input = part.input || part.arguments || {};
          const mapped = toolDescription(toolName, input);
          items.push({
            timestamp: ts,
            icon: mapped.icon,
            description: mapped.description,
            type: 'tool',
            detail: truncateText(JSON.stringify(input), 220)
          });
          continue;
        }

        const assistantText = truncateText(extractMessageText(msg.content), 180);
        if (assistantText) {
          items.push({
            timestamp: ts,
            icon: '🤖',
            description: `🤖 ${assistantText}`,
            type: 'assistant'
          });
        }
        continue;
      }

      if (msg.role === 'toolResult') {
        const resultText = truncateText(extractMessageText(msg.content) || msg.details?.error || msg.details?.status || 'Tool result', 160);
        items.push({
          timestamp: ts,
          icon: msg.isError ? '❌' : '✅',
          description: (msg.isError ? '❌ Tool error: ' : '✅ Tool result: ') + resultText,
          type: 'tool',
          detail: msg.toolName || undefined
        });
        continue;
      }

      if (msg.role === 'user') {
        const userText = truncateText(extractMessageText(msg.content), 180);
        if (userText) {
          items.push({
            timestamp: ts,
            icon: '👤',
            description: `👤 ${userText}`,
            type: 'user'
          });
        }
      }
    }

    items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const result = { items: items.slice(0, limit) };
    cache.set(cacheKey, result, 10000); // cache 10s — main session JSONL is expensive to re-read
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message, items: [] });
  }
});

// API: cron jobs
app.get('/api/crons', (req, res) => {
  const hit = cache.get('crons_simple');
  if (hit) return res.json(hit);
  const cronData = exec("openclaw cron list --json 2>/dev/null");
  let jobs = [];
  try { jobs = JSON.parse(cronData)?.jobs || []; } catch {}
  const result = { jobs };
  cache.set('crons_simple', result, 30000); // cache 30s
  res.json(result);
});

// API: stats/today — compact session activity summary for dashboard card
// Reuses orch_sessions cache if warm (no extra disk I/O); falls back to fast file-stat scan
app.get('/api/stats/today', (req, res) => {
  const hit = cache.get('stats_today');
  if (hit) return res.json(hit);

  try {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const sevenDaysMs = 7 * oneDayMs;

    // Prefer orch_sessions cache (rich data, already computed)
    const orchCache = cache.get('orch_sessions');
    if (orchCache && orchCache.sessions) {
      const sessions = orchCache.sessions;
      const todaySess = sessions.filter(s => s.startTime && (now - new Date(s.startTime).getTime()) < oneDayMs);
      const result = {
        sessionsToday: todaySess.length,
        sessionsWeek: sessions.length,
        tokensInToday: todaySess.reduce((a, s) => a + (s.tokenIn || 0), 0),
        tokensOutToday: todaySess.reduce((a, s) => a + (s.tokenOut || 0), 0),
        errorsToday: todaySess.filter(s => s.hasError).length,
        activeSessions: sessions.filter(s => s.status === 'active').length,
        toolCallsToday: todaySess.reduce((a, s) => a + (s.toolCalls || 0), 0),
        rich: true
      };
      cache.set('stats_today', result, 15000);
      return res.json(result);
    }

    // Light fallback: count session files by mtime only (no file reads)
    const sessDir = path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions');
    let todayCount = 0, weekCount = 0;
    try {
      const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl') && !f.includes('.deleted.'));
      for (const f of files) {
        try {
          const ageMs = now - fs.statSync(path.join(sessDir, f)).mtimeMs;
          if (ageMs < sevenDaysMs) weekCount++;
          if (ageMs < oneDayMs) todayCount++;
        } catch {}
      }
    } catch {}

    // Don't cache non-rich result — let next request try for rich data
    res.json({
      sessionsToday: todayCount, sessionsWeek: weekCount,
      tokensInToday: null, tokensOutToday: null,
      errorsToday: null, activeSessions: null, toolCallsToday: null,
      rich: false
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: tools status (cached 2 min — docker info is slow)
app.get('/api/tools', (req, res) => {
  const hit = cache.get('tools_status');
  if (hit) return res.json(hit);
  const tools = [
    { name: 'Email (Himalaya)', check: () => exec("himalaya --version 2>/dev/null") ? 'ok' : 'error' },
    { name: 'GitHub CLI', check: () => exec("gh auth status 2>&1").includes('Logged in') ? 'ok' : 'error' },
    { name: 'Playwright', check: () => fs.existsSync(require('path').resolve(require('os').homedir(), '.cache/ms-playwright')) ? 'ok' : 'missing' },
    { name: 'Python3', check: () => exec("python3 --version 2>/dev/null") ? 'ok' : 'error' },
    { name: 'pymssql', check: () => exec("python3 -c 'import pymssql; print(\"ok\")' 2>/dev/null") || 'error' },
    { name: 'Docker', check: () => exec("docker ps 2>/dev/null") ? 'ok' : 'error' },
    { name: 'Nextcloud', check: () => 'configured' },
    { name: 'SQL Server (VIS)', check: () => 'configured' },
  ];
  
  const result = { tools: tools.map(t => ({ name: t.name, status: t.check() })) };
  cache.set('tools_status', result, 120000); // cache 2 min
  res.json(result);
});

// API: workspace files overview
app.get('/api/workspace', (req, res) => {
  const files = exec(`find ${WORKSPACE} -maxdepth 2 -type f -name '*.md' -o -name '*.json' -o -name '*.js' -o -name '*.sh' | grep -v node_modules | sort`);
  res.json({ files: files.split('\n').filter(Boolean) });
});

// API: VIS database stats (cached 5 min — live SQL connection is slow)
app.get('/api/vis', (req, res) => {
  const hit = cache.get('vis_stats');
  if (hit) return res.json(hit);
  const script = `
import pymssql, json, os
try:
    conn = pymssql.connect(server=os.environ.get('VIS_DB_HOST',''), port=int(os.environ.get('VIS_DB_PORT','1433')), user=os.environ.get('VIS_DB_USER',''), password=os.environ.get('VIS_DB_PASS',''), database=os.environ.get('VIS_DB_NAME',''))
    c = conn.cursor()
    c.execute('SELECT COUNT(*) FROM mont_RatingContract WHERE Active=1')
    active = c.fetchone()[0]
    c.execute('SELECT COUNT(*) FROM mont_RatingContract')
    total = c.fetchone()[0]
    c.execute('SELECT COUNT(*) FROM VU_Current_Contract')
    current = c.fetchone()[0]
    c.execute('SELECT COUNT(*) FROM Company WHERE Comp_Rec_Status=1')
    companies = c.fetchone()[0]
    conn.close()
    print(json.dumps({"active": active, "total": total, "current": current, "companies": companies, "status": "ok"}))
except Exception as e:
    print(json.dumps({"status": "error", "error": str(e)}))
`;
  const result = exec(`python3 -c '${script.replace(/'/g, "'\"'\"'")}'`, '{"status":"error"}');
  try {
    const data = JSON.parse(result);
    if (data.status === 'ok') cache.set('vis_stats', data, 300000); // cache 5 min on success
    res.json(data);
  } catch { res.json({ status: 'error' }); }
});

// API: mail list
app.get('/api/mail/list', (req, res) => {
  const folder = req.query.folder || 'INBOX';
  // Strict allowlist — only permit known safe folder names
  const folderMap = { 'INBOX': 'INBOX', 'Sent': '[Gmail]/Sent Mail' };
  if (!folderMap[folder]) return res.status(400).json({ error: 'Invalid folder', emails: [] });
  const cacheKey = `mail_list_${folder}`;
  const hit = cache.get(cacheKey);
  if (hit) return res.json(hit);

  const f = folderMap[folder];
  
  const raw = exec(`himalaya envelope list -f "${f}" -w 200 2>/dev/null | tail -n +3 | head -50`);
  if (!raw) return res.json({ emails: [] });
  
  const emails = raw.split('\n')
    .filter(l => l.includes('|') && !l.match(/^[\s|:-]+$/))
    .map(line => {
      // Split by | but keep empty parts (don't filter empty)
      const parts = line.split('|').slice(1, -1).map(p => p.trim());
      if (parts.length >= 5 && parseInt(parts[0])) {
        return {
          id: parseInt(parts[0]),
          flags: parts[1],
          subject: parts[2],
          from: parts[3],
          date: parts[4]
        };
      }
      return null;
    }).filter(Boolean);
  
  // For sent mail, swap from/to display
  if (folder === 'Sent') {
    emails.forEach(e => { e.to = e.from; e.from = 'Me'; });
  }
  
  const result = { emails: emails.reverse() };
  cache.set(cacheKey, result, 20000); // cache 20s — avoid hammering IMAP on auto-refresh
  res.json(result);
});

// API: mail read
app.get('/api/mail/read', (req, res) => {
  const folder = req.query.folder || 'INBOX';
  const id = req.query.id;
  if (!id) return res.json({ error: 'No ID' });
  // Sanitize: mail IDs must be numeric only
  if (!/^\d+$/.test(String(id))) return res.status(400).json({ error: 'Invalid ID' });
  
  const folderMap = { 'INBOX': 'INBOX', 'Sent': '[Gmail]/Sent Mail' };
  if (!folderMap[folder]) return res.status(400).json({ error: 'Invalid folder' });
  const f = folderMap[folder];
  
  const raw = exec(`himalaya message read -f "${f}" ${id} 2>/dev/null`, '(unable to read)');
  
  // Parse headers from the output
  const lines = raw.split('\n');
  let from = '', to = '', subject = '', date = '', bodyStart = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('From:')) from = line.replace('From:', '').trim();
    else if (line.startsWith('To:')) to = line.replace('To:', '').trim();
    else if (line.startsWith('Subject:')) subject = line.replace('Subject:', '').trim();
    else if (line.startsWith('Date:')) date = line.replace('Date:', '').trim();
    else if (line === '' && (from || subject)) { bodyStart = i + 1; break; }
  }
  
  // If no headers found, body is everything
  const body = bodyStart > 0 ? lines.slice(bodyStart).join('\n').trim() : raw.trim();
  
  res.json({ from, to, subject, date, body });
});

// API: mail stats — inbox count, today received, sent count, top senders
app.get('/api/mail/stats', (req, res) => {
  const hit = cache.get('mail_stats');
  if (hit) return res.json(hit);

  const folderMap = { 'INBOX': 'INBOX', 'Sent': '[Gmail]/Sent Mail' };

  function parseEnvelopes(folder) {
    const f = folderMap[folder];
    const raw = exec(`himalaya envelope list -f "${f}" -w 200 2>/dev/null | tail -n +3 | head -50`);
    if (!raw) return [];
    return raw.split('\n')
      .filter(l => l.includes('|') && !l.match(/^[\s|:-]+$/))
      .map(line => {
        const parts = line.split('|').slice(1, -1).map(p => p.trim());
        if (parts.length >= 5 && parseInt(parts[0])) {
          return { id: parseInt(parts[0]), subject: parts[2], from: parts[3], date: parts[4] };
        }
        return null;
      }).filter(Boolean);
  }

  const inbox = parseEnvelopes('INBOX');
  const sent  = parseEnvelopes('Sent');

  // Detect "today" emails: match against multiple date formats himalaya might use
  const now = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const todayPatterns = [
    `${now.getDate()} ${months[now.getMonth()]}`,   // "3 Mar"
    `${months[now.getMonth()]} ${now.getDate()}`,    // "Mar 3"
    now.toISOString().slice(0, 10),                  // "2026-03-03"
    'Today',
  ];
  const todayCount = inbox.filter(e => todayPatterns.some(p => (e.date || '').includes(p))).length;

  // Top 5 senders
  const senderMap = {};
  inbox.forEach(e => {
    // Strip angle-bracket address; keep display name only
    const raw = (e.from || 'Unknown');
    const name = raw.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || raw;
    senderMap[name] = (senderMap[name] || 0) + 1;
  });
  const topSenders = Object.entries(senderMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  const result = {
    inboxCount: inbox.length,
    sentCount:  sent.length,
    todayCount,
    topSenders,
    generatedAt: new Date().toISOString()
  };
  cache.set('mail_stats', result, 60000); // 60s TTL
  res.json(result);
});

// Function to extract error info from session
function extractSessionError(lines) {
  let hasError = false;
  let lastError = null;
  let status = 'completed';
  
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const line = JSON.parse(lines[i]);
      
      // Check for tool errors
      if (line.type === 'message' && line.message && line.message.role === 'toolResult') {
        const details = line.details || {};
        const msgIsError = line.message.isError || line.message.is_error;
        if (details.status === 'error' || details.isError || msgIsError) {
          hasError = true;
          lastError = details.error || line.message.error || 'Tool execution failed';
          status = 'failed';
          break;
        }
      }
      
      // Check for direct error messages
      if (line.error || (line.status && line.status === 'error')) {
        hasError = true;
        lastError = line.error || line.message || 'Unknown error';
        status = 'failed';
        break;
      }
      
      // Check for aborted sessions
      if (line.type === 'aborted' || (line.message && line.message.includes && line.message.includes('aborted'))) {
        hasError = true;
        lastError = 'Session was aborted';
        status = 'aborted';
        break;
      }
    } catch {}
  }
  
  return { hasError, lastError, status };
}

// API: orchestration - sessions (active + history)
app.get('/api/orchestration/sessions', (req, res) => {
  const hit = cache.get('orch_sessions');
  if (hit) return res.json(hit);
  const sessDir = path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions');
  try {
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const scanTime = Date.now();
    // Only process sessions modified in the last 30 days to avoid reading stale files
    const files = fs.readdirSync(sessDir)
      .filter(f => f.endsWith('.jsonl'))
      .filter(f => {
        try { return scanTime - fs.statSync(path.join(sessDir, f)).mtimeMs < thirtyDaysMs; } catch { return false; }
      })
      .sort();
    const sessions = files.map(f => {
      const id = f.replace('.jsonl', '');
      const fullPath = path.join(sessDir, f);
      const rawContent = fs.readFileSync(fullPath, 'utf8').trim();
      // Skip empty files — they produce ghost entries with all-null values
      if (!rawContent) return null;
      const lines = rawContent.split('\n');
      
      let firstLine = {}, lastLine = {}, model = '', task = '', kind = 'unknown';
      let tokenIn = 0, tokenOut = 0, toolCalls = 0;
      
      try { firstLine = JSON.parse(lines[0]); } catch {}
      try { lastLine = JSON.parse(lines[lines.length - 1]); } catch {}
      
      // Extract error info
      const errorInfo = extractSessionError(lines);
      
      // Single-pass: extract model, task, tokens, tool calls from all lines
      for (let i = 0; i < lines.length; i++) {
        try {
          const l = JSON.parse(lines[i]);

          // Model from model_change event (first occurrence wins)
          if (l.type === 'model_change' && l.modelId && !model) model = l.modelId;

          // Task from first user message
          if (!task && l.type === 'message' && l.message && l.message.role === 'user') {
            const content = l.message.content;
            if (Array.isArray(content)) {
              task = content.filter(c => c && c.type === 'text').map(c => c.text).join(' ');
            } else if (typeof content === 'string') {
              task = content;
            }
            task = (task || '').substring(0, 200);
          }

          // Token extraction: OpenClaw stores usage in message.usage
          // input = new tokens; cacheRead = cached context hits; output = generated
          if (l.type === 'message' && l.message && l.message.usage) {
            const u = l.message.usage;
            tokenIn  += (u.input || 0) + (u.cacheRead || 0); // total context processed
            tokenOut += u.output || 0;
          }

          // Tool call counting: assistant messages with tool_use/toolCall content blocks
          if (l.type === 'message' && l.message && l.message.role === 'assistant') {
            const content = l.message.content;
            if (Array.isArray(content)) toolCalls += content.filter(c => c && (c.type === 'tool_use' || c.type === 'toolCall' || c.type === 'tool_calls')).length;
          }
        } catch {}
      }
      
      // Determine kind (will be refined from sessions.json key in enrichment step below)
      if (id.includes('cron') || f.includes('cron')) kind = 'cron';
      else if (id.includes('subagent')) kind = 'subagent';
      else kind = (firstLine.type === 'session' || firstLine.type === 'init') && firstLine.cwd ? 'main' : 'session';
      
      const startTime = firstLine.timestamp || null;
      const endTime = lastLine.timestamp || null;
      const duration = startTime && endTime ? new Date(endTime) - new Date(startTime) : null;
      
      return {
        id,
        kind,
        model: model || 'unknown',
        task: task.substring(0, 200) || '(no task description)',
        startTime,
        endTime,
        durationMs: duration,
        messageCount: lines.length,
        tokenIn,
        tokenOut,
        toolCalls,
        status: errorInfo.status,
        hasError: errorInfo.hasError,
        lastError: errorInfo.lastError,
        cost: calculateSessionCost(fullPath).cost
      };
    }).filter(Boolean); // remove nulls from empty session files
    
    // Enrich with session keys, labels, models from sessions.json
    const sessStorePath = path.join(sessDir, 'sessions.json');
    let sessIdx = {};
    try { sessIdx = JSON.parse(fs.readFileSync(sessStorePath, 'utf8')); } catch {}
    const idToEntry = {};
    for (const [k, v] of Object.entries(sessIdx)) {
      if (v && v.sessionId) idToEntry[v.sessionId] = { key: k, label: v.label || '', modelOverride: v.modelOverride || '' };
    }
    // Build set of currently active session IDs from sessions.json
    const activeSessionIds = new Set();
    for (const [k, v] of Object.entries(sessIdx)) {
      if (v && v.sessionId && v.status !== 'ended' && v.status !== 'completed') {
        activeSessionIds.add(v.sessionId);
      }
    }
    // Also mark sessions whose file was modified in the last 2 minutes as active
    const nowMs = Date.now();
    for (const s of sessions) {
      try {
        const fp = path.join(sessDir, s.id + '.jsonl');
        const mtime = fs.statSync(fp).mtimeMs;
        if (nowMs - mtime < 120000) activeSessionIds.add(s.id);
      } catch {}
    }

    for (const s of sessions) {
      const entry = idToEntry[s.id];
      s.sessionKey = entry ? entry.key : null;
      if (entry) {
        if (entry.label) s.task = entry.label;
        if (entry.modelOverride && (s.model === 'unknown' || !s.model)) s.model = entry.modelOverride;
        const k = entry.key;
        if (k.includes(':cron:')) s.kind = 'cron';
        else if (k.includes(':subagent:')) s.kind = 'subagent';
        else if (k === 'agent:main:main' || k === 'agent:voice:main') s.kind = 'main';
        else if (k.includes(':whatsapp:')) { s.kind = 'session'; if (!s.task || s.task === '(no task description)') s.task = 'WhatsApp Chat'; }
      }
      // Mark as active if file recently modified
      if (activeSessionIds.has(s.id) && s.status !== 'failed' && s.status !== 'aborted') {
        s.status = 'active';
      }
    }
    
    const result = { sessions: sessions.reverse() };
    cache.set('orch_sessions', result, 15000);
    res.json(result);
  } catch (e) {
    res.json({ sessions: [], error: e.message });
  }
});

// API: orchestration - session dependency tree
app.get('/api/orchestration/tree', (req, res) => {
  const hit = cache.get('orch_tree');
  if (hit) return res.json(hit);
  const sessDir = path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions');
  try {
    const sessStorePath = path.join(sessDir, 'sessions.json');
    const sessIdx = JSON.parse(fs.readFileSync(sessStorePath, 'utf8'));
    
    // Build lookup: sessionKey -> session info
    const nodes = {};
    for (const [key, val] of Object.entries(sessIdx)) {
      const sessionId = val.sessionId || '';
      const filePath = path.join(sessDir, sessionId + '.jsonl');
      let model = val.model || '', label = val.label || '', status = 'unknown', cost = 0;
      let startTime = null, endTime = null;
      
      // Read first/last lines for status info
      try {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        const lines = content.split('\n');
        try { const first = JSON.parse(lines[0]); startTime = first.timestamp || null; } catch {}
        try { const last = JSON.parse(lines[lines.length - 1]); endTime = last.timestamp || null; } catch {}
        
        // Check for errors/completion
        let hasError = false;
        for (let i = Math.max(0, lines.length - 5); i < lines.length; i++) {
          try {
            const l = JSON.parse(lines[i]);
            if (l.type === 'summary' || l.type === 'result') { if (l.model) model = l.model; }
            if (l.level === 'error' || l.type === 'error') hasError = true;
          } catch {}
        }
        
        // Determine status
        const age = Date.now() - new Date(endTime || 0).getTime();
        if (hasError) status = 'failed';
        else if (age < 120000) status = 'active';
        else status = 'completed';
      } catch { status = 'unknown'; }
      
      try { cost = calculateSessionCost(filePath).cost; } catch {}
      
      nodes[key] = { key, sessionId, label, model, status, cost, startTime, endTime };
    }
    
    // Build tree: find main sessions and attach children
    const trees = [];
    const mainKeys = Object.keys(nodes).filter(k => k === 'agent:main:main' || k === 'agent:voice:main' || (k.startsWith('agent:main:') || k.startsWith('agent:voice:') && !k.includes('subagent:') && !k.includes('cron:')));
    const subagentKeys = Object.keys(nodes).filter(k => k.includes(':subagent:'));
    const cronKeys = Object.keys(nodes).filter(k => k.includes(':cron:') && !k.includes(':run:'));
    
    for (const mk of mainKeys) {
      const mainNode = { ...nodes[mk], children: [] };
      if (mk === 'agent:main:main' || mk === 'agent:voice:main') {
        // Attach subagents to main session only
        for (const sk of subagentKeys) {
          mainNode.children.push({ ...nodes[sk], children: [] });
        }
        // Attach cron parents (with their runs as children)
        for (const ck of cronKeys) {
          const cronNode = { ...nodes[ck], children: [] };
          const runKeys = Object.keys(nodes).filter(k => k.startsWith(ck + ':run:'));
          for (const rk of runKeys) {
            cronNode.children.push({ ...nodes[rk], children: [] });
          }
          mainNode.children.push(cronNode);
        }
      }
      // Sort children by startTime desc
      mainNode.children.sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0));
      trees.push(mainNode);
    }
    
    const treeResult = { trees };
    cache.set('orch_tree', treeResult, 30000); // cache 30s — was missing, caused full recompute every call
    res.json(treeResult);
  } catch (e) {
    res.json({ trees: [], error: e.message });
  }
});

// API: orchestration - cron jobs with run history
app.get('/api/orchestration/crons', (req, res) => {
  const hit = cache.get('orch_crons');
  if (hit) return res.json(hit);
  const cronData = exec("openclaw cron list --json 2>/dev/null");
  let jobs = [];
  try { jobs = JSON.parse(cronData)?.jobs || []; } catch {}
  
  // Get run history from cron run JSONL files
  const cronRunsDir = '' + (process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw')) + '/cron/runs';
  const cronRuns = [];
  try {
    const files = fs.readdirSync(cronRunsDir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const jobId = f.replace('.jsonl', '');
      const fullPath = path.join(cronRunsDir, f);
      const lines = fs.readFileSync(fullPath, 'utf8').trim().split('\n');
      // Parse all run entries for this job
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          if (d.action === 'finished') {
            cronRuns.push({
              jobId: d.jobId || jobId,
              sessionId: d.sessionId,
              status: d.status || 'unknown',
              summary: d.summary || '',
              durationMs: d.durationMs || 0,
              timestamp: d.ts ? new Date(d.ts).toISOString() : null,
              error: d.status === 'error' ? (d.error || d.summary || 'Unknown error') : null
            });
          }
        } catch {}
      }
    }
  } catch {}
  
  // Attach last error to each job
  for (const job of jobs) {
    const jobRuns = cronRuns.filter(r => r.jobId === job.id).sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    const lastRun = jobRuns[0];
    if (lastRun) {
      job.lastRunSummary = lastRun.summary;
      job.lastRunError = lastRun.error;
      job.lastRunDurationMs = lastRun.durationMs;
    }
    // Find last error across all runs
    const lastError = jobRuns.find(r => r.status === 'error');
    if (lastError) {
      job.lastErrorMessage = lastError.error;
      job.lastErrorTime = lastError.timestamp;
    }
    // Last 5 runs for history dots
    job.recentRuns = jobRuns.slice(0, 5).map(r => ({
      status: r.status === 'error' ? 'error' : 'ok',
      timestamp: r.timestamp,
      durationMs: r.durationMs
    }));
  }
  
  const cronsResult = { jobs, cronRuns };
  cache.set('orch_crons', cronsResult, 20000); // 20s
  res.json(cronsResult);
});

// API: orchestration - session error details
app.get('/api/orchestration/session/:id/error', (req, res) => {
  // Validate: session IDs are UUIDs or alphanumeric (no path traversal)
  if (!/^[a-zA-Z0-9_-]{4,80}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
  const sessFile = path.join(path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions'), req.params.id + '.jsonl');
  if (!fs.existsSync(sessFile)) return res.json({ error: 'Session not found' });
  
  const lines = fs.readFileSync(sessFile, 'utf8').trim().split('\n');
  const errors = [];
  
  for (let i = 0; i < lines.length; i++) {
    try {
      const d = JSON.parse(lines[i]);
      
      // Tool errors
      if (d.type === 'message' && d.message && d.message.role === 'toolResult') {
        if (d.message.isError || (d.details && d.details.isError)) {
          const content = d.message.content;
          let errorText = '';
          if (Array.isArray(content)) {
            errorText = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          } else if (typeof content === 'string') {
            errorText = content;
          }
          errors.push({
            type: 'tool_error',
            tool: d.message.toolName || d.details?.toolName || 'unknown',
            message: errorText.substring(0, 500),
            timestamp: d.timestamp || d.ts
          });
        }
      }
      
      // Direct errors
      if (d.error || d.status === 'error') {
        errors.push({
          type: 'session_error',
          message: (d.error || d.message || 'Unknown error').substring(0, 500),
          timestamp: d.timestamp || d.ts
        });
      }
      
      // Aborted
      if (d.type === 'aborted') {
        errors.push({
          type: 'aborted',
          message: 'Session was aborted',
          timestamp: d.timestamp || d.ts
        });
      }
    } catch {}
  }
  
  const errorInfo = extractSessionError(lines);
  res.json({
    id: req.params.id,
    hasError: errorInfo.hasError,
    status: errorInfo.status,
    lastError: errorInfo.lastError,
    errors
  });
});

// API: orchestration - session detail (transcript summary)
app.get('/api/orchestration/session/:id', (req, res) => {
  if (!/^[a-zA-Z0-9_-]{4,80}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid session ID' });
  const sessFile = path.join(path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions'), req.params.id + '.jsonl');
  if (!fs.existsSync(sessFile)) return res.json({ error: 'Session not found' });
  
  const lines = fs.readFileSync(sessFile, 'utf8').trim().split('\n');
  const messages = [];
  
  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      
      // Format: type=message with nested message object
      if (d.type === 'message' && d.message) {
        let msg = d.message;
        if (typeof msg === 'string') { try { msg = JSON.parse(msg.replace(/'/g, '"')); } catch { msg = { role: 'unknown', content: d.message }; } }
        
        const role = msg.role || 'unknown';
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          if (!text) text = msg.content.filter(c => c.type === 'tool_use').map(c => '🔧 ' + c.name).join(', ');
        }
        if (text) messages.push({ role, text: text.substring(0, 500), timestamp: d.timestamp });
      }
      // Format: type=tool_result
      else if (d.type === 'tool_result') {
        messages.push({ role: 'tool', text: (d.name || 'tool') + ': ' + (d.output || d.result || '').toString().substring(0, 300), timestamp: d.timestamp });
      }
      // Direct role-based format
      else if (d.role === 'user' || d.role === 'assistant') {
        const text = d.message || d.text || d.content || '';
        if (typeof text === 'string' && text) messages.push({ role: d.role, text: text.substring(0, 500), timestamp: d.timestamp });
      }
    } catch {}
  }
  
  res.json({ id: req.params.id, messageCount: lines.length, messages: messages.slice(0, 100) });
});

// API: orchestration - toggle cron job enabled/disabled
app.post('/api/orchestration/cron/toggle', express.json(), (req, res) => {
  const { jobId, enabled } = req.body;
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
  
  try {
    const command = enabled ? 'enable' : 'disable';
    const result = exec(`openclaw cron ${command} "${jobId}" 2>&1`);
    
    // Get updated job state
    const cronData = exec(`openclaw cron list --json 2>/dev/null`);
    let jobs = [];
    try { jobs = JSON.parse(cronData)?.jobs || []; } catch {}
    const updatedJob = jobs.find(j => j.id === jobId);
    
    // Invalidate cron caches so next load shows updated state
    cache.del('orch_crons');
    cache.del('crons_simple');
    res.json({ 
      ok: true, 
      message: `Job ${command}d successfully`,
      job: updatedJob,
      result: result
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: orchestration - run cron job now
app.post('/api/orchestration/cron/run', express.json(), (req, res) => {
  const { jobId } = req.body;
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });
  
  try {
    const result = exec(`openclaw cron run "${jobId}" 2>&1`);
    
    // Invalidate cron caches so dashboard reflects the triggered run
    cache.del('orch_crons');
    cache.del('crons_simple');
    res.json({ 
      ok: true, 
      message: 'Job executed successfully',
      result: result
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: orchestration - kill a sub-agent session
app.post('/api/orchestration/kill', express.json(), (req, res) => {
  const { sessionKey } = req.body;
  if (!sessionKey) return res.status(400).json({ error: 'Missing sessionKey' });
  
  // Safety: never allow killing main session
  if (sessionKey === 'agent:main:main' || sessionKey === 'agent:voice:main' || sessionKey.endsWith(':main') && !sessionKey.includes(':subagent:') && !sessionKey.includes(':cron:')) {
    return res.status(403).json({ error: 'Cannot kill main session' });
  }
  
  try {
    const sessStore = path.join(path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions'), 'sessions.json');
    let sessIndex = {};
    try { sessIndex = JSON.parse(fs.readFileSync(sessStore, 'utf8')); } catch {}
    
    // Find the session entry
    const entry = sessIndex[sessionKey];
    if (!entry) {
      return res.status(404).json({ error: 'Session not found in store' });
    }
    
    const sessionId = entry.sessionId;
    const sessionFile = path.join(path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions'), sessionId + '.jsonl');
    
    // Rename session file to mark as deleted/aborted
    if (fs.existsSync(sessionFile)) {
      const deletedName = sessionFile + '.deleted.' + new Date().toISOString().replace(/:/g, '-');
      fs.renameSync(sessionFile, deletedName);
    }
    
    // Remove from sessions index
    delete sessIndex[sessionKey];
    fs.writeFileSync(sessStore, JSON.stringify(sessIndex, null, 2));
    
    res.json({ ok: true, message: 'Session killed', sessionKey, sessionId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: orchestration - live status from openclaw CLI + session store
app.get('/api/orchestration/live', (req, res) => {
  const hit = cache.get('orch_live');
  if (hit) return res.json(hit);
  // Load sessions index for resolving truncated keys
  const sessStore = path.join(path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions'), 'sessions.json');
  let sessIndex = {};
  try { sessIndex = JSON.parse(fs.readFileSync(sessStore, 'utf8')); } catch {}
  const fullKeys = Object.keys(sessIndex);

  // Parse sessions from CLI output (not JSON - parse the table)
  const raw = exec("openclaw sessions list 2>/dev/null", '');
  const items = [];
  
  for (const line of raw.split('\n')) {
    // Match lines like: direct agent:main:subag...id  5m ago  model  tokens  flags
    const match = line.match(/^(\S+)\s+(agent:\S+)\s+(\S+\s+\S*(?:ago|now))\s+(\S+)\s+(.*)/);
    if (!match) continue;
    let [, kind, key, age, model, rest] = match;
    
    // Resolve truncated keys (e.g. "agent:main:subag...766282") against sessions.json
    if (key.includes('...')) {
      const suffix = key.split('...')[1];
      const resolved = fullKeys.find(k => k.endsWith(suffix));
      if (resolved) key = resolved;
    }
    
    // Determine session type
    let sessionKind = 'session';
    if (key.includes(':subagent:') || key.includes(':subag')) sessionKind = 'subagent';
    else if (key.includes(':cron:')) sessionKind = 'cron';
    else if (key === 'agent:main:main' || key === 'agent:voice:main') sessionKind = 'main';
    
    // Parse age string to rough ms
    let ageMs = 0;
    const ageMatch = age.trim().match(/(\d+)([mhd])\s*ago/);
    if (ageMatch) {
      const n = parseInt(ageMatch[1]);
      if (ageMatch[2] === 'm') ageMs = n * 60000;
      else if (ageMatch[2] === 'h') ageMs = n * 3600000;
      else if (ageMatch[2] === 'd') ageMs = n * 86400000;
    }
    
    // Get enhanced activity description
    let activityDesc = 'Idle';
    let currentState = 'idle';
    
    // Check recent activity from session file and journal
    // Get session ID from sessions.json metadata
    const sessEntry = sessIndex[key];
    const sessId = sessEntry?.sessionId || key.split(':')[key.split(':').length - 1];
    if (sessId && sessId !== 'main') {
      const transcriptPath = path.join(path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions'), sessId + '.jsonl');
      try {
        const transcript = fs.readFileSync(transcriptPath, 'utf8').trim();
        const lines = transcript.split('\n');
        if (lines.length > 0) {
          // Get the most recent message to understand current activity
          const lastLine = JSON.parse(lines[lines.length - 1]);
          const firstLine = JSON.parse(lines[0]);
          
          // Check if actively processing
          if (ageMs < 30000) { // Active within 30 seconds
            if (sessionKind === 'subagent' && firstLine.spawnLabel) {
              activityDesc = `Running: ${firstLine.spawnLabel}`;
              currentState = 'processing_subagent';
            } else if (sessionKind === 'cron') {
              activityDesc = 'Executing cron job';
              currentState = 'executing_cron';
            } else if (sessionKind === 'main') {
              // Check if processing WhatsApp or other channel
              if (firstLine.channel === 'whatsapp') {
                activityDesc = 'Processing WhatsApp message';
                currentState = 'processing_whatsapp';
              } else {
                activityDesc = 'Processing request';
                currentState = 'processing_request';
              }
            }
          } else if (ageMs < 300000) { // Recent within 5 minutes
            const idleTime = Math.floor(ageMs / 60000);
            activityDesc = `Idle since ${idleTime}m ago`;
            currentState = 'recent_idle';
          } else {
            const idleHours = Math.floor(ageMs / 3600000);
            const idleMins = Math.floor((ageMs % 3600000) / 60000);
            if (idleHours > 0) {
              activityDesc = `Idle since ${idleHours}h ${idleMins}m ago`;
            } else {
              activityDesc = `Idle since ${idleMins}m ago`;
            }
            currentState = 'long_idle';
          }
        }
      } catch {}
    } else if (key === 'agent:main:main' || key === 'agent:voice:main') {
      // Main session - check for recent activity
      if (ageMs < 30000) {
        activityDesc = 'Active in main session';
        currentState = 'active_main';
      } else {
        const now = new Date();
        const idleTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')} UTC`;
        activityDesc = `💤 Idle since ${idleTime}`;
        currentState = 'idle_main';
      }
    }
    
    // Determine label
    let label = key;
    if (sessionKind === 'main') label = 'Main Session';
    else if (sessionKind === 'subagent') {
      const uuid = key.split(':subagent:')[1] || key.split(':subag...')[1] || '';
      label = 'Sub-agent ' + (uuid.substring(0, 8) || '?');
    } else if (sessionKind === 'cron') label = 'Cron Job';
    
    // Check if aborted
    const isAborted = rest.includes('aborted');
    const status = ageMs < 30000 ? 'active' : isAborted ? 'aborted' : ageMs < 300000 ? 'recent' : 'idle';
    
    // Parse tokens
    const tokMatch = rest.match(/(\d+[kKmM]?)\/(\d+[kKmM]?)/);
    const tokens = tokMatch ? tokMatch[1] : '';
    
    items.push({ 
      key, 
      kind: sessionKind, 
      label, 
      model, 
      age: age.trim(), 
      ageMs, 
      status, 
      tokens, 
      isAborted,
      activityDescription: activityDesc,
      currentState,
      timeSinceActivity: ageMs
    });
  }
  
  // Enrich with labels from session transcripts
  for (const item of items) {
    if (item.kind === 'subagent') {
      const entry = sessIndex[item.key];
      // Use label from sessions.json if available
      if (entry?.label) {
        item.label = entry.label;
        if (item.ageMs < 30000) {
          item.activityDescription = `⚡ Running: ${entry.label}`;
          item.currentState = 'running_subagent';
        }
      }
      // Try to find label from transcript first line
      const sessId = entry?.sessionId || item.key.split(':subagent:')[1];
      if (sessId && !entry?.label) {
        const transcriptPath = path.join(path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions'), sessId + '.jsonl');
        try {
          const firstLines = fs.readFileSync(transcriptPath, 'utf8').split('\n').slice(0, 3);
          for (const l of firstLines) {
            try {
              const d = JSON.parse(l);
              if (d.label) { 
                item.label = d.label; 
                // Update activity description with specific task
                if (item.ageMs < 30000) {
                  item.activityDescription = `⚡ Running: ${d.label}`;
                  item.currentState = 'running_subagent';
                }
                break; 
              }
              if (d.spawnLabel) { 
                item.label = d.spawnLabel; 
                if (item.ageMs < 30000) {
                  item.activityDescription = `⚡ Running: ${d.spawnLabel}`;
                  item.currentState = 'running_subagent';
                }
                break; 
              }
            } catch {}
          }
        } catch {}
      }
    }
  }
  
  const liveResult = { items };
  cache.set('orch_live', liveResult, 8000); // 8s — live data, refresh faster
  res.json(liveResult);
});

// API: tools summary — top tool calls across recent sessions (7d)
app.get('/api/orchestration/tools-summary', (req, res) => {
  const hit = cache.get('orch_tools_summary');
  if (hit) return res.json(hit);
  const sessDir = path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions');
  try {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const files = fs.readdirSync(sessDir)
      .filter(f => f.endsWith('.jsonl'))
      .filter(f => { try { return now - fs.statSync(path.join(sessDir, f)).mtimeMs < sevenDaysMs; } catch { return false; } });

    const toolCounts = {};
    let totalCalls = 0;
    let sessionsScanned = 0;

    for (const f of files) {
      const raw = readFile(path.join(sessDir, f), '').trim();
      if (!raw) continue;
      sessionsScanned++;
      for (const line of raw.split('\n')) {
        try {
          const l = JSON.parse(line);
          if (l.type === 'message' && l.message && l.message.role === 'assistant') {
            const content = l.message.content;
            if (Array.isArray(content)) {
              for (const c of content) {
                if (c && (c.type === 'tool_use' || c.type === 'toolCall') && c.name) {
                  toolCounts[c.name] = (toolCounts[c.name] || 0) + 1;
                  totalCalls++;
                }
              }
            }
          }
        } catch {}
      }
    }

    const sorted = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, count]) => ({ name, count, pct: totalCalls > 0 ? Math.round(count / totalCalls * 100) : 0 }));

    const result = { tools: sorted, totalCalls, sessionsScanned, generatedAt: new Date().toISOString() };
    cache.set('orch_tools_summary', result, 60000); // 60s cache
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: status heartbeat - enhanced system status with activity parsing
app.get('/api/status/heartbeat', (req, res) => {
  const hit = cache.get('heartbeat');
  if (hit) return res.json(hit);
  try {
    // Get main session status
    const sessionsRaw = exec("openclaw sessions list 2>/dev/null", '');
    let mainSessionStatus = { status: 'unknown', lastActivity: null, description: 'Unknown' };
    
    for (const line of sessionsRaw.split('\n')) {
      if (line.includes('agent:main:main') || line.includes('agent:voice:main')) {
        const match = line.match(/^(\S+)\s+(agent:main:main)\s+(\S+\s+\S*(?:ago|now))\s+(\S+)\s+(.*)/);
        if (match) {
          const [, , , age, model] = match;
          const ageMatch = age.trim().match(/(\d+)([mhd])\s*ago/);
          let ageMs = 0;
          if (ageMatch) {
            const n = parseInt(ageMatch[1]);
            if (ageMatch[2] === 'm') ageMs = n * 60000;
            else if (ageMatch[2] === 'h') ageMs = n * 3600000;
            else if (ageMatch[2] === 'd') ageMs = n * 86400000;
          }
          
          if (ageMs < 60000) { // Active within 1 minute
            mainSessionStatus = {
              status: 'active',
              lastActivity: new Date(Date.now() - ageMs).toISOString(),
              description: 'Processing request',
              ageMs,
              model
            };
          } else {
            const now = new Date(Date.now() - ageMs);
            mainSessionStatus = {
              status: 'idle',
              lastActivity: now.toISOString(),
              description: `💤 Idle since ${now.toTimeString().split(' ')[0]} UTC`,
              ageMs,
              model
            };
          }
        }
        break;
      }
    }
    
    // Check systemd journal for recent OpenClaw activity
    const journalRaw = exec('journalctl -u openclaw --since "5 min ago" --no-pager -q -o short-iso 2>/dev/null | tail -5', '');
    let recentJournalActivity = [];
    
    for (const line of journalRaw.split('\n').filter(Boolean)) {
      try {
        // Parse journal line format: timestamp hostname service[pid]: message
        const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4})\s+\S+\s+openclaw\[\d+\]:\s*(.+)$/);
        if (match) {
          recentJournalActivity.push({
            timestamp: match[1],
            message: match[2].substring(0, 100)
          });
        }
      } catch {}
    }
    
    // Enhanced journal analysis for specific activity patterns
    let systemActivity = 'No recent activity';
    if (recentJournalActivity.length > 0) {
      const latest = recentJournalActivity[recentJournalActivity.length - 1];
      const latestTime = new Date(latest.timestamp);
      const ageMs = Date.now() - latestTime.getTime();
      
      if (ageMs < 60000) { // Within last minute
        if (latest.message.includes('whatsapp') || latest.message.includes('WhatsApp')) {
          systemActivity = '📱 Processing WhatsApp activity';
        } else if (latest.message.includes('cron') || latest.message.includes('schedule')) {
          systemActivity = '⏰ Cron job activity';
        } else if (latest.message.includes('subagent') || latest.message.includes('spawn')) {
          systemActivity = '🤖 Sub-agent activity';
        } else {
          systemActivity = '⚡ Recent system activity';
        }
      } else {
        systemActivity = `Last activity: ${Math.floor(ageMs / 60000)}m ago`;
      }
    }
    
    // Count active subagents
    let activeSubagents = 0;
    let subagentLabels = [];
    for (const line of sessionsRaw.split('\n')) {
      if (line.includes('subag') && (line.includes('just now') || line.match(/\b[0-2]s\s+ago/))) {
        activeSubagents++;
        const labelMatch = line.match(/agent:\S+/);
        if (labelMatch) subagentLabels.push(labelMatch[0]);
      }
    }

    // Enrich main session description with subagent info
    if (activeSubagents > 0 && mainSessionStatus.status === 'active') {
      mainSessionStatus.description = `Processing with ${activeSubagents} active sub-agent${activeSubagents > 1 ? 's' : ''}`;
    }

    const result = {
      mainSession: mainSessionStatus,
      systemActivity,
      activeSubagents,
      recentJournal: recentJournalActivity,
      timestamp: new Date().toISOString()
    };
    cache.set('heartbeat', result, 10000); // cache 10s
    res.json(result);
    
  } catch (error) {
    res.json({
      mainSession: { status: 'error', description: 'Failed to get status' },
      systemActivity: 'Error checking activity',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// API: settings - models list from OpenRouter
app.get('/api/settings/models', async (req, res) => {
  try {
    const orKey = process.env.OPENROUTER_API_KEY || exec("grep OPENROUTER_API_KEY ' + (process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw')) + '/openclaw.json | head -1 | grep -oP '\"[^\"]+\"$'").replace(/"/g, '');
    
    // Fetch models
    const modelsRaw = exec(`curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer ${orKey}"`, '{"data":[]}');
    let models = [];
    try { models = JSON.parse(modelsRaw)?.data || []; } catch {}
    
    // Fetch balance
    let balance = null;
    const balRaw = exec(`curl -s https://openrouter.ai/api/v1/auth/key -H "Authorization: Bearer ${orKey}"`, '{}');
    try { 
      const bd = JSON.parse(balRaw);
      // OpenRouter returns usage (spent), not balance. We need credits endpoint
      const credRaw = exec(`curl -s https://openrouter.ai/api/v1/credits -H "Authorization: Bearer ${orKey}"`, '{}');
      try {
        const cd = JSON.parse(credRaw);
        balance = cd?.data?.total_credits != null ? (cd.data.total_credits - (cd.data.total_usage || 0)) : null;
      } catch {}
      // Fallback: show usage info
      if (balance === null) balance = { usage: bd?.data?.usage || 0, note: 'usage_only' };
    } catch {}
    
    res.json({ models, balance, count: models.length });
  } catch(e) {
    res.json({ models: [], error: e.message });
  }
});

// API: settings - task assignments (read)
app.get('/api/settings/assignments', (req, res) => {
  const assignFile = path.join(WORKSPACE, 'config', 'model-assignments.json');
  let assignments = {};
  try { assignments = JSON.parse(fs.readFileSync(assignFile, 'utf8')); } catch {}
  res.json({ assignments });
});

// API: settings - task assignments (write)
app.post('/api/settings/assignments', express.json(), (req, res) => {
  const assignDir = path.join(WORKSPACE, 'config');
  const assignFile = path.join(assignDir, 'model-assignments.json');
  try {
    if (!fs.existsSync(assignDir)) fs.mkdirSync(assignDir, { recursive: true });
    fs.writeFileSync(assignFile, JSON.stringify(req.body.assignments || {}, null, 2));
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// API: test a model with a canned prompt
app.post('/api/settings/test-model', express.json(), async (req, res) => {
  const model = req.body.model;
  if (!model) return res.json({ error: 'No model specified' });

  const modelName = model.replace(/^(openrouter|ollama|anthropic)\//, '');
  const prompt = `Say 'Hello from ${modelName}' in exactly 5 words.`;
  const start = Date.now();

  try {
    let response = '', inputTokens = 0, outputTokens = 0;

    if (model.startsWith('openrouter/')) {
      const orKey = process.env.OPENROUTER_API_KEY || '';
      const orModel = model.replace(/^openrouter\//, '');
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${orKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: orModel, messages: [{ role: 'user', content: prompt }], max_tokens: 50 })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
      response = d.choices?.[0]?.message?.content || '';
      inputTokens = d.usage?.prompt_tokens || 0;
      outputTokens = d.usage?.completion_tokens || 0;
    } else if (model.startsWith('ollama/')) {
      const ollamaModel = model.replace(/^ollama\//, '');
      const r = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ollamaModel, messages: [{ role: 'user', content: prompt }], stream: false, options: { num_predict: 50 } })
      });
      const d = await r.json();
      response = d.message?.content || '';
      inputTokens = d.prompt_eval_count || 0;
      outputTokens = d.eval_count || 0;
    } else if (model.startsWith('anthropic/')) {
      const antKey = process.env.ANTHROPIC_API_KEY || '';
      const antModel = model.replace(/^anthropic\//, '');
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': antKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: antModel, max_tokens: 50, messages: [{ role: 'user', content: prompt }] })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
      response = d.content?.[0]?.text || '';
      inputTokens = d.usage?.input_tokens || 0;
      outputTokens = d.usage?.output_tokens || 0;
    } else {
      return res.json({ error: 'Unknown provider for model: ' + model });
    }

    const latencyMs = Date.now() - start;
    // Estimate cost using MODEL_PRICING or assume 0
    let estimatedCost = 0;
    const pKey = Object.keys(MODEL_PRICING).find(k => model.includes(k)) || '';
    if (pKey && MODEL_PRICING[pKey]) {
      const pr = MODEL_PRICING[pKey];
      estimatedCost = (inputTokens * pr.input / 1e6) + (outputTokens * pr.output / 1e6);
    }

    res.json({ response, latencyMs, inputTokens, outputTokens, estimatedCost });
  } catch (e) {
    res.json({ error: e.message, latencyMs: Date.now() - start });
  }
});

// Cost tracking pricing lookup (per million tokens)
const MODEL_PRICING = {
  // Direct Anthropic (subscription — show as $0 actual cost)
  'anthropic/claude-opus-4-6': { input: 15.0, output: 75.0, subscription: true },
  'anthropic/claude-sonnet-4-6': { input: 3.0, output: 15.0, subscription: true },
  // OpenRouter
  'openrouter/moonshotai/kimi-k2.5': { input: 0.23, output: 3.00 },
  'openrouter/z-ai/glm-5': { input: 0.28, output: 1.10 },
  'openrouter/z-ai/glm-4.5-air:free': { input: 0, output: 0 },
  'openrouter/deepseek/deepseek-r1-0528': { input: 0, output: 0 },
  'openrouter/deepseek/deepseek-chat-v3-0324': { input: 0.30, output: 0.88 },
  'openrouter/google/gemini-2.5-flash-preview': { input: 0.15, output: 0.60 },
  'openrouter/google/gemini-2.5-pro-preview': { input: 1.25, output: 10.0 },
  'openrouter/meta-llama/llama-4-maverick': { input: 0.20, output: 0.60 },
  'openrouter/qwen/qwen3-next-80b-a3b-instruct:free': { input: 0, output: 0 },
  'openrouter/qwen/qwen3-coder': { input: 0.16, output: 0.60 },
  'openrouter/mistralai/mistral-medium-3': { input: 0.40, output: 2.0 },
  'openrouter/nousresearch/hermes-3-llama-3.1-405b': { input: 0.80, output: 0.80 },
  'openrouter/openai/gpt-4.1': { input: 2.0, output: 8.0 },
  'openrouter/openai/o4-mini': { input: 1.10, output: 4.40 },
  'openrouter/x-ai/grok-3-mini': { input: 0.30, output: 0.50 },
  // Local
  'ollama/llama3.2': { input: 0, output: 0 }
};

// Resolve full model key from provider+modelId (e.g. "openrouter" + "z-ai/glm-5" → "openrouter/z-ai/glm-5")
function resolveModelKey(provider, modelId) {
  if (!provider || !modelId) return modelId || 'unknown';
  return `${provider}/${modelId}`;
}

function calculateSessionCost(sessionFile) {
  try {
    const lines = fs.readFileSync(sessionFile, 'utf8').trim().split('\n');
    let totalCost = 0;
    let sessionModel = 'unknown';
    const perModel = {}; // model → { input, output, cost, tokens, subscription }

    for (const line of lines) {
      try {
        const data = JSON.parse(line);

        // Track model from model_change events
        if (data.type === 'model_change' && data.modelId) {
          sessionModel = resolveModelKey(data.provider, data.modelId);
        }

        // Extract usage from message.usage (where OpenClaw stores it)
        const msg = data.message;
        if (msg && msg.usage) {
          const u = msg.usage;
          const model = resolveModelKey(msg.provider, msg.model);
          if (sessionModel === 'unknown') sessionModel = model;

          const pricing = MODEL_PRICING[model];
          let cost = 0;
          let isSub = false;

          if (u.cost && typeof u.cost.total === 'number') {
            // Pre-calculated cost from OpenClaw — use it
            cost = u.cost.total;
          } else if (pricing) {
            cost = (u.input || 0) * pricing.input / 1e6 + (u.output || 0) * pricing.output / 1e6;
          }

          // Subscription models: track usage but $0 actual cost
          if (pricing && pricing.subscription) {
            isSub = true;
            cost = 0;
          }

          if (!perModel[model]) perModel[model] = { cost: 0, input: 0, output: 0, calls: 0, subscription: isSub };
          perModel[model].cost += cost;
          perModel[model].input += (u.input || 0);
          perModel[model].output += (u.output || 0);
          perModel[model].calls += 1;
          totalCost += cost;
        }
      } catch {}
    }

    return { cost: totalCost, model: sessionModel, perModel };
  } catch {
    return { cost: 0, model: 'unknown', perModel: {} };
  }
}

// API: budget settings
const BUDGET_PATH = path.join(WORKSPACE, 'config/budget.json');
function readBudget() {
  try { return JSON.parse(fs.readFileSync(BUDGET_PATH, 'utf8')); } catch { return { dailyLimit: 5.00, weeklyLimit: 20.00, alertEnabled: true }; }
}
app.get('/api/settings/budget', (req, res) => {
  res.json(readBudget());
});
app.post('/api/settings/budget', express.json(), (req, res) => {
  try {
    const budget = {
      dailyLimit: parseFloat(req.body.dailyLimit) || 5.00,
      weeklyLimit: parseFloat(req.body.weeklyLimit) || 20.00,
      alertEnabled: !!req.body.alertEnabled
    };
    fs.mkdirSync(path.dirname(BUDGET_PATH), { recursive: true });
    fs.writeFileSync(BUDGET_PATH, JSON.stringify(budget, null, 2));
    res.json({ ok: true, budget });
  } catch (e) { res.json({ error: e.message }); }
});

// API: costs summary
app.get('/api/costs/summary', (req, res) => {
  const hit = cache.get('costs_summary');
  if (hit) return res.json(hit);
  try {
    const sessionDirs = [
      path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions'),
      '' + (process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw')) + '/cron/runs'
    ];

    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const sevenDaysMs = 7 * oneDayMs;

    let sessions = [];
    let dailyTotals = {};
    let modelTotals = {};       // model → { cost, input, output, calls, subscription }
    let totalToday = 0;
    let totalSevenDays = 0;
    let subscriptionUsage = {}; // model → { input, output, calls }

    for (const sessDir of sessionDirs) {
      let files;
      try { files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl')); } catch { continue; }

      for (const file of files) {
        const fullPath = path.join(sessDir, file);
        let stat;
        try { stat = fs.statSync(fullPath); } catch { continue; }
        const ageMs = now - stat.mtimeMs;
        if (ageMs > sevenDaysMs) continue;

        const sessionId = file.replace('.jsonl', '');
        const { cost, model, perModel } = calculateSessionCost(fullPath);
        const dateStr = new Date(stat.mtime).toISOString().split('T')[0];

        // Aggregate per-model data
        for (const [m, d] of Object.entries(perModel)) {
          if (!modelTotals[m]) modelTotals[m] = { cost: 0, input: 0, output: 0, calls: 0, subscription: d.subscription };
          modelTotals[m].cost += d.cost;
          modelTotals[m].input += d.input;
          modelTotals[m].output += d.output;
          modelTotals[m].calls += d.calls;

          if (d.subscription) {
            if (!subscriptionUsage[m]) subscriptionUsage[m] = { input: 0, output: 0, calls: 0 };
            subscriptionUsage[m].input += d.input;
            subscriptionUsage[m].output += d.output;
            subscriptionUsage[m].calls += d.calls;
          }
        }

        sessions.push({ id: sessionId, cost, model, date: dateStr, timestamp: stat.mtime.toISOString() });
        dailyTotals[dateStr] = (dailyTotals[dateStr] || 0) + cost;
        totalSevenDays += cost;
        if (ageMs < oneDayMs) totalToday += cost;
      }
    }

    // 7-day breakdown
    const sevenDayBreakdown = [];
    for (let i = 6; i >= 0; i--) {
      const dateStr = new Date(now - i * oneDayMs).toISOString().split('T')[0];
      sevenDayBreakdown.push({ date: dateStr, cost: dailyTotals[dateStr] || 0 });
    }

    // Sort sessions by timestamp desc
    sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const budget = readBudget();
    const dailyPercentUsed = budget.dailyLimit > 0 ? (totalToday / budget.dailyLimit) * 100 : 0;
    const weeklyPercentUsed = budget.weeklyLimit > 0 ? (totalSevenDays / budget.weeklyLimit) * 100 : 0;
    const overBudget = dailyPercentUsed >= 100 || weeklyPercentUsed >= 100;

    const result = {
      totalToday,
      totalSevenDays,
      sevenDayBreakdown,
      sessions: sessions.slice(0, 50),
      modelTotals,
      subscriptionUsage,
      budget: {
        ...budget,
        dailyPercentUsed: Math.round(dailyPercentUsed * 10) / 10,
        weeklyPercentUsed: Math.round(weeklyPercentUsed * 10) / 10,
        overBudget
      }
    };
    cache.set('costs_summary', result, 30000); // cache 30s
    res.json(result);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// API: costs by model (for charts)
app.get('/api/costs/by-model', (req, res) => {
  const hit = cache.get('costs_by_model');
  if (hit) return res.json(hit);
  try {
    const sessionDirs = [
      path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions'),
      '' + (process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw')) + '/cron/runs'
    ];
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    let modelCosts = {};

    for (const sessDir of sessionDirs) {
      let files;
      try { files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl')); } catch { continue; }

      for (const file of files) {
        const fullPath = path.join(sessDir, file);
        let stat;
        try { stat = fs.statSync(fullPath); } catch { continue; }
        if (now - stat.mtimeMs > sevenDaysMs) continue;

        const { perModel } = calculateSessionCost(fullPath);
        for (const [model, d] of Object.entries(perModel)) {
          if (!modelCosts[model]) modelCosts[model] = { cost: 0, sessions: 0, input: 0, output: 0, calls: 0, subscription: d.subscription };
          modelCosts[model].cost += d.cost;
          modelCosts[model].input += d.input;
          modelCosts[model].output += d.output;
          modelCosts[model].calls += d.calls;
          modelCosts[model].sessions += 1;
        }
      }
    }

    const modelArray = Object.entries(modelCosts)
      .map(([model, data]) => ({
        model,
        cost: data.cost,
        sessions: data.sessions,
        calls: data.calls,
        input: data.input,
        output: data.output,
        subscription: data.subscription,
        provider: model.split('/')[0]
      }))
      .sort((a, b) => b.cost - a.cost);

    const result = { models: modelArray };
    cache.set('costs_by_model', result, 30000); // cache 30s
    res.json(result);
  } catch (e) {
    res.json({ error: e.message, models: [] });
  }
});

// API: provider health check (cached 60s)
let healthCache = { data: null, ts: 0 };
app.get('/api/health/providers', async (req, res) => {
  if (healthCache.data && Date.now() - healthCache.ts < 60000) {
    return res.json(healthCache.data);
  }

  const check = async (name, fn) => {
    const start = Date.now();
    try {
      const result = await fn();
      return { status: 'ok', latencyMs: Date.now() - start, ...result };
    } catch {
      return { status: 'down', latencyMs: Date.now() - start };
    }
  };

  const anthropicKey = process.env.ANTHROPIC_API_KEY || exec("grep ANTHROPIC_API_KEY ' + (process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw')) + '/openclaw.json 2>/dev/null | head -1 | grep -oP '\"[^\"]+\"$'").replace(/"/g, '');
  const orKey = process.env.OPENROUTER_API_KEY || exec("grep OPENROUTER_API_KEY ' + (process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw')) + '/openclaw.json 2>/dev/null | head -1 | grep -oP '\"[^\"]+\"$'").replace(/"/g, '');

  const [anthropic, openrouter, ollama, openaiCodex] = await Promise.all([
    check('anthropic', () => {
      const code = exec(`curl -s -o /dev/null -w "%{http_code}" -m 5 -H "x-api-key: ${anthropicKey}" -H "anthropic-version: 2023-06-01" https://api.anthropic.com/v1/models`, '0');
      if (code === '0' || code.startsWith('5')) throw new Error('down');
      return {};
    }),
    check('openrouter', () => {
      const raw = exec(`curl -s -m 5 https://openrouter.ai/api/v1/auth/key -H "Authorization: Bearer ${orKey}"`, '{}');
      const d = JSON.parse(raw);
      if (!d.data) throw new Error('down');
      return { balance: d.data.usage != null ? d.data : undefined };
    }),
    check('ollama', () => {
      const raw = exec(`curl -s -m 3 http://localhost:11434/api/tags`, '');
      if (!raw) throw new Error('down');
      const d = JSON.parse(raw);
      return { models: (d.models || []).length };
    }),
    check('openai-codex', () => {
      const code = exec(`curl -s -o /dev/null -w "%{http_code}" -m 5 https://api.openai.com/v1/models`, '0');
      if (code === '0' || code.startsWith('5')) throw new Error('down');
      return {};
    }),
  ]);

  const result = { anthropic, openrouter, ollama, 'openai-codex': openaiCodex, checkedAt: new Date().toISOString() };
  healthCache = { data: result, ts: Date.now() };
  res.json(result);
});

// API: log tail
const ALLOWED_SERVICES = ['openclaw', 'clawdbot-dashboard', 'cloudflared-dashboard', 'searxng', 'ollama'];
app.get('/api/logs/tail', (req, res) => {
  const lines = Math.min(Math.max(parseInt(req.query.lines) || 50, 1), 500);
  const service = req.query.service || 'openclaw';
  if (!ALLOWED_SERVICES.includes(service)) {
    return res.status(400).json({ error: 'Invalid service', allowed: ALLOWED_SERVICES });
  }
  const output = exec(`journalctl -u ${service} --no-pager -n ${lines} -o short-iso 2>&1`, '');
  res.json({ lines: output ? output.split('\n') : [], service, timestamp: new Date().toISOString() });
});

// API: log service status — lightweight is-active check for all log-page service tabs
// Note: `systemctl is-active` exits non-zero for inactive/failed — must use show instead
app.get('/api/logs/services-status', (req, res) => {
  const hit = cache.get('log_svc_status');
  if (hit) return res.json(hit);
  const svcs = {};
  for (const svc of ALLOWED_SERVICES) {
    // `systemctl show` always exits 0; ActiveState is always readable
    const state = exec(`systemctl show ${svc} --property=ActiveState --value 2>/dev/null`, 'unknown').trim();
    svcs[svc] = state || 'unknown';
  }
  const result = { services: svcs, checkedAt: new Date().toISOString() };
  cache.set('log_svc_status', result, 15000); // 15s TTL — quick status, low cost
  res.json(result);
});

// API: neural graph (cached 30s, supports ?detail=low|medium|high)
app.get('/api/neural/graph', (req, res) => {
  try {
    const detail = req.query.detail || 'auto';
    const cacheKey = `graph_${detail}`;
    if (neuralGraphCache[cacheKey] && Date.now() - neuralGraphCache[cacheKey].ts < 30000) {
      return res.json(neuralGraphCache[cacheKey].data);
    }

    // Detail levels: low=mobile, medium=laptop, high=desktop
    const limits = {
      low:    { fibers: 100, neurons: 500 },
      medium: { fibers: 400, neurons: 3000 },
      high:   { fibers: 2000, neurons: 20000 },
      auto:   { fibers: 2000, neurons: 20000 }
    };
    const lim = limits[detail] || limits.auto;

    const db = getNeuralDb();

    const fibers = db.prepare(`
      SELECT id, summary, tags, salience, conductivity, coherence
      FROM fibers
      ORDER BY salience DESC
      LIMIT ?
    `).all(lim.fibers);

    const conceptNeurons = db.prepare(`
      SELECT n.id, n.content, n.type, n.metadata, ns.activation_level, ns.access_frequency
      FROM neurons n
      JOIN neuron_states ns ON ns.neuron_id = n.id
      WHERE n.type = 'concept'
      ORDER BY ns.access_frequency DESC
      LIMIT ?
    `).all(lim.neurons);

    const fiberIds = fibers.map(f => f.id);
    const neuronIds = conceptNeurons.map(n => n.id);

    // Use temp tables to avoid SQLite variable limit (999 max)
    const neuronIdSet = new Set(neuronIds);
    const fiberIdSet = new Set(fiberIds);

    const fiberNeuronEdges = (fiberIds.length && neuronIds.length)
      ? db.prepare(`
          SELECT fiber_id, neuron_id
          FROM fiber_neurons
        `).all().filter(r => fiberIdSet.has(r.fiber_id) && neuronIdSet.has(r.neuron_id))
      : [];

    const synapseEdges = (neuronIds.length)
      ? db.prepare(`
          SELECT source_id, target_id, type, weight
          FROM synapses
          ORDER BY weight DESC
        `).all().filter(r => neuronIdSet.has(r.source_id) && neuronIdSet.has(r.target_id))
      : [];

    const fiberNodes = fibers.map(f => {
      const tags = parseJsonArray(f.tags);
      const label = (f.summary && String(f.summary).trim()) || (tags.join(', ').slice(0, 40) || `Fiber ${f.id}`);
      const salience = Number(f.salience) || 0;
      return {
        id: `f-${f.id}`,
        label,
        type: 'fiber',
        salience,
        conductivity: Number(f.conductivity) || 0,
        coherence: Number(f.coherence) || 0,
        tags,
        summary: f.summary || '',
        size: Math.max(10, Math.min(18, 10 + salience * 8))
      };
    });

    const neuronNodes = conceptNeurons.map(n => {
      const activation = Number(n.activation_level) || 0;
      let metadata = {};
      if (n.metadata) {
        try { metadata = JSON.parse(n.metadata); } catch { metadata = {}; }
      }
      return {
        id: `n-${n.id}`,
        label: n.content || `Neuron ${n.id}`,
        type: n.type || 'concept',
        activation,
        access_frequency: Number(n.access_frequency) || 0,
        metadata,
        size: Math.max(4, Math.min(8, 4 + activation * 4))
      };
    });

    // Computed similarity edges — fiber-to-fiber (shared tags) + neuron-to-neuron (word overlap)
    const computedEdges = [];

    // Fiber-to-fiber: connect fibers sharing ≥2 tags
    for (let i = 0; i < fiberNodes.length; i++) {
      for (let j = i + 1; j < fiberNodes.length; j++) {
        const a = fiberNodes[i].tags;
        const b = fiberNodes[j].tags;
        const shared = a.filter(t => b.includes(t));
        if (shared.length >= 2) {
          computedEdges.push({
            source: fiberNodes[i].id,
            target: fiberNodes[j].id,
            type: 'computed_similar',
            weight: shared.length / Math.max(a.length, b.length, 1),
            sharedTags: shared
          });
        }
      }
    }

    // Neuron-to-neuron: Jaccard similarity on content words (skip if already synapse-linked)
    const synapseSet = new Set(synapseEdges.map(e => `n-${e.source_id}::n-${e.target_id}`));
    const tokenize = s => new Set((s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3));
    const STOPWORDS = new Set(['that','this','with','from','have','they','their','will','been','when','what','which','also','into','more','than','some','were','about','other','there','would','could','should','then','these','after','where','being']);
    const filteredToken = s => new Set([...tokenize(s)].filter(w => !STOPWORDS.has(w)));

    // Only check top 60 neurons to keep comparisons manageable (~1770 pairs)
    const topNeurons = neuronNodes.slice(0, 60);
    for (let i = 0; i < topNeurons.length; i++) {
      const aWords = filteredToken(topNeurons[i].label);
      for (let j = i + 1; j < topNeurons.length; j++) {
        const key = `${topNeurons[i].id}::${topNeurons[j].id}`;
        if (synapseSet.has(key)) continue;
        const bWords = filteredToken(topNeurons[j].label);
        const inter = [...aWords].filter(w => bWords.has(w)).length;
        if (inter < 2) continue;
        const union = new Set([...aWords, ...bWords]).size;
        const jaccard = union > 0 ? inter / union : 0;
        if (jaccard >= 0.35) {
          computedEdges.push({
            source: topNeurons[i].id,
            target: topNeurons[j].id,
            type: 'computed_similar',
            weight: jaccard,
            sharedWords: [...aWords].filter(w => bWords.has(w)).slice(0, 5)
          });
        }
      }
    }

    const edges = [
      ...fiberNeuronEdges.map(e => ({
        source: `f-${e.fiber_id}`,
        target: `n-${e.neuron_id}`,
        type: 'fiber_neuron',
        weight: 1
      })),
      ...synapseEdges.map(e => ({
        source: `n-${e.source_id}`,
        target: `n-${e.target_id}`,
        type: e.type || 'related_to',
        weight: Number(e.weight) || 0
      })),
      ...computedEdges
    ];

    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM neurons) AS neurons,
        (SELECT COUNT(*) FROM synapses) AS synapses,
        (SELECT COUNT(*) FROM fibers) AS fibers
    `).get();

    // Build fiber membership map for neurons (which fiber each neuron belongs to)
    const neuronFiberMap = {};
    for (const fe of fiberNeuronEdges) {
      const nid = `n-${fe.neuron_id}`;
      const fid = `f-${fe.fiber_id}`;
      if (!neuronFiberMap[nid]) neuronFiberMap[nid] = fid;
    }
    // Attach fiber info to neuron nodes
    for (const nn of neuronNodes) {
      nn.fiberId = neuronFiberMap[nn.id] || null;
    }

    const payload = {
      nodes: [...fiberNodes, ...neuronNodes],
      edges,
      stats: {
        neurons: counts.neurons,
        synapses: counts.synapses,
        fibers: counts.fibers,
        lastTrained: neuralLastTrainedIso(db)
      }
    };

    neuralGraphCache[cacheKey] = { ts: Date.now(), data: payload };
    res.json(payload);
  } catch (e) {
    neuralDb = null; // Reset stale handle so next request reconnects
    neuralGraphCache = {}; // Invalidate cache
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/neural/stats', (req, res) => {
  const hit = cache.get('neural_stats');
  if (hit) return res.json(hit);

  try {
    const db = getNeuralDb();
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM neurons) AS neurons,
        (SELECT COUNT(*) FROM synapses) AS synapses,
        (SELECT COUNT(*) FROM fibers) AS fibers
    `).get();

    const topConcepts = db.prepare(`
      SELECT n.content, ns.access_frequency
      FROM neurons n
      JOIN neuron_states ns ON ns.neuron_id = n.id
      WHERE n.type = 'concept'
      ORDER BY ns.access_frequency DESC
      LIMIT 15
    `).all().map(r => ({ label: r.content, freq: r.access_frequency || 0 })).filter(r => r.label);

    const result = {
      neurons: counts.neurons,
      synapses: counts.synapses,
      fibers: counts.fibers,
      topConcepts,
      lastTrained: neuralLastTrainedIso(db)
    };
    cache.set('neural_stats', result, 30000); // cache 30s
    res.json(result);
  } catch (e) {
    neuralDb = null; // Reset stale handle
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/neural/recall', (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Missing q parameter' });

    const escaped = q.replace(/"/g, '\\"');
    const output = execSync(`nmem recall "${escaped}"`, {
      timeout: 8000,
      encoding: 'utf8'
    }).trim();

    res.json({ query: q, result: output });
  } catch (e) {
    const stderr = e?.stderr ? String(e.stderr).trim() : '';
    res.status(500).json({ error: stderr || e.message, query: String(req.query.q || '') });
  }
});

// API: sessions hourly activity heatmap (last 7 days, bucketed by hour 0-23)
app.get('/api/sessions/hourly', (req, res) => {
  const hit = cache.get('sessions_hourly');
  if (hit) return res.json(hit);

  try {
    const sessDir = path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions');
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    const hourBuckets = new Array(24).fill(0);    // session starts per hour
    const toolBuckets = new Array(24).fill(0);    // tool calls per hour (sampled)
    const dayBuckets = {};                        // date → session count

    let files;
    try { files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl')); } catch { files = []; }

    for (const f of files) {
      const fullPath = path.join(sessDir, f);
      let stat;
      try { stat = fs.statSync(fullPath); } catch { continue; }
      if (now - stat.mtimeMs > sevenDaysMs) continue;

      // Read just the first line to get session start time + a quick scan for tool calls
      let firstLine = null;
      let toolCallsInSession = 0;
      try {
        const lines = fs.readFileSync(fullPath, 'utf8').trim().split('\n');
        try { firstLine = JSON.parse(lines[0]); } catch {}
        // Quick scan for tool calls (sample up to 100 lines)
        const scanLimit = Math.min(lines.length, 100);
        for (let i = 0; i < scanLimit; i++) {
          try {
            const l = JSON.parse(lines[i]);
            if (l.type === 'message' && l.message && l.message.role === 'assistant') {
              const content = l.message.content;
              if (Array.isArray(content)) {
                toolCallsInSession += content.filter(c => c && (c.type === 'tool_use' || c.type === 'toolCall')).length;
              }
            }
          } catch {}
        }
      } catch { continue; }

      const ts = firstLine && firstLine.timestamp ? new Date(firstLine.timestamp) : new Date(stat.mtime);
      if (isNaN(ts.getTime())) continue;
      if (now - ts.getTime() > sevenDaysMs) continue;

      const hour = ts.getUTCHours();
      hourBuckets[hour]++;
      toolBuckets[hour] += toolCallsInSession;

      const dateStr = ts.toISOString().split('T')[0];
      dayBuckets[dateStr] = (dayBuckets[dateStr] || 0) + 1;
    }

    // Build 7-day date array
    const sevenDayBreakdown = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      sevenDayBreakdown.push({ date: d, sessions: dayBuckets[d] || 0 });
    }

    // Find peak hour
    const peakHour = hourBuckets.indexOf(Math.max(...hourBuckets));

    const result = {
      hourBuckets,       // [0..23] session counts
      toolBuckets,       // [0..23] tool call counts
      sevenDayBreakdown,
      peakHour,
      totalSessions: hourBuckets.reduce((a, b) => a + b, 0),
      totalTools: toolBuckets.reduce((a, b) => a + b, 0)
    };
    cache.set('sessions_hourly', result, 60000); // cache 60s
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: session error summary (last 24h — lightweight scan) ─────────────────
app.get('/api/sessions/errors-summary', (req, res) => {
  const hit = cache.get('sess_errors_summary');
  if (hit) return res.json(hit);

  try {
    const sessDir = path.join(process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw'), 'agents/voice/sessions');
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    // Try orch_sessions cache first (already rich data)
    const orchCache = cache.get('orch_sessions');
    if (orchCache && orchCache.sessions) {
      const todaySessions = orchCache.sessions.filter(s => s.startTime && (now - new Date(s.startTime).getTime()) < oneDayMs);
      const errorSessions = todaySessions.filter(s => s.hasError || s.status === 'failed' || s.status === 'aborted');
      const successCount = todaySessions.length - errorSessions.length;
      const successRate = todaySessions.length > 0 ? Math.round(successCount / todaySessions.length * 100) : 100;
      const result = {
        totalToday: todaySessions.length,
        errorsToday: errorSessions.length,
        successRate,
        recentErrors: errorSessions.slice(0, 5).map(s => ({
          id: s.id,
          task: (s.task || '').substring(0, 80),
          kind: s.kind,
          status: s.status,
          error: (s.lastError || '').substring(0, 120),
          time: s.endTime || s.startTime
        })),
        rich: true
      };
      cache.set('sess_errors_summary', result, 20000);
      return res.json(result);
    }

    // Light fallback: quick file stat scan + read last lines for errors
    let files;
    try { files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl') && !f.includes('.deleted.')); } catch { files = []; }

    let totalToday = 0, errorsToday = 0;
    const recentErrors = [];
    const sessIndex = (() => { try { return JSON.parse(fs.readFileSync(path.join(sessDir, 'sessions.json'), 'utf8')); } catch { return {}; } })();
    const idToLabel = {};
    for (const [k, v] of Object.entries(sessIndex)) { if (v?.sessionId) idToLabel[v.sessionId] = v.label || k; }

    for (const f of files) {
      const fp = path.join(sessDir, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > oneDayMs) continue;
        totalToday++;
        // Read last 10 lines for error detection
        const content = fs.readFileSync(fp, 'utf8').trim().split('\n');
        const { hasError, lastError, status } = extractSessionError(content);
        if (hasError) {
          errorsToday++;
          if (recentErrors.length < 5) {
            const id = f.replace('.jsonl', '');
            recentErrors.push({
              id: id.substring(0, 12),
              task: (idToLabel[id] || '').substring(0, 80),
              kind: 'session',
              status,
              error: (lastError || '').substring(0, 120),
              time: stat.mtime.toISOString()
            });
          }
        }
      } catch {}
    }

    const successRate = totalToday > 0 ? Math.round((totalToday - errorsToday) / totalToday * 100) : 100;
    const result = { totalToday, errorsToday, successRate, recentErrors, rich: false };
    cache.set('sess_errors_summary', result, 20000);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message, errorsToday: 0, successRate: 100 });
  }
});

// ── Batch endpoint: all dashboard data in one request ─────────────────────
app.get('/api/dashboard', async (req, res) => {
  const hit = cache.get('dashboard_batch');
  if (hit) return res.json(hit);

  // Run the three slow independent pieces in parallel using promises
  const withCache = (key, ttl, fn) => {
    const c = cache.get(key);
    if (c) return Promise.resolve(c);
    return new Promise(resolve => {
      try { const v = fn(); cache.set(key, v, ttl); resolve(v); }
      catch(e) { resolve({ error: e.message }); }
    });
  };

  // Gather health (use existing cache if warm)
  const healthP = withCache('health', 20000, () => {
    const diskRaw = exec("df -h / | tail -1 | awk '{print $2,$3,$4,$5}'");
    const [diskTotal, diskUsed, diskFree, diskPct] = diskRaw.split(' ');
    const totalMem = os.totalmem(), freeMem = os.freemem();
    const oclawPid = exec("pgrep -f 'openclaw.*gateway' | head -1");
    const dockerRaw = exec("docker ps --format '{{.Names}}:{{.Status}}' 2>/dev/null");
    return {
      system: {
        hostname: os.hostname(), uptime: os.uptime(),
        cpu: { count: os.cpus().length, load: os.loadavg() },
        memory: { total: totalMem, used: totalMem - freeMem, free: freeMem, pct: (((totalMem-freeMem)/totalMem)*100).toFixed(1) },
        disk: { total: diskTotal, used: diskUsed, free: diskFree, pct: diskPct }
      },
      openclaw: { version: exec("openclaw --version 2>/dev/null"), pid: oclawPid },
      docker: dockerRaw ? dockerRaw.split('\n').map(c => { const [n,...s]=c.split(':'); return {name:n,status:s.join(':')}; }) : []
    };
  });

  // Gather heartbeat (use existing cache if warm)
  const heartbeatP = withCache('heartbeat', 10000, () => {
    const sessionsRaw = exec("openclaw sessions list 2>/dev/null", '');
    let mainSession = { status: 'unknown', description: 'Unknown', model: '' };
    for (const line of sessionsRaw.split('\n')) {
      if (line.includes('agent:main:main') || line.includes('agent:voice:main')) {
        const ageMatch = line.match(/(\d+)([smhd])\s+ago/);
        let ageMs = 0;
        if (ageMatch) {
          const n = parseInt(ageMatch[1]);
          if (ageMatch[2]==='s') ageMs=n*1000; else if (ageMatch[2]==='m') ageMs=n*60000;
          else if (ageMatch[2]==='h') ageMs=n*3600000; else if (ageMatch[2]==='d') ageMs=n*86400000;
        }
        const modelM = line.match(/claude-\S+|gpt-\S+|llama\S+/);
        mainSession = {
          status: ageMs < 120000 ? 'active' : 'idle',
          lastActivity: new Date(Date.now()-ageMs).toISOString(),
          description: ageMs < 120000 ? 'Active' : `Idle ${Math.floor(ageMs/60000)}m`,
          ageMs, model: modelM ? modelM[0] : ''
        };
        break;
      }
    }
    return { mainSession, systemActivity: 'OK', activeSubagents: 0, timestamp: new Date().toISOString() };
  });

  // Costs (use existing cache only — don't run full calculation inline; let /api/costs/summary handle it)
  const costsP = Promise.resolve(cache.get('costs_summary') || { totalToday: 0, totalSevenDays: 0 });

  const [health, heartbeat, costs] = await Promise.all([healthP, heartbeatP, costsP]);

  const result = { health, heartbeat, costs, _cached: true, _ts: Date.now() };
  cache.set('dashboard_batch', result, 10000); // batch cache 10s
  res.json(result);
});

// ── Workspace Identity API ────────────────────────────────────────────────
const CORE_FILES = [
  { name: 'AGENTS.md',    path: 'AGENTS.md',    category: 'core' },
  { name: 'SOUL.md',      path: 'SOUL.md',      category: 'core' },
  { name: 'IDENTITY.md',  path: 'IDENTITY.md',  category: 'core' },
  { name: 'USER.md',      path: 'USER.md',      category: 'core' },
  { name: 'MEMORY.md',    path: 'MEMORY.md',    category: 'core' },
  { name: 'HEARTBEAT.md', path: 'HEARTBEAT.md', category: 'core' },
  { name: 'TOOLS.md',     path: 'TOOLS.md',     category: 'core' },
];

app.get('/api/workspace/files', (req, res) => {
  const cached = cache.get('workspace_files');
  if (cached) return res.json(cached);

  const files = [];

  // Core files
  for (const f of CORE_FILES) {
    const abs = path.join(WORKSPACE, f.path);
    try {
      const stat = fs.statSync(abs);
      files.push({ name: f.name, path: f.path, size: stat.size, mtime: stat.mtime.toISOString(), category: f.category });
    } catch { /* skip if missing */ }
  }

  // Memory logs: memory/*.md sorted descending by name
  const memDir = path.join(WORKSPACE, 'memory');
  try {
    const memFiles = fs.readdirSync(memDir)
      .filter(n => n.endsWith('.md'))
      .sort()
      .reverse();
    for (const n of memFiles) {
      const abs = path.join(memDir, n);
      try {
        const stat = fs.statSync(abs);
        files.push({ name: n, path: 'memory/' + n, size: stat.size, mtime: stat.mtime.toISOString(), category: 'memory' });
      } catch { /* skip */ }
    }
  } catch { /* memory dir missing */ }

  const result = { files };
  cache.set('workspace_files', result, 10000);
  res.json(result);
});

app.get('/api/workspace/file', (req, res) => {
  const relPath = req.query.path;
  if (!relPath || relPath.startsWith('/') || relPath.includes('..')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  const abs = path.join(WORKSPACE, relPath);
  let stat;
  try { stat = fs.statSync(abs); } catch { return res.status(404).json({ error: 'File not found' }); }
  if (stat.size > 500 * 1024) return res.status(413).json({ error: 'File too large' });
  try {
    const content = fs.readFileSync(abs, 'utf8');
    res.json({ content, path: relPath, size: stat.size, mtime: stat.mtime.toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: workspace fulltext search — grep across all workspace markdown files
app.get('/api/workspace/search', (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query || query.length < 2) return res.status(400).json({ error: 'Query too short' });
  if (query.length > 100) return res.status(400).json({ error: 'Query too long' });

  // Sanitise: only allow alphanumeric + common punctuation, reject shell meta
  if (/[;|`$&(){}[\]<>\\]/.test(query)) return res.status(400).json({ error: 'Invalid characters in query' });

  const cacheKey = 'ws_search_' + query.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    // grep -rn case-insensitive in workspace markdown/json files, max 5 lines per file, limit output
    const raw = exec(
      `grep -rni --include="*.md" --include="*.json" -m 5 ${JSON.stringify(query)} ${WORKSPACE} 2>/dev/null | head -100`,
      ''
    );

    const results = [];
    const fileCounts = {};
    for (const line of raw.split('\n').filter(Boolean)) {
      const colon1 = line.indexOf(':');
      const colon2 = line.indexOf(':', colon1 + 1);
      if (colon1 < 0 || colon2 < 0) continue;
      const absPath = line.slice(0, colon1);
      const lineNum = parseInt(line.slice(colon1 + 1, colon2));
      const text = line.slice(colon2 + 1).trim();
      const relPath = absPath.startsWith(WORKSPACE + '/') ? absPath.slice(WORKSPACE.length + 1) : absPath;

      // Skip node_modules, .git, binary files
      if (relPath.includes('node_modules') || relPath.includes('.git') || relPath.includes('/files/')) continue;

      fileCounts[relPath] = (fileCounts[relPath] || 0) + 1;
      results.push({ file: relPath, line: lineNum, text: text.slice(0, 200) });
    }

    const out = { query, results, totalFiles: Object.keys(fileCounts).length, totalMatches: results.length };
    cache.set(cacheKey, out, 15000); // 15s cache
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: memory file health — freshness / size of key memory files
app.get('/api/memory/health', (req, res) => {
  const hit = cache.get('memory_health');
  if (hit) return res.json(hit);

  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];

  const checkFile = (relPath, staleThresholdMs) => {
    const abs = path.join(WORKSPACE, relPath);
    try {
      const stat = fs.statSync(abs);
      const content = fs.readFileSync(abs, 'utf8');
      const lines = content.split('\n').filter(l => l.trim()).length;
      const ageMs = now - stat.mtimeMs;
      return {
        exists: true,
        size: stat.size,
        lines,
        mtime: stat.mtime.toISOString(),
        ageMs,
        stale: ageMs > staleThresholdMs
      };
    } catch {
      return { exists: false, size: 0, lines: 0, mtime: null, ageMs: null, stale: false };
    }
  };

  const result = {
    memoryMd:      checkFile('MEMORY.md',                       72 * 3600 * 1000), // stale >72h
    todayLog:      checkFile(`memory/${today}.md`,               8 * 3600 * 1000), // stale >8h (agent logs 2-3x/day)
    sessionState:  checkFile('memory/session-state.json',        8 * 3600 * 1000), // stale >8h
    heartbeatState:checkFile('memory/heartbeat-state.json',      8 * 3600 * 1000), // stale >8h
    heartbeatMd:   checkFile('HEARTBEAT.md',                    72 * 3600 * 1000), // stale >72h
    date: today,
    checkedAt: new Date().toISOString()
  };

  cache.set('memory_health', result, 30000); // 30s cache
  res.json(result);
});

// ══════════════════════════════════════════════════════════════════════════
// === Network & Tunnel Status ==================================================
// ══════════════════════════════════════════════════════════════════════════

// GET /api/network/status — checks cloudflared tunnel, local port, public URLs
app.get('/api/network/status', (req, res) => {
  const hit = cache.get('network_status');
  if (hit) return res.json(hit);

  const TUNNEL_ID = 'fa824c5c-59d3-4bb7-b84e-ba4ba35e98b7'; // from TOOLS.md

  // 1. cloudflared-dashboard service state
  const tunnelActive = exec('systemctl show cloudflared-dashboard --property=ActiveState --value 2>/dev/null', 'unknown').trim();

  // 2. Is port 3000 actually listening?
  const portOut = exec('ss -ltn 2>/dev/null | grep ":3000 "', '');
  const portListening = portOut.trim().length > 0;

  // 3. Public URL checks (fast — 4s max each)
  const arcResult = (() => {
    const start = Date.now();
    const code = exec('curl -s -o /dev/null -w "%{http_code}" -m 4 https://arc.net.pk 2>/dev/null', '0');
    return { httpStatus: parseInt(code) || 0, latencyMs: Date.now() - start };
  })();

  const dashResult = (() => {
    const start = Date.now();
    const code = exec('curl -s -o /dev/null -w "%{http_code}" -m 4 https://dashboard.arc.net.pk 2>/dev/null', '0');
    return { httpStatus: parseInt(code) || 0, latencyMs: Date.now() - start };
  })();

  const result = {
    tunnel: { active: tunnelActive },
    port: { listening: portListening },
    arc: arcResult,
    dashboard: dashResult,
    tunnelId: TUNNEL_ID,
    checkedAt: new Date().toISOString()
  };
  cache.set('network_status', result, 30000); // 30s TTL
  res.json(result);
});

// ══════════════════════════════════════════════════════════════════════════
// === Admin Utility Routes =================================================
// ══════════════════════════════════════════════════════════════════════════

// GET /api/admin/cache-stats — expose in-memory TTL cache key count + workspace disk
app.get('/api/admin/cache-stats', (req, res) => {
  const now = Date.now();
  const keys = Object.entries(cache._s).map(([k, e]) => ({
    key: k,
    ttlRemaining: Math.max(0, Math.round((e.exp - now) / 1000)),
    expired: now > e.exp
  })).filter(e => !e.expired);

  const diskWorkspace = exec(`du -sh ${WORKSPACE} 2>/dev/null | cut -f1`, '?');
  const diskSessions = exec(`du -sh ' + (process.env.OPENCLAW_HOME || path.resolve(os.homedir(), '.openclaw')) + '/agents/voice/sessions 2>/dev/null | cut -f1`, '?');
  const diskNeural   = exec(`du -sh ' + os.homedir() + '/.neuralmemory 2>/dev/null | cut -f1`, '?');
  const processMemMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);

  res.json({
    cacheKeys: keys.length,
    keys,
    disk: { workspace: diskWorkspace, sessions: diskSessions, neural: diskNeural },
    processMem: processMemMb,
    uptime: Math.round(process.uptime()),
    nodeVersion: process.version
  });
});

// POST /api/admin/clear-cache — flush all in-memory TTL cache entries
app.post('/api/admin/clear-cache', express.json(), (req, res) => {
  const keysBefore = Object.keys(cache._s).length;
  cache._s = {};
  console.log(`[admin] Cache cleared by ${req.session.username || 'unknown'} — ${keysBefore} keys removed`);
  res.json({ ok: true, keysCleared: keysBefore });
});


// ── Virtual host routing ──────────────────────────────────────────────────
// (ARC website routing is above requireAuth — see line ~90)

// Dashboard — served on dashboard.arc.net.pk and everything else
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Global error handlers — prevent crashes from uncaught errors ───────────
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message, err.stack);
  // Don't exit — keep server running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', reason);
  // Don't exit — keep server running
});

// ── Graceful shutdown — close neural DB connection ─────────────────────────
function gracefulShutdown(signal) {
  console.log(`[${signal}] Shutting down gracefully...`);
  if (neuralDb) {
    try { neuralDb.close(); } catch (e) { /* ignore */ }
  }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🤖 Clawdbot Dashboard running on http://0.0.0.0:${PORT}`);
  console.log(`🌐 ARC website routing: arc.net.pk → ${ARC_SITE}`);
});

// (duplicate mobile-log route removed — registered before auth at line ~117)
