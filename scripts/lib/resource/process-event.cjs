/**
 * Turn a measured command into one normalized process event.
 *
 * This module is deliberately pure apart from reading the measurement object.
 * It never invents a missing value: CodeCarbon's 0 W/0 Wh GPU fields become
 * null with `gpu_available: false`, water with WUE=0 becomes null, and energy
 * derived from a load model stays `estimated`, not `measured`.
 */

const { makeEvent, sha256 } = require('./event.cjs');

const VALIDATION_ACTIVITIES = new Set([
  'test-suite',
  'phpunit-execution',
  'playwright-testing',
  'validation',
  'accessibility-scanning',
  'accessibility-regression',
  'lighthouse-testing',
  'policy-evaluation',
]);

function taskKind(activity) {
  if (['test-suite', 'policy-evaluation', 'benchmark', 'resource-aggregation', 'static-dashboard-generation', 'noop'].includes(activity)) return 'tooling';
  if (['dependency-classification', 'repository-inventory', 'incremental-inventory', 'repository-configuration', 'security-alert-review'].includes(activity)) return 'maintenance';
  if (activity === 'ai-assisted-investigation') return 'investigation';
  if (activity === 'documentation-maintenance') return 'documentation';
  if (activity === 'accessibility-regression') return 'accessibility-evaluation';
  return 'maintenance';
}

function outcomeFor(measurement) {
  if (measurement.timed_out || measurement.signal || measurement.interrupted) return 'cancelled';
  if (measurement.status === 0) return 'success';
  if (measurement.status === null || measurement.status === undefined) return 'unknown';
  return 'failure';
}

function validationFor(activity, outcome) {
  if (!VALIDATION_ACTIVITIES.has(activity)) return 'not-run';
  if (outcome === 'success') return 'passed';
  if (outcome === 'failure') return 'failed';
  return 'unknown';
}

function gbToBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 1024 ** 3);
}

function energyFromCodeCarbon(codecarbon, { samplingIntervalMs, project }) {
  const requested = Boolean(codecarbon.requested);
  const parsed = codecarbon.parsed;
  if (!parsed) {
    return {
      energy: {
        boundary: 'unavailable',
        method: null,
        source: requested ? 'codecarbon' : null,
        source_version: requested ? (codecarbon.version || null) : null,
        measured_wh: null,
        estimated_wh: null,
        mean_wh: null,
        standard_deviation_wh: null,
        lower_wh: null,
        upper_wh: null,
        interval_method: null,
        basis: 'unavailable',
        coverage: 'unavailable',
        components: { cpu_wh: null, gpu_wh: null, ram_wh: null, accelerator_wh: null, host_wh: null, cooling_wh: null, idle_wh: null },
        source_values: [],
        hardware: {
          cpu_model: null, cpu_threads: null, gpu_model: null, gpu_available: null,
          ram_total_bytes: null, tracking_mode: null, country_iso_code: null,
          region: null, pue: null, wue: null,
        },
        dataset: requested ? { name: 'codecarbon', version: codecarbon.version || null, checksum: null, license: null, methodology_version: codecarbon.version || null } : { name: null, version: null, checksum: null, license: null, methodology_version: null },
        by_category: { uncached_input_wh: null, cached_input_wh: null, cache_creation_wh: null, output_wh: null },
        sensitivity: null,
        unestimated_categories: [],
        estimated_tokens: null,
        total_tokens: null,
        uncertainty_correlation: null,
        notes: [requested ? 'codecarbon-energy-unavailable' : 'energy-not-measured', ...(codecarbon.problems || [])],
      },
      emissions: null,
      warnings: requested ? ['codecarbon-energy-unavailable'] : [],
      missing: ['energy', 'emissions'],
    };
  }

  const n = parsed.normalized;
  const h = parsed.hardware;
  const warnings = parsed.warnings.map((warning) => warning.code);
  const notes = [
    'codecarbon-energy-is-modelled-not-directly-measured',
    'codecarbon-csv-does-not-expose-cpu-measurement-backend',
    ...(h.cpu_model && /Apple/i.test(h.cpu_model) ? ['cpu-load-based-estimate-apple-silicon'] : []),
    'ram-model-estimate',
    ...parsed.warnings.map((warning) => warning.message),
  ];
  if (h.gpu_available === false) {
    notes.push('gpu-not-detected-zero-is-not-a-measured-zero');
    warnings.push('gpu-unavailable');
  }
  if (n.duration_ms !== null && samplingIntervalMs && n.duration_ms < samplingIntervalMs * 3) {
    warnings.push('short-duration-relative-to-sampling-interval');
    notes.push(`measurement duration ${Math.round(n.duration_ms)} ms is less than three ${samplingIntervalMs} ms sampling intervals`);
  }
  if (n.energy_wh === null) warnings.push('energy-missing');
  if (n.emissions_gco2e === null) warnings.push('emissions-missing');

  const coverage = n.energy_wh === null
    ? 'unavailable'
    : (h.gpu_available === false || parsed.missing.length ? 'partial' : 'complete');
  const energy = {
    boundary: 'process-and-descendants',
    method: h.tracking_mode === 'process'
      ? 'codecarbon-process-energy-model'
      : 'codecarbon-machine-energy-model',
    source: 'codecarbon',
    source_version: h.codecarbon_version || codecarbon.version || null,
    measured_wh: null,
    estimated_wh: n.energy_wh,
    mean_wh: null,
    standard_deviation_wh: null,
    lower_wh: null,
    upper_wh: null,
    interval_method: null,
    basis: 'estimated',
    coverage,
    components: {
      cpu_wh: n.cpu_wh,
      gpu_wh: n.gpu_wh,
      ram_wh: n.ram_wh,
      accelerator_wh: null,
      host_wh: null,
      cooling_wh: null,
      idle_wh: null,
    },
    source_values: parsed.source_values,
    hardware: {
      cpu_model: h.cpu_model,
      cpu_threads: h.cpu_threads === null ? null : Math.round(h.cpu_threads),
      gpu_model: h.gpu_model,
      gpu_available: h.gpu_available,
      ram_total_bytes: gbToBytes(h.ram_total_gb),
      tracking_mode: h.tracking_mode,
      country_iso_code: h.country_iso_code,
      region: h.region,
      pue: n.pue,
      wue: n.wue,
    },
    dataset: {
      name: 'codecarbon',
      version: h.codecarbon_version || null,
      checksum: null,
      license: 'MIT',
      methodology_version: h.codecarbon_version || null,
    },
    by_category: { uncached_input_wh: null, cached_input_wh: null, cache_creation_wh: null, output_wh: null },
    sensitivity: null,
    unestimated_categories: [],
    estimated_tokens: null,
    total_tokens: null,
    uncertainty_correlation: null,
    notes,
  };

  const emissions = {
    boundary: 'operational-electricity',
    gco2e: n.emissions_gco2e,
    gco2e_per_kwh: n.carbon_intensity_g_per_kwh,
    carbon_intensity_source: h.country_iso_code && h.region
      ? `CodeCarbon ${h.codecarbon_version || ''} regional annual average (${h.country_iso_code}/${h.region}); dataset year ${h.codecarbon_version === '3.3.3' ? 2024 : 'unknown'}`.trim()
      : 'CodeCarbon regional annual average',
    carbon_intensity_year: h.codecarbon_version === '3.3.3' ? 2024 : null,
    uncertainty: 'annual-average grid intensity; no marginal or time matching; upstream energy is modelled',
    region: h.region,
    country_iso_code: h.country_iso_code,
    methodology: 'energy_kWh x regional_carbon_intensity_g_per_kWh',
    basis: 'estimated',
    coverage: n.emissions_gco2e === null ? 'unavailable' : 'partial',
    components: { operational_gco2e: n.emissions_gco2e, embodied_gco2e: null, construction_gco2e: null },
    source_values: [
      ...(n.emissions_gco2e === null ? [] : [{ field: 'emissions', value: n.emissions_gco2e, unit: 'gCO2e' }]),
      ...(n.emissions_rate_g_per_s === null ? [] : [{ field: 'emissions_rate', value: n.emissions_rate_g_per_s, unit: 'gCO2e/s' }]),
    ],
  };

  return { energy, emissions, warnings, missing: parsed.missing };
}

function createProcessEvent({
  measurement,
  activity = 'unknown',
  project = 'local/unfiled',
  commit = null,
  issue = null,
  pullRequest = null,
  variant = null,
  taskId = null,
  taskLabel = null,
  taskKind: explicitKind = null,
  deliverable = 'none',
  verification = null,
  samplingIntervalMs = null,
  overlap = false,
  concurrentMeasurements = 0,
  cacheState = null,
  repeats = 1,
  benchmark = null,
  baseline = null,
  commandLabel = null,
} = {}) {
  const outcome = outcomeFor(measurement);
  const cc = measurement.codecarbon || {};
  const parsed = cc.parsed ? energyFromCodeCarbon({
    parsed: cc.parsed,
    version: cc.parsed.hardware?.codecarbon_version || null,
    problems: cc.problems || [],
    requested: true,
  }, { samplingIntervalMs, project }) : energyFromCodeCarbon({
    parsed: null,
    version: null,
    problems: cc.problems || [],
    requested: Boolean(cc.requested),
  }, { samplingIntervalMs, project });

  const t = measurement.time || {};
  const cpuTotal = t.user_seconds === null || t.system_seconds === null
    ? null
    : t.user_seconds + t.system_seconds;
  const innerMs = t.wall_ms ?? measurement.inner_wall_ms ?? null;
  const cpuPercent = cpuTotal !== null && innerMs ? (cpuTotal / (innerMs / 1000)) * 100 : null;
  const cpuMeasurement = cpuTotal === null ? 'unavailable' : 'measured';
  const memoryMeasurement = t.max_rss_bytes === null ? 'unavailable' : 'measured';
  const hardware = parsed.energy.hardware;
  const energyCoverage = parsed.energy.coverage;
  const warnings = [...new Set([
    ...(parsed.warnings || []),
    ...(overlap ? ['measurement-overlapped-another-measurement'] : []),
    ...(measurement.interrupted ? ['measurement-interrupted-by-signal'] : []),
    ...(cc.requested && !cc.attempted ? ['codecarbon-requested-but-not-run'] : []),
    ...(cc.requested && cc.available === false ? ['codecarbon-unavailable'] : []),
    ...(cc.attempted && !cc.parsed ? ['codecarbon-produced-no-usable-row'] : []),
  ])];
  const missing = [...new Set([
    ...(parsed.missing || []),
    ...(energyCoverage === 'unavailable' ? ['energy'] : []),
    ...(parsed.emissions === null ? ['emissions'] : []),
    ...(cpuTotal === null ? ['cpu'] : []),
    ...(t.max_rss_bytes === null ? ['memory'] : []),
    ...(hardware.gpu_available === false ? ['gpu_energy'] : []),
    'tokens',
    'network',
    'cost',
  ])].sort();

  const completeness = cpuTotal !== null && t.max_rss_bytes !== null && energyCoverage !== 'unavailable'
    ? 'partial'
    : (cpuTotal !== null || t.max_rss_bytes !== null || energyCoverage !== 'unavailable' ? 'partial' : 'unavailable');

  const measuredTool = cc.requested && cc.attempted ? 'codecarbon' : 'node-time';
  const toolVersion = cc.requested && cc.attempted ? (hardware.codecarbon_version || null) : process.version;
  const taskKindValue = explicitKind || taskKind(activity);
  const commandHash = sha256(measurement.command.join('\0'));

  return makeEvent({
    measurement_id: measurement.measurement_id,
    event_type: 'process',
    occurred_at: measurement.started_at,
    duration_ms: innerMs ?? measurement.wall_ms,
    project,
    issue,
    variant,
    task: {
      id: taskId || `unfiled:${activity}`,
      label: taskLabel,
      execution_id: `run:${measurement.started_at}`,
      kind: taskKindValue,
      state: 'in_progress',
      expected_deliverable: deliverable,
      verified: false,
    },
    activity,
    tool: measuredTool,
    model: null,
    provider: null,
    environment: {
      os: `${process.platform} ${process.arch}`,
      node: process.version,
      runner: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
      ddev: null,
      docker: process.env.DOCKER_CONTAINER ? 'docker' : null,
      arch: process.arch,
      python: hardware.python_version || null,
      codecarbon: hardware.codecarbon_version || null,
      cpu_model: hardware.cpu_model || null,
      cpu_threads: hardware.cpu_threads === null ? null : Math.round(hardware.cpu_threads),
      ram_total_bytes: hardware.ram_total_bytes || null,
      gpu_model: hardware.gpu_model || null,
      gpu_available: hardware.gpu_available,
    },
    outcome,
    validation: validationFor(activity, outcome),
    commit,
    patch: null,
    source: {
      adapter: cc.requested && cc.attempted ? 'process-wrapper+codecarbon' : 'process-wrapper',
      method: cc.requested && cc.attempted
        ? '/usr/bin/time child accounting plus CodeCarbon offline energy model'
        : '/usr/bin/time child accounting',
      confidence: cc.requested && cc.attempted ? 'estimated' : (cpuMeasurement === 'measured' ? 'measured' : 'unavailable'),
      reference: null,
    },
    measurements: {
      tokens: {},
      cost: {},
      tools: {},
      context: {},
      latency: {},
      cpu: {
        user_seconds: t.user_seconds,
        system_seconds: t.system_seconds,
        total_seconds: cpuTotal,
        cpu_percent: cpuPercent === null ? null : Math.round(cpuPercent * 100) / 100,
        measurement: cpuMeasurement,
        source: t.format === 'none' ? null : '/usr/bin/time',
      },
      memory: {
        peak_rss_bytes: t.max_rss_bytes,
        measurement: memoryMeasurement,
      },
      io: {
        read_ops: t.read_ops,
        write_ops: t.write_ops,
        read_bytes: null,
        write_bytes: null,
        measurement: t.read_ops === null ? 'unavailable' : 'measured',
      },
      network: {},
      github: {},
      energy: parsed.energy,
      emissions: parsed.emissions || {},
      measurement: {
        id: measurement.measurement_id,
        tool: measuredTool,
        tool_version: toolVersion,
        exit_status: measurement.status,
        signal: measurement.signal,
        timed_out: Boolean(measurement.timed_out),
        wall_ms: measurement.wall_ms,
        inner_wall_ms: innerMs,
        overhead_ms: measurement.measurement_overhead_ms,
        sampling_interval_ms: cc.requested && cc.attempted ? samplingIntervalMs : null,
        lock_wait_ms: cc.lock_wait_ms,
        overlap,
        concurrent_measurements: concurrentMeasurements,
        cache_state: cacheState,
        repeats,
      },
      ...(benchmark ? { benchmark } : {}),
    },
    quality: {
      completeness,
      missing,
      notes: [
        ...(parsed.energy.notes || []),
        ...(parsed.emissions ? ['emissions-are-operational-electricity-only'] : []),
        ...(overlap ? ['overlapping-measurement-recorded-not-blocked'] : []),
        ...(cc.lock_wait_ms ? [`codecarbon-lock-waited-${cc.lock_wait_ms}ms`] : []),
      ],
      warnings,
    },
    private: {
      command_hash: commandHash,
      command_label: commandLabel || measurement.command.join(' ').slice(0, 300),
      exit_status: measurement.status,
      signal: measurement.signal,
      timed_out: Boolean(measurement.timed_out),
      raw_measurement_dir: measurement.measurement_id,
      verification: verification || null,
      codecarbon_problems: cc.problems || [],
      codecarbon_error: cc.error || null,
      baseline: baseline || null,
      repeats,
    },
  });
}

module.exports = {
  VALIDATION_ACTIVITIES,
  taskKind,
  outcomeFor,
  validationFor,
  energyFromCodeCarbon,
  createProcessEvent,
};
