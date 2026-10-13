/**
 * Plain-language explanations for maintenance coverage gaps: what an
 * "unknown" or "not_available" status means for each signal, and the exact
 * token permission or repository setting that would fill it in. Shared by
 * maintenance.js (browser) and the Node tests. Pure data and functions.
 *
 * "unknown" means the scan could not read the signal (usually a missing
 * token permission). "not_available" means the scan could read it and the
 * feature is off. Neither is evidence a repository is insecure.
 */

const COVERAGE_HELP = {
  dependency_graph: {
    label: 'Repository metadata',
    unknown: 'The repository could not be read at all this run (rate limit or network error). It is retried next run.',
  },
  dependabot_alerts: {
    label: 'Dependabot alerts',
    unknown: 'The scan token cannot read alerts. Give MAINTENANCE_RO_TOKEN "Dependabot alerts: Read-only" on this repository.',
    not_available: 'Dependabot alerts are turned off. Enable them in the repository\'s Settings → Code security, or run scripts/enable-security-defaults.cjs.',
  },
  dependabot_security_updates: {
    label: 'Dependabot security updates',
    unknown: 'GitHub only shows this setting to a token with "Administration: Read-only" on the repository.',
    not_available: 'Security update PRs are turned off. Enable them in Settings → Code security, or run scripts/enable-security-defaults.cjs.',
  },
  secret_scanning: {
    label: 'Secret scanning',
    unknown: 'GitHub only shows this setting to a token with "Administration: Read-only" on the repository.',
    not_available: 'Secret scanning is turned off. Enable it (free on public repositories) in Settings → Code security, or run scripts/enable-security-defaults.cjs.',
  },
  codeql_default_setup: {
    label: 'CodeQL code scanning',
    unknown: 'Not checked by the scan yet. This is a gap in the tool, not in your repositories.',
  },
  branch_protection: {
    label: 'Branch protection',
    unknown: 'Classic branch protection needs "Administration: Read-only" to read, and no ruleset was found on the default branch.',
    not_available: 'The default branch has no ruleset or branch protection. Add a ruleset in Settings → Rules → Rulesets.',
  },
};

/**
 * One row per (signal, status) pair with how many repositories it affects,
 * most widespread first, so a single fix that covers many repositories
 * shows at the top.
 * @param {object[]} repositories - rollup repository entries
 * @returns {{field: string, status: string, label: string, help: string, repos: string[]}[]}
 */
function summarizeCoverageGaps(repositories) {
  const groups = new Map();
  for (const repo of repositories) {
    for (const [field, status] of Object.entries(repo.coverage || {})) {
      if (status !== 'unknown' && status !== 'not_available') continue;
      const key = `${field}:${status}`;
      if (!groups.has(key)) {
        const help = COVERAGE_HELP[field] || {};
        groups.set(key, {
          field,
          status,
          label: help.label || field.replace(/_/g, ' '),
          help: help[status] || 'No further detail available.',
          repos: [],
        });
      }
      groups.get(key).repos.push(repo.full_name);
    }
  }
  return [...groups.values()].sort((a, b) => b.repos.length - a.repos.length || a.label.localeCompare(b.label));
}

const CoverageHelp = { COVERAGE_HELP, summarizeCoverageGaps };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CoverageHelp;
} else {
  window.CoverageHelp = CoverageHelp;
}
