#!/usr/bin/env node
/**
 * Write a compact GitHub Actions step summary for a monthly resource cycle.
 * Aggregate-only; never includes repository names, task labels or paths.
 */

const fs = require('node:fs');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  const message = '## Monthly resource cycle\n\nNo resource report was generated.\n';
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
  else process.stdout.write(message);
  process.exitCode = 1;
} else {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const api = report.maintenance?.api || {};
  const ci = report.maintenance?.ci || {};
  const local = report.local_computing || {};
  const energy = local.energy || {};
  const lines = [
    '## Monthly resource cycle',
    '',
    `- Local energy: ${energy.estimated_wh ?? energy.measured_wh ?? 'unavailable'} Wh (${energy.coverage ?? 'unavailable'})`,
    `- Local CPU time: ${local.cpu_seconds ?? 'unavailable'} CPU-seconds`,
    `- API requests: ${api.requests ?? 'unavailable'}`,
    `- Repositories evaluated: ${api.repositories_evaluated ?? 'unavailable'}`,
    `- Requests per evaluated repository: ${api.requests_per_evaluated_repository ?? 'unavailable'}`,
    `- Inventory scan complete: ${api.complete === null || api.complete === undefined ? 'unavailable' : (api.complete ? 'yes' : 'no')}`,
    `- Workflow elapsed: ${ci.workflow_elapsed_ms ?? 'unavailable'} ms`,
    `- Summed job execution: ${ci.job_elapsed_ms ?? 'unavailable'} ms`,
    '',
    'Aggregate-only; raw measurements and ledgers are not published.',
    '',
  ];
  const text = `${lines.join('\n')}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  else process.stdout.write(text);
}
