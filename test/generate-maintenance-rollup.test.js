const test = require('node:test');
const assert = require('node:assert/strict');

const {
  redact,
  cap,
  parseDependabotTitle,
  semverParts,
  inferUpdateType,
  inferDependencyClass,
  computeRecommendedAction,
} = require('../scripts/generate-maintenance-rollup.js');

test('redact: masks a classic PAT', () => {
  const text = `token is ghp_${'a'.repeat(36)} in the log`;
  assert.ok(!redact(text).includes('ghp_'));
  assert.match(redact(text), /\[redacted-token\]/);
});

test('redact: masks a fine-grained PAT', () => {
  const text = `github_pat_${'b'.repeat(40)}`;
  assert.match(redact(text), /\[redacted-token\]/);
});

test('redact: leaves a plain git sha untouched', () => {
  const sha = 'a'.repeat(40);
  assert.equal(redact(sha), sha);
});

test('redact: masks a long opaque alphanumeric string that is not hex', () => {
  const opaque = 'Zx9' + 'qQ7pR2mN8vL4wT6'.repeat(3);
  assert.match(redact(opaque), /\[redacted\]/);
});

test('cap: truncates text longer than the max and appends a marker', () => {
  const long = 'failure details '.repeat(40); // realistic prose, not an opaque token-shaped string
  const result = cap(long, 500);
  assert.ok(result.endsWith('(truncated)'));
  assert.ok(result.length <= 520);
});

test('cap: leaves short text unchanged', () => {
  assert.equal(cap('short summary', 500), 'short summary');
});

test('cap: returns empty string for falsy input', () => {
  assert.equal(cap('', 500), '');
  assert.equal(cap(null, 500), '');
});

test('parseDependabotTitle: parses a standard npm bump title', () => {
  const result = parseDependabotTitle('Bump eslint from 8.56.0 to 8.57.0');
  assert.deepEqual(result, { dependencyName: 'eslint', versionFrom: '8.56.0', versionTo: '8.57.0' });
});

test('parseDependabotTitle: parses a github-actions bump title with v-prefixed versions', () => {
  const result = parseDependabotTitle('Bump actions/checkout from v3 to v4');
  assert.deepEqual(result, { dependencyName: 'actions/checkout', versionFrom: 'v3', versionTo: 'v4' });
});

test('parseDependabotTitle: returns null for a non-Dependabot-shaped title', () => {
  assert.equal(parseDependabotTitle('Fix the login bug'), null);
});

test('semverParts: parses a plain semver string', () => {
  assert.deepEqual(semverParts('8.56.0'), [8, 56, 0]);
});

test('semverParts: strips a leading v or ^/~', () => {
  assert.deepEqual(semverParts('v4'), [4]);
  assert.deepEqual(semverParts('^1.2.3'), [1, 2, 3]);
});

test('semverParts: returns null for a non-numeric version', () => {
  assert.equal(semverParts('latest'), null);
});

test('inferUpdateType: detects a major bump', () => {
  assert.equal(inferUpdateType('v3', 'v4'), 'major');
});

test('inferUpdateType: detects a minor bump', () => {
  assert.equal(inferUpdateType('8.56.0', '8.57.0'), 'minor');
});

test('inferUpdateType: detects a patch bump', () => {
  assert.equal(inferUpdateType('1.3.0', '1.3.1'), 'patch');
});

test('inferUpdateType: returns unknown when versions are not parseable', () => {
  assert.equal(inferUpdateType('latest', 'next'), 'unknown');
});

test('inferDependencyClass: github_actions ecosystem is always github-actions', () => {
  assert.equal(inferDependencyClass({ labels: [] }, 'github_actions'), 'github-actions');
});

test('inferDependencyClass: a devDependencies label maps to development', () => {
  assert.equal(inferDependencyClass({ labels: [{ name: 'devDependencies' }] }, 'npm'), 'development');
});

test('inferDependencyClass: no identifying label is unknown, not a guess', () => {
  assert.equal(inferDependencyClass({ labels: [{ name: 'dependencies' }] }, 'npm'), 'unknown');
});

test('computeRecommendedAction: urgent security alerts take priority over everything else', () => {
  const result = computeRecommendedAction(
    { counts: { critical: 1, high: 0, moderate: 0, low: 0 } },
    [{ risk_state: 'eligible' }],
    [{ number: 1 }]
  );
  assert.equal(result.action, 'review_security_alerts');
});

test('computeRecommendedAction: failed PRs take priority over eligible/review when no alerts', () => {
  const result = computeRecommendedAction(
    { counts: { critical: 0, high: 0, moderate: 0, low: 0 } },
    [{ risk_state: 'eligible' }],
    [{ number: 1 }]
  );
  assert.equal(result.action, 'repair_failed_update_pr');
});

test('computeRecommendedAction: eligible updates recommended when nothing more urgent exists', () => {
  const result = computeRecommendedAction(
    { counts: { critical: 0, high: 0, moderate: 0, low: 0 } },
    [{ risk_state: 'eligible' }],
    []
  );
  assert.equal(result.action, 'merge_eligible_updates');
});

test('computeRecommendedAction: human review recommended when only needs_review/blocked items remain', () => {
  const result = computeRecommendedAction(
    { counts: { critical: 0, high: 0, moderate: 0, low: 0 } },
    [{ risk_state: 'needs_review' }],
    []
  );
  assert.equal(result.action, 'human_review_required');
});

test('computeRecommendedAction: none when there is nothing to report', () => {
  const result = computeRecommendedAction({ counts: { critical: 0, high: 0, moderate: 0, low: 0 } }, [], []);
  assert.equal(result.action, 'none');
});

test('computeRecommendedAction: missing alert counts (unavailable coverage) does not crash and does not claim urgency', () => {
  const result = computeRecommendedAction({ counts: null }, [], []);
  assert.equal(result.action, 'none');
});
