import fs from 'node:fs/promises';
import fsp from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function copyDir(from, to) {
  await ensureDir(to);
  await fs.cp(from, to, {
    recursive: true,
    force: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== '.git' && base !== 'node_modules' && base !== '.earnest';
    },
  });
}

export async function removeDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Recursively list relative file paths, sorted, skipping ignored dirs. */
export async function listFiles(root, { skip = ['.git', 'node_modules', '.earnest'] } = {}) {
  const out = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (skip.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }

  await walk(root);
  return out.sort();
}

export async function hashFile(file) {
  const buf = await fs.readFile(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Map of relative path -> sha256 for every file under root. */
export async function hashTree(root) {
  const files = await listFiles(root);
  const map = {};
  for (const rel of files) {
    map[rel] = await hashFile(path.join(root, rel));
  }
  return map;
}

export function diffTrees(before, after) {
  const added = [];
  const removed = [];
  const modified = [];
  for (const [rel, hash] of Object.entries(after)) {
    if (!(rel in before)) added.push(rel);
    else if (before[rel] !== hash) modified.push(rel);
  }
  for (const rel of Object.keys(before)) {
    if (!(rel in after)) removed.push(rel);
  }
  return { added, removed, modified, changed: [...added, ...modified, ...removed].sort() };
}

/** Minimal line diff, enough to show a readable preview in the UI. */
export function lineDiff(beforeText, afterText) {
  const before = String(beforeText ?? '').split('\n');
  const after = String(afterText ?? '').split('\n');
  const rows = [];

  // Longest common subsequence over lines (files here are small).
  const n = before.length;
  const m = after.length;
  const table = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      rows.push({ type: 'context', text: before[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      rows.push({ type: 'removed', text: before[i] });
      i += 1;
    } else {
      rows.push({ type: 'added', text: after[j] });
      j += 1;
    }
  }
  while (i < n) rows.push({ type: 'removed', text: before[i++] });
  while (j < m) rows.push({ type: 'added', text: after[j++] });

  const changed = rows.some((r) => r.type !== 'context');
  if (!changed) return [];

  // Keep the preview focused: collapse runs of unchanged lines.
  const focused = [];
  let run = 0;
  for (const row of rows) {
    if (row.type === 'context') {
      run += 1;
      if (run <= 2) focused.push(row);
    } else {
      run = 0;
      focused.push(row);
    }
  }
  return focused;
}
