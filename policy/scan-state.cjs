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

/**
 * Orders candidate repositories for a scan run, prioritizing the user's
 * own actively-maintained work over long-dormant ones within the same
 * coverage tier. Never-scanned repositories still come before
 * already-scanned ones (coverage first), but within each of those two
 * groups, more recently pushed-to repositories sort first — surfacing
 * issues on code being actively worked on ahead of code that hasn't
 * changed in years. forks and archived repositories are excluded well
 * before this function runs (see discovery.exclude_forks /
 * exclude_archived in maintenance-policy.yml), so "recently pushed"
 * here is a proxy for "actively maintained by the user", not a
 * substitute for that exclusion.
 * @param {object} state - scan state, as orderByStaleness takes
 * @param {string[]} repoFullNames
 * @param {Map<string, string|null>} pushedAtByRepo - repo full_name -> pushed_at ISO string (or null if unknown)
 * @returns {string[]}
 */
function orderByActivityThenStaleness(state, repoFullNames, pushedAtByRepo) {
  const pushedAtMs = (name) => {
    const iso = pushedAtByRepo.get(name);
    return iso ? new Date(iso).getTime() : -Infinity; // unknown pushed_at sorts as least-recent
  };

  return [...repoFullNames].sort((a, b) => {
    const aScanned = Boolean(getRepoState(state, a)?.last_scanned);
    const bScanned = Boolean(getRepoState(state, b)?.last_scanned);
    if (aScanned !== bScanned) return aScanned ? 1 : -1; // never-scanned group comes first

    // Within the same coverage tier, more recently pushed-to sorts first.
    return pushedAtMs(b) - pushedAtMs(a);
  });
}

const ScanState = {
  DEFAULT_STATE,
  getRepoState,
  canSkipPrWork,
  recordScan,
  orderByStaleness,
  orderByActivityThenStaleness,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScanState;
} else {
  window.ScanState = ScanState;
}
