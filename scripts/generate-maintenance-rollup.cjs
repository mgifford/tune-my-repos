#!/usr/bin/env node
/**
 * Generates maintenance-rollup.json by calling the GitHub REST API for each
 * repository in maintenance-policy.json's scope, classifying every open
 * Dependabot PR through policy/policy-engine.cjs, and writing a bounded,
 * redacted, schema-conformant rollup file.
 *
 * Deterministic: no AI, no inference beyond the explicit rules below. Any
 * signal that cannot be read (missing scope, 403, 404) is recorded as
 * "not_available" or "unknown" — never silently omitted, never guessed.
 *
 * Usage: node scripts/generate-maintenance-rollup.cjs [--dry-run]
 * Env:   GITHUB_TOKEN or MAINTENANCE_RO_TOKEN - read-only PAT (optional;
 *        without one, only public, unauthenticated-rate-limited data is
 *        fetched, and alert/branch-protection coverage will read "unknown")
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { classifyUpdate, getRepositoryTier, isRepositoryInPolicy, repositoryMatchesPattern } = require('../policy/policy-engine.cjs');
const { validatePolicySchema } = require('../policy/policy-validator.cjs');
const {
  canSkipPrWork,
  canSkipAfterProbe,
  getIssuesEtag,
  recordIssuesEtag,
  recordScan,
  pruneToRepositories,
  orderByActivityThenStaleness,
} = require('../policy/scan-state.cjs');
const { redactExactAlertCounts } = require('../policy/public-redaction.cjs');
const { KNOWN_REPLACEMENTS, listDirectDependencies, evaluateLibraryAdvice } = require('../policy/library-advice.cjs');
const { makeEvent } = require('./lib/resource/event.cjs');

const MAX_FAILURE_SUMMARY_CHARS = 500;
// GitHub allows 60 unauthenticated requests/hour; a repository costs
// roughly 6 or more, so an unauthenticated run stays small.
const UNAUTHENTICATED_MAX_REPOS = 8;
const MAX_REASON_CHARS = 500;
const API_BASE = 'https://api.github.com';

const token = process.env.MAINTENANCE_RO_TOKEN || process.env.GITHUB_TOKEN || '';
const dryRun = process.argv.includes('--dry-run');
const resourceOutArg = process.argv.find((arg) => arg.startsWith('--resource-out='));
const resourceOutPath = resourceOutArg ? path.resolve(resourceOutArg.slice('--resource-out='.length)) : null;

// Measured API/cache counters for this run. These are counts of requests this
// process actually made; they are never converted into energy.
function createApiMetrics() {
  return {
    requests: 0,
    status_200: 0,
    status_304: 0,
    failed: 0,
    rate_limited: 0,
    cache_hits: 0,
    cache_misses: 0,
    repositories_discovered: 0,
    repositories_evaluated: 0,
    repositories_skipped: 0,
    carried_forward: 0,
    security_checks: 0,
    response_bytes: 0,
    completeness: null,
    freshness: null,
  };
}
let apiMetrics = createApiMetrics();
function resetApiMetrics() {
  apiMetrics = createApiMetrics();
  return apiMetrics;
}

function isSecurityEndpoint(endpoint) {
  return /\/(dependabot\/alerts|secret-scanning|code-scanning|branches\/|rules\/branches)/.test(endpoint);
}
// Set LIBRARY_ADVICE_REGISTRY=off to skip npm registry lookups (curated
// rules still apply).
const registryLookups = process.env.LIBRARY_ADVICE_REGISTRY !== 'off';

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

/**
 * Pure: the git blob SHA-1 of a file's bytes, equal to `git hash-object`.
 * Identifies the exact AGENTS.md a run used without needing git history,
 * which the workflow's shallow checkout does not have.
 * @param {Buffer} bytes
 */
function gitBlobSha(bytes) {
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * @param {string} endpoint
 * @param {{allow404?: boolean, raw?: boolean, etag?: string|null}} [options]
 *   etag: a stored ETag; sent as If-None-Match. A 304 reply is returned as
 *   {ok: false, status: 304, notModified: true}, so a caller that ignores it
 *   treats the data as unreadable, never as empty.
 * @returns {Promise<{ok: boolean, status: number, data: any, etag?: string|null, notModified?: boolean}>}
 */
async function githubFetch(endpoint, {
  allow404 = false,
  raw = false,
  etag = null,
  authToken = token,
  security = false,
  cacheCheck = false,
  count = true,
} = {}) {
  const headers = {
    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (etag) headers['If-None-Match'] = etag;

  if (count) apiMetrics.requests += 1;
  const response = await fetch(`${API_BASE}${endpoint}`, { headers });
  // Read the body once so response bytes are measured, then parse it. A 304
  // has no body. This does not alter the existing ok/304/404/403 contract.
  const bodyText = response.status === 304 ? '' : await response.text();
  if (count) apiMetrics.response_bytes += Buffer.byteLength(bodyText, 'utf8');
  if (count && response.status === 200) apiMetrics.status_200 += 1;
  if (count && response.status === 304) apiMetrics.status_304 += 1;
  if (count && response.status >= 400 && response.status !== 304) apiMetrics.failed += 1;
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (count && (response.status === 429 || (response.status === 403 && (remaining === '0' || response.headers.get('retry-after'))))) {
    apiMetrics.rate_limited += 1;
  }
  if (count && cacheCheck) {
    if (response.status === 304) apiMetrics.cache_hits += 1;
    else if (response.status === 200) apiMetrics.cache_misses += 1;
  }
  if (count && (security || isSecurityEndpoint(endpoint))) apiMetrics.security_checks += 1;

  if (response.status === 304) {
    return { ok: false, status: 304, notModified: true, data: null };
  }
  if (response.status === 404 && allow404) {
    return { ok: false, status: 404, data: null };
  }
  if (response.status === 403 || response.status === 401) {
    return { ok: false, status: response.status, data: null };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, data: null };
  }
  let data = null;
  if (raw) data = bodyText;
  else if (bodyText) data = JSON.parse(bodyText);
  return {
    ok: true,
    status: response.status,
    etag: response.headers.get('etag'),
    data,
  };
}

/** One stable URL, so the ETag stored from one run matches the next run's request. */
function openIssuesEndpoint(repoFullName) {
  return `/repos/${repoFullName}/issues?state=open&per_page=100&sort=updated&direction=desc`;
}

/**
 * Reads the open issues-and-PRs list, conditionally when an ETag is known.
 * @returns {Promise<{outcome: 'not_modified'|'modified'|'unknown', items: object[]|null, etag: string|null}>}
 */
async function probeOpenIssues(repoFullName, storedEtag) {
  const result = await githubFetch(openIssuesEndpoint(repoFullName), { allow404: true, etag: storedEtag, cacheCheck: true });
  if (result.notModified) return { outcome: 'not_modified', items: null, etag: storedEtag };
  if (result.ok && Array.isArray(result.data)) return { outcome: 'modified', items: result.data, etag: result.etag || null };
  return { outcome: 'unknown', items: null, etag: null };
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
    // Never configurable: every output of this script is published (the
    // public rollup and the committed scan-state), so a private repository
    // must not even be named in it.
    .filter((repo) => repo.private !== true)
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
  const match = String(title || '').match(/(?:Bump|Update)\s+(\S+)\s+(?:requirement\s+)?from\s+(\S+)\s+to\s+(\S+)/i);
  if (!match) return null;
  const [, dependencyName, versionFrom, versionTo] = match;
  return { dependencyName, versionFrom, versionTo };
}

/**
 * Grouped and multi-dependency Dependabot PRs ("Bump the npm_and_yarn group
 * ... with 3 updates") carry no single version in the title. Their body
 * lists each one as "Updates `name` from X to Y". Pure string parsing.
 * @returns {{dependencyName: string, versionFrom: string, versionTo: string}[]}
 */
function parseDependabotBodyUpdates(body) {
  const updates = [];
  const seen = new Set();
  const re = /Updates `([^`]+)` from (\S+?)[.,]? to (\S+?)[.,]?(?:\s|$)/g;
  for (const m of String(body || '').matchAll(re)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    updates.push({ dependencyName: m[1], versionFrom: m[2], versionTo: m[3] });
  }
  return updates;
}

const UPDATE_TYPE_RANK = { patch: 1, minor: 2, major: 3 };

/**
 * Combines per-dependency update types for a multi-update PR: the riskiest
 * wins, and any unparseable version makes the whole PR "unknown".
 */
function combineUpdateTypes(types) {
  if (types.length === 0 || types.includes('unknown')) return 'unknown';
  return types.reduce((a, b) => (UPDATE_TYPE_RANK[b] > UPDATE_TYPE_RANK[a] ? b : a));
}

/**
 * Combines per-dependency classes for a multi-update PR, conservatively:
 * any unknown -> unknown; any production -> production.
 */
function combineDependencyClasses(classes) {
  if (classes.length === 0 || classes.includes('unknown')) return 'unknown';
  if (classes.includes('production')) return 'production';
  return classes.every((c) => c === classes[0]) ? classes[0] : 'unknown';
}

function describeDependencies(names, max = 3) {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} (+${names.length - max} more)`;
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

function inferDependencyClassFromLabels(pr) {
  const labels = (pr.labels || []).map((l) => l.name.toLowerCase());
  if (labels.some((l) => ['devdependencies', 'development', 'test', 'lint'].includes(l))) {
    return 'development';
  }
  return null;
}

/**
 * Looks up a dependency name in a parsed package.json's dependencies /
 * devDependencies maps. Pure function, no network access. Returns null
 * (not "unknown") for a transitive dependency that isn't listed directly
 * — the caller must fall back to "unknown" explicitly, since this
 * function cannot distinguish "not found because transitive" from
 * "not found because it's the wrong manifest".
 * @param {object} packageJson - parsed package.json content
 * @param {string} dependencyName
 * @returns {'production'|'development'|null}
 */
function classifyFromPackageJson(packageJson, dependencyName) {
  if (packageJson?.devDependencies && dependencyName in packageJson.devDependencies) {
    return 'development';
  }
  if (packageJson?.dependencies && dependencyName in packageJson.dependencies) {
    return 'production';
  }
  return null;
}

/**
 * Classifies a dependency (direct or transitive) from a parsed npm
 * package-lock.json. npm marks packages reachable only through
 * devDependencies with "dev": true; anything else ships at runtime
 * ("devOptional" is treated as production, conservatively). Pure.
 * @returns {'production'|'development'|null} null when not found
 */
function classifyFromPackageLock(lock, dependencyName) {
  if (!lock || typeof lock !== 'object') return null;
  if (lock.packages && typeof lock.packages === 'object') {
    const suffix = `node_modules/${dependencyName}`;
    const entries = Object.entries(lock.packages).filter(([key]) => key === suffix || key.endsWith(`/${suffix}`));
    if (entries.length === 0) return null;
    return entries.every(([, entry]) => entry && entry.dev === true) ? 'development' : 'production';
  }
  const legacy = lock.dependencies?.[dependencyName]; // lockfileVersion 1
  if (!legacy) return null;
  return legacy.dev === true ? 'development' : 'production';
}

// One run fetches each manifest at most once per repo/ref/path, however many
// PRs need it.
const manifestCache = new Map();

async function fetchJsonFile(repoFullName, ref, filePath) {
  const key = `${repoFullName}@${ref}:${filePath}`;
  if (!manifestCache.has(key)) {
    manifestCache.set(key, (async () => {
      const result = await githubFetch(
        `/repos/${repoFullName}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
        { allow404: true, raw: true }
      );
      if (!result.ok || typeof result.data !== 'string') return null;
      try {
        return JSON.parse(result.data);
      } catch {
        return null; // malformed content; never throw on untrusted repo data
      }
    })());
  }
  return manifestCache.get(key);
}

// One lookup per package name per run, shared by every repository.
const registryCache = new Map();

async function registryJson(url) {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null; // registry unreachable: no advice rather than a guess
  }
}

/**
 * Public npm registry facts for one package: the latest version's
 * deprecation message, and (only if not deprecated) its publish date via
 * the search endpoint, which is far smaller than the full packument.
 * @returns {Promise<{deprecated?: string, lastPublished?: string}|null>}
 */
async function fetchNpmRegistryFacts(name) {
  if (!registryCache.has(name)) {
    registryCache.set(name, (async () => {
      const encoded = name.replace('/', '%2f');
      const latest = await registryJson(`https://registry.npmjs.org/${encoded}/latest`);
      if (!latest) return null;
      if (latest.deprecated) return { deprecated: String(latest.deprecated).slice(0, 200) };
      const search = await registryJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(name)}&size=5`);
      const hit = (search?.objects || []).find((o) => o.package?.name === name);
      return hit?.package?.date ? { lastPublished: hit.package.date } : {};
    })());
  }
  return registryCache.get(name);
}

async function buildLibraryAdvice(repoFullName, defaultBranch) {
  const packageJson = await fetchJsonFile(repoFullName, defaultBranch, 'package.json');
  if (!packageJson) return null; // no npm manifest at the root: nothing to advise on
  const dependencies = listDirectDependencies(packageJson);
  const facts = new Map();
  if (registryLookups) {
    const toCheck = dependencies.filter((d) => !KNOWN_REPLACEMENTS[d.name]);
    for (let i = 0; i < toCheck.length; i += 8) {
      const batch = toCheck.slice(i, i + 8);
      const results = await Promise.all(batch.map((d) => fetchNpmRegistryFacts(d.name)));
      batch.forEach((d, j) => facts.set(d.name, results[j]));
    }
  }
  return evaluateLibraryAdvice(dependencies, facts, new Date()).map((a) => ({ ...a, suggestion: cap(a.suggestion, 300) }));
}

/**
 * Pure: the directory holding the npm manifest a PR changes ("" for root),
 * so nested packages are classified against their own manifest.
 */
function npmManifestDir(changedFiles) {
  const hit = (changedFiles || []).find((f) => /(^|\/)(package\.json|package-lock\.json)$/.test(f));
  if (!hit || !hit.includes('/')) return '';
  return hit.slice(0, hit.lastIndexOf('/') + 1);
}

/**
 * Determines a PR's dependency class: labels first (cheap, already
 * fetched), falling back to reading the base branch's package.json for
 * npm PRs when no identifying label exists. A direct dependency not found
 * in the manifest is assumed transitive and left "unknown" rather than
 * guessed — see classifyFromPackageJson.
 */
async function inferDependencyClass(pr, ecosystem, repoFullName, dependencyName, baseRef, manifestDir = '') {
  if (ecosystem === 'github_actions') return 'github-actions';

  const fromLabel = inferDependencyClassFromLabels(pr);
  if (fromLabel) return fromLabel;

  if (ecosystem === 'npm' && dependencyName !== 'unknown') {
    const packageJson = await fetchJsonFile(repoFullName, baseRef, `${manifestDir}package.json`);
    const fromManifest = classifyFromPackageJson(packageJson, dependencyName);
    if (fromManifest) return fromManifest;
    // Transitive dependency: the lockfile records whether it is dev-only.
    const lock = await fetchJsonFile(repoFullName, baseRef, `${manifestDir}package-lock.json`);
    const fromLock = classifyFromPackageLock(lock, dependencyName);
    if (fromLock) return fromLock;
  }

  // Without a label or a direct manifest entry (e.g. a transitive
  // dependency, or an ecosystem without manifest support yet), we cannot
  // reliably classify. Declare unknown rather than guessing — the policy
  // routes unknown to needs_review by default.
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
  const result = await githubFetch(`/repos/${repoFullName}`, { security: true });
  if (!result.ok) return null;
  return result.data;
}

/**
 * Pure: combines classic branch protection with repository rulesets. The
 * classic endpoint needs Administration: read and never sees rulesets;
 * the rules endpoint is readable on any public repository.
 * @param {'available'|'not_available'|'unknown'} classic
 * @param {object[]|null} rules - active rules on the branch, null if unreadable
 */
function combineBranchProtection(classic, rules) {
  if (classic === 'available' || (rules && rules.length > 0)) return 'available';
  if (classic === 'not_available' && rules) return 'not_available';
  return 'unknown';
}

async function fetchBranchProtection(repoFullName, defaultBranch) {
  const branch = encodeURIComponent(defaultBranch);
  const [classicResult, rulesResult] = await Promise.all([
    githubFetch(`/repos/${repoFullName}/branches/${branch}/protection`, { allow404: true }),
    githubFetch(`/repos/${repoFullName}/rules/branches/${branch}`, { allow404: true }),
  ]);
  const classic = classicResult.status === 404 ? 'not_available' : classicResult.ok ? 'available' : 'unknown';
  const rules = rulesResult.ok && Array.isArray(rulesResult.data) ? rulesResult.data : null;
  return combineBranchProtection(classic, rules);
}

/**
 * Pure: a security_and_analysis setting's coverage. GitHub omits the whole
 * security_and_analysis block unless the token has admin-level read, so a
 * missing block is "unknown", never "not_available".
 */
function securitySettingStatus(repoMeta, key) {
  if (!repoMeta || !repoMeta.security_and_analysis) return 'unknown';
  return repoMeta.security_and_analysis[key]?.status === 'enabled' ? 'available' : 'not_available';
}

async function fetchOpenPulls(repoFullName) {
  const result = await githubFetch(`/repos/${repoFullName}/pulls?state=open&per_page=100`);
  return result.ok ? result.data : null; // null: unreadable, distinct from "none open"
}

const FAILING_CONCLUSIONS = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'];

// Job names in .github/workflows/dependabot-pilot.yml (a test keeps them in
// step). That workflow labels PRs and requests auto-merge; it does not test
// the update, so its result says nothing about whether the update is safe.
// In the 2026-11-15 rollup, cancelled pilot runs (Dependabot's own labels on
// a new PR each start one) and a pilot permission error marked passing
// updates needs_repair.
const PILOT_CHECK_NAMES = ['Label Dependabot PR', 'Request auto-merge if eligible'];

/**
 * Pure: derives one CI status from GitHub Actions check runs plus legacy
 * commit statuses. GitHub Actions reports only via check runs, and the
 * legacy combined status reads "pending" when no statuses exist at all, so
 * using it alone made every Actions-only PR look pending forever.
 * Skipped/neutral runs are ignored. All checks count, not only required
 * ones (required-check config needs admin scope to read), except the
 * Dependabot Pilot's own jobs (PILOT_CHECK_NAMES).
 * @param {object[]|null} checkRuns - check_runs array, or null if unreadable
 * @param {object|null} combinedStatus - /status response, or null if unreadable
 * @returns {'passing'|'failing'|'pending'|'none'|'unknown'}
 */
function summarizeCiStatus(checkRuns, combinedStatus) {
  if (checkRuns === null && combinedStatus === null) return 'unknown';
  const states = [];
  for (const run of checkRuns || []) {
    if (PILOT_CHECK_NAMES.includes(run.name)) continue;
    if (run.status !== 'completed') states.push('pending');
    else if (FAILING_CONCLUSIONS.includes(run.conclusion)) states.push('failing');
    else if (run.conclusion === 'success') states.push('passing');
  }
  if (combinedStatus && combinedStatus.total_count > 0) {
    if (combinedStatus.state === 'success') states.push('passing');
    else if (combinedStatus.state === 'failure' || combinedStatus.state === 'error') states.push('failing');
    else states.push('pending');
  }
  if (states.includes('failing')) return 'failing';
  if (states.includes('pending')) return 'pending';
  if (states.includes('passing')) return 'passing';
  return 'none';
}

function findFailedCheckRun(checkRuns) {
  return (checkRuns || []).find((run) => !PILOT_CHECK_NAMES.includes(run.name)
    && run.status === 'completed' && FAILING_CONCLUSIONS.includes(run.conclusion)) || null;
}

async function fetchCiState(repoFullName, pr) {
  const [runs, status] = await Promise.all([
    githubFetch(`/repos/${repoFullName}/commits/${pr.head.sha}/check-runs?per_page=100`, { allow404: true }),
    githubFetch(`/repos/${repoFullName}/commits/${pr.head.sha}/status`, { allow404: true }),
  ]);
  const checkRuns = runs.ok ? runs.data.check_runs || [] : null;
  return { checkRuns, ciStatus: summarizeCiStatus(checkRuns, status.ok ? status.data : null) };
}

async function fetchChangedFiles(repoFullName, pr) {
  const result = await githubFetch(`/repos/${repoFullName}/pulls/${pr.number}/files?per_page=100`, { allow404: true });
  if (!result.ok) return [];
  return result.data.map((f) => f.filename);
}

/**
 * Pure: maps a PR's changed file names to a package ecosystem. Dependabot
 * always changes a recognizable manifest/lockfile for the ecosystem it's
 * updating, so this is a reliable signal independent of labels.
 * @param {string[]} filenames
 * @returns {string} one of 'npm', 'github_actions', 'composer', 'unknown'
 */
function detectEcosystemFromFiles(filenames) {
  if (filenames.some((f) => f.startsWith('.github/workflows/'))) return 'github_actions';
  if (filenames.some((f) => /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f))) return 'npm';
  if (filenames.some((f) => /(^|\/)(composer\.json|composer\.lock)$/.test(f))) return 'composer';
  return 'unknown';
}

// Dependabot's default language labels seen on "unknown" PRs in the
// 2026-11-15 rollup. Bare "python" is not mapped: pip, Poetry and uv share it.
const ECOSYSTEM_BY_LABEL = { ruby: 'bundler', 'python:uv': 'uv' };

/**
 * Pure: a PR's ecosystem from its changed files, falling back to its
 * Dependabot language label only when the files are not recognized.
 */
function resolveEcosystem(changedFiles, pr) {
  const fromFiles = detectEcosystemFromFiles(changedFiles);
  if (fromFiles !== 'unknown') return fromFiles;
  const label = (pr.labels || []).map((l) => l.name.toLowerCase()).find((n) => Object.hasOwn(ECOSYSTEM_BY_LABEL, n));
  return label ? ECOSYSTEM_BY_LABEL[label] : 'unknown';
}

function failedCheckDetail(checkRuns) {
  const failed = findFailedCheckRun(checkRuns);
  if (!failed) return null;
  return {
    name: failed.name,
    url: failed.html_url,
    summary: cap(failed.output?.summary || failed.output?.title || 'No summary available', MAX_FAILURE_SUMMARY_CHARS),
  };
}

/**
 * Pure: PR-derived fields to reuse when this run skipped a repository's PR
 * work (unchanged since its last scan). Without this, a skipped repository
 * was published with no PRs at all, so back-to-back runs emptied the
 * dashboard. Any merge or new Dependabot PR changes pushed_at, which forces
 * a fresh scan, so the carried data is still accurate; the page's live
 * check also removes PRs merged since.
 * @param {object|undefined} previousEntry - this repo's entry in the last published rollup
 */
function carryForwardPrData(previousEntry) {
  if (!previousEntry) {
    return { dependabotPrs: [], failedUpdatePrs: [], openPullRequests: null, libraryAdvice: null, prDataAsOf: null };
  }
  return {
    dependabotPrs: previousEntry.dependabot_prs || [],
    failedUpdatePrs: previousEntry.failed_update_prs || [],
    openPullRequests: previousEntry.open_pull_requests || null,
    libraryAdvice: previousEntry.library_advice || null,
    prDataAsOf: previousEntry.pr_data_as_of || previousEntry.source_timestamp || null,
  };
}

/** Pure: whether a previous entry holds PR data that may be carried forward. */
function hasCarryablePrData(previousEntry) {
  return Boolean(previousEntry && previousEntry.pr_data_as_of && Array.isArray(previousEntry.dependabot_prs));
}

async function buildRepositoryEntry(policy, repoFullName, { skipPrWork = false, repoMeta: providedRepoMeta, previousEntry } = {}) {
  const tier = getRepositoryTier(policy, repoFullName);
  // Callers that already fetched repo metadata to decide skipPrWork (see
  // main()) pass it in via repoMeta to avoid fetching it twice.
  const repoMeta = providedRepoMeta !== undefined ? providedRepoMeta : await fetchSecurityAndAnalysis(repoFullName);
  const defaultBranch = repoMeta?.default_branch || 'main';

  // Alerts are always fetched (cheap, time-sensitive — a new CVE can
  // appear with no new push). PR/CI-status work is the expensive part and
  // is skipped when scan-state says this repo is unchanged and was
  // recently scanned; see policy/scan-state.cjs.
  const [alertResult, branchProtectionAvailability, openPulls] = await Promise.all([
    fetchDependabotAlerts(repoFullName),
    fetchBranchProtection(repoFullName, defaultBranch),
    skipPrWork ? Promise.resolve(null) : fetchOpenPulls(repoFullName),
  ]);
  const pulls = (openPulls || []).filter((pr) => pr.user?.login === 'dependabot[bot]');
  // Public repos only: a private repo's dependency list must never reach
  // the published rollup. Refreshed on the same cadence as PR work.
  const libraryAdvice = !skipPrWork && repoMeta && repoMeta.private === false
    ? await buildLibraryAdvice(repoFullName, defaultBranch)
    : null;

  const coverage = {
    dependency_graph: repoMeta ? 'available' : 'unknown',
    dependabot_alerts: alertResult.available,
    dependabot_security_updates: securitySettingStatus(repoMeta, 'dependabot_security_updates'),
    secret_scanning: securitySettingStatus(repoMeta, 'secret_scanning'),
    codeql_default_setup: 'unknown', // requires a separate, higher-scope endpoint; not fetched in this phase
    branch_protection: branchProtectionAvailability,
  };

  const dependabotPrs = [];
  const failedUpdatePrs = [];

  for (const pr of pulls) {
    const changedFiles = await fetchChangedFiles(repoFullName, pr);
    const ecosystem = resolveEcosystem(changedFiles, pr);
    const manifestDir = npmManifestDir(changedFiles);
    const bodyUpdates = parseDependabotBodyUpdates(pr.body);
    const titleUpdate = parseDependabotTitle(pr.title);
    // A grouped PR's body lists every update; otherwise trust the title.
    const updates = bodyUpdates.length > 1 ? bodyUpdates : titleUpdate ? [titleUpdate] : bodyUpdates;
    const single = updates.length === 1 ? updates[0] : null;
    const dependencyName = updates.length ? describeDependencies(updates.map((u) => u.dependencyName)) : 'unknown';
    const versionFrom = single ? single.versionFrom : updates.length ? 'multiple' : 'unknown';
    const versionTo = single ? single.versionTo : updates.length ? 'multiple' : 'unknown';
    const updateType = combineUpdateTypes(updates.map((u) => inferUpdateType(u.versionFrom, u.versionTo)));
    const classes = [];
    for (const u of updates) {
      classes.push(await inferDependencyClass(pr, ecosystem, repoFullName, u.dependencyName, pr.base.ref, manifestDir));
    }
    const dependencyClass = combineDependencyClasses(classes);

    const { checkRuns, ciStatus } = await fetchCiState(repoFullName, pr);
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
      opened_at: pr.created_at,
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
      const detail = failedCheckDetail(checkRuns);
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

  // Skipped this run: reuse the last published PR data instead of
  // publishing none (alerts above are always re-checked regardless).
  const carried = skipPrWork ? carryForwardPrData(previousEntry) : null;
  if (carried) {
    dependabotPrs.push(...carried.dependabotPrs);
    failedUpdatePrs.push(...carried.failedUpdatePrs);
  }
  const openPullRequests = openPulls
    ? { total: openPulls.length, dependabot: pulls.length }
    : carried?.openPullRequests || null;
  const advice = libraryAdvice || carried?.libraryAdvice || null;
  const nowIso = new Date().toISOString();
  const prDataAsOf = carried ? carried.prDataAsOf : nowIso;

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
    source_timestamp: nowIso,
    coverage,
    // Exact counts are retained here for the private workflow artifact and
    // any other authenticated consumer. has_urgent_alerts is the only field
    // safe to render on a public page — see rollup.schema.json.
    security_alerts: { ...counts, has_urgent_alerts: computeHasUrgentAlerts(counts) },
    // Omitted (not zeroed) when PR counts are unknown. per_page=100 caps the
    // count; a repo with more open PRs reports 100.
    ...(openPullRequests ? { open_pull_requests: openPullRequests } : {}),
    ...(advice ? { library_advice: advice } : {}),
    ...(prDataAsOf ? { pr_data_as_of: prDataAsOf } : {}),
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

/** Pure: the per-run repository cap, lowered when there is no token. */
function effectiveMaxRepos(configured, hasToken) {
  return hasToken ? configured : Math.min(configured, UNAUTHENTICATED_MAX_REPOS);
}

/**
 * Pure: a warning when this copy of the tool runs under an account its
 * policy does not mention, which usually means a fork or copy whose
 * maintenance-policy.json still names the original owner.
 * @returns {string|null}
 */
function ownerMismatchWarning(policy, runningOwner) {
  if (!runningOwner) return null;
  const owners = (policy.discovery.owners || []).map((o) => o.toLowerCase());
  if (owners.includes(runningOwner.toLowerCase())) return null;
  return `This repository belongs to "${runningOwner}", but maintenance-policy.json scans ${owners.join(', ') || 'no owners'}. ` +
    'If this is your copy, set discovery.owners and repositories.include to your own account (see README).';
}


/**
 * Optional GitHub Actions metadata. Environment values cost no API calls. The
 * run/jobs API is queried only when RESOURCE_COLLECT_ACTIONS=1 (a deliberate,
 * occasional measurement), using GITHUB_TOKEN rather than the read-only scan
 * token. Job/workflow elapsed values collected while the job is still running
 * are lower bounds and are labelled as such.
 */
async function collectActionsMetrics({ authToken: actionToken = process.env.GITHUB_TOKEN || token } = {}) {
  if (process.env.GITHUB_ACTIONS !== 'true') return null;
  const metrics = {
    workflow: process.env.GITHUB_WORKFLOW || null,
    job: process.env.GITHUB_JOB || null,
    event: process.env.GITHUB_EVENT_NAME || null,
    runner: process.env.RUNNER_ENVIRONMENT || process.env.RUNNER_OS || null,
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT) || null,
    potentially_superseded: null,
    billable_minutes: null,
    queue_seconds: null,
    run_id: process.env.GITHUB_RUN_ID || null,
    job_id: null,
    conclusion: null,
    started_at: null,
    completed_at: null,
    artifact_retention_days: null,
    cache_bytes: null,
    job_elapsed_ms: null,
    workflow_elapsed_ms: null,
    api_available: false,
    requested: process.env.RESOURCE_COLLECT_ACTIONS === '1',
    note: 'GitHub Actions does not expose CPU time, electricity or billable minutes through this API surface.',
  };
  if (!metrics.requested || !metrics.run_id || !process.env.GITHUB_REPOSITORY) return metrics;

  const repo = process.env.GITHUB_REPOSITORY;
  const run = await githubFetch(`/repos/${repo}/actions/runs/${metrics.run_id}`, {
    allow404: true,
    authToken: actionToken,
    count: false,
  });
  if (run.ok && run.data) {
    metrics.api_available = true;
    metrics.workflow = run.data.name || metrics.workflow;
    metrics.event = run.data.event || metrics.event;
    metrics.attempt = run.data.run_attempt || metrics.attempt;
    metrics.conclusion = run.data.conclusion || null;
    metrics.started_at = run.data.run_started_at || run.data.created_at || null;
    metrics.completed_at = run.data.status === 'completed' ? (run.data.updated_at || null) : null;
    if (metrics.started_at) {
      const startMs = Date.parse(metrics.started_at);
      const endMs = metrics.completed_at ? Date.parse(metrics.completed_at) : Date.now();
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
        metrics.workflow_elapsed_ms = endMs - startMs;
      }
      if (run.data.created_at) {
        const createdMs = Date.parse(run.data.created_at);
        if (Number.isFinite(createdMs) && startMs >= createdMs) metrics.queue_seconds = (startMs - createdMs) / 1000;
      }
    }
    metrics.run_id = String(run.data.id || metrics.run_id);
  }

  const jobs = await githubFetch(`/repos/${repo}/actions/runs/${metrics.run_id}/jobs?filter=latest&per_page=100`, {
    allow404: true,
    authToken: actionToken,
    count: false,
  });
  if (jobs.ok && Array.isArray(jobs.data?.jobs)) {
    const jobList = jobs.data.jobs;
    const matching = jobList.find((job) => job.name === metrics.job) || jobList[0] || null;
    if (matching) {
      metrics.job = matching.name || metrics.job;
      metrics.job_id = matching.id ? String(matching.id) : null;
      metrics.conclusion = matching.conclusion || metrics.conclusion;
      metrics.started_at = metrics.started_at || matching.started_at || null;
      metrics.completed_at = matching.completed_at || metrics.completed_at;
      if (Array.isArray(matching.labels) && matching.labels.length) metrics.runner = matching.labels.join(', ');
    }
    // Sum all job execution times, including matrix children, so this is not
    // confused with the workflow's wall-clock elapsed time.
    let totalJobMs = 0;
    let anyJob = false;
    for (const job of jobList) {
      if (!job.started_at) continue;
      const start = Date.parse(job.started_at);
      const end = job.completed_at ? Date.parse(job.completed_at) : Date.now();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      totalJobMs += end - start;
      anyJob = true;
    }
    if (anyJob) metrics.job_elapsed_ms = totalJobMs;
  }
  if (!metrics.api_available) metrics.note += ' The Actions API was unavailable; only environment metadata is recorded.';
  return metrics;
}

function actionsOutcome(conclusion) {
  if (conclusion === 'success') return 'success';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required') return 'failure';
  if (conclusion === 'cancelled') return 'cancelled';
  if (conclusion === 'skipped') return 'partial';
  return 'unknown';
}

/** Build the local resource evidence for one inventory run. Counts only; no repository names. */
function buildInventoryResourceEvents({
  startedAt,
  endedAt,
  actions = null,
  project = process.env.GITHUB_REPOSITORY || 'local/tune-my-repos',
  commit = process.env.GITHUB_SHA || null,
  runId = process.env.GITHUB_RUN_ID || null,
  attempt = process.env.GITHUB_RUN_ATTEMPT || null,
  dryRun: isDryRun = false,
  candidateCount = 0,
  evaluatedCount = 0,
  carriedForward = 0,
  probeCounts = {},
} = {}) {
  const measurementId = `inventory:${runId ? `${runId}:${attempt || '1'}` : startedAt}`.slice(0, 120);
  const complete = apiMetrics.completeness === true;
  const api = {
    requests: apiMetrics.requests,
    status_200: apiMetrics.status_200,
    status_304: apiMetrics.status_304,
    failed: apiMetrics.failed,
    rate_limited: apiMetrics.rate_limited,
    cache_hits: apiMetrics.cache_hits,
    cache_misses: apiMetrics.cache_misses,
    repositories_discovered: candidateCount,
    repositories_evaluated: evaluatedCount,
    repositories_skipped: Math.max(0, candidateCount - evaluatedCount),
    carried_forward: carriedForward,
    security_checks: apiMetrics.security_checks,
    response_bytes: apiMetrics.response_bytes,
    freshness: endedAt,
    complete,
  };
  const warnings = [];
  if (!complete) warnings.push('incomplete-inventory-scan');
  if (apiMetrics.rate_limited > 0) warnings.push('github-rate-limit-response');
  if (actions && actions.requested && !actions.api_available) warnings.push('github-actions-api-unavailable');
  const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  const common = {
    project,
    commit,
    issue: null,
    variant: null,
    task: {
      id: 'repository-inventory',
      label: 'Portfolio repository inventory',
      execution_id: `run:${startedAt}`,
      kind: 'maintenance',
      state: 'completed_unverified',
      expected_deliverable: 'inventory',
      verified: false,
    },
    environment: {
      os: `${process.platform} ${process.arch}`,
      node: process.version,
      runner: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
      ddev: null,
      docker: null,
      arch: process.arch,
    },
    validation: 'not-run',
    model: null,
    provider: null,
  };
  const events = [makeEvent({
    ...common,
    measurement_id: measurementId,
    event_type: 'github-api',
    occurred_at: startedAt,
    duration_ms: durationMs,
    activity: 'repository-inventory',
    tool: 'github-rest-api',
    outcome: complete ? 'success' : 'partial',
    source: {
      adapter: 'inventory-generator',
      method: 'instrumented githubFetch counters',
      confidence: 'measured',
      reference: null,
    },
    measurements: {
      github_api: api,
      cpu: { measurement: 'unavailable' },
      memory: { measurement: 'unavailable' },
      network: { rx_bytes: null, tx_bytes: null, measurement: 'unavailable' },
      measurement: {
        id: measurementId,
        tool: 'inventory-generator',
        tool_version: null,
        exit_status: 0,
        signal: null,
        timed_out: false,
        wall_ms: durationMs,
        inner_wall_ms: durationMs,
        overhead_ms: null,
        sampling_interval_ms: null,
        lock_wait_ms: null,
        overlap: false,
        concurrent_measurements: 0,
        cache_state: null,
        repeats: 1,
      },
    },
    quality: {
      completeness: 'partial',
      missing: ['energy', 'emissions', 'cpu', 'memory', 'tokens', 'cost', 'network'],
      notes: [
        'GitHub API request counts are not converted into energy.',
        `Issue/PR probe outcomes: ${probeCounts.not_modified || 0} not modified, ${probeCounts.modified || 0} modified/first read, ${probeCounts.unknown || 0} unreadable.`,
        complete ? 'Every candidate repository in this run was evaluated.' : 'This scan is incomplete; do not treat it as a completed portfolio inventory.',
      ],
      warnings,
    },
    private: {
      dry_run: Boolean(isDryRun),
      token_present: Boolean(token),
      candidates: candidateCount,
      evaluated: evaluatedCount,
      probe_counts: probeCounts,
    },
  })];

  if (actions) {
    events.push(makeEvent({
      ...common,
      measurement_id: `${measurementId}:actions`.slice(0, 120),
      event_type: 'github-actions',
      occurred_at: actions.started_at || startedAt,
      duration_ms: actions.workflow_elapsed_ms,
      activity: 'github-actions',
      tool: 'github-actions',
      outcome: actionsOutcome(actions.conclusion),
      source: {
        adapter: 'github-actions-metadata',
        method: actions.api_available ? 'run and job metadata plus environment' : 'environment metadata only',
        confidence: actions.api_available ? 'provider-reported' : 'unavailable',
        reference: null,
      },
      measurements: {
        github: {
          workflow: actions.workflow,
          job: actions.job,
          event: actions.event,
          runner: actions.runner,
          attempt: actions.attempt,
          potentially_superseded: actions.potentially_superseded,
          billable_minutes: actions.billable_minutes,
          queue_seconds: actions.queue_seconds,
          run_id: actions.run_id,
          job_id: actions.job_id,
          conclusion: actions.conclusion,
          started_at: actions.started_at,
          completed_at: actions.completed_at,
          artifact_retention_days: actions.artifact_retention_days,
          cache_bytes: actions.cache_bytes,
          job_elapsed_ms: actions.job_elapsed_ms,
        },
        cpu: { measurement: 'unavailable' },
        memory: { measurement: 'unavailable' },
        network: { rx_bytes: null, tx_bytes: null, measurement: 'unavailable' },
        measurement: {
          id: `${measurementId}:actions`.slice(0, 120),
          tool: 'github-actions',
          tool_version: null,
          exit_status: null,
          signal: null,
          timed_out: false,
          wall_ms: actions.workflow_elapsed_ms,
          inner_wall_ms: actions.job_elapsed_ms,
          overhead_ms: null,
          sampling_interval_ms: null,
          lock_wait_ms: null,
          overlap: false,
          concurrent_measurements: 0,
          cache_state: null,
          repeats: 1,
        },
      },
      quality: {
        completeness: 'partial',
        missing: ['energy', 'emissions', 'cpu', 'memory', 'tokens', 'cost', 'network', 'billable_minutes', 'cache_bytes'],
        notes: [
          'Workflow elapsed time is not CPU time or electricity consumption.',
          'Job elapsed time is summed job execution time; it is not electricity.',
          actions.note,
          actions.requested ? (actions.api_available ? 'Actions API metadata collected for this run.' : 'Actions API collection was requested but unavailable; only environment metadata is recorded.') : 'Actions API collection was not requested; only environment metadata is recorded.',
          actions.api_available && !actions.completed_at ? 'Workflow/job duration is a lower bound collected while the job was still running.' : '',
        ].filter(Boolean),
        warnings: actions.requested && !actions.api_available ? ['github-actions-api-unavailable'] : [],
      },
      private: { api_available: actions.api_available },
    }));
  }
  return events;
}

async function main() {
  resetApiMetrics();
  const runStartedAt = new Date().toISOString();
  const runStartedMs = Date.now();
  const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'maintenance-policy.json'), 'utf8'));
  const mismatch = ownerMismatchWarning(policy, process.env.GITHUB_REPOSITORY_OWNER);
  // ::warning:: surfaces on the Actions run summary, not just in the log
  if (mismatch) console.log(`::warning::${mismatch}`);
  const rollupSchema = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'policy', 'rollup.schema.json'), 'utf8')
  );
  const scanStatePath = path.join(__dirname, '..', 'maintenance-scan-state.json');
  let scanState = { schema_version: '1.0.0', repositories: {} };
  if (fs.existsSync(scanStatePath)) {
    scanState = JSON.parse(fs.readFileSync(scanStatePath, 'utf8'));
  }

  // The last published rollup supplies PR data for repositories whose PR
  // work is skipped this run (see carryForwardPrData).
  const previousEntries = new Map();
  const previousPublicPath = path.join(__dirname, '..', 'maintenance-rollup.public.json');
  if (fs.existsSync(previousPublicPath)) {
    try {
      for (const e of JSON.parse(fs.readFileSync(previousPublicPath, 'utf8')).repositories || []) {
        previousEntries.set(e.full_name, e);
      }
    } catch {
      // unreadable previous rollup: skipped repositories simply get fresh-empty PR data
    }
  }

  const pushedAtByRepo = await resolveCandidateRepos(policy);
  const candidateCount = pushedAtByRepo.size;
  apiMetrics.repositories_discovered = candidateCount;
  // Drop state for repositories that are no longer public candidates. Skipped
  // when discovery returned nothing (likely an API failure), so one bad run
  // does not wipe the rotation history.
  if (pushedAtByRepo.size > 0) {
    scanState = pruneToRepositories(scanState, pushedAtByRepo.keys());
  }
  const orderedRepos = orderByActivityThenStaleness(scanState, [...pushedAtByRepo.keys()], pushedAtByRepo);
  const maxRepos = effectiveMaxRepos(policy.discovery.max_repos_per_run, Boolean(token));
  if (maxRepos < policy.discovery.max_repos_per_run) {
    console.log(`No token: scanning at most ${maxRepos} repositories this run (set MAINTENANCE_RO_TOKEN for more).`);
  }
  const reposThisRun = orderedRepos.slice(0, maxRepos);

  const repositories = [];
  const probeCounts = { not_modified: 0, modified: 0, unknown: 0 };
  for (const repoFullName of reposThisRun) {
    // Repo metadata is fetched once here (rather than inside
    // buildRepositoryEntry) because its pushed_at is needed up front to
    // decide skipPrWork, including for an exact (non-glob)
    // repositories.include entry, which discovery never saw.
    const repoMeta = await fetchSecurityAndAnalysis(repoFullName);
    // Second guard for exact repositories.include entries, which discovery
    // never filtered: only a repository confirmed public is scanned.
    if (repoMeta?.private !== false) {
      console.log(`Skipping ${repoFullName}: private, or visibility could not be confirmed`);
      scanState = pruneToRepositories(scanState, Object.keys(scanState.repositories).filter((n) => n !== repoFullName));
      continue;
    }
    const knownPushedAt = pushedAtByRepo.get(repoFullName) ?? repoMeta?.pushed_at ?? null;
    // Only skip when there is real PR data to carry forward: an entry
    // without pr_data_as_of was published before carry-forward existed (or
    // never had PRs read), so skipping would publish an empty PR list.
    const unchangedByPush = knownPushedAt !== null
      && hasCarryablePrData(previousEntries.get(repoFullName))
      && canSkipPrWork(scanState, repoFullName, knownPushedAt, policy.discovery.rescan_prs_after_days);

    // pushed_at does not move for what does not push here: a pull request
    // from a fork, or any issue. So a repository that looks unchanged is
    // confirmed with one conditional request for its open issue/PR list: 304
    // (free, not counted against the rate limit) keeps the skip; anything
    // else does the work. A repository not already skippable is read without
    // an ETag, to record one for next time.
    const storedEtag = unchangedByPush ? getIssuesEtag(scanState, repoFullName) : null;
    const probe = await probeOpenIssues(repoFullName, storedEtag);
    const skipPrWork = canSkipAfterProbe(unchangedByPush && Boolean(storedEtag), probe.outcome);
    probeCounts[probe.outcome] += 1;
    if (skipPrWork) apiMetrics.carried_forward += 1;

    const entry = await buildRepositoryEntry(policy, repoFullName, {
      skipPrWork,
      repoMeta,
      previousEntry: previousEntries.get(repoFullName),
    });
    const pushedAtForState = knownPushedAt ?? entry._pushed_at;
    delete entry._pushed_at;
    repositories.push(entry);
    apiMetrics.repositories_evaluated += 1;
    if (pushedAtForState) {
      scanState = recordScan(scanState, repoFullName, pushedAtForState);
      scanState = recordIssuesEtag(scanState, repoFullName, probe.etag);
    }
  }

  // Counts only, so the line is safe in a public log. A high not_modified
  // share is the saving; many "unknown" means the issues list is unreadable.
  console.log(`Issue/PR list probes: ${probeCounts.not_modified} not modified, ${probeCounts.modified} modified or first read, ${probeCounts.unknown} unreadable`);

  apiMetrics.repositories_skipped = Math.max(0, candidateCount - repositories.length);
  apiMetrics.completeness = candidateCount > 0
    && reposThisRun.length === candidateCount
    && repositories.length === reposThisRun.length
    && apiMetrics.rate_limited === 0;
  apiMetrics.freshness = new Date().toISOString();

  if (!dryRun) {
    fs.writeFileSync(scanStatePath, JSON.stringify(scanState, null, 2) + '\n');
  }

  const rollup = {
    schema_version: '1.0.0',
    run_timestamp: new Date().toISOString(),
    policy_version: policy.policy_version,
    // Read here, not at load time: the Dependabot Pilot imports this module
    // from a sparse checkout that has no AGENTS.md.
    agents_md_blob_sha: gitBlobSha(fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'))),
    repositories,
  };

  const errors = validatePolicySchema(rollup, rollupSchema);
  if (errors.length > 0) {
    console.error('Generated rollup failed schema validation:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  // Resource evidence is separate from the maintenance rollup. It contains
  // counts and timings only; no repository names or alert details.
  const actions = resourceOutPath ? await collectActionsMetrics() : null;
  const runEndedAt = new Date().toISOString();
  if (resourceOutPath) {
    const resourceEvents = buildInventoryResourceEvents({
      startedAt: runStartedAt,
      endedAt: runEndedAt,
      actions,
      candidateCount,
      evaluatedCount: repositories.length,
      carriedForward: apiMetrics.carried_forward,
      probeCounts,
      dryRun,
    });
    fs.mkdirSync(path.dirname(resourceOutPath), { recursive: true });
    fs.writeFileSync(resourceOutPath, `${resourceEvents.map((event) => JSON.stringify(event)).join('\n')}\n`);
    console.log(`Wrote ${resourceEvents.length} resource event(s) to ${resourceOutPath}`);
  }
  const requestsPerRepo = repositories.length > 0 ? apiMetrics.requests / repositories.length : null;
  console.log(`GitHub API counters: ${apiMetrics.requests} requests, ${apiMetrics.status_304} not modified, ${apiMetrics.failed} failed, ${apiMetrics.rate_limited} rate-limited; ${repositories.length}/${candidateCount} repositories evaluated${requestsPerRepo === null ? '' : `, ${requestsPerRepo.toFixed(2)} requests/evaluated repository`}; scan ${apiMetrics.completeness ? 'complete' : 'incomplete'}; ${Date.now() - runStartedMs} ms wall clock`);

  const outPath = path.join(__dirname, '..', 'maintenance-rollup.json');
  // The full rollup (exact alert counts) is for the private 90-day
  // workflow artifact only. The public file is the one actually published
  // to GitHub Pages — see policy/public-redaction.cjs and README.md
  // "Security alert visibility on the public dashboard" for why this
  // reduction exists and must never be skipped for a published file.
  const publicOutPath = path.join(__dirname, '..', 'maintenance-rollup.public.json');
  const publicRollup = redactExactAlertCounts(rollup);

  if (dryRun) {
    // Workflow logs are public on a public repository, so a dry run prints
    // only the redacted public rollup — never the exact alert counts, which
    // exist only in the private artifact of a real run.
    console.log(`[dry-run] would write ${outPath} (exact alert counts; not printed, logs are public)`);
    console.log(`[dry-run] would write ${publicOutPath}:`);
    console.log(JSON.stringify(publicRollup, null, 2));
  } else {
    fs.writeFileSync(outPath, JSON.stringify(rollup, null, 2) + '\n');
    fs.writeFileSync(publicOutPath, JSON.stringify(publicRollup, null, 2) + '\n');
    console.log(`Wrote ${outPath} and ${publicOutPath} (${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'})`);
  }
}

module.exports = {
  githubFetch,
  resetApiMetrics,
  getApiMetrics: () => apiMetrics,
  collectActionsMetrics,
  buildInventoryResourceEvents,
  actionsOutcome,
  openIssuesEndpoint,
  probeOpenIssues,
  redact,
  cap,
  parseDependabotTitle,
  parseDependabotBodyUpdates,
  combineUpdateTypes,
  combineDependencyClasses,
  describeDependencies,
  classifyFromPackageLock,
  npmManifestDir,
  summarizeCiStatus,
  PILOT_CHECK_NAMES,
  combineBranchProtection,
  carryForwardPrData,
  hasCarryablePrData,
  effectiveMaxRepos,
  ownerMismatchWarning,
  securitySettingStatus,
  findFailedCheckRun,
  semverParts,
  inferUpdateType,
  inferDependencyClass,
  inferDependencyClassFromLabels,
  classifyFromPackageJson,
  detectEcosystemFromFiles,
  resolveEcosystem,
  computeRecommendedAction,
  computeHasUrgentAlerts,
  filterDiscoveredRepos,
  gitBlobSha,
};

if (require.main === module) {
  main().catch((error) => {
    console.error('Failed to generate maintenance rollup:', error.message);
    process.exit(1);
  });
}
