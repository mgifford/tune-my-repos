const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { detect, validateValue, validateFile } = require('../scripts/validate-resource.cjs');
const { validatePolicySchema } = require('../policy/policy-validator.cjs');

const root = path.join(__dirname, '..');
const fixtures = path.join(root, 'fixtures', 'resource');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('every committed resource fixture validates against its schema', () => {
  const files = [
    'resource-events.synthetic.jsonl',
    'resource-tasks.synthetic.jsonl',
    'resource-rollup.sample.json',
    'cleer-factors.synthetic.json',
  ];
  for (const name of files) {
    const results = validateFile(path.join(fixtures, name));
    for (const result of results) assert.deepEqual(result.problems, [], `${name} line ${result.line}`);
  }
});

test('document shape detection does not depend on filenames', () => {
  assert.equal(detect(read(path.join(fixtures, 'resource-rollup.sample.json'))), 'rollup');
  assert.equal(detect(read(path.join(fixtures, 'cleer-factors.synthetic.json'))), 'factor');
  const task = fs.readFileSync(path.join(fixtures, 'resource-tasks.synthetic.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)[0];
  const event = fs.readFileSync(path.join(fixtures, 'resource-events.synthetic.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)[0];
  assert.equal(detect(task), 'task');
  assert.equal(detect(event), 'event');
  assert.equal(detect({ hello: 'world' }), null);
});

test('a malformed event is rejected with a path-specific problem', () => {
  const event = fs.readFileSync(path.join(fixtures, 'resource-events.synthetic.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)[0];
  const broken = { ...event, activity: 'not-a-workflow' };
  const result = validateValue(broken);
  assert.equal(result.kind, 'event');
  assert.ok(result.problems.some((problem) => problem.includes('not-a-workflow')));
});

test('the event schema uses Drupal Core Lab core terminology', () => {
  const schema = read(path.join(root, 'policy', 'resource-evidence.schema.json'));
  for (const key of ['schema_version', 'event_id', 'event_type', 'recorded_at', 'occurred_at', 'project', 'task', 'activity', 'tool', 'model', 'provider', 'environment', 'outcome', 'validation', 'commit', 'patch', 'source', 'measurements', 'quality']) {
    assert.ok(schema.required.includes(key), `${key} is required`);
  }
  assert.equal(schema.properties.schema_version.const, '1.0.0');
  assert.ok(schema.definitions.measurements.properties.energy);
  assert.ok(schema.definitions.measurements.properties.emissions);
});

test('all resource schemas are versioned and have stable identifiers', () => {
  for (const name of ['resource-evidence.schema.json', 'resource-task.schema.json', 'resource-rollup.schema.json', 'resource-factor.schema.json']) {
    const schema = read(path.join(root, 'policy', name));
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
    assert.match(schema.$id, /^https:\/\/github\.com\/mgifford\/tune-my-repos\/policy\//);
  }
});

test('the validate-resource CLI succeeds on fixtures and fails on a broken file', () => {
  const ok = spawnSync(process.execPath, [path.join(root, 'scripts', 'validate-resource.cjs'), path.join(fixtures, 'resource-rollup.sample.json')], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /valid rollup/);
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tmr-invalid-'));
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, JSON.stringify({ schema_version: '1.0.0', event_id: 'nope' }));
  const bad = spawnSync(process.execPath, [path.join(root, 'scripts', 'validate-resource.cjs'), file], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
});

test('the rollup schema rejects a raw repository name and a single score field', () => {
  const rollup = read(path.join(fixtures, 'resource-rollup.sample.json'));
  const schema = read(path.join(root, 'policy', 'resource-rollup.schema.json'));
  const withName = { ...rollup, project_name: 'mgifford/tune-my-repos' };
  assert.ok(validatePolicySchema(withName, schema).length > 0);
  const withScore = { ...rollup, sustainability_score: 42 };
  assert.ok(validatePolicySchema(withScore, schema).length > 0);
});
