#!/usr/bin/env node
/**
 * Import local evidence into the resource ledger.
 *
 *   node scripts/import-resource-evidence.cjs --codecarbon-csv emissions.csv \
 *     --activity=test-suite --task=maintenance-baseline
 *   node scripts/import-resource-evidence.cjs --ai-usage fixtures/resource/ai-usage.synthetic.jsonl \
 *     --factors fixtures/resource/cleer-factors.synthetic.json --allow-synthetic
 *   node scripts/import-resource-evidence.cjs --cleer-models /path/to/models.json \
 *     --cleer-meta /path/to/meta.json --factors-out .resource-cache/factors/cleer.json
 *
 * The importer never contacts the network. A CodeCarbon CSV has no command
 * exit status, so imported events are marked outcome/validation unknown rather
 * than assumed successful.
 */

const fs = require('node:fs');
const path = require('node:path');

const { REPO_ROOT, factorRoot, ensureDir } = require('./lib/resource/paths.cjs');
const { projectInfo, nowIso, codecarbonVersion } = require('./lib/resource/measure.cjs');
const { parseCodeCarbonCsv, normalizeCodeCarbonRow } = require('./lib/resource/units.cjs');
const { appendEvents, monitoringEvent } = require('./lib/resource/ledger.cjs');
const { createProcessEvent } = require('./lib/resource/process-event.cjs');
const { normalizeAiRequest } = require('./lib/resource/ai.cjs');
const { loadFactorDataset, importCleerDashboard, writeFactorDataset, coverage } = require('./lib/resource/factors.cjs');

function usage() {
  return `Usage: node scripts/import-resource-evidence.cjs <source> [options]

Sources:
  --codecarbon-csv=<file>    Import one or more CodeCarbon 3.3.3 CSV rows.
  --ai-usage=<file>          Import JSONL provider-shaped AI usage records.
  --cleer-models=<file>      Import CLEER dashboard models.json as session-only coverage.
  --events=<file>            Validate and append TMR resource events (JSONL).

Options:
  --cleer-meta=<file>        CLEER meta.json (optional).
  --factors=<file>           Per-token factor dataset for AI estimation.
  --factors-out=<file>       Output path for an imported factor dataset.
  --allow-synthetic          Allow a synthetic factor dataset (test fixtures only).
  --cache-creation-policy=<unavailable|sensitivity_as_uncached_input>
  --max-age-days=<n>         Refuse imported events older than n days (freshness guard).
  --activity=<id>            Activity for CSV events (default: unknown).
  --task=<id>                Task id for imported events.
  --project=<owner/name>     Project override.
  --no-record                Do not write the ledger.
  --json                     Print a JSON import summary.
  --help                     Show this help.

CLEER 1.1.0 publishes per-session energy only, not per-token coefficients. The
CLEER import therefore records model coverage and refuses request-level
estimation; it does not divide session energy by an assumed token count.`;
}

function parseArgs(argv) {
  const value = (name) => {
    const prefix = `--${name}=`;
    const found = argv.find((arg) => arg.startsWith(prefix));
    if (found) return found.slice(prefix.length);
    const index = argv.indexOf(`--${name}`);
    if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
    return null;
  };
  const has = (name) => argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  return { value, has };
}

function sanitizeTaskId(value) {
  return String(value || 'imported-evidence').toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'imported-evidence';
}

function csvEvents({ file, activity, taskId, project, commit, measurementOverheadMs = null }) {
  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseCodeCarbonCsv(text);
  if (parsed.rows.length === 0) throw new Error('CodeCarbon CSV has no data rows');
  const events = [];
  for (const [index, row] of parsed.rows.entries()) {
    const normalized = normalizeCodeCarbonRow(row);
    const timestamp = String(row.timestamp || '').trim();
    const occurredAt = timestamp && Number.isFinite(Date.parse(timestamp))
      ? new Date(timestamp).toISOString()
      : nowIso();
    const runId = String(row.run_id || `row-${index + 1}`);
    const measurementId = `csv:${runId}`.slice(0, 120);
    const durationMs = normalized.normalized.duration_ms;
    const measurement = {
      measurement_id: measurementId,
      command: ['codecarbon-csv-import', path.basename(file)],
      started_at: occurredAt,
      wall_ms: durationMs,
      inner_wall_ms: durationMs,
      status: null,
      signal: null,
      timed_out: false,
      measurement_overhead_ms: measurementOverheadMs,
      time: {
        wall_ms: durationMs,
        user_seconds: null,
        system_seconds: null,
        max_rss_bytes: null,
        read_ops: null,
        write_ops: null,
        format: 'none',
      },
      codecarbon: {
        requested: true,
        attempted: true,
        parsed: normalized,
        problems: [],
        version: normalized.hardware.codecarbon_version,
      },
    };
    const event = createProcessEvent({
      measurement,
      activity,
      project,
      commit,
      taskId,
      taskLabel: `Imported CodeCarbon CSV row ${index + 1}`,
      deliverable: 'resource-report',
      samplingIntervalMs: null,
      repeats: 1,
    });
    event.outcome = 'unknown';
    event.validation = 'unknown';
    event.quality.notes.push('codecarbon-csv-has-no-command-exit-status');
    event.quality.notes.push('codecarbon-csv-timestamp-is-local-naive-time');
    event.quality.warnings = [...new Set([...(event.quality.warnings || []), 'imported-outcome-unknown'])];
    event.private.codecarbon_experiment_id = String(row.experiment_id || '') || null;
    event.private.import_file = path.basename(file);
    // Recompute the id after the outcome/metadata changes so imports stay deterministic.
    const { eventId } = require('./lib/resource/event.cjs');
    event.event_id = eventId(event);
    events.push(event);
  }
  return events;
}

function aiEvents({ file, dataset, cacheCreationPolicy, project, commit }) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
  const events = [];
  const problems = [];
  for (const [index, line] of lines.entries()) {
    try {
      const raw = JSON.parse(line);
      const event = normalizeAiRequest({
        ...raw,
        project: raw.project || raw.repository || project,
        commit: raw.commit || commit,
      }, { dataset, cacheCreationPolicy });
      events.push(event);
    } catch (error) {
      problems.push({ line: index + 1, problem: error.message.slice(0, 300) });
    }
  }
  return { events, problems };
}

function eventFileEvents(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
  return lines.map((line, index) => {
    try { return { event: JSON.parse(line) }; } catch (error) { return { problem: { line: index + 1, problem: error.message } }; }
  });
}

async function main(argv) {
  const { value, has } = parseArgs(argv);
  if (has('help')) { console.log(usage()); return 0; }
  const info = projectInfo(process.cwd());
  const project = value('project') || info.project;
  const commit = info.commit;
  const taskId = value('task') || `import:${new Date().toISOString().slice(0, 10)}`;
  const activity = value('activity') || 'unknown';
  const noRecord = has('no-record');
  const maxAgeDays = Number(value('max-age-days') || 0);
  const summary = { imported: 0, problems: [], source: null };

  if (value('cleer-models')) {
    const dataset = importCleerDashboard(value('cleer-models'), {
      metaFile: value('cleer-meta'),
      sourceUrl: value('source-url'),
    });
    const out = value('factors-out') || path.join(factorRoot(), `${dataset.dataset}-${dataset.dataset_version}.json`.replace(/[^A-Za-z0-9._-]/g, '-'));
    ensureDir(path.dirname(out));
    writeFactorDataset(dataset, out);
    summary.source = 'cleer-dashboard';
    summary.factors = { path: path.relative(process.cwd(), out), ...coverage(dataset) };
    console.error(`[resource-import] imported CLEER coverage: ${coverage(dataset).model_count} models, per-token factors: 0 (not published)`);
    console.error(`[resource-import] wrote ${path.relative(process.cwd(), out)}`);
    if (has('json')) console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  let dataset = null;
  if (value('factors')) {
    dataset = loadFactorDataset(value('factors'), { allowSynthetic: has('allow-synthetic') });
    summary.factors = coverage(dataset);
  }

  let events = [];
  if (value('codecarbon-csv')) {
    summary.source = 'codecarbon-csv';
    events = csvEvents({
      file: value('codecarbon-csv'),
      activity,
      taskId,
      project,
      commit,
    });
  } else if (value('ai-usage')) {
    summary.source = 'ai-usage';
    const imported = aiEvents({
      file: value('ai-usage'),
      dataset,
      cacheCreationPolicy: value('cache-creation-policy') || 'unavailable',
      project,
      commit,
    });
    events = imported.events;
    summary.problems.push(...imported.problems);
  } else if (value('events')) {
    summary.source = 'events';
    const rows = eventFileEvents(value('events'));
    for (const row of rows) {
      if (row.event) events.push(row.event);
      else summary.problems.push(row.problem);
    }
  } else {
    console.error(usage());
    return 2;
  }

  if (maxAgeDays > 0) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const stale = events.filter((event) => {
      const at = Date.parse(event.occurred_at);
      return !Number.isFinite(at) || at < cutoff;
    });
    if (stale.length) {
      throw new Error(`refusing stale evidence: ${stale.length} event(s) are older than ${maxAgeDays} day(s); refresh the local measurement`);
    }
  }
  summary.imported = events.length;
  if (!noRecord && events.length) {
    const written = await appendEvents(events);
    summary.added = written.added.length;
    summary.skipped = written.skipped.length;
    await appendEvents([monitoringEvent({
      adapter: 'import-resource-evidence',
      startedAt: nowIso(),
      durationMs: 0,
      note: 'Evidence import and ledger overhead; imported measurements are not re-measured.',
      project,
    })]);
  }
  for (const problem of summary.problems.slice(0, 10)) console.error(`[resource-import] skipped line ${problem.line}: ${problem.problem}`);
  console.error(`[resource-import] ${summary.source}: ${summary.imported} event(s) imported${summary.added === undefined ? '' : `, ${summary.added} added, ${summary.skipped} skipped`}`);
  if (has('json')) console.log(JSON.stringify(summary, null, 2));
  return summary.problems.length && events.length === 0 ? 2 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[resource-import] ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = {
  parseArgs,
  csvEvents,
  aiEvents,
  eventFileEvents,
  sanitizeTaskId,
  codecarbonVersion,
  REPO_ROOT,
};
