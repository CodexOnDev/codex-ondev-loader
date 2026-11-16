import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { config, defaultPath, bbUrl, nowIso } from './config.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeTcp(port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs || 400);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function probeHttp(port, pathName, timeoutMs) {
  return new Promise((resolve) => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path: pathName,
      timeout: timeoutMs || 1200,
      headers: { accept: 'text/html,*/*' }
    }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

function truncateLine(line) {
  const clean = String(line).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').trimEnd();
  return clean.length > 400 ? clean.slice(0, 400) + '...' : clean;
}

function describeCli(result) {
  if (result.ok) return 'ok';
  const text = (result.stderr || result.stdout || 'failed').split('\n').filter(Boolean)[0] || 'failed';
  return (result.timedOut ? 'timed out: ' : 'failed: ') + text.slice(0, 300);
}

class Supervisor {
  constructor() {
    this.children = new Map();
    this.logs = { opencode: [], bb: [], configure: [] };
    this.opencode = { state: 'stopped', pid: null, port: config.opencodePort, error: '' };
    this.bb = { state: 'stopped', pid: null, port: config.bbPort, error: '' };
    this.ready = false;
    this.phase = 'Starting';
    this.error = '';
    this.configured = false;
    this.starting = false;
    this.stopping = false;
    this.restartTimer = null;
    this.startedAt = '';
  }

  snapshot() {
    return {
      ready: this.ready,
      phase: this.phase,
      error: this.error,
      configured: this.configured,
      startedAt: this.startedAt,
      bbUrl: bbUrl(),
      opencode: { ...this.opencode },
      bb: { ...this.bb },
      logs: {
        opencode: this.logs.opencode.slice(-40),
        bb: this.logs.bb.slice(-40),
        configure: this.logs.configure.slice(-20)
      }
    };
  }

  log(channel, line) {
    if (!line) return;
    const target = this.logs[channel] || this.logs.bb;
    target.push(truncateLine(line));
    if (target.length > config.logLimit) target.splice(0, target.length - config.logLimit);
    this.writeLogFile(channel, line);
  }

  writeLogFile(channel, line) {
    try {
      fs.appendFileSync('/tmp/ondev-' + channel + '.log', truncateLine(line) + '\n');
    } catch { /* logging must never break boot */ }
  }

  childEnv() {
    return {
      ...process.env,
      HOME: config.home,
      PATH: defaultPath,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TERM: 'xterm-256color',
      BB_TELEMETRY: 'false',
      BB_DATA_DIR: config.bbDataDir,
      CODEX_HOME: '/root/.codex',
      BB_SERVER_URL: 'http://127.0.0.1:' + config.bbPort,
      NODE_OPTIONS: '--max-old-space-size=768'
    };
  }

  spawnChild(name, command, args) {
    const logFile = '/tmp/ondev-' + name + '.log';
    this.log(name, '=== ' + nowIso() + ' starting ' + command + ' ' + args.join(' ') + ' ===');
    const child = spawn(command, args, {
      env: this.childEnv(),
      cwd: config.home,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.children.set(name, child);
    const state = name === 'bb' ? this.bb : this.opencode;
    state.pid = child.pid || null;
    state.state = 'starting';
    state.error = '';

    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      const reader = readline.createInterface({ input: stream });
      reader.on('line', (line) => this.log(name, line));
    }

    child.once('error', (error) => {
      state.state = 'error';
      state.error = error.message;
      this.log(name, 'spawn error: ' + error.message);
    });

    child.once('exit', (code, signal) => {
      const detail = 'exited code=' + (code === null ? 'null' : code) + ' signal=' + (signal || 'none');
      this.log(name, '=== ' + detail + ' ===');
      state.pid = null;
      const recent = (name === 'bb' ? this.logs.bb.slice(-60).join('\n') : '');
      if (name === 'bb' && recent.includes('EADDRINUSE')) {
        this.log('bb', 'port already served by another bb; keeping it');
        state.state = 'running';
        this.ready = true;
        return;
      }
      state.state = 'stopped';
      this.ready = false;
      this.children.delete(name);
      if (this.stopping) return;
      state.state = 'restarting';
      state.error = detail;
      this.phase = (name === 'bb' ? 'bb web UI' : 'OpenCode') + ' restarted';
      this.scheduleRestart(name);
    });

    try { fs.appendFileSync(logFile, ''); } catch { /* ignore */ }
    return child;
  }

  scheduleRestart(name) {
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      if (this.stopping) return;
      if (name === 'bb') {
        await this.startBb();
      } else {
        await this.startOpencode();
      }
      await this.configureBb().catch((error) => {
        this.log('configure', 'configure after restart failed: ' + error.message);
      });
    }, 2500);
  }

  async startOpencode() {
    if (await probeTcp(config.opencodePort)) {
      this.opencode.state = 'running';
      this.log('opencode', 'reusing listener on ' + config.opencodePort);
      return;
    }
    const existing = this.children.get('opencode');
    if (existing && existing.exitCode === null) return;
    this.spawnChild('opencode', 'opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(config.opencodePort)]);
    const started = Date.now();
    while (Date.now() - started < 40000) {
      if (await probeTcp(config.opencodePort)) {
        this.opencode.state = 'running';
        this.log('opencode', 'listening on 127.0.0.1:' + config.opencodePort);
        return;
      }
      await sleep(300);
    }
    throw new Error('OpenCode did not listen on ' + config.opencodePort);
  }

  async startBb() {
    this.clearStaleLock();
    if (await probeHttp(config.bbPort, '/', 1000)) {
      this.bb.state = 'running';
      this.ready = true;
      this.log('bb', 'reusing listener on ' + config.bbPort);
      return;
    }
    const existing = this.children.get('bb');
    if (existing && existing.exitCode === null) return;
    this.spawnChild('bb', 'bb-app', [
      '--data-dir', config.bbDataDir,
      '--server-bind-host', '127.0.0.1',
      '--server-port', String(config.bbPort),
      '--no-in-app-updates'
    ]);
    const started = Date.now();
    while (Date.now() - started < config.readyTimeoutMs) {
      if (await probeHttp(config.bbPort, '/', 1200)) {
        this.bb.state = 'running';
        this.ready = true;
        this.log('bb', 'listening on 127.0.0.1:' + config.bbPort);
        return;
      }
      await sleep(500);
    }
    throw new Error('bb web UI did not answer on ' + config.bbPort);
  }

  clearStaleLock() {
    const lock = '/root/.bb/daemon.lock';
    try {
      if (!fs.existsSync(lock)) return;
      const holders = spawnSync('pgrep', ['-f', 'bb-app'], { encoding: 'utf8' });
      if ((holders.stdout || '').trim() !== '') return;
      fs.unlinkSync(lock);
      this.log('configure', 'cleared stale daemon.lock');
    } catch (error) {
      this.log('configure', 'lock check failed: ' + error.message);
    }
  }

  runCli(command, args, timeoutMs) {
    return new Promise((resolve) => {
      const limit = timeoutMs || 30000;
      let settled = false;
      const child = spawn(command, args, {
        env: this.childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      });
      let stdout = '';
      let stderr = '';
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const killGroup = () => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      };
      const timer = setTimeout(() => {
        killGroup();
        finish({
          ok: false,
          timedOut: true,
          stdout: stdout.trim(),
          stderr: (stderr.trim() + ' timed out after ' + limit + 'ms').trim(),
        });
      }, limit);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.once('error', (error) => {
        finish({ ok: false, stdout: stdout.trim(), stderr: error.message });
      });
      child.once('exit', (code) => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
        finish({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() });
      });
    });
  }

  async configureBb() {
    this.log('configure', 'configure start codex=' + fs.existsSync('/root/.codex/auth.json'));
    await this.disableGithubStar();
    this.phase = 'Configuring OpenCode provider';
    const enable = await this.runCli('bb', ['plugin', 'enable', 'provider-acp'], 30000);
    this.log('configure', 'plugin enable provider-acp: ' + describeCli(enable));

    let providerReady = false;
    let lastList = '';
    for (let attempt = 1; attempt <= 4 && !providerReady; attempt += 1) {
      const list = await this.runCli('bb', ['provider', 'list'], 15000);
      lastList = describeCli(list);
      this.log('configure', 'provider list #' + attempt + ': ' + lastList);
      providerReady = list.ok && list.stdout.includes('acp-opencode');
      if (!providerReady) await sleep(1500);
    }
    if (!providerReady) {
      throw new Error('acp-opencode provider did not register (provider list: ' + lastList + ')');
    }
    this.log('configure', 'acp-opencode registered');

    const codexSignedIn = fs.existsSync('/root/.codex/auth.json');
    const providerOrder = codexSignedIn
      ? '["codex","acp-opencode"]'
      : '["acp-opencode"]';
    const defaultProvider = 'acp-opencode';
    this.log('configure', 'codex auth.json present=' + codexSignedIn + ' default=' + defaultProvider);

    const defaults = [
      ['providerOrder', providerOrder],
      ['defaultProviderId', defaultProvider],
      ['onboardingCompletedAt', nowIso()],
      ['telemetryEnabled', 'false']
    ];
    for (const [key, value] of defaults) {
      const result = await this.runCli('bb', ['settings', 'general', key, value], 20000);
      this.log('configure', 'settings ' + key + ': ' + describeCli(result));
    }

    await this.configurePush();

    const projects = await this.runCli('bb', ['project', 'list', '--json'], 20000);
    this.log('configure', 'project list: ' + describeCli(projects));
    if (projects.ok && projects.stdout.trim() === '[]') {
      const created = await this.runCli('bb', ['project', 'create', '--name', 'Workspace', '--root', config.workspace], 30000);
      this.log('configure', 'project create: ' + describeCli(created));
    }
    this.configured = true;
    this.phase = 'Ready';
    this.log('configure', 'configure done');
  }

  async disableGithubStar() {
    const disabled = await this.runCli(
      'bb',
      ['plugin', 'disable', 'bb--github-star'],
      30000,
    );
    const detail = describeCli(disabled);
    if (disabled.ok || detail.includes('unknown plugin')) return;
    this.log('configure', 'github-star plugin disable: ' + detail);
  }

  async configurePush() {
    const port = Number.parseInt(process.env.ONDEV_PUSH_PORT ?? '', 10);
    if (!Number.isFinite(port) || port <= 0) {
      this.log('configure', 'push endpoint: no local port');
      return;
    }
    const enable = await this.runCli('bb', ['plugin', 'enable', 'push-notifications'], 30000);
    this.log('configure', 'push plugin enable: ' + (enable.ok ? 'ok' : enable.stderr || 'failed'));
    const settings = [
      ['expoPushUrl', 'http://127.0.0.1:' + port],
      ['mobileEnabled', 'true']
    ];
    for (const [key, value] of settings) {
      const result = await this.runCli(
        'bb',
        ['plugin', 'config', 'push-notifications', 'set', key, value],
        20000,
      );
      this.log('configure', 'push ' + key + ': ' + (result.ok ? 'ok' : result.stderr || 'failed'));
    }
    const device = await this.runCli(
      'bb',
      ['push-notifications', 'add', '--token', 'ExponentPushToken[codex-ondev-local]', '--platform', 'android', '--label', 'Codex ondev', '--json'],
      20000,
    );
    this.log('configure', 'push device: ' + (device.ok ? 'ok' : device.stderr || 'failed'));
  }

  async start() {
    if (this.starting) return;
    this.starting = true;
    this.startedAt = nowIso();
    this.error = '';
    this.ready = false;
    try {
      this.phase = 'Starting OpenCode';
      await this.startOpencode();
      this.phase = 'Starting bb web UI';
      await this.startBb();
      try {
        await this.configureBb();
      } catch (configureError) {
        this.error = 'Setup did not finish: ' + configureError.message;
        this.phase = 'bb ready, setup incomplete';
        this.log('configure', 'configure failed: ' + configureError.message);
        this.ready = await probeHttp(config.bbPort, '/', 1500).catch(() => false);
        return;
      }
      this.ready = true;
      this.phase = 'Ready';
      this.log('configure', 'runtime ready at ' + bbUrl());
    } catch (error) {
      this.error = error.message;
      this.phase = 'Failed';
      this.log('configure', 'start failed: ' + error.message);
      this.ready = await probeHttp(config.bbPort, '/', 1500).catch(() => false);
    } finally {
      this.starting = false;
    }
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    for (const [name, child] of this.children) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch { /* ignore */ }
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      this.log(name, 'stopped');
    }
    this.children.clear();
    this.stopping = false;
    this.ready = false;
  }

  async restart() {
    await this.stop();
    await sleep(700);
    await this.start();
  }
}

export const supervisor = new Supervisor();
