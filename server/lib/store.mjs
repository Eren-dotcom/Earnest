import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { STATE_FILE, RUNTIME_DIR } from './paths.mjs';
import { ensureDir, exists } from './fsutil.mjs';

/** Serialises writes so concurrent requests cannot interleave state updates. */
let queue = Promise.resolve();

const ZERO_HASH = '0'.repeat(64);
const LEDGER_LIMIT = 400;
const ARCHIVE_LIMIT = 5000;

/** Stable stringify: JSON key order must not change an event's hash. */
function canonical(value) {
  if (value === null || value === undefined || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

/** Hash of an event, excluding the hash field itself. */
export function eventHash(entry) {
  const { hash, ...rest } = entry;
  return createHash('sha256').update(canonical(rest)).digest('hex');
}

function initialState() {
  return {
    version: 2,
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
    ledgerArchive: [],
    ledgerHead: ZERO_HASH,
    ledgerSeq: 0,
    incidents: [],
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
    const state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    // Migrate an older state file without discarding its history.
    if (!Array.isArray(state.ledgerArchive)) state.ledgerArchive = [];
    if (typeof state.ledgerHead !== 'string') state.ledgerHead = state.ledger?.[0]?.hash ?? ZERO_HASH;
    if (typeof state.ledgerSeq !== 'number') state.ledgerSeq = state.ledger?.[0]?.seq ?? 0;
    if (!Array.isArray(state.incidents)) state.incidents = [];
    if (typeof state.version !== 'number') state.version = 2;
    return state;
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

/**
 * Append a tamper-evident event. Each event carries the hash of the event
 * before it, so editing or deleting a historical entry breaks the chain at
 * that point. Old events are archived rather than silently dropped.
 */
export function logEvent(state, event) {
  const prevHash = state.ledgerHead ?? state.ledger?.[0]?.hash ?? ZERO_HASH;
  const entry = {
    id: nextId('evt'),
    at: new Date().toISOString(),
    seq: (state.ledgerSeq ?? 0) + 1,
    ...event,
    prevHash,
  };
  entry.hash = eventHash(entry);

  state.ledger.unshift(entry);
  state.ledgerHead = entry.hash;
  state.ledgerSeq = entry.seq;

  if (state.ledger.length > LEDGER_LIMIT) {
    const overflow = state.ledger.splice(LEDGER_LIMIT);
    state.ledgerArchive.unshift(...overflow);
    if (state.ledgerArchive.length > ARCHIVE_LIMIT) state.ledgerArchive.length = ARCHIVE_LIMIT;
  }
  return entry;
}

/** Start a fresh, empty chain. Used by the reset endpoint. */
export function resetLedger(state) {
  state.ledger = [];
  state.ledgerArchive = [];
  state.ledgerHead = ZERO_HASH;
  state.ledgerSeq = 0;
}

/**
 * Walk every event from newest to oldest, recompute its hash, and confirm the
 * prevHash link. A truncated archive tail is reported honestly rather than
 * being called a broken chain.
 */
export function verifyLedger(state) {
  const all = [...(state.ledger ?? []), ...(state.ledgerArchive ?? [])];
  const head = state.ledgerHead ?? ZERO_HASH;
  if (!all.length) {
    return { ok: head === ZERO_HASH, count: 0, head, reason: 'The ledger is empty.' };
  }
  if (all[0].hash !== head) {
    return { ok: false, count: all.length, head, badId: all[0].id, reason: 'The stored head hash does not match the newest event.' };
  }

  let truncated = false;
  for (let i = 0; i < all.length; i += 1) {
    const entry = all[i];
    if (typeof entry.hash !== 'string' || eventHash(entry) !== entry.hash) {
      return {
        ok: false,
        count: all.length,
        head,
        badIndex: i,
        badId: entry.id,
        reason: `Event ${entry.id} does not match its recorded hash (or predates hash chaining).`,
      };
    }
    const older = all[i + 1];
    if (older) {
      if (entry.prevHash !== older.hash) {
        return {
          ok: false,
          count: all.length,
          head,
          badIndex: i,
          badId: entry.id,
          reason: `The chain is broken between events ${entry.id} and ${older.id}.`,
        };
      }
    } else if (entry.prevHash !== ZERO_HASH && (state.ledgerArchive ?? []).length >= ARCHIVE_LIMIT) {
      truncated = true;
    }
  }

  return {
    ok: true,
    count: all.length,
    head,
    truncated,
    reason: truncated
      ? `All ${all.length} retained events are intact. The archived tail was pruned, so the oldest links are no longer present.`
      : `All ${all.length} events verified. Each hash matches its contents and its predecessor.`,
  };
}

export { initialState, ZERO_HASH };
