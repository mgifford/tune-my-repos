const test = require('node:test');
const assert = require('node:assert/strict');

const { ageInDays, mergeBlocker, sortForReview, reposWithOpenPrs } = require('../policy/pr-view.cjs');

const NOW = new Date('2026-10-13T12:00:00Z');

test('ageInDays: whole days since opening', () => {
  assert.equal(ageInDays('2026-10-03T12:00:00Z', NOW), 10);
  assert.equal(ageInDays('2026-10-13T11:00:00Z', NOW), 0);
});

test('ageInDays: missing or invalid timestamp is null, not 0', () => {
  assert.equal(ageInDays(undefined, NOW), null);
  assert.equal(ageInDays('not a date', NOW), null);
});

test('mergeBlocker: eligible with passing CI has no blocker', () => {
  assert.equal(mergeBlocker({ risk_state: 'eligible', ci_status: 'passing', reason: 'x' }), null);
});

test('mergeBlocker: CI problems come before policy, even for eligible PRs', () => {
  assert.match(mergeBlocker({ risk_state: 'eligible', ci_status: 'none', reason: 'x' }), /no CI checks/);
  assert.match(mergeBlocker({ risk_state: 'needs_review', ci_status: 'failing', reason: 'x' }), /failing/);
  assert.match(mergeBlocker({ risk_state: 'eligible', ci_status: 'pending', reason: 'x' }), /not finished/);
  assert.match(mergeBlocker({ risk_state: 'eligible', ci_status: 'unknown', reason: 'x' }), /could not be read/);
});

test('mergeBlocker: passing CI but needs review falls back to the policy reason', () => {
  assert.equal(mergeBlocker({ risk_state: 'needs_review', ci_status: 'passing', reason: 'Runtime dependency' }), 'Runtime dependency');
});

test('sortForReview: oldest first, unknown age last, then repo and number', () => {
  const items = [
    { repo: 'o/b', pr: { number: 2, opened_at: '2026-10-10T00:00:00Z' } },
    { repo: 'o/a', pr: { number: 9 } },
    { repo: 'o/c', pr: { number: 1, opened_at: '2026-09-01T00:00:00Z' } },
    { repo: 'o/a', pr: { number: 3, opened_at: '2026-10-10T00:00:00Z' } },
  ];
  assert.deepEqual(sortForReview(items, NOW).map((i) => `${i.repo}#${i.pr.number}`), ['o/c#1', 'o/a#3', 'o/b#2', 'o/a#9']);
});

test('sortForReview: does not mutate its input', () => {
  const items = [{ repo: 'b', pr: { number: 1 } }, { repo: 'a', pr: { number: 1 } }];
  sortForReview(items, NOW);
  assert.equal(items[0].repo, 'b');
});

test('reposWithOpenPrs: most PRs first; unscanned and zero-PR repos left out', () => {
  const rows = reposWithOpenPrs([
    { full_name: 'o/none', open_pull_requests: { total: 0, dependabot: 0 } },
    { full_name: 'o/unscanned' },
    { full_name: 'o/few', open_pull_requests: { total: 2, dependabot: 2 } },
    { full_name: 'o/many', open_pull_requests: { total: 5, dependabot: 1 } },
  ]);
  assert.deepEqual(rows, [
    { repo: 'o/many', total: 5, dependabot: 1, other: 4 },
    { repo: 'o/few', total: 2, dependabot: 2, other: 0 },
  ]);
});

const { describeSnapshotAge, liveStateFromApi } = require('../policy/pr-view.cjs');

test('describeSnapshotAge: hours under two days, then days', () => {
  assert.equal(describeSnapshotAge('2026-10-13T11:30:00Z', NOW), 'less than an hour ago');
  assert.equal(describeSnapshotAge('2026-10-13T11:00:00Z', NOW), '1 hour ago');
  assert.equal(describeSnapshotAge('2026-10-12T16:00:00Z', NOW), '20 hours ago');
  assert.equal(describeSnapshotAge('2026-10-06T12:00:00Z', NOW), '7 days ago');
  assert.equal(describeSnapshotAge('garbage', NOW), null);
});

test('liveStateFromApi: open, merged, closed without merging, unusable', () => {
  assert.equal(liveStateFromApi({ state: 'open', merged_at: null }), 'open');
  assert.equal(liveStateFromApi({ state: 'closed', merged_at: '2026-10-13T00:00:00Z' }), 'merged');
  assert.equal(liveStateFromApi({ state: 'closed', merged_at: null }), 'closed');
  assert.equal(liveStateFromApi({ message: 'Not Found' }), null);
  assert.equal(liveStateFromApi(null), null);
});
