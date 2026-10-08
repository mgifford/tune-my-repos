const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { classifyPrMetadata } = require('../.github/scripts/classify-dependabot-pr.cjs');

const policy = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'maintenance-policy.json'), 'utf8')
);

// github_actions ecosystem never makes a network call in inferDependencyClass
// (it short-circuits before the package.json fetch), so these stay
// deterministic without mocking. npm-ecosystem cases that need the manifest
// fallback are exercised directly against classifyFromPackageJson /
// inferDependencyClass in generate-maintenance-rollup.cjs's own test file —
// this file only re-tests the github-actions path end to end, plus the
// label-based fallback, which also needs no network call.

test('classifyPrMetadata: a patch github-actions bump is eligible', async () => {
  const result = await classifyPrMetadata(policy, {
    title: 'Bump actions/setup-node from 7.0.0 to 7.0.1',
    labelNames: ['dependencies', 'github-actions'],
    repository: 'mgifford/tune-my-repos',
    changedFiles: ['.github/workflows/ci.yml'],
    baseRef: 'main',
  });
  assert.equal(result.dependency_class, 'github-actions');
  assert.equal(result.update_type, 'patch');
  assert.equal(result.risk_state, 'eligible');
});

test('classifyPrMetadata: a major github-actions bump always needs review', async () => {
  const result = await classifyPrMetadata(policy, {
    title: 'Bump actions/checkout from v4 to v5',
    labelNames: ['dependencies', 'github-actions'],
    repository: 'mgifford/tune-my-repos',
    changedFiles: ['.github/workflows/ci.yml'],
    baseRef: 'main',
  });
  assert.equal(result.update_type, 'major');
  assert.equal(result.risk_state, 'needs_review');
});

test('classifyPrMetadata: a repository under a different owner outside policy scope is ignored, never eligible', async () => {
  const result = await classifyPrMetadata(policy, {
    title: 'Bump actions/setup-node from 7.0.0 to 7.0.1',
    labelNames: ['dependencies', 'github-actions'],
    repository: 'someoneelse/not-in-policy',
    changedFiles: ['.github/workflows/ci.yml'],
    baseRef: 'main',
  });
  assert.equal(result.risk_state, 'ignored');
});

test('classifyPrMetadata: an unparseable title with no recognizable changed files classifies as unknown, never eligible', async () => {
  const result = await classifyPrMetadata(policy, {
    title: 'chore: update something',
    labelNames: [],
    repository: 'mgifford/tune-my-repos',
    changedFiles: ['README.md'],
    baseRef: 'main',
  });
  assert.equal(result.dependency_class, 'unknown');
  assert.equal(result.update_type, 'unknown');
  assert.equal(result.risk_state, 'needs_review');
});

test('classifyPrMetadata: a devDependencies-labeled update with no recognized ecosystem file still resolves via the label fallback', async () => {
  const result = await classifyPrMetadata(policy, {
    title: 'Bump eslint from 8.56.0 to 8.56.1',
    labelNames: ['dependencies', 'devDependencies'],
    repository: 'mgifford/tune-my-repos',
    changedFiles: [], // no recognizable ecosystem file -> falls back to the devDependencies label
    baseRef: 'main',
  });
  assert.equal(result.dependency_class, 'development');
  assert.equal(result.risk_state, 'eligible');
});

test('classifyPrMetadata: no identifying label and no recognizable changed files is unknown, never a guess', async () => {
  const result = await classifyPrMetadata(policy, {
    title: 'Bump left-pad from 1.3.0 to 1.3.1',
    labelNames: ['dependencies'],
    repository: 'mgifford/tune-my-repos',
    changedFiles: [],
    baseRef: 'main',
  });
  assert.equal(result.dependency_class, 'unknown');
  assert.equal(result.risk_state, 'needs_review');
});
