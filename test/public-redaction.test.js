const test = require('node:test');
const assert = require('node:assert/strict');

const { redactExactAlertCounts } = require('../policy/public-redaction.js');

function sampleRollup(hasUrgent) {
  return {
    schema_version: '1.0.0',
    run_timestamp: '2026-10-04T00:00:00Z',
    policy_version: '1.0.0',
    repositories: [
      {
        full_name: 'mgifford/tune-my-repos',
        security_alerts: { critical: 3, high: 1, moderate: 2, low: 5, has_urgent_alerts: hasUrgent },
        dependabot_prs: [],
      },
    ],
  };
}

test('redactExactAlertCounts: strips exact critical/high/moderate/low counts', () => {
  const redacted = redactExactAlertCounts(sampleRollup(true));
  const alerts = redacted.repositories[0].security_alerts;
  assert.deepEqual(alerts, { has_urgent_alerts: true });
  assert.equal('critical' in alerts, false);
  assert.equal('high' in alerts, false);
  assert.equal('moderate' in alerts, false);
  assert.equal('low' in alerts, false);
});

test('redactExactAlertCounts: preserves has_urgent_alerts value when false', () => {
  const redacted = redactExactAlertCounts(sampleRollup(false));
  assert.equal(redacted.repositories[0].security_alerts.has_urgent_alerts, false);
});

test('redactExactAlertCounts: leaves other repository fields (e.g. dependabot_prs) untouched', () => {
  const rollup = sampleRollup(true);
  rollup.repositories[0].dependabot_prs = [{ number: 1, dependency_name: 'eslint' }];
  const redacted = redactExactAlertCounts(rollup);
  assert.deepEqual(redacted.repositories[0].dependabot_prs, [{ number: 1, dependency_name: 'eslint' }]);
});

test('redactExactAlertCounts: does not mutate the original rollup object', () => {
  const rollup = sampleRollup(true);
  redactExactAlertCounts(rollup);
  assert.equal(rollup.repositories[0].security_alerts.critical, 3);
});
