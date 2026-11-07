import path from 'node:path';

/**
 * Policy enforcement.
 *
 * The plan is explicit that permissions must not rely on a system prompt: the
 * agent has to be technically unable to write outside the approved scope. Every
 * mutating action passes through `authorize()` before it touches the filesystem,
 * so an out-of-scope edit is blocked rather than merely reported afterwards.
 */

/** Paths that are never writable, regardless of the contract. */
const HARD_DENY = [/^\.git\//, /^node_modules\//, /^\.earnest\//, /^package-lock\.json$/];
const HARD_DENY_NAMES = new Set(['.env', '.env.local', '.npmrc', '.git-credentials']);

export const WRITE_ACTIONS = new Set(['write', 'delete', 'create']);

/**
 * Normalise an agent-supplied path into a safe repo-relative POSIX path.
 * Returns null when the path is absolute, escapes the workspace, or is empty.
 */
export function normalizePath(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().replace(/\\/g, '/');
  if (!trimmed) return null;
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) return null;
  if (trimmed.includes('\0')) return null;

  const normalized = path.posix.normalize(trimmed).replace(/^\.\//, '');
  if (normalized === '.' || normalized === '..') return null;
  if (normalized.startsWith('../') || normalized.includes('/../')) return null;
  return normalized;
}

export function isHardDenied(rel) {
  const base = rel.split('/').pop();
  if (HARD_DENY_NAMES.has(base)) return true;
  if (base.startsWith('.env')) return true;
  return HARD_DENY.some((re) => re.test(rel));
}

/** Match a repo-relative path against contract patterns such as `src/**`. */
export function matchesPattern(rel, pattern) {
  if (pattern === rel) return true;
  if (!pattern.includes('*')) return false;

  const escaped = pattern
    .split('')
    .map((ch) => (ch === '*' ? '\u0000' : ch.replace(/[.+^${}()|[\]\\?]/g, '\\$&')))
    .join('')
    .replace(/\u0000\u0000/g, '.*')
    .replace(/\u0000/g, '[^/]*');

  return new RegExp(`^${escaped}$`).test(rel);
}

/**
 * Decide whether an action is permitted.
 *
 * Returns one of:
 *   { decision: 'allow' }
 *   { decision: 'deny', reason, code }
 *
 * `code` separates ordinary scope violations from serious safety stops so the
 * engine can apply the right consequence.
 */
export function authorize(action, contract) {
  // Commands carry no path, so they are decided before path checks.
  if (action.type === 'run') {
    const permitted = (contract.allowedCommands ?? []).includes(action.command);
    if (!permitted) {
      return {
        decision: 'deny',
        code: 'forbidden-command',
        reason: `Command "${action.command}" is not on the allowlist for this task.`,
      };
    }
    return { decision: 'allow' };
  }

  const normalized = normalizePath(action.path);
  if (!normalized) {
    return {
      decision: 'deny',
      code: 'unsafe-path',
      reason: `Path "${action.path}" is not a safe workspace-relative path.`,
    };
  }

  if (isHardDenied(normalized)) {
    return {
      decision: 'deny',
      code: 'forbidden-path',
      reason: `"${normalized}" is protected and can never be modified by the agent.`,
    };
  }

  const allowed = contract.allowedPaths ?? [];

  if (WRITE_ACTIONS.has(action.type)) {
    if (action.type === 'delete' && !contract.allowDelete) {
      return {
        decision: 'deny',
        code: 'forbidden-action',
        reason: 'Deleting files is not enabled for this task.',
      };
    }
    const permitted = allowed.some((pattern) => matchesPattern(normalized, pattern));
    if (!permitted) {
      return {
        decision: 'deny',
        code: 'out-of-scope',
        reason: `"${normalized}" is outside the approved scope for this task (allowed: ${allowed.join(', ') || 'none'}).`,
      };
    }
    return { decision: 'allow', path: normalized };
  }

  if (action.type === 'read' || action.type === 'inspect') {
    return { decision: 'allow', path: normalized };
  }

  if (action.type === 'run') {
    const permitted = (contract.allowedCommands ?? []).includes(action.command);
    if (!permitted) {
      return {
        decision: 'deny',
        code: 'forbidden-command',
        reason: `Command "${action.command}" is not on the allowlist for this task.`,
      };
    }
    return { decision: 'allow' };
  }

  return { decision: 'deny', code: 'unknown-action', reason: `Unknown action type "${action.type}".` };
}
