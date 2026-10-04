/**
 * Pure helpers for maintenance-scan-state.json: a small, committed record
 * of when each repository was last scanned and what its pushed_at was at
 * that time. Lets the inventory script skip the expensive PR/CI-status
 * work for repositories that have not changed, while always re-checking
 * Dependabot alerts regardless (cheap, and alerts can appear with no new
 * push). No AI, no network access — pure functions over plain objects.
 */

const DEFAULT_STATE = { schema_version: '1.0.0', repositories: {} };

/**
 * @param {object} state - parsed maintenance-scan-state.json (or DEFAULT_STATE)
 * @param {string} repoFullName
 * @returns {{last_scanned: string, last_pushed_at: string}|null}
 */
function getRepoState(state, repoFullName) {
  return state.repositories[repoFullName] || null;
}

/**
 * Decides whether a repository's PR/CI-status work can be skipped this run.
 * Alerts are never skipped by this function — callers must always fetch
 * them separately regardless of the result here.
 *
 * @param {object} state
 * @param {string} repoFullName
 * @param {string} currentPushedAt - the repo's current pushed_at from the API
 * @param {number} rescanAfterDays - force a rescan even if unchanged, after this many days
 * @param {string} [nowIso] - override "now" for deterministic testing
 * @returns {boolean} true if PR/CI work may be skipped
 */
function canSkipPrWork(state, repoFullName, currentPushedAt, rescanAfterDays, nowIso = new Date().toISOString()) {
  const entry = getRepoState(state, repoFullName);
  if (!entry) return false;
  if (entry.last_pushed_at !== currentPushedAt) return false;

  const ageMs = new Date(nowIso).getTime() - new Date(entry.last_scanned).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays < rescanAfterDays;
}

/**
 * Returns a new state object with repoFullName's entry updated. Does not
 * mutate the input.
 */
function recordScan(state, repoFullName, pushedAt, nowIso = new Date().toISOString()) {
  return {
    ...state,
    repositories: {
      ...state.repositories,
      [repoFullName]: { last_scanned: nowIso, last_pushed_at: pushedAt },
    },
  };
}

/**
 * Orders candidate repositories oldest-last-scanned-first, so a capped-size
 * run makes progress across the whole set over successive runs rather than
 * always scanning the same repositories. Repositories never scanned before
 * sort first (treated as infinitely stale).
 * @param {object} state
 * @param {string[]} repoFullNames
 * @returns {string[]}
 */
function orderByStaleness(state, repoFullNames) {
  return [...repoFullNames].sort((a, b) => {
    const aScanned = getRepoState(state, a)?.last_scanned;
    const bScanned = getRepoState(state, b)?.last_scanned;
    if (!aScanned && !bScanned) return 0;
    if (!aScanned) return -1;
    if (!bScanned) return 1;
    return new Date(aScanned).getTime() - new Date(bScanned).getTime();
  });
}

const ScanState = { DEFAULT_STATE, getRepoState, canSkipPrWork, recordScan, orderByStaleness };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScanState;
} else {
  window.ScanState = ScanState;
}
