const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  validatePolicyInvariants,
  repositoryMatchesPattern,
  isRepositoryInPolicy,
  getRepositoryTier,
  findActiveOverride,
  classifyUpdate,
} = require('../policy/policy-engine.js');

const policy = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'maintenance-policy.json'), 'utf8')
);

function baseUpdate(overrides = {}) {
  return {
    repository: 'mgifford/tune-my-repos',
    dependency_class: 'development',
    update_type: 'patch',
    required_ci_passed: true,
    touches_workflow_permissions: false,
    is_lockfile_only: false,
    is_generated_output_only: false,
    requires_new_secret_or_elevated_access: false,
    required_check_failed: false,
    ...overrides,
  };
}

test('validatePolicyInvariants passes on the real policy file', () => {
  const errors = validatePolicyInvariants(policy);
  assert.deepEqual(errors, []);
});

test('validatePolicyInvariants flags missing dependency classes', () => {
  const broken = JSON.parse(JSON.stringify(policy));
  delete broken.dependency_classes['production'];
  const errors = validatePolicyInvariants(broken);
  assert.ok(errors.some((e) => e.includes('production')));
});

test('validatePolicyInvariants flags an expired override', () => {
  const withExpired = JSON.parse(JSON.stringify(policy));
  withExpired.overrides.push({
    repository: 'mgifford/tune-my-repos',
    dependency_name: 'left-pad',
    ecosystem: 'npm',
    risk_state: 'eligible',
    reason: 'stale',
    expires: '2020-01-01',
  });
  const errors = validatePolicyInvariants(withExpired);
  assert.ok(errors.some((e) => e.includes('expired')));
});

test('repositoryMatchesPattern: exact match', () => {
  assert.equal(repositoryMatchesPattern('mgifford/tune-my-repos', 'mgifford/tune-my-repos'), true);
  assert.equal(repositoryMatchesPattern('mgifford/other-repo', 'mgifford/tune-my-repos'), false);
});

test('repositoryMatchesPattern: owner glob', () => {
  assert.equal(repositoryMatchesPattern('mgifford/anything', 'mgifford/*'), true);
  assert.equal(repositoryMatchesPattern('someoneelse/anything', 'mgifford/*'), false);
});

test('isRepositoryInPolicy: included repo is in scope', () => {
  assert.equal(isRepositoryInPolicy(policy, 'mgifford/tune-my-repos'), true);
});

test('isRepositoryInPolicy: repo not listed is out of scope', () => {
  assert.equal(isRepositoryInPolicy(policy, 'mgifford/not-in-policy'), false);
});

test('isRepositoryInPolicy: excluded repo overrides an include glob', () => {
  const withExclude = JSON.parse(JSON.stringify(policy));
  withExclude.repositories.include = ['mgifford/*'];
  withExclude.repositories.exclude = ['mgifford/archived-repo'];
  assert.equal(isRepositoryInPolicy(withExclude, 'mgifford/archived-repo'), false);
  assert.equal(isRepositoryInPolicy(withExclude, 'mgifford/tune-my-repos'), true);
});

test('getRepositoryTier: defaults to manual when unlisted', () => {
  assert.equal(getRepositoryTier(policy, 'mgifford/unlisted-repo'), 'manual');
});

test('getRepositoryTier: returns pilot for the pilot repo', () => {
  assert.equal(getRepositoryTier(policy, 'mgifford/tune-my-repos'), 'pilot');
});

test('findActiveOverride: returns null when no override matches', () => {
  assert.equal(findActiveOverride(policy, { repository: 'x', dependency_name: 'y', ecosystem: 'npm' }), null);
});

test('findActiveOverride: finds a matching non-expired override', () => {
  const withOverride = JSON.parse(JSON.stringify(policy));
  withOverride.overrides.push({
    repository: 'mgifford/tune-my-repos',
    dependency_name: 'left-pad',
    ecosystem: 'npm',
    risk_state: 'eligible',
    reason: 'manually reviewed',
    expires: '2099-01-01',
  });
  const found = findActiveOverride(
    withOverride,
    { repository: 'mgifford/tune-my-repos', dependency_name: 'left-pad', ecosystem: 'npm' },
    '2026-10-03'
  );
  assert.ok(found);
  assert.equal(found.risk_state, 'eligible');
});

test('findActiveOverride: ignores an expired override', () => {
  const withExpired = JSON.parse(JSON.stringify(policy));
  withExpired.overrides.push({
    repository: 'mgifford/tune-my-repos',
    dependency_name: 'left-pad',
    ecosystem: 'npm',
    risk_state: 'eligible',
    reason: 'stale',
    expires: '2020-01-01',
  });
  const found = findActiveOverride(
    withExpired,
    { repository: 'mgifford/tune-my-repos', dependency_name: 'left-pad', ecosystem: 'npm' },
    '2026-10-03'
  );
  assert.equal(found, null);
});

test('classifyUpdate: repo outside policy scope is ignored', () => {
  const result = classifyUpdate(policy, baseUpdate({ repository: 'mgifford/not-in-policy' }));
  assert.equal(result.risk_state, 'ignored');
});

test('classifyUpdate: github-actions patch with passing CI is eligible', () => {
  const result = classifyUpdate(policy, baseUpdate({
    dependency_class: 'github-actions',
    update_type: 'patch',
    required_ci_passed: true,
  }));
  assert.equal(result.risk_state, 'eligible');
  assert.equal(result.tier, 'pilot');
});

test('classifyUpdate: github-actions minor without CI pass needs review', () => {
  const result = classifyUpdate(policy, baseUpdate({
    dependency_class: 'github-actions',
    update_type: 'minor',
    required_ci_passed: false,
  }));
  assert.equal(result.risk_state, 'needs_review');
});

test('classifyUpdate: github-actions major is always needs_review even with passing CI', () => {
  const result = classifyUpdate(policy, baseUpdate({
    dependency_class: 'github-actions',
    update_type: 'major',
    required_ci_passed: true,
  }));
  assert.equal(result.risk_state, 'needs_review');
});

test('classifyUpdate: development patch with passing CI is eligible', () => {
  const result = classifyUpdate(policy, baseUpdate({
    dependency_class: 'development',
    update_type: 'patch',
    required_ci_passed: true,
  }));
  assert.equal(result.risk_state, 'eligible');
});

test('classifyUpdate: production update is always needs_review regardless of update_type', () => {
  for (const updateType of ['patch', 'minor', 'major']) {
    const result = classifyUpdate(policy, baseUpdate({
      dependency_class: 'production',
      update_type: updateType,
      required_ci_passed: true,
    }));
    assert.equal(result.risk_state, 'needs_review', `production/${updateType} should need review`);
  }
});

test('classifyUpdate: major dependency_class is always needs_review', () => {
  const result = classifyUpdate(policy, baseUpdate({ dependency_class: 'major', update_type: 'major' }));
  assert.equal(result.risk_state, 'needs_review');
});

test('classifyUpdate: unknown dependency_class is always needs_review', () => {
  const result = classifyUpdate(policy, baseUpdate({ dependency_class: 'unknown' }));
  assert.equal(result.risk_state, 'needs_review');
});

test('classifyUpdate: unrecognized update_type falls back to unknown handling', () => {
  const result = classifyUpdate(policy, baseUpdate({ dependency_class: 'development', update_type: 'weird' }));
  assert.equal(result.risk_state, 'needs_review');
  assert.match(result.reason, /unknown/i);
});

test('classifyUpdate: workflow permission change is always blocked, even for dev/patch', () => {
  const result = classifyUpdate(policy, baseUpdate({ touches_workflow_permissions: true }));
  assert.equal(result.risk_state, 'blocked');
});

test('classifyUpdate: update requiring a new secret is always blocked', () => {
  const result = classifyUpdate(policy, baseUpdate({ requires_new_secret_or_elevated_access: true }));
  assert.equal(result.risk_state, 'blocked');
});

test('classifyUpdate: failing required check is needs_repair, overriding eligibility', () => {
  const result = classifyUpdate(policy, baseUpdate({
    dependency_class: 'github-actions',
    update_type: 'patch',
    required_ci_passed: true,
    required_check_failed: true,
  }));
  assert.equal(result.risk_state, 'needs_repair');
});

test('classifyUpdate: lockfile-only change needs review even for otherwise-eligible class', () => {
  const result = classifyUpdate(policy, baseUpdate({
    dependency_class: 'development',
    update_type: 'patch',
    is_lockfile_only: true,
  }));
  assert.equal(result.risk_state, 'needs_review');
});

test('classifyUpdate: generated-output-only change needs review', () => {
  const result = classifyUpdate(policy, baseUpdate({ is_generated_output_only: true }));
  assert.equal(result.risk_state, 'needs_review');
});

test('classifyUpdate: active override takes precedence over computed risk_state', () => {
  const withOverride = JSON.parse(JSON.stringify(policy));
  withOverride.overrides.push({
    repository: 'mgifford/tune-my-repos',
    dependency_name: 'left-pad',
    ecosystem: 'npm',
    risk_state: 'eligible',
    reason: 'Pinned patch-only update, manually reviewed',
    expires: '2099-01-01',
  });
  const result = classifyUpdate(withOverride, baseUpdate({
    dependency_class: 'production',
    update_type: 'patch',
    dependency_name: 'left-pad',
    ecosystem: 'npm',
  }));
  assert.equal(result.risk_state, 'eligible');
  assert.equal(result.override_applied, true);
});

test('classifyUpdate: special case still consults override (override can relax a block)', () => {
  const withOverride = JSON.parse(JSON.stringify(policy));
  withOverride.overrides.push({
    repository: 'mgifford/tune-my-repos',
    dependency_name: 'actions/checkout',
    ecosystem: 'github-actions',
    risk_state: 'needs_review',
    reason: 'Reviewed manually; permission change is additive only',
    expires: '2099-01-01',
  });
  const result = classifyUpdate(withOverride, baseUpdate({
    touches_workflow_permissions: true,
    dependency_name: 'actions/checkout',
    ecosystem: 'github-actions',
  }));
  assert.equal(result.risk_state, 'needs_review');
  assert.equal(result.override_applied, true);
});
