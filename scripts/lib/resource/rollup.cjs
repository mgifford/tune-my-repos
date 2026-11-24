/**
 * Deterministic aggregation of local resource evidence into a sanitized
 * public rollup. Aggregate-only: no project names, task labels, commands,
 * paths, session ids, prompts or private maintenance findings are emitted.
 *
 * CLEER and EcoLogits estimates remain separate. No single sustainability
 * score is calculated, and no baseline energy is silently subtracted.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ensureDir } = require('./paths.cjs');
const { aggregateInferenceEstimates } = require('./ai.cjs');
const { assertPublicResource } = require('../../../policy/resource-redaction.cjs');
const { validatePolicySchema } = require('../../../policy/policy-validator.cjs');
const { iso } = require('./event.cjs');

const SCHEMA_PATH = path.join(__dirname, '..', '..', '..', 'policy', 'resource-rollup.schema.json');
let cachedSchema = null;
function schema() {
  if (!cachedSchema) cachedSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return cachedSchema;
}

function isLocal(event) {
  // GitHub API calls and hosted Actions runs are not local computing, and
  // remote AI inference has its own section. Only process/container/manual
  // measurements contribute to the local energy/CPU totals.
  return ['process', 'container', 'manual'].includes(event.event_type) && event.activity !== 'monitoring';
}

function isMonitoring(event) {
  return event.activity === 'monitoring' || event.event_type === 'monitoring';
}

function sum(values) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return numbers.length ? numbers.reduce((total, value) => total + value, 0) : null;
}

function max(values) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return numbers.length ? Math.max(...numbers) : null;
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length))].sort();
}

function coverageFor(events, getter = (event) => event.measurements.energy.coverage) {
  const values = events.map(getter).filter(Boolean);
  if (values.length === 0) return 'unavailable';
  if (values.every((value) => value === 'complete')) return 'complete';
  if (values.some((value) => value === 'complete' || value === 'partial')) return 'partial';
  return 'unavailable';
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const groupKey = key(item);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(item);
  }
  return groups;
}

function aggregateLocal(events) {
  const local = events.filter((event) => isLocal(event));
  const energyEvents = local.filter((event) => event.measurements.energy.coverage !== 'unavailable');
  const hardwareGroups = groupBy(local, (event) => {
    const e = event.environment || {};
    return `${e.cpu_model || 'unknown'}|${e.cpu_threads || ''}|${e.gpu_available === null || e.gpu_available === undefined ? 'unknown' : e.gpu_available}`;
  });
  return {
    events: local.length,
    wall_ms: sum(local.map((event) => event.duration_ms)),
    cpu_seconds: sum(local.map((event) => event.measurements.cpu.total_seconds)),
    peak_rss_bytes: max(local.map((event) => event.measurements.memory.peak_rss_bytes)),
    energy: {
      estimated_wh: sum(local.map((event) => event.measurements.energy.estimated_wh)),
      measured_wh: sum(local.map((event) => event.measurements.energy.measured_wh)),
      coverage: coverageFor(energyEvents),
      methods: unique(local.map((event) => event.measurements.energy.method)),
      boundaries: unique(local.map((event) => event.measurements.energy.boundary)),
    },
    emissions_gco2e: sum(local.map((event) => event.measurements.emissions.gco2e)),
    hardware: [...hardwareGroups.entries()].map(([key, group]) => {
      const first = group[0].environment || {};
      return {
        cpu_model: first.cpu_model || null,
        cpu_threads: first.cpu_threads || null,
        gpu_available: first.gpu_available ?? null,
        events: group.length,
      };
    }).sort((a, b) => `${a.cpu_model}|${a.cpu_threads}`.localeCompare(`${b.cpu_model}|${b.cpu_threads}`)),
  };
}

function aggregateRemoteAi(events) {
  const requests = events.filter((event) => event.event_type === 'ai-request' || event.event_type === 'ai-usage');
  const tokenFields = ['input_total', 'uncached_input', 'cache_creation', 'cache_read', 'output', 'reasoning', 'model_requests'];
  const tokens = Object.fromEntries(tokenFields.map((field) => [field, sum(requests.map((event) => event.measurements.tokens[field]))]));
  const estimates = requests.map((event) => ({
    ...event.measurements.energy,
    source: event.measurements.energy.source,
    source_version: event.measurements.energy.source_version,
    dataset: event.measurements.energy.dataset,
  }));
  const aggregated = aggregateInferenceEstimates(estimates);
  const byProvider = groupBy(requests, (event) => event.provider || 'unknown');
  const byModel = groupBy(requests, (event) => `${event.provider || 'unknown'}|${event.model || 'unknown'}`);
  const unsupported = new Map();
  for (const event of requests) {
    const energy = event.measurements.energy;
    if (energy.coverage !== 'unavailable') continue;
    const reason = (energy.notes || []).find((note) => note.startsWith('reason:') || note.startsWith('mapping:') || note.startsWith('cleer-')) || 'energy-unavailable';
    const key = `${event.model || 'unknown'}|${reason}`;
    unsupported.set(key, {
      model: event.model || null,
      requests: (unsupported.get(key)?.requests || 0) + 1,
      reason: reason.slice(0, 200),
    });
  }
  const currencies = unique(requests.map((event) => event.measurements.cost.currency));
  return {
    requests: requests.length,
    complete_estimates: requests.filter((event) => event.measurements.energy.coverage === 'complete').length,
    partial_estimates: requests.filter((event) => event.measurements.energy.coverage === 'partial').length,
    unavailable_estimates: requests.filter((event) => event.measurements.energy.coverage === 'unavailable').length,
    tokens,
    by_provider: [...byProvider.entries()].map(([provider, group]) => ({
      provider: provider === 'unknown' ? null : provider,
      requests: group.length,
      input_total: sum(group.map((event) => event.measurements.tokens.input_total)),
      output: sum(group.map((event) => event.measurements.tokens.output)),
    })).sort((a, b) => String(a.provider).localeCompare(String(b.provider))),
    by_model: [...byModel.entries()].map(([, group]) => {
      const first = group[0];
      const complete = group.filter((event) => event.measurements.energy.coverage === 'complete');
      const energyMeans = complete.map((event) => event.measurements.energy.mean_wh).filter((value) => value !== null);
      const energySds = complete.map((event) => event.measurements.energy.standard_deviation_wh).filter((value) => value !== null);
      return {
        provider: first.provider || null,
        model: first.model || null,
        requests: group.length,
        input_total: sum(group.map((event) => event.measurements.tokens.input_total)),
        output: sum(group.map((event) => event.measurements.tokens.output)),
        energy_mean_wh: energyMeans.length ? sum(energyMeans) : null,
        energy_standard_deviation_wh: energyMeans.length && energySds.length === energyMeans.length
          ? sum(energySds)
          : null,
        coverage: coverageFor(group),
        methodology: first.measurements.energy.dataset?.methodology_version || null,
      };
    }).sort((a, b) => `${a.provider}|${a.model}`.localeCompare(`${b.provider}|${b.model}`)),
    energy_by_methodology: aggregated.by_dataset.map((group) => ({
      source: group.source,
      dataset_version: group.dataset_version,
      methodology_version: group.methodology_version,
      boundary: group.boundary,
      requests: group.requests,
      mean_wh: group.mean_wh,
      standard_deviation_wh: group.standard_deviation_wh,
      coverage: group.complete_requests > 0 ? (group.partial_requests > 0 ? 'partial' : 'complete') : (group.partial_requests > 0 ? 'partial' : 'unavailable'),
    })),
    cost: {
      reported_usd: sum(requests.filter((event) => event.measurements.cost.currency === 'USD').map((event) => event.measurements.cost.reported_usd)),
      estimated_usd: sum(requests.filter((event) => event.measurements.cost.currency === 'USD').map((event) => event.measurements.cost.estimated_usd)),
      currency: currencies.length === 0 ? null : (currencies.length === 1 && currencies[0] === 'USD' ? 'USD' : null),
    },
    unsupported_models: [...unsupported.values()].sort((a, b) => `${a.model}|${a.reason}`.localeCompare(`${b.model}|${b.reason}`)),
    _mixed_currencies: currencies.length > 1 || (currencies.length === 1 && currencies[0] !== 'USD'),
    _mixing_rule: aggregated.mixing_rule,
    _total_across_datasets: aggregated.total_across_datasets,
  };
}

function aggregateActivity(events) {
  const groups = groupBy(events.filter((event) => isLocal(event)), (event) => event.activity);
  return [...groups.entries()].map(([activity, group]) => ({
    activity,
    events: group.length,
    wall_ms: sum(group.map((event) => event.duration_ms)),
    cpu_seconds: sum(group.map((event) => event.measurements.cpu.total_seconds)),
    estimated_wh: sum(group.map((event) => event.measurements.energy.estimated_wh)),
    emissions_gco2e: sum(group.map((event) => event.measurements.emissions.gco2e)),
    coverage: coverageFor(group.filter((event) => event.measurements.energy.coverage !== 'unavailable')),
  })).sort((a, b) => a.activity.localeCompare(b.activity));
}

function aggregateGithubApi(events) {
  const apiEvents = events.filter((event) => event.measurements.github_api);
  if (apiEvents.length === 0) return null;
  const get = (field) => sum(apiEvents.map((event) => event.measurements.github_api[field]));
  const requests = get('requests');
  const evaluated = get('repositories_evaluated');
  const hits = get('cache_hits');
  const misses = get('cache_misses');
  const completed = apiEvents.map((event) => event.measurements.github_api.complete).filter((value) => typeof value === 'boolean');
  return {
    requests,
    status_200: get('status_200'),
    status_304: get('status_304'),
    failed: get('failed'),
    cache_hits: hits,
    cache_misses: misses,
    repositories_evaluated: evaluated,
    repositories_skipped: get('repositories_skipped'),
    carried_forward: get('carried_forward'),
    security_checks: get('security_checks'),
    complete: completed.length === 0 ? null : completed.every(Boolean),
    requests_per_evaluated_repository: requests !== null && evaluated ? requests / evaluated : null,
    cache_hit_rate: hits !== null && misses !== null && hits + misses > 0 ? hits / (hits + misses) : null,
    not_modified_rate: requests !== null && requests > 0 ? (get('status_304') || 0) / requests : null,
  };
}

function aggregateGithubActions(events) {
  const ci = events.filter((event) => event.event_type === 'github-actions' || event.measurements.github.run_id);
  if (ci.length === 0) return null;
  const workflowEvents = ci.filter((event) => event.event_type === 'github-actions');
  const jobDurations = ci
    .map((event) => (typeof event.measurements.github.job_elapsed_ms === 'number'
      ? event.measurements.github.job_elapsed_ms
      : event.duration_ms))
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  return {
    workflow_runs: ci.length,
    workflow_elapsed_ms: sum(workflowEvents.map((event) => event.duration_ms)),
    job_elapsed_ms: jobDurations.length ? jobDurations.reduce((total, value) => total + value, 0) : null,
    failed_runs: ci.filter((event) => event.outcome === 'failure' || event.measurements.github.conclusion === 'failure').length,
    retried_runs: ci.filter((event) => (event.measurements.github.attempt || 1) > 1).length,
    cancelled_runs: ci.filter((event) => event.outcome === 'cancelled' || event.measurements.github.conclusion === 'cancelled').length,
    potentially_superseded_runs: ci.filter((event) => event.measurements.github.potentially_superseded === true).length,
  };
}

function measurementQuality(events) {
  return {
    measured: events.filter((event) => event.source.confidence === 'measured').length,
    provider_reported: events.filter((event) => event.source.confidence === 'provider-reported').length,
    derived: events.filter((event) => event.source.confidence === 'derived').length,
    estimated: events.filter((event) => event.source.confidence === 'estimated').length,
    partial: events.filter((event) => event.quality.completeness === 'partial').length,
    unavailable: events.filter((event) => event.source.confidence === 'unavailable').length,
  };
}

function functionalUnits({ events, tasks, api }) {
  const eventById = new Map(events.map((event) => [event.event_id, event]));
  const verifiedTasks = tasks.filter((task) => task.state === 'completed_verified');
  const verifiedEnergyEvents = verifiedTasks
    .flatMap((task) => (task.resource_event_ids || []).map((id) => eventById.get(id)))
    .filter((event) => event && event.measurements.energy.coverage !== 'unavailable');
  const verifiedWh = sum(verifiedEnergyEvents.map((event) => event.measurements.energy.estimated_wh ?? event.measurements.energy.measured_wh));
  const verifiedCoverage = coverageFor(verifiedEnergyEvents);
  const units = [];
  if (verifiedTasks.length > 0 && verifiedWh !== null) {
    units.push({
      unit: 'per_verified_task',
      label: 'Wh per verified maintenance task',
      value_wh: verifiedWh / verifiedTasks.length,
      denominator: verifiedTasks.length,
      coverage: verifiedCoverage,
      reason: verifiedCoverage === 'partial'
        ? 'Partial coverage: some energy components or hardware are unavailable.'
        : 'Energy is summed only from events associated with verified tasks.',
    });
  } else {
    units.push({
      unit: 'per_verified_task',
      label: 'Wh per verified maintenance task',
      value_wh: null,
      denominator: verifiedTasks.length,
      coverage: 'unavailable',
      reason: verifiedTasks.length === 0
        ? 'No verified tasks in this ledger.'
        : 'No verified task has an associated energy event.',
    });
  }
  const evaluated = api?.repositories_evaluated ?? null;
  const inventoryEvents = events.filter((event) => isLocal(event)
    && ['repository-inventory', 'incremental-inventory'].includes(event.activity)
    && event.measurements.energy.coverage !== 'unavailable');
  const inventoryWh = sum(inventoryEvents.map((event) => event.measurements.energy.estimated_wh ?? event.measurements.energy.measured_wh));
  if (evaluated && inventoryWh !== null) {
    units.push({
      unit: 'per_evaluated_repository',
      label: 'Wh per repository evaluated',
      value_wh: inventoryWh / evaluated,
      denominator: evaluated,
      coverage: coverageFor(inventoryEvents),
      reason: 'Numerator is energy for inventory activities in this window, not benchmark or test energy.',
    });
  } else {
    units.push({
      unit: 'per_evaluated_repository',
      label: 'Wh per repository evaluated',
      value_wh: null,
      denominator: evaluated,
      coverage: 'unavailable',
      reason: evaluated
        ? 'API evidence exists, but there is no local energy measurement for inventory activity; request counts are not converted into energy.'
        : 'No GitHub API inventory evidence with an evaluated-repository denominator.',
    });
  }
  return units;
}

function buildResourceRollup({ events = [], tasks = [], generatedAt = iso(), ledgerBytes = 0, rawBytes = 0 } = {}) {
  const deduped = [...new Map(events.map((event) => [event.event_id, event])).values()]
    .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)) || a.event_id.localeCompare(b.event_id));
  const local = aggregateLocal(deduped);
  const remote = aggregateRemoteAi(deduped);
  const api = aggregateGithubApi(deduped);
  const ci = aggregateGithubActions(deduped);
  const monitoringEvents = deduped.filter((event) => isMonitoring(event));
  const projectCount = new Set(deduped.map((event) => event.project)).size;
  const taskCount = new Set([
    ...tasks.map((task) => task.task_id),
    ...deduped.filter((event) => !isMonitoring(event)).map((event) => event.task.id),
  ]).size;
  const limitations = [
    'Local energy from CodeCarbon is modelled, not directly measured; on the Apple Silicon baseline CPU energy is load-based, RAM energy is modelled and GPU telemetry is unavailable.',
    'Remote inference energy is available only for models with a local per-token factor dataset. The current public CLEER release publishes per-session energy, not per-token coefficients, so request-level CLEER estimates are unavailable.',
    'CLEER and EcoLogits estimates are never added together or averaged into a new estimate.',
    'Operational carbon emissions use a regional annual average intensity and do not include embodied or construction emissions unless explicitly labelled.',
    'A partial energy estimate is not total inference or workflow energy. Coverage is shown next to every total.',
    'No single sustainability score is calculated, and no baseline energy is subtracted automatically.',
  ];
  if (remote._mixed_currencies) limitations.push('Financial costs in more than one currency were not combined.');

  const rollup = {
    schema_version: '1.0.0',
    generated_at: generatedAt,
    window: {
      start: deduped.length ? deduped[0].occurred_at : null,
      end: deduped.length ? deduped[deduped.length - 1].occurred_at : null,
    },
    event_count: deduped.length,
    project_count: projectCount,
    task_count: taskCount,
    local_computing: local,
    remote_ai: {
      requests: remote.requests,
      complete_estimates: remote.complete_estimates,
      partial_estimates: remote.partial_estimates,
      unavailable_estimates: remote.unavailable_estimates,
      tokens: remote.tokens,
      by_provider: remote.by_provider,
      by_model: remote.by_model,
      energy_by_methodology: remote.energy_by_methodology,
      cost: remote.cost,
      unsupported_models: remote.unsupported_models,
    },
    maintenance: {
      by_activity: aggregateActivity(deduped),
      verified_tasks: tasks.filter((task) => task.state === 'completed_verified').length,
      unverified_tasks: tasks.filter((task) => ['completed_unverified', 'in_progress', 'planned', 'blocked', 'paused', 'unknown'].includes(task.state)).length,
      failed_tasks: tasks.filter((task) => task.state === 'failed').length,
      api,
      ci,
    },
    measurement_quality: measurementQuality(deduped),
    functional_units: functionalUnits({ events: deduped, tasks, api }),
    monitoring: {
      events: monitoringEvents.length,
      duration_ms: sum(monitoringEvents.map((event) => event.duration_ms)),
      cpu_seconds: sum(monitoringEvents.map((event) => event.measurements.cpu.total_seconds)),
      estimated_wh: sum(monitoringEvents.map((event) => event.measurements.energy.estimated_wh)),
      ledger_bytes: ledgerBytes,
      raw_bytes: rawBytes,
    },
    limitations,
  };
  const problems = validatePolicySchema(rollup, schema());
  if (problems.length) throw new Error(`resource rollup is invalid:\n  ${problems.slice(0, 15).join('\n  ')}`);
  assertPublicResource(rollup, 'public resource rollup');
  return rollup;
}

function fmt(value, digits = 4) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  if (Math.abs(value) < 1e-4) return value.toExponential(3);
  if (digits === 0) return String(Math.round(value));
  return value.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function renderResourceMarkdown(rollup) {
  const lines = [];
  lines.push('# Resource accounting summary');
  lines.push('');
  lines.push(`Generated: ${rollup.generated_at}`);
  lines.push('');
  lines.push(`Events: ${rollup.event_count}. Projects: ${rollup.project_count}. Tasks: ${rollup.task_count}.`);
  lines.push('');
  lines.push('No single sustainability score is calculated. Units are Wh for energy, W for power, gCO2e for operational emissions, CPU-seconds for CPU time and bytes for memory. Missing values are “—”, not zero.');
  lines.push('');
  lines.push('## Local computing');
  lines.push('');
  lines.push('| Metric | Value | Coverage |');
  lines.push('| --- | --- | --- |');
  lines.push(`| Wall clock | ${fmt(rollup.local_computing.wall_ms, 0)} ms | — |`);
  lines.push(`| CPU time | ${fmt(rollup.local_computing.cpu_seconds, 3)} CPU-seconds | — |`);
  lines.push(`| Peak RSS | ${rollup.local_computing.peak_rss_bytes === null ? '—' : `${fmt(rollup.local_computing.peak_rss_bytes / 1048576, 1)} MiB`} | — |`);
  lines.push(`| Energy | ${fmt(rollup.local_computing.energy.estimated_wh ?? rollup.local_computing.energy.measured_wh, 6)} Wh | ${rollup.local_computing.energy.coverage} |`);
  lines.push(`| Operational emissions | ${fmt(rollup.local_computing.emissions_gco2e, 8)} gCO2e | ${rollup.local_computing.energy.coverage} |`);
  lines.push('');
  if (rollup.local_computing.energy.methods.length) {
    lines.push(`Methods: ${rollup.local_computing.energy.methods.join(', ')}. Boundaries: ${rollup.local_computing.energy.boundaries.join(', ')}.`);
    lines.push('');
  }
  lines.push('| Activity | Events | CPU-seconds | Energy (Wh) | Coverage |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  for (const row of rollup.maintenance.by_activity) {
    lines.push(`| ${row.activity} | ${row.events} | ${fmt(row.cpu_seconds, 3)} | ${fmt(row.estimated_wh, 6)} | ${row.coverage} |`);
  }
  lines.push('');
  lines.push('## Remote AI inference');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Requests | ${rollup.remote_ai.requests} |`);
  lines.push(`| Complete estimates | ${rollup.remote_ai.complete_estimates} |`);
  lines.push(`| Partial estimates | ${rollup.remote_ai.partial_estimates} |`);
  lines.push(`| Unavailable estimates | ${rollup.remote_ai.unavailable_estimates} |`);
  lines.push(`| Uncached input tokens | ${fmt(rollup.remote_ai.tokens.uncached_input, 0)} |`);
  lines.push(`| Cache creation tokens | ${fmt(rollup.remote_ai.tokens.cache_creation, 0)} |`);
  lines.push(`| Cache read tokens | ${fmt(rollup.remote_ai.tokens.cache_read, 0)} |`);
  lines.push(`| Output tokens | ${fmt(rollup.remote_ai.tokens.output, 0)} |`);
  lines.push(`| Reasoning tokens (not added to output) | ${fmt(rollup.remote_ai.tokens.reasoning, 0)} |`);
  lines.push('');
  if (rollup.remote_ai.by_model.length) {
    lines.push('| Provider | Model | Requests | Energy (Wh) | Coverage | Methodology |');
    lines.push('| --- | --- | ---: | ---: | --- | --- |');
    for (const row of rollup.remote_ai.by_model) {
      lines.push(`| ${row.provider ?? '—'} | ${row.model ?? '—'} | ${row.requests} | ${fmt(row.energy_mean_wh, 6)} | ${row.coverage} | ${row.methodology ?? '—'} |`);
    }
    lines.push('');
  }
  if (rollup.remote_ai.energy_by_methodology.length) {
    lines.push('| Source | Dataset | Boundary | Requests | Mean Wh | SD Wh | Coverage |');
    lines.push('| --- | --- | --- | ---: | ---: | ---: | --- |');
    for (const row of rollup.remote_ai.energy_by_methodology) {
      lines.push(`| ${row.source ?? '—'} | ${row.dataset_version ?? '—'} | ${row.boundary ?? '—'} | ${row.requests} | ${fmt(row.mean_wh, 6)} | ${fmt(row.standard_deviation_wh, 6)} | ${row.coverage} |`);
    }
    lines.push('');
  }
  if (rollup.remote_ai.unsupported_models.length) {
    lines.push('### Models without a usable factor');
    lines.push('');
    lines.push('| Model | Requests | Reason |');
    lines.push('| --- | ---: | --- |');
    for (const row of rollup.remote_ai.unsupported_models) {
      lines.push(`| ${row.model ?? '—'} | ${row.requests} | ${row.reason} |`);
    }
    lines.push('');
  }
  lines.push('## Maintenance and verification');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Verified tasks | ${rollup.maintenance.verified_tasks} |`);
  lines.push(`| Unverified or in-progress tasks | ${rollup.maintenance.unverified_tasks} |`);
  lines.push(`| Failed tasks | ${rollup.maintenance.failed_tasks} |`);
  lines.push(`| GitHub API requests | ${fmt(rollup.maintenance.api?.requests, 0)} |`);
  lines.push(`| Requests per evaluated repository | ${fmt(rollup.maintenance.api?.requests_per_evaluated_repository, 2)} |`);
  lines.push(`| HTTP 304 rate | ${rollup.maintenance.api?.not_modified_rate === null || rollup.maintenance.api?.not_modified_rate === undefined ? '—' : `${(rollup.maintenance.api.not_modified_rate * 100).toFixed(1)}%`} |`);
  lines.push(`| Cache hit rate | ${rollup.maintenance.api?.cache_hit_rate === null || rollup.maintenance.api?.cache_hit_rate === undefined ? '—' : `${(rollup.maintenance.api.cache_hit_rate * 100).toFixed(1)}%`} |`);
  lines.push(`| Repositories evaluated | ${fmt(rollup.maintenance.api?.repositories_evaluated, 0)} |`);
  lines.push(`| Inventory scan complete | ${rollup.maintenance.api?.complete === null || rollup.maintenance.api?.complete === undefined ? '—' : (rollup.maintenance.api.complete ? 'yes' : 'no')} |`);
  lines.push(`| Workflow runs | ${fmt(rollup.maintenance.ci?.workflow_runs, 0)} |`);
  lines.push(`| Workflow elapsed time | ${fmt(rollup.maintenance.ci?.workflow_elapsed_ms, 0)} ms |`);
  lines.push(`| Summed job execution time | ${fmt(rollup.maintenance.ci?.job_elapsed_ms, 0)} ms |`);
  lines.push('');
  lines.push('## Measurement quality');
  lines.push('');
  lines.push('| Quality class | Events |');
  lines.push('| --- | ---: |');
  lines.push(`| Measured | ${rollup.measurement_quality.measured} |`);
  lines.push(`| Provider-reported | ${rollup.measurement_quality.provider_reported} |`);
  lines.push(`| Derived | ${rollup.measurement_quality.derived} |`);
  lines.push(`| Estimated | ${rollup.measurement_quality.estimated} |`);
  lines.push(`| Partial | ${rollup.measurement_quality.partial} |`);
  lines.push(`| Unavailable | ${rollup.measurement_quality.unavailable} |`);
  lines.push('');
  lines.push('## Functional units');
  lines.push('');
  lines.push('| Unit | Value | Denominator | Coverage | Note |');
  lines.push('| --- | ---: | ---: | --- | --- |');
  for (const row of rollup.functional_units) {
    lines.push(`| ${row.label} | ${fmt(row.value_wh, 6)} | ${fmt(row.denominator, 0)} | ${row.coverage} | ${row.reason ?? '—'} |`);
  }
  lines.push('');
  lines.push('Absolute totals above remain the primary record. A ratio is not shown when its denominator or measurement coverage is insufficient.');
  lines.push('');
  lines.push('## Monitoring overhead');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Monitoring events | ${rollup.monitoring.events} |`);
  lines.push(`| Collection time | ${fmt(rollup.monitoring.duration_ms, 1)} ms |`);
  lines.push(`| Collector CPU time | ${fmt(rollup.monitoring.cpu_seconds, 3)} CPU-seconds |`);
  lines.push(`| Ledger size | ${rollup.monitoring.ledger_bytes} bytes |`);
  lines.push(`| Raw measurement size | ${rollup.monitoring.raw_bytes} bytes |`);
  lines.push('');
  lines.push('## Limitations');
  lines.push('');
  for (const limitation of rollup.limitations) lines.push(`- ${limitation}`);
  lines.push('');
  lines.push('Raw measurements and task records remain local and are not published by this report. See `docs/RESOURCE-PRIVACY.md`.');
  lines.push('');
  return lines.join('\n');
}

function renderResourceCsv(rollup) {
  const rows = [['section', 'metric', 'unit', 'value', 'coverage']];
  rows.push(['local', 'wall_clock', 'ms', rollup.local_computing.wall_ms ?? '', '']);
  rows.push(['local', 'cpu_time', 'CPU-seconds', rollup.local_computing.cpu_seconds ?? '', '']);
  rows.push(['local', 'peak_rss', 'bytes', rollup.local_computing.peak_rss_bytes ?? '', '']);
  rows.push(['local', 'energy', 'Wh', rollup.local_computing.energy.estimated_wh ?? rollup.local_computing.energy.measured_wh ?? '', rollup.local_computing.energy.coverage]);
  rows.push(['local', 'operational_emissions', 'gCO2e', rollup.local_computing.emissions_gco2e ?? '', rollup.local_computing.energy.coverage]);
  for (const row of rollup.maintenance.by_activity) {
    rows.push(['activity', row.activity, 'Wh', row.estimated_wh ?? '', row.coverage]);
  }
  rows.push(['remote_ai', 'requests', 'count', rollup.remote_ai.requests, '']);
  rows.push(['remote_ai', 'uncached_input_tokens', 'tokens', rollup.remote_ai.tokens.uncached_input ?? '', 'provider-reported where available']);
  rows.push(['remote_ai', 'output_tokens', 'tokens', rollup.remote_ai.tokens.output ?? '', 'provider-reported where available']);
  for (const row of rollup.remote_ai.energy_by_methodology) {
    rows.push(['remote_ai', `${row.source || 'unknown'}_${row.dataset_version || 'unknown'}`, 'Wh', row.mean_wh ?? '', row.coverage]);
  }
  rows.push(['maintenance', 'api_requests_per_evaluated_repository', 'requests/repository', rollup.maintenance.api?.requests_per_evaluated_repository ?? '', '']);
  rows.push(['maintenance', 'ci_workflow_elapsed', 'ms', rollup.maintenance.ci?.workflow_elapsed_ms ?? '', '']);
  rows.push(['maintenance', 'ci_job_elapsed', 'ms', rollup.maintenance.ci?.job_elapsed_ms ?? '', '']);
  rows.push(['monitoring', 'collection_time', 'ms', rollup.monitoring.duration_ms ?? '', '']);
  rows.push(['monitoring', 'ledger_size', 'bytes', rollup.monitoring.ledger_bytes, '']);
  return `${rows.map((row) => row.map((cell) => {
    const text = String(cell ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',')).join('\n')}\n`;
}

function writeResourceReports(rollup, { outDir, formats = ['json', 'md', 'csv'] } = {}) {
  ensureDir(outDir);
  const written = [];
  if (formats.includes('json')) {
    const file = path.join(outDir, 'resource-rollup.public.json');
    fs.writeFileSync(file, `${JSON.stringify(rollup, null, 2)}\n`, { mode: 0o600 });
    written.push(file);
  }
  if (formats.includes('md')) {
    const file = path.join(outDir, 'RESOURCE-SUMMARY.md');
    fs.writeFileSync(file, renderResourceMarkdown(rollup), { mode: 0o600 });
    written.push(file);
  }
  if (formats.includes('csv')) {
    const file = path.join(outDir, 'resource-summary.csv');
    fs.writeFileSync(file, renderResourceCsv(rollup), { mode: 0o600 });
    written.push(file);
  }
  return written;
}

function validateResourceRollup(rollup) {
  return validatePolicySchema(rollup, schema());
}

module.exports = {
  SCHEMA_PATH,
  schema,
  buildResourceRollup,
  validateResourceRollup,
  renderResourceMarkdown,
  renderResourceCsv,
  writeResourceReports,
  aggregateLocal,
  aggregateRemoteAi,
  functionalUnits,
};
