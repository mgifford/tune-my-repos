'use strict';

/**
 * Delta digest: the difference between two rollups, as a few lines of text.
 *
 * Purpose: a reader (a person, or a model asked to check the work) should
 * read only what changed since the previous run, not the whole rollup. A
 * quiet day costs one line.
 *
 * Inputs are the PUBLIC rollup shape, so only fields that survive redaction
 * are used: no exact alert counts, no failure summaries, no reason text.
 * The output holds repository names, counts, PR numbers and action names.
 * It is still meant for the private data repository only: "which repository
 * has an urgent alert" is information about unfixed vulnerabilities.
 *
 * Pure functions, no I/O.
 */

function byName(rollup) {
  const map = new Map();
  for (const entry of rollup?.repositories || []) map.set(entry.full_name, entry);
  return map;
}

function humanPrs(entry) {
  const open = entry.open_pull_requests;
  if (!open) return 0;
  return Math.max(0, (open.total || 0) - (open.dependabot || 0));
}

function failedNumbers(entry) {
  return new Set((entry.failed_update_prs || []).map((pr) => pr.number));
}

/**
 * @param {object|null} previous - previous rollup, or null for a first run
 * @param {object} current
 * @returns {{baseline: boolean, previous_run: string|null, current_run: string|null,
 *   totals: {repositories: number}, changes: object[]}}
 */
function computeDelta(previous, current) {
  const currentMap = byName(current);
  const totals = { repositories: currentMap.size };
  const base = {
    previous_run: previous?.run_timestamp || null,
    current_run: current?.run_timestamp || null,
    totals,
  };

  // Without a previous rollup every repository would look "new". Say so once.
  if (!previous) return { baseline: true, ...base, changes: [] };

  const previousMap = byName(previous);
  const changes = [];

  for (const [name, now] of currentMap) {
    const before = previousMap.get(name);
    if (!before) {
      changes.push({ kind: 'repository_added', repo: name });
      continue;
    }

    const wasUrgent = Boolean(before.security_alerts?.has_urgent_alerts);
    const isUrgent = Boolean(now.security_alerts?.has_urgent_alerts);
    if (!wasUrgent && isUrgent) changes.push({ kind: 'urgent_alert_appeared', repo: name });
    if (wasUrgent && !isUrgent) changes.push({ kind: 'urgent_alert_cleared', repo: name });

    const humanBefore = humanPrs(before);
    const humanNow = humanPrs(now);
    if (humanNow > humanBefore) {
      changes.push({ kind: 'human_prs_increased', repo: name, from: humanBefore, to: humanNow });
    }

    const failedBefore = failedNumbers(before);
    const newlyFailed = [...failedNumbers(now)].filter((n) => !failedBefore.has(n)).sort((a, b) => a - b);
    if (newlyFailed.length > 0) {
      changes.push({ kind: 'failed_update_pr_appeared', repo: name, numbers: newlyFailed });
    }

    const actionBefore = before.recommended_action?.action;
    const actionNow = now.recommended_action?.action;
    if (actionBefore !== actionNow) {
      changes.push({ kind: 'action_changed', repo: name, from: actionBefore || null, to: actionNow || null });
    }
  }

  for (const name of previousMap.keys()) {
    if (!currentMap.has(name)) changes.push({ kind: 'repository_removed', repo: name });
  }

  return { baseline: false, ...base, changes };
}

const HEADINGS = [
  ['urgent_alert_appeared', 'New urgent security alerts'],
  ['failed_update_pr_appeared', 'Update PRs that started failing'],
  ['human_prs_increased', 'New pull requests from people'],
  ['action_changed', 'Recommended action changed'],
  ['urgent_alert_cleared', 'Urgent alerts cleared'],
  ['repository_added', 'Repositories added to the scan'],
  ['repository_removed', 'Repositories no longer scanned'],
];

function describe(change) {
  switch (change.kind) {
    case 'human_prs_increased':
      return `${change.repo}: ${change.from} -> ${change.to} open`;
    case 'failed_update_pr_appeared':
      return `${change.repo}: ${change.numbers.map((n) => `#${n}`).join(', ')}`;
    case 'action_changed':
      return `${change.repo}: ${change.from || 'none'} -> ${change.to || 'none'}`;
    default:
      return change.repo;
  }
}

/**
 * Markdown digest of a delta. Quiet runs are one line.
 */
function renderDigest(delta, current) {
  const lines = [`# Maintenance digest`, ''];
  const run = delta.current_run || current?.run_timestamp || 'unknown';
  lines.push(`Run: ${run}. Repositories scanned: ${delta.totals.repositories}.`, '');

  if (delta.baseline) {
    lines.push('First run with no previous rollup to compare against. This run is the baseline.', '');
    return lines.join('\n');
  }
  if (delta.changes.length === 0) {
    lines.push('No changes since the previous run.', '');
    return lines.join('\n');
  }

  for (const [kind, heading] of HEADINGS) {
    const group = delta.changes.filter((c) => c.kind === kind);
    if (group.length === 0) continue;
    lines.push(`## ${heading}`, '');
    for (const change of group) lines.push(`- ${describe(change)}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Fixed-shape totals block. Lets a model or a person check the whole fleet
 * from about ten lines instead of reading the rollup.
 */
function renderSummary(rollup) {
  const repositories = rollup?.repositories || [];
  const actions = {};
  let urgent = 0;
  let humanOpen = 0;
  let failed = 0;
  for (const entry of repositories) {
    if (entry.security_alerts?.has_urgent_alerts) urgent += 1;
    humanOpen += humanPrs(entry);
    failed += (entry.failed_update_prs || []).length;
    const action = entry.recommended_action?.action || 'none';
    actions[action] = (actions[action] || 0) + 1;
  }
  const lines = [
    `run: ${rollup?.run_timestamp || 'unknown'}`,
    `repositories: ${repositories.length}`,
    `urgent_alerts: ${urgent}`,
    `open_prs_from_people: ${humanOpen}`,
    `failed_update_prs: ${failed}`,
    'recommended_actions:',
  ];
  for (const action of Object.keys(actions).sort()) lines.push(`  ${action}: ${actions[action]}`);
  return lines.join('\n') + '\n';
}

module.exports = { computeDelta, renderDigest, renderSummary };
