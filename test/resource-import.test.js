const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { csvEvents, aiEvents } = require('../scripts/import-resource-evidence.cjs');
const { loadEvents } = require('../scripts/lib/resource/ledger.cjs');
const { loadFactorDataset } = require('../scripts/lib/resource/factors.cjs');
const { validateEvent } = require('../scripts/lib/resource/event.cjs');

const root = path.join(__dirname, '..');
const fixtures = path.join(root, 'fixtures', 'resource');

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tmr-import-'));
}

function cli(args, cache) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'import-resource-evidence.cjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, RESOURCE_CACHE_DIR: cache, RESOURCE_REPORTS_DIR: cache },
  });
}

test('CodeCarbon CSV import normalizes every row and does not assume a successful command', () => {
  const events = csvEvents({
    file: path.join(fixtures, 'codecarbon-3.3.3-sample.csv'),
    activity: 'repository-inventory',
    taskId: 'imported-csv',
    project: 'example/public-repo',
    commit: '0123456789abcdef0123456789abcdef01234567',
  });
  assert.equal(events.length, 5);
  for (const event of events) {
    assert.deepEqual(validateEvent(event), []);
    assert.equal(event.outcome, 'unknown');
    assert.equal(event.validation, 'unknown');
    assert.ok(event.quality.notes.includes('codecarbon-csv-has-no-command-exit-status'));
  }
  assert.ok(Math.abs(events[0].measurements.energy.estimated_wh - 0.025) < 1e-12);
  assert.equal(events[0].measurements.emissions.gco2e, 0.000065);
});

test('CodeCarbon CSV import is idempotent through deterministic event ids', () => {
  const first = csvEvents({ file: path.join(fixtures, 'codecarbon-3.3.3-sample.csv'), activity: 'repository-inventory', taskId: 'dedupe', project: 'example/public-repo' });
  const second = csvEvents({ file: path.join(fixtures, 'codecarbon-3.3.3-sample.csv'), activity: 'repository-inventory', taskId: 'dedupe', project: 'example/public-repo' });
  assert.deepEqual(first.map((event) => event.event_id), second.map((event) => event.event_id));
});

test('the import CLI writes CodeCarbon rows and skips an identical re-import', () => {
  const cache = temp();
  const args = ['--codecarbon-csv', path.join(fixtures, 'codecarbon-3.3.3-sample.csv'), '--activity=repository-inventory', '--task=imported-csv', '--project=example/public-repo'];
  const first = cli(args, cache);
  assert.equal(first.status, 0, first.stderr);
  const ledgerFile = path.join(cache, 'ledger', 'events.jsonl');
  const firstEvents = loadEvents({ file: ledgerFile }).events.filter((event) => event.event_type === 'process');
  assert.equal(firstEvents.length, 5);
  const second = cli(args, cache);
  assert.equal(second.status, 0, second.stderr);
  const secondEvents = loadEvents({ file: ledgerFile }).events.filter((event) => event.event_type === 'process');
  assert.equal(secondEvents.length, 5, 'identical rows are not duplicated');
});

test('AI usage import preserves raw provider fields, hashes sessions and uses the factor dataset', () => {
  const dataset = loadFactorDataset(path.join(fixtures, 'cleer-factors.synthetic.json'));
  const imported = aiEvents({
    file: path.join(fixtures, 'ai-usage.synthetic.jsonl'),
    dataset,
    cacheCreationPolicy: 'unavailable',
    project: 'example/public-repo',
    commit: null,
  });
  assert.equal(imported.events.length, 4);
  assert.deepEqual(imported.problems, []);
  const anthropic = imported.events.find((event) => event.ai.request_id === 'req_anth_synthetic_1');
  assert.equal(anthropic.measurements.tokens.input_total, 8000);
  assert.equal(anthropic.measurements.tokens.cache_creation, 2000);
  assert.match(anthropic.ai.session_id_hash, /^[0-9a-f]{64}$/);
  assert.equal(anthropic.private.raw_usage.input_tokens, 1000);
  const unsupported = imported.events.find((event) => event.ai.request_id === 'req_unknown_synthetic_1');
  assert.equal(unsupported.measurements.energy.coverage, 'unavailable');
});

test('AI usage import works without a factor dataset and reports energy unavailable', () => {
  const imported = aiEvents({ file: path.join(fixtures, 'ai-usage.synthetic.jsonl'), dataset: null, cacheCreationPolicy: 'unavailable', project: 'example/public-repo', commit: null });
  assert.equal(imported.events.length, 4);
  assert.ok(imported.events.every((event) => event.measurements.energy.coverage === 'unavailable'));
  assert.ok(imported.events.every((event) => event.measurements.energy.notes.includes('no-local-factor-dataset')));
});

test('the import CLI accepts synthetic AI factors only when explicitly allowed', () => {
  const cache = temp();
  const base = ['--ai-usage', path.join(fixtures, 'ai-usage.synthetic.jsonl'), '--factors', path.join(fixtures, 'cleer-factors.synthetic.json'), '--no-record'];
  const refused = cli(base, cache);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /synthetic/);
  const allowed = cli([...base, '--allow-synthetic'], cache);
  assert.equal(allowed.status, 0, allowed.stderr);
});

test('CLEER dashboard import writes a session-only factor dataset and reports no per-token factors', () => {
  const cache = temp();
  const out = path.join(cache, 'cleer.json');
  const result = cli([
    '--cleer-models', path.join(fixtures, 'cleer-dashboard-models.synthetic.json'),
    '--factors-out', out,
    '--json',
  ], cache);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.factors.dataset_kind, 'session-only');
  assert.equal(summary.factors.per_token_models, 0);
  assert.equal(fs.existsSync(out), true);
  const dataset = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(dataset.dataset_kind, 'session-only');
  assert.equal(dataset.models.length, 2);
  assert.ok(dataset.notes.some((note) => note.includes('per-token')));
});

test('the import CLI refuses an invalid AI JSONL line but keeps valid ones', () => {
  const cache = temp();
  const dir = temp();
  const file = path.join(dir, 'mixed.jsonl');
  const valid = fs.readFileSync(path.join(fixtures, 'ai-usage.synthetic.jsonl'), 'utf8').split('\n')[0];
  fs.writeFileSync(file, `${valid}\nnot-json\n`);
  const result = cli(['--ai-usage', file, '--no-record'], cache);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /skipped line 2/);
});
