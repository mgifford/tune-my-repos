const test = require('node:test');
const assert = require('node:assert/strict');

const {
  redact,
  cap,
  parseDependabotTitle,
  semverParts,
  inferUpdateType,
  inferDependencyClassFromLabels,
  classifyFromPackageJson,
  detectEcosystemFromFiles,
  computeRecommendedAction,
  computeHasUrgentAlerts,
  filterDiscoveredRepos,
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

test('inferDependencyClassFromLabels: a devDependencies label maps to development', () => {
  assert.equal(inferDependencyClassFromLabels({ labels: [{ name: 'devDependencies' }] }), 'development');
});

test('inferDependencyClassFromLabels: no identifying label returns null, not a guess', () => {
  assert.equal(inferDependencyClassFromLabels({ labels: [{ name: 'dependencies' }] }), null);
});

test('inferDependencyClassFromLabels: no labels at all returns null', () => {
  assert.equal(inferDependencyClassFromLabels({ labels: [] }), null);
});

test('classifyFromPackageJson: a dependency listed in devDependencies is development', () => {
  const pkg = { devDependencies: { eslint: '^8.0.0' }, dependencies: {} };
  assert.equal(classifyFromPackageJson(pkg, 'eslint'), 'development');
});

test('classifyFromPackageJson: a dependency listed in dependencies is production', () => {
  const pkg = { devDependencies: {}, dependencies: { express: '^4.0.0' } };
  assert.equal(classifyFromPackageJson(pkg, 'express'), 'production');
});

test('classifyFromPackageJson: a transitive dependency not listed directly returns null, not a guess', () => {
  const pkg = { devDependencies: { svgo: '^3.0.0' }, dependencies: {} };
  assert.equal(classifyFromPackageJson(pkg, 'js-yaml'), null);
});

test('classifyFromPackageJson: a missing/unparseable package.json returns null', () => {
  assert.equal(classifyFromPackageJson(null, 'eslint'), null);
});

test('detectEcosystemFromFiles: a workflow file change is github_actions', () => {
  assert.equal(detectEcosystemFromFiles(['.github/workflows/ci.yml']), 'github_actions');
});

test('detectEcosystemFromFiles: a lockfile-only change is npm', () => {
  assert.equal(detectEcosystemFromFiles(['package-lock.json']), 'npm');
});

test('detectEcosystemFromFiles: a nested package.json change is npm', () => {
  assert.equal(detectEcosystemFromFiles(['packages/app/package.json']), 'npm');
});

test('detectEcosystemFromFiles: a composer lockfile change is composer', () => {
  assert.equal(detectEcosystemFromFiles(['composer.lock']), 'composer');
});

test('detectEcosystemFromFiles: an unrecognized file set is unknown', () => {
  assert.equal(detectEcosystemFromFiles(['README.md']), 'unknown');
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

test('computeHasUrgentAlerts: true when critical count is positive', () => {
  assert.equal(computeHasUrgentAlerts({ critical: 1, high: 0, moderate: 0, low: 0 }), true);
});

test('computeHasUrgentAlerts: true when high count is positive', () => {
  assert.equal(computeHasUrgentAlerts({ critical: 0, high: 1, moderate: 0, low: 0 }), true);
});

test('computeHasUrgentAlerts: false when only moderate/low alerts exist', () => {
  assert.equal(computeHasUrgentAlerts({ critical: 0, high: 0, moderate: 5, low: 5 }), false);
});

test('computeHasUrgentAlerts: false when there are no alerts at all', () => {
  assert.equal(computeHasUrgentAlerts({ critical: 0, high: 0, moderate: 0, low: 0 }), false);
});

test('filterDiscoveredRepos: excludes forks when exclude_forks is true', () => {
  const repos = [
    { full_name: 'mgifford/original', fork: false, archived: false, pushed_at: 'x' },
    { full_name: 'mgifford/forked', fork: true, archived: false, pushed_at: 'x' },
  ];
  const result = filterDiscoveredRepos(repos, { exclude_forks: true, exclude_archived: false });
  assert.deepEqual(result.map((r) => r.full_name), ['mgifford/original']);
});

test('filterDiscoveredRepos: excludes archived repos when exclude_archived is true', () => {
  const repos = [
    { full_name: 'mgifford/active', fork: false, archived: false, pushed_at: 'x' },
    { full_name: 'mgifford/old', fork: false, archived: true, pushed_at: 'x' },
  ];
  const result = filterDiscoveredRepos(repos, { exclude_forks: false, exclude_archived: true });
  assert.deepEqual(result.map((r) => r.full_name), ['mgifford/active']);
});

test('filterDiscoveredRepos: keeps forks and archived repos when both flags are false', () => {
  const repos = [
    { full_name: 'mgifford/forked-and-archived', fork: true, archived: true, pushed_at: 'x' },
  ];
  const result = filterDiscoveredRepos(repos, { exclude_forks: false, exclude_archived: false });
  assert.deepEqual(result.map((r) => r.full_name), ['mgifford/forked-and-archived']);
});

test('filterDiscoveredRepos: projects down to full_name and pushed_at only', () => {
  const repos = [{ full_name: 'mgifford/x', fork: false, archived: false, pushed_at: '2026-10-01T00:00:00Z', extra: 'ignored' }];
  const result = filterDiscoveredRepos(repos, { exclude_forks: true, exclude_archived: true });
  assert.deepEqual(result, [{ full_name: 'mgifford/x', pushed_at: '2026-10-01T00:00:00Z' }]);
});
