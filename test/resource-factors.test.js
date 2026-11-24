const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadFactorDataset,
  writeFactorDataset,
  validateFactorDataset,
  datasetChecksum,
  matchModel,
  importCleerDashboard,
  coverage,
  coefficientToWhPerToken,
} = require('../scripts/lib/resource/factors.cjs');

const factorsPath = path.join(__dirname, '..', 'fixtures', 'resource', 'cleer-factors.synthetic.json');
const dataset = loadFactorDataset(factorsPath);

function tempFile(name, value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmr-factors-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

test('a versioned per-token dataset loads with a verified checksum', () => {
  assert.equal(dataset.dataset, 'cleer');
  assert.equal(dataset.dataset_version, 'synthetic-1.0.0');
  assert.equal(dataset.methodology_version, 'CLEER-Text-0926');
  assert.equal(dataset.boundary, 'accelerator-inference');
  const raw = JSON.parse(fs.readFileSync(factorsPath, 'utf8'));
  assert.equal(raw.checksum, `sha256:${datasetChecksum(raw)}`);
  assert.equal(coverage(dataset).per_token_models, 5);
});

test('a changed dataset fails checksum verification', () => {
  const changed = JSON.parse(fs.readFileSync(factorsPath, 'utf8'));
  changed.models[0].output.mean = 999;
  const problems = validateFactorDataset(changed);
  assert.ok(problems.some((problem) => problem.includes('checksum')));
});

test('synthetic factors are refused when the caller does not allow them', () => {
  const problems = validateFactorDataset(JSON.parse(fs.readFileSync(factorsPath, 'utf8')), { allowSynthetic: false });
  assert.ok(problems.some((problem) => problem.includes('synthetic')));
});

test('a per-token dataset without an output coefficient is rejected', () => {
  const broken = JSON.parse(fs.readFileSync(factorsPath, 'utf8'));
  delete broken.models[0].output;
  delete broken.checksum;
  const problems = validateFactorDataset(broken);
  assert.ok(problems.some((problem) => problem.includes('output')));
});

test('coefficient units are converted to Wh per token and unsupported units are rejected', () => {
  assert.equal(coefficientToWhPerToken({ mean: 3600, sd: null, unit: 'J/token' }).mean, 1);
  assert.equal(coefficientToWhPerToken({ mean: 1, sd: null, unit: 'kWh/token' }).mean, 1000);
  assert.equal(coefficientToWhPerToken({ mean: 1, sd: null, unit: 'tokens/Wh' }).problem, 'unsupported-coefficient-unit:tokens/Wh');
  assert.equal(coefficientToWhPerToken({ mean: null, sd: null, unit: 'Wh/token' }).problem, 'no-mean');
});

test('written datasets carry a checksum that reloads successfully', () => {
  const clone = JSON.parse(fs.readFileSync(factorsPath, 'utf8'));
  delete clone.checksum;
  clone.dataset_version = 'synthetic-1.0.1';
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmr-factors-write-')), 'factors.json');
  const written = writeFactorDataset(clone, file);
  assert.match(written.checksum, /^sha256:[0-9a-f]{64}$/);
  const reloaded = loadFactorDataset(file);
  assert.equal(reloaded.dataset_version, 'synthetic-1.0.1');
});

test('CLEER dashboard import records session-only coverage and the source checksum', () => {
  const imported = importCleerDashboard(path.join(__dirname, '..', 'fixtures', 'resource', 'cleer-dashboard-models.synthetic.json'));
  assert.equal(imported.dataset_kind, 'session-only');
  assert.equal(imported.dataset_version, 'cleer-dashboard-1.1.0-2026-09-29');
  assert.equal(imported.methodology_version, 'CLEER-Text-0926');
  assert.match(imported.source_checksum, /^sha256:[0-9a-f]{64}$/);
  assert.equal(imported.license, 'CC BY-NC 4.0');
  assert.equal(imported.models.length, 2);
  assert.equal(imported.models[0].session_results['chat.light'].energy_wh_mean, 1.2);
  assert.ok(imported.notes.some((note) => note.includes('per-token')));
});

test('CLEER dashboard models are marked unsupported for per-token matching', () => {
  const imported = importCleerDashboard(path.join(__dirname, '..', 'fixtures', 'resource', 'cleer-dashboard-models.synthetic.json'));
  const matching = matchModel(imported, 'Synthetic Model A');
  assert.equal(matching.state, 'unsupported');
  assert.equal(matching.reason, 'factor-dataset-marks-model-unsupported');
  assert.equal(coverage(imported).per_token_models, 0);
});

test('model matching never substitutes a similarly named model', () => {
  assert.equal(matchModel(dataset, 'gpt-5-synthetic-pro').state, 'unsupported');
  assert.equal(matchModel(dataset, 'GPT-5-SYNTHETIC').state, 'ambiguous');
});
