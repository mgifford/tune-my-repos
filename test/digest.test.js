const test = require('node:test');
const assert = require('node:assert/strict');

const { computeDelta, renderDigest, renderSummary } = require('../policy/digest.cjs');

function repo(name, overrides = {}) {
  return {
    full_name: name,
    tier: 'standard',
    security_alerts: { has_urgent_alerts: false },
    open_pull_requests: { total: 0, dependabot: 0 },
    dependabot_prs: [],
    failed_update_prs: [],
    recommended_action: { action: 'none', reason: 'nothing to do' },
    ...overrides,
  };
}

function rollup(repos, run = '2026-11-16T09:00:00Z') {
  return { schema_version: '1.0.0', run_timestamp: run, repositories: repos };
}

test('no previous rollup reports a baseline, not a flood of new repositories', () => {
  const delta = computeDelta(null, rollup([repo('a/x'), repo('a/y')]));
  assert.equal(delta.baseline, true);
  assert.deepEqual(delta.changes, []);
  assert.equal(delta.totals.repositories, 2);
});

test('identical rollups produce no changes', () => {
  const r = rollup([repo('a/x')]);
  const delta = computeDelta(r, r);
  assert.equal(delta.baseline, false);
  assert.deepEqual(delta.changes, []);
});

test('a new urgent alert is reported', () => {
  const prev = rollup([repo('a/x')]);
  const curr = rollup([repo('a/x', { security_alerts: { has_urgent_alerts: true } })]);
  const kinds = computeDelta(prev, curr).changes.map((c) => c.kind);
  assert.deepEqual(kinds, ['urgent_alert_appeared']);
});

test('an urgent alert that cleared is reported', () => {
  const prev = rollup([repo('a/x', { security_alerts: { has_urgent_alerts: true } })]);
  const curr = rollup([repo('a/x')]);
  assert.deepEqual(computeDelta(prev, curr).changes.map((c) => c.kind), ['urgent_alert_cleared']);
});

test('new non-Dependabot pull requests are reported with the increase', () => {
  const prev = rollup([repo('a/x', { open_pull_requests: { total: 2, dependabot: 2 } })]);
  const curr = rollup([repo('a/x', { open_pull_requests: { total: 4, dependabot: 2 } })]);
  const [change] = computeDelta(prev, curr).changes;
  assert.equal(change.kind, 'human_prs_increased');
  assert.equal(change.from, 0);
  assert.equal(change.to, 2);
});

test('a Dependabot-only increase is not a human PR change', () => {
  const prev = rollup([repo('a/x', { open_pull_requests: { total: 1, dependabot: 1 } })]);
  const curr = rollup([repo('a/x', { open_pull_requests: { total: 3, dependabot: 3 } })]);
  assert.deepEqual(computeDelta(prev, curr).changes.map((c) => c.kind), []);
});

test('a newly failing update PR is reported by number only when it is new', () => {
  const failing = { number: 7, url: 'u', dependency_name: 'd', failed_check_name: 'c', failed_check_url: 'u', failure_summary: 's' };
  const prev = rollup([repo('a/x', { failed_update_prs: [failing] })]);
  const curr = rollup([repo('a/x', { failed_update_prs: [failing, { ...failing, number: 9 }] })]);
  const [change] = computeDelta(prev, curr).changes;
  assert.equal(change.kind, 'failed_update_pr_appeared');
  assert.deepEqual(change.numbers, [9]);
});

test('a changed recommended action is reported', () => {
  const prev = rollup([repo('a/x')]);
  const curr = rollup([repo('a/x', { recommended_action: { action: 'human_review_required', reason: 'r' } })]);
  const [change] = computeDelta(prev, curr).changes;
  assert.equal(change.kind, 'action_changed');
  assert.equal(change.from, 'none');
  assert.equal(change.to, 'human_review_required');
});

test('repositories added and removed between runs are reported', () => {
  const prev = rollup([repo('a/old')]);
  const curr = rollup([repo('a/new')]);
  const kinds = computeDelta(prev, curr).changes.map((c) => `${c.kind}:${c.repo}`).sort();
  assert.deepEqual(kinds, ['repository_added:a/new', 'repository_removed:a/old']);
});

test('digest lists nothing but a one-line all-clear when there are no changes', () => {
  const r = rollup([repo('a/x')]);
  const md = renderDigest(computeDelta(r, r), r);
  assert.match(md, /No changes since the previous run/);
  assert.doesNotMatch(md, /a\/x/);
});

test('digest never contains failure summaries or reasons, only identifiers', () => {
  const failing = { number: 7, url: 'https://x', dependency_name: 'secret-dep', failed_check_name: 'c', failed_check_url: 'u', failure_summary: 'LEAKY TEXT' };
  const prev = rollup([repo('a/x')]);
  const curr = rollup([repo('a/x', { failed_update_prs: [failing], recommended_action: { action: 'repair_failed_update_pr', reason: 'LEAKY REASON' } })]);
  const md = renderDigest(computeDelta(prev, curr), curr);
  assert.doesNotMatch(md, /LEAKY/);
  assert.match(md, /a\/x/);
  assert.match(md, /#7/);
});

test('summary is a short fixed-shape block that a model can read instead of the rollup', () => {
  const curr = rollup([
    repo('a/x', { security_alerts: { has_urgent_alerts: true } }),
    repo('a/y', { recommended_action: { action: 'merge_eligible_updates', reason: 'r' } }),
    repo('a/z'),
  ]);
  const text = renderSummary(curr);
  assert.match(text, /repositories: 3/);
  assert.match(text, /urgent_alerts: 1/);
  assert.match(text, /merge_eligible_updates: 1/);
  assert.ok(text.split('\n').length < 20);
});
