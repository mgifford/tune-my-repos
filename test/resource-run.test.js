const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const { loadEvents, loadTasks } = require('../scripts/lib/resource/ledger.cjs');

const wrapper = path.join(__dirname, '..', 'scripts', 'resource-run.cjs');
const repoRoot = path.join(__dirname, '..');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tmr-resource-run-'));
}

function run(args, { cache, timeout = 20000 } = {}) {
  return spawnSync(process.execPath, [wrapper, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, RESOURCE_CACHE_DIR: cache, RESOURCE_REPORTS_DIR: cache },
  });
}

test('resource-run preserves a successful exit status and records an attributed event', () => {
  const cache = tempDir();
  const result = run(['--activity=test', '--task=demo-test', '--label=Demo', '--', 'node', '-e', 'process.exit(0)'], { cache });
  assert.equal(result.status, 0, result.stderr);
  const events = loadEvents({ file: path.join(cache, 'ledger', 'events.jsonl') });
  assert.equal(events.invalid.length, 0);
  const processEvent = events.events.find((event) => event.event_type === 'process');
  assert.equal(processEvent.activity, 'test-suite');
  assert.equal(processEvent.task.id, 'demo-test');
  assert.equal(processEvent.outcome, 'success');
  assert.equal(processEvent.validation, 'passed');
  assert.equal(processEvent.measurements.cpu.measurement, 'measured');
  assert.ok(processEvent.measurements.memory.peak_rss_bytes > 0);
  const task = loadTasks({ file: path.join(cache, 'ledger', 'tasks.jsonl') }).tasks.find((entry) => entry.task_id === 'demo-test');
  assert.equal(task.state, 'in_progress');
  assert.equal(task.attempts.total, 1);
  assert.ok(task.resource_event_ids.includes(processEvent.event_id));
});

test('resource-run preserves a failing exit status and records the failed attempt', () => {
  const cache = tempDir();
  const result = run(['--activity=test', '--task=demo-fail', '--', 'node', '-e', 'process.exit(7)'], { cache });
  assert.equal(result.status, 7);
  const events = loadEvents({ file: path.join(cache, 'ledger', 'events.jsonl') });
  const processEvent = events.events.find((event) => event.event_type === 'process');
  assert.equal(processEvent.outcome, 'failure');
  assert.equal(processEvent.validation, 'failed');
  const task = loadTasks({ file: path.join(cache, 'ledger', 'tasks.jsonl') }).tasks.find((entry) => entry.task_id === 'demo-fail');
  assert.equal(task.state, 'failed');
  assert.equal(task.attempts.failed, 1);
});

test('resource-run writes no ledger with --no-record but can still write the event JSON', () => {
  const cache = tempDir();
  const eventFile = path.join(cache, 'event.json');
  const result = run(['--activity=noop', '--task=no-record', '--no-record', `--event-out=${eventFile}`, '--', 'node', '-e', ''], { cache });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(cache, 'ledger', 'events.jsonl')), false);
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  assert.equal(event.activity, 'noop');
  assert.equal(event.task.id, 'no-record');
});

test('CodeCarbon is optional: a missing binary does not fail the wrapped command', () => {
  const cache = tempDir();
  const result = run(['--activity=noop', '--task=optional-codecarbon', '--codecarbon', '--codecarbon-bin=/nonexistent/codecarbon', '--', 'node', '-e', 'process.exit(0)'], { cache });
  assert.equal(result.status, 0, result.stderr);
  const processEvent = loadEvents({ file: path.join(cache, 'ledger', 'events.jsonl') }).events.find((event) => event.event_type === 'process');
  assert.equal(processEvent.measurements.energy.coverage, 'unavailable');
  assert.ok(processEvent.quality.warnings.includes('codecarbon-unavailable'));
});

test('--require-codecarbon refuses to run the command when CodeCarbon is missing', () => {
  const cache = tempDir();
  const marker = path.join(cache, 'ran.txt');
  const result = run(['--activity=noop', '--task=required-codecarbon', '--require-codecarbon', '--codecarbon-bin=/nonexistent/codecarbon', '--', 'node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], { cache });
  assert.equal(result.status, 127);
  assert.equal(fs.existsSync(marker), false, 'the command must not run when the required tracker is unavailable');
});

test('each measurement gets a unique raw directory; no two measurements overwrite a CSV', async () => {
  const cache = tempDir();
  const runs = await Promise.all([1, 2].map(() => new Promise((resolve) => {
    const child = spawn(process.execPath, [wrapper, '--activity=noop', '--task=parallel-measurements', '--', 'node', '-e', 'setTimeout(()=>{}, 300)'], {
      cwd: repoRoot,
      env: { ...process.env, RESOURCE_CACHE_DIR: cache, RESOURCE_REPORTS_DIR: cache },
      stdio: 'ignore',
    });
    child.on('exit', (code) => resolve(code));
  })));
  assert.deepEqual(runs, [0, 0]);
  const rawDirs = fs.readdirSync(path.join(cache, 'raw'));
  assert.equal(rawDirs.length, 2);
  assert.equal(new Set(rawDirs).size, 2);
  const events = loadEvents({ file: path.join(cache, 'ledger', 'events.jsonl') }).events.filter((event) => event.event_type === 'process');
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map((event) => event.measurement_id)).size, 2);
});

test('a concurrently active measurement is recorded as overlap, not hidden', () => {
  const cache = tempDir();
  const activeFile = path.join(cache, 'active-measurements.json');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(activeFile, `${JSON.stringify([{ pid: process.pid, activity: 'other', started_at: new Date().toISOString() }])}\n`);
  const result = run(['--activity=noop', '--task=overlap', '--', 'node', '-e', ''], { cache });
  assert.equal(result.status, 0, result.stderr);
  const processEvent = loadEvents({ file: path.join(cache, 'ledger', 'events.jsonl') }).events.find((event) => event.event_type === 'process');
  assert.equal(processEvent.measurements.measurement.overlap, true);
  assert.equal(processEvent.measurements.measurement.concurrent_measurements, 1);
  assert.ok(processEvent.quality.warnings.includes('measurement-overlapped-another-measurement'));
});

test('a verified task is not silently unverified by a later resource run', () => {
  const cache = tempDir();
  let result = run(['--activity=test', '--task=verified-task', '--', 'node', '-e', ''], { cache });
  assert.equal(result.status, 0, result.stderr);
  const verify = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'resource-task.cjs'), 'verify', 'verified-task', '--evidence=test/synthetic'], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env, RESOURCE_CACHE_DIR: cache },
  });
  assert.equal(verify.status, 0, verify.stderr);
  result = run(['--activity=test', '--task=verified-task', '--', 'node', '-e', ''], { cache });
  assert.equal(result.status, 0, result.stderr);
  const task = loadTasks({ file: path.join(cache, 'ledger', 'tasks.jsonl') }).tasks.find((entry) => entry.task_id === 'verified-task');
  assert.equal(task.state, 'completed_verified');
  assert.equal(task.verified, true);
  assert.equal(task.attempts.total, 2);
});
