const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { validatePolicySchema } = require('../policy/policy-validator.cjs');
const { cap, computeRecommendedAction } = require('../scripts/generate-maintenance-rollup.cjs');
const { validateRollupFile } = require('../scripts/validate-rollup.cjs');

const root = path.join(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'policy', 'rollup.schema.json'), 'utf8'));
const samplePath = path.join(root, 'fixtures', 'maintenance-rollup.sample.json');
const sample = () => JSON.parse(fs.readFileSync(samplePath, 'utf8'));
const script = path.join(root, 'scripts', 'validate-rollup.cjs');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-rollup-'));
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
function writeTemp(name, content) {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, content);
  return file;
}

// --- Keywords the schema used but the validator ignored ---

test('validator: a string longer than maxLength is reported', () => {
  const rollup = sample();
  rollup.repositories[0].failed_update_prs[0].failure_summary = 'x'.repeat(1001);
  assert.match(validatePolicySchema(rollup, schema).join('\n'), /failure_summary: string longer than maxLength 1000/);
});

test('validator: an array longer than maxItems is reported', () => {
  const rollup = sample();
  const advice = { package: 'left-pad', dependency_type: 'production', kind: 'native', suggestion: 'Use padStart.' };
  rollup.repositories[0].library_advice = Array(21).fill(advice);
  assert.match(validatePolicySchema(rollup, schema).join('\n'), /library_advice: array longer than maxItems 20/);
});

test('validator: a non-boolean where the schema requires a boolean is reported', () => {
  const rollup = sample();
  rollup.repositories[0].security_alerts.has_urgent_alerts = 'yes';
  assert.match(validatePolicySchema(rollup, schema).join('\n'), /has_urgent_alerts: expected boolean/);
});

// --- recommended_action.action enum ---

test('schema: recommended_action.action lists exactly the actions the generator returns', () => {
  const actions = new Set([
    computeRecommendedAction({ counts: { critical: 1, high: 0 } }, [], []).action,
    computeRecommendedAction({ counts: null }, [], [{}]).action,
    computeRecommendedAction({ counts: null }, [{ risk_state: 'eligible' }], []).action,
    computeRecommendedAction({ counts: null }, [{ risk_state: 'needs_review' }], []).action,
    computeRecommendedAction({ counts: null }, [], []).action,
  ]);
  const allowed = schema.definitions.repositoryEntry.properties.recommended_action.properties.action.enum;
  assert.deepEqual([...allowed].sort(), [...actions].sort());
});

test('schema: an unknown recommended_action.action is reported', () => {
  const rollup = sample();
  rollup.repositories[0].recommended_action.action = 'do_something';
  assert.match(validatePolicySchema(rollup, schema).join('\n'), /recommended_action\.action: "do_something" is not one of/);
});

test('schema: a PR reason truncated by cap() still fits', () => {
  const rollup = sample();
  rollup.repositories[0].dependabot_prs[0].reason = cap('a long policy reason '.repeat(40), 500);
  assert.deepEqual(validatePolicySchema(rollup, schema), []);
});

// --- scripts/validate-rollup.cjs ---

test('validateRollupFile: the sample fixture passes', () => {
  assert.deepEqual(validateRollupFile(samplePath, schema), []);
});

test('validateRollupFile: a missing file fails', () => {
  assert.match(validateRollupFile(path.join(tempDir, 'absent.json'), schema)[0], /cannot read file/);
});

test('validateRollupFile: a file that is not JSON fails', () => {
  assert.deepEqual(validateRollupFile(writeTemp('broken.json', '{'), schema), ['not valid JSON']);
});

test('validate-rollup CLI: exits 0 when every file passes and 1 when any fails', () => {
  const bad = writeTemp('extra.json', JSON.stringify({ ...sample(), unexpected: true }));
  assert.equal(spawnSync(process.execPath, [script, samplePath]).status, 0);
  assert.equal(spawnSync(process.execPath, [script, samplePath, bad]).status, 1);
});

test('validate-rollup CLI: no file arguments is a failure', () => {
  assert.equal(spawnSync(process.execPath, [script]).status, 1);
});
