#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || '.';
const secretNames = ['.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', '.npmrc', 'keystore.jks'];
const secretPatterns = [/sk-[A-Za-z0-9]{16,}/, /ghp_[A-Za-z0-9]{20,}/, /AIza[0-9A-Za-z_-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
const skip = new Set(['node_modules', '.git', 'dist', 'build', '.gradle', 'Pods']);
const problems = [];
let readme = null;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    const stat = fs.statSync(full);
    if (stat.size > 100 * 1024 * 1024) problems.push('over 100 MB: ' + full);
    if (secretNames.includes(entry.name)) problems.push('looks like a secret file: ' + full);
    if (entry.name.toLowerCase() === 'readme.md') readme = full;
    if (stat.size <= 2 * 1024 * 1024) {
      const text = fs.readFileSync(full, 'utf8');
      for (const pattern of secretPatterns) {
        if (pattern.test(text)) problems.push('possible secret in ' + full);
      }
    }
  }
}

walk(root);

if (readme) {
  const text = fs.readFileSync(readme, 'utf8');
  if (fs.statSync(readme).size > 512 * 1024) problems.push('README over 512 KB');
  const first = text.split('\n')[0] || '';
  if (!first.startsWith('# ') || first.length > 120) problems.push('first line must be "# Title" under 120 characters');
  const paragraph = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !p.startsWith('#'))[0] || '';
  if (paragraph.length <= 60) problems.push('first paragraph must be over 60 characters');
  if (/https?:\/\//.test(paragraph)) problems.push('first paragraph must not contain a URL');
  const images = [...text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)];
  if (images.length > 12) problems.push('more than 12 README images');
  if (images.length > 0 && !/screenshot|gameplay/i.test(images[0][1])) {
    problems.push('first image alt text must contain "screenshot" or "gameplay"');
  }
} else {
  problems.push('README.md is missing');
}

if (problems.length === 0) {
  console.log('ready to publish: no secrets, README looks right');
} else {
  for (const problem of problems) console.log('- ' + problem);
  process.exitCode = 1;
}
