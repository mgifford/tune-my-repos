const test = require('node:test');
const assert = require('node:assert/strict');

const { detectEcosystems, buildDependabotYml, parseArgs, plannedActions } = require('../scripts/enable-security-defaults.cjs');

const allOff = { alerts: false, securityUpdates: false, secretScanning: false, pushProtection: false, privateReporting: false };

test('detectEcosystems: maps manifests and workflows, deduplicated and sorted', () => {
  assert.deepEqual(
    detectEcosystems(['package.json', 'requirements.txt', 'pyproject.toml', 'README.md'], true),
    ['github-actions', 'npm', 'pip'],
  );
});

test('detectEcosystems: no manifests means no ecosystems', () => {
  assert.deepEqual(detectEcosystems(['README.md'], false), []);
});

test('buildDependabotYml: weekly, grouped, with cooldown', () => {
  const yml = buildDependabotYml(['npm']);
  assert.match(yml, /package-ecosystem: "npm"/);
  assert.match(yml, /interval: "weekly"/);
  assert.match(yml, /default-days: 3/);
  assert.match(yml, /"minor"/);
  assert.doesNotMatch(yml, /"major"/);
});

test('parseArgs: dry run by default; --apply must be explicit', () => {
  assert.equal(parseArgs(['--owner', 'mgifford']).apply, false);
  assert.equal(parseArgs(['--owner', 'mgifford', '--apply']).apply, true);
});

test('parseArgs: rejects missing/invalid owner and unknown flags', () => {
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--owner', 'bad/owner']));
  assert.throws(() => parseArgs(['--owner', 'mgifford', '--nope']));
});

test('plannedActions: public repo gets all four settings', () => {
  const names = plannedActions({ full_name: 'o/r', private: false }, allOff).map((a) => a.name);
  assert.equal(names.length, 4);
});

test('plannedActions: private repo skips secret scanning and private reporting', () => {
  const names = plannedActions({ full_name: 'o/r', private: true }, allOff).map((a) => a.name);
  assert.deepEqual(names, ['Dependabot alerts', 'Dependabot security updates']);
});

test('plannedActions: idempotent when already at baseline', () => {
  const on = { alerts: true, securityUpdates: true, secretScanning: true, pushProtection: true, privateReporting: true };
  assert.deepEqual(plannedActions({ full_name: 'o/r', private: false }, on), []);
});
