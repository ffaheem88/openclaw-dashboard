#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const cmd = args[0];

const PKG_DIR = path.resolve(__dirname, '..');
const DASHBOARD_DIR = process.env.OPENCLAW_DASHBOARD_DIR || path.join(process.env.HOME || '/root', '.openclaw', 'dashboard');

function printHelp() {
  console.log(`
🤖 OpenClaw Dashboard v${require('../package.json').version}

Usage:
  openclaw-dashboard <command> [options]

Commands:
  start         Start the dashboard server
  setup         Run first-time setup wizard
  install       Install dashboard to ~/.openclaw/dashboard
  status        Check if dashboard is running
  help          Show this help

Options:
  --port <n>    Port to run on (default: 3000)
  --host <h>    Host to bind (default: 0.0.0.0)

Environment Variables:
  OPENCLAW_HOME        Path to OpenClaw home (default: ~/.openclaw)
  OPENCLAW_WORKSPACE   Path to workspace (default: OPENCLAW_HOME/workspace)
  OPENCLAW_AGENT       Agent name (default: voice)
  PORT                 Server port (default: 3000)
  SESSION_SECRET       Express session secret

Examples:
  openclaw-dashboard start
  openclaw-dashboard start --port 8080
  openclaw-dashboard install
  PORT=8080 openclaw-dashboard start
`);
}

function installDashboard() {
  console.log('📦 Installing OpenClaw Dashboard to', DASHBOARD_DIR);
  
  if (!fs.existsSync(DASHBOARD_DIR)) {
    fs.mkdirSync(DASHBOARD_DIR, { recursive: true });
  }

  // Copy all files
  const filesToCopy = [
    'server.js',
    'package.json',
    '.env.example',
    'README.md',
  ];

  const dirsToCopy = ['public', 'bin'];

  for (const file of filesToCopy) {
    const src = path.join(PKG_DIR, file);
    const dst = path.join(DASHBOARD_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      console.log('  ✓', file);
    }
  }

  for (const dir of dirsToCopy) {
    const srcDir = path.join(PKG_DIR, dir);
    const dstDir = path.join(DASHBOARD_DIR, dir);
    if (fs.existsSync(srcDir)) {
      fs.mkdirSync(dstDir, { recursive: true });
      const files = fs.readdirSync(srcDir);
      for (const f of files) {
        fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
      }
      console.log('  ✓', dir + '/ (' + files.length + ' files)');
    }
  }

  // Create .env if it doesn't exist
  const envPath = path.join(DASHBOARD_DIR, '.env');
  if (!fs.existsSync(envPath)) {
    const exampleEnv = path.join(PKG_DIR, '.env.example');
    if (fs.existsSync(exampleEnv)) {
      fs.copyFileSync(exampleEnv, envPath);
      console.log('  ✓ .env (from example)');
    }
  } else {
    console.log('  ⏭️  .env already exists, skipping');
  }

  // Create config dir
  const configDir = path.join(DASHBOARD_DIR, 'config');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
    console.log('  ✓ config/');
  }

  // Install dependencies
  console.log('\n📥 Installing dependencies...');
  try {
    execSync('npm install --production', { cwd: DASHBOARD_DIR, stdio: 'inherit' });
  } catch (e) {
    console.error('⚠️  npm install failed — run manually in', DASHBOARD_DIR);
  }

  console.log('\n✅ Installed! Start with:');
  console.log('   cd', DASHBOARD_DIR);
  console.log('   node server.js');
  console.log('\nOr: openclaw-dashboard start');
}

function startServer() {
  const portArg = args.indexOf('--port');
  const hostArg = args.indexOf('--host');
  
  if (portArg !== -1 && args[portArg + 1]) {
    process.env.PORT = args[portArg + 1];
  }
  if (hostArg !== -1 && args[hostArg + 1]) {
    process.env.HOST = args[hostArg + 1];
  }

  // Try installed location first, then package dir
  const serverPaths = [
    path.join(DASHBOARD_DIR, 'server.js'),
    path.join(PKG_DIR, 'server.js'),
  ];

  for (const sp of serverPaths) {
    if (fs.existsSync(sp)) {
      process.chdir(path.dirname(sp));
      require(sp);
      return;
    }
  }

  console.error('❌ server.js not found. Run: openclaw-dashboard install');
  process.exit(1);
}

function checkStatus() {
  const http = require('http');
  const port = process.env.PORT || 3000;
  const req = http.get('http://localhost:' + port + '/api/health', (res) => {
    let data = '';
    res.on('data', (d) => data += d);
    res.on('end', () => {
      try {
        const j = JSON.parse(data);
        console.log('✅ Dashboard running on port', port);
        console.log('   Uptime:', j.uptime || 'unknown');
      } catch {
        console.log('✅ Dashboard responding on port', port);
      }
    });
  });
  req.on('error', () => {
    console.log('❌ Dashboard not running on port', port);
  });
  req.setTimeout(3000, () => {
    console.log('❌ Dashboard not responding on port', port);
    req.destroy();
  });
}

switch (cmd) {
  case 'start':
    startServer();
    break;
  case 'setup':
    process.env.FORCE_SETUP = '1';
    startServer();
    break;
  case 'install':
    installDashboard();
    break;
  case 'status':
    checkStatus();
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    printHelp();
    break;
  default:
    console.error('Unknown command:', cmd);
    printHelp();
    process.exit(1);
}
