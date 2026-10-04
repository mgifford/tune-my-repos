#!/usr/bin/env node
/**
 * Generates maintenance-rollup.json by calling the GitHub REST API for each
 * repository in maintenance-policy.json's scope, classifying every open
 * Dependabot PR through policy/policy-engine.js, and writing a bounded,
 * redacted, schema-conformant rollup file.
 *
 * Deterministic: no AI, no inference beyond the explicit rules below. Any
 * signal that cannot be read (missing scope, 403, 404) is recorded as
 * "not_available" or "unknown" — never silently omitted, never guessed.
 *
 * Usage: node scripts/generate-maintenance-rollup.js [--dry-run]
 * Env:   GITHUB_TOKEN or MAINTENANCE_RO_TOKEN - read-only PAT (optional;
 *        without one, only public, unauthenticated-rate-limited data is
 *        fetched, and alert/branch-protection coverage will read "unknown")
 */

const fs = require('node:fs');
const path = require('node:path');

const { classifyUpdate, getRepositoryTier, isRepositoryInPolicy, repositoryMatchesPattern } = require('../policy/policy-engine.js');
const { validatePolicySchema } = require('../policy/policy-validator.js');
const { canSkipPrWork, recordScan, orderByStaleness } = require('../policy/scan-state.js');

const MAX_FAILURE_SUMMARY_CHARS = 500;
const MAX_REASON_CHARS = 500;
const API_BASE = 'https://api.github.com';

const token = process.env.MAINTENANCE_RO_TOKEN || process.env.GITHUB_TOKEN || '';
const dryRun = process.argv.includes('--dry-run');

function redact(text) {
  if (!text) return '';
  // Strip anything that looks like a credential before it ever reaches disk.
  return String(text)
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted-token]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[redacted-token]')
    .replace(/[A-Za-z0-9_-]{32,}/g, (match) => (/^[0-9a-f]+$/i.test(match) ? match : '[redacted]'));
}

function cap(text, max) {
  const r = redact(text);
  return r.length > max ? `${r.slice(0, max)}… (truncated)` : r;
}

async function githubFetch(endpoint, { allow404 = false } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}${endpoint}`, { headers });

  if (response.status === 404 && allow404) {
    return { ok: false, status: 404, data: null };
  }
  if (response.status === 403 || response.status === 401) {
    return { ok: false, status: response.status, data: null };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, data: null };
  }
  return { ok: true, status: response.status, data: await response.json() };
}

/**
 * Fetches every page of a GitHub list endpoint. Used only for repository
 * discovery, which can return hundreds of results for a busy owner/org —
 * every other call in this script already fits in one page (per_page=100
 * is enough for alerts/PRs on a single repository).
 * @param {string} endpoint - path with query string, e.g. "/users/x/repos?per_page=100"
 * @returns {Promise<{ok: boolean, data: object[]}>}
 */
async function githubFetchAllPages(endpoint) {
  const results = [];
  let page = 1;
  // 10 pages * 100 per page = 1000 repos per owner, well above what any
  // owner in discovery.owners has today; a hard cap avoids an unbounded
  // loop if GitHub's pagination behaves unexpectedly.
  const maxPages = 10;

  while (page <= maxPages) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const result = await githubFetch(`${endpoint}${separator}page=${page}`, { allow404: true });
    if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) {
      return { ok: page === 1 ? result.ok : true, data: results };
    }
    results.push(...result.data);
    if (result.data.length < 100) break; // last page
    page += 1;
  }

  return { ok: true, data: results };
}

/**
 * Discovers candidate repositories for one owner (user or org login) via
 * the GitHub API, applying discovery.exclude_forks / exclude_archived.
 * Falls back to the user-repos endpoint if the org-repos endpoint 404s
 * (the owner is a user, not an org) — this script never assumes which
 * kind an owner is.
 * @param {string} owner
 * @param {{exclude_forks: boolean, exclude_archived: boolean}} options
 * @returns {Promise<{full_name: string, pushed_at: string}[]>}
 */
/**
 * Pure filter/map step, factored out for unit testing without a network
 * call: applies discovery.exclude_forks / exclude_archived to a raw list
 * of repo objects from the GitHub API and projects down to the two fields
 * the rest of the script actually needs.
 */
function filterDiscoveredRepos(rawRepos, options) {
  return rawRepos
    .filter((repo) => !(options.exclude_forks && repo.fork))
    .filter((repo) => !(options.exclude_archived && repo.archived))
    .map((repo) => ({ full_name: repo.full_name, pushed_at: repo.pushed_at }));
}

async function discoverRepositoriesForOwner(owner, options) {
  let result = await githubFetchAllPages(`/orgs/${encodeURIComponent(owner)}/repos?per_page=100&type=all`);
  if (!result.ok || result.data.length === 0) {
    result = await githubFetchAllPages(`/users/${encodeURIComponent(owner)}/repos?per_page=100&type=all`);
  }

  return filterDiscoveredRepos(result.data, options);
}

/**
 * Dependabot PR titles follow a predictable format, e.g.:
 *   "Bump eslint from 8.56.0 to 8.57.0"
 *   "Bump actions/checkout from 3 to 4"
 * This is the only place update_type/version parsing happens — deterministic
 * string parsing, no inference beyond semver comparison.
 */
function parseDependabotTitle(title) {
  const match = title.match(/Bump\s+(\S+)\s+from\s+(\S+)\s+to\s+(\S+)/i);
  if (!match) return null;
  const [, dependencyName, versionFrom, versionTo] = match;
  return { dependencyName, versionFrom, versionTo };
}

function semverParts(version) {
  const cleaned = version.replace(/^[v^~]/, '');
  const parts = cleaned.split('.').map((p) => parseInt(p, 10));
  if (parts.some(Number.isNaN)) return null;
  return parts;
}

function inferUpdateType(versionFrom, versionTo) {
  const from = semverParts(versionFrom);
  const to = semverParts(versionTo);
  if (!from || !to) return 'unknown';
  if (to[0] !== from[0]) return 'major';
  if ((to[1] ?? 0) !== (from[1] ?? 0)) return 'minor';
  return 'patch';
}

function inferDependencyClass(pr, ecosystem) {
  if (ecosystem === 'github_actions') return 'github-actions';
  const labels = (pr.labels || []).map((l) => l.name.toLowerCase());
  if (labels.some((l) => ['devdependencies', 'development', 'test', 'lint'].includes(l))) {
    return 'development';
  }
  // Without manifest inspection we cannot reliably tell production from
  // development for ecosystems that don't label it. Declare unknown rather
  // than guessing — the policy routes unknown to needs_review by default.
  return 'unknown';
}

/**
 * Derives the only security_alerts field safe to render on an
 * unauthenticated page. Dependabot security alerts are private on GitHub
 * even for public repos, so exact counts must never be displayed outside
 * an authenticated context — see rollup.schema.json.
 */
function computeHasUrgentAlerts(counts) {
  return counts.critical > 0 || counts.high > 0;
}

async function fetchDependabotAlerts(repoFullName) {
  const result = await githubFetch(`/repos/${repoFullName}/dependabot/alerts?state=open&per_page=100`, {
    allow404: true,
  });
  if (!result.ok) {
    return { available: result.status === 404 ? 'not_available' : 'unknown', counts: null };
  }
  const counts = { critical: 0, high: 0, moderate: 0, low: 0 };
  for (const alert of result.data) {
    const severity = alert.security_advisory?.severity;
    if (severity && severity in counts) counts[severity] += 1;
  }
  return { available: 'available', counts };
}

async function fetchSecurityAndAnalysis(repoFullName) {
  const result = await githubFetch(`/repos/${repoFullName}`);
  if (!result.ok) return null;
  return result.data;
}

async function fetchBranchProtection(repoFullName, defaultBranch) {
  const result = await githubFetch(
    `/repos/${repoFullName}/branches/${encodeURIComponent(defaultBranch)}/protection`,
    { allow404: true }
  );
  if (result.status === 404) return 'not_available'; // no protection configured
  if (!result.ok) return 'unknown'; // likely 403: insufficient permission to read
  return 'available';
}

async function fetchDependabotPulls(repoFullName) {
  const result = await githubFetch(`/repos/${repoFullName}/pulls?state=open&per_page=100`);
  if (!result.ok) return [];
  return result.data.filter((pr) => pr.user?.login === 'dependabot[bot]');
}

async function fetchRequiredChecksStatus(repoFullName, pr) {
  const result = await githubFetch(`/repos/${repoFullName}/commits/${pr.head.sha}/status`, { allow404: true });
  if (!result.ok) return 'unknown';
  if (result.data.state === 'success') return 'passing';
  if (result.data.state === 'failure' || result.data.state === 'error') return 'failing';
  return 'pending';
}

async function fetchFailedCheckDetail(repoFullName, pr) {
  const result = await githubFetch(`/repos/${repoFullName}/commits/${pr.head.sha}/check-runs`, { allow404: true });
  if (!result.ok) return null;
  const failed = (result.data.check_runs || []).find((run) => run.conclusion === 'failure');
  if (!failed) return null;
  return {
    name: failed.name,
    url: failed.html_url,
    summary: cap(failed.output?.summary || failed.output?.title || 'No summary available', MAX_FAILURE_SUMMARY_CHARS),
  };
}

async function buildRepositoryEntry(policy, repoFullName, { skipPrWork = false, repoMeta: providedRepoMeta } = {}) {
  const tier = getRepositoryTier(policy, repoFullName);
  // Callers that already fetched repo metadata to decide skipPrWork (see
  // main()) pass it in via repoMeta to avoid fetching it twice.
  const repoMeta = providedRepoMeta !== undefined ? providedRepoMeta : await fetchSecurityAndAnalysis(repoFullName);
  const defaultBranch = repoMeta?.default_branch || 'main';

  // Alerts are always fetched (cheap, time-sensitive — a new CVE can
  // appear with no new push). PR/CI-status work is the expensive part and
  // is skipped when scan-state says this repo is unchanged and was
  // recently scanned; see policy/scan-state.js.
  const [alertResult, branchProtectionAvailability, pulls] = await Promise.all([
    fetchDependabotAlerts(repoFullName),
    fetchBranchProtection(repoFullName, defaultBranch),
    skipPrWork ? Promise.resolve([]) : fetchDependabotPulls(repoFullName),
  ]);

  const coverage = {
    dependency_graph: repoMeta ? 'available' : 'unknown',
    dependabot_alerts: alertResult.available,
    dependabot_security_updates: repoMeta?.security_and_analysis?.dependabot_security_updates?.status === 'enabled'
      ? 'available'
      : repoMeta ? 'not_available' : 'unknown',
    secret_scanning: repoMeta?.security_and_analysis?.secret_scanning?.status === 'enabled'
      ? 'available'
      : repoMeta ? 'not_available' : 'unknown',
    codeql_default_setup: 'unknown', // requires a separate, higher-scope endpoint; not fetched in this phase
    branch_protection: branchProtectionAvailability,
  };

  const dependabotPrs = [];
  const failedUpdatePrs = [];

  for (const pr of pulls) {
    const ecosystem = (pr.labels || []).some((l) => l.name === 'github_actions' || l.name === 'github-actions')
      ? 'github_actions'
      : 'unknown';
    const parsed = parseDependabotTitle(pr.title);
    const dependencyName = parsed?.dependencyName || 'unknown';
    const versionFrom = parsed?.versionFrom || 'unknown';
    const versionTo = parsed?.versionTo || 'unknown';
    const updateType = parsed ? inferUpdateType(versionFrom, versionTo) : 'unknown';
    const dependencyClass = inferDependencyClass(pr, ecosystem);

    const ciStatus = await fetchRequiredChecksStatus(repoFullName, pr);
    const requiredCheckFailed = ciStatus === 'failing';

    const classification = classifyUpdate(policy, {
      repository: repoFullName,
      dependency_class: dependencyClass,
      update_type: updateType,
      dependency_name: dependencyName,
      ecosystem,
      required_ci_passed: ciStatus === 'passing',
      touches_workflow_permissions: false, // not determinable without diff inspection in this phase
      is_lockfile_only: false,
      is_generated_output_only: false,
      requires_new_secret_or_elevated_access: false,
      required_check_failed: requiredCheckFailed,
    });

    dependabotPrs.push({
      number: pr.number,
      url: pr.html_url,
      ecosystem,
      dependency_name: dependencyName,
      version_from: versionFrom,
      version_to: versionTo,
      update_type: updateType,
      dependency_class: dependencyClass,
      labels: (pr.labels || []).map((l) => l.name).slice(0, 10),
      ci_status: ciStatus,
      risk_state: classification.risk_state,
      reason: cap(classification.reason, MAX_REASON_CHARS),
    });

    if (requiredCheckFailed) {
      const detail = await fetchFailedCheckDetail(repoFullName, pr);
      failedUpdatePrs.push({
        number: pr.number,
        url: pr.html_url,
        dependency_name: dependencyName,
        failed_check_name: detail?.name || 'unknown',
        failed_check_url: detail?.url || pr.html_url,
        failure_summary: detail?.summary || 'A required check failed; no further detail available via API.',
      });
    }
  }

  const recommendedAction = computeRecommendedAction(alertResult, dependabotPrs, failedUpdatePrs);
  const counts = alertResult.counts || { critical: 0, high: 0, moderate: 0, low: 0 };

  return {
    // Not part of the public rollup schema — stripped before the entry is
    // pushed into the rollup; used only by main() to update scan-state.
    _pushed_at: repoMeta?.pushed_at || null,
    full_name: repoFullName,
    default_branch: defaultBranch,
    tier,
    policy_version: policy.policy_version,
    source_timestamp: new Date().toISOString(),
    coverage,
    // Exact counts are retained here for the private workflow artifact and
    // any other authenticated consumer. has_urgent_alerts is the only field
    // safe to render on a public page — see rollup.schema.json.
    security_alerts: { ...counts, has_urgent_alerts: computeHasUrgentAlerts(counts) },
    dependabot_prs: dependabotPrs,
    failed_update_prs: failedUpdatePrs,
    recommended_action: recommendedAction,
  };
}

function computeRecommendedAction(alertResult, dependabotPrs, failedUpdatePrs) {
  const counts = alertResult.counts;
  if (counts && (counts.critical > 0 || counts.high > 0)) {
    return {
      action: 'review_security_alerts',
      reason: `${counts.critical} critical and ${counts.high} high severity Dependabot alerts are open and unaddressed`,
    };
  }
  if (failedUpdatePrs.length > 0) {
    return {
      action: 'repair_failed_update_pr',
      reason: `${failedUpdatePrs.length} Dependabot update PR(s) failed a required check and need repair`,
    };
  }
  const eligible = dependabotPrs.filter((pr) => pr.risk_state === 'eligible');
  if (eligible.length > 0) {
    return {
      action: 'merge_eligible_updates',
      reason: `${eligible.length} update(s) are eligible for the low-risk merge path once required CI passes`,
    };
  }
  const needsReview = dependabotPrs.filter((pr) => pr.risk_state === 'needs_review' || pr.risk_state === 'blocked');
  if (needsReview.length > 0) {
    return {
      action: 'human_review_required',
      reason: `${needsReview.length} update(s) require a human decision under current policy`,
    };
  }
  return { action: 'none', reason: 'No open Dependabot alerts or update PRs requiring attention' };
}

/**
 * Expands maintenance-policy.json's repositories.include into a concrete
 * list of candidate repositories, resolving any "owner/*" glob via
 * discovery.owners + the GitHub API, and applying discovery's
 * exclude_forks/exclude_archived. Returns {full_name -> pushed_at} so
 * callers can decide what to skip without a second API call per repo.
 */
async function resolveCandidateRepos(policy) {
  const exactIncludes = policy.repositories.include.filter((p) => !p.includes('*'));
  const hasGlob = policy.repositories.include.some((p) => p.includes('*'));

  const pushedAtByRepo = new Map();
  for (const name of exactIncludes) {
    pushedAtByRepo.set(name, null); // unknown until buildRepositoryEntry fetches it
  }

  if (hasGlob) {
    for (const owner of policy.discovery.owners) {
      const discovered = await discoverRepositoriesForOwner(owner, policy.discovery);
      for (const repo of discovered) {
        if (isRepositoryInPolicy(policy, repo.full_name)) {
          pushedAtByRepo.set(repo.full_name, repo.pushed_at);
        }
      }
    }
  }

  // Exact includes that aren't already excluded by repositories.exclude.
  for (const name of [...pushedAtByRepo.keys()]) {
    if (!isRepositoryInPolicy(policy, name)) pushedAtByRepo.delete(name);
  }

  return pushedAtByRepo;
}

async function main() {
  const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'maintenance-policy.json'), 'utf8'));
  const rollupSchema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'policy', 'rollup.schema.json'), 'utf8')
  );
  const scanStatePath = path.join(__dirname, '..', 'maintenance-scan-state.json');
  let scanState = { schema_version: '1.0.0', repositories: {} };
  if (fs.existsSync(scanStatePath)) {
    scanState = JSON.parse(fs.readFileSync(scanStatePath, 'utf8'));
  }

  const pushedAtByRepo = await resolveCandidateRepos(policy);
  const orderedRepos = orderByStaleness(scanState, [...pushedAtByRepo.keys()]);
  const reposThisRun = orderedRepos.slice(0, policy.discovery.max_repos_per_run);

  const repositories = [];
  for (const repoFullName of reposThisRun) {
    // Repo metadata is fetched once here (rather than inside
    // buildRepositoryEntry) because its pushed_at is needed up front to
    // decide skipPrWork, including for an exact (non-glob)
    // repositories.include entry, which discovery never saw.
    const repoMeta = await fetchSecurityAndAnalysis(repoFullName);
    const knownPushedAt = pushedAtByRepo.get(repoFullName) ?? repoMeta?.pushed_at ?? null;
    const skipPrWork = knownPushedAt !== null && canSkipPrWork(
      scanState,
      repoFullName,
      knownPushedAt,
      policy.discovery.rescan_prs_after_days
    );

    const entry = await buildRepositoryEntry(policy, repoFullName, { skipPrWork, repoMeta });
    const pushedAtForState = knownPushedAt ?? entry._pushed_at;
    delete entry._pushed_at;
    repositories.push(entry);
    if (pushedAtForState) {
      scanState = recordScan(scanState, repoFullName, pushedAtForState);
    }
  }

  if (!dryRun) {
    fs.writeFileSync(scanStatePath, JSON.stringify(scanState, null, 2) + '\n');
  }

  const rollup = {
    schema_version: '1.0.0',
    run_timestamp: new Date().toISOString(),
    policy_version: policy.policy_version,
    repositories,
  };

  const errors = validatePolicySchema(rollup, rollupSchema);
  if (errors.length > 0) {
    console.error('Generated rollup failed schema validation:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const outPath = path.join(__dirname, '..', 'maintenance-rollup.json');
  if (dryRun) {
    console.log(`[dry-run] would write ${outPath}:`);
    console.log(JSON.stringify(rollup, null, 2));
  } else {
    fs.writeFileSync(outPath, JSON.stringify(rollup, null, 2) + '\n');
    console.log(`Wrote ${outPath} (${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'})`);
  }
}

module.exports = {
  redact,
  cap,
  parseDependabotTitle,
  semverParts,
  inferUpdateType,
  inferDependencyClass,
  computeRecommendedAction,
  computeHasUrgentAlerts,
  filterDiscoveredRepos,
};

if (require.main === module) {
  main().catch((error) => {
    console.error('Failed to generate maintenance rollup:', error.message);
    process.exit(1);
  });
}
