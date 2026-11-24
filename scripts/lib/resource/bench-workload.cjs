#!/usr/bin/env node
/**
 * Local-only benchmark workloads. These never call GitHub and never invoke an
 * AI provider. They exercise the same deterministic functions the maintenance
 * and resource pipelines use.
 */

const fs = require('node:fs');
const path = require('node:path');

const { REPO_ROOT } = require('./paths.cjs');
const { classifyUpdate } = require('../../../policy/policy-engine.cjs');
const { validatePolicySchema } = require('../../../policy/policy-validator.cjs');
const { redactExactAlertCounts } = require('../../../policy/public-redaction.cjs');
const { buildResourceRollup } = require('./rollup.cjs');
const { renderResourceDashboard } = require('../../../policy/resource-view.cjs');

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8'));
}

function iterations(defaultValue) {
  const value = Number(process.env.BENCH_ITERATIONS || defaultValue);
  return Number.isInteger(value) && value > 0 ? value : defaultValue;
}

function policyEvaluation() {
  const policy = readJson('maintenance-policy.json');
  const rollup = readJson('fixtures/maintenance-rollup.sample.json');
  const updates = [];
  for (const repository of rollup.repositories) {
    for (const pr of repository.dependabot_prs || []) {
      updates.push({
        repository: repository.full_name,
        dependency_class: pr.dependency_class,
        update_type: pr.update_type,
        required_ci_passed: pr.ci_status === 'passing',
        touches_workflow_permissions: false,
        is_lockfile_only: false,
        is_generated_output_only: false,
        requires_new_secret_or_elevated_access: false,
        required_check_failed: pr.ci_status === 'failing',
      });
    }
  }
  let classified = 0;
  for (let i = 0; i < iterations(500); i += 1) {
    for (const update of updates) {
      const result = classifyUpdate(policy, update);
      if (!result || !result.risk_state) throw new Error('classification returned no risk state');
      classified += 1;
    }
  }
  console.log(`policy-evaluation: ${classified} classifications over ${updates.length} fixture update(s)`);
}

function inventoryProcessing() {
  const rollup = readJson('fixtures/maintenance-rollup.sample.json');
  const schema = readJson('policy/rollup.schema.json');
  let processed = 0;
  for (let i = 0; i < iterations(200); i += 1) {
    const publicRollup = redactExactAlertCounts(rollup);
    const problems = validatePolicySchema(publicRollup, schema);
    if (problems.length) throw new Error(`redacted fixture invalid: ${problems[0]}`);
    for (const repository of publicRollup.repositories) {
      if ('critical' in repository.security_alerts) throw new Error('exact alert count leaked into public fixture');
      processed += 1;
    }
  }
  console.log(`inventory-processing: ${processed} repository-record redactions/validations`);
}

function resourceAggregation() {
  const events = fs.readFileSync(path.join(REPO_ROOT, 'fixtures/resource/resource-events.synthetic.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const tasks = fs.readFileSync(path.join(REPO_ROOT, 'fixtures/resource/resource-tasks.synthetic.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  let runs = 0;
  for (let i = 0; i < iterations(100); i += 1) {
    const rollup = buildResourceRollup({ events, tasks, generatedAt: '2026-11-24T00:00:00.000Z' });
    if (rollup.event_count !== events.length) throw new Error('aggregation lost events');
    runs += 1;
  }
  console.log(`resource-aggregation: ${runs} rollups over ${events.length} events`);
}

function dashboardRender() {
  const rollup = readJson('fixtures/resource/resource-rollup.sample.json');
  let runs = 0;
  let bytes = 0;
  for (let i = 0; i < iterations(200); i += 1) {
    const html = renderResourceDashboard(rollup);
    if (!html.includes('<table') || html.includes('<script')) throw new Error('dashboard renderer produced unexpected markup');
    bytes += html.length;
    runs += 1;
  }
  console.log(`dashboard-render: ${runs} renders, ${Math.round(bytes / runs)} average bytes`);
}

const WORKLOADS = {
  'policy-evaluation': policyEvaluation,
  'inventory-processing': inventoryProcessing,
  'resource-aggregation': resourceAggregation,
  'dashboard-render': dashboardRender,
};

const name = process.argv[2];
if (!WORKLOADS[name]) {
  console.error(`unknown local benchmark workload "${name || ''}". Choose: ${Object.keys(WORKLOADS).join(', ')}`);
  process.exitCode = 2;
} else {
  WORKLOADS[name]();
}
