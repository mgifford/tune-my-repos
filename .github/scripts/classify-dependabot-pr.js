#!/usr/bin/env node
/**
 * Classifies a single Dependabot PR (from environment variables set by the
 * dependabot-pilot workflow) and writes dependency_class, update_type, and
 * risk_state to $GITHUB_OUTPUT. Reuses the exact same parsing and policy
 * logic as scripts/generate-maintenance-rollup.js and policy/policy-engine.js
 * so labeling and the rollup can never disagree.
 *
 * Reads only PR metadata (title, labels) passed in via env vars — never
 * executes or inspects the PR branch's own code.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  parseDependabotTitle,
  inferUpdateType,
  inferDependencyClass,
} = require('../../scripts/generate-maintenance-rollup.js');
const { classifyUpdate } = require('../../policy/policy-engine.js');

/**
 * Pure classification step, factored out for unit testing.
 * @param {object} policy - parsed maintenance-policy.json
 * @param {{title: string, labelNames: string[], repository: string}} pr
 * @returns {{dependency_class: string, update_type: string, risk_state: string}}
 */
function classifyPrMetadata(policy, pr) {
  const labels = pr.labelNames.map((name) => ({ name }));

  const ecosystem = labels.some((l) => l.name === 'github_actions' || l.name === 'github-actions')
    ? 'github_actions'
    : 'unknown';

  const parsed = parseDependabotTitle(pr.title);
  const dependencyName = parsed?.dependencyName || 'unknown';
  const versionFrom = parsed?.versionFrom || 'unknown';
  const versionTo = parsed?.versionTo || 'unknown';
  const updateType = parsed ? inferUpdateType(versionFrom, versionTo) : 'unknown';
  const dependencyClass = inferDependencyClass({ labels }, ecosystem);

  // IMPORTANT: risk_state here answers "is this class of update ever
  // eligible for auto-merge" (a policy question, computed as if CI had
  // already passed), NOT "has CI passed yet" (a fact question). The
  // auto-merge job in dependabot-pilot.yml treats this as necessary but not
  // sufficient: it still calls `gh pr merge --auto`, which defers the
  // actual merge until GitHub's own branch ruleset reports the required
  // "npm test" check green on this PR's head commit. This script never
  // has, and must never be given, the authority to merge directly.
  const classificationIfCiPasses = classifyUpdate(policy, {
    repository: pr.repository,
    dependency_class: dependencyClass,
    update_type: updateType,
    dependency_name: dependencyName,
    ecosystem,
    required_ci_passed: true,
    touches_workflow_permissions: false,
    is_lockfile_only: false,
    is_generated_output_only: false,
    requires_new_secret_or_elevated_access: false,
    required_check_failed: false,
  });

  return {
    dependency_class: dependencyClass,
    update_type: updateType,
    risk_state: classificationIfCiPasses.risk_state,
  };
}

function main() {
  const policy = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'maintenance-policy.json'), 'utf8')
  );

  const result = classifyPrMetadata(policy, {
    title: process.env.PR_TITLE || '',
    labelNames: JSON.parse(process.env.PR_LABELS || '[]'),
    repository: process.env.REPO_FULL_NAME || '',
  });

  const lines = [
    `dependency_class=${result.dependency_class}`,
    `update_type=${result.update_type}`,
    `risk_state=${result.risk_state}`,
  ];

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    fs.appendFileSync(outputPath, lines.join('\n') + '\n');
  }
  console.log(lines.join('\n'));
}

module.exports = { classifyPrMetadata };

if (require.main === module) {
  main();
}
