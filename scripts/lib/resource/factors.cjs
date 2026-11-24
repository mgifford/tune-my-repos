/**
 * Versioned local AI energy factor datasets.
 *
 * The estimator never fetches factors. A dataset is loaded from a local file,
 * validated, checksum-verified, and matched explicitly. A model that cannot be
 * matched is reported as unsupported/ambiguous/unknown; it is never silently
 * replaced by a cheaper or similarly named model.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { validatePolicySchema } = require('../../../policy/policy-validator.cjs');
const { stableStringify } = require('./event.cjs');
const { finite } = require('./units.cjs');

const SCHEMA_PATH = path.join(__dirname, '..', '..', '..', 'policy', 'resource-factor.schema.json');
let cachedSchema = null;

function schema() {
  if (!cachedSchema) cachedSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return cachedSchema;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function withoutChecksum(dataset) {
  const clone = { ...dataset };
  delete clone.checksum;
  return clone;
}

function datasetChecksum(dataset) {
  return sha256(stableStringify(withoutChecksum(dataset)));
}

function coefficientToWhPerToken(coefficient) {
  if (!coefficient || coefficient.mean == null) return { mean: null, sd: null, unit: 'Wh/token', problem: 'no-mean' };
  const match = String(coefficient.unit || '').trim().match(/^([A-Za-z]+)\/token$/);
  if (!match) return { mean: null, sd: null, unit: 'Wh/token', problem: `unsupported-coefficient-unit:${coefficient.unit}` };
  const unit = match[1].toLowerCase();
  const factor = { j: 1 / 3600, kj: 1000 / 3600, mj: 1e6 / 3600, wh: 1, kwh: 1000, mwh: 1e6 }[unit];
  if (factor === undefined) return { mean: null, sd: null, unit: 'Wh/token', problem: `unsupported-coefficient-unit:${coefficient.unit}` };
  return {
    mean: finite(coefficient.mean) === null ? null : coefficient.mean * factor,
    sd: finite(coefficient.sd) === null ? null : coefficient.sd * factor,
    unit: 'Wh/token',
    basis: coefficient.basis,
  };
}

function normalizeDataset(dataset) {
  return {
    ...dataset,
    models: (dataset.models || []).map((model) => ({
      ...model,
      uncached_input: model.uncached_input ? coefficientToWhPerToken(model.uncached_input) : null,
      cached_input: model.cached_input ? coefficientToWhPerToken(model.cached_input) : null,
      cache_creation: model.cache_creation ? coefficientToWhPerToken(model.cache_creation) : null,
      output: model.output ? coefficientToWhPerToken(model.output) : null,
    })),
  };
}

function validateFactorDataset(dataset, { allowSynthetic = true } = {}) {
  const problems = validatePolicySchema(dataset, schema());
  if (dataset.synthetic === true && !allowSynthetic) {
    problems.push('$.synthetic: synthetic factors are not allowed for this operation');
  }
  if (dataset.dataset_kind === 'per-token') {
    for (const [index, model] of (dataset.models || []).entries()) {
      for (const key of ['uncached_input', 'output']) {
        if (!model[key] || model[key].mean == null) problems.push(`$.models[${index}].${key}: per-token dataset requires a mean coefficient`);
      }
    }
  }
  if (dataset.checksum) {
    const expected = datasetChecksum(dataset);
    if (dataset.checksum !== `sha256:${expected}` && dataset.checksum !== expected) {
      problems.push(`$.checksum: does not match the dataset content (expected sha256:${expected})`);
    }
  }
  return problems;
}

function loadFactorDataset(file, options = {}) {
  const text = fs.readFileSync(file, 'utf8');
  let dataset;
  try { dataset = JSON.parse(text); } catch (error) {
    throw new Error(`factor dataset is not valid JSON: ${error.message}`);
  }
  const problems = validateFactorDataset(dataset, options);
  if (problems.length) throw new Error(`factor dataset is invalid:\n  ${problems.slice(0, 12).join('\n  ')}`);
  const normalized = normalizeDataset(dataset);
  normalized.checksum = dataset.checksum || `sha256:${datasetChecksum(dataset)}`;
  return normalized;
}

function writeFactorDataset(dataset, file) {
  const checksum = `sha256:${datasetChecksum(dataset)}`;
  const withChecksum = { ...dataset, checksum };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(withChecksum, null, 2)}\n`, { mode: 0o600 });
  return withChecksum;
}

function normalizeModelKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function matchModel(dataset, requestedModel) {
  const requested = String(requestedModel || '').trim();
  if (!requested) {
    return { state: 'unknown', requested: null, matched_id: null, mapping: null, confidence: null, reason: 'no-model-id' };
  }
  const models = dataset?.models || [];
  const exact = models.find((model) => model.id === requested);
  if (exact) {
    const state = exact.mapping === 'explicit_proxy'
      ? 'explicit_proxy'
      : (exact.mapping === 'unsupported' ? 'unsupported' : 'exact');
    return {
      state,
      requested,
      matched_id: exact.id,
      mapping: exact.mapping,
      confidence: exact.confidence ?? null,
      reason: exact.mapping === 'explicit_proxy'
        ? 'factor-dataset-declares-proxy'
        : (exact.mapping === 'unsupported' ? 'factor-dataset-marks-model-unsupported' : 'exact-model-id'),
    };
  }
  const aliasMatches = [];
  for (const model of models) {
    for (const alias of model.aliases || []) {
      if (alias.id === requested) aliasMatches.push({ model, alias });
    }
  }
  if (aliasMatches.length === 1) {
    const { model, alias } = aliasMatches[0];
    const state = model.mapping === 'explicit_proxy'
      ? 'explicit_proxy'
      : (model.mapping === 'unsupported' ? 'unsupported' : 'documented_alias');
    return {
      state,
      requested,
      matched_id: model.id,
      mapping: model.mapping,
      confidence: model.confidence ?? null,
      reason: state === 'unsupported' ? 'factor-dataset-marks-model-unsupported' : 'documented-alias',
      alias_source: alias.source,
    };
  }
  if (aliasMatches.length > 1) {
    return { state: 'ambiguous', requested, matched_id: null, mapping: null, confidence: null, reason: 'multiple-documented-aliases' };
  }
  const proxies = models.filter((model) => model.mapping === 'explicit_proxy'
    && (model.proxy_for === requested || (model.aliases || []).some((alias) => alias.id === requested)));
  if (proxies.length === 1) {
    return {
      state: 'explicit_proxy',
      requested,
      matched_id: proxies[0].id,
      mapping: 'explicit_proxy',
      confidence: proxies[0].confidence ?? null,
      reason: 'explicit-proxy-entry',
      proxy_for: proxies[0].proxy_for ?? requested,
    };
  }
  if (proxies.length > 1) {
    return { state: 'ambiguous', requested, matched_id: null, mapping: null, confidence: null, reason: 'multiple-explicit-proxies' };
  }
  const normalized = normalizeModelKey(requested);
  const near = models.filter((model) => normalizeModelKey(model.id) === normalized
    || (model.aliases || []).some((alias) => normalizeModelKey(alias.id) === normalized));
  if (near.length === 1) {
    return {
      state: 'ambiguous',
      requested,
      matched_id: near[0].id,
      mapping: near[0].mapping,
      confidence: near[0].confidence ?? null,
      reason: 'case-or-separator-differs-from-published-id',
    };
  }
  if (near.length > 1) {
    return { state: 'ambiguous', requested, matched_id: null, mapping: null, confidence: null, reason: 'multiple-case-insensitive-matches' };
  }
  const unsupported = models.find((model) => model.mapping === 'unsupported' && model.id === requested);
  return {
    state: 'unsupported',
    requested,
    matched_id: unsupported?.id || null,
    mapping: unsupported?.mapping || null,
    confidence: unsupported?.confidence ?? null,
    reason: 'no-published-factor-for-model',
  };
}

/**
 * Import the public CLEER dashboard payload as a session-only dataset.
 *
 * CLEER 1.1.0 deliberately does not publish per-token intensities, and the
 * token counts behind its session workloads are not published either. The
 * import therefore records model coverage and per-session energy only; it
 * cannot produce request-level energy without inventing token counts.
 */
function importCleerDashboard(modelsFile, { metaFile = null, sourceUrl = null } = {}) {
  const text = fs.readFileSync(modelsFile, 'utf8');
  let payload;
  try { payload = JSON.parse(text); } catch (error) {
    throw new Error(`CLEER models.json is not valid JSON: ${error.message}`);
  }
  if (!payload || !Array.isArray(payload.models) || typeof payload.schemaVersion !== 'string') {
    throw new Error('CLEER models.json is missing schemaVersion or models[]');
  }
  let meta = null;
  if (metaFile) {
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { meta = null; }
  }
  const license = meta?.license?.data || payload.license?.data || 'CC BY-NC 4.0';
  const dataUpdated = payload.dataUpdated || meta?.dataUpdated || payload.generatedAt || 'unknown';
  const engine = payload.methodology?.engine || meta?.methodology?.engine || 'CLEER-Text-0926';
  const models = payload.models.map((model) => ({
    id: String(model.name || model.id || 'unnamed'),
    display_name: model.name || null,
    provider: model.provider ?? null,
    // No per-token coefficient exists in this release, so request-level
    // estimation is explicitly unsupported rather than proxied silently.
    mapping: 'unsupported',
    confidence: finite(model.confidence),
    aliases: [],
    proxy_for: null,
    session_results: Object.fromEntries(Object.entries(model.results || {}).map(([key, value]) => [
      key,
      {
        unit: payload.workloads?.[key]?.unit || 'one session',
        energy_wh_mean: finite(value?.energy_wh?.mean),
        energy_wh_sd: finite(value?.energy_wh?.sd),
        carbon_gco2e_mean: finite(value?.carbon_gco2e?.mean),
        carbon_gco2e_sd: finite(value?.carbon_gco2e?.sd),
      },
    ])),
  }));
  return {
    schema_version: '1.0.0',
    dataset_kind: 'session-only',
    dataset: 'cleer',
    dataset_version: `cleer-dashboard-${payload.schemaVersion}-${dataUpdated}`,
    methodology_version: engine,
    boundary: 'facility',
    license,
    license_url: 'https://github.com/sustainableaigroup/CLEER/blob/main/data/LICENSE',
    synthetic: false,
    source_url: sourceUrl || 'https://github.com/sustainableaigroup/CLEER',
    generated_at: payload.generatedAt || null,
    checksum: null,
    source_checksum: `sha256:${sha256(text)}`,
    notes: [
      'CLEER dashboard data publishes per-session energy only; per-token coefficients and the token counts behind each session workload are not published.',
      'Request-level per-token estimation is unavailable from this dataset. Do not derive per-token factors by dividing session energy by an assumed token count.',
      `License: ${license}. Commercial use may require separate written permission from Sustainable AI Group.`,
    ],
    units: {
      uncached_input: 'not-published',
      cached_input: 'not-published',
      cache_creation: 'not-published',
      output: 'not-published',
    },
    models,
  };
}

function coverage(dataset) {
  const models = dataset?.models || [];
  return {
    dataset: dataset?.dataset || null,
    dataset_kind: dataset?.dataset_kind || null,
    dataset_version: dataset?.dataset_version || null,
    methodology_version: dataset?.methodology_version || null,
    boundary: dataset?.boundary || null,
    license: dataset?.license || null,
    synthetic: Boolean(dataset?.synthetic),
    model_count: models.length,
    per_token_models: models.filter((model) => model.uncached_input?.mean != null && model.output?.mean != null).length,
    session_only_models: models.filter((model) => model.session_results && Object.keys(model.session_results).length > 0).length,
    unsupported_models: models.filter((model) => model.mapping === 'unsupported').length,
  };
}

module.exports = {
  SCHEMA_PATH,
  schema,
  sha256,
  datasetChecksum,
  validateFactorDataset,
  loadFactorDataset,
  writeFactorDataset,
  coefficientToWhPerToken,
  matchModel,
  importCleerDashboard,
  coverage,
};
