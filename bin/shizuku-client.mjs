#!/usr/bin/env node
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const SOCKET = '/run/shizuku.sock';
const PLAY = 'https://play.google.com/store/apps/details?id=moe.shizuku.privileged.api';
const GITHUB = 'https://github.com/RikkaApps/Shizuku/releases';

const rawArgs = process.argv.slice(2);
let overrideTimeout = 0;
const args = [];
for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index];
  if (arg === '--timeout' || arg === '-d') {
    overrideTimeout = Number.parseInt(rawArgs[index + 1] ?? '', 10) || 0;
    index += 1;
    continue;
  }
  if (arg.startsWith('--timeout=')) {
    overrideTimeout = Number.parseInt(arg.slice('--timeout='.length), 10) || 0;
    continue;
  }
  args.push(arg);
}
if (args.length === 0) {
  process.stderr.write('Usage: shizuku <command...> | shizuku status | shizuku pull SRC DST | shizuku push SRC DST\n');
  process.exit(2);
}

function timeoutMs() {
  if (overrideTimeout > 0) return overrideTimeout;
  const parsed = Number.parseInt(process.env.ONDEV_SHIZUKU_TIMEOUT ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function bridgePort() {
  const parsed = Number.parseInt(process.env.ONDEV_PUSH_PORT ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readLine(stream) {
  return new Promise((resolve) => {
    let text = '';
    const onData = (chunk) => {
      text += chunk.toString('latin1');
      const index = text.indexOf('\n');
      if (index >= 0) {
        stream.off('data', onData);
        resolve({ line: text.slice(0, index), rest: Buffer.from(text.slice(index + 1), 'latin1') });
      }
    };
    stream.on('data', onData);
    stream.once('error', () => resolve(null));
    stream.once('close', () => resolve(null));
  });
}

function execSocket(command, stdin, limit) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: SOCKET });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    if (limit > 0) {
      socket.setTimeout(limit + 15000, () => done({ exitCode: 124, stdout: Buffer.alloc(0), stderr: Buffer.from('timeout'), transport: 'socket' }));
    }
    socket.on('error', () => done(null));
    socket.on('connect', async () => {
      const header = JSON.stringify({ command, stdinLen: stdin ? stdin.length : 0, timeoutMs: limit });
      socket.write(header + '\n');
      if (stdin && stdin.length > 0) socket.write(stdin);
      const first = await readLine(socket);
      if (first === null) return done(null);
      let meta;
      try {
        meta = JSON.parse(first.line);
      } catch {
        return done(null);
      }
      if (meta.ok === false && meta.error) {
        return done({ exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(meta.error), transport: 'socket' });
      }
      const need = (meta.stdoutLen || 0) + (meta.stderrLen || 0);
      const chunks = [first.rest];
      let have = first.rest.length;
      if (have >= need) {
        const all = Buffer.concat(chunks);
        return done({
          exitCode: meta.exitCode ?? 1,
          stdout: all.subarray(0, meta.stdoutLen || 0),
          stderr: all.subarray(meta.stdoutLen || 0, need),
          transport: 'socket',
        });
      }
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        have += chunk.length;
        if (have >= need) {
          const all = Buffer.concat(chunks);
          done({
            exitCode: meta.exitCode ?? 1,
            stdout: all.subarray(0, meta.stdoutLen || 0),
            stderr: all.subarray(meta.stdoutLen || 0, need),
            transport: 'socket',
          });
        }
      });
      socket.on('close', () => done(null));
    });
  });
}

async function execRish(command, limit) {
  const port = bridgePort();
  if (port === 0) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await new Promise((resolve) => {
      const body = JSON.stringify({ op: 'exec', command, timeoutMs: limit });
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/',
          timeout: limit > 0 ? limit + 15000 : 0,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(text));
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });
    if (result) {
      return {
        exitCode: result.exitCode ?? 1,
        stdout: Buffer.from(result.stdoutB64 || '', 'base64'),
        stderr: Buffer.from(result.stderrB64 || '', 'base64'),
        transport: 'rish',
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

async function exec(command, stdin, limit) {
  if (!fs.existsSync(SOCKET)) {
    await ensureSocket();
  }
  if (fs.existsSync(SOCKET)) {
    const viaSocket = await execSocket(command, stdin, limit);
    if (viaSocket) return viaSocket;
  }
  return execRish(command, limit);
}

function ensureSocket() {
  const port = bridgePort();
  if (port === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const body = JSON.stringify({ op: 'ensure' });
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/', timeout: 8000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on('end', resolve); },
    );
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function status() {
  if (fs.existsSync(SOCKET)) {
    const result = await new Promise((resolve) => {
      const socket = net.createConnection({ path: SOCKET });
      socket.setTimeout(4000, () => { socket.destroy(); resolve(null); });
      socket.on('error', () => resolve(null));
      socket.on('connect', async () => {
        socket.write(JSON.stringify({ op: 'status' }) + '\n');
        const line = await readLine(socket);
        socket.destroy();
        try {
          resolve(JSON.parse(line.line));
        } catch {
          resolve(null);
        }
      });
    });
    if (result && result.ok) {
      process.stdout.write('shizuku: connected as shell user (uid ' + result.uid + ') via socket\n');
      return true;
    }
  }
  const port = bridgePort();
  if (port > 0) {
    const state = await new Promise((resolve) => {
      const body = JSON.stringify({ op: 'status' });
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/', timeout: 4000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(text)); } catch { resolve(null); }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });
    if (state && state.binder && state.permission) {
      process.stdout.write('shizuku: connected via rish\n');
      return true;
    }
    if (state) {
      process.stderr.write('shizuku: not connected. ' + explain(state) + '\n');
      process.exitCode = 1;
      return false;
    }
  }
  process.stderr.write('shizuku: not connected. ' + explain(null) + '\n');
  process.exitCode = 1;
  return false;
}

function explain(state) {
  if (state === null) return 'Start the app and try again.';
  if (!state.installed) {
    return 'Shizuku is not installed on this phone. Install it from Google Play ' + PLAY + ' or GitHub ' + GITHUB + ', then tap Allow on the Shizuku popup.';
  }
  if (!state.binder) {
    return 'Shizuku is installed but not running. Open Shizuku and tap Start. On Android 11 and newer this uses Wireless debugging and needs no computer, but it has to be started again after a phone restart.';
  }
  return 'Codex ondev needs phone access. Tap Allow on the Shizuku popup.';
}

async function pull(src, dst) {
  const result = await exec('cat ' + JSON.stringify(src), null, timeoutMs());
  if (result === null) {
    process.stderr.write('shizuku: not connected\n');
    process.exitCode = 1;
    return;
  }
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr.toString() || 'pull failed\n');
    process.exitCode = result.exitCode;
    return;
  }
  fs.writeFileSync(dst, result.stdout);
  const remote = await exec('sha256sum ' + JSON.stringify(src), null, timeoutMs());
  const remoteHash = remote ? remote.stdout.toString().trim().split(/\s+/)[0] : '';
  const localHash = sha256(fs.readFileSync(dst));
  if (remoteHash && remoteHash !== localHash) {
    process.stderr.write('sha256 mismatch: remote ' + remoteHash + ' local ' + localHash + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('pulled ' + src + ' to ' + dst + ' (' + result.stdout.length + ' bytes, sha256 ' + localHash + ')\n');
}

async function push(src, dst) {
  const data = fs.readFileSync(src);
  const result = await exec('cat > ' + JSON.stringify(dst), data, timeoutMs());
  if (result === null) {
    process.stderr.write('shizuku: not connected\n');
    process.exitCode = 1;
    return;
  }
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr.toString() || 'push failed\n');
    process.exitCode = result.exitCode;
    return;
  }
  const remote = await exec('sha256sum ' + JSON.stringify(dst), null, timeoutMs());
  const remoteHash = remote ? remote.stdout.toString().trim().split(/\s+/)[0] : '';
  const localHash = sha256(data);
  if (remoteHash && remoteHash !== localHash) {
    process.stderr.write('sha256 mismatch: local ' + localHash + ' remote ' + remoteHash + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('pushed ' + src + ' to ' + dst + ' (' + data.length + ' bytes, sha256 ' + localHash + ')\n');
}

async function main() {
  const limit = timeoutMs();
  if (args[0] === 'status') return status();
  if (args[0] === 'pull' && args.length >= 3) return pull(args[1], args[2]);
  if (args[0] === 'push' && args.length >= 3) return push(args[1], args[2]);
  const result = await exec(args.join(' '), process.stdin.isTTY ? null : fs.readFileSync(0), limit);
  if (result === null) {
    process.stderr.write('shizuku: not connected\n');
    process.exitCode = 1;
    return;
  }
  if (result.stdout && result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr && result.stderr.length > 0) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode ?? 0;
}

main();
