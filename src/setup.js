import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import { spawnSync } from 'node:child_process';
import { config, defaultPath, nowIso } from './config.js';

const CODEX_AUTH_PATH = '/root/.codex/auth.json';
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';

const STEPS = [
  { id: 'profile', label: 'Shell profile' },
  { id: 'sysfiles', label: 'DNS and hosts' },
  { id: 'tmpdirs', label: 'Temp directories' },
  { id: 'gitconfig', label: 'Git identity' },
  { id: 'opencode', label: 'OpenCode free model' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'codexconfig', label: 'Codex config' },
  { id: 'agentdocs', label: 'Agent instructions' },
  { id: 'codexauth', label: 'Codex auth' },
  { id: 'opencodeauth', label: 'OpenCode auth' },
  { id: 'opencodefallback', label: 'OpenCode fallback' },
  { id: 'shizuku', label: 'Shizuku CLI' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'verify', label: 'Verify runtime' }
];

const state = {
  running: false,
  done: false,
  failed: false,
  error: '',
  currentStep: '',
  steps: STEPS.map((step) => ({ ...step, done: false, detail: '', error: '' })),
  checks: {},
  startedAt: '',
  completedAt: ''
};

let listeners = [];

function notify() {
  for (const listener of listeners) {
    try { listener(getSetupStatus()); } catch { /* ignore */ }
  }
}

export function onSetupChange(listener) {
  listeners.push(listener);
  return () => { listeners = listeners.filter((item) => item !== listener); };
}

export function getSetupStatus() {
  return {
    running: state.running,
    done: state.done,
    failed: state.failed,
    error: state.error,
    currentStep: state.currentStep,
    checks: { ...state.checks },
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    steps: state.steps.map((step) => ({ ...step }))
  };
}

function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let previous = '';
  try { previous = fs.readFileSync(filePath, 'utf8'); } catch { /* new file */ }
  if (previous === content) return false;
  fs.writeFileSync(filePath, content, { mode: mode || 0o644 });
  fs.chmodSync(filePath, mode || 0o644);
  return true;
}

function writeFileAtomic(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let previous = '';
  try { previous = fs.readFileSync(filePath, 'utf8'); } catch { /* new file */ }
  if (previous === content) return false;
  const tempPath = filePath + '.tmp';
  fs.writeFileSync(tempPath, content, { mode: mode || 0o644 });
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, mode || 0o644);
  return true;
}

function readNameservers(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('nameserver '))
      .map((line) => line.slice('nameserver '.length).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, PATH: defaultPath, HOME: config.home },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim()
  };
}

function staticHosts() {
  return [
    ['opencode.ai', '104.18.10.66'],
    ['models.dev', '104.21.51.36'],
    ['github.com', '4.237.22.38'],
    ['api.github.com', '140.82.112.6'],
    ['objects.githubusercontent.com', '185.199.108.133'],
    ['registry.npmjs.org', '104.16.24.34']
  ];
}

async function resolveHosts() {
  const resolved = [];
  for (const [name, fallback] of staticHosts()) {
    let address = fallback;
    try {
      const answer = await Promise.race([
        dns.promises.resolve4(name),
        new Promise((resolve) => setTimeout(() => resolve([]), 1500))
      ]);
      if (Array.isArray(answer) && answer.length > 0) address = answer[0];
    } catch { /* keep fallback */ }
    resolved.push([name, address]);
  }
  return resolved;
}

async function stepProfile() {
  const content = [
    'export HOME=/root',
    'export PATH=' + defaultPath,
    'export LANG=C.UTF-8',
    'export LC_ALL=C.UTF-8',
    'export TERM=xterm-256color',
    'export NODE_PATH=/usr/local/lib/node_modules',
    'export BB_TELEMETRY=false',
    'export npm_config_cache=/tmp/.npm',
    ''
  ].join('\n');
  const changed = writeFile('/root/.profile', content);
  return { changed, detail: changed ? 'PATH and locale exported' : 'already configured' };
}

async function stepSysfiles() {
  const hosts = await resolveHosts();
  const lines = [
    '127.0.0.1 localhost',
    '127.0.0.1 codex-ondev',
    '::1 localhost',
    '',
    '# proot DNS workaround: glibc getaddrinfo can fail through the Android',
    '# translation layer, so pin the upstream hosts the runtime needs.',
    ...hosts.map(([name, address]) => address + ' ' + name)
  ];
  const changedHosts = writeFileAtomic('/etc/hosts', lines.join('\n') + '\n');
  return {
    changed: changedHosts,
    detail: hosts.length + ' host entries (resolv.conf owned by the app)'
  };
}

async function stepTmpdirs() {
  for (const dir of ['/tmp', '/var/tmp', '/root/.cache', '/dev/shm', '/run']) {
    fs.mkdirSync(dir, { recursive: true });
  }
  run('chmod', ['1777', '/tmp', '/var/tmp', '/dev/shm']);
  return { changed: false, detail: 'writable /tmp, /var/tmp, /dev/shm' };
}

async function stepGitconfig() {
  const content = [
    '[user]',
    '\tname = Codex ondev',
    '\temail = ondev@localhost',
    '[init]',
    '\tdefaultBranch = main',
    '[safe]',
    '\tdirectory = *',
    ''
  ].join('\n');
  const changed = writeFile('/root/.gitconfig', content);
  return { changed, detail: changed ? 'wrote /root/.gitconfig' : 'already configured' };
}

async function stepOpencode() {
  const file = '/root/.config/opencode/opencode.json';
  const content = JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: config.model }, null, 2) + '\n';
  const changed = writeFile(file, content);
  return { changed, detail: config.model };
}

async function stepCodex() {
  const result = run('codex', ['--version']);
  if (!result.ok) {
    throw new Error('codex CLI is not installed or not executable');
  }
  const host = fs.existsSync('/usr/local/bin/codex-code-mode-host');
  return {
    changed: false,
    detail: result.stdout + (host ? ' / code-mode-host' : ' / code-mode disabled (host missing)')
  };
}

async function stepCodexConfig() {
  const file = '/root/.codex/config.toml';
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = current.length > 0 ? current.split('\n') : [];
  let sectionStart = -1;
  let sectionEnd = lines.length;
  let featureLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === '[features]') {
      sectionStart = index;
      continue;
    }
    if (sectionStart >= 0 && trimmed.startsWith('[')) {
      sectionEnd = index;
      break;
    }
    if (sectionStart >= 0 && /^code_mode_host\s*=/.test(trimmed)) {
      featureLine = index;
    }
  }

  const hostPresent = fs.existsSync('/usr/local/bin/codex-code-mode-host');
  const featureValue = hostPresent ? 'code_mode_host = true' : 'code_mode_host = false';
  let next;
  if (featureLine >= 0) {
    lines[featureLine] = featureValue;
    next = lines.join('\n');
  } else if (sectionStart >= 0) {
    lines.splice(sectionStart + 1, 0, featureValue);
    next = lines.join('\n');
  } else {
    const prefix = current.trimEnd();
    next = (prefix.length > 0 ? prefix + '\n\n' : '') + '[features]\n' + featureValue + '\n';
  }
  if (!next.endsWith('\n')) next += '\n';
  const changed = writeFile(file, next, 0o644);
  return { changed, detail: changed ? 'enabled features.code_mode_host' : 'already enabled' };
}

function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function jwtAccountId(token) {
  const claims = decodeJwt(token);
  const auth = claims && claims['https://api.openai.com/auth'];
  return auth && typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : '';
}

function jwtExpiry(token) {
  const claims = decodeJwt(token);
  return claims && typeof claims.exp === 'number' ? claims.exp : 0;
}

async function stepCodexAuth() {
  if (!fs.existsSync(CODEX_AUTH_PATH)) {
    return { changed: false, detail: 'not signed in' };
  }
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(CODEX_AUTH_PATH, 'utf8'));
  } catch (error) {
    return { changed: false, detail: 'unreadable auth.json: ' + error.message };
  }
  const tokens = auth.tokens || {};
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : '';
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '';
  if (!accessToken || !refreshToken) {
    return { changed: false, detail: 'auth.json has no usable tokens' };
  }
  const expiresAt = jwtExpiry(accessToken);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (expiresAt > 0 && expiresAt - nowSeconds > 300) {
    return { changed: false, detail: 'access token valid for ' + (expiresAt - nowSeconds) + 's' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: OAUTH_CLIENT_ID,
        refresh_token: refreshToken
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      return { changed: false, detail: 'refresh failed HTTP ' + response.status };
    }
    const data = await response.json();
    const nextAccess = typeof data.access_token === 'string' ? data.access_token : accessToken;
    const nextRefresh = typeof data.refresh_token === 'string' ? data.refresh_token : refreshToken;
    const nextId = typeof data.id_token === 'string' ? data.id_token : (tokens.id_token || '');
    const accountId = tokens.account_id || jwtAccountId(nextId) || jwtAccountId(nextAccess) || '';
    const next = {
      ...auth,
      auth_mode: auth.auth_mode || 'chatgpt',
      OPENAI_API_KEY: auth.OPENAI_API_KEY === undefined ? null : auth.OPENAI_API_KEY,
      tokens: {
        id_token: nextId,
        access_token: nextAccess,
        refresh_token: nextRefresh,
        account_id: accountId
      },
      last_refresh: nowIso()
    };
    writeFile(CODEX_AUTH_PATH, JSON.stringify(next, null, 2) + '\n', 0o600);
    return { changed: true, detail: 'refreshed Codex access token' };
  } catch (error) {
    return { changed: false, detail: 'refresh error: ' + error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function stepShizuku() {
  const wrapper = '#!/bin/sh\nexec /usr/local/bin/node /opt/ondev/bin/shizuku-client.mjs "$@"\n';
  const cliChanged = writeFile('/usr/local/bin/shizuku', wrapper, 0o755);
  const skill = fs.readFileSync('/opt/ondev/skills/shizuku/SKILL.md', 'utf8');
  const skillChanged = writeFile('/root/.bb/skills/shizuku/SKILL.md', skill);
  return {
    changed: cliChanged || skillChanged,
    detail: 'shizuku CLI + skill'
  };
}

const AGENT_GUIDE = [
  'You run inside the Codex ondev app on the user\'s Android phone. To see phone files or control apps, use Shizuku (the shizuku skill). Run `shizuku status` first. If it isn\'t connected, say so in one or two plain sentences, with no jargon or paths, and give both links: Google Play https://play.google.com/store/apps/details?id=moe.shizuku.privileged.api and GitHub https://github.com/RikkaApps/Shizuku/releases.',
  '',
  'Don\'t say "this environment" or talk about workspace paths unless asked.',
  ''
].join('\n');

const OPENCODE_AUTH_SCRIPT = `import json, sqlite3, time, uuid, base64
a = json.load(open('/root/.codex/auth.json'))
t = a.get('tokens') or {}
access = t.get('access_token')
refresh = t.get('refresh_token')
if not access or not refresh:
    print('no codex tokens')
    raise SystemExit(0)

def expires_ms(jwt):
    part = jwt.split('.')[1]
    part += '=' * (-len(part) % 4)
    return int(json.loads(base64.urlsafe_b64decode(part))['exp']) * 1000

value = {
    'type': 'oauth',
    'methodID': 'chatgpt-headless',
    'refresh': refresh,
    'access': access,
    'expires': expires_ms(access),
}
account = t.get('account_id')
if account:
    value['metadata'] = {'accountID': account}
db = sqlite3.connect('/root/.local/share/opencode/opencode.db')
row = db.execute("select value from credential where integration_id='openai' limit 1").fetchone()
if row and json.loads(row[0]) == value:
    print('already current')
    raise SystemExit(0)
db.execute("delete from credential where integration_id='openai'")
now = int(time.time() * 1000)
db.execute(
    'insert into credential (id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated) values (?,?,?,?,?,?,?,?,?)',
    (str(uuid.uuid4()), 'openai', 'OAuth', json.dumps(value), None, 'chatgpt-headless', 1, now, now),
)
db.commit()
print('openai oauth written to opencode.db')
`;

async function stepOpencodeAuth() {
  const codexAuth = '/root/.codex/auth.json';
  if (!fs.existsSync(codexAuth)) return { changed: false, detail: 'not signed in' };
  if (!fs.existsSync('/root/.local/share/opencode/opencode.db')) {
    return { changed: false, detail: 'opencode.db not created yet' };
  }
  writeFileAtomic('/tmp/ondev-opencode-auth.py', OPENCODE_AUTH_SCRIPT, 0o600);
  const result = run('python3', ['/tmp/ondev-opencode-auth.py'], { timeout: 30000 });
  const detail = (result.stdout || result.stderr || 'failed').trim().split('\n').pop();
  return { changed: result.ok && detail !== 'already current', detail };
}

function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

async function stepOpencodeFallback() {
  try {
    const vendor = '/opt/ondev/vendor/opencode-fallback-model';
    const target = '/root/.config/opencode/plugins/opencode-fallback-model';
    const stale = '/root/.config/opencode/plugins/opencode-fallback';
    if (fs.existsSync(stale)) fs.rmSync(stale, { recursive: true, force: true });
    let pluginChanged = false;
    if (fs.existsSync(vendor)) {
      pluginChanged = true;
      copyTree(vendor, target);
    }
    const configPath = '/root/.config/opencode/opencode.json';
    let opencodeJson = { $schema: 'https://opencode.ai/config.json', model: config.model };
    try {
      opencodeJson = {
        ...JSON.parse(fs.readFileSync(configPath, 'utf8')),
        model: config.model,
      };
    } catch { /* new file */ }
    const models = ['opencode/big-pickle'];
    if (fs.existsSync('/root/.local/share/opencode/auth.json')) models.push('openai/gpt-6-luna');
    opencodeJson.plugins = [
      { package: './plugins/opencode-fallback-model', options: { models } },
    ];
    delete opencodeJson.plugin;
    const configChanged = writeFileAtomic(configPath, JSON.stringify(opencodeJson, null, 2) + '\n');
    const catalog = '/opt/ondev/vendor/catalog/models.json';
    const cache = '/root/.cache/opencode/models.json';
    if (fs.existsSync(catalog) && (!fs.existsSync(cache) || fs.statSync(cache).size < 1024)) {
      fs.mkdirSync('/root/.cache/opencode', { recursive: true });
      fs.copyFileSync(catalog, cache);
    }
    return {
      changed: pluginChanged || configChanged,
      detail: pluginChanged ? 'bundled plugin + config' : 'config only',
    };
  } catch (error) {
    return { changed: false, detail: 'fallback setup skipped: ' + error.message };
  }
}

async function stepAgentDocs() {
  const codex = writeFileAtomic('/root/.codex/AGENTS.md', AGENT_GUIDE);
  const opencode = writeFileAtomic('/root/.config/opencode/AGENTS.md', AGENT_GUIDE);
  return {
    changed: codex || opencode,
    detail: 'Codex and OpenCode instructions'
  };
}

async function stepWorkspace() {
  fs.mkdirSync(config.workspace, { recursive: true });
  const readme = path.join(config.workspace, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, '# Workspace\n\nLocal bb workspace on Android.\n');
  }
  if (!fs.existsSync(path.join(config.workspace, '.git'))) {
    run('git', ['init', '-q'], { cwd: config.workspace });
  }
  const hasHead = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: config.workspace }).ok;
  if (!hasHead) {
    run('git', ['add', 'README.md'], { cwd: config.workspace });
    run('git', ['-c', 'user.name=Codex ondev', '-c', 'user.email=ondev@localhost', 'commit', '-q', '-m', 'Initial workspace'], { cwd: config.workspace });
  }
  return { changed: false, detail: config.workspace };
}

async function stepVerify() {
  const checks = {};
  const binaries = [
    ['node', ['--version']],
    ['opencode', ['--version']],
    ['codex', ['--version']],
    ['bb', ['--version']],
    ['git', ['--version']],
    ['rg', ['--version']]
  ];
  for (const [name, args] of binaries) {
    const result = run(name, args);
    checks[name] = { ok: result.ok, version: result.stdout || result.stderr };
  }
  state.checks = checks;
  const missing = binaries
    .map(([name]) => name)
    .filter((name) => !checks[name].ok);
  if (missing.length > 0) {
    throw new Error('Missing runtime binaries: ' + missing.join(', '));
  }
  return { changed: false, detail: 'opencode ' + checks.opencode.version + ' / bb ' + checks.bb.version };
}

const STEP_FNS = {
  profile: stepProfile,
  sysfiles: stepSysfiles,
  tmpdirs: stepTmpdirs,
  gitconfig: stepGitconfig,
  opencode: stepOpencode,
  codex: stepCodex,
  codexconfig: stepCodexConfig,
  agentdocs: stepAgentDocs,
  codexauth: stepCodexAuth,
  opencodeauth: stepOpencodeAuth,
  opencodefallback: stepOpencodeFallback,
  shizuku: stepShizuku,
  workspace: stepWorkspace,
  verify: stepVerify
};

export async function runSetup() {
  if (state.running) return getSetupStatus();
  state.running = true;
  state.done = false;
  state.failed = false;
  state.error = '';
  state.currentStep = '';
  state.startedAt = nowIso();
  state.completedAt = '';
  state.steps = STEPS.map((step) => ({ ...step, done: false, detail: '', error: '' }));
  notify();

  for (let index = 0; index < STEPS.length; index += 1) {
    const step = STEPS[index];
    state.currentStep = step.label;
    notify();
    try {
      const fn = STEP_FNS[step.id];
      const result = await fn();
      state.steps[index].done = true;
      state.steps[index].detail = result.detail || '';
      console.log('[setup] ' + step.label + ': ' + (result.detail || 'ok'));
    } catch (error) {
      state.steps[index].error = error.message;
      console.error('[setup] ' + step.label + ' failed: ' + error.message);
      if (step.id === 'verify') {
        state.failed = true;
        state.error = step.label + ': ' + error.message;
        break;
      }
    }
    notify();
  }

  state.running = false;
  state.currentStep = '';
  state.done = !state.failed;
  state.completedAt = nowIso();
  notify();
  return getSetupStatus();
}
