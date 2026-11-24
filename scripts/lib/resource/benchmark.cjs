/**
 * Controlled, configurable micro-benchmarks.
 *
 * Only local processing workloads are in the registry. No workload makes
 * repeated GitHub API requests: the inventory benchmark exercises local
 * classification/redaction against committed fixtures. Whether an inventory
 * run used the live API is recorded separately by the inventory itself.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { REPO_ROOT, reportsRoot, ensureDir } = require('./paths.cjs');
const { measureCommand, projectInfo, nowIso } = require('./measure.cjs');
const { makeEvent, sha256 } = require('./event.cjs');
const { appendEvents, monitoringEvent } = require('./ledger.cjs');

const MAX_REPETITIONS = 20;

const WORKLOADS = Object.freeze({
  noop: {
    description: 'Process and measurement floor: node -e ""',
    command: [process.execPath, '-e', ''],
    fixtureOnly: true,
  },
  'test-suite': {
    description: 'The deterministic Node test suite (node --test)',
    command: [process.execPath, '--test'],
    fixtureOnly: true,
  },
  'policy-evaluation': {
    description: 'Classify committed maintenance PR fixtures through the policy engine, without network access',
    command: [process.execPath, 'scripts/lib/resource/bench-workload.cjs', 'policy-evaluation'],
    fixtureOnly: true,
  },
  'inventory-processing': {
    description: 'Validate and publicly redact a committed maintenance rollup fixture',
    command: [process.execPath, 'scripts/lib/resource/bench-workload.cjs', 'inventory-processing'],
    fixtureOnly: true,
  },
  'resource-aggregation': {
    description: 'Aggregate the committed synthetic resource ledger into a public rollup',
    command: [process.execPath, 'scripts/lib/resource/bench-workload.cjs', 'resource-aggregation'],
    fixtureOnly: true,
  },
  'dashboard-render': {
    description: 'Render the committed resource rollup fixture into accessible table markup',
    command: [process.execPath, 'scripts/lib/resource/bench-workload.cjs', 'dashboard-render'],
    fixtureOnly: true,
  },
  'inventory-live': {
    description: 'Refused: live GitHub inventory is not benchmarked to avoid unbounded API requests',
    command: null,
    fixtureOnly: false,
  },
});

function sortedNumbers(values) {
  return values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
}

function quantile(values, q) {
  const sorted = sortedNumbers(values);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  return sorted[base] + (sorted[base + 1] - sorted[base]) * rest;
}

function median(values) { return quantile(values, 0.5); }

function standardDeviation(values) {
  const numbers = sortedNumbers(values);
  if (numbers.length < 2) return null;
  const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  const variance = numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (numbers.length - 1);
  return Math.sqrt(variance);
}

function summary(values) {
  const numbers = sortedNumbers(values);
  return {
    n: numbers.length,
    median: median(numbers),
    minimum: numbers.length ? numbers[0] : null,
    maximum: numbers.length ? numbers[numbers.length - 1] : null,
    standard_deviation: standardDeviation(numbers),
    interquartile_range: numbers.length ? quantile(numbers, 0.75) - quantile(numbers, 0.25) : null,
  };
}

function benchmarkStatistics(repetitions) {
  const wall = repetitions.map((rep) => rep.wall_ms);
  const cpu = repetitions.map((rep) => rep.cpu_seconds);
  const rss = repetitions.map((rep) => rep.peak_rss_bytes);
  return {
    n: repetitions.length,
    median: summary(wall).median,
    minimum: summary(wall).minimum,
    maximum: summary(wall).maximum,
    standard_deviation: summary(wall).standard_deviation,
    interquartile_range: summary(wall).interquartile_range,
    wall_ms: summary(wall),
    cpu_seconds: summary(cpu),
    peak_rss_bytes: summary(rss),
  };
}

function repFromMeasurement(measurement, repetition, total) {
  const parsed = measurement.codecarbon?.parsed || null;
  const energyWh = parsed ? parsed.normalized.energy_wh : null;
  const emissions = parsed ? parsed.normalized.emissions_gco2e : null;
  const time = measurement.time || {};
  const cpuSeconds = time.user_seconds === null || time.system_seconds === null || time.user_seconds === undefined || time.system_seconds === undefined
    ? null
    : time.user_seconds + time.system_seconds;
  return {
    repetition,
    cache_state: repetition === 1 ? 'cold' : 'warm',
    wall_ms: measurement.inner_wall_ms ?? measurement.wall_ms ?? null,
    outer_wall_ms: measurement.wall_ms ?? null,
    cpu_seconds: cpuSeconds,
    peak_rss_bytes: time.max_rss_bytes ?? null,
    energy_wh: energyWh,
    emissions_gco2e: emissions,
    coverage: parsed ? (parsed.hardware.gpu_available === false || parsed.missing.length ? 'partial' : 'complete') : 'unavailable',
    measurement_overhead_ms: measurement.measurement_overhead_ms ?? null,
    codecarbon_attempted: Boolean(measurement.codecarbon?.attempted),
    codecarbon_error: measurement.codecarbon?.error || null,
    status: measurement.status,
    hardware: parsed?.hardware || null,
    sampling_interval_ms: measurement.codecarbon?.attempted ? (measurement.codecarbon.sampling_interval_ms || null) : null,
    total,
  };
}

async function runWorkload(workload, {
  repetitions = 3,
  codecarbon = false,
  codecarbonBin = process.env.CODECARBON_BIN || 'codecarbon',
  countryIsoCode = 'CAN',
  region = 'quebec',
  measurePowerSecs = 1,
  timeoutMs = null,
} = {}) {
  const definition = WORKLOADS[workload];
  if (!definition) throw new Error(`unknown benchmark workload "${workload}"`);
  if (!definition.command) throw new Error(definition.description);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > MAX_REPETITIONS) {
    throw new Error(`--repetitions must be an integer from 1 to ${MAX_REPETITIONS}`);
  }
  const runs = [];
  for (let index = 1; index <= repetitions; index += 1) {
    const measurement = await measureCommand({
      command: definition.command,
      cwd: REPO_ROOT,
      codecarbon,
      codecarbonBin,
      countryIsoCode,
      region,
      measurePowerSecs,
      timeoutMs,
      experimentName: `benchmark-${workload}`,
      cacheState: index === 1 ? 'cold' : 'warm',
    });
    measurement.codecarbon.sampling_interval_ms = codecarbon ? measurePowerSecs * 1000 : null;
    runs.push(repFromMeasurement(measurement, index, repetitions));
    if (measurement.status !== 0 && measurement.status !== null) {
      throw new Error(`benchmark workload "${workload}" exited ${measurement.status} on repetition ${index}`);
    }
  }
  return runs;
}

function energySummary(runs) {
  const values = runs.map((run) => run.energy_wh).filter((value) => value !== null);
  const emissions = runs.map((run) => run.emissions_gco2e).filter((value) => value !== null);
  return {
    available_runs: values.length,
    total_wh: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
    median_wh: median(values),
    total_gco2e: emissions.length ? emissions.reduce((sum, value) => sum + value, 0) : null,
    median_gco2e: median(emissions),
    coverage: values.length === 0
      ? 'unavailable'
      : (values.length === runs.length && runs.every((run) => run.coverage === 'complete') ? 'complete' : 'partial'),
  };
}

function systemHardware() {
  const cpus = os.cpus();
  return {
    cpu_model: cpus[0]?.model || null,
    cpu_threads: cpus.length || null,
    gpu_model: null,
    gpu_available: null,
    ram_total_gb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    codecarbon_version: null,
    tracking_mode: null,
    country_iso_code: null,
    region: null,
    pue: null,
    wue: null,
  };
}

function buildBenchmarkResult({ workload, runs, baselineRuns = null, baselineWorkload = null, info = null }) {
  const stats = benchmarkStatistics(runs);
  const baselineStats = baselineRuns ? benchmarkStatistics(baselineRuns) : null;
  return {
    schema_version: '1.0.0',
    generated_at: nowIso(),
    workload,
    description: WORKLOADS[workload]?.description || null,
    repetitions: runs.length,
    hardware: runs.find((run) => run.hardware)?.hardware || systemHardware(),
    git_revision: info?.commit || null,
    cold_warm: { cold_repetitions: 1, warm_repetitions: Math.max(0, runs.length - 1), note: 'Cold means the first repetition after this harness started; the OS page cache is not flushed.' },
    statistics: stats,
    energy: energySummary(runs),
    measurement_overhead_ms: summary(runs.map((run) => run.measurement_overhead_ms)),
    runs,
    baseline: baselineRuns ? {
      workload: baselineWorkload,
      statistics: baselineStats,
      energy: energySummary(baselineRuns),
      runs: baselineRuns,
      note: 'Reported separately. No idle or baseline energy is subtracted from the gross workload measurement.',
    } : null,
    limitations: [
      'A short workload is sensitive to process startup, sampling interval and background activity.',
      'CodeCarbon energy is modelled from load/model coefficients on this hardware, not directly measured.',
      'No statistical significance claim is made without an appropriate paired design and uncertainty analysis.',
      'Live GitHub API inventory is deliberately excluded from repeated benchmarks.',
    ],
  };
}

function benchmarkEvent(result, { project, codecarbon = false } = {}) {
  const runs = result.runs;
  const cpuSeconds = runs.map((run) => run.cpu_seconds).filter((value) => value !== null);
  const peakRss = runs.map((run) => run.peak_rss_bytes).filter((value) => value !== null);
  const wall = runs.map((run) => run.wall_ms).filter((value) => value !== null);
  const hardware = result.hardware || {};
  const energy = result.energy;
  return makeEvent({
    measurement_id: randomUUID(),
    event_type: 'process',
    occurred_at: new Date(Date.parse(result.generated_at) - (wall.reduce((sum, value) => sum + value, 0) || 0)).toISOString(),
    duration_ms: wall.reduce((sum, value) => sum + value, 0),
    project,
    task: {
      id: `benchmark:${result.workload}`,
      label: `Benchmark ${result.workload}`,
      execution_id: `benchmark:${result.generated_at}`,
      kind: 'benchmark',
      state: 'completed_unverified',
      expected_deliverable: 'benchmark-report',
      verified: false,
    },
    activity: 'benchmark',
    tool: codecarbon ? 'codecarbon+benchmark-harness' : 'benchmark-harness',
    outcome: 'success',
    validation: 'not-run',
    commit: result.git_revision,
    source: {
      adapter: 'benchmark-harness',
      method: codecarbon ? '/usr/bin/time plus CodeCarbon offline per repetition' : '/usr/bin/time per repetition',
      confidence: codecarbon ? 'estimated' : 'measured',
      reference: null,
    },
    environment: {
      os: `${process.platform} ${process.arch}`,
      node: process.version,
      runner: 'local',
      ddev: null,
      docker: null,
      arch: process.arch,
      codecarbon: hardware.codecarbon_version || null,
      cpu_model: hardware.cpu_model || null,
      cpu_threads: hardware.cpu_threads ? Math.round(hardware.cpu_threads) : null,
      ram_total_bytes: hardware.ram_total_gb ? Math.round(hardware.ram_total_gb * 1024 ** 3) : null,
      gpu_model: hardware.gpu_model || null,
      gpu_available: hardware.gpu_available ?? null,
    },
    measurements: {
      cpu: {
        total_seconds: cpuSeconds.length ? cpuSeconds.reduce((sum, value) => sum + value, 0) : null,
        measurement: cpuSeconds.length ? 'measured' : 'unavailable',
        source: '/usr/bin/time',
      },
      memory: {
        peak_rss_bytes: peakRss.length ? Math.max(...peakRss) : null,
        measurement: peakRss.length ? 'measured' : 'unavailable',
      },
      energy: {
        boundary: 'process-and-descendants',
        method: codecarbon ? 'codecarbon-process-energy-model' : null,
        source: codecarbon ? 'codecarbon' : null,
        source_version: hardware.codecarbon_version || null,
        measured_wh: null,
        estimated_wh: energy.total_wh,
        mean_wh: null,
        standard_deviation_wh: null,
        lower_wh: null,
        upper_wh: null,
        interval_method: null,
        basis: codecarbon && energy.total_wh !== null ? 'estimated' : 'unavailable',
        coverage: energy.coverage,
        components: {
          cpu_wh: null, gpu_wh: null, ram_wh: null,
          accelerator_wh: null, host_wh: null, cooling_wh: null, idle_wh: null,
        },
        source_values: [],
        hardware: {
          cpu_model: hardware.cpu_model || null,
          cpu_threads: hardware.cpu_threads ? Math.round(hardware.cpu_threads) : null,
          gpu_model: hardware.gpu_model || null,
          gpu_available: hardware.gpu_available ?? null,
          ram_total_bytes: hardware.ram_total_gb ? Math.round(hardware.ram_total_gb * 1024 ** 3) : null,
          tracking_mode: hardware.tracking_mode || null,
          country_iso_code: hardware.country_iso_code || null,
          region: hardware.region || null,
          pue: hardware.pue ?? null,
          wue: hardware.wue ?? null,
        },
        dataset: {
          name: codecarbon ? 'codecarbon' : null,
          version: hardware.codecarbon_version || null,
          checksum: null,
          license: codecarbon ? 'MIT' : null,
          methodology_version: hardware.codecarbon_version || null,
        },
        by_category: { uncached_input_wh: null, cached_input_wh: null, cache_creation_wh: null, output_wh: null },
        sensitivity: null,
        unestimated_categories: [],
        estimated_tokens: null,
        total_tokens: null,
        uncertainty_correlation: null,
        notes: ['benchmark-summary-event', 'baseline-not-subtracted'],
      },
      emissions: {
        boundary: codecarbon ? 'operational-electricity' : 'unavailable',
        gco2e: energy.total_gco2e,
        gco2e_per_kwh: null,
        carbon_intensity_source: codecarbon && hardware.region ? `CodeCarbon regional annual average (${hardware.country_iso_code}/${hardware.region})` : null,
        region: hardware.region || null,
        country_iso_code: hardware.country_iso_code || null,
        methodology: codecarbon ? 'reported by CodeCarbon per repetition, summed' : null,
        basis: codecarbon && energy.total_gco2e !== null ? 'estimated' : 'unavailable',
        coverage: energy.coverage,
        components: { operational_gco2e: energy.total_gco2e, embodied_gco2e: null, construction_gco2e: null },
        source_values: [],
      },
      measurement: {
        id: randomUUID(),
        tool: 'benchmark-harness',
        tool_version: null,
        exit_status: 0,
        signal: null,
        timed_out: false,
        wall_ms: wall.reduce((sum, value) => sum + value, 0),
        inner_wall_ms: wall.reduce((sum, value) => sum + value, 0),
        overhead_ms: result.measurement_overhead_ms.median,
        sampling_interval_ms: runs.find((run) => run.sampling_interval_ms)?.sampling_interval_ms || null,
        lock_wait_ms: null,
        overlap: false,
        concurrent_measurements: 0,
        cache_state: 'cold',
        repeats: result.repetitions,
      },
      benchmark: {
        workload: result.workload,
        repetition: 1,
        repetitions: result.repetitions,
        cache_state: 'cold',
        baseline: result.baseline?.workload || null,
        summary: true,
        runs: runs.map((run) => ({
          repetition: run.repetition,
          cache_state: run.cache_state,
          wall_ms: run.wall_ms,
          cpu_seconds: run.cpu_seconds,
          peak_rss_bytes: run.peak_rss_bytes,
          energy_wh: run.energy_wh,
          emissions_gco2e: run.emissions_gco2e,
          coverage: run.coverage,
        })),
        statistics: {
          n: result.statistics.n,
          median: result.statistics.median,
          minimum: result.statistics.minimum,
          maximum: result.statistics.maximum,
          standard_deviation: result.statistics.standard_deviation,
          interquartile_range: result.statistics.interquartile_range,
        },
      },
    },
    quality: {
      completeness: codecarbon ? 'partial' : 'partial',
      missing: ['tokens', 'network', 'cost', ...(codecarbon ? ['gpu_energy'] : ['energy', 'emissions'])],
      notes: ['Benchmark summary; per-repetition data is in the generated report.', 'Baseline measurements are reported separately, never subtracted automatically.'],
      warnings: codecarbon ? ['gpu-unavailable'] : [],
    },
    private: {
      command_label: WORKLOADS[result.workload]?.command?.join(' ') || null,
      command_hash: sha256((WORKLOADS[result.workload]?.command || []).join('\0')),
      baseline_workload: result.baseline?.workload || null,
    },
  });
}

function renderBenchmarkMarkdown(result) {
  const lines = [];
  lines.push(`# Resource benchmark: ${result.workload}`);
  lines.push('');
  lines.push(`Generated: ${result.generated_at}`);
  lines.push('');
  lines.push(result.description || '');
  lines.push('');
  lines.push('## Conditions');
  lines.push('');
  lines.push('| Condition | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Repetitions | ${result.repetitions} |`);
  lines.push(`| Cold/warm | 1 cold, ${Math.max(0, result.repetitions - 1)} warm (OS page cache not flushed) |`);
  lines.push(`| Operating system | ${process.platform} ${process.arch} |`);
  lines.push(`| Node.js | ${process.version} |`);
  lines.push(`| Git revision | ${result.git_revision || 'unavailable'} |`);
  if (result.hardware) {
    lines.push(`| CPU | ${result.hardware.cpu_model || 'unavailable'} (${result.hardware.cpu_threads || '?'} threads) |`);
    lines.push(`| GPU | ${result.hardware.gpu_available ? (result.hardware.gpu_model || 'reported') : 'unavailable'} |`);
    lines.push(`| RAM | ${result.hardware.ram_total_gb || '?'} GiB |`);
    lines.push(`| CodeCarbon | ${result.hardware.codecarbon_version || 'not used'} |`);
  }
  lines.push('');
  lines.push('## Wall clock');
  lines.push('');
  lines.push('| Metric | Milliseconds |');
  lines.push('| --- | --- |');
  for (const key of ['n', 'median', 'minimum', 'maximum', 'standard_deviation', 'interquartile_range']) {
    lines.push(`| ${key.replace(/_/g, ' ')} | ${result.statistics[key] === null ? '—' : Number(result.statistics[key]).toFixed(2)} |`);
  }
  lines.push('');
  lines.push('## CPU and memory');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| CPU seconds (median) | ${result.statistics.cpu_seconds.median === null ? '—' : result.statistics.cpu_seconds.median.toFixed(3)} |`);
  lines.push(`| Peak RSS (median) | ${result.statistics.peak_rss_bytes.median === null ? '—' : `${(result.statistics.peak_rss_bytes.median / 1048576).toFixed(1)} MiB`} |`);
  lines.push(`| Measurement overhead (median) | ${result.measurement_overhead_ms.median === null ? '—' : `${result.measurement_overhead_ms.median.toFixed(1)} ms`} |`);
  lines.push('');
  lines.push('## Energy and emissions');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Energy runs available | ${result.energy.available_runs} of ${result.repetitions} |`);
  lines.push(`| Total energy | ${result.energy.total_wh === null ? 'unavailable' : `${result.energy.total_wh.toFixed(6)} Wh`} |`);
  lines.push(`| Median energy per run | ${result.energy.median_wh === null ? 'unavailable' : `${result.energy.median_wh.toFixed(6)} Wh`} |`);
  lines.push(`| Total operational emissions | ${result.energy.total_gco2e === null ? 'unavailable' : `${result.energy.total_gco2e.toFixed(8)} gCO2e`} |`);
  lines.push(`| Coverage | ${result.energy.coverage} |`);
  lines.push('');
  if (result.baseline) {
    lines.push('## Baseline (reported separately)');
    lines.push('');
    lines.push(`Baseline workload: ${result.baseline.workload}. No baseline energy is subtracted from the gross result.`);
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('| --- | --- |');
    lines.push(`| Median wall clock | ${result.baseline.statistics.median === null ? '—' : `${result.baseline.statistics.median.toFixed(2)} ms`} |`);
    lines.push(`| Total energy | ${result.baseline.energy.total_wh === null ? 'unavailable' : `${result.baseline.energy.total_wh.toFixed(6)} Wh`} |`);
    lines.push('');
  }
  lines.push('## Limitations');
  lines.push('');
  for (const limitation of result.limitations) lines.push(`- ${limitation}`);
  lines.push('');
  lines.push('No sustainability score is calculated. This report is a local measurement record, not a compliance claim.');
  lines.push('');
  return lines.join('\n');
}

function writeBenchmarkReports(result, { outDir = path.join(reportsRoot(), 'benchmarks'), formats = ['json', 'md'] } = {}) {
  ensureDir(outDir);
  const stamp = result.generated_at.replace(/[:.]/g, '-');
  const base = path.join(outDir, `${stamp}-${result.workload}`);
  const written = [];
  if (formats.includes('json')) {
    const file = `${base}.json`;
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    written.push(file);
  }
  if (formats.includes('md')) {
    const file = `${base}.md`;
    fs.writeFileSync(file, renderBenchmarkMarkdown(result), { mode: 0o600 });
    written.push(file);
  }
  return written;
}

module.exports = {
  MAX_REPETITIONS,
  WORKLOADS,
  summary,
  median,
  quantile,
  standardDeviation,
  benchmarkStatistics,
  runWorkload,
  buildBenchmarkResult,
  benchmarkEvent,
  renderBenchmarkMarkdown,
  writeBenchmarkReports,
  energySummary,
  repFromMeasurement,
};
