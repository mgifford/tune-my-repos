const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validatePolicySchema } = require('../policy/policy-validator.cjs');
const { classifyUpdate } = require('../policy/policy-engine.cjs');

const rollupSchema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'policy', 'rollup.schema.json'), 'utf8')
);
const sampleRollup = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'maintenance-rollup.sample.json'), 'utf8')
);
const policy = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'maintenance-policy.json'), 'utf8')
);

test('the sample rollup fixture conforms to rollup.schema.json', () => {
  const errors = validatePolicySchema(sampleRollup, rollupSchema);
  assert.deepEqual(errors, []);
});

test('sample rollup covers all four dashboard categories: eligible, needs_review, needs_repair evidence, and unavailable coverage', () => {
  const repo = sampleRollup.repositories[0];
  const riskStates = repo.dependabot_prs.map((pr) => pr.risk_state);

  assert.ok(riskStates.includes('eligible'), 'fixture should include an eligible PR');
  assert.ok(riskStates.includes('needs_review'), 'fixture should include a needs_review PR');
  assert.ok(repo.failed_update_prs.length > 0, 'fixture should include at least one failed update PR');
  assert.ok(
    Object.values(repo.coverage).some((v) => v === 'unknown' || v === 'not_available'),
    'fixture should demonstrate at least one unknown/not_available coverage field'
  );
  assert.ok(
    repo.security_alerts.critical > 0 || repo.security_alerts.high > 0,
    'fixture should include at least one urgent (critical/high) security alert'
  );
});

test('every dependabot PR risk_state in the fixture matches what classifyUpdate would compute from its stated inputs', () => {
  const repo = sampleRollup.repositories[0];
  for (const pr of repo.dependabot_prs) {
    const result = classifyUpdate(policy, {
      repository: repo.full_name,
      dependency_class: pr.dependency_class,
      update_type: pr.update_type,
      required_ci_passed: pr.ci_status === 'passing',
      touches_workflow_permissions: false,
      is_lockfile_only: false,
      is_generated_output_only: false,
      requires_new_secret_or_elevated_access: false,
      required_check_failed: false,
    });
    assert.equal(
      result.risk_state,
      pr.risk_state,
      `PR #${pr.number} (${pr.dependency_name}) fixture risk_state should match policy engine output`
    );
  }
});
