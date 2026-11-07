import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (one level above `server/`). */
export const ROOT = path.resolve(here, '..', '..');

/**
 * Everything Earnest owns at runtime lives here; it is git-ignored.
 * Overridable so tests (and parallel runs) can use an isolated directory
 * instead of fighting over the same workspace.
 */
export const RUNTIME_DIR = process.env.EARNEST_RUNTIME
  ? path.resolve(process.env.EARNEST_RUNTIME)
  : path.join(ROOT, '.earnest');

/** Pristine copy of the sample project, used as the demo baseline. */
export const SEED_DIR = path.join(here, '..', 'seed');

/** The disposable, checkpointed workspace the agent is allowed to edit. */
export const WORKSPACE_DIR = path.join(RUNTIME_DIR, 'workspace');

/** Snapshot storage. */
export const CHECKPOINT_DIR = path.join(RUNTIME_DIR, 'checkpoints');

/** Persisted application state (trust, tasks, ledger). */
export const STATE_FILE = path.join(RUNTIME_DIR, 'state.json');

/** Static assets served to the browser. */
export const PUBLIC_DIR = path.join(ROOT, 'public');
