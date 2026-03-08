// Load .env from user config dir first, then fallback to package dir
const dotenv = require('dotenv');
const _userEnv = require('path').join(process.env.OPENCLAW_HOME || require('path').join(require('os').homedir(), '.openclaw'), 'dashboard', 'config', '.env');
dotenv.config({ path: require('fs').existsSync(_userEnv) ? _userEnv : undefined });
const express = require('express');
const { execSync, execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
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
const DEFAULT_OPENCLAW_HOME = path.resolve(os.homedir(), '.openclaw');
const DEFAULT_WORKSPACE = path.join(DEFAULT_OPENCLAW_HOME, 'workspace');
const NEURAL_DB_PATH = require('path').resolve(require('os').homedir(), '.neuralmemory/brains/default.db');

function getOpenClawHome() {
  return process.env.OPENCLAW_HOME || DEFAULT_OPENCLAW_HOME;
}

function getWorkspace() {
  return process.env.OPENCLAW_WORKSPACE || DEFAULT_WORKSPACE;
}

function getAgentName() {
  return process.env.OPENCLAW_AGENT || 'voice';
}

function getSessionsDir() {
  return path.join(getOpenClawHome(), 'agents', getAgentName(), 'sessions');
}

function getDashboardPort() {
  const value = parseInt(process.env.PORT || '3000', 10);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : 3000;
}

function getDashboardHost() {
  const host = String(process.env.HOST || '0.0.0.0').trim();
  return /^[a-zA-Z0-9.:_-]+$/.test(host) ? host : '0.0.0.0';
}

function getServiceName(kind) {
  if (kind === 'dashboard') return process.env.SVC_DASHBOARD || 'clawdbot-dashboard';
  if (kind === 'tunnel') return process.env.SVC_TUNNEL || 'cloudflared-dashboard';
  return '';
}

function getExtraServices() {
  return (process.env.SVC_EXTRA || 'searxng,ollama').split(',').map(s => s.trim()).filter(Boolean);
}

function getAllowedServices() {
  return ['openclaw', 'openclaw-gateway', getServiceName('dashboard'), getServiceName('tunnel'), ...getExtraServices()].filter(Boolean);
}

// Startup snapshots for legacy read-only paths that still use module-level constants.
const WORKSPACE = getWorkspace();
const OPENCLAW_HOME = getOpenClawHome();
const AGENT_NAME = getAgentName();
const SESSIONS_DIR = getSessionsDir();
const SVC_DASHBOARD = getServiceName('dashboard');
const SVC_TUNNEL = getServiceName('tunnel');
const SVC_EXTRA = getExtraServices();

// Config lives in user home, not inside the npm package (which may be root-owned)
const CONFIG_DIR = process.env.OPENCLAW_DASHBOARD_CONFIG || path.join(getOpenClawHome(), 'dashboard', 'config');
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

function pickWritableSessionStorePath() {
  const candidates = [
    path.join(CONFIG_DIR, 'dashboard-sessions.json'),
    path.join(os.tmpdir(), 'openclaw-dashboard-sessions.json')
  ];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      const probe = candidate + '.write-test';
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return path.join(os.tmpdir(), 'openclaw-dashboard-sessions.json');
}

const SESSION_STORE_PATH = pickWritableSessionStorePath();

const AUTH_CONFIG_PATH = path.join(CONFIG_DIR, 'dashboard-auth.json');
function getAuthConfig() {
  try { return JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, 'utf8')); }
  catch { return { username: 'admin', passwordHash: '$2a$10$placeholder' }; }
}

function getSessionSecret() {
  const configured = String(process.env.SESSION_SECRET || '');
  if (configured.length >= 32) return configured;
  return crypto.randomBytes(32).toString('hex');
}

class FileSessionStore extends session.Store {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this._ensure();
  }

  _ensure() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, '{}\n');
  }

  _readAll() {
    this._ensure();
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const now = Date.now();
      let mutated = false;
      for (const [sid, sess] of Object.entries(data)) {
        const expiresAt = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : null;
        if (expiresAt && expiresAt <= now) {
          delete data[sid];
          mutated = true;
        }
      }
      if (mutated) this._writeAll(data);
      return data;
    } catch {
      return {};
    }
  }

  _writeAll(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  get(sid, cb) {
    try {
      const data = this._readAll();
      cb(null, data[sid] || null);
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const data = this._readAll();
      data[sid] = sess;
      this._writeAll(data);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      const data = this._readAll();
      delete data[sid];
      this._writeAll(data);
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(session({
  store: new FileSessionStore(SESSION_STORE_PATH),
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: 'auto',
    sameSite: 'lax',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Check if setup has been completed
function isSetupComplete() {
  if (process.env.FORCE_SETUP === '1') return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, 'utf8'));
    return cfg.passwordHash && cfg.passwordHash !== '$2a$10$placeholder';
  } catch { return false; }
}

function isLocalRequest(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const host = String(req.headers.host || '').split(':')[0];
  return ip === '127.0.0.1' || ip === '::1' || host === 'localhost';
}

function safeRedirectPath(input) {
  if (typeof input !== 'string' || !input.startsWith('/') || input.startsWith('//')) return '/';
  return input;
}

function requireSameOrigin(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (!isSetupComplete() && (req.path === '/setup' || req.path === '/setup.html' || req.path.startsWith('/api/setup/'))) return next();
  if (req.path === '/api/mobile-log' || req.path === '/api/contact') return next();

  const host = String(req.headers.host || '');
  const origin = String(req.headers.origin || '');
  const referer = String(req.headers.referer || '');
  const allowedPrefixes = [`http://${host}/`, `https://${host}/`];
  const matches = (value) => allowedPrefixes.some(prefix => value.startsWith(prefix));

  if (origin && !allowedPrefixes.some(prefix => prefix.slice(0, -1) === origin)) {
    return res.status(403).json({ error: 'Cross-site request rejected' });
  }
  if (!origin && referer && !matches(referer)) {
    return res.status(403).json({ error: 'Cross-site request rejected' });
  }
  next();
}

app.use(requireSameOrigin);

function requireSetupLocalAccess(req, res, next) {
  if (isSetupComplete() || isLocalRequest(req)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Setup is only available from localhost until bootstrap completes' });
  }
  res.status(403).send('Setup is only available from localhost until bootstrap completes');
}

// Auth middleware — protect everything except /login, /setup, and /api/auth/*
function requireAuth(req, res, next) {
  // Always allow login and setup pages
  if (req.path === '/login' || req.path === '/login.html') return next();
  if (req.path === '/setup' || req.path === '/setup.html') {
    if (!isSetupComplete()) return requireSetupLocalAccess(req, res, next);
    return res.redirect('/login');
  }
  // Setup APIs — localhost-only pre-bootstrap, auth-protected afterwards
  if (req.path.startsWith('/api/setup/')) {
    if (!isSetupComplete()) return requireSetupLocalAccess(req, res, next);
    // After setup, treat like normal API (fall through to auth check below)
  }
  // Setup wizard — redirect everything if setup not complete
  if (!isSetupComplete()) {
    if (req.path.startsWith('/api/')) return res.status(503).json({ error: 'Setup required', redirect: '/setup' });
    return res.redirect('/setup');
  }
  if (req.session && req.session.authenticated) return next();
  // API routes return 401 JSON
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized', redirect: '/login' });
  // Page routes redirect to login
  res.redirect('/login?next=' + encodeURIComponent(req.path));
}

// GET /login
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/');
  res.sendFile('login.html', { root: path.join(__dirname, 'public') });
});

// POST /login
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const cfg = getAuthConfig();
  if (username === cfg.username && bcrypt.compareSync(password, cfg.passwordHash)) {
    req.session.authenticated = true;
    req.session.username = username;
    const nextPath = safeRedirectPath(req.body?.next || req.query.next || '/');
    return res.redirect(nextPath);
  }
  const retryTarget = safeRedirectPath(req.body?.next || req.query.next || '/');
  res.redirect('/login?error=1&next=' + encodeURIComponent(retryTarget));
});

// POST /logout
app.post('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// POST /api/auth/change-password
app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const cfg = getAuthConfig();
  if (!bcrypt.compareSync(currentPassword, cfg.passwordHash)) {
    return res.json({ error: 'Current password incorrect' });
  }
  if (!newPassword || newPassword.length < 8) return res.json({ error: 'New password must be at least 8 characters' });
  cfg.passwordHash = bcrypt.hashSync(newPassword, 10);
  fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  res.json({ ok: true });
});

// ARC website bypass — serve arc.net.pk WITHOUT auth (public site)
const ARC_SITE = path.join(getWorkspace(), 'arc-consultancy');
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
const publicWriteWindowMs = 60 * 1000;
const publicWriteLimit = new Map();

function consumePublicWriteBudget(key, limit) {
  const now = Date.now();
  const current = publicWriteLimit.get(key);
  if (!current || current.resetAt <= now) {
    publicWriteLimit.set(key, { count: 1, resetAt: now + publicWriteWindowMs });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function sanitizePublicLogValue(value, maxLength = 500) {
  return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength);
}

app.post('/api/mobile-log', async (req, res) => {
  const remoteKey = 'mobile-log:' + (req.ip || 'unknown');
  if (!consumePublicWriteBudget(remoteKey, 60)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  const safeBody = {};
  for (const [key, value] of Object.entries(req.body || {})) {
    safeBody[sanitizePublicLogValue(key, 64)] = sanitizePublicLogValue(value, 1000);
  }
  const entry = `[${new Date().toISOString()}] ${JSON.stringify(safeBody)}\n`;
  try {
    await fs.promises.appendFile(path.join(getWorkspace(), 'tradeiators/mobile-debug.log'), entry, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ARC contact form (before auth — public)
app.post('/api/contact', async (req, res) => {
  const remoteKey = 'contact:' + (req.ip || 'unknown');
  if (!consumePublicWriteBudget(remoteKey, 12)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  const { name, email, company, service, message } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  const entry = `[${new Date().toISOString()}] NAME: ${sanitizePublicLogValue(name)} | EMAIL: ${sanitizePublicLogValue(email)} | COMPANY: ${sanitizePublicLogValue(company || 'N/A')} | SERVICE: ${sanitizePublicLogValue(service)} | MSG: ${sanitizePublicLogValue(message, 4000)}\n`;
  try {
    await fs.promises.appendFile(path.join(getWorkspace(), 'arc-consultancy/inquiries.log'), entry, 'utf8');
    console.log('[ARC Contact]', entry.trim());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Apply auth to ALL subsequent routes (login/logout above are exempt, ARC above is exempt)
app.use(requireAuth);

let neuralGraphCache = {};
let neuralDb;
function getNeuralDb() {
  if (!neuralDb) {
    if (!fs.existsSync(NEURAL_DB_PATH)) return null;
    try {
      neuralDb = new Database(NEURAL_DB_PATH, { readonly: true });
    } catch (e) {
      console.error('[neural] Failed to open DB:', e.message);
      return null;
    }
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
function runCommand(command, args = [], opts = {}) {
  try {
    const stdout = execFileSync(command, args, {
      timeout: opts.timeout || 5000,
      encoding: 'utf8',
      input: opts.input,
      cwd: opts.cwd
    });
    return { ok: true, stdout: String(stdout || '').trim(), stderr: '' };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || '').trim(),
      error
    };
  }
}
function requireCommandOutput(command, args = [], opts = {}) {
  const result = runCommand(command, args, opts);
  if (!result.ok) throw new Error(result.stderr || result.stdout || result.error?.message || `${command} failed`);
  return result.stdout;
}
function readFile(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}
function fileAge(p) {
  try { return Date.now() - fs.statSync(p).mtimeMs; } catch { return null; }
}

function sanitizeEnvValue(value, maxLength = 4096) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength);
}

function serializeEnvValue(value) {
  const sanitized = sanitizeEnvValue(value);
  return `"${sanitized.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function readOpenClawConfig() {
  const candidates = [
    path.join(getOpenClawHome(), 'config.json'),
    path.join(getOpenClawHome(), 'openclaw.json')
  ];
  for (const cfgPath of candidates) {
    try {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch {
      // keep trying
    }
  }
  return null;
}

function getConfiguredProviderKeys() {
  const cfg = readOpenClawConfig() || {};
  const providers = cfg.providers || cfg.llm || {};
  return {
    anthropic: process.env.ANTHROPIC_API_KEY || providers.anthropic?.apiKey || cfg.anthropicApiKey || '',
    openrouter: process.env.OPENROUTER_API_KEY || providers.openrouter?.apiKey || cfg.openrouterApiKey || '',
    openai: process.env.OPENAI_API_KEY || providers.openai?.apiKey || cfg.openaiApiKey || ''
  };
}

function isTextFileExt(ext) {
  return ['.md', '.txt', '.json', '.yml', '.yaml', '.toml', '.sh', '.js', '.mjs', '.cjs', '.py', '.ts', '.tsx', '.jsx', '.css', '.html'].includes(ext.toLowerCase());
}

function getWorkspaceRootRealPath() {
  const workspace = getWorkspace();
  if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });
  return fs.realpathSync(workspace);
}

function resolveWorkspacePath(relPath, options = {}) {
  const relativePath = String(relPath || '');
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new Error('Invalid path');
  }
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/'));
  if (normalized.startsWith('../') || normalized === '..') throw new Error('Invalid path');

  const workspaceRoot = getWorkspaceRootRealPath();
  const candidate = path.resolve(workspaceRoot, normalized);
  let targetPath;
  if (options.allowMissing && !fs.existsSync(candidate)) {
    let parent = path.dirname(candidate);
    while (!fs.existsSync(parent) && parent !== workspaceRoot && parent !== path.dirname(parent)) {
      parent = path.dirname(parent);
    }
    targetPath = fs.realpathSync(parent);
  } else {
    targetPath = fs.realpathSync(candidate);
  }
  if (targetPath !== workspaceRoot && !targetPath.startsWith(workspaceRoot + path.sep)) {
    throw new Error('Path escapes workspace');
  }
  return candidate;
}

function walkWorkspaceFiles() {
  const workspaceRoot = getWorkspaceRootRealPath();
  const results = [];
  const queue = [''];
  const skipNames = new Set(['.git', 'node_modules', '.next', 'dist', 'build']);

  while (queue.length) {
    const relDir = queue.shift();
    const absDir = relDir ? path.join(workspaceRoot, relDir) : workspaceRoot;
    let entries = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (skipNames.has(entry.name)) continue;
      const relPath = relDir ? path.posix.join(relDir, entry.name) : entry.name;
      const absPath = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(relPath);
        continue;
      }
      const ext = path.extname(entry.name);
      if (!isTextFileExt(ext)) continue;
      try {
        const stat = fs.statSync(absPath);
        const category = relPath.startsWith('memory/') ? 'memory' : CORE_FILES.some(f => f.path === relPath) ? 'core' : 'workspace';
        results.push({ name: entry.name, path: relPath, size: stat.size, mtime: stat.mtime.toISOString(), category });
      } catch {
        // skip unreadable files
      }
    }
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function invalidateWorkspaceCaches() {
  cache.del('workspace_files');
  const prefix = 'ws_search_';
  for (const key of Object.keys(cache._s)) {
    if (key.startsWith(prefix)) cache.del(key);
  }
}

function readWorkspaceSearchResults(query) {
  const lowerQuery = query.toLowerCase();
  const results = [];
  const fileCounts = {};

  for (const file of walkWorkspaceFiles()) {
    if (file.size > 500 * 1024) continue;
    let content = '';
    try {
      content = fs.readFileSync(resolveWorkspacePath(file.path), 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    let perFileMatches = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line.toLowerCase().includes(lowerQuery)) continue;
      if (!fileCounts[file.path]) fileCounts[file.path] = 0;
      fileCounts[file.path] += 1;
      perFileMatches += 1;
      results.push({ file: file.path, line: index + 1, text: line.trim().slice(0, 240) });
      if (perFileMatches >= 5 || results.length >= 100) break;
    }
    if (results.length >= 100) break;
  }

  return { results, totalFiles: Object.keys(fileCounts).length, totalMatches: results.length };
}

function validateCronId(id) {
  if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(String(id || ''))) {
    throw new Error('Invalid cron ID');
  }
  return String(id);
}

function validateCronPayload(body, { partial = false } = {}) {
  const payload = body || {};
  const out = {};
  const required = partial ? [] : ['name', 'schedule', 'message'];

  function validateText(key, maxLength, pattern) {
    if (payload[key] == null || payload[key] === '') {
      if (required.includes(key)) throw new Error(`${key} is required`);
      return;
    }
    const value = String(payload[key]).trim();
    if (!value) throw new Error(`${key} is required`);
    if (value.length > maxLength) throw new Error(`${key} is too long`);
    if (pattern && !pattern.test(value)) throw new Error(`Invalid ${key}`);
    out[key] = value;
  }

  validateText('name', 80, /^[\w .:@/+(),-]+$/);
  validateText('description', 200);
  validateText('schedule', 80, /^[A-Za-z0-9*/,\- ]+$/);
  validateText('tz', 64, /^[A-Za-z0-9_+\-/]+$/);
  validateText('model', 160, /^[A-Za-z0-9._:/-]+$/);
  validateText('message', 4000);
  validateText('to', 200, /^[A-Za-z0-9_@+:/.,#\- ]+$/);

  if (payload.timeout != null && payload.timeout !== '') {
    const timeout = parseInt(payload.timeout, 10);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400) throw new Error('Invalid timeout');
    out.timeout = timeout;
  }

  if (payload.channel != null && payload.channel !== '') {
    const channel = String(payload.channel).trim();
    const allowedChannels = new Set(['whatsapp', 'telegram', 'msteams', 'discord']);
    if (!allowedChannels.has(channel)) throw new Error('Invalid channel');
    out.channel = channel;
  }

  if (out.channel && !out.to) throw new Error('Delivery target is required when channel is set');
  if (out.to && !out.channel) throw new Error('Delivery channel is required when target is set');
  if (!partial) {
    out.tz = out.tz || 'UTC';
  }
  return out;
}

function runOpenClawCron(args) {
  return requireCommandOutput('openclaw', ['cron', ...args], { timeout: 10000 });
}

function safeSessionFile(sessionId) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(String(sessionId || ''))) throw new Error('Invalid session ID');
  return path.join(getSessionsDir(), sessionId + '.jsonl');
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
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
  const sessDir = SESSIONS_DIR;
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
  for (const svc of [getServiceName('dashboard'), getServiceName('tunnel'), ...getExtraServices()]) {
    const status = exec(`systemctl is-active ${svc} 2>/dev/null`, 'unknown');
    const since = exec(`systemctl show ${svc} --property=ActiveEnterTimestamp --value 2>/dev/null`);
    services[svc] = { status, since };
  }
  
  // Live: recent git commits in workspace
  const gitLog = exec(`cd ${getWorkspace()} && git log --oneline --since="2 days ago" -10 2>/dev/null`);
  
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

  const sessDir = SESSIONS_DIR;
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
  const cronData = runCommand('openclaw', ['cron', 'list', '--json'], { timeout: 10000 });
  let jobs = [];
  try { jobs = JSON.parse(cronData.stdout || '{}')?.jobs || []; } catch {}
  const result = { jobs };
  cache.set('crons_simple', result, 30000); // cache 30s
  res.json(result);
});

// API: cron CRUD operations
app.post('/api/crons', (req, res) => {
  try {
    const payload = validateCronPayload(req.body);
    const args = ['add', '--name', payload.name, '--schedule', payload.schedule, '--tz', payload.tz, '--message', payload.message];
    if (payload.model) args.push('--model', payload.model);
    if (payload.timeout) args.push('--timeout', String(payload.timeout));
    if (payload.description) args.push('--description', payload.description);
    if (payload.channel && payload.to) args.push('--announce', payload.channel, '--to', payload.to);
    const output = runOpenClawCron(args);
    cache.del('crons_simple');
    cache.del('orch_crons');
    res.json({ ok: true, output });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/crons/:id', (req, res) => {
  try {
    const id = validateCronId(req.params.id);
    const payload = validateCronPayload(req.body, { partial: true });
    const args = ['edit', id];
    if (payload.name) args.push('--name', payload.name);
    if (payload.schedule) args.push('--schedule', payload.schedule);
    if (payload.tz) args.push('--tz', payload.tz);
    if (payload.model) args.push('--model', payload.model);
    if (payload.timeout) args.push('--timeout', String(payload.timeout));
    if (payload.message) args.push('--message', payload.message);
    if (payload.description) args.push('--description', payload.description);
    if (payload.channel && payload.to) args.push('--announce', payload.channel, '--to', payload.to);
    const output = runOpenClawCron(args);
    cache.del('crons_simple');
    cache.del('orch_crons');
    res.json({ ok: true, output });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/crons/:id/enable', (req, res) => {
  try {
    const output = runOpenClawCron(['enable', validateCronId(req.params.id)]);
    cache.del('crons_simple');
    cache.del('orch_crons');
    res.json({ ok: true, output });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/crons/:id/disable', (req, res) => {
  try {
    const output = runOpenClawCron(['disable', validateCronId(req.params.id)]);
    cache.del('crons_simple');
    cache.del('orch_crons');
    res.json({ ok: true, output });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/crons/:id/run', (req, res) => {
  try {
    const output = runOpenClawCron(['run', validateCronId(req.params.id)]);
    res.json({ ok: true, output });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/crons/:id', (req, res) => {
  try {
    const output = runOpenClawCron(['rm', validateCronId(req.params.id), '--yes']);
    cache.del('crons_simple');
    cache.del('orch_crons');
    res.json({ ok: true, output });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
    const sessDir = SESSIONS_DIR;
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
  const sessDir = SESSIONS_DIR;
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
  const sessDir = SESSIONS_DIR;
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
  const sessFile = path.join(SESSIONS_DIR, req.params.id + '.jsonl');
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
  const sessFile = path.join(SESSIONS_DIR, req.params.id + '.jsonl');
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
  
  res.json({ id: req.params.id, messageCount: lines.length, messages: messages.slice(-100) });
});

// API: orchestration - toggle cron job enabled/disabled
app.post('/api/orchestration/cron/toggle', express.json(), (req, res) => {
  const { jobId, enabled } = req.body;
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
  
  try {
    const command = enabled ? 'enable' : 'disable';
    const result = runOpenClawCron([command, validateCronId(jobId)]);
    
    // Get updated job state
    const cronData = runCommand('openclaw', ['cron', 'list', '--json'], { timeout: 10000 });
    let jobs = [];
    try { jobs = JSON.parse(cronData.stdout || '{}')?.jobs || []; } catch {}
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
    const result = runOpenClawCron(['run', validateCronId(jobId)]);
    
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
    if (!/^[a-zA-Z0-9:_-]{4,200}$/.test(sessionKey)) {
      return res.status(400).json({ error: 'Invalid sessionKey' });
    }
    const sessStore = path.join(getSessionsDir(), 'sessions.json');
    let sessIndex = {};
    try { sessIndex = JSON.parse(fs.readFileSync(sessStore, 'utf8')); } catch {}
    
    // Find the session entry
    const entry = sessIndex[sessionKey];
    if (!entry) {
      return res.status(404).json({ error: 'Session not found in store' });
    }
    
    const sessionId = entry.sessionId;
    const stopAttempts = [
      ['sessions', 'kill', sessionKey],
      ['sessions', 'kill', sessionId],
      ['session', 'kill', sessionKey],
      ['session', 'kill', sessionId],
      ['sessions', 'stop', sessionKey],
      ['sessions', 'stop', sessionId]
    ];

    let stopOutput = '';
    let stopped = false;
    let lastError = 'Session termination failed';
    for (const args of stopAttempts) {
      const result = runCommand('openclaw', args, { timeout: 10000 });
      if (result.ok) {
        stopOutput = result.stdout || result.stderr;
        stopped = true;
        break;
      }
      lastError = result.stderr || result.stdout || result.error?.message || lastError;
    }
    if (!stopped) {
      return res.status(500).json({ error: lastError });
    }

    delete sessIndex[sessionKey];
    fs.writeFileSync(sessStore, JSON.stringify(sessIndex, null, 2));

    const sessionFile = safeSessionFile(sessionId);
    if (fs.existsSync(sessionFile)) {
      fs.appendFileSync(sessionFile, JSON.stringify({
        type: 'aborted',
        reason: 'Killed from dashboard',
        timestamp: new Date().toISOString()
      }) + '\n');
    }

    res.json({ ok: true, message: 'Session killed', sessionKey, sessionId, output: stopOutput });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: orchestration - live status from openclaw CLI + session store
app.get('/api/orchestration/live', (req, res) => {
  const hit = cache.get('orch_live');
  if (hit) return res.json(hit);
  // Load sessions index for resolving truncated keys
  const sessStore = path.join(SESSIONS_DIR, 'sessions.json');
  let sessIndex = {};
  try { sessIndex = JSON.parse(fs.readFileSync(sessStore, 'utf8')); } catch {}
  const fullKeys = Object.keys(sessIndex);

  // Parse sessions from CLI output (not JSON - parse the table)
  const raw = exec("openclaw sessions 2>/dev/null", '');
  const items = [];
  
  for (const line of raw.split('\n')) {
    // Match lines like: direct agent:main:subag...id  5m ago  model  tokens  flags
    const match = line.match(/^(\S+)\s+(agent:\S+)\s+(.+?(?:ago|now))\s+(\S+)\s+(.*)/);
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
      const transcriptPath = path.join(SESSIONS_DIR, sessId + '.jsonl');
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
        const transcriptPath = path.join(SESSIONS_DIR, sessId + '.jsonl');
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
  const sessDir = SESSIONS_DIR;
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
    // Read sessions.json directly (reliable from systemd, unlike CLI)
    const sjPath = path.join(getSessionsDir(), 'sessions.json');
    let sessIndex = {};
    try { sessIndex = JSON.parse(fs.readFileSync(sjPath, 'utf8')); } catch {}
    
    let mainSessionStatus = { status: 'unknown', lastActivity: null, description: 'Unknown' };
    
    // Find main session
    const mainKey = Object.keys(sessIndex).find(k => k === 'agent:voice:main' || k === 'agent:main:main');
    if (mainKey) {
      const entry = sessIndex[mainKey];
      const updatedAt = entry.updatedAt;
      const ageMs = updatedAt ? Date.now() - updatedAt : Infinity;
      const model = entry.model || entry.modelProvider || 'unknown';
      const lastActivity = updatedAt ? new Date(updatedAt).toISOString() : null;
      
      if (ageMs < 120000) {
        mainSessionStatus = { status: 'active', lastActivity, description: 'Processing request', ageMs, model };
      } else {
        const idleTime = updatedAt ? new Date(updatedAt).toTimeString().split(' ')[0] : 'unknown';
        mainSessionStatus = { status: 'idle', lastActivity, description: `💤 Idle since ${idleTime} UTC`, ageMs, model };
      }
    }
    
    // Find most recent session across ALL sessions
    let mostRecentKey = null;
    let mostRecentTime = 0;
    for (const [key, val] of Object.entries(sessIndex)) {
      if (val.updatedAt && val.updatedAt > mostRecentTime) {
        mostRecentTime = val.updatedAt;
        mostRecentKey = key;
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
    
    // Count active subagents from sessions.json
    let activeSubagents = 0;
    for (const [key, val] of Object.entries(sessIndex)) {
      if (key.includes(':subagent:') && val.updatedAt && (Date.now() - val.updatedAt) < 120000) {
        activeSubagents++;
      }
    }

    // Enrich main session description with subagent info
    if (activeSubagents > 0 && mainSessionStatus.status === 'active') {
      mainSessionStatus.description = `Processing with ${activeSubagents} active sub-agent${activeSubagents > 1 ? 's' : ''}`;
    }

    // Most recent activity across all sessions
    if (mostRecentKey && mostRecentTime) {
      const recentAgeMs = Date.now() - mostRecentTime;
      if (recentAgeMs < 60000) {
        if (mostRecentKey.includes('whatsapp')) systemActivity = '📱 Processing WhatsApp activity';
        else if (mostRecentKey.includes('cron:')) systemActivity = '⏰ Cron job activity';
        else if (mostRecentKey.includes('subagent:')) systemActivity = '🤖 Sub-agent activity';
        else systemActivity = '⚡ Recent system activity';
      } else {
        systemActivity = `Last activity: ${Math.floor(recentAgeMs / 60000)}m ago`;
      }
    }

    const result = {
      mainSession: mainSessionStatus,
      systemActivity,
      activeSubagents,
      activeSessions: Object.keys(sessIndex).length,
      mostRecentSession: mostRecentKey,
      mostRecentAt: mostRecentTime ? new Date(mostRecentTime).toISOString() : null,
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
    const orKey = getConfiguredProviderKeys().openrouter;
    if (!orKey) return res.json({ models: [], balance: null, count: 0, error: 'OpenRouter API key not configured' });

    const modelsResp = await fetchJsonWithTimeout('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${orKey}` }
    }, 8000);
    const models = modelsResp.data?.data || [];

    let balance = null;
    const authResp = await fetchJsonWithTimeout('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${orKey}` }
    }, 8000);
    const creditsResp = await fetchJsonWithTimeout('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${orKey}` }
    }, 8000);
    if (typeof creditsResp.data?.data?.total_credits === 'number') {
      balance = creditsResp.data.data.total_credits - (creditsResp.data.data.total_usage || 0);
    } else if (authResp.data?.data?.usage != null) {
      balance = { usage: authResp.data.data.usage, note: 'usage_only' };
    }

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
      SESSIONS_DIR,
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
      SESSIONS_DIR,
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

  const keys = getConfiguredProviderKeys();
  const checkProvider = async (name, fn) => {
    const start = Date.now();
    try {
      const result = await fn();
      return { ...result, latencyMs: Date.now() - start };
    } catch (error) {
      return { status: 'down', latencyMs: Date.now() - start, error: error.message };
    }
  };

  const [anthropic, openrouter, ollama, openaiCodex] = await Promise.all([
    checkProvider('anthropic', async () => {
      if (!keys.anthropic) return { status: 'config_error', error: 'Missing API key' };
      const { response } = await fetchJsonWithTimeout('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': keys.anthropic, 'anthropic-version': '2023-06-01' }
      }, 5000);
      if (response.status === 401 || response.status === 403) return { status: 'config_error', error: 'Authentication failed' };
      if (!response.ok) return { status: 'down', error: `HTTP ${response.status}` };
      return { status: 'ok' };
    }),
    checkProvider('openrouter', async () => {
      if (!keys.openrouter) return { status: 'config_error', error: 'Missing API key' };
      const { response, data } = await fetchJsonWithTimeout('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${keys.openrouter}` }
      }, 5000);
      if (response.status === 401 || response.status === 403) return { status: 'config_error', error: 'Authentication failed' };
      if (!response.ok || !data?.data) return { status: 'down', error: `HTTP ${response.status}` };
      return { status: 'ok', balance: data.data.usage != null ? data.data : undefined };
    }),
    checkProvider('ollama', async () => {
      const { response, data } = await fetchJsonWithTimeout('http://localhost:11434/api/tags', {}, 3000);
      if (!response.ok) return { status: 'down', error: `HTTP ${response.status}` };
      return { status: 'ok', models: (data?.models || []).length };
    }),
    checkProvider('openai-codex', async () => {
      if (!keys.openai) return { status: 'config_error', error: 'Missing API key' };
      const { response } = await fetchJsonWithTimeout('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${keys.openai}` }
      }, 5000);
      if (response.status === 401 || response.status === 403) return { status: 'config_error', error: 'Authentication failed' };
      if (!response.ok) return { status: 'down', error: `HTTP ${response.status}` };
      return { status: 'ok' };
    })
  ]);

  const result = { anthropic, openrouter, ollama, 'openai-codex': openaiCodex, checkedAt: new Date().toISOString() };
  healthCache = { data: result, ts: Date.now() };
  res.json(result);
});

// API: log tail
app.get('/api/logs/tail', (req, res) => {
  const lines = Math.min(Math.max(parseInt(req.query.lines) || 50, 1), 500);
  const service = req.query.service || 'openclaw';
  const allowedServices = getAllowedServices();
  if (!allowedServices.includes(service)) {
    return res.status(400).json({ error: 'Invalid service', allowed: allowedServices });
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
  const allowedServices = getAllowedServices();
  for (const svc of allowedServices) {
    // `systemctl show` always exits 0; ActiveState is always readable
    const state = exec(`systemctl show ${svc} --property=ActiveState --value 2>/dev/null`, 'unknown').trim();
    svcs[svc] = state || 'unknown';
  }
  const result = { services: svcs, allowed: allowedServices, checkedAt: new Date().toISOString() };
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
    if (!db) return res.json({ fibers: [], neurons: [], synapses: [], unavailable: true });

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
        (SELECT COUNT(*) FROM fibers) AS fibers,
        (SELECT COUNT(*) FROM neurons WHERE type = 'concept') AS concepts
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
    if (!db) return res.json({ neurons: 0, synapses: 0, fibers: 0, topConcepts: [], lastTrained: null, unavailable: true });
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
      concepts: counts.concepts,
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

    const output = requireCommandOutput('nmem', ['recall', q], { timeout: 8000 });

    res.json({ query: q, result: output });
  } catch (e) {
    res.status(500).json({ error: e.message, query: String(req.query.q || '') });
  }
});

// API: sessions hourly activity heatmap (last 7 days, bucketed by hour 0-23)
app.get('/api/sessions/hourly', (req, res) => {
  const hit = cache.get('sessions_hourly');
  if (hit) return res.json(hit);

  try {
    const sessDir = SESSIONS_DIR;
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
    const sessDir = SESSIONS_DIR;
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
    const sessionsRaw = exec("openclaw sessions 2>/dev/null", '');
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
  const result = { files: walkWorkspaceFiles() };
  cache.set('workspace_files', result, 10000);
  res.json(result);
});

app.get('/api/workspace/file', (req, res) => {
  const relPath = req.query.path;
  let abs;
  let stat;
  try {
    abs = resolveWorkspacePath(relPath);
    stat = fs.statSync(abs);
  } catch (e) {
    return res.status(404).json({ error: e.message === 'Invalid path' ? e.message : 'File not found' });
  }
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

  const cacheKey = 'ws_search_' + query.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const matches = readWorkspaceSearchResults(query);
    const out = { query, ...matches };
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
  const tunnelId = sanitizeEnvValue(process.env.TUNNEL_ID || '', 128) || null;
  const arcUrl = sanitizeEnvValue(process.env.ARC_PUBLIC_URL || '', 512) || null;
  const dashboardUrl = sanitizeEnvValue(process.env.DASHBOARD_PUBLIC_URL || '', 512) || null;
  const tunnelActive = exec(`systemctl show ${getServiceName('tunnel')} --property=ActiveState --value 2>/dev/null`, 'unknown').trim();
  const port = getDashboardPort();
  const portListening = runCommand('ss', ['-ltn'], { timeout: 3000 }).stdout.split('\n').some(line => line.includes(`:${port} `));

  const checkUrl = (url) => {
    if (!url) return null;
    const start = Date.now();
    try {
      const raw = exec(`curl -s -o /dev/null -w "%{http_code}" -m 4 ${JSON.stringify(url)} 2>/dev/null`, '0');
      return { url, httpStatus: parseInt(raw, 10) || 0, latencyMs: Date.now() - start };
    } catch {
      return { url, httpStatus: 0, latencyMs: Date.now() - start };
    }
  };

  const result = {
    tunnel: { active: tunnelActive, configured: Boolean(getServiceName('tunnel')) },
    port: { listening: portListening, port },
    arc: checkUrl(arcUrl),
    dashboard: checkUrl(dashboardUrl),
    tunnelId,
    checkedAt: new Date().toISOString()
  };
  cache.set('network_status', result, 30000);
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

  const du = (target) => {
    const result = runCommand('du', ['-sh', target], { timeout: 5000 });
    return result.ok ? (result.stdout.split(/\s+/)[0] || '?') : '?';
  };
  const diskWorkspace = du(getWorkspace());
  const diskSessions = du(getSessionsDir());
  const diskNeural = du(path.join(os.homedir(), '.neuralmemory'));
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


// ══════════════════════════════════════════════════════════════════════════
// === Setup Wizard API =====================================================
// ══════════════════════════════════════════════════════════════════════════

// GET /api/setup/detect — auto-detect OpenClaw installation
app.get('/api/setup/detect', (req, res) => {
  const results = { openclawHome: null, agents: [], services: {}, installed: [], enabledFeatures: [] };

  // Detect OpenClaw home
  const candidates = [
    path.resolve(os.homedir(), '.openclaw'),
    '/root/.openclaw',
    '/home/ubuntu/.openclaw'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { results.openclawHome = c; break; }
  }

  // Detect agents
  if (results.openclawHome) {
    const agentsDir = path.join(results.openclawHome, 'agents');
    try {
      const dirs = fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && fs.existsSync(path.join(agentsDir, d.name, 'sessions')))
        .map(d => d.name);
      results.agents = dirs;
    } catch {}
  }

  // Detect systemd services
  try {
    const units = execSync('systemctl list-units --type=service --all --no-legend 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    const svcNames = units.split('\n').map(l => l.trim().split(/\s+/)[0]).filter(Boolean);

    // Find dashboard service
    const dashSvc = svcNames.find(s => s.includes('dashboard') && s.includes('openclaw'))
      || svcNames.find(s => s.includes('dashboard') && s.includes('claw'))
      || svcNames.find(s => s.includes('openclaw-dashboard'));
    if (dashSvc) results.services.dashboard = dashSvc.replace('.service', '');

    // Find tunnel service
    const tunnelSvc = svcNames.find(s => s.includes('cloudflared'));
    if (tunnelSvc) results.services.tunnel = tunnelSvc.replace('.service', '');

    // Find extra services
    const extras = [];
    for (const name of ['searxng', 'ollama']) {
      if (svcNames.find(s => s.includes(name))) extras.push(name);
    }
    if (extras.length) results.services.extra = extras.join(',');
  } catch {}

  // Detect installed tools
  try { execSync('which nmem 2>/dev/null'); results.installed.push('neural'); } catch {}
  try { execSync('which himalaya 2>/dev/null'); results.installed.push('mail'); } catch {}
  try { execSync('which gh 2>/dev/null'); results.installed.push('github'); } catch {}
  try { execSync('which cloudflared 2>/dev/null'); results.installed.push('tunnel'); } catch {}
  try { execSync('which ollama 2>/dev/null'); results.installed.push('ollama'); } catch {}

  // Detect existing API keys from OpenClaw config
  results.keys = {};
  if (results.openclawHome) {
    try {
      const previousHome = process.env.OPENCLAW_HOME;
      process.env.OPENCLAW_HOME = results.openclawHome;
      const providerKeys = getConfiguredProviderKeys();
      if (providerKeys.anthropic) results.keys.anthropic = { detected: true, masked: '••••' + providerKeys.anthropic.slice(-6) };
      if (providerKeys.openrouter) results.keys.openrouter = { detected: true, masked: '••••' + providerKeys.openrouter.slice(-6) };
      if (providerKeys.openai) results.keys.openai = { detected: true, masked: '••••' + providerKeys.openai.slice(-6) };
      if (previousHome === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = previousHome;
    } catch {}
  }

  try {
    const dashboardConfig = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'dashboard-config.json'), 'utf8'));
    results.enabledFeatures = Array.isArray(dashboardConfig.features) ? dashboardConfig.features : [];
  } catch {}

  res.json(results);
});

// POST /api/setup/validate — validate API keys
app.post('/api/setup/validate', express.json(), async (req, res) => {
  const { provider, key } = req.body || {};
  if (!provider || !key) return res.json({ valid: false, error: 'Missing provider or key' });

  try {
    const https = require('https');
    const http = require('http');
    let valid = false;

    if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
      });
      valid = r.status !== 401 && r.status !== 403;
    } else if (provider === 'openrouter') {
      const r = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { 'Authorization': 'Bearer ' + key }
      });
      const data = await r.json();
      valid = !!data.data;
    } else if (provider === 'openai') {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': 'Bearer ' + key }
      });
      valid = r.status === 200;
    }

    res.json({ valid });
  } catch (e) {
    res.json({ valid: false, error: e.message });
  }
});

// ── Settings API (post-setup config management) ────────────────────────
// Helper: read/write .env as key-value pairs
const ENV_PATH = path.join(CONFIG_DIR, '.env');
const MANAGED_ENV_KEYS = [
  'PORT', 'HOST', 'SESSION_SECRET',
  'OPENCLAW_HOME', 'OPENCLAW_WORKSPACE', 'OPENCLAW_AGENT',
  'ENABLED_FEATURES', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY',
  'VIS_DB_HOST', 'VIS_DB_PORT', 'VIS_DB_USER', 'VIS_DB_PASS', 'VIS_DB_NAME',
  'MAIL_IMAP', 'MAIL_ADDR', 'MAIL_PASS',
  'SVC_DASHBOARD', 'SVC_TUNNEL', 'SVC_EXTRA',
  'TUNNEL_ID', 'ARC_PUBLIC_URL', 'DASHBOARD_PUBLIC_URL'
];
function readEnvFile() {
  try {
    return dotenv.parse(fs.readFileSync(ENV_PATH, 'utf8'));
  } catch { return {}; }
}

function writeEnvFile(env) {
  const lines = [];
  for (const [key, val] of Object.entries(env)) {
    if (val !== undefined && val !== null && val !== '') lines.push(`${key}=${serializeEnvValue(val)}`);
  }
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n');
  for (const key of MANAGED_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key) && env[key] !== '' && env[key] != null) {
      process.env[key] = sanitizeEnvValue(env[key]);
    } else {
      delete process.env[key];
    }
  }
}

// POST /api/settings/keys — update API keys
app.post('/api/settings/keys', express.json(), requireAuth, (req, res) => {
  try {
    const env = readEnvFile();
    const { anthropic, openrouter, openai } = req.body || {};
    env.ANTHROPIC_API_KEY = sanitizeEnvValue(anthropic);
    env.OPENROUTER_API_KEY = sanitizeEnvValue(openrouter);
    env.OPENAI_API_KEY = sanitizeEnvValue(openai);
    writeEnvFile(env);
    res.json({ ok: true });
  } catch (e) { res.json({ error: e.message }); }
});

// POST /api/settings/general — update paths and service names
app.post('/api/settings/general', express.json(), requireAuth, (req, res) => {
  try {
    const env = readEnvFile();
    const { openclawHome, agentName, svcDashboard, svcTunnel, svcExtra } = req.body || {};
    const home = sanitizeEnvValue(openclawHome, 1024);
    env.OPENCLAW_HOME = home;
    env.OPENCLAW_WORKSPACE = home ? path.join(home, 'workspace') : '';
    env.OPENCLAW_AGENT = sanitizeEnvValue(agentName, 128);
    env.SVC_DASHBOARD = sanitizeEnvValue(svcDashboard, 128);
    env.SVC_TUNNEL = sanitizeEnvValue(svcTunnel, 128);
    env.SVC_EXTRA = sanitizeEnvValue(svcExtra, 256);
    writeEnvFile(env);
    res.json({ ok: true, restart: true });
  } catch (e) { res.json({ error: e.message }); }
});

// POST /api/settings/features — update enabled features + install
app.post('/api/settings/features', express.json(), requireAuth, (req, res) => {
  try {
    const { features = [] } = req.body || {};
    const env = readEnvFile();
    env.ENABLED_FEATURES = ['dashboard', 'costs', ...features].join(',');
    writeEnvFile(env);

    // Update dashboard config
    const configDir = CONFIG_DIR;
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    const dashConfigPath = path.join(configDir, 'dashboard-config.json');
    let dashConfig = {};
    try { dashConfig = JSON.parse(fs.readFileSync(dashConfigPath, 'utf8')); } catch {}
    dashConfig.features = features;
    fs.writeFileSync(dashConfigPath, JSON.stringify(dashConfig, null, 2));

    res.json({ ok: true, features });
  } catch (e) { res.json({ error: e.message }); }
});

// POST /api/setup/save — save configuration
app.post('/api/setup/save', express.json(), (req, res) => {
  const config = req.body;
  if (!config) return res.json({ error: 'No config provided' });
  if (!config.adminPass || config.adminPass.length < 8) return res.json({ error: 'Password must be at least 8 characters' });

  try {
    // Write auth config
    const configDir = CONFIG_DIR;
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

    const authConfig = {
      username: config.adminUser || 'admin',
      passwordHash: bcrypt.hashSync(config.adminPass, 10)
    };
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(authConfig, null, 2));

    const selectedFeatures = Array.isArray(config.features) ? config.features.map(f => sanitizeEnvValue(f, 64)).filter(Boolean) : [];
    const env = readEnvFile();
    env.PORT = String(parseInt(config.port, 10) || 3000);
    env.HOST = sanitizeEnvValue(config.host || process.env.HOST || '0.0.0.0', 128);
    env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    env.OPENCLAW_HOME = sanitizeEnvValue(config.openclawHome, 1024);
    env.OPENCLAW_WORKSPACE = env.OPENCLAW_HOME ? path.join(env.OPENCLAW_HOME, 'workspace') : '';
    env.OPENCLAW_AGENT = sanitizeEnvValue(config.agentName || 'voice', 128);
    env.ENABLED_FEATURES = ['dashboard', 'costs', ...selectedFeatures].join(',');
    env.ANTHROPIC_API_KEY = sanitizeEnvValue(config.keys?.anthropic);
    env.OPENROUTER_API_KEY = sanitizeEnvValue(config.keys?.openrouter);
    env.OPENAI_API_KEY = sanitizeEnvValue(config.keys?.openai);
    env.VIS_DB_HOST = selectedFeatures.includes('vis') ? sanitizeEnvValue(config.vis?.host, 256) : '';
    env.VIS_DB_PORT = selectedFeatures.includes('vis') ? sanitizeEnvValue(config.vis?.port || 1433, 16) : '';
    env.VIS_DB_USER = selectedFeatures.includes('vis') ? sanitizeEnvValue(config.vis?.user, 256) : '';
    env.VIS_DB_PASS = selectedFeatures.includes('vis') ? sanitizeEnvValue(config.vis?.pass, 512) : '';
    env.VIS_DB_NAME = selectedFeatures.includes('vis') ? sanitizeEnvValue(config.vis?.db, 256) : '';
    env.MAIL_IMAP = selectedFeatures.includes('mail') ? sanitizeEnvValue(config.mail?.imap, 256) : '';
    env.MAIL_ADDR = selectedFeatures.includes('mail') ? sanitizeEnvValue(config.mail?.addr, 256) : '';
    env.MAIL_PASS = selectedFeatures.includes('mail') ? sanitizeEnvValue(config.mail?.pass, 512) : '';
    env.SVC_DASHBOARD = sanitizeEnvValue(config.services?.dashboard, 128);
    env.SVC_TUNNEL = sanitizeEnvValue(config.services?.tunnel, 128);
    env.SVC_EXTRA = sanitizeEnvValue(config.services?.extra, 256);

    // Write dashboard config (features + non-secret settings)
    const dashConfig = {
      features: selectedFeatures,
      setupComplete: true,
      setupDate: new Date().toISOString()
    };
    fs.writeFileSync(path.join(configDir, 'dashboard-config.json'), JSON.stringify(dashConfig, null, 2));

    writeEnvFile(env);
    res.json({ ok: true, restart: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// POST /api/setup/install — install optional dependencies
app.post('/api/setup/install', express.json(), (req, res) => {
  const { features = [], openclawHome } = req.body || {};
  const selectedFeatures = Array.isArray(features) ? features.filter(f => ['neural', 'mail', 'github', 'vis', 'tunnel', 'ollama'].includes(f)) : [];
  const steps = [];
  const safeOpenclawHome = openclawHome ? path.resolve(String(openclawHome)) : '';

  for (const feat of selectedFeatures) {
    if (feat === 'neural') {
      // Install neural-memory
      try {
        requireCommandOutput('which', ['nmem']);
        steps.push({ ok: true, message: 'nmem already installed' });
      } catch {
        try {
          requireCommandOutput('pip', ['install', 'neural-memory'], { timeout: 120000 });
          steps.push({ ok: true, message: 'neural-memory installed via pip' });
        } catch (e) {
          steps.push({ ok: false, message: 'Failed to install neural-memory: ' + e.message.substring(0, 200) });
          continue;
        }
      }

      // Init nmem if needed
      const neuralDir = path.resolve(os.homedir(), '.neuralmemory');
      if (!fs.existsSync(path.join(neuralDir, 'brains', 'default.db'))) {
        try {
          requireCommandOutput('nmem', ['init'], { timeout: 30000 });
          steps.push({ ok: true, message: 'nmem initialized' });
        } catch (e) {
          steps.push({ ok: false, message: 'nmem init failed: ' + e.message.substring(0, 200) });
        }
      }

      // Train if workspace exists
      if (safeOpenclawHome) {
        const workspace = path.join(safeOpenclawHome, 'workspace');
        const memoryDir = path.join(workspace, 'memory');
        const memoryMd = path.join(workspace, 'MEMORY.md');
        const args = ['train'];
        if (fs.existsSync(memoryDir)) args.push('--source', memoryDir);
        if (fs.existsSync(memoryMd)) args.push('--source', memoryMd);
        if (args.length > 1) {
          try {
            requireCommandOutput('nmem', args, { timeout: 300000 });
            steps.push({ ok: true, message: 'nmem trained on workspace memory' });
          } catch (e) {
            steps.push({ ok: false, message: 'nmem train failed (non-critical): ' + e.message.substring(0, 200) });
          }
        }
      }

      // Set up cron
      try {
        const sources = [];
        if (safeOpenclawHome) {
          sources.push('--source', path.join(safeOpenclawHome, 'workspace', 'memory'));
          sources.push('--source', path.join(safeOpenclawHome, 'workspace', 'MEMORY.md'));
        }
        const cronLine = `0 */4 * * * ${['nmem', 'train', ...sources].map(part => String(part).replace(/ /g, '\\ ')).join(' ')} >> /var/log/nmem-train.log 2>&1`;
        const currentCrontab = runCommand('crontab', ['-l'], { timeout: 5000 });
        const existing = currentCrontab.ok ? currentCrontab.stdout : '';
        if (!existing.includes('nmem train')) {
          const nextCrontab = (existing ? existing + '\n' : '') + cronLine + '\n';
          const installResult = spawnSync('crontab', ['-'], { input: nextCrontab, encoding: 'utf8', timeout: 5000 });
          if (installResult.status !== 0) throw new Error(String(installResult.stderr || installResult.stdout || 'crontab failed'));
          steps.push({ ok: true, message: 'nmem 4-hour cron job added' });
        } else {
          steps.push({ ok: true, message: 'nmem cron already configured' });
        }
      } catch (e) {
        steps.push({ ok: false, message: 'Failed to set up nmem cron: ' + e.message.substring(0, 100) });
      }
    }

    if (feat === 'mail') {
      try {
        requireCommandOutput('which', ['himalaya']);
        steps.push({ ok: true, message: 'himalaya CLI already installed' });
      } catch {
        steps.push({ ok: false, message: 'himalaya not found — install manually: cargo install himalaya' });
      }
    }

    if (feat === 'github') {
      try {
        requireCommandOutput('which', ['gh']);
        const authStatus = runCommand('gh', ['auth', 'status'], { timeout: 10000 });
        const statusText = authStatus.stdout || authStatus.stderr;
        if (statusText.includes('Logged in')) {
          steps.push({ ok: true, message: 'gh CLI authenticated' });
        } else {
          steps.push({ ok: false, message: 'gh CLI installed but not authenticated — run: gh auth login' });
        }
      } catch {
        steps.push({ ok: false, message: 'gh CLI not found — install: https://cli.github.com' });
      }
    }
  }

  res.json({ steps });
});

// GET /api/setup/health — post-setup health check
app.get('/api/setup/health', (req, res) => {
  const checks = [];

  // OpenClaw process
  try {
    const pid = execSync('pgrep -f "openclaw" 2>/dev/null || true', { encoding: 'utf8' }).trim();
    checks.push({
      name: 'OpenClaw Process',
      status: pid ? 'ok' : 'warn',
      detail: pid ? `PID ${pid.split('\n')[0]}` : 'Not detected'
    });
  } catch { checks.push({ name: 'OpenClaw Process', status: 'error', detail: 'Check failed' }); }

  // Session directory — use env var (may have been updated by setup/save)
  const currentHome = process.env.OPENCLAW_HOME || getOpenClawHome();
  const currentAgent = process.env.OPENCLAW_AGENT || getAgentName();
  const sessDir = path.join(currentHome, 'agents', currentAgent, 'sessions');
  checks.push({
    name: 'Session Directory',
    status: fs.existsSync(sessDir) ? 'ok' : 'error',
    detail: fs.existsSync(sessDir) ? sessDir : 'Not found: ' + sessDir
  });

  // Workspace
  const currentWorkspace = process.env.OPENCLAW_WORKSPACE || getWorkspace();
  checks.push({
    name: 'Workspace',
    status: fs.existsSync(currentWorkspace) ? 'ok' : 'error',
    detail: fs.existsSync(currentWorkspace) ? currentWorkspace : 'Not found'
  });

  // Neural memory
  const neuralPath = path.resolve(os.homedir(), '.neuralmemory/brains/default.db');
  try {
    execSync('which nmem 2>/dev/null');
    checks.push({
      name: 'Neural Memory',
      status: fs.existsSync(neuralPath) ? 'ok' : 'warn',
      detail: fs.existsSync(neuralPath) ? 'Trained & ready' : 'Installed but not trained'
    });
  } catch {
    checks.push({ name: 'Neural Memory', status: 'warn', detail: 'Not installed (optional)' });
  }

  // Disk space
  try {
    const df = execSync("df -h / | tail -1 | awk '{print $5}'", { encoding: 'utf8' }).trim();
    const pct = parseInt(df);
    checks.push({
      name: 'Disk Usage',
      status: pct > 90 ? 'error' : pct > 75 ? 'warn' : 'ok',
      detail: df + ' used'
    });
  } catch { checks.push({ name: 'Disk Usage', status: 'warn', detail: 'Could not check' }); }

  // Memory
  try {
    const memInfo = execSync("free -m | awk 'NR==2{printf \"%d/%dMB (%.0f%%)\", $3,$2,$3*100/$2}'", { encoding: 'utf8' }).trim();
    const pct = parseInt(memInfo.match(/\((\d+)%\)/)?.[1] || '0');
    checks.push({
      name: 'Memory',
      status: pct > 90 ? 'error' : pct > 75 ? 'warn' : 'ok',
      detail: memInfo
    });
  } catch { checks.push({ name: 'Memory', status: 'warn', detail: 'Could not check' }); }

  // Config files
  checks.push({
    name: 'Dashboard Config',
    status: isSetupComplete() ? 'ok' : 'error',
    detail: isSetupComplete() ? 'Configured' : 'Not configured'
  });

  res.json({ checks });
});

// GET /setup — serve setup wizard
app.get('/setup', (req, res) => {
  if (isSetupComplete()) return res.redirect('/login');
  res.sendFile('setup.html', { root: path.join(__dirname, 'public') });
});

// ── Live Session Viewer APIs ──────────────────────────────────────────
// GET /api/live/sessions — list all sessions from sessions.json
app.get('/api/live/sessions', requireAuth, (req, res) => {
  try {
    const sjPath = path.join(getSessionsDir(), 'sessions.json');
    const data = JSON.parse(fs.readFileSync(sjPath, 'utf8'));
    // Try to load group names from OpenClaw config or contacts
    let groupNames = {};
    try {
      const contactsPath = path.join(getOpenClawHome(), 'contacts.json');
      if (fs.existsSync(contactsPath)) {
        const contacts = JSON.parse(fs.readFileSync(contactsPath, 'utf8'));
        if (contacts.groups) for (const [id, info] of Object.entries(contacts.groups)) { groupNames[id] = info.name || info.subject; }
      }
    } catch {}

    const sessions = Object.entries(data).map(([key, val]) => {
      const origin = val.origin || {};
      // Resolve friendly name
      let friendlyName = null;
      if (key.includes(':direct:')) {
        const phone = key.split(':direct:')[1];
        friendlyName = phone;
      } else if (key.includes(':group:')) {
        const groupId = key.split(':group:')[1];
        friendlyName = groupNames[groupId] || null;
      } else if (key.endsWith(':main')) {
        friendlyName = 'Main Session';
      } else if (key.includes(':cron:')) {
        friendlyName = 'Cron: ' + key.split(':cron:')[1].substring(0, 8);
      } else if (key.includes(':subagent:')) {
        friendlyName = 'Sub-agent: ' + key.split(':subagent:')[1].substring(0, 12);
      }
      return {
        key,
        sessionId: val.sessionId,
        updatedAt: val.updatedAt ? new Date(val.updatedAt).toISOString() : null,
        updatedAtMs: val.updatedAt || 0,
        chatType: val.chatType || origin.chatType || 'unknown',
        surface: origin.surface || null,
        label: origin.label || null,
        friendlyName,
        model: val.model || null,
        lastTo: val.lastTo || null
      };
    }).sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
    res.json(sessions);
  } catch (e) { res.json([]); }
});

// GET /api/live/session?key=...&limit=100 — read session log
app.get('/api/live/session', requireAuth, (req, res) => {
  try {
    const sjPath = path.join(getSessionsDir(), 'sessions.json');
    const data = JSON.parse(fs.readFileSync(sjPath, 'utf8'));
    const key = req.query.key;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    if (!key || !data[key]) return res.json({ error: 'Session not found' });
    const entry = data[key];
    const logFile = entry.sessionFile;
    if (!logFile || !fs.existsSync(logFile)) return res.json({ error: 'Session log not found', updatedAt: entry.updatedAt ? new Date(entry.updatedAt).toISOString() : null });
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.trim().split('\n');
    const messages = [];
    for (const line of lines.slice(-limit * 2)) { // read more lines than needed, filter later
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'message' || obj.type === 'custom') {
          messages.push({
            type: obj.type,
            role: obj.message ? obj.message.role : obj.type,
            message: obj.message,
            timestamp: obj.timestamp || (obj.message && obj.message.timestamp),
          });
        }
      } catch {}
    }
    res.json({
      key,
      sessionId: entry.sessionId,
      updatedAt: entry.updatedAt ? new Date(entry.updatedAt).toISOString() : null,
      chatType: entry.chatType,
      messages: messages.slice(-limit)
    });
  } catch (e) { res.json({ error: e.message }); }
});

// POST /api/agent/steer — send a message to redirect an agent
app.post('/api/agent/steer', express.json(), requireAuth, (req, res) => {
  const { key, message } = req.body || {};
  if (!key || !message) return res.json({ error: 'Key and message required' });
  // Write steer request to a file that the agent can pick up
  const steerDir = CONFIG_DIR;
  if (!fs.existsSync(steerDir)) fs.mkdirSync(steerDir, { recursive: true });
  const steerFile = path.join(steerDir, 'steer-requests.json');
  let requests = [];
  try { requests = JSON.parse(fs.readFileSync(steerFile, 'utf8')); } catch {}
  requests.push({ key, message, timestamp: new Date().toISOString() });
  fs.writeFileSync(steerFile, JSON.stringify(requests, null, 2));
  res.json({ ok: true });
});

// POST /api/chat/session — send message to a session via gateway tool-call API
app.post('/api/chat/session', requireAuth, async (req, res) => {
  const { key, message } = req.body || {};
  if (!key || !message) return res.status(400).json({ error: 'key and message required' });
  try {
    // Read gateway token from openclaw config
    const ocConfigPath = path.join(getOpenClawHome(), 'openclaw.json');
    let gwToken = '';
    let gwPort = 18789;
    try {
      const ocConfig = JSON.parse(fs.readFileSync(ocConfigPath, 'utf8'));
      gwToken = ocConfig?.gateway?.auth?.token || '';
      gwPort = ocConfig?.gateway?.port || 18789;
    } catch {}

    if (!gwToken) {
      return res.json({ error: 'Gateway token not found in openclaw.json — cannot send to sessions' });
    }

    // Use gateway tool-call API
    const gwUrl = `http://127.0.0.1:${gwPort}/v1/tools/sessions_send`;
    const response = await fetch(gwUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${gwToken}` },
      body: JSON.stringify({ sessionKey: key, message }),
      signal: AbortSignal.timeout(60000)
    });

    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      res.json({ ok: true, response: data.response || data.result || '(message sent to session)' });
    } else {
      const errText = await response.text().catch(() => 'Unknown error');
      // Fallback: steer file
      const steerFile = path.join(CONFIG_DIR, 'steer-requests.json');
      let requests = [];
      try { requests = JSON.parse(fs.readFileSync(steerFile, 'utf8')); } catch {}
      requests.push({ key, message, timestamp: new Date().toISOString() });
      fs.writeFileSync(steerFile, JSON.stringify(requests, null, 2));
      res.json({ ok: true, response: '(message queued for next agent pickup — gateway returned: ' + response.status + ')', fallback: true });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/chat/provider — direct chat with an LLM provider
app.post('/api/chat/provider', requireAuth, async (req, res) => {
  const { model, messages } = req.body || {};
  if (!model || !messages || !messages.length) return res.status(400).json({ error: 'model and messages required' });
  
  try {
    const keys = getConfiguredProviderKeys();
    let apiUrl, headers, body;
    
    if (model.startsWith('anthropic/')) {
      if (!keys.anthropic) return res.json({ error: 'Anthropic API key not configured' });
      apiUrl = 'https://api.anthropic.com/v1/messages';
      headers = { 'Content-Type': 'application/json', 'x-api-key': keys.anthropic, 'anthropic-version': '2023-06-01' };
      body = JSON.stringify({
        model: model.replace('anthropic/', ''),
        max_tokens: 4096,
        messages: messages.map(m => ({ role: m.role, content: m.content }))
      });
    } else if (model.startsWith('openrouter/')) {
      if (!keys.openrouter) return res.json({ error: 'OpenRouter API key not configured' });
      apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
      headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keys.openrouter };
      body = JSON.stringify({
        model: model.replace('openrouter/', ''),
        messages: messages.map(m => ({ role: m.role, content: m.content }))
      });
    } else if (model.startsWith('openai/') || model.startsWith('openai-codex/')) {
      if (!keys.openai) return res.json({ error: 'OpenAI API key not configured' });
      apiUrl = 'https://api.openai.com/v1/chat/completions';
      headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keys.openai };
      body = JSON.stringify({
        model: model.replace(/^openai(-codex)?\//, ''),
        messages: messages.map(m => ({ role: m.role, content: m.content }))
      });
    } else if (model.startsWith('ollama/')) {
      apiUrl = 'http://localhost:11434/api/chat';
      headers = { 'Content-Type': 'application/json' };
      body = JSON.stringify({
        model: model.replace('ollama/', ''),
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: false
      });
    } else {
      return res.json({ error: 'Unknown provider for model: ' + model });
    }
    
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    
    const response = await fetch(apiUrl, { method: 'POST', headers, body, signal: controller.signal });
    clearTimeout(timer);
    
    const data = await response.json();
    
    if (!response.ok) {
      return res.json({ error: data.error?.message || data.error || 'API error: HTTP ' + response.status });
    }
    
    // Extract response text
    let responseText = '';
    if (data.content && Array.isArray(data.content)) {
      // Anthropic format
      responseText = data.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    } else if (data.choices && data.choices[0]) {
      // OpenAI/OpenRouter format
      responseText = data.choices[0].message?.content || '';
    } else if (data.message) {
      // Ollama format
      responseText = data.message.content || '';
    }
    
    res.json({
      response: responseText,
      model: model,
      usage: data.usage || null
    });
  } catch (e) {
    if (e.name === 'AbortError') return res.json({ error: 'Request timed out (120s)' });
    res.status(500).json({ error: e.message });
  }
});

// GET/POST /api/settings/alerts — alert configuration
app.get('/api/settings/alerts', requireAuth, (req, res) => {
  const configPath = path.join(CONFIG_DIR, 'alerts-config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    res.json(config);
  } catch { res.json({}); }
});

app.get('/api/alerts/recent', requireAuth, (req, res) => {
  const configPath = path.join(CONFIG_DIR, 'alerts-config.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}

  const items = [];
  const nowIso = new Date().toISOString();
  const types = config.types || {};

  if (types.budget) {
    const budgetLimit = parseFloat(config.budgetLimit);
    const summary = cache.get('costs_summary');
    if (summary && Number.isFinite(budgetLimit) && budgetLimit > 0 && (summary.totalToday || 0) >= budgetLimit) {
      items.push({ level: 'error', title: 'Daily budget exceeded', detail: `Today: $${(summary.totalToday || 0).toFixed(4)} / $${budgetLimit.toFixed(2)}`, timestamp: nowIso });
    }
  }

  if (types.errors) {
    const threshold = parseInt(config.errorThreshold, 10) || 0;
    const orch = cache.get('orch_sessions');
    if (orch && threshold > 0) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const recentErrors = (orch.sessions || []).filter(s => s.hasError && s.startTime && new Date(s.startTime).getTime() >= cutoff);
      if (recentErrors.length >= threshold) {
        items.push({ level: 'error', title: 'Error threshold exceeded', detail: `${recentErrors.length} failed sessions in the last 24 hours`, timestamp: nowIso });
      }
    }
  }

  if (types.disk) {
    const diskThreshold = parseInt(config.diskThreshold, 10) || 0;
    const df = exec("df -P / | tail -1 | awk '{print $5}'", '0%').replace('%', '');
    const pct = parseInt(df, 10) || 0;
    if (diskThreshold > 0 && pct >= diskThreshold) {
      items.push({ level: pct >= 90 ? 'error' : 'warn', title: 'Disk usage high', detail: `${pct}% used on /`, timestamp: nowIso });
    }
  }

  if (types.offline) {
    const oclawPid = exec("pgrep -f 'openclaw.*gateway' | head -1", '');
    if (!oclawPid) {
      items.push({ level: 'error', title: 'OpenClaw process offline', detail: 'Gateway process was not detected', timestamp: nowIso });
    }
  }

  if (types.channel) {
    const tunnelState = exec(`systemctl show ${getServiceName('tunnel')} --property=ActiveState --value 2>/dev/null`, 'unknown').trim();
    if (tunnelState && tunnelState !== 'active') {
      items.push({ level: 'warn', title: 'Tunnel not active', detail: `Tunnel service state: ${tunnelState}`, timestamp: nowIso });
    }
  }

  res.json({ items });
});

app.post('/api/settings/alerts', express.json(), requireAuth, (req, res) => {
  try {
    const configDir = CONFIG_DIR;
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'alerts-config.json'), JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) { res.json({ error: e.message }); }
});

// POST /api/workspace/file — save file content
app.post('/api/workspace/file', express.json({ limit: '1mb' }), requireAuth, (req, res) => {
  const { path: relPath, content } = req.body || {};
  const allowed = ['.md', '.txt', '.json', '.yml', '.yaml', '.toml', '.sh', '.js', '.py'];
  const ext = path.extname(relPath).toLowerCase();
  if (!allowed.includes(ext)) {
    return res.status(403).json({ error: 'File type not editable' });
  }
  try {
    const abs = resolveWorkspacePath(relPath, { allowMissing: true });
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    const stat = fs.statSync(abs);
    invalidateWorkspaceCaches();
    res.json({ ok: true, path: relPath, size: stat.size, mtime: stat.mtime.toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

const PORT = getDashboardPort();
const HOST = getDashboardHost();
app.listen(PORT, HOST, () => {
  console.log(`🤖 Clawdbot Dashboard running on http://${HOST}:${PORT}`);
  console.log(`🌐 ARC website routing: arc.net.pk → ${ARC_SITE}`);
});

// (duplicate mobile-log route removed — registered before auth at line ~117)
