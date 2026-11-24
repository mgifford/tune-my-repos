#!/usr/bin/env node
/**
 * Generate the sanitized resource rollup, Markdown summary and CSV from the
 * local event ledger (or a committed synthetic fixture).
 *
 *   node scripts/generate-resource-rollup.cjs
 *   node scripts/generate-resource-rollup.cjs --sample
 *   node scripts/generate-resource-rollup.cjs \
 *     --input fixtures/resource/resource-events.synthetic.jsonl \
 *     --tasks fixtures/resource/resource-tasks.synthetic.jsonl \
 *     --out reports/resources/sample
 *
 * The public JSON is written only after the fail-closed privacy scanner passes.
 */

const fs = require('node:fs');
const path = require('node:path');

const { REPO_ROOT, reportsRoot, cacheRoot, rawRoot, ledgerRoot, ensureDir } = require('./lib/resource/paths.cjs');
const { loadEvents, loadTasks, ledgerFile, tasksFile, directoryBytes } = require('./lib/resource/ledger.cjs');
const { buildResourceRollup, renderResourceMarkdown, writeResourceReports } = require('./lib/resource/rollup.cjs');

function usage() {
  return `Usage: node scripts/generate-resource-rollup.cjs [options]

Options:
  --input=<file>       Event JSONL (default: local ledger).
  --tasks=<file>       Task JSONL (default: local task ledger).
  --out=<dir>          Output directory (default: reports/resources).
  --sample             Use committed synthetic fixtures and reports/resources/sample.
  --quiet              Do not print the Markdown report.
  --json               Print the public rollup JSON instead of Markdown.
  --help               Show this help.`;
}

function parseArgs(argv) {
  const value = (name) => {
    const prefix = `--${name}=`;
    const found = argv.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  };
  const has = (name) => argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  return { value, has };
}

function main(argv) {
  const { value, has } = parseArgs(argv);
  if (has('help')) { console.log(usage()); return 0; }
  const sample = has('sample');
  const inputFile = value('input') || (sample
    ? path.join(REPO_ROOT, 'fixtures', 'resource', 'resource-events.synthetic.jsonl')
    : ledgerFile());
  const taskFile = value('tasks') || (sample
    ? path.join(REPO_ROOT, 'fixtures', 'resource', 'resource-tasks.synthetic.jsonl')
    : tasksFile());
  const outDir = value('out') || (sample ? path.join(reportsRoot(), 'sample') : reportsRoot());

  if (!fs.existsSync(inputFile)) {
    console.error(`[resource-report] no event ledger at ${inputFile}; run a measurement first`);
    return 2;
  }
  const events = loadEvents({ file: inputFile, includeMonitoring: true });
  if (events.invalid.length) {
    for (const row of events.invalid.slice(0, 10)) console.error(`[resource-report] skipped invalid event line ${row.line}: ${row.problem}`);
  }
  let tasks = [];
  if (fs.existsSync(taskFile)) {
    const loaded = loadTasks({ file: taskFile });
    tasks = loaded.tasks;
    for (const row of loaded.invalid.slice(0, 10)) console.error(`[resource-report] skipped invalid task line ${row.line}: ${row.problem}`);
  }
  const rollup = buildResourceRollup({
    events: events.events,
    tasks,
    generatedAt: new Date().toISOString(),
    ledgerBytes: directoryBytes(ledgerRoot()),
    rawBytes: directoryBytes(rawRoot()),
  });
  ensureDir(outDir);
  const written = writeResourceReports(rollup, { outDir });
  for (const file of written) console.error(`[resource-report] wrote ${path.relative(process.cwd(), file)}`);
  if (has('json')) console.log(JSON.stringify(rollup, null, 2));
  else if (!has('quiet')) console.log(renderResourceMarkdown(rollup));
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { parseArgs, main };
