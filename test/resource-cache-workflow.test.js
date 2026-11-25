const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('the cache check runs quarterly and uses the previous rollup plus scan state', () => {
  const yaml = fs.readFileSync(path.join(root, '.github', 'workflows', 'inventory-cache-check.yml'), 'utf8');
  assert.match(yaml, /cron: '0 8 1 1,4,7,10 \*'/);
  assert.match(yaml, /maintenance-rollup\.public\.json/);
  assert.match(yaml, /--dry-run/);
  assert.match(yaml, /record-inventory-cache\.cjs/);
  assert.match(yaml, /resource-cache-history\.json/);
  assert.match(yaml, /MAINTENANCE_DATA_TOKEN/);
});

test('the cache check publishes privately and does not touch public resource data', () => {
  const yaml = fs.readFileSync(path.join(root, '.github', 'workflows', 'inventory-cache-check.yml'), 'utf8');
  assert.doesNotMatch(yaml, /resource-data\//);
  assert.doesNotMatch(yaml, /gh pr create|gh pr merge/);
  assert.match(yaml, /cache-efficiency\.resource\.json/);
  assert.match(yaml, /CACHE-EFFICIENCY\.md/);
});
