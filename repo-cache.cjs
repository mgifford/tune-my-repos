/**
 * Per-repository result cache for the Analyze page, kept in the viewer's
 * own browser (localStorage). Each repository's analysis is stored
 * separately for 24 hours, so a run that stops at GitHub's 60
 * requests/hour unauthenticated limit keeps what it finished, and the next
 * visit only spends requests on the repositories still missing.
 *
 * An entry is also discarded early when the repository has been pushed to
 * since it was cached (pushed_at comes free with the repository list), so
 * a changed repository is never shown from stale data.
 *
 * Storage is passed in, so this works in the browser and in Node tests.
 * Every storage call is guarded: blocked or full storage never breaks the
 * page, it only means fewer cache hits.
 */

const REPO_CACHE_PREFIX = 'tune-my-repos-repo-';
const REPO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function createRepoCache(storage, { now = () => Date.now(), ttlMs = REPO_CACHE_TTL_MS } = {}) {
  const keyFor = (fullName) => `${REPO_CACHE_PREFIX}${String(fullName).toLowerCase()}`;

  function ownKeys() {
    try {
      const keys = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && key.startsWith(REPO_CACHE_PREFIX)) keys.push(key);
      }
      return keys;
    } catch {
      return [];
    }
  }

  function read(key) {
    try {
      return JSON.parse(storage.getItem(key) || 'null');
    } catch {
      return null;
    }
  }

  /**
   * @param {string} fullName - owner/repo
   * @param {string|null} pushedAt - current pushed_at from the repository list
   * @returns {object|null} the cached analysis, or null on a miss
   */
  function get(fullName, pushedAt) {
    const entry = read(keyFor(fullName));
    if (!entry || typeof entry.cachedAt !== 'number') return null;
    const expired = now() - entry.cachedAt > ttlMs;
    const changed = Boolean(pushedAt && entry.pushedAt && pushedAt !== entry.pushedAt);
    if (expired || changed) {
      remove(fullName);
      return null;
    }
    return entry.result;
  }

  /** Oldest entries first, so a full store gives up the stalest data. */
  function evictOldest(count) {
    const entries = ownKeys()
      .map((key) => ({ key, cachedAt: (read(key) || {}).cachedAt || 0 }))
      .sort((a, b) => a.cachedAt - b.cachedAt);
    for (const { key } of entries.slice(0, count)) {
      try { storage.removeItem(key); } catch { /* ignore */ }
    }
  }

  /** @returns {boolean} whether the entry was stored */
  function set(fullName, pushedAt, result) {
    const value = JSON.stringify({ cachedAt: now(), pushedAt: pushedAt || null, result });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        storage.setItem(keyFor(fullName), value);
        return true;
      } catch {
        evictOldest(10); // likely full: free space and retry
      }
    }
    return false;
  }

  function remove(fullName) {
    try { storage.removeItem(keyFor(fullName)); } catch { /* ignore */ }
  }

  /** @returns {number} entries removed */
  function clear() {
    const keys = ownKeys();
    for (const key of keys) {
      try { storage.removeItem(key); } catch { /* ignore */ }
    }
    return keys.length;
  }

  return { get, set, remove, clear, count: () => ownKeys().length };
}

const RepoCache = { REPO_CACHE_PREFIX, REPO_CACHE_TTL_MS, createRepoCache };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RepoCache;
} else {
  window.RepoCache = RepoCache;
}
