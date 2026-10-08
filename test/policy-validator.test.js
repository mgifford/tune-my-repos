const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validatePolicySchema } = require('../policy/policy-validator.cjs');

const schema = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'policy', 'policy.schema.json'), 'utf8')
);
const policy = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'maintenance-policy.json'), 'utf8')
);

test('the real maintenance-policy.json conforms to policy.schema.json', () => {
  const errors = validatePolicySchema(policy, schema);
  assert.deepEqual(errors, []);
});

test('validatePolicySchema rejects a missing required top-level field', () => {
  const broken = JSON.parse(JSON.stringify(policy));
  delete broken.policy_version;
  const errors = validatePolicySchema(broken, schema);
  assert.ok(errors.some((e) => e.includes('policy_version')));
});

test('validatePolicySchema rejects an unexpected top-level property', () => {
  const broken = JSON.parse(JSON.stringify(policy));
  broken.unexpected_field = true;
  const errors = validatePolicySchema(broken, schema);
  assert.ok(errors.some((e) => e.includes('unexpected_field')));
});

test('validatePolicySchema rejects a bad policy_version format', () => {
  const broken = JSON.parse(JSON.stringify(policy));
  broken.policy_version = 'v1';
  const errors = validatePolicySchema(broken, schema);
  assert.ok(errors.some((e) => e.includes('policy_version')));
});

test('validatePolicySchema rejects an invalid risk_state enum value', () => {
  const broken = JSON.parse(JSON.stringify(policy));
  broken.dependency_classes.production.patch.risk_state = 'always_allow';
  const errors = validatePolicySchema(broken, schema);
  assert.ok(errors.some((e) => e.includes('always_allow')));
});

test('validatePolicySchema rejects an override missing a reason', () => {
  const broken = JSON.parse(JSON.stringify(policy));
  broken.overrides.push({
    repository: 'mgifford/tune-my-repos',
    dependency_name: 'left-pad',
    ecosystem: 'npm',
    risk_state: 'eligible',
    expires: '2099-01-01',
  });
  const errors = validatePolicySchema(broken, schema);
  assert.ok(errors.some((e) => e.includes('reason')));
});

test('validatePolicySchema rejects a negative attention threshold', () => {
  const broken = JSON.parse(JSON.stringify(policy));
  broken.attention_thresholds.max_age_days_open_pr = -1;
  const errors = validatePolicySchema(broken, schema);
  assert.ok(errors.some((e) => e.includes('max_age_days_open_pr')));
});
