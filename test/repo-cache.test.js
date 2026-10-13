const test = require('node:test');
const assert = require('node:assert/strict');

const { createRepoCache, REPO_CACHE_TTL_MS } = require('../repo-cache.cjs');

// Minimal localStorage stand-in; quota (in entries) simulates a full store.
function fakeStorage(quota = Infinity) {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (!map.has(k) && map.size >= quota) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem: (k) => { map.delete(k); },
    map,
  };
}

test('repo cache: hit within 24 hours for an unchanged repository', () => {
  let t = 1000;
  const cache = createRepoCache(fakeStorage(), { now: () => t });
  cache.set('Owner/Repo', '2026-10-01T00:00:00Z', { score: 1 });
  t += REPO_CACHE_TTL_MS - 1;
  assert.deepEqual(cache.get('owner/repo', '2026-10-01T00:00:00Z'), { score: 1 });
});

test('repo cache: expires after 24 hours', () => {
  let t = 1000;
  const cache = createRepoCache(fakeStorage(), { now: () => t });
  cache.set('o/r', 'p', { score: 1 });
  t += REPO_CACHE_TTL_MS + 1;
  assert.equal(cache.get('o/r', 'p'), null);
  assert.equal(cache.count(), 0);
});

test('repo cache: a push since caching invalidates the entry early', () => {
  const cache = createRepoCache(fakeStorage());
  cache.set('o/r', '2026-10-01T00:00:00Z', { score: 1 });
  assert.equal(cache.get('o/r', '2026-10-13T00:00:00Z'), null);
});

test('repo cache: unknown pushed_at on either side does not invalidate', () => {
  const cache = createRepoCache(fakeStorage());
  cache.set('o/r', null, { score: 1 });
  assert.deepEqual(cache.get('o/r', '2026-10-13T00:00:00Z'), { score: 1 });
});

test('repo cache: a full store evicts the oldest entries and still stores', () => {
  let t = 0;
  const storage = fakeStorage(10);
  const cache = createRepoCache(storage, { now: () => ++t });
  for (let i = 0; i < 10; i++) cache.set(`o/r${i}`, null, { i });
  assert.equal(cache.set('o/new', null, { i: 'new' }), true);
  assert.deepEqual(cache.get('o/new', null), { i: 'new' });
  assert.equal(cache.get('o/r0', null), null, 'oldest entry was evicted');
});

test('repo cache: clear removes only its own entries', () => {
  const storage = fakeStorage();
  storage.setItem('unrelated', 'keep');
  const cache = createRepoCache(storage);
  cache.set('o/a', null, {});
  cache.set('o/b', null, {});
  assert.equal(cache.clear(), 2);
  assert.equal(storage.getItem('unrelated'), 'keep');
});

test('repo cache: blocked storage never throws', () => {
  const broken = {
    get length() { throw new Error('SecurityError'); },
    key() { throw new Error('SecurityError'); },
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  const cache = createRepoCache(broken);
  assert.equal(cache.get('o/r', null), null);
  assert.equal(cache.set('o/r', null, {}), false);
  assert.equal(cache.clear(), 0);
});
