const test = require('node:test');
const assert = require('node:assert/strict');

const { getRepoState, canSkipPrWork, recordScan, orderByStaleness, orderByActivityThenStaleness } = require('../policy/scan-state.cjs');

function stateWith(entries) {
  return { schema_version: '1.0.0', repositories: entries };
}

test('getRepoState: returns null for a repo never scanned', () => {
  assert.equal(getRepoState(stateWith({}), 'mgifford/x'), null);
});

test('getRepoState: returns the stored entry when present', () => {
  const state = stateWith({ 'mgifford/x': { last_scanned: '2026-10-01T00:00:00Z', last_pushed_at: '2026-09-01T00:00:00Z' } });
  assert.deepEqual(getRepoState(state, 'mgifford/x'), { last_scanned: '2026-10-01T00:00:00Z', last_pushed_at: '2026-09-01T00:00:00Z' });
});

test('canSkipPrWork: false for a repo never scanned before', () => {
  const state = stateWith({});
  assert.equal(canSkipPrWork(state, 'mgifford/x', '2026-09-01T00:00:00Z', 7), false);
});

test('canSkipPrWork: false when pushed_at changed since last scan', () => {
  const state = stateWith({ 'mgifford/x': { last_scanned: '2026-10-01T00:00:00Z', last_pushed_at: '2026-09-01T00:00:00Z' } });
  assert.equal(canSkipPrWork(state, 'mgifford/x', '2026-09-15T00:00:00Z', 7), false);
});

test('canSkipPrWork: true when pushed_at unchanged and within the rescan window', () => {
  const state = stateWith({ 'mgifford/x': { last_scanned: '2026-10-01T00:00:00Z', last_pushed_at: '2026-09-01T00:00:00Z' } });
  assert.equal(
    canSkipPrWork(state, 'mgifford/x', '2026-09-01T00:00:00Z', 7, '2026-10-02T00:00:00Z'),
    true
  );
});

test('canSkipPrWork: false when pushed_at unchanged but the rescan window has elapsed', () => {
  const state = stateWith({ 'mgifford/x': { last_scanned: '2026-10-01T00:00:00Z', last_pushed_at: '2026-09-01T00:00:00Z' } });
  assert.equal(
    canSkipPrWork(state, 'mgifford/x', '2026-09-01T00:00:00Z', 7, '2026-10-10T00:00:00Z'),
    false
  );
});

test('recordScan: adds a new entry without mutating the input state', () => {
  const state = stateWith({});
  const updated = recordScan(state, 'mgifford/x', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z');
  assert.deepEqual(state.repositories, {});
  assert.deepEqual(updated.repositories['mgifford/x'], {
    last_scanned: '2026-10-01T00:00:00Z',
    last_pushed_at: '2026-09-01T00:00:00Z',
  });
});

test('recordScan: overwrites an existing entry for the same repo', () => {
  const state = stateWith({ 'mgifford/x': { last_scanned: '2026-09-01T00:00:00Z', last_pushed_at: '2026-08-01T00:00:00Z' } });
  const updated = recordScan(state, 'mgifford/x', '2026-09-15T00:00:00Z', '2026-10-01T00:00:00Z');
  assert.deepEqual(updated.repositories['mgifford/x'], {
    last_scanned: '2026-10-01T00:00:00Z',
    last_pushed_at: '2026-09-15T00:00:00Z',
  });
});

test('orderByStaleness: never-scanned repos sort before any scanned repo', () => {
  const state = stateWith({ 'mgifford/scanned': { last_scanned: '2026-10-01T00:00:00Z', last_pushed_at: 'x' } });
  const ordered = orderByStaleness(state, ['mgifford/scanned', 'mgifford/never-scanned']);
  assert.deepEqual(ordered, ['mgifford/never-scanned', 'mgifford/scanned']);
});

test('orderByStaleness: oldest-scanned repo sorts first among scanned repos', () => {
  const state = stateWith({
    'mgifford/recent': { last_scanned: '2026-10-03T00:00:00Z', last_pushed_at: 'x' },
    'mgifford/old': { last_scanned: '2026-09-01T00:00:00Z', last_pushed_at: 'x' },
  });
  const ordered = orderByStaleness(state, ['mgifford/recent', 'mgifford/old']);
  assert.deepEqual(ordered, ['mgifford/old', 'mgifford/recent']);
});

test('orderByStaleness: does not mutate the input array', () => {
  const state = stateWith({});
  const input = ['mgifford/b', 'mgifford/a'];
  orderByStaleness(state, input);
  assert.deepEqual(input, ['mgifford/b', 'mgifford/a']);
});

test('orderByActivityThenStaleness: never-scanned repos come before already-scanned ones regardless of push recency', () => {
  const state = stateWith({ 'mgifford/scanned': { last_scanned: '2026-10-01T00:00:00Z', last_pushed_at: 'x' } });
  const pushedAt = new Map([
    ['mgifford/scanned', '2026-10-04T00:00:00Z'], // very recently pushed, but already scanned
    ['mgifford/never-scanned', '2020-01-01T00:00:00Z'], // dormant, but never scanned
  ]);
  const ordered = orderByActivityThenStaleness(state, ['mgifford/scanned', 'mgifford/never-scanned'], pushedAt);
  assert.deepEqual(ordered, ['mgifford/never-scanned', 'mgifford/scanned']);
});

test('orderByActivityThenStaleness: among never-scanned repos, more recently pushed sorts first', () => {
  const state = stateWith({});
  const pushedAt = new Map([
    ['mgifford/dormant', '2020-01-01T00:00:00Z'],
    ['mgifford/active', '2026-10-01T00:00:00Z'],
  ]);
  const ordered = orderByActivityThenStaleness(state, ['mgifford/dormant', 'mgifford/active'], pushedAt);
  assert.deepEqual(ordered, ['mgifford/active', 'mgifford/dormant']);
});

test('orderByActivityThenStaleness: among already-scanned repos, more recently pushed sorts first', () => {
  const state = stateWith({
    'mgifford/dormant': { last_scanned: '2026-10-01T00:00:00Z', last_pushed_at: 'x' },
    'mgifford/active': { last_scanned: '2026-10-01T00:00:00Z', last_pushed_at: 'x' },
  });
  const pushedAt = new Map([
    ['mgifford/dormant', '2020-01-01T00:00:00Z'],
    ['mgifford/active', '2026-10-01T00:00:00Z'],
  ]);
  const ordered = orderByActivityThenStaleness(state, ['mgifford/dormant', 'mgifford/active'], pushedAt);
  assert.deepEqual(ordered, ['mgifford/active', 'mgifford/dormant']);
});

test('orderByActivityThenStaleness: an unknown pushed_at sorts as least-recent, not crash', () => {
  const state = stateWith({});
  const pushedAt = new Map([
    ['mgifford/known', '2026-10-01T00:00:00Z'],
    ['mgifford/unknown', null],
  ]);
  const ordered = orderByActivityThenStaleness(state, ['mgifford/unknown', 'mgifford/known'], pushedAt);
  assert.deepEqual(ordered, ['mgifford/known', 'mgifford/unknown']);
});

test('orderByActivityThenStaleness: does not mutate the input array', () => {
  const state = stateWith({});
  const pushedAt = new Map([['mgifford/a', '2026-10-01T00:00:00Z'], ['mgifford/b', '2026-10-02T00:00:00Z']]);
  const input = ['mgifford/a', 'mgifford/b'];
  orderByActivityThenStaleness(state, input, pushedAt);
  assert.deepEqual(input, ['mgifford/a', 'mgifford/b']);
});
