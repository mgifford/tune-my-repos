#!/usr/bin/env node
/**
 * Optional resource measurement wrapper.
 *
 *   node scripts/resource-run.cjs --activity=test-suite --task=maintenance-baseline -- npm test
 *   node scripts/resource-run.cjs --activity=repository-inventory --task=incremental-inventory \
 *     --codecarbon -- node scripts/generate-maintenance-rollup.cjs
 *
 * CodeCarbon is optional. The command's exit status is preserved. Raw
 * measurement files go to a unique gitignored directory; the normalized event
 * goes to the local JSONL ledger. No telemetry is sent anywhere.
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { cacheRoot, ensureDir } = require('./lib/resource/paths.cjs');
const { ledgerFile } = require('./lib/resource/ledger.cjs');
const { nowIso, projectInfo, measureCommand, codecarbonVersion, acquireLock } = require('./lib/resource/measure.cjs');
const { makeEvent, activities } = require('./lib/resource/event.cjs');
const { appendEvents, monitoringEvent } = require('./lib/resource/ledger.cjs');
const { recordEvent, updateTask, getTask } = require('./lib/resource/tasks.cjs');
const { createProcessEvent } = require('./lib/resource/process-event.cjs');

const ALIASES = {
  test: 'test-suite',
  tests: 'test-suite',
  inventory: 'repository-inventory',
  'full-inventory': 'repository-inventory',
  incremental: 'incremental-inventory',
  policy: 'policy-evaluation',
  dashboard: 'static-dashboard-generation',
  aggregate: 'resource-aggregation',
  noop: 'noop',
};

function usage() {
  return `Usage: node scripts/resource-run.cjs --activity=<activity> [options] -- <command...>

Options:
  --activity=<id>            Workload type (required). "test" is an alias for test-suite.
  --task=<id>                Stable task id (default: unfiled:<activity>).
  --label=<text>             Local-only command label.
  --issue=<ref>              Related issue.
  --pr=<ref>                 Related pull request.
  --variant=<ref>            Variant or comparison label.
  --deliverable=<id>         Expected deliverable enum.
  --verify=<ref>             Verification evidence reference (recorded, not auto-verified).
  --codecarbon               Run CodeCarbon in offline mode around the command.
  --require-codecarbon       Refuse to run if CodeCarbon is unavailable.
  --codecarbon-bin=<path>    CodeCarbon executable (default: $CODECARBON_BIN or "codecarbon").
  --country-iso-code=<code>  Offline grid country (default: CAN).
  --region=<name>            Offline grid region (default: quebec).
  --measure-power-secs=<n>   CodeCarbon sampling interval (default: 1).
  --timeout=<seconds>        Stop the command after this many seconds.
  --cache-state=<cold|warm>  Benchmark cache state label.
  --repeats=<n>              Repetition count label (default: 1).
  --baseline=<id>            Baseline workload label for benchmark events.
  --no-record                Measure but do not write the ledger or task record.
  --event-out=<file>         Also write the normalized event JSON to this file.
  --json                     Print the event JSON to stdout after the summary.
  --help                     Show this help.

The command must follow the first "--". Exit status is the wrapped command's
status (124 on timeout).`;
}

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  const flags = separator >= 0 ? argv.slice(0, separator) : argv.filter((arg) => arg.startsWith('-'));
  const command = separator >= 0 ? argv.slice(separator + 1) : argv.filter((arg) => !arg.startsWith('-'));
  const value = (name) => {
    const prefix = `--${name}=`;
    const found = flags.find((flag) => flag.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  };
  const has = (name) => flags.some((flag) => flag === `--${name}` || flag.startsWith(`--${name}=`));
  return { flags, command, value, has };
}

function normalizeActivity(value) {
  const raw = String(value || 'unknown');
  const activity = ALIASES[raw] || raw;
  if (!activities().includes(activity)) {
    throw new Error(`unknown activity "${raw}". Allowed: ${activities().join(', ')}`);
  }
  return activity;
}

function readActive() {
  const file = path.join(cacheRoot(), 'active-measurements.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function writeActive(entries) {
  const file = path.join(cacheRoot(), 'active-measurements.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

async function registerActive(record) {
  const lock = await acquireLock('active-measurements');
  try {
    const entries = readActive().filter((entry) => entry.pid !== process.pid && alive(entry.pid));
    const concurrent = entries.length;
    entries.push(record);
    await writeActive(entries);
    return { concurrent, entries };
  } finally {
    lock.release();
  }
}

async function unregisterActive() {
  const lock = await acquireLock('active-measurements');
  try {
    const entries = readActive().filter((entry) => entry.pid !== process.pid && alive(entry.pid));
    await writeActive(entries);
  } finally {
    lock.release();
  }
}

function formatNumber(value, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'unavailable';
}

async function main(argv) {
  const { flags, command, value, has } = parseArgs(argv);
  if (has('help') || command.length === 0) {
    console.log(usage());
    return command.length === 0 && !has('help') ? 2 : 0;
  }
  const activity = normalizeActivity(has('activity') ? value('activity') : 'unknown');
  const taskId = value('task') || `unfiled:${activity}`;
  const label = value('label');
  const issue = value('issue');
  const pullRequest = value('pr');
  const variant = value('variant');
  const deliverable = value('deliverable') || 'none';
  const verification = value('verify');
  const codecarbon = has('codecarbon') || has('require-codecarbon');
  const requireCodecarbon = has('require-codecarbon');
  const codecarbonBin = value('codecarbon-bin') || process.env.CODECARBON_BIN || 'codecarbon';
  const countryIsoCode = value('country-iso-code') || 'CAN';
  const region = value('region') || 'quebec';
  const measurePowerSecs = Number(value('measure-power-secs') || 1);
  const timeoutSeconds = Number(value('timeout') || 0);
  const cacheState = value('cache-state');
  const repeats = Number(value('repeats') || 1);
  const baseline = value('baseline');
  const eventOut = value('event-out');
  const noRecord = has('no-record');
  const jsonOut = has('json');

  if (!Number.isFinite(measurePowerSecs) || measurePowerSecs <= 0) throw new Error('--measure-power-secs must be > 0');
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('--repeats must be an integer >= 1');
  if (cacheState && !['cold', 'warm'].includes(cacheState)) throw new Error('--cache-state must be cold or warm');

  const info = projectInfo(process.cwd());
  const project = value('project') || info.project;
  const active = await registerActive({
    pid: process.pid,
    activity,
    task_id: taskId,
    started_at: nowIso(),
  });
  let measurement;
  try {
    measurement = await measureCommand({
      command,
      cwd: process.cwd(),
      codecarbon,
      requireCodecarbon,
      codecarbonBin,
      countryIsoCode,
      region,
      measurePowerSecs,
      timeoutMs: timeoutSeconds > 0 ? timeoutSeconds * 1000 : null,
      experimentName: activity,
      cacheState,
    });
  } finally {
    await unregisterActive();
  }

  const event = createProcessEvent({
    measurement,
    activity,
    project,
    commit: info.commit,
    issue,
    pullRequest,
    variant,
    taskId,
    taskLabel: label,
    deliverable,
    verification,
    samplingIntervalMs: codecarbon ? measurePowerSecs * 1000 : null,
    overlap: active.concurrent > 0,
    concurrentMeasurements: active.concurrent,
    cacheState,
    repeats,
    baseline,
    commandLabel: label || command.join(' ').slice(0, 300),
  });

  if (!noRecord) {
    const overheadStarted = Date.now();
    await appendEvents([event]);
    await recordEvent({ taskId, event, project, activity, issue, pullRequest, label, deliverable });
    if (verification) {
      const current = getTask(taskId);
      if (current) {
        await updateTask({
          taskId,
          state: current.state,
          verified: Boolean(current.verified),
          evidence: {
            kind: activity === 'test-suite' ? 'test' : 'command',
            reference: verification,
            summary: `Recorded by resource-run for activity ${activity}`,
          },
        });
      }
    }
    await appendEvents([monitoringEvent({
      adapter: 'resource-run',
      startedAt: new Date(overheadStarted).toISOString(),
      durationMs: Date.now() - overheadStarted,
      note: 'Wrapper, task-ledger and event-ledger overhead for one measured command; does not include the child CPU already in the process event.',
      project,
    })]);
  }

  if (eventOut) {
    fs.mkdirSync(path.dirname(path.resolve(eventOut)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.resolve(eventOut), `${JSON.stringify(event, null, 2)}\n`, { mode: 0o600 });
  }

  const energy = event.measurements.energy;
  console.error(`[resource] ${activity} task=${taskId} outcome=${event.outcome} exit=${measurement.status ?? measurement.signal ?? 'error'}`);
  console.error(`[resource] wall=${formatNumber(measurement.wall_ms / 1000, 2)}s cpu=${formatNumber(event.measurements.cpu.total_seconds, 2)}s rss=${event.measurements.memory.peak_rss_bytes === null ? 'unavailable' : `${formatNumber(event.measurements.memory.peak_rss_bytes / 1048576, 1)}MiB`}`);
  console.error(`[resource] energy=${energy.estimated_wh === null ? 'unavailable' : `${formatNumber(energy.estimated_wh, 6)}Wh (${energy.coverage})`} emissions=${event.measurements.emissions.gco2e === null ? 'unavailable' : `${formatNumber(event.measurements.emissions.gco2e, 8)}gCO2e`}`);
  if (event.quality.warnings.length) console.error(`[resource] warnings=${event.quality.warnings.join(', ')}`);
  if (codecarbon && !measurement.codecarbon.attempted) {
    console.error(`[resource] CodeCarbon was requested but not run: ${measurement.codecarbon.error || 'unknown reason'}`);
  }
  if (!noRecord) console.error(`[resource] event=${event.event_id} ledger=${path.relative(process.cwd(), ledgerFile())}`);
  if (jsonOut) console.log(JSON.stringify(event, null, 2));

  if (measurement.refused) return 127;
  if (measurement.timed_out) return 124;
  if (measurement.status === null || measurement.status === undefined) return 1;
  return measurement.status;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[resource] ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = {
  ALIASES,
  parseArgs,
  normalizeActivity,
  main,
  readActive,
  alive,
  registerActive,
  unregisterActive,
  codecarbonVersion,
  makeEvent,
  ensureDir,
  randomUUID,
};
