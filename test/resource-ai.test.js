const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeProviderUsage,
  normalizeAiRequest,
  estimateInferenceEnergy,
  estimateWithAdapter,
  aggregateInferenceEstimates,
} = require('../scripts/lib/resource/ai.cjs');
const { loadFactorDataset, importCleerDashboard, matchModel } = require('../scripts/lib/resource/factors.cjs');
const { validateEvent } = require('../scripts/lib/resource/event.cjs');

const dataset = loadFactorDataset(path.join(__dirname, '..', 'fixtures', 'resource', 'cleer-factors.synthetic.json'));
const aiLines = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'resource', 'ai-usage.synthetic.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line));

function anthropicUsage() {
  return { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 5000, output_tokens: 500 };
}

function openaiUsage() {
  return {
    prompt_tokens: 10000,
    prompt_tokens_details: { cached_tokens: 4000 },
    completion_tokens: 800,
    completion_tokens_details: { reasoning_tokens: 300 },
  };
}

test('Anthropic token categories are additive and mutually exclusive', () => {
  const { tokens } = normalizeProviderUsage({ provider: 'anthropic', usage: anthropicUsage() });
  assert.equal(tokens.input_total, 8000);
  assert.equal(tokens.uncached_input, 1000);
  assert.equal(tokens.cache_creation, 2000);
  assert.equal(tokens.cache_read, 5000);
  assert.equal(tokens.output, 500);
  assert.equal(tokens.reasoning, null, 'Anthropic does not report thinking separately');
  assert.equal(tokens.token_basis, 'provider-reported');
});

test('OpenAI cached tokens are a subset of prompt tokens and reasoning is not double counted', () => {
  const { tokens } = normalizeProviderUsage({ provider: 'openai', usage: openaiUsage() });
  assert.equal(tokens.input_total, 10000);
  assert.equal(tokens.uncached_input, 6000);
  assert.equal(tokens.cache_read, 4000);
  assert.equal(tokens.cache_creation, null, 'Chat Completions does not report cache creation');
  assert.equal(tokens.output, 800);
  assert.equal(tokens.reasoning, 300);
  assert.equal(tokens.reasoning_included_in_output, true);
  assert.equal(tokens.output + tokens.reasoning, 1100, 'reasoning must not be added to output');
});

test('missing OpenAI cache details are recorded as an explicit zero assumption', () => {
  const { tokens, notes } = normalizeProviderUsage({
    provider: 'openai',
    usage: { prompt_tokens: 2000, completion_tokens: 100 },
  });
  assert.equal(tokens.cache_read, 0);
  assert.equal(tokens.uncached_input, 2000);
  assert.ok(notes.includes('openai-absent-cached-tokens-treated-as-zero'));
});

test('cached tokens exceeding prompt tokens invalidates uncached input instead of going negative', () => {
  const { tokens, notes } = normalizeProviderUsage({
    provider: 'openai',
    usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens: 5 },
  });
  assert.equal(tokens.uncached_input, null);
  assert.equal(tokens.token_basis, 'unavailable');
  assert.ok(notes.includes('openai-cached-tokens-exceed-prompt-tokens'));
});

test('a provider without reported usage remains unavailable; no text/4 or cost inference', () => {
  const { tokens, missing } = normalizeProviderUsage({ provider: 'generic', usage: {} });
  assert.equal(tokens.token_basis, 'unavailable');
  assert.equal(tokens.input_total, null);
  assert.equal(tokens.output, null);
  assert.ok(missing.includes('tokens.input_total'));
});

test('model matching distinguishes exact, alias, proxy, ambiguous, unsupported and unknown', () => {
  assert.equal(matchModel(dataset, 'gpt-5-synthetic').state, 'exact');
  assert.equal(matchModel(dataset, 'gpt-5-synthetic-2026-01-01').state, 'documented_alias');
  assert.equal(matchModel(dataset, 'frontier-model-alias').state, 'explicit_proxy');
  assert.equal(matchModel(dataset, 'ambiguous-alias').state, 'ambiguous');
  assert.equal(matchModel(dataset, 'mystery-model-9000').state, 'unsupported');
  assert.equal(matchModel(dataset, null).state, 'unknown');
});

test('partial per-token estimate reports an estimated portion but not a complete mean', () => {
  const tokens = normalizeProviderUsage({ provider: 'anthropic', usage: anthropicUsage() }).tokens;
  const energy = estimateInferenceEnergy({ tokens, dataset, model: 'claude-sonnet-4-5-synthetic' });
  assert.equal(energy.coverage, 'partial');
  assert.equal(energy.mean_wh, null, 'partial estimates are not presented as complete');
  assert.ok(Math.abs(energy.estimated_wh - 0.0014) < 1e-12);
  assert.ok(energy.unestimated_categories.includes('cache_creation'));
  assert.equal(energy.lower_wh, null);
  assert.equal(energy.boundary, 'accelerator-inference');
  assert.ok(energy.notes.includes('partial-estimate-not-total-inference-energy'));
  assert.ok(energy.notes.includes('synthetic-factor-dataset'));
});

test('complete per-token estimate preserves mean, standard deviation, range and category components', () => {
  const tokens = { uncached_input: 1000, cache_read: 5000, cache_creation: 2000, output: 500 };
  const energy = estimateInferenceEnergy({ tokens, dataset, model: 'proxy-model-synthetic' });
  assert.equal(energy.coverage, 'complete');
  assert.ok(Math.abs(energy.mean_wh - 0.0025) < 1e-12);
  assert.ok(energy.standard_deviation_wh > 0);
  assert.ok(energy.lower_wh <= energy.mean_wh);
  assert.ok(energy.upper_wh >= energy.mean_wh);
  assert.equal(energy.interval_method, 'mean-plus-minus-1.96-sd');
  assert.ok(Math.abs(energy.by_category.uncached_input_wh - 0.0004) < 1e-12);
  assert.ok(Math.abs(energy.by_category.cached_input_wh - 0.00075) < 1e-12);
  assert.ok(Math.abs(energy.by_category.cache_creation_wh - 0.0006) < 1e-12);
  assert.ok(Math.abs(energy.by_category.output_wh - 0.00075) < 1e-12);
  assert.ok(energy.notes.includes('explicit-proxy-model-mapping'));
});

test('cache creation is never silently classified as cache reads', () => {
  const tokens = { uncached_input: 1000, cache_read: 5000, cache_creation: 2000, output: 500 };
  const energy = estimateInferenceEnergy({ tokens, dataset, model: 'claude-sonnet-4-5-synthetic' });
  assert.equal(energy.by_category.cache_creation_wh, null);
  assert.ok(energy.unestimated_categories.includes('cache_creation'));
  assert.notEqual(energy.by_category.cache_creation_wh, energy.by_category.cached_input_wh);
});

test('a cache-creation sensitivity is reported separately and never included in the mean', () => {
  const tokens = { uncached_input: 1000, cache_read: 5000, cache_creation: 2000, output: 500 };
  const energy = estimateInferenceEnergy({
    tokens,
    dataset,
    model: 'claude-sonnet-4-5-synthetic',
    cacheCreationPolicy: 'sensitivity_as_uncached_input',
  });
  assert.equal(energy.mean_wh, null);
  assert.equal(energy.sensitivity.included_in_mean, false);
  assert.ok(energy.sensitivity.cache_creation_wh > 0);
  assert.ok(Math.abs(energy.estimated_wh - 0.0014) < 1e-12, 'sensitivity is not folded into the partial estimate');
  assert.ok(Math.abs(energy.sensitivity.cache_creation_wh - 0.0006) < 1e-12);
});

test('unsupported model preserves raw tokens and reports energy unavailable', () => {
  const raw = aiLines[3];
  const event = normalizeAiRequest(raw, { dataset });
  assert.equal(event.measurements.tokens.uncached_input, 500);
  assert.equal(event.measurements.energy.coverage, 'unavailable');
  assert.equal(event.measurements.energy.mean_wh, null);
  assert.ok(event.measurements.energy.notes.some((note) => note.includes('unsupported')));
  assert.equal(validateEvent(event).length, 0);
});

test('session-only CLEER data refuses request-level per-token estimation', () => {
  const cleer = importCleerDashboard(path.join(__dirname, '..', 'fixtures', 'resource', 'cleer-dashboard-models.synthetic.json'));
  assert.equal(cleer.dataset_kind, 'session-only');
  const energy = estimateInferenceEnergy({
    tokens: { uncached_input: 100, cache_read: 0, cache_creation: 0, output: 10 },
    dataset: cleer,
    model: 'Synthetic Model A',
  });
  assert.equal(energy.coverage, 'unavailable');
  assert.ok(energy.notes.includes('cleer-per-token-factors-not-published'));
  assert.ok(energy.notes.includes('session-only-dataset'));
  assert.equal(energy.mean_wh, null);
});

test('estimates never mix local process energy and remote inference boundaries', () => {
  const tokens = normalizeProviderUsage({ provider: 'openai', usage: openaiUsage() }).tokens;
  const remote = estimateInferenceEnergy({ tokens, dataset, model: 'gpt-5-synthetic' });
  const local = estimateWithAdapter('ecologits', {});
  assert.equal(remote.boundary, 'accelerator-inference');
  assert.equal(local.boundary, 'accelerator-inference');
  assert.equal(local.coverage, 'unavailable');
  assert.ok(local.notes.includes('do-not-add-to-cleer-estimate'));
});

test('aggregation keeps methodologies separate and does not divide systematic uncertainty by request count', () => {
  const estimate = {
    source: 'cleer',
    source_version: 'synthetic-1.0.0',
    boundary: 'accelerator-inference',
    coverage: 'complete',
    mean_wh: 1,
    standard_deviation_wh: 0.2,
    dataset: { name: 'cleer', version: 'synthetic-1.0.0', methodology_version: 'CLEER-Text-0926' },
  };
  const aggregated = aggregateInferenceEstimates([estimate, { ...estimate }, {
    ...estimate, source: 'ecologits', source_version: 'other', mean_wh: 0.5,
  }]);
  const cleer = aggregated.by_dataset.find((group) => group.source === 'cleer');
  const ecologits = aggregated.by_dataset.find((group) => group.source === 'ecologits');
  assert.equal(cleer.mean_wh, 2);
  assert.ok(Math.abs(cleer.standard_deviation_wh - 0.4) < 1e-12, 'same-model uncertainty adds rather than shrinking with n');
  assert.equal(ecologits.mean_wh, 0.5);
  assert.equal(aggregated.total_across_datasets, null);
  assert.ok(aggregated.mixing_rule.includes('never summed'));
});

test('AI request event stores a session hash, not the raw session id', () => {
  const event = normalizeAiRequest(aiLines[0], { dataset });
  assert.equal(event.ai.request_id, 'req_anth_synthetic_1');
  assert.match(event.ai.session_id_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(event.ai.session_id_hash, 'synthetic-session-secret-1');
  assert.equal(event.private.session_id_hash, event.ai.session_id_hash);
  assert.equal(event.private.raw_usage.input_tokens, 1000);
  assert.equal(event.measurements.cost.reported_usd, 0.0123);
  assert.equal(event.measurements.cost.basis, 'provider-reported');
  assert.equal(event.measurements.cost.currency, 'USD');
});
