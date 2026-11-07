import { execFile } from 'node:child_process';
import { WORKSPACE_DIR } from './paths.mjs';

/**
 * Environment for verification commands.
 *
 * A child process must not inherit the caller's test-runner context. Node's own
 * runner refuses to start nested runs ("skipping running files"), which would
 * silently turn a failing suite into a passing check. Stripping the marker
 * variables keeps verification honest whether Earnest is driven by the server,
 * a script, or a test harness.
 */
export function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  delete env.NODE_V8_COVERAGE;
  env.NO_COLOR = '1';
  return env;
}

/** Run an allowlisted command inside the disposable workspace only. */
export function runCommandInWorkspace(command, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(
      'bash',
      ['-c', command],
      { cwd: WORKSPACE_DIR, timeout: timeoutMs, env: cleanEnv(), maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          ms: Date.now() - started,
        });
      },
    );
  });
}
