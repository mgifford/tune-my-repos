const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('the public-refresh workflow runs after the monthly cycle and never auto-merges', () => {
  const yaml = fs.readFileSync(path.join(root, '.github', 'workflows', 'publish-resource-pages.yml'), 'utf8');
  assert.match(yaml, /workflow_run:/);
  assert.match(yaml, /workflows: \["Monthly Resource Cycle"\]/);
  assert.match(yaml, /resource-data\/resource-rollup\.public\.json/);
  assert.match(yaml, /node scripts\/validate-resource\.cjs/);
  assert.match(yaml, /MAINTENANCE_DATA_TOKEN/);
  assert.match(yaml, /gh pr create/);
  assert.doesNotMatch(yaml, /gh pr merge/);
  assert.doesNotMatch(yaml, /--auto/);
});

test('the public-refresh workflow only copies aggregate files, not the ledger or tasks', () => {
  const yaml = fs.readFileSync(path.join(root, '.github', 'workflows', 'publish-resource-pages.yml'), 'utf8');
  assert.match(yaml, /for FILE in resource-rollup\.public\.json RESOURCE-SUMMARY\.md resource-summary\.csv/);
  assert.doesNotMatch(yaml, /events\.jsonl|tasks\.jsonl|\.resource-cache|local-resource-evidence/);
});
