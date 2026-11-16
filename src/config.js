import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

function toInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const defaultPath = [
  '/root/.local/bin',
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin'
].join(':');

export const config = Object.freeze({
  projectRoot,
  host: process.env.ONDEV_HOST || '127.0.0.1',
  port: toInt(process.env.ONDEV_PORT, 1400),
  opencodePort: toInt(process.env.ONDEV_OPENCODE_PORT, 4096),
  bbPort: toInt(process.env.ONDEV_BB_PORT, 38886),
  bbDataDir: process.env.ONDEV_BB_DATA_DIR || '/root/.bb',
  workspace: process.env.ONDEV_WORKSPACE || '/root/workspace',
  home: '/root',
  model: process.env.ONDEV_MODEL || 'opencode/deepseek-v4.1-flash-free',
  readyTimeoutMs: toInt(process.env.ONDEV_READY_TIMEOUT_MS, 120000),
  logLimit: toInt(process.env.ONDEV_LOG_LIMIT, 240)
});

export function bbUrl() {
  return 'http://127.0.0.1:' + config.bbPort + '/';
}

export function nowIso() {
  return new Date().toISOString();
}

export function hostname() {
  return os.hostname();
}
