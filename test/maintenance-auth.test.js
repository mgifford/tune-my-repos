const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeToken, buildDataRequest, describeAuthFailure, DATA_REPO, DATA_PATH } = require('../policy/maintenance-auth.cjs');

test('normalizeToken trims whitespace and rejects empty or malformed input', () => {
  assert.equal(normalizeToken('  github_pat_abc123  '), 'github_pat_abc123');
  assert.equal(normalizeToken(''), null);
  assert.equal(normalizeToken('   '), null);
  assert.equal(normalizeToken('has space inside'), null);
  assert.equal(normalizeToken(undefined), null);
});

test('buildDataRequest targets the private data repo with a bearer token', () => {
  const req = buildDataRequest('tok');
  assert.equal(req.url, `https://api.github.com/repos/${DATA_REPO}/contents/${DATA_PATH}`);
  assert.equal(req.headers.Authorization, 'Bearer tok');
  assert.match(req.headers.Accept, /raw/);
});

test('buildDataRequest refuses to build without a token', () => {
  assert.throws(() => buildDataRequest(null));
});

test('describeAuthFailure gives actionable, non-leaking messages', () => {
  assert.match(describeAuthFailure(401), /rejected/i);
  assert.match(describeAuthFailure(403), /permission|rate/i);
  assert.match(describeAuthFailure(404), /private data repository|access/i);
  assert.match(describeAuthFailure(500), /500/);
});

test('the sensitive rollup is no longer published from this public repository', () => {
  const root = path.join(__dirname, '..');
  assert.equal(fs.existsSync(path.join(root, 'maintenance-rollup.public.json')), false);
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/maintenance-inventory.yml'), 'utf8');
  assert.doesNotMatch(workflow, /git add maintenance-scan-state\.json maintenance-rollup\.public\.json/);
  assert.match(workflow, /MAINTENANCE_DATA_TOKEN/);
  const html = fs.readFileSync(path.join(root, 'maintenance.html'), 'utf8');
  assert.doesNotMatch(html, /value="maintenance-rollup\.public\.json"/);
});
