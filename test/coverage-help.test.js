const test = require('node:test');
const assert = require('node:assert/strict');

const { COVERAGE_HELP, summarizeCoverageGaps } = require('../policy/coverage-help.cjs');
const { combineBranchProtection, securitySettingStatus } = require('../scripts/generate-maintenance-rollup.cjs');

const repo = (full_name, coverage) => ({ full_name, coverage });

test('summarizeCoverageGaps: groups by signal and status, most widespread first', () => {
  const groups = summarizeCoverageGaps([
    repo('o/a', { dependabot_alerts: 'unknown', secret_scanning: 'not_available', dependency_graph: 'available' }),
    repo('o/b', { dependabot_alerts: 'unknown', secret_scanning: 'available' }),
  ]);
  assert.deepEqual(groups.map((g) => [g.field, g.status, g.repos]), [
    ['dependabot_alerts', 'unknown', ['o/a', 'o/b']],
    ['secret_scanning', 'not_available', ['o/a']],
  ]);
  assert.match(groups[0].help, /Dependabot alerts: Read-only/);
});

test('summarizeCoverageGaps: no gaps means no groups', () => {
  assert.deepEqual(summarizeCoverageGaps([repo('o/a', { dependabot_alerts: 'available' })]), []);
});

test('summarizeCoverageGaps: an unrecognised signal still gets a readable label', () => {
  const [group] = summarizeCoverageGaps([repo('o/a', { new_signal: 'unknown' })]);
  assert.equal(group.label, 'new signal');
  assert.equal(group.help, 'No further detail available.');
});

test('COVERAGE_HELP: every signal the scanner reports has help for "unknown"', () => {
  for (const field of ['dependency_graph', 'dependabot_alerts', 'dependabot_security_updates', 'secret_scanning', 'codeql_default_setup', 'branch_protection']) {
    assert.ok(COVERAGE_HELP[field] && COVERAGE_HELP[field].unknown, field);
  }
});

test('combineBranchProtection: a ruleset counts as protection even when classic is unreadable', () => {
  assert.equal(combineBranchProtection('unknown', [{ type: 'deletion' }]), 'available');
  assert.equal(combineBranchProtection('available', []), 'available');
});

test('combineBranchProtection: unprotected only when both are readable and empty', () => {
  assert.equal(combineBranchProtection('not_available', []), 'not_available');
  assert.equal(combineBranchProtection('unknown', []), 'unknown');
  assert.equal(combineBranchProtection('not_available', null), 'unknown');
});

test('securitySettingStatus: missing security_and_analysis is unknown, not off', () => {
  assert.equal(securitySettingStatus({ private: false }, 'secret_scanning'), 'unknown');
  assert.equal(securitySettingStatus(null, 'secret_scanning'), 'unknown');
  assert.equal(securitySettingStatus({ security_and_analysis: { secret_scanning: { status: 'enabled' } } }, 'secret_scanning'), 'available');
  assert.equal(securitySettingStatus({ security_and_analysis: { secret_scanning: { status: 'disabled' } } }, 'secret_scanning'), 'not_available');
});
