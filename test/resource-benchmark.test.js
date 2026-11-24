const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  summary,
  median,
  quantile,
  standardDeviation,
  benchmarkStatistics,
  runWorkload,
  buildBenchmarkResult,
  benchmarkEvent,
  writeBenchmarkReports,
  WORKLOADS,
  MAX_REPETITIONS,
} = require('../scripts/lib/resource/benchmark.cjs');
const { validateEvent } = require('../scripts/lib/resource/event.cjs');

// The benchmark tests exercise the real measurement path; keep their raw
// files out of the developer's local resource cache.
process.env.RESOURCE_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tmr-benchmark-test-cache-'));

function fakeRun(repetition, wall, energy = null, cpu = 0.1) {
  return {
    repetition,
    cache_state: repetition === 1 ? 'cold' : 'warm',
    wall_ms: wall,
    cpu_seconds: cpu,
    peak_rss_bytes: 1024,
    energy_wh: energy,
    emissions_gco2e: energy === null ? null : energy * 2.6,
    coverage: energy === null ? 'unavailable' : 'partial',
    measurement_overhead_ms: 5,
    sampling_interval_ms: null,
    hardware: { cpu_model: 'Test CPU', cpu_threads: 8, gpu_available: false, ram_total_gb: 16, codecarbon_version: null },
  };
}

test('summary statistics are deterministic and handle small samples', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
  assert.equal(standardDeviation([2, 4]), Math.sqrt(2));
  const stats = summary([10, 20, 30, 40]);
  assert.equal(stats.n, 4);
  assert.equal(stats.median, 25);
  assert.equal(stats.minimum, 10);
  assert.equal(stats.maximum, 40);
  assert.equal(stats.interquartile_range, 15);
  assert.equal(summary([]).median, null);
});

test('benchmark result reports gross energy, baseline separately and no subtraction', () => {
  const runs = [fakeRun(1, 100, 0.01), fakeRun(2, 90, 0.009), fakeRun(3, 110, 0.011)];
  const baseline = [fakeRun(1, 10, 0.001), fakeRun(2, 10, 0.001)];
  const result = buildBenchmarkResult({ workload: 'noop', runs, baselineRuns: baseline, baselineWorkload: 'noop', info: { commit: 'abc' } });
  assert.equal(result.repetitions, 3);
  assert.equal(result.energy.coverage, 'partial');
  assert.ok(Math.abs(result.energy.total_wh - 0.03) < 1e-12);
  assert.equal(result.baseline.workload, 'noop');
  assert.ok(Math.abs(result.baseline.energy.total_wh - 0.002) < 1e-12);
  assert.match(result.baseline.note, /No idle or baseline energy is subtracted/);
  assert.equal(result.cold_warm.cold_repetitions, 1);
  assert.equal(result.runs[0].cache_state, 'cold');
  assert.equal(result.runs[1].cache_state, 'warm');
});

test('a benchmark summary event is schema-valid and records runs and statistics', () => {
  const runs = [fakeRun(1, 100, 0.01), fakeRun(2, 90, 0.009)];
  const result = buildBenchmarkResult({ workload: 'noop', runs });
  const event = benchmarkEvent(result, { project: 'example/public-repo', codecarbon: false });
  assert.deepEqual(validateEvent(event), []);
  assert.equal(event.activity, 'benchmark');
  assert.equal(event.measurements.benchmark.workload, 'noop');
  assert.equal(event.measurements.benchmark.summary, true);
  assert.equal(event.measurements.benchmark.runs.length, 2);
  assert.equal(event.measurements.energy.estimated_wh, 0.019);
  assert.equal(event.quality.completeness, 'partial');
});

test('the benchmark facility runs only local fixture workloads and refuses live inventory', async () => {
  assert.ok(WORKLOADS.noop);
  assert.ok(WORKLOADS['policy-evaluation']);
  assert.equal(WORKLOADS['inventory-live'].command, null);
  await assert.rejects(() => runWorkload('inventory-live', { repetitions: 1 }), /Refused/);
  for (const definition of Object.values(WORKLOADS)) {
    if (!definition.command) continue;
    assert.ok(!definition.command.join(' ').includes('generate-maintenance-rollup'), 'no live inventory benchmark');
  }
});

test('repetition counts are bounded', async () => {
  await assert.rejects(() => runWorkload('noop', { repetitions: 0 }), /1 to 20/);
  await assert.rejects(() => runWorkload('noop', { repetitions: MAX_REPETITIONS + 1 }), /1 to 20/);
});

test('a noop workload measures wall, CPU and memory and labels cold/warm runs', async () => {
  const runs = await runWorkload('noop', { repetitions: 2 });
  assert.equal(runs.length, 2);
  assert.equal(runs[0].cache_state, 'cold');
  assert.equal(runs[1].cache_state, 'warm');
  assert.ok(runs.every((run) => run.wall_ms !== null));
  assert.ok(runs.every((run) => run.cpu_seconds !== null));
  assert.ok(runs.every((run) => run.peak_rss_bytes > 0));
  assert.ok(runs.every((run) => run.energy_wh === null));
  const result = buildBenchmarkResult({ workload: 'noop', runs });
  assert.equal(result.energy.coverage, 'unavailable');
  assert.equal(result.statistics.n, 2);
  assert.ok(result.statistics.median > 0);
});

test('benchmark reports are written as JSON and Markdown with reproducible conditions', () => {
  const runs = [fakeRun(1, 100, 0.01)];
  const baseline = [fakeRun(1, 10, 0.001)];
  const result = buildBenchmarkResult({ workload: 'noop', runs, baselineRuns: baseline, baselineWorkload: 'noop', info: { commit: 'abc123' } });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tmr-benchmark-'));
  const files = writeBenchmarkReports(result, { outDir: out });
  assert.equal(files.length, 2);
  const json = JSON.parse(fs.readFileSync(files.find((file) => file.endsWith('.json')), 'utf8'));
  assert.equal(json.schema_version, '1.0.0');
  assert.equal(json.workload, 'noop');
  assert.equal(json.repetitions, 1);
  assert.equal(json.git_revision, 'abc123');
  const markdown = fs.readFileSync(files.find((file) => file.endsWith('.md')), 'utf8');
  assert.match(markdown, /Cold\/warm/);
  assert.match(markdown, /No sustainability score is calculated/);
  assert.match(markdown, /Baseline/);
});

test('benchmarkStatistics uses wall-clock values for its schema fields', () => {
  const stats = benchmarkStatistics([fakeRun(1, 100), fakeRun(2, 200)]);
  assert.equal(stats.n, 2);
  assert.equal(stats.median, 150);
  assert.equal(stats.minimum, 100);
  assert.equal(stats.maximum, 200);
});
