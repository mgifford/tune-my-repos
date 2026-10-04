const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { classifyPrMetadata } = require('../.github/scripts/classify-dependabot-pr.js');

const policy = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'maintenance-policy.json'), 'utf8')
);

test('classifyPrMetadata: a patch github-actions bump is eligible', () => {
  const result = classifyPrMetadata(policy, {
    title: 'Bump actions/setup-node from 7.0.0 to 7.0.1',
    labelNames: ['dependencies', 'github-actions'],
    repository: 'mgifford/tune-my-repos',
  });
  assert.equal(result.dependency_class, 'github-actions');
  assert.equal(result.update_type, 'patch');
  assert.equal(result.risk_state, 'eligible');
});

test('classifyPrMetadata: a major github-actions bump always needs review', () => {
  const result = classifyPrMetadata(policy, {
    title: 'Bump actions/checkout from v4 to v5',
    labelNames: ['dependencies', 'github-actions'],
    repository: 'mgifford/tune-my-repos',
  });
  assert.equal(result.update_type, 'major');
  assert.equal(result.risk_state, 'needs_review');
});

test('classifyPrMetadata: a repository under a different owner outside policy scope is ignored, never eligible', () => {
  const result = classifyPrMetadata(policy, {
    title: 'Bump actions/setup-node from 7.0.0 to 7.0.1',
    labelNames: ['dependencies', 'github-actions'],
    repository: 'someoneelse/not-in-policy',
  });
  assert.equal(result.risk_state, 'ignored');
});

test('classifyPrMetadata: an unparseable title classifies as unknown, never eligible', () => {
  const result = classifyPrMetadata(policy, {
    title: 'chore: update something',
    labelNames: [],
    repository: 'mgifford/tune-my-repos',
  });
  assert.equal(result.dependency_class, 'unknown');
  assert.equal(result.update_type, 'unknown');
  assert.equal(result.risk_state, 'needs_review');
});

test('classifyPrMetadata: an npm devDependencies patch bump is eligible', () => {
  const result = classifyPrMetadata(policy, {
    title: 'Bump eslint from 8.56.0 to 8.56.1',
    labelNames: ['dependencies', 'devDependencies'],
    repository: 'mgifford/tune-my-repos',
  });
  assert.equal(result.dependency_class, 'development');
  assert.equal(result.risk_state, 'eligible');
});

test('classifyPrMetadata: without a devDependencies/github-actions label, class is unknown not production', () => {
  const result = classifyPrMetadata(policy, {
    title: 'Bump left-pad from 1.3.0 to 1.3.1',
    labelNames: ['dependencies'],
    repository: 'mgifford/tune-my-repos',
  });
  assert.equal(result.dependency_class, 'unknown');
  assert.equal(result.risk_state, 'needs_review');
});
