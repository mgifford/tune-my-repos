/**
 * Provider-neutral AI request telemetry and inference energy estimates.
 *
 * Token categories are normalized only when the provider's documented
 * semantics support the normalization. Raw provider fields are preserved.
 * Reasoning tokens are never added to output twice. A model without a
 * published factor is reported as unsupported; it is never substituted.
 *
 * The current public CLEER dataset publishes per-session energy, not per-token
 * coefficients. `estimateInferenceEnergy()` therefore returns `unavailable`
 * for a session-only dataset and names the missing evidence. It does not
 * divide session energy by an assumed token count.
 */

const { blankAi, makeEvent, sha256, iso } = require('./event.cjs');
const { finite } = require('./units.cjs');
const { matchModel } = require('./factors.cjs');

const PROVIDER_SEMANTICS_VERSION = '2026-11-24';

const PROVIDER_SEMANTICS = Object.freeze({
  anthropic: {
    version: PROVIDER_SEMANTICS_VERSION,
    source: 'https://docs.anthropic.com/en/api/messages',
    notes: [
      'input_tokens counts tokens that were neither read from nor used to create a cache.',
      'cache_creation_input_tokens and cache_read_input_tokens are separate additive categories.',
      'output_tokens includes any extended-thinking tokens; thinking is not reported as a separate count.',
    ],
  },
  openai: {
    version: PROVIDER_SEMANTICS_VERSION,
    source: 'https://platform.openai.com/docs/api-reference/chat/object',
    notes: [
      'prompt_tokens is the input total; prompt_tokens_details.cached_tokens is a subset of it.',
      'completion_tokens is the output total; completion_tokens_details.reasoning_tokens is a subset of it.',
      'Cache creation tokens are not reported by the Chat Completions usage object.',
    ],
  },
  generic: {
    version: PROVIDER_SEMANTICS_VERSION,
    source: null,
    notes: [
      'Canonical fields are accepted only when the client supplies them directly.',
      'No category is inferred from text length, billing cost, or another provider.',
    ],
  },
});

function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function numberOrNull(value) {
  const number = finite(value);
  return number === null || number < 0 ? null : number;
}

function addNote(notes, code) {
  if (!notes.includes(code)) notes.push(code);
}

function normalizeProviderUsage({ provider, shape = provider, usage = {} } = {}) {
  const p = String(provider || shape || 'generic').toLowerCase();
  const s = String(shape || p).toLowerCase();
  const u = usage && typeof usage === 'object' ? usage : {};
  const notes = [];
  const missing = [];
  const providerFields = { ...u };
  let tokens;

  if (p === 'anthropic' || s === 'anthropic') {
    const input = intOrNull(u.input_tokens);
    let cacheCreation = intOrNull(u.cache_creation_input_tokens);
    let cacheRead = intOrNull(u.cache_read_input_tokens);
    if (input !== null && cacheCreation === null) { cacheCreation = 0; addNote(notes, 'anthropic-absent-cache-creation-treated-as-zero'); }
    if (input !== null && cacheRead === null) { cacheRead = 0; addNote(notes, 'anthropic-absent-cache-read-treated-as-zero'); }
    const output = intOrNull(u.output_tokens);
    const inputTotal = input === null ? null : input + (cacheCreation || 0) + (cacheRead || 0);
    if (input === null) missing.push('tokens.input_total');
    if (output === null) missing.push('tokens.output');
    tokens = {
      input_total: inputTotal,
      uncached_input: input,
      cache_creation: cacheCreation,
      cache_read: cacheRead,
      output,
      reasoning: null,
      reasoning_included_in_output: null,
      model_requests: 1,
      token_basis: inputTotal !== null && output !== null ? 'provider-reported' : 'unavailable',
      provider_fields: providerFields,
    };
  } else if (p === 'openai' || s === 'openai') {
    const prompt = intOrNull(u.prompt_tokens);
    let cached = intOrNull(u.prompt_tokens_details?.cached_tokens);
    if (prompt !== null && cached === null) { cached = 0; addNote(notes, 'openai-absent-cached-tokens-treated-as-zero'); }
    const completion = intOrNull(u.completion_tokens);
    const reasoning = intOrNull(u.completion_tokens_details?.reasoning_tokens);
    if (prompt === null) missing.push('tokens.input_total');
    if (completion === null) missing.push('tokens.output');
    if (cached !== null && prompt !== null && cached > prompt) {
      addNote(notes, 'openai-cached-tokens-exceed-prompt-tokens');
      tokens = {
        input_total: prompt,
        uncached_input: null,
        cache_creation: null,
        cache_read: cached,
        output: completion,
        reasoning,
        reasoning_included_in_output: reasoning === null ? null : true,
        model_requests: 1,
        token_basis: 'unavailable',
        provider_fields: providerFields,
      };
      missing.push('tokens.uncached_input');
    } else {
      tokens = {
        input_total: prompt,
        uncached_input: prompt === null ? null : prompt - (cached || 0),
        cache_creation: null,
        cache_read: cached,
        output: completion,
        reasoning,
        reasoning_included_in_output: reasoning === null ? null : true,
        model_requests: 1,
        token_basis: prompt !== null && completion !== null ? 'provider-reported' : 'unavailable',
        provider_fields: providerFields,
      };
    }
    if (reasoning !== null) addNote(notes, 'openai-reasoning-included-in-output');
  } else {
    const inputTotal = intOrNull(u.input_total ?? u.input_tokens);
    const uncached = intOrNull(u.uncached_input);
    const cacheCreation = intOrNull(u.cache_creation);
    const cacheRead = intOrNull(u.cache_read ?? u.cached_input);
    const output = intOrNull(u.output ?? u.output_tokens);
    const reasoning = intOrNull(u.reasoning);
    const reasoningIncluded = typeof u.reasoning_included_in_output === 'boolean' ? u.reasoning_included_in_output : null;
    if (inputTotal === null && uncached === null) missing.push('tokens.input_total');
    if (output === null) missing.push('tokens.output');
    tokens = {
      input_total: inputTotal,
      uncached_input: uncached,
      cache_creation: cacheCreation,
      cache_read: cacheRead,
      output,
      reasoning,
      reasoning_included_in_output: reasoningIncluded,
      model_requests: 1,
      token_basis: (inputTotal !== null || uncached !== null) && output !== null ? 'provider-reported' : 'unavailable',
      provider_fields: providerFields,
    };
  }

  return { tokens, notes, missing };
}

function blankEnergyEstimate(reason, details = {}) {
  return {
    boundary: 'accelerator-inference',
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
      cpu_wh: null, gpu_wh: null, ram_wh: null,
      accelerator_wh: null, host_wh: null, cooling_wh: null, idle_wh: null,
    },
    source_values: [],
    hardware: {
      cpu_model: null, cpu_threads: null, gpu_model: null, gpu_available: null,
      ram_total_bytes: null, tracking_mode: null, country_iso_code: null,
      region: null, pue: null, wue: null,
    },
    dataset: { name: null, version: null, checksum: null, license: null, methodology_version: null },
    by_category: { uncached_input_wh: null, cached_input_wh: null, cache_creation_wh: null, output_wh: null },
    sensitivity: null,
    unestimated_categories: [],
    estimated_tokens: null,
    total_tokens: null,
    uncertainty_correlation: null,
    ...details,
    notes: [reason, ...(details.notes || [])],
  };
}

function datasetMetadata(dataset) {
  return {
    name: dataset?.dataset || null,
    version: dataset?.dataset_version || null,
    checksum: dataset?.checksum || null,
    license: dataset?.license || null,
    methodology_version: dataset?.methodology_version || null,
  };
}

/**
 * Estimate request-level accelerator energy from a per-token factor dataset.
 * `cacheCreationPolicy` is either "unavailable" (default) or
 * "sensitivity_as_uncached_input" (reported separately, never in the mean).
 */
function estimateInferenceEnergy({
  tokens,
  dataset = null,
  model = null,
  cacheCreationPolicy = 'unavailable',
  adapter = 'cleer',
} = {}) {
  if (!dataset) {
    return blankEnergyEstimate('no-local-factor-dataset', { notes: ['energy-unavailable'] });
  }
  const meta = datasetMetadata(dataset);
  if (dataset.dataset_kind !== 'per-token') {
    return blankEnergyEstimate('cleer-per-token-factors-not-published', {
      notes: [
        'session-only-dataset',
        'token-workloads-not-published',
        'request-level-energy-unavailable',
        ...(dataset.notes || []),
      ],
      dataset: meta,
      source: dataset.dataset || adapter,
      source_version: dataset.dataset_version || null,
      uncertainty_correlation: 'unavailable',
      unestimated_categories: ['uncached_input', 'cached_input', 'cache_creation', 'output'],
    });
  }
  const mapping = matchModel(dataset, model);
  if (!['exact', 'documented_alias', 'explicit_proxy'].includes(mapping.state)) {
    return blankEnergyEstimate(`model-mapping-${mapping.state}`, {
      notes: [
        `mapping:${mapping.state}`,
        `reason:${mapping.reason}`,
        ...(mapping.state === 'ambiguous' ? ['ambiguous-model-not-substituted'] : []),
        ...(mapping.state === 'unsupported' ? ['unsupported-model-energy-unavailable'] : []),
      ],
      dataset: meta,
      source: dataset.dataset || adapter,
      source_version: dataset.dataset_version || null,
      uncertainty_correlation: null,
      unestimated_categories: ['uncached_input', 'cached_input', 'cache_creation', 'output'],
    });
  }
  const factor = (dataset.models || []).find((entry) => entry.id === mapping.matched_id);
  if (!factor) {
    return blankEnergyEstimate('matched-model-has-no-factor-entry', { dataset: meta });
  }
  const categories = [
    { key: 'uncached_input', tokens: tokens.uncached_input, coefficient: factor.uncached_input },
    { key: 'cached_input', tokens: tokens.cache_read, coefficient: factor.cached_input },
    { key: 'cache_creation', tokens: tokens.cache_creation, coefficient: factor.cache_creation },
    { key: 'output', tokens: tokens.output, coefficient: factor.output },
  ];
  const components = { uncached_input_wh: null, cached_input_wh: null, cache_creation_wh: null, output_wh: null };
  const unestimated = [];
  const notes = [];
  let estimatedWh = 0;
  let estimatedTokens = 0;
  let totalTokens = 0;
  let variance = 0;
  let varianceAvailable = true;
  let anyEstimated = false;
  let sensitivityCacheCreationWh = null;

  for (const category of categories) {
    const count = intOrNull(category.tokens);
    if (count !== null) totalTokens += count;
    if (count === 0) {
      components[`${category.key}_wh`] = 0;
      continue;
    }
    if (count === null) {
      unestimated.push(category.key);
      addNote(notes, `unknown-token-count:${category.key}`);
      varianceAvailable = false;
      continue;
    }
    const mean = category.coefficient?.mean;
    if (mean === null || mean === undefined) {
      if (category.key === 'cache_creation') {
        addNote(notes, 'cache-creation-coefficient-not-published');
        if (cacheCreationPolicy === 'sensitivity_as_uncached_input' && factor.uncached_input?.mean != null) {
          sensitivityCacheCreationWh = count * factor.uncached_input.mean;
          addNote(notes, 'cache-creation-sensitivity-uses-uncached-input-coefficient');
        }
      } else {
        addNote(notes, `missing-coefficient:${category.key}`);
      }
      unestimated.push(category.key);
      varianceAvailable = false;
      continue;
    }
    const componentWh = count * mean;
    components[`${category.key}_wh`] = componentWh;
    estimatedWh += componentWh;
    estimatedTokens += count;
    anyEstimated = true;
    if (category.coefficient.sd === null || category.coefficient.sd === undefined) varianceAvailable = false;
    else variance += (count * category.coefficient.sd) ** 2;
  }

  const complete = unestimated.length === 0;
  const coverage = complete ? 'complete' : (anyEstimated ? 'partial' : 'unavailable');
  const meanWh = complete ? estimatedWh : null;
  const sd = varianceAvailable && anyEstimated ? Math.sqrt(variance) : null;
  const lower = meanWh !== null && sd !== null ? Math.max(0, meanWh - 1.96 * sd) : null;
  const upper = meanWh !== null && sd !== null ? meanWh + 1.96 * sd : null;

  if (dataset.synthetic) addNote(notes, 'synthetic-factor-dataset');
  if (mapping.state === 'explicit_proxy') addNote(notes, 'explicit-proxy-model-mapping');
  if (mapping.state === 'documented_alias') addNote(notes, 'documented-alias-model-mapping');
  if (dataset.license && /NC|NonCommercial/i.test(dataset.license)) addNote(notes, 'non-commercial-factor-license');

  return {
    boundary: dataset.boundary || 'accelerator-inference',
    method: 'factor-dataset-per-token',
    source: dataset.dataset || adapter,
    source_version: dataset.dataset_version || null,
    measured_wh: null,
    estimated_wh: anyEstimated ? estimatedWh : null,
    mean_wh: meanWh,
    standard_deviation_wh: sd,
    lower_wh: lower,
    upper_wh: upper,
    interval_method: sd === null ? null : 'mean-plus-minus-1.96-sd',
    basis: 'estimated',
    coverage,
    components: {
      cpu_wh: null,
      gpu_wh: null,
      ram_wh: null,
      accelerator_wh: anyEstimated ? estimatedWh : null,
      host_wh: null,
      cooling_wh: null,
      idle_wh: null,
    },
    source_values: [],
    hardware: {
      cpu_model: null, cpu_threads: null, gpu_model: null, gpu_available: null,
      ram_total_bytes: null, tracking_mode: null, country_iso_code: null,
      region: null, pue: null, wue: null,
    },
    dataset: meta,
    by_category: components,
    sensitivity: sensitivityCacheCreationWh === null ? null : {
      cache_creation_wh: sensitivityCacheCreationWh,
      method: 'cache-creation-as-uncached-input',
      included_in_mean: false,
    },
    unestimated_categories: unestimated,
    estimated_tokens: anyEstimated ? estimatedTokens : null,
    total_tokens: totalTokens,
    uncertainty_correlation: 'same-model-coefficients-fully-correlated',
    notes: [
      ...notes,
      ...(mapping.state === 'explicit_proxy' ? ['proxy-mapping-not-a-direct-measurement'] : []),
      ...(complete ? [] : ['partial-estimate-not-total-inference-energy']),
      ...(sensitivityCacheCreationWh !== null ? [`cache-creation-sensitivity-wh:${sensitivityCacheCreationWh}`] : []),
      ...(mapping.state === 'documented_alias' ? [`alias-source:${mapping.alias_source}`] : []),
    ],
  };
}

function normalizeAiRequest(raw = {}, { dataset = null, cacheCreationPolicy = 'unavailable' } = {}) {
  const provider = String(raw.provider || 'unknown').toLowerCase();
  const shape = String(raw.shape || provider).toLowerCase();
  const usage = normalizeProviderUsage({ provider, shape, usage: raw.usage || raw.usage_metadata || {} });
  const requestedModel = raw.requested_model || raw.model || null;
  const resolvedModel = raw.resolved_model || raw.model || null;
  const requestId = raw.request_id || raw.id || null;
  const startedAt = raw.started_at || raw.startedAt || null;
  const endedAt = raw.ended_at || raw.endedAt || null;
  let durationMs = numberOrNull(raw.duration_ms);
  if (durationMs === null && startedAt && endedAt) {
    const start = Date.parse(startedAt);
    const end = Date.parse(endedAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) durationMs = end - start;
  }
  const energy = estimateInferenceEnergy({
    tokens: usage.tokens,
    dataset,
    model: resolvedModel || requestedModel,
    cacheCreationPolicy,
  });
  const missing = [...usage.missing];
  if (energy.coverage === 'unavailable') missing.push('energy');
  if (energy.coverage === 'partial') missing.push('energy.unestimated_categories');
  if (raw.cost?.reported_usd == null && raw.cost?.estimated_usd == null) missing.push('cost');
  missing.push('emissions');
  const completeness = energy.coverage === 'complete' && usage.tokens.token_basis === 'provider-reported' && missing.length === 0
    ? 'complete'
    : (usage.tokens.token_basis === 'unavailable' && energy.coverage === 'unavailable' ? 'unavailable' : 'partial');

  const cost = (() => {
    const reported = numberOrNull(raw.cost?.reported_usd);
    const estimated = numberOrNull(raw.cost?.estimated_usd);
    if (reported !== null) return { reported_usd: reported, estimated_usd: null, basis: 'provider-reported', note: raw.cost?.note || null, currency: raw.cost?.currency || 'USD' };
    if (estimated !== null) return { reported_usd: null, estimated_usd: estimated, basis: 'estimated', note: raw.cost?.note || null, currency: raw.cost?.currency || 'USD' };
    return { reported_usd: null, estimated_usd: null, basis: 'unavailable', note: null, currency: raw.cost?.currency || null };
  })();

  const sessionIdHash = raw.session_id ? sha256(raw.session_id) : null;
  const measurementId = requestId ? `ai-${sha256(`${requestId}\0${startedAt || ''}`).slice(0, 32)}` : undefined;
  const ai = {
    ...blankAi(),
    request_id: requestId,
    session_id_hash: sessionIdHash,
    requested_model: requestedModel,
    resolved_model: resolvedModel,
    model_version: raw.model_version ?? null,
    model_alias: raw.model_alias ?? null,
    streaming: typeof raw.streaming === 'boolean' ? raw.streaming : null,
    reasoning: {
      enabled: typeof raw.reasoning?.enabled === 'boolean' ? raw.reasoning.enabled : null,
      effort: raw.reasoning?.effort ?? null,
      budget_tokens: intOrNull(raw.reasoning?.budget_tokens),
    },
    retries: intOrNull(raw.retries),
    tool_invocations: intOrNull(raw.tools?.invocations),
    tool_result_bytes: intOrNull(raw.tools?.result_bytes),
    time_to_first_token_ms: numberOrNull(raw.time_to_first_token_ms),
    output_tokens_per_second: numberOrNull(raw.output_tokens_per_second),
    context_window_utilization: numberOrNull(raw.context_window_utilization),
    modality: raw.modality ?? null,
    api_region: raw.api_region ?? null,
    service_tier: raw.service_tier ?? null,
    batch: typeof raw.batch === 'boolean' ? raw.batch : null,
    cache_lifetime: raw.cache_lifetime ?? null,
    routing: raw.routing ?? null,
    outcome: raw.outcome || 'success',
  };

  return makeEvent({
    ...(measurementId ? { measurement_id: measurementId } : {}),
    event_type: 'ai-request',
    occurred_at: startedAt || iso(),
    recorded_at: raw.recorded_at || undefined,
    duration_ms: durationMs,
    project: raw.repository || raw.project || 'local/unfiled',
    issue: raw.issue ?? null,
    variant: raw.variant ?? null,
    task: {
      id: raw.task_id || 'unfiled',
      label: raw.task_label ?? null,
      execution_id: raw.execution_id ?? null,
      kind: raw.task_kind || 'investigation',
      state: raw.task_state ?? null,
      expected_deliverable: raw.expected_deliverable || 'investigation-report',
      verified: null,
    },
    activity: raw.activity || 'ai-assisted-investigation',
    tool: raw.client || `${provider}-client`,
    model: resolvedModel,
    provider: raw.provider ?? null,
    outcome: raw.outcome || 'success',
    validation: raw.validation || 'not-run',
    commit: raw.commit ?? null,
    patch: raw.patch ?? null,
    source: {
      adapter: 'ai-usage-import',
      method: `${provider}-usage-normalization`,
      confidence: usage.tokens.token_basis === 'provider-reported' ? 'provider-reported' : (usage.tokens.token_basis === 'estimated' ? 'estimated' : 'unavailable'),
      reference: null,
    },
    measurements: {
      tokens: usage.tokens,
      cost,
      tools: {
        invocations: ai.tool_invocations,
        result_bytes: ai.tool_result_bytes,
        repeated_reads: intOrNull(raw.tools?.repeated_reads),
        errors: intOrNull(raw.tools?.errors),
      },
      context: {
        start_tokens: intOrNull(raw.context?.start_tokens),
        average_tokens: intOrNull(raw.context?.average_tokens),
        growth_tokens: intOrNull(raw.context?.growth_tokens),
      },
      latency: {
        api_ms: numberOrNull(raw.latency_ms),
        tool_ms: numberOrNull(raw.tool_ms),
        time_to_first_token_ms: ai.time_to_first_token_ms,
        output_tokens_per_second: ai.output_tokens_per_second,
      },
      cpu: { measurement: 'unavailable' },
      memory: { measurement: 'unavailable' },
      io: { read_ops: null, write_ops: null, read_bytes: null, write_bytes: null, measurement: 'unavailable' },
      network: { rx_bytes: null, tx_bytes: null, measurement: 'unavailable' },
      github: {},
      energy,
      emissions: {
        boundary: 'unavailable',
        gco2e: null,
        gco2e_per_kwh: null,
        carbon_intensity_source: null,
        region: raw.region ?? null,
        country_iso_code: raw.country_iso_code ?? null,
        methodology: null,
        basis: 'unavailable',
        coverage: 'unavailable',
        components: { operational_gco2e: null, embodied_gco2e: null, construction_gco2e: null },
        source_values: [],
      },
      measurement: {
        id: measurementId || requestId || 'ai-request',
        tool: raw.client || `${provider}-client`,
        tool_version: raw.client_version ?? null,
        exit_status: null,
        signal: null,
        timed_out: false,
        wall_ms: durationMs,
        inner_wall_ms: durationMs,
        overhead_ms: null,
        sampling_interval_ms: null,
        lock_wait_ms: null,
        overlap: Boolean(raw.overlap),
        concurrent_measurements: intOrNull(raw.concurrent_measurements) || 0,
        cache_state: null,
        repeats: 1,
      },
    },
    ai,
    quality: {
      completeness,
      missing: [...new Set(missing)].sort(),
      notes: [
        ...usage.notes,
        ...energy.notes,
        'remote-inference-energy-is-separate-from-local-compute',
        ...(energy.coverage !== 'complete' ? ['partial-estimate-not-total-inference-energy'] : []),
      ],
      warnings: [...new Set([...usage.notes, ...energy.notes.map((n) => n.split(':')[0])])],
    },
    private: {
      session_id_hash: sessionIdHash,
      provider_semantics_version: PROVIDER_SEMANTICS_VERSION,
      provider_semantics_source: PROVIDER_SEMANTICS[provider]?.source || null,
      raw_usage: usage.tokens.provider_fields,
      cache_creation_policy: cacheCreationPolicy,
    },
  });
}

/**
 * Aggregate estimates without mixing methodologies. Same-model coefficients
 * are treated as fully correlated (systematic uncertainty is not reduced by
 * adding requests); different models are combined in quadrature.
 */
function aggregateInferenceEstimates(estimates = []) {
  const byDataset = new Map();
  for (const estimate of estimates) {
    const key = `${estimate.source || 'unknown'}|${estimate.source_version || 'unknown'}|${estimate.boundary || 'unknown'}`;
    if (!byDataset.has(key)) {
      byDataset.set(key, {
        source: estimate.source || null,
        dataset_version: estimate.source_version || null,
        methodology_version: estimate.dataset?.methodology_version || null,
        boundary: estimate.boundary || null,
        requests: 0,
        complete_requests: 0,
        partial_requests: 0,
        unavailable_requests: 0,
        mean_wh: null,
        standard_deviation_wh: null,
        complete_estimated_wh: null,
        partial_estimated_wh: null,
        notes: [
          'Never add CLEER and EcoLogits estimates together.',
          'Same-model coefficients are treated as fully correlated; cross-model uncertainty is combined in quadrature.',
        ],
      });
    }
    const group = byDataset.get(key);
    group.requests += 1;
    if (estimate.coverage === 'complete') group.complete_requests += 1;
    else if (estimate.coverage === 'partial') { group.partial_requests += 1; group.partial_estimated_wh = (group.partial_estimated_wh || 0) + (estimate.estimated_wh || 0); }
    else group.unavailable_requests += 1;
  }

  for (const [key, group] of [...byDataset.entries()]) {
    const complete = estimates.filter((estimate) => (
      estimate.source === group.source
      && (estimate.source_version || null) === group.dataset_version
      && (estimate.boundary || null) === group.boundary
      && estimate.coverage === 'complete'
      && estimate.mean_wh !== null
    ));
    if (complete.length === 0) continue;
    const byModel = new Map();
    for (const estimate of complete) {
      const model = estimate.dataset?.name && estimate.dataset?.version
        ? `${estimate.dataset.version}:${estimate.dataset.name}`
        : 'unknown';
      if (!byModel.has(model)) byModel.set(model, { mean: 0, sd: 0, hasSd: true });
      const entry = byModel.get(model);
      entry.mean += estimate.mean_wh;
      if (estimate.standard_deviation_wh === null) entry.hasSd = false;
      else entry.sd += estimate.standard_deviation_wh;
    }
    let mean = 0;
    let variance = 0;
    let hasSd = true;
    for (const entry of byModel.values()) {
      mean += entry.mean;
      if (!entry.hasSd) hasSd = false;
      else variance += entry.sd ** 2;
    }
    group.mean_wh = mean;
    group.standard_deviation_wh = hasSd ? Math.sqrt(variance) : null;
    group.complete_estimated_wh = mean;
    byDataset.set(key, group);
  }

  return {
    generated_at: new Date().toISOString(),
    by_dataset: [...byDataset.values()].sort((a, b) => `${a.source}|${a.dataset_version}`.localeCompare(`${b.source}|${b.dataset_version}`)),
    mixing_rule: 'estimates from different sources are reported separately and are never summed or averaged',
    total_across_datasets: null,
  };
}

const ADAPTERS = Object.freeze({
  cleer: (options) => estimateInferenceEnergy({ ...options, adapter: 'cleer' }),
  ecologits: () => blankEnergyEstimate('ecologits-adapter-not-implemented', {
    notes: [
      'interface-reserved',
      'no-local-ecologits-factor-dataset',
      'do-not-add-to-cleer-estimate',
    ],
  }),
});

function estimateWithAdapter(adapter, options) {
  const fn = ADAPTERS[adapter];
  if (!fn) return blankEnergyEstimate(`unknown-energy-adapter:${adapter}`);
  return fn(options);
}

module.exports = {
  PROVIDER_SEMANTICS_VERSION,
  PROVIDER_SEMANTICS,
  normalizeProviderUsage,
  normalizeAiRequest,
  estimateInferenceEnergy,
  estimateWithAdapter,
  aggregateInferenceEstimates,
  blankEnergyEstimate,
};
