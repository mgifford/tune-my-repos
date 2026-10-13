const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseDependabotTitle,
  parseDependabotBodyUpdates,
  combineUpdateTypes,
  combineDependencyClasses,
  describeDependencies,
  classifyFromPackageLock,
  npmManifestDir,
  summarizeCiStatus,
  findFailedCheckRun,
} = require('../scripts/generate-maintenance-rollup.cjs');

const run = (status, conclusion, name = 'test') => ({ status, conclusion, name });

// --- CI status (regression: Actions-only PRs always read "pending") ---

test('summarizeCiStatus: successful Actions check run with no legacy statuses is passing', () => {
  assert.equal(summarizeCiStatus([run('completed', 'success')], { state: 'pending', total_count: 0 }), 'passing');
});

test('summarizeCiStatus: any failing conclusion wins', () => {
  assert.equal(summarizeCiStatus([run('completed', 'success'), run('completed', 'timed_out')], null), 'failing');
});

test('summarizeCiStatus: an in-progress run is pending', () => {
  assert.equal(summarizeCiStatus([run('completed', 'success'), run('in_progress', null)], null), 'pending');
});

test('summarizeCiStatus: skipped and neutral runs are ignored', () => {
  assert.equal(summarizeCiStatus([run('completed', 'skipped'), run('completed', 'success')], null), 'passing');
});

test('summarizeCiStatus: a failing legacy status counts', () => {
  assert.equal(summarizeCiStatus([run('completed', 'success')], { state: 'failure', total_count: 1 }), 'failing');
});

test('summarizeCiStatus: no checks of any kind is none, not pending', () => {
  assert.equal(summarizeCiStatus([], { state: 'pending', total_count: 0 }), 'none');
});

test('summarizeCiStatus: unreadable data is unknown', () => {
  assert.equal(summarizeCiStatus(null, null), 'unknown');
});

test('findFailedCheckRun: returns the first failing run, ignoring skipped', () => {
  const failed = findFailedCheckRun([run('completed', 'skipped', 'a'), run('completed', 'cancelled', 'b')]);
  assert.equal(failed.name, 'b');
  assert.equal(findFailedCheckRun([run('completed', 'success')]), null);
});

// --- Title and body parsing ---

test('parseDependabotTitle: conventional-commit prefix and "in /dir" suffix', () => {
  assert.deepEqual(parseDependabotTitle('chore(deps): bump lodash from 4.17.20 to 4.17.21 in /web'),
    { dependencyName: 'lodash', versionFrom: '4.17.20', versionTo: '4.17.21' });
});

test('parseDependabotTitle: pip/bundler "Update X requirement from" form', () => {
  assert.deepEqual(parseDependabotTitle('Update requests requirement from ~=2.31 to ~=2.32'),
    { dependencyName: 'requests', versionFrom: '~=2.31', versionTo: '~=2.32' });
});

test('parseDependabotTitle: grouped title has no single version', () => {
  assert.equal(parseDependabotTitle('Bump the npm_and_yarn group across 1 directory with 2 updates'), null);
});

test('parseDependabotBodyUpdates: lists each update in a grouped PR body, deduplicated', () => {
  const body = [
    'Bumps the npm_and_yarn group with 2 updates.',
    'Updates `brace-expansion` from 2.1.4 to 2.1.7',
    '- [Release notes](https://example.invalid)',
    'Updates `brace-expansion` from 2.1.4 to 2.1.7',
    'Updates `vite` from 5.4.1 to 6.0.0.',
  ].join('\n');
  assert.deepEqual(parseDependabotBodyUpdates(body), [
    { dependencyName: 'brace-expansion', versionFrom: '2.1.4', versionTo: '2.1.7' },
    { dependencyName: 'vite', versionFrom: '5.4.1', versionTo: '6.0.0' },
  ]);
});

test('parseDependabotBodyUpdates: empty or missing body returns no updates', () => {
  assert.deepEqual(parseDependabotBodyUpdates(null), []);
});

test('combineUpdateTypes: riskiest wins; any unknown makes the PR unknown', () => {
  assert.equal(combineUpdateTypes(['patch', 'major', 'minor']), 'major');
  assert.equal(combineUpdateTypes(['patch', 'unknown']), 'unknown');
  assert.equal(combineUpdateTypes([]), 'unknown');
});

test('combineDependencyClasses: conservative combination', () => {
  assert.equal(combineDependencyClasses(['development', 'development']), 'development');
  assert.equal(combineDependencyClasses(['development', 'production']), 'production');
  assert.equal(combineDependencyClasses(['development', 'unknown']), 'unknown');
  assert.equal(combineDependencyClasses([]), 'unknown');
});

test('describeDependencies: caps long lists', () => {
  assert.equal(describeDependencies(['a', 'b']), 'a, b');
  assert.equal(describeDependencies(['a', 'b', 'c', 'd', 'e']), 'a, b, c (+2 more)');
});

// --- Transitive dependency classification from package-lock.json ---

test('classifyFromPackageLock: transitive dev-only dependency is development', () => {
  const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/brace-expansion': { version: '2.1.4', dev: true } } };
  assert.equal(classifyFromPackageLock(lock, 'brace-expansion'), 'development');
});

test('classifyFromPackageLock: any non-dev copy makes it production', () => {
  const lock = { packages: {
    'node_modules/ms': { dev: true },
    'node_modules/debug/node_modules/ms': {},
  } };
  assert.equal(classifyFromPackageLock(lock, 'ms'), 'production');
});

test('classifyFromPackageLock: devOptional is treated as production', () => {
  const lock = { packages: { 'node_modules/fsevents': { devOptional: true } } };
  assert.equal(classifyFromPackageLock(lock, 'fsevents'), 'production');
});

test('classifyFromPackageLock: does not match a package whose name merely ends the same', () => {
  const lock = { packages: { 'node_modules/not-ms': { dev: true } } };
  assert.equal(classifyFromPackageLock(lock, 'ms'), null);
});

test('classifyFromPackageLock: scoped packages match', () => {
  const lock = { packages: { 'node_modules/@babel/core': { dev: true } } };
  assert.equal(classifyFromPackageLock(lock, '@babel/core'), 'development');
});

test('classifyFromPackageLock: lockfileVersion 1 uses dependencies map', () => {
  assert.equal(classifyFromPackageLock({ lockfileVersion: 1, dependencies: { a: { dev: true } } }, 'a'), 'development');
  assert.equal(classifyFromPackageLock({ lockfileVersion: 1, dependencies: { a: {} } }, 'a'), 'production');
});

test('classifyFromPackageLock: missing lock or package returns null', () => {
  assert.equal(classifyFromPackageLock(null, 'a'), null);
  assert.equal(classifyFromPackageLock({ packages: {} }, 'a'), null);
});

test('npmManifestDir: root and nested manifests', () => {
  assert.equal(npmManifestDir(['package-lock.json']), '');
  assert.equal(npmManifestDir(['web/package.json', 'web/package-lock.json']), 'web/');
  assert.equal(npmManifestDir(['.github/workflows/ci.yml']), '');
});
