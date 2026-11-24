/**
 * Normalized resource evidence events.
 *
 * Core terminology intentionally follows Drupal Core Lab's resource schema
 * (project, task, activity, tool, environment, outcome, validation, source,
 * measurements, quality). Tune My Repos adds energy, emissions, measurement,
 * benchmark, github_api and ai blocks. `toDrupalCoreLabEvent()` produces a
 * DCL-shaped event without the TMR-only measurement extensions; the energy
 * evidence is carried in DCL's `private` object rather than discarded.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { validatePolicySchema } = require('../../../policy/policy-validator.cjs');
const { publicProblems } = require('../../../policy/resource-redaction.cjs');

const SCHEMA_PATH = path.join(__dirname, '..', '..', '..', 'policy', 'resource-evidence.schema.json');
const SCHEMA_VERSION = '1.0.0';
let cachedSchema = null;

function schema() {
  if (!cachedSchema) cachedSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return cachedSchema;
}

function activities() {
  return schema().definitions.activity.enum;
}

const iso = (date = new Date()) => new Date(date).toISOString();
const day = (date) => iso(date).slice(0, 10);
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const sortObject = (value) => {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
  }
  return value;
};
const stableStringify = (value) => JSON.stringify(sortObject(value));
const safeText = (value, max = 300) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

function blankEnergy() {
  return {
    boundary: 'unavailable',
    method: null,
    source: null,
    source_version: null,
    measured_wh: null,
    estimated_wh: null,
    mean_wh: null,
    standard_deviation_wh: null,
    lower_wh: null,
    upper_wh: null,
    interval_method: null,
    basis: 'unavailable',
    coverage: 'unavailable',
    components: {
      cpu_wh: null,
      gpu_wh: null,
      ram_wh: null,
      accelerator_wh: null,
      host_wh: null,
      cooling_wh: null,
      idle_wh: null,
    },
    source_values: [],
    hardware: {
      cpu_model: null,
      cpu_threads: null,
      gpu_model: null,
      gpu_available: null,
      ram_total_bytes: null,
      tracking_mode: null,
      country_iso_code: null,
      region: null,
      pue: null,
      wue: null,
    },
    dataset: { name: null, version: null, checksum: null, license: null, methodology_version: null },
    by_category: { uncached_input_wh: null, cached_input_wh: null, cache_creation_wh: null, output_wh: null },
    sensitivity: null,
    unestimated_categories: [],
    estimated_tokens: null,
    total_tokens: null,
    uncertainty_correlation: null,
    notes: [],
  };
}

function blankEmissions() {
  return {
    boundary: 'unavailable',
    gco2e: null,
    gco2e_per_kwh: null,
    carbon_intensity_source: null,
    carbon_intensity_year: null,
    uncertainty: null,
    region: null,
    country_iso_code: null,
    methodology: null,
    basis: 'unavailable',
    coverage: 'unavailable',
    components: { operational_gco2e: null, embodied_gco2e: null, construction_gco2e: null },
    source_values: [],
  };
}

function blankMeasurement(id = null, tool = 'unknown') {
  return {
    id: id || 'unavailable',
    tool,
    tool_version: null,
    exit_status: null,
    signal: null,
    timed_out: false,
    wall_ms: null,
    inner_wall_ms: null,
    overhead_ms: null,
    sampling_interval_ms: null,
    lock_wait_ms: null,
    overlap: false,
    concurrent_measurements: 0,
    cache_state: null,
    repeats: 1,
  };
}

function blankMeasurements() {
  return {
    tokens: {
      input_total: null,
      uncached_input: null,
      cache_creation: null,
      cache_read: null,
      output: null,
      reasoning: null,
      reasoning_included_in_output: null,
      model_requests: null,
      token_basis: 'unavailable',
      provider_fields: {},
    },
    cost: { reported_usd: null, estimated_usd: null, basis: 'unavailable', note: null, currency: null },
    tools: { invocations: null, result_bytes: null, repeated_reads: null, errors: null },
    context: { start_tokens: null, average_tokens: null, growth_tokens: null },
    latency: { api_ms: null, tool_ms: null, time_to_first_token_ms: null, output_tokens_per_second: null },
    cpu: { user_seconds: null, system_seconds: null, total_seconds: null, cpu_percent: null, measurement: 'unavailable', source: null },
    memory: { peak_rss_bytes: null, peak_container_bytes: null, peak_php_mb: null, measurement: 'unavailable' },
    io: { read_ops: null, write_ops: null, read_bytes: null, write_bytes: null, measurement: 'unavailable' },
    network: { rx_bytes: null, tx_bytes: null, measurement: 'unavailable' },
    github: {
      workflow: null,
      job: null,
      event: null,
      runner: null,
      attempt: null,
      potentially_superseded: null,
      billable_minutes: null,
      queue_seconds: null,
      run_id: null,
      job_id: null,
      conclusion: null,
      started_at: null,
      completed_at: null,
      artifact_retention_days: null,
      cache_bytes: null,
    },
    energy: blankEnergy(),
    emissions: blankEmissions(),
    measurement: blankMeasurement(),
  };
}

function blankAi() {
  return {
    request_id: null,
    session_id_hash: null,
    requested_model: null,
    resolved_model: null,
    model_alias: null,
    streaming: null,
    reasoning: { enabled: null, effort: null, budget_tokens: null },
    retries: null,
    tool_invocations: null,
    tool_result_bytes: null,
    time_to_first_token_ms: null,
    output_tokens_per_second: null,
    context_window_utilization: null,
    modality: null,
    api_region: null,
    service_tier: null,
    batch: null,
    cache_lifetime: null,
    routing: null,
    outcome: 'unknown',
  };
}

const deepMerge = (base, update) => {
  if (update === undefined) return base;
  if (update === null || typeof update !== 'object' || Array.isArray(update)) return update;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(update)) out[key] = deepMerge(out[key], value);
  return out;
};

function eventId(event) {
  const material = {
    measurement_id: event.measurement_id,
    event_type: event.event_type,
    occurred_at: event.occurred_at,
    duration_ms: event.duration_ms,
    project: event.project,
    activity: event.activity,
    task: event.task?.id || null,
    commit: event.commit,
    model: event.model,
    provider: event.provider,
    source: event.source?.adapter || null,
    outcome: event.outcome,
    request_id: event.ai?.request_id || null,
    measurements: event.measurements,
  };
  return sha256(stableStringify(material));
}

function makeEvent(input = {}) {
  const measurements = deepMerge(blankMeasurements(), input.measurements || {});
  const event = {
    schema_version: SCHEMA_VERSION,
    measurement_id: input.measurement_id || crypto.randomUUID(),
    event_type: input.event_type || 'process',
    recorded_at: input.recorded_at || iso(),
    occurred_at: input.occurred_at || iso(),
    duration_ms: input.duration_ms ?? null,
    project: input.project || 'local/unfiled',
    issue: input.issue ?? null,
    variant: input.variant ?? null,
    task: {
      id: input.task?.id || 'unfiled',
      label: input.task?.label ?? null,
      execution_id: input.task?.execution_id ?? null,
      kind: input.task?.kind ?? null,
      state: input.task?.state ?? null,
      expected_deliverable: input.task?.expected_deliverable ?? null,
      verified: input.task?.verified ?? null,
    },
    activity: input.activity || 'unknown',
    tool: input.tool || 'unknown',
    model: input.model ?? null,
    provider: input.provider ?? null,
    environment: {
      os: input.environment?.os ?? `${process.platform} ${process.arch}`,
      node: input.environment?.node ?? process.version,
      runner: input.environment?.runner ?? 'local',
      ddev: input.environment?.ddev ?? null,
      docker: input.environment?.docker ?? null,
      arch: input.environment?.arch ?? process.arch,
      python: input.environment?.python ?? null,
      codecarbon: input.environment?.codecarbon ?? null,
      cpu_model: input.environment?.cpu_model ?? measurements.energy.hardware.cpu_model,
      cpu_threads: input.environment?.cpu_threads ?? measurements.energy.hardware.cpu_threads,
      ram_total_bytes: input.environment?.ram_total_bytes ?? measurements.energy.hardware.ram_total_bytes,
      gpu_model: input.environment?.gpu_model ?? measurements.energy.hardware.gpu_model,
      gpu_available: input.environment?.gpu_available ?? measurements.energy.hardware.gpu_available,
      container: input.environment?.container ?? null,
      virtualization: input.environment?.virtualization ?? null,
    },
    outcome: input.outcome || 'unknown',
    validation: input.validation || 'unknown',
    commit: input.commit ?? null,
    patch: input.patch ?? null,
    source: {
      adapter: input.source?.adapter || 'manual',
      method: input.source?.method || 'unknown',
      confidence: input.source?.confidence || 'unavailable',
      reference: input.source?.reference ?? null,
    },
    measurements,
    quality: {
      completeness: input.quality?.completeness || 'partial',
      missing: [...new Set(input.quality?.missing || [])].sort(),
      notes: (input.quality?.notes || []).map((note) => safeText(note, 500)),
      ...(input.quality?.warnings ? { warnings: [...new Set(input.quality.warnings)].sort() } : {}),
    },
  };
  if (input.ai) event.ai = deepMerge(blankAi(), input.ai);
  if (input.measurements?.benchmark) event.measurements.benchmark = input.measurements.benchmark;
  if (input.measurements?.github_api) event.measurements.github_api = input.measurements.github_api;
  if (input.source_key !== undefined) event.source_key = input.source_key;
  if (input.supersedes !== undefined) event.supersedes = input.supersedes;
  if (input.revision !== undefined) event.revision = input.revision;
  if (input.private && typeof input.private === 'object') event.private = input.private;
  event.event_id = input.event_id || eventId(event);
  return event;
}

function validateEvent(event) {
  return validatePolicySchema(event, schema());
}

function assertEvent(event) {
  const errors = validateEvent(event);
  if (errors.length) {
    throw new Error(`resource event is invalid:\n  ${errors.slice(0, 12).join('\n  ')}`);
  }
  return event;
}

function eventForValidation(input) {
  return makeEvent(input);
}

const DCL_ACTIVITY = {
  'test-suite': 'validation',
  noop: 'monitoring',
  'repository-inventory': 'infrastructure',
  'incremental-inventory': 'infrastructure',
  'dependency-classification': 'infrastructure',
  'policy-evaluation': 'infrastructure',
  'security-alert-review': 'issue-analysis',
  'dependabot-repair': 'patch-development',
  'documentation-maintenance': 'documentation-generation',
  'accessibility-regression': 'accessibility-scanning',
  'repository-configuration': 'infrastructure',
  'ai-assisted-investigation': 'issue-analysis',
  'static-dashboard-generation': 'documentation-generation',
  'resource-aggregation': 'resource-measurement',
  benchmark: 'resource-measurement',
  'github-api': 'infrastructure',
};

const DCL_TASK_STATE = {
  completed_unverified: 'completed_claimed',
  failed: 'completed_claimed',
  abandoned: 'abandoned',
};

function dclTaskKind(kind) {
  if (kind === 'resource-accounting' || kind === 'benchmark') return 'tooling';
  return kind;
}

/**
 * DCL-shaped export. DCL 1.0.0 has no energy/emissions fields, so those are
 * carried under `private.tmr_resource` (DCL allows arbitrary private data) and
 * are never published by DCL's public allowlist.
 */
function toDrupalCoreLabEvent(event) {
  const e = event;
  const m = e.measurements;
  const dclMeasurements = {
    tokens: {
      input_total: m.tokens.input_total,
      uncached_input: m.tokens.uncached_input,
      output: m.tokens.output,
      cache_creation: m.tokens.cache_creation,
      cache_read: m.tokens.cache_read,
      reasoning: m.tokens.reasoning,
      model_requests: m.tokens.model_requests,
      token_basis: m.tokens.token_basis,
    },
    cost: {
      reported_usd: m.cost.reported_usd,
      estimated_usd: m.cost.estimated_usd,
      basis: m.cost.basis,
      note: m.cost.note,
    },
    tools: { ...m.tools },
    context: { ...m.context },
    latency: { api_ms: m.latency.api_ms, tool_ms: m.latency.tool_ms },
    cpu: { ...m.cpu },
    memory: { ...m.memory },
    io: { ...m.io },
    network: { ...m.network },
    github: {
      workflow: m.github.workflow,
      job: m.github.job,
      event: m.github.event,
      runner: m.github.runner,
      attempt: m.github.attempt,
      potentially_superseded: m.github.potentially_superseded,
      billable_minutes: m.github.billable_minutes,
      queue_seconds: m.github.queue_seconds,
    },
  };
  return {
    schema_version: e.schema_version,
    event_id: e.event_id,
    event_type: e.event_type,
    recorded_at: e.recorded_at,
    occurred_at: e.occurred_at,
    duration_ms: e.duration_ms,
    project: e.project,
    issue: e.issue,
    variant: e.variant,
    task: {
      id: e.task.id,
      label: e.task.label,
      execution_id: e.task.execution_id,
      kind: dclTaskKind(e.task.kind),
      state: DCL_TASK_STATE[e.task.state] || e.task.state,
      expected_deliverable: e.task.expected_deliverable,
      verified: e.task.verified,
    },
    activity: DCL_ACTIVITY[e.activity] || e.activity,
    tool: e.tool,
    model: e.model,
    provider: e.provider,
    environment: {
      os: e.environment.os,
      node: e.environment.node,
      runner: e.environment.runner,
      ddev: e.environment.ddev,
      docker: e.environment.docker,
    },
    outcome: e.outcome,
    validation: e.validation,
    commit: e.commit,
    patch: e.patch,
    source: { ...e.source },
    measurements: dclMeasurements,
    quality: {
      completeness: e.quality.completeness,
      missing: e.quality.missing,
      notes: e.quality.notes,
    },
    private: {
      ...(e.private || {}),
      tmr_resource: {
        energy: e.measurements.energy,
        emissions: e.measurements.emissions,
        measurement: e.measurements.measurement,
        ai: e.ai || null,
        github_api: e.measurements.github_api || null,
      },
    },
  };
}

function publicEvent(event) {
  const e = event;
  const m = e.measurements;
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const short = (value, length = 16) => (value ? String(value).slice(0, length) : null);
  return {
    id: short(e.event_id),
    date: day(e.occurred_at),
    event_type: e.event_type,
    activity: e.activity,
    outcome: e.outcome,
    validation: e.validation,
    project_ref: sha256(e.project).slice(0, 12),
    task_ref: sha256(e.task.id).slice(0, 12),
    task_kind: e.task.kind,
    task_state: e.task.state,
    commit_short: short(e.commit, 7),
    provider: e.provider,
    model: e.model,
    source: { adapter: e.source.adapter, confidence: e.source.confidence },
    environment: {
      os: e.environment.os,
      node: e.environment.node,
      arch: e.environment.arch,
      cpu_model: e.environment.cpu_model,
      cpu_threads: e.environment.cpu_threads,
      gpu_available: e.environment.gpu_available,
      runner: e.environment.runner,
    },
    duration_seconds: num(e.duration_ms) === null ? null : Math.round(e.duration_ms / 100) / 10,
    tokens: {
      input_total: num(m.tokens.input_total),
      uncached_input: num(m.tokens.uncached_input),
      cache_creation: num(m.tokens.cache_creation),
      cache_read: num(m.tokens.cache_read),
      output: num(m.tokens.output),
      reasoning: num(m.tokens.reasoning),
      reasoning_included_in_output: m.tokens.reasoning_included_in_output,
      model_requests: num(m.tokens.model_requests),
      token_basis: m.tokens.token_basis,
    },
    cost: {
      reported_usd: num(m.cost.reported_usd),
      estimated_usd: num(m.cost.estimated_usd),
      basis: m.cost.basis,
      currency: m.cost.currency,
    },
    cpu: { total_seconds: num(m.cpu.total_seconds), measurement: m.cpu.measurement },
    memory: { peak_rss_bytes: num(m.memory.peak_rss_bytes), measurement: m.memory.measurement },
    energy: {
      boundary: m.energy.boundary,
      method: m.energy.method,
      source: m.energy.source,
      source_version: m.energy.source_version,
      measured_wh: num(m.energy.measured_wh),
      estimated_wh: num(m.energy.estimated_wh),
      mean_wh: num(m.energy.mean_wh),
      standard_deviation_wh: num(m.energy.standard_deviation_wh),
      lower_wh: num(m.energy.lower_wh),
      upper_wh: num(m.energy.upper_wh),
      interval_method: m.energy.interval_method,
      basis: m.energy.basis,
      coverage: m.energy.coverage,
      components: Object.fromEntries(Object.entries(m.energy.components).map(([k, v]) => [k, num(v)])),
      dataset: { ...m.energy.dataset },
      by_category: Object.fromEntries(Object.entries(m.energy.by_category || {}).map(([k, v]) => [k, num(v)])),
      sensitivity: m.energy.sensitivity ? {
        cache_creation_wh: num(m.energy.sensitivity.cache_creation_wh),
        method: m.energy.sensitivity.method,
        included_in_mean: m.energy.sensitivity.included_in_mean,
      } : null,
      unestimated_categories: m.energy.unestimated_categories,
      estimated_tokens: num(m.energy.estimated_tokens),
      total_tokens: num(m.energy.total_tokens),
      uncertainty_correlation: m.energy.uncertainty_correlation,
      hardware: {
        cpu_model: m.energy.hardware.cpu_model,
        cpu_threads: num(m.energy.hardware.cpu_threads),
        gpu_model: m.energy.hardware.gpu_model,
        gpu_available: m.energy.hardware.gpu_available,
        region: m.energy.hardware.region,
        country_iso_code: m.energy.hardware.country_iso_code,
      },
    },
    emissions: {
      boundary: m.emissions.boundary,
      gco2e: num(m.emissions.gco2e),
      gco2e_per_kwh: num(m.emissions.gco2e_per_kwh),
      carbon_intensity_year: num(m.emissions.carbon_intensity_year),
      uncertainty: m.emissions.uncertainty,
      basis: m.emissions.basis,
      coverage: m.emissions.coverage,
      region: m.emissions.region,
      country_iso_code: m.emissions.country_iso_code,
    },
    measurement: {
      tool: m.measurement.tool,
      tool_version: m.measurement.tool_version,
      exit_status: num(m.measurement.exit_status),
      timed_out: m.measurement.timed_out,
      overhead_ms: num(m.measurement.overhead_ms),
      sampling_interval_ms: num(m.measurement.sampling_interval_ms),
      overlap: m.measurement.overlap,
      concurrent_measurements: num(m.measurement.concurrent_measurements),
      cache_state: m.measurement.cache_state,
      repeats: num(m.measurement.repeats),
    },
    ...(e.ai ? {
      ai: {
        requested_model: e.ai.requested_model,
        resolved_model: e.ai.resolved_model,
        model_version: e.ai.model_version,
        model_alias: e.ai.model_alias,
        streaming: e.ai.streaming,
        retries: num(e.ai.retries),
        tool_invocations: num(e.ai.tool_invocations),
        time_to_first_token_ms: num(e.ai.time_to_first_token_ms),
        output_tokens_per_second: num(e.ai.output_tokens_per_second),
        modality: e.ai.modality,
        outcome: e.ai.outcome,
      },
    } : {}),
    ...(m.benchmark ? { benchmark: m.benchmark } : {}),
    ...(m.github_api ? { github_api: m.github_api } : {}),
    ...(m.github.workflow || m.github.run_id ? {
      github: {
        workflow: m.github.workflow,
        event: m.github.event,
        runner: m.github.runner,
        attempt: num(m.github.attempt),
        potentially_superseded: m.github.potentially_superseded,
        billable_minutes: num(m.github.billable_minutes),
      },
    } : {}),
    quality: {
      completeness: e.quality.completeness,
      missing: e.quality.missing,
      warnings: e.quality.warnings || [],
    },
  };
}

function assertPublicEvent(event) {
  const projected = publicEvent(event);
  const problems = publicProblems(projected);
  if (problems.length) throw new Error(`public event projection leaked data:\n  ${problems.join('\n  ')}`);
  return projected;
}

module.exports = {
  SCHEMA_PATH,
  SCHEMA_VERSION,
  schema,
  activities,
  iso,
  day,
  sha256,
  stableStringify,
  safeText,
  blankMeasurements,
  blankAi,
  makeEvent,
  eventId,
  validateEvent,
  assertEvent,
  eventForValidation,
  publicEvent,
  assertPublicEvent,
  toDrupalCoreLabEvent,
  DCL_ACTIVITY,
  DCL_TASK_STATE,
};
