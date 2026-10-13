/**
 * Pure helpers for presenting Dependabot PRs on the maintenance dashboard:
 * age, sort order, and a plain-language reason a PR is not merging on its
 * own. Shared by maintenance.js (browser) and the Node test suite. No
 * network access, no inference beyond the rollup fields.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string|undefined} openedAt - ISO timestamp
 * @param {Date} now
 * @returns {number|null} whole days open, or null when unknown
 */
function ageInDays(openedAt, now) {
  const opened = Date.parse(openedAt || '');
  if (Number.isNaN(opened)) return null;
  return Math.max(0, Math.floor((now.getTime() - opened) / DAY_MS));
}

/**
 * Why a PR is not merging automatically, or null when nothing blocks it
 * (eligible under policy and CI passing). CI problems come first because
 * they block every merge path, including a manual one.
 * @param {{risk_state: string, ci_status: string, reason: string}} pr
 * @returns {string|null}
 */
function mergeBlocker(pr) {
  if (pr.ci_status === 'failing') return 'CI is failing on this PR.';
  if (pr.ci_status === 'none') return 'This PR has no CI checks, so nothing can gate an automatic merge.';
  if (pr.ci_status === 'pending') return 'CI has not finished yet.';
  if (pr.ci_status === 'unknown') return 'CI status could not be read.';
  if (pr.risk_state === 'eligible') return null;
  return pr.reason || 'Policy requires a human decision.';
}

/**
 * Oldest first, so long-waiting PRs surface; unknown ages go last, then
 * repository name and PR number keep the order stable.
 * @param {{repo: string, pr: object}[]} items
 * @param {Date} now
 */
function sortForReview(items, now) {
  return [...items].sort((a, b) => {
    const ageA = ageInDays(a.pr.opened_at, now);
    const ageB = ageInDays(b.pr.opened_at, now);
    if (ageA !== ageB) {
      if (ageA === null) return 1;
      if (ageB === null) return -1;
      return ageB - ageA;
    }
    return a.repo.localeCompare(b.repo) || a.pr.number - b.pr.number;
  });
}

/**
 * Repositories with at least one open PR, most first. Repos whose PR
 * counts were not collected this run are left out rather than shown as 0.
 * @param {object[]} repositories - rollup repository entries
 * @returns {{repo: string, total: number, dependabot: number, other: number}[]}
 */
function reposWithOpenPrs(repositories) {
  return repositories
    .filter((r) => r.open_pull_requests && r.open_pull_requests.total > 0)
    .map((r) => ({
      repo: r.full_name,
      total: r.open_pull_requests.total,
      dependabot: r.open_pull_requests.dependabot,
      other: r.open_pull_requests.total - r.open_pull_requests.dependabot,
    }))
    .sort((a, b) => b.total - a.total || a.repo.localeCompare(b.repo));
}

/**
 * How old the scan snapshot is, in words, so the page never presents
 * scan-time data as current.
 * @returns {string|null} e.g. "20 hours ago", or null when unknown
 */
function describeSnapshotAge(runTimestamp, now) {
  const ran = Date.parse(runTimestamp || '');
  if (Number.isNaN(ran)) return null;
  const hours = Math.max(0, Math.floor((now.getTime() - ran) / 3600000));
  if (hours < 1) return 'less than an hour ago';
  if (hours < 48) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/**
 * Current state of a PR from GitHub's REST response for
 * GET /repos/{owner}/{repo}/pulls/{number}.
 * @returns {'open'|'merged'|'closed'|null} null when the response is unusable
 */
function liveStateFromApi(apiPr) {
  if (!apiPr || typeof apiPr.state !== 'string') return null;
  if (apiPr.state === 'open') return 'open';
  return apiPr.merged_at ? 'merged' : 'closed';
}

const PrView = { ageInDays, mergeBlocker, sortForReview, reposWithOpenPrs, describeSnapshotAge, liveStateFromApi };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PrView;
} else {
  window.PrView = PrView;
}
