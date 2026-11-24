const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderResourceDashboard, renderTable, renderCsv, formatNumber, formatBytes, escapeHtml } = require('../policy/resource-view.cjs');

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'resource', 'resource-rollup.sample.json'), 'utf8'));

test('the dashboard renders semantic tables with captions and column headers', () => {
  const html = renderResourceDashboard(sample);
  assert.match(html, /<table /);
  assert.match(html, /<caption/);
  assert.match(html, /<th scope="col"/);
  assert.match(html, /<h2 id="local-computing-heading">Local computing<\/h2>/);
  assert.doesNotMatch(html, /role="table"/);
  assert.doesNotMatch(html, /<p[^>]*>\s*<table/, 'descriptions must not be children of a table');
});

test('missing values render as an em dash and a measured zero renders as zero', () => {
  assert.equal(formatNumber(null), '—');
  assert.equal(formatNumber(0), '0');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(null), '—');
  const clone = JSON.parse(JSON.stringify(sample));
  clone.local_computing.energy.estimated_wh = 0;
  clone.local_computing.emissions_gco2e = 0;
  const html = renderResourceDashboard(clone);
  assert.match(html, />0 Wh</);
  assert.match(html, />0 gCO2e</);
});

test('all text is escaped, including limitations and model names', () => {
  const clone = JSON.parse(JSON.stringify(sample));
  clone.limitations = ['<script>alert("x")</script>'];
  clone.remote_ai.by_model[0].model = '<img src=x onerror=alert(1)>';
  const html = renderResourceDashboard(clone);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
});

test('the dashboard shows coverage, uncertainty and unsupported models without a single score', () => {
  const html = renderResourceDashboard(sample);
  assert.match(html, /Coverage/);
  assert.match(html, /Standard deviation Wh/);
  assert.match(html, /Models without a usable per-token factor/);
  assert.match(html, /No single sustainability score is calculated/);
  assert.doesNotMatch(html, /class="[^"]*score/);
  assert.doesNotMatch(html, /Sustainability score:/);
});

test('table rows include every data row and an empty-state row', () => {
  const table = renderTable({
    id: 'test-table',
    caption: 'Test caption',
    description: 'Test description',
    columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', numeric: true }],
    rows: [{ a: 'one', b: '2' }],
  });
  assert.match(table, /<caption id="test-table-caption">Test caption<\/caption>/);
  assert.match(table, /aria-describedby="test-table-description"/);
  assert.match(table, /<td class="numeric">2<\/td>/);
  const empty = renderTable({ id: 'empty', caption: 'Empty', columns: [{ key: 'a', label: 'A' }], rows: [] });
  assert.match(empty, /colspan="1"/);
  assert.match(empty, /No evidence in this window/);
});

test('the CSV export has a header and includes coverage', () => {
  const csv = renderCsv(sample);
  assert.match(csv, /^section,metric,unit,value,coverage/m);
  assert.match(csv, /remote_ai,requests,count,2/);
});

test('the dashboard defaults to a tracked fixture so CI does not request an unpublished report', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'resources.html'), 'utf8');
  const fixtureOption = html.match(/<option value="fixtures\/resource\/resource-rollup\.sample\.json"[^>]*>/)?.[0] || '';
  const liveOption = html.match(/<option value="reports\/resources\/resource-rollup\.public\.json"[^>]*>/)?.[0] || '';
  assert.match(fixtureOption, /selected/);
  assert.doesNotMatch(liveOption, /selected/);
});

test('the static page has a labelled source control, live status and no sign-in token field', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'resources.html'), 'utf8');
  assert.match(html, /<label for="resourceSource">Resource rollup<\/label>/);
  assert.match(html, /id="resourceStatus"[^>]*role="status"/);
  assert.match(html, /id="resourceError"[^>]*role="alert"/);
  assert.match(html, /<noscript>/);
  assert.doesNotMatch(html, /type="password"/);
  assert.match(html, /href="maintenance.html"/);
});

test('the dashboard script fetches only local files and has no provider or telemetry endpoint', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'resources.js'), 'utf8');
  assert.doesNotMatch(js, /api\.github\.com|api\.openai\.com|anthropic\.com|codecarbon\.io/);
  assert.match(js, /policy\/resource-rollup\.schema\.json/);
  assert.match(js, /fixtures\/resource\/resource-rollup\.sample\.json/);
  assert.match(js, /window\.PolicyValidator/);
});

test('a rollup with an unsupported schema version is refused', () => {
  const html = renderResourceDashboard({ schema_version: '2.0.0' });
  assert.match(html, /role="alert"/);
  assert.match(html, /unsupported schema version/);
});

test('the dashboard render guard does not call itself recursively', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'resources.js'), 'utf8');
  assert.equal((js.match(/safeRender\(/g) || []).length, 2, 'one definition and one call site');
  assert.match(js, /function safeRender\(rollup\) \{\n    try \{\n      render\(rollup\);/);
});
