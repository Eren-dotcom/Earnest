import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authorize, normalizePath, matchesPattern, isHardDenied } from '../server/lib/policy.mjs';

const contract = {
  allowedPaths: ['src/HeroImage.js'],
  allowedCommands: ['node --test'],
  allowDelete: false,
};

test('normalizePath rejects absolute and escaping paths', () => {
  assert.equal(normalizePath('/etc/passwd'), null);
  assert.equal(normalizePath('../outside.js'), null);
  assert.equal(normalizePath('src/../../escape.js'), null);
  assert.equal(normalizePath('C:\\Windows\\system.ini'), null);
  assert.equal(normalizePath(''), null);
});

test('normalizePath accepts and cleans relative paths', () => {
  assert.equal(normalizePath('src/./HeroImage.js'), 'src/HeroImage.js');
  assert.equal(normalizePath('./src/HeroImage.js'), 'src/HeroImage.js');
});

test('in-scope write is allowed', () => {
  const verdict = authorize({ type: 'write', path: 'src/HeroImage.js' }, contract);
  assert.equal(verdict.decision, 'allow');
});

test('out-of-scope write is denied with the out-of-scope code', () => {
  const verdict = authorize({ type: 'write', path: 'src/Navbar.js' }, contract);
  assert.equal(verdict.decision, 'deny');
  assert.equal(verdict.code, 'out-of-scope');
});

test('protection cannot be bypassed with path tricks', () => {
  for (const attempt of ['src/../src/Navbar.js', '/etc/hosts', '../server/seed/src/Navbar.js']) {
    const verdict = authorize({ type: 'write', path: attempt }, contract);
    assert.equal(verdict.decision, 'deny', `should deny ${attempt}`);
  }
});

test('hard-denied paths stay denied even if the contract allows them', () => {
  const permissive = { allowedPaths: ['**'], allowedCommands: [], allowDelete: true };
  for (const path of ['.git/config', '.earnest/state.json', '.env', 'src/.env.local', 'node_modules/x/index.js']) {
    const verdict = authorize({ type: 'write', path }, permissive);
    assert.equal(verdict.decision, 'deny', `should deny ${path}`);
  }
});

test('isHardDenied flags secrets and metadata', () => {
  assert.ok(isHardDenied('.env'));
  assert.ok(isHardDenied('server/.env.production'));
  assert.ok(isHardDenied('.git/HEAD'));
  assert.ok(!isHardDenied('src/HeroImage.js'));
});

test('unlisted commands are denied, listed ones allowed', () => {
  assert.equal(authorize({ type: 'run', command: 'node --test' }, contract).decision, 'allow');
  const denied = authorize({ type: 'run', command: 'rm -rf /' }, contract);
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.code, 'forbidden-command');
});

test('deletion requires explicit permission', () => {
  const verdict = authorize({ type: 'delete', path: 'src/HeroImage.js' }, contract);
  assert.equal(verdict.decision, 'deny');
  assert.equal(verdict.code, 'forbidden-action');
});

test('reads are not restricted to the write allowlist', () => {
  assert.equal(authorize({ type: 'read', path: 'tests/site.test.mjs' }, contract).decision, 'allow');
});

test('glob patterns match as intended', () => {
  assert.ok(matchesPattern('src/HeroImage.js', 'src/*.js'));
  assert.ok(matchesPattern('src/deep/file.js', 'src/**'));
  assert.ok(!matchesPattern('src/Navbar.js', 'src/HeroImage.js'));
  assert.ok(matchesPattern('a.b.js', '*.js'));
  assert.ok(!matchesPattern('test/a.js', 'src/**'));
});
