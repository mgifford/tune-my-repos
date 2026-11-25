const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { sanitize, selectEvents, main } = require('../scripts/export-local-resource-evidence.cjs');
const { validateEvent, eventId } = require('../scripts/lib/resource/event.cjs');
const { loadEvents } = require('../scripts/lib/resource/ledger.cjs');

const fixture = path.join(__dirname, '..', 'fixtures', 'resource', 'resource-events.synthetic.jsonl');
const events = loadEvents({ file: fixture }).events;

function tempOut() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmr-local-evidence-')), 'evidence.jsonl');
}

test('selectEvents chooses the latest process events with CodeCarbon energy', () => {
  const selected = selectEvents(events, { latest: 1 });
  assert.equal(selected.length, 1);
  assert.ok(selected[0].measurements.energy.estimated_wh > 0);
  assert.equal(selected[0].event_type, 'process');
  const all = selectEvents(events, { latest: 10 });
  assert.ok(all.length >= 2);
});

test('sanitize removes private data, task labels, commands and paths while preserving energy', () => {
  const source = events.find((event) => event.event_type === 'process' && event.measurements.energy.estimated_wh > 0);
  const clean = sanitize(source);
  assert.deepEqual(validateEvent(clean), []);
  assert.equal(clean.project, 'local/tune-my-repos');
  assert.equal(clean.task.id, 'local-resource-baseline');
  assert.equal(clean.task.label, null);
  assert.equal(clean.private, undefined);
  assert.equal(clean.source.reference, null);
  assert.equal(clean.source.method, 'CodeCarbon offline process energy model plus child accounting');
  assert.equal(clean.measurements.energy.estimated_wh, source.measurements.energy.estimated_wh);
  const serialized = JSON.stringify(clean);
  assert.doesNotMatch(serialized, /\/Users\/|command_label|session_id|private|example\/public-repo|Synthetic repository inventory/);
  assert.notEqual(clean.event_id, source.event_id);
  assert.equal(clean.event_id, eventId(clean));
});

test('the export CLI writes a valid JSONL file and is deterministic', () => {
  const first = tempOut();
  const second = tempOut();
  const args = [`--input=${fixture}`, `--out=${first}`, '--latest=2'];
  assert.equal(main(args), 0);
  assert.equal(main([`--input=${fixture}`, `--out=${second}`, '--latest=2']), 0);
  const rows = fs.readFileSync(first, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual(validateEvent(row), []);
  assert.deepEqual(
    rows.map((row) => row.event_id),
    fs.readFileSync(second, 'utf8').trim().split('\n').map(JSON.parse).map((row) => row.event_id),
  );
});

test('the export CLI fails clearly when no matching energy event exists', () => {
  const out = tempOut();
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'export-local-resource-evidence.cjs'), '--input=' + fixture, '--out=' + out, '--activity=no-such-activity'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no process event with CodeCarbon energy matched/);
  assert.equal(fs.existsSync(out), false);
});

test('since and activity filters are supported', () => {
  const selected = selectEvents(events, { latest: 10, since: '2026-11-20T15:00:00Z' });
  assert.ok(selected.length >= 1);
  assert.ok(selected.every((event) => Date.parse(event.occurred_at) >= Date.parse('2026-11-20T15:00:00Z')));
  const incremental = selectEvents(events, { latest: 10, activity: 'incremental-inventory' });
  assert.ok(incremental.every((event) => event.activity === 'incremental-inventory'));
});
