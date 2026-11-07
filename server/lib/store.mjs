import fs from 'node:fs/promises';
import path from 'node:path';
import { STATE_FILE, RUNTIME_DIR } from './paths.mjs';
import { ensureDir, exists } from './fsutil.mjs';

/** Serialises writes so concurrent requests cannot interleave state updates. */
let queue = Promise.resolve();

function initialState() {
  return {
    version: 1,
    projectId: 'workshop-demo',
    projectName: 'Workshop sample site',
    trust: 5,
    trustHistory: [
      {
        id: 'trust-seed',
        at: new Date().toISOString(),
        from: 5,
        to: 5,
        reason: 'New agent/project pairing starts at the suggested level of 5/10.',
        taskId: null,
      },
    ],
    ledger: [],
    tasks: [],
    run: null,
    incident: null,
    badges: [],
    createdAt: new Date().toISOString(),
  };
}

export async function readState() {
  await ensureDir(RUNTIME_DIR);
  if (!(await exists(STATE_FILE))) {
    const fresh = initialState();
    await writeState(fresh);
    return fresh;
  }
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    const fresh = initialState();
    await writeState(fresh);
    return fresh;
  }
}

export async function writeState(state) {
  await ensureDir(RUNTIME_DIR);
  const tmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, STATE_FILE);
  return state;
}

/** Run `fn` with exclusive access to state. */
export function update(fn) {
  const next = queue.then(async () => {
    const state = await readState();
    const result = await fn(state);
    await writeState(state);
    return result ?? state;
  });
  queue = next.catch(() => {});
  return next;
}

export function nextId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function logEvent(state, event) {
  const entry = {
    id: nextId('evt'),
    at: new Date().toISOString(),
    ...event,
  };
  state.ledger.unshift(entry);
  if (state.ledger.length > 400) state.ledger.length = 400;
  return entry;
}

export { initialState };
