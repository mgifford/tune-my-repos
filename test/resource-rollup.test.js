const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildResourceRollup,
  validateResourceRollup,
  renderResourceMarkdown,
  renderResourceCsv,
  writeResourceReports,
} = require('../scripts/lib/resource/rollup.cjs');
const { publicProblems } = require('../policy/resource-redaction.cjs');
const { makeEvent } = require('../scripts/lib/resource/event.cjs');

const events = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'resource', 'resource-events.synthetic.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line));
const tasks = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'resource', 'resource-tasks.synthetic.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line));

test('the synthetic ledger produces a schema-valid, sanitized rollup', () => {
  const rollup = buildResourceRollup({ events, tasks, generatedAt: '2026-11-24T00:00:00.000Z', ledgerBytes: 10, rawBytes: 20 });
  assert.deepEqual(validateResourceRollup(rollup), []);
  assert.deepEqual(publicProblems(rollup), []);
  assert.equal(rollup.schema_version, '1.0.0');
  assert.equal(rollup.event_count, events.length);
  assert.equal(rollup.project_count, 1);
  assert.equal(rollup.local_computing.wall_ms, 34900);
  assert.ok(Math.abs(rollup.local_computing.energy.estimated_wh - 0.039) < 1e-12);
  assert.equal(rollup.local_computing.energy.coverage, 'partial');
  assert.equal(rollup.local_computing.energy.measured_wh, null);
});

test('monitoring overhead is reported separately from measured activity', () => {
  const rollup = buildResourceRollup({ events, tasks });
  assert.equal(rollup.monitoring.events, 1);
  assert.equal(rollup.monitoring.ledger_bytes, 0);
  assert.ok(rollup.local_computing.events < events.length);
  assert.ok(rollup.maintenance.by_activity.every((row) => row.activity !== 'monitoring'));
});

test('remote AI token categories and unsupported models are reported without substitution', () => {
  const rollup = buildResourceRollup({ events, tasks });
  assert.equal(rollup.remote_ai.requests, 2);
  assert.equal(rollup.remote_ai.tokens.uncached_input, 1500);
  assert.equal(rollup.remote_ai.tokens.cache_creation, 2000);
  assert.equal(rollup.remote_ai.tokens.cache_read, 5000);
  assert.equal(rollup.remote_ai.tokens.output, 550);
  assert.equal(rollup.remote_ai.complete_estimates, 0);
  assert.equal(rollup.remote_ai.partial_estimates, 1);
  assert.equal(rollup.remote_ai.unavailable_estimates, 1);
  assert.ok(rollup.remote_ai.unsupported_models.some((row) => row.model === 'mystery-model-9000-2026-02-01'));
  assert.ok(rollup.remote_ai.by_model.some((row) => row.model === 'claude-sonnet-4-5-synthetic-20260101' && row.coverage === 'partial'));
});

test('CLEER and EcoLogits estimates remain separate rows and are never added together', () => {
  const base = events.find((event) => event.event_type === 'ai-request');
  const ecologits = JSON.parse(JSON.stringify(base));
  ecologits.event_id = 'e'.repeat(64);
  ecologits.measurements.energy = {
    ...ecologits.measurements.energy,
    source: 'ecologits',
    source_version: 'synthetic-ecologits-1',
    dataset: { name: 'ecologits', version: 'synthetic-ecologits-1', checksum: null, license: 'synthetic', methodology_version: 'synthetic' },
    mean_wh: 0.5,
    estimated_wh: 0.5,
    coverage: 'complete',
    standard_deviation_wh: 0.1,
  };
  const rollup = buildResourceRollup({ events: [...events, ecologits], tasks });
  const methods = rollup.remote_ai.energy_by_methodology.map((row) => row.source);
  assert.ok(methods.includes('cleer'));
  assert.ok(methods.includes('ecologits'));
  const total = rollup.remote_ai.energy_by_methodology.reduce((sum, row) => sum + (row.mean_wh || 0), 0);
  assert.ok(total > 0);
  assert.equal(rollup.remote_ai.energy_by_methodology.length, 2);
});

test('functional units are withheld when the denominator or coverage is insufficient', () => {
  const rollup = buildResourceRollup({ events, tasks });
  const verified = rollup.functional_units.find((row) => row.unit === 'per_verified_task');
  assert.equal(verified.denominator, 1);
  assert.equal(verified.coverage, 'partial');
  assert.ok(verified.value_wh > 0);
  assert.match(verified.reason, /partial coverage/i);

  const noTasks = buildResourceRollup({ events, tasks: [] });
  const missing = noTasks.functional_units.find((row) => row.unit === 'per_verified_task');
  assert.equal(missing.value_wh, null);
  assert.equal(missing.coverage, 'unavailable');
  assert.match(missing.reason, /no verified/i);
});

test('GitHub API and Actions evidence are aggregated without converting requests to energy', () => {
  const rollup = buildResourceRollup({ events, tasks });
  assert.equal(rollup.maintenance.api.requests, 42);
  assert.equal(rollup.maintenance.api.status_304, 8);
  assert.equal(rollup.maintenance.api.repositories_evaluated, 8);
  assert.equal(rollup.maintenance.api.complete, true);
  assert.equal(rollup.maintenance.api.requests_per_evaluated_repository, 5.25);
  assert.ok(rollup.maintenance.api.cache_hit_rate > 0);
  assert.ok(rollup.maintenance.api.not_modified_rate > 0);
  assert.equal(rollup.maintenance.ci.workflow_runs, 1);
  assert.equal(rollup.maintenance.ci.workflow_elapsed_ms, 150000);
  assert.equal(rollup.maintenance.ci.job_elapsed_ms, 150000);
  assert.equal(rollup.maintenance.ci.failed_runs, 0);
  assert.equal(rollup.maintenance.ci.job_elapsed_ms, 150000);
  assert.ok(Number.isFinite(rollup.local_computing.energy.estimated_wh));
  assert.ok(!Object.keys(rollup.maintenance.api).includes('energy_wh'));
});

test('public Markdown and CSV exports state units and never present a sustainability score', () => {
  const rollup = buildResourceRollup({ events, tasks });
  const markdown = renderResourceMarkdown(rollup);
  assert.match(markdown, /No single sustainability score is calculated/i);
  assert.match(markdown, /Wh/);
  assert.match(markdown, /gCO2e/);
  assert.match(markdown, /Partial coverage/i);
  assert.match(markdown, /—/);
  const csv = renderResourceCsv(rollup);
  assert.match(csv, /^section,metric,unit,value,coverage/m);
  assert.match(csv, /remote_ai,requests,count,2/);
});

test('report writing produces JSON, Markdown and CSV without absolute paths', () => {
  const rollup = buildResourceRollup({ events, tasks });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tmr-rollup-'));
  const files = writeResourceReports(rollup, { outDir: out });
  assert.equal(files.length, 3);
  const json = fs.readFileSync(path.join(out, 'resource-rollup.public.json'), 'utf8');
  assert.equal(JSON.parse(json).schema_version, '1.0.0');
  assert.doesNotMatch(json, /\/Users\/|\/tmp\//);
  assert.ok(fs.existsSync(path.join(out, 'RESOURCE-SUMMARY.md')));
  assert.ok(fs.existsSync(path.join(out, 'resource-summary.csv')));
});

test('a rollup containing a private path or repository name is rejected before writing', () => {
  const leaky = makeEvent({
    event_type: 'ai-request',
    project: 'example/private-repo',
    model: 'safe-model',
    measurements: {
      energy: {
        source: 'cleer',
        source_version: '/Users/alice/secret',
        coverage: 'complete',
        mean_wh: 1,
        estimated_wh: 1,
        basis: 'estimated',
        dataset: { name: 'cleer', version: '/Users/alice/secret', checksum: null, license: 'synthetic', methodology_version: 'synthetic' },
      },
    },
  });
  assert.throws(() => buildResourceRollup({ events: [leaky], tasks: [] }), /not publishable|private path/);
});
