#!/usr/bin/env node
// gh-oauth-login: log the GitHub CLI in through a browser OAuth redirect (no device code).
// Dependency-free, Node 20+. The token is piped straight into `gh auth login --with-token`
// and is never written to disk, logged, or printed.
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

// The GitHub CLI's own OAuth app. The secret is public in the open-source gh repo.
const CLIENT_ID = process.env.GH_OAUTH_CLIENT_ID || '178c6fc778ccc68e1d6a';
const CLIENT_SECRET = process.env.GH_OAUTH_CLIENT_SECRET || '34ddeff2b558a23d38fba8a6de74f086ede1cc0b';
const ALL_SCOPES = [
  'repo', 'workflow', 'write:packages', 'delete:packages', 'admin:org', 'admin:public_key',
  'admin:repo_hook', 'admin:org_hook', 'gist', 'notifications', 'user', 'delete_repo',
  'write:discussion', 'admin:enterprise', 'audit_log', 'codespace', 'project',
  'admin:gpg_key', 'admin:ssh_signing_key', 'copilot',
].join(' ');

const HELP = `Usage: node gh-oauth-login.mjs [options]

Logs gh in with a browser OAuth redirect (state + PKCE), requesting all scopes by default.

  --host <host>      GitHub host (default github.com)
  --scopes "<list>"  Space/comma separated scopes (default: all scopes)
  --port <n>         Local callback port on 127.0.0.1 (default: random free port)
  --print-url        Print the authorize URL and don't open a browser
                     (open it on another device; the callback must still reach this machine)
  --switch           Make the new account gh's active account (default: keep the current active one)
  --replace          Allow refreshing the token of an account gh already has
  --timeout <min>    Give up after this many minutes (default 10)
  -h, --help         Show this help`;

function parseArgs(argv) {
  const o = { host: 'github.com', scopes: ALL_SCOPES, port: 0, printUrl: false, switch: false, replace: false, timeout: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) die(`Missing value for ${a}`); return v; };
    if (a === '--host') o.host = val().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    else if (a === '--scopes') o.scopes = val().split(/[\s,]+/).filter(Boolean).join(' ');
    else if (a === '--port') o.port = Number(val());
    else if (a === '--print-url') o.printUrl = true;
    else if (a === '--switch') o.switch = true;
    else if (a === '--replace') o.replace = true;
    else if (a === '--timeout') o.timeout = Number(val());
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else die(`Unknown option: ${a}\n\n${HELP}`);
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) die('Invalid --port');
  if (!(o.timeout > 0)) die('Invalid --timeout');
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(o.host)) die('Invalid --host');
  if (!o.scopes) die('Empty --scopes');
  return o;
}

function die(msg, code = 1) { console.error(`gh-oauth-login: ${msg}`); process.exit(code); }

// Child env without tokens that would override or block the stored login.
function ghEnv() {
  const env = { ...process.env };
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[k];
  return env;
}

function gh(args) {
  return spawnSync('gh', args, { env: ghEnv(), encoding: 'utf8' });
}

// Logins gh already holds for a host, and which one is active.
function ghAccounts(host) {
  const r = gh(['auth', 'status', '--hostname', host]);
  if (r.error) die('gh CLI not found on PATH');
  const out = `${r.stdout}\n${r.stderr}`;
  const accounts = [];
  let active = null;
  let last = null;
  for (const line of out.split('\n')) {
    const m = /Logged in to \S+ account (\S+)/.exec(line) || /Logged in to \S+ as (\S+)/.exec(line);
    if (m) { last = m[1]; accounts.push(last); }
    if (last && /Active account:\s*true/.test(line)) active = last;
  }
  return { accounts, active };
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.error('Could not open a browser; open the URL above manually.'));
    child.unref();
  } catch { console.error('Could not open a browser; open the URL above manually.'); }
}

async function postForm(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'gh-oauth-login' },
    body: new URLSearchParams(form),
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`token endpoint HTTP ${res.status}`);
  return res.json();
}

async function fetchUser(host, token) {
  const api = host === 'github.com' ? 'https://api.github.com/user' : `https://${host}/api/v3/user`;
  const res = await fetch(api, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'gh-oauth-login' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`user lookup HTTP ${res.status}`);
  const u = await res.json();
  if (typeof u.login !== 'string') throw new Error('user lookup returned no login');
  return u.login;
}

function pipeTokenToGh(host, token) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', ['auth', 'login', '--hostname', host, '--with-token'], { env: ghEnv(), stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`gh auth login exited with ${code}`)));
    child.stdin.end(`${token}\n`);
  });
}

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5"><h2>${title}</h2><p>${body}</p></body>`;

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (spawnSync('gh', ['--version']).error) die('gh CLI not found on PATH');

  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let redirectUri;
  let done = false;

  const result = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== '/callback') { res.writeHead(404); return res.end('Not found'); }
      if (done || !safeEqual(url.searchParams.get('state') || '', state)) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        return res.end(page('Invalid or expired login', 'Start the login again from the terminal.'));
      }
      done = true;
      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const finish = (ok, title, body, value) => {
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html', Connection: 'close' });
        res.end(page(title, body), () => { server.close(); server.closeAllConnections?.(); ok ? resolve(value) : reject(value); });
      };
      if (err || !code) return finish(false, 'Login cancelled', 'GitHub did not return a code. You can close this tab.', new Error(err || 'no code in callback'));
      finish(true, 'GitHub login received', 'Finishing in the terminal. You can close this tab.', code);
    });
    const timer = setTimeout(() => { server.close(); server.closeAllConnections?.(); reject(new Error(`timed out after ${opt.timeout} min`)); }, opt.timeout * 60000);
    timer.unref();
    server.on('error', e => reject(new Error(`local server: ${e.code || e.message}`)));
    server.listen(opt.port, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      const params = new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: redirectUri, scope: opt.scopes, state,
        code_challenge: challenge, code_challenge_method: 'S256', allow_signup: 'true',
      });
      const authUrl = `https://${opt.host}/login/oauth/authorize?${params}`;
      console.log(`Waiting for GitHub on ${redirectUri}`);
      console.log(`Scopes: ${opt.scopes}`);
      console.log(`\nAuthorize URL:\n${authUrl}\n`);
      if (opt.printUrl) console.log('Open it on any device; the final redirect must reach this machine (forward the port if you use another device).');
      else openBrowser(authUrl);
    });
  }).catch(e => die(e.message));

  let token;
  try {
    const data = await postForm(`https://${opt.host}/login/oauth/access_token`, {
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: result, redirect_uri: redirectUri, code_verifier: verifier,
    });
    if (data.error) die(`token exchange failed: ${data.error}`);
    if (typeof data.access_token !== 'string' || !data.access_token) die('token exchange returned no token');
    token = data.access_token;
    if (data.scope !== undefined) console.log(`Granted scopes: ${data.scope || '(none)'}`);
  } catch (e) { die(`token exchange failed: ${e.message}`); }

  let login;
  try { login = await fetchUser(opt.host, token); } catch (e) { die(e.message); }
  console.log(`Signed in to GitHub as ${login}`);
  const before = ghAccounts(opt.host);

  if (before.accounts.includes(login) && !opt.replace) {
    token = null;
    die(`gh already has ${login} on ${opt.host}; token discarded. Re-run with --replace to refresh it.`, 3);
  }

  try { await pipeTokenToGh(opt.host, token); } catch (e) { die(e.message); }
  token = null;

  if (!opt.switch && before.active && before.active !== login) {
    const r = gh(['auth', 'switch', '--hostname', opt.host, '--user', before.active]);
    if (r.status === 0) console.log(`Kept ${before.active} as the active account (use --switch to make ${login} active).`);
    else console.error(`Could not switch back to ${before.active}; ${login} is now active.`);
  }

  console.log('');
  const st = spawnSync('gh', ['auth', 'status', '--hostname', opt.host], { env: ghEnv(), stdio: 'inherit' });
  process.exit(st.status ?? 0);
}

main().catch(e => die(e.message));
