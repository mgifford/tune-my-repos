const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'summarize-resource-cycle.cjs');
const report = path.join(root, 'fixtures', 'resource', 'resource-rollup.sample.json');

function tempSummary() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmr-cycle-')), 'summary.md');
}

test('resource cycle summary reports API efficiency and scan completeness', () => {
  const summary = tempSummary();
  const result = spawnSync(process.execPath, [script, report], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  assert.equal(result.status, 0, result.stderr);
  const text = fs.readFileSync(summary, 'utf8');
  assert.match(text, /Monthly resource cycle/);
  assert.match(text, /Local energy: 0.039 Wh \(partial\)/);
  assert.match(text, /Local CPU time: 4 CPU-seconds/);
  assert.match(text, /API requests: 42/);
  assert.match(text, /Repositories evaluated: 8/);
  assert.match(text, /Requests per evaluated repository: 5.25/);
  assert.match(text, /Inventory scan complete: yes/);
  assert.doesNotMatch(text, /mgifford|example\/public-repo|\/Users\//);
});

test('resource cycle summary fails clearly when no report exists', () => {
  const summary = tempSummary();
  const result = spawnSync(process.execPath, [script, path.join(os.tmpdir(), 'missing-resource-report.json')], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  assert.equal(result.status, 1);
  assert.match(fs.readFileSync(summary, 'utf8'), /No resource report was generated/);
});
