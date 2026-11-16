import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config, nowIso } from './config.js';
import { getSetupStatus, runSetup, onSetupChange } from './setup.js';
import { supervisor } from './supervisor.js';

const publicDir = path.join(config.projectRoot, 'public');
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

const launcherLogs = [];
const bootStartedAt = nowIso();
let booting = false;
let activityCache = { at: 0, active: false };

function log(line) {
  const entry = nowIso() + ' ' + line;
  launcherLogs.push(entry);
  if (launcherLogs.length > 80) launcherLogs.shift();
  console.log(line);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function statusPayload() {
  return {
    app: 'Codex ondev',
    bootStartedAt,
    setup: getSetupStatus(),
    runtime: supervisor.snapshot(),
    launcher: launcherLogs.slice(-20)
  };
}

async function hasActiveTurns() {
  if (Date.now() - activityCache.at < 5000) return activityCache.active;
  const statuses = ['active', 'pending', 'starting'];
  const results = [];
  for (const status of statuses) {
    results.push(await supervisor.runCli('bb', ['thread', 'count', '--status', status, '--json'], 10000));
  }
  let total = 0;
  let answered = true;
  for (const result of results) {
    if (!result.ok) {
      answered = false;
      continue;
    }
    try {
      total += Number(JSON.parse(result.stdout).total ?? 0);
    } catch {
      answered = false;
    }
  }
  const active = answered ? total > 0 : true;
  activityCache = { at: Date.now(), active };
  return active;
}

function serveStatic(res, pathname, headOnly) {
  const normalized = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(publicDir, normalized));
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  let stat;
  try { stat = fs.statSync(filePath); } catch { stat = null; }
  if (!stat || !stat.isFile()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  res.writeHead(200, {
    'content-type': contentTypes.get(path.extname(filePath)) || 'application/octet-stream',
    'cache-control': 'no-store'
  });
  if (headOnly) {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

async function boot() {
  if (booting) return;
  booting = true;
  try {
    const setup = await runSetup();
    if (setup.failed) {
      log('setup failed: ' + setup.error);
      return;
    }
    log('setup complete, starting runtime');
    await supervisor.start();
  } finally {
    booting = false;
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1:' + config.port);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    sendJson(res, 200, statusPayload());
    return;
  }

  if (url.pathname === '/api/activity' && req.method === 'GET') {
    sendJson(res, 200, { active: await hasActiveTurns() });
    return;
  }

  if (url.pathname === '/api/configure' && req.method === 'POST') {
    try {
      await supervisor.configureBb();
      sendJson(res, 200, { ok: true });
    } catch (error) {
      log('configure failed: ' + error.message);
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (url.pathname === '/api/retry' && req.method === 'POST') {
    log('retry requested');
    const setup = getSetupStatus();
    if (setup.failed || !setup.done) {
      runSetup().then((result) => {
        if (!result.failed) return supervisor.start();
        return null;
      }).catch((error) => log('retry failed: ' + error.message));
    } else {
      supervisor.restart().catch((error) => log('restart failed: ' + error.message));
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/logs' && req.method === 'GET') {
    sendJson(res, 200, statusPayload());
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(res, url.pathname, req.method === 'HEAD');
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
}

onSetupChange(() => { /* status is polled; events are intentionally absent */ });

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => sendJson(res, 500, { error: error.message }));
});

server.on('error', (error) => {
  log('launcher server error: ' + error.message);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  log('launcher listening on http://' + config.host + ':' + config.port);
  boot().catch((error) => log('boot failed: ' + error.message));
});

async function shutdown() {
  try { await supervisor.stop(); } catch { /* ignore */ }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
