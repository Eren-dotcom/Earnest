import fs from 'node:fs/promises';
import path from 'node:path';
import { CHECKPOINT_DIR, WORKSPACE_DIR } from './paths.mjs';
import { copyDir, ensureDir, hashTree, removeDir } from './fsutil.mjs';

/**
 * Checkpoints are full snapshots of the disposable workspace. They are taken
 * before an agent is trusted with edits, and restore is verified by comparing
 * content hashes afterwards -- a restore that does not actually restore is a
 * failure, not a success.
 */

export async function createCheckpoint(id, label = '') {
  const dir = path.join(CHECKPOINT_DIR, id);
  await removeDir(dir);
  await ensureDir(dir);
  await copyDir(WORKSPACE_DIR, dir);
  const tree = await hashTree(dir);
  return { id, label, createdAt: new Date().toISOString(), files: Object.keys(tree).length };
}

export async function listCheckpoints() {
  const entries = await fs.readdir(CHECKPOINT_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Restore the workspace from a checkpoint and verify the result. */
export async function restoreCheckpoint(id) {
  const dir = path.join(CHECKPOINT_DIR, id);
  const expected = await hashTree(dir).catch(() => null);
  if (!expected) {
    return { ok: false, reason: `Checkpoint "${id}" does not exist, so restore cannot be trusted.` };
  }

  await removeDir(WORKSPACE_DIR);
  await copyDir(dir, WORKSPACE_DIR);

  const actual = await hashTree(WORKSPACE_DIR);
  const matches =
    Object.keys(expected).length === Object.keys(actual).length &&
    Object.entries(expected).every(([rel, hash]) => actual[rel] === hash);

  return {
    ok: matches,
    reason: matches ? 'Workspace matches the checkpoint exactly.' : 'Workspace does not match the checkpoint after restore.',
    files: Object.keys(actual).length,
  };
}
