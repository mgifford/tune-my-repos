/**
 * Append-only local ledgers for resource events and task records.
 *
 * The ledger is JSONL under .resource-cache/ (gitignored). A malformed line is
 * reported and skipped, never allowed to make the whole ledger unreadable.
 * Writes are serialized with a lock so two measurements cannot interleave a
 * partial line. Re-importing the same immutable event is a no-op.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ensureDir, ledgerRoot } = require('./paths.cjs');
const { acquireLock, nowIso } = require('./measure.cjs');
const { makeEvent, validateEvent, iso } = require('./event.cjs');

function ledgerFile() { return path.join(ledgerRoot(), 'events.jsonl'); }
function tasksFile() { return path.join(ledgerRoot(), 'tasks.jsonl'); }

function ensureLedger() {
  ensureDir(ledgerRoot());
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return { rows: [], invalid: [], lines: 0 };
  const raw = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
  const rows = [];
  const invalid = [];
  for (const [index, line] of raw.entries()) {
    try {
      rows.push({ line: index + 1, value: JSON.parse(line) });
    } catch (error) {
      invalid.push({ line: index + 1, problem: `invalid JSON: ${error.message}`.slice(0, 200) });
    }
  }
  return { rows, invalid, lines: raw.length };
}

function loadEvents({ file = ledgerFile(), includeSuperseded = false, includeMonitoring = true } = {}) {
  const raw = readJsonl(file);
  const events = [];
  const invalid = [...raw.invalid];
  const latestBySource = new Map();
  for (const row of raw.rows) {
    const event = row.value;
    const problems = validateEvent(event);
    if (problems.length) {
      invalid.push({ line: row.line, problem: problems.slice(0, 3).join('; ') });
      continue;
    }
    if (!includeMonitoring && event.activity === 'monitoring') continue;
    if (!event.source_key) { events.push(event); continue; }
    const previous = latestBySource.get(event.source_key);
    if (!previous) { latestBySource.set(event.source_key, event); continue; }
    const better = (event.revision || 1) > (previous.revision || 1)
      || ((event.revision || 1) === (previous.revision || 1) && String(event.recorded_at) > String(previous.recorded_at));
    if (better) {
      if (includeSuperseded) events.push(previous);
      latestBySource.set(event.source_key, event);
    } else if (includeSuperseded) {
      events.push(event);
    }
  }
  events.push(...latestBySource.values());
  events.sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)) || a.event_id.localeCompare(b.event_id));
  return { events, invalid, lines: raw.lines };
}

async function appendEvents(input, { file = ledgerFile() } = {}) {
  ensureLedger();
  const candidates = (Array.isArray(input) ? input : [input]).map((item) => (
    item && item.event_id ? item : makeEvent(item)
  ));
  const lock = await acquireLock('ledger');
  try {
    const existing = loadEvents({ file, includeMonitoring: true });
    const existingIds = new Set(existing.events.map((event) => event.event_id));
    // Re-read raw for source-key revisions, because loadEvents hides superseded rows.
    const raw = readJsonl(file);
    const latestBySource = new Map();
    for (const row of raw.rows) {
      const event = row.value;
      if (!event || !event.source_key) continue;
      const previous = latestBySource.get(event.source_key);
      if (!previous || (event.revision || 1) > (previous.revision || 1)) latestBySource.set(event.source_key, event);
    }
    const added = [];
    const skipped = [];
    for (const candidate of candidates) {
      const problems = validateEvent(candidate);
      if (problems.length) {
        throw new Error(`refusing to append an invalid resource event:\n  ${problems.slice(0, 10).join('\n  ')}`);
      }
      if (existingIds.has(candidate.event_id)) {
        skipped.push({ event_id: candidate.event_id, reason: 'identical event already recorded' });
        continue;
      }
      let event = candidate;
      if (event.source_key) {
        const previous = latestBySource.get(event.source_key);
        if (previous && previous.event_id !== event.event_id) {
          event = {
            ...event,
            supersedes: previous.event_id,
            revision: (previous.revision || 1) + 1,
          };
          const recheck = validateEvent(event);
          if (recheck.length) throw new Error(`invalid superseding event: ${recheck.slice(0, 3).join('; ')}`);
        }
      }
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      existingIds.add(event.event_id);
      if (event.source_key) latestBySource.set(event.source_key, event);
      added.push(event);
    }
    return { added, skipped, recorded_at: iso() };
  } finally {
    lock.release();
  }
}

function validateTaskRecord(record) {
  // The task schema is loaded lazily to keep this module usable by the
  // event-only tests that never touch tasks.
  const { validateResourceTask } = require('./tasks.cjs');
  return validateResourceTask(record);
}

function loadTasks({ file = tasksFile() } = {}) {
  const raw = readJsonl(file);
  const invalid = [...raw.invalid];
  const latest = new Map();
  for (const row of raw.rows) {
    const task = row.value;
    const problems = validateTaskRecord(task);
    if (problems.length) {
      invalid.push({ line: row.line, problem: problems.slice(0, 3).join('; ') });
      continue;
    }
    const previous = latest.get(task.task_id);
    if (!previous || (task.revision || 1) >= (previous.revision || 1)) latest.set(task.task_id, task);
  }
  return {
    tasks: [...latest.values()].sort((a, b) => a.task_id.localeCompare(b.task_id)),
    invalid,
    lines: raw.lines,
  };
}

async function appendTask(record, { file = tasksFile() } = {}) {
  ensureLedger();
  const lock = await acquireLock('ledger');
  try {
    const existing = loadTasks({ file });
    const previous = existing.tasks.find((task) => task.task_id === record.task_id);
    const next = {
      ...record,
      revision: previous ? (previous.revision || 1) + 1 : (record.revision || 1),
      updated_at: record.updated_at || nowIso(),
      ...(previous ? { replaces: previous.revision || 1 } : {}),
    };
    const problems = validateTaskRecord(next);
    if (problems.length) throw new Error(`invalid task record:\n  ${problems.slice(0, 10).join('\n  ')}`);
    fs.appendFileSync(file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    return next;
  } finally {
    lock.release();
  }
}

function monitoringEvent({ adapter, startedAt, durationMs, note, project = 'local/tune-my-repos' }) {
  const usage = process.resourceUsage();
  const cpuSeconds = (usage.userCPUTime + usage.systemCPUTime) / 1e6;
  return makeEvent({
    event_type: 'monitoring',
    occurred_at: startedAt,
    duration_ms: durationMs || 0,
    project,
    task: { id: `monitor:${adapter}`, label: 'Resource collection overhead', execution_id: null, kind: 'resource-accounting', state: 'completed_verified', expected_deliverable: 'none', verified: true },
    activity: 'monitoring',
    tool: 'resource-collect',
    outcome: 'success',
    validation: 'not-run',
    source: { adapter: 'self', method: 'process.resourceUsage()', confidence: 'measured', reference: null },
    measurements: {
      cpu: { user_seconds: usage.userCPUTime / 1e6, system_seconds: usage.systemCPUTime / 1e6, total_seconds: cpuSeconds, cpu_percent: null, measurement: 'measured', source: 'Node process.resourceUsage()' },
      memory: { peak_rss_bytes: usage.maxRSS * 1024, measurement: 'measured' },
      io: { read_ops: usage.fsRead ?? null, write_ops: usage.fsWrite ?? null, read_bytes: null, write_bytes: null, measurement: usage.fsRead == null ? 'unavailable' : 'measured' },
      network: { rx_bytes: null, tx_bytes: null, measurement: 'unavailable' },
    },
    quality: {
      completeness: 'partial',
      missing: ['network', 'energy'],
      notes: [note || 'Collector process overhead, not the activity it measured.'],
      warnings: ['collector-overhead-not-activity'],
    },
    private: { collector: adapter },
  });
}

function directoryBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try { total += fs.statSync(full).size; } catch { /* disappeared */ }
      }
    }
  }
  return total;
}

module.exports = {
  ledgerFile,
  tasksFile,
  ensureLedger,
  readJsonl,
  loadEvents,
  appendEvents,
  loadTasks,
  appendTask,
  monitoringEvent,
  directoryBytes,
  iso,
};
