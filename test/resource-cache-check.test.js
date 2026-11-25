const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { entryFrom, renderMarkdown, main } = require('../scripts/record-inventory-cache.cjs');

const reportPath = path.join(__dirname, '..', 'fixtures', 'resource', 'resource-rollup.sample.json');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tmr-cache-check-'));
}

test('entryFrom extracts cache and scan-completeness metrics', () => {
  const entry = entryFrom(report);
  assert.equal(entry.requests, 42);
  assert.equal(entry.status_304, 8);
  assert.equal(entry.cache_hits, 8);
  assert.equal(entry.cache_misses, 34);
  assert.equal(entry.repositories_evaluated, 8);
  assert.equal(entry.complete, true);
  assert.ok(entry.cache_hit_rate > 0);
  assert.ok(entry.requests_per_evaluated_repository > 0);
});

test('the cache-check writer appends history and writes an aggregate-only summary', () => {
  const dir = tempDir();
  const history = path.join(dir, 'resource-cache-history.json');
  const out = path.join(dir, 'report');
  assert.equal(main([`--report=${reportPath}`, `--history=${history}`, `--out-dir=${out}`]), 0);
  assert.equal(main([`--report=${reportPath}`, `--history=${history}`, `--out-dir=${out}`]), 0);
  const parsed = JSON.parse(fs.readFileSync(history, 'utf8'));
  assert.equal(parsed.schema_version, '1.0.0');
  assert.equal(parsed.entries.length, 2);
  const markdown = fs.readFileSync(path.join(out, 'CACHE-EFFICIENCY.md'), 'utf8');
  assert.match(markdown, /Inventory cache efficiency/);
  assert.match(markdown, /HTTP 304/);
  assert.match(markdown, /42/);
  assert.doesNotMatch(markdown, /mgifford|example\/public-repo|\/Users\/|ghp_/);
});

test('the cache-check writer fails clearly when the report is missing', () => {
  const dir = tempDir();
  assert.equal(main([`--report=${path.join(dir, 'missing.json')}`, `--history=${path.join(dir, 'history.json')}`]), 2);
});
