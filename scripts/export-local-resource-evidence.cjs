#!/usr/bin/env node
/**
 * Export sanitized local CodeCarbon evidence for the monthly private cycle.
 *
 * The raw ledger stays local. This writes a small JSONL file containing only
 * selected process events with their energy/CPU/memory measurements, a generic
 * project/task identity, no private object, no command, no paths and no task
 * labels. The monthly workflow imports this file into a temporary ledger before
 * aggregation.
 *
 * Usage:
 *   node scripts/export-local-resource-evidence.cjs \
 *     --out=local-resource-evidence.jsonl --latest=1
 */

const fs = require('node:fs');
const path = require('node:path');

const { loadEvents, ledgerFile } = require('./lib/resource/ledger.cjs');
const { eventId, assertEvent, validateEvent } = require('./lib/resource/event.cjs');

function usage() {
  return `Usage: node scripts/export-local-resource-evidence.cjs --out=<file> [options]

Options:
  --input=<file>       Event ledger (default: local ledger).
  --out=<file>         Output JSONL (required).
  --latest=<n>         Export the latest n matching events (default: 1).
  --since=<ISO date>   Only export events at or after this timestamp.
  --activity=<id>      Only export this activity (default: any process activity).
  --task-id=<id>       Generic task id written to the export (default: local-resource-baseline).
  --help               Show this help.

Only process events with CodeCarbon energy evidence are exported. The output
contains no command, path, private object, task label or session data.`;
}

function parseArgs(argv) {
  const value = (name) => {
    const prefix = `--${name}=`;
    const found = argv.find((arg) => arg.startsWith(prefix));
    if (found) return found.slice(prefix.length);
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : null;
  };
  const has = (name) => argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  return { value, has };
}

function sanitize(event, { taskId = 'local-resource-baseline' } = {}) {
  const copy = JSON.parse(JSON.stringify(event));
  copy.project = 'local/tune-my-repos';
  copy.issue = null;
  copy.variant = null;
  copy.task = {
    id: taskId,
    label: null,
    execution_id: null,
    kind: 'tooling',
    state: 'completed_unverified',
    expected_deliverable: 'benchmark-report',
    verified: false,
  };
  copy.source = {
    adapter: 'local-evidence-export',
    method: 'CodeCarbon offline process energy model plus child accounting',
    confidence: copy.source?.confidence || 'estimated',
    reference: null,
  };
  copy.quality = {
    completeness: copy.quality?.completeness || 'partial',
    missing: [...new Set(copy.quality?.missing || [])].sort(),
    notes: ['Sanitized local CodeCarbon evidence; raw command, ledger and task labels omitted.'],
    warnings: [...new Set(copy.quality?.warnings || [])].sort(),
  };
  delete copy.private;
  delete copy.source_key;
  delete copy.supersedes;
  delete copy.revision;
  copy.event_id = eventId(copy);
  return copy;
}

function selectEvents(events, { latest = 1, since = null, activity = null } = {}) {
  const sinceMs = since ? Date.parse(since) : null;
  if (since && !Number.isFinite(sinceMs)) throw new Error(`invalid --since timestamp: ${since}`);
  return events
    .filter((event) => event.event_type === 'process')
    .filter((event) => event.measurements?.energy?.coverage && event.measurements.energy.coverage !== 'unavailable')
    .filter((event) => (event.measurements.energy.estimated_wh !== null || event.measurements.energy.measured_wh !== null))
    .filter((event) => !activity || event.activity === activity)
    .filter((event) => sinceMs === null || Date.parse(event.occurred_at) >= sinceMs)
    .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)))
    .slice(-Math.max(1, latest));
}

function main(argv) {
  const { value, has } = parseArgs(argv);
  if (has('help')) { console.log(usage()); return 0; }
  const out = value('out');
  if (!out) { console.error(usage()); return 2; }
  const input = value('input') || ledgerFile();
  if (!fs.existsSync(input)) { console.error(`[local-evidence] no ledger at ${input}`); return 2; }
  const loaded = loadEvents({ file: input });
  if (loaded.invalid.length) {
    for (const row of loaded.invalid.slice(0, 5)) console.error(`[local-evidence] skipped invalid line ${row.line}: ${row.problem}`);
  }
  const latest = Number(value('latest') || 1);
  if (!Number.isInteger(latest) || latest < 1) { console.error('--latest must be an integer >= 1'); return 2; }
  const events = selectEvents(loaded.events, {
    latest,
    since: value('since'),
    activity: value('activity'),
  });
  if (events.length === 0) {
    console.error('[local-evidence] no process event with CodeCarbon energy matched; run a local CodeCarbon measurement first');
    return 2;
  }
  const exported = events.map((event) => sanitize(event, { taskId: value('task-id') || 'local-resource-baseline' }));
  for (const event of exported) assertEvent(event);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), `${exported.map((event) => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 });
  console.error(`[local-evidence] exported ${exported.length} sanitized event(s) to ${path.relative(process.cwd(), path.resolve(out))}`);
  for (const event of exported) {
    console.error(`[local-evidence] ${event.activity} ${event.occurred_at} ${event.measurements.energy.estimated_wh} Wh coverage=${event.measurements.energy.coverage}`);
  }
  return 0;
}

module.exports = { parseArgs, sanitize, selectEvents, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
