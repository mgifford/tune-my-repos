const test = require('node:test');
const assert = require('node:assert/strict');

const {
  recordScan,
  pruneToRepositories,
  getIssuesEtag,
  recordIssuesEtag,
  canSkipAfterProbe,
} = require('../policy/scan-state.cjs');
const { githubFetch, openIssuesEndpoint } = require('../scripts/generate-maintenance-rollup.cjs');

function stateWith(entries) {
  return { schema_version: '1.0.0', repositories: entries };
}

test('getIssuesEtag: null for a repository with no stored ETag', () => {
  assert.equal(getIssuesEtag(stateWith({}), 'mgifford/x'), null);
  const state = stateWith({ 'mgifford/x': { last_scanned: 'a', last_pushed_at: 'b' } });
  assert.equal(getIssuesEtag(state, 'mgifford/x'), null);
});

test('recordIssuesEtag: stores the ETag without mutating the input', () => {
  const state = stateWith({ 'mgifford/x': { last_scanned: 'a', last_pushed_at: 'b' } });
  const updated = recordIssuesEtag(state, 'mgifford/x', '"abc123"');
  assert.equal(getIssuesEtag(state, 'mgifford/x'), null);
  assert.equal(getIssuesEtag(updated, 'mgifford/x'), '"abc123"');
  assert.equal(updated.repositories['mgifford/x'].last_scanned, 'a');
});

test('recordIssuesEtag: ignores a missing ETag rather than storing null', () => {
  const state = stateWith({ 'mgifford/x': { last_scanned: 'a', last_pushed_at: 'b', issues_etag: '"old"' } });
  assert.equal(getIssuesEtag(recordIssuesEtag(state, 'mgifford/x', null), 'mgifford/x'), '"old"');
});

test('recordScan: keeps the stored ETag when a repository is rescanned', () => {
  const state = stateWith({ 'mgifford/x': { last_scanned: 'a', last_pushed_at: 'b', issues_etag: '"keep"' } });
  const updated = recordScan(state, 'mgifford/x', 'c', 'd');
  assert.equal(updated.repositories['mgifford/x'].issues_etag, '"keep"');
  assert.equal(updated.repositories['mgifford/x'].last_pushed_at, 'c');
});

test('pruneToRepositories: removes the ETag together with the repository', () => {
  const state = stateWith({ 'mgifford/x': { last_scanned: 'a', last_pushed_at: 'b', issues_etag: '"e"' } });
  assert.deepEqual(pruneToRepositories(state, []).repositories, {});
});

test('canSkipAfterProbe: skips only when unchanged by push AND the list is not modified', () => {
  assert.equal(canSkipAfterProbe(true, 'not_modified'), true);
  assert.equal(canSkipAfterProbe(true, 'modified'), false);
  assert.equal(canSkipAfterProbe(false, 'not_modified'), false);
});

test('canSkipAfterProbe: an unreadable or missing probe never allows a skip', () => {
  assert.equal(canSkipAfterProbe(true, 'unknown'), false);
  assert.equal(canSkipAfterProbe(true, undefined), false);
});

test('openIssuesEndpoint: one stable URL, so a stored ETag matches the next request', () => {
  assert.equal(
    openIssuesEndpoint('mgifford/x'),
    '/repos/mgifford/x/issues?state=open&per_page=100&sort=updated&direction=desc'
  );
});

function withStubbedFetch(handler, body) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(body()).finally(() => { globalThis.fetch = original; });
}

test('githubFetch: sends If-None-Match when given an ETag', async () => {
  let seen;
  await withStubbedFetch(async (url, options) => {
    seen = options.headers;
    return new Response('[]', { status: 200, headers: { etag: '"new"' } });
  }, () => githubFetch('/repos/mgifford/x/issues', { etag: '"old"' }));
  assert.equal(seen['If-None-Match'], '"old"');
});

test('githubFetch: sends no If-None-Match without an ETag', async () => {
  let seen;
  await withStubbedFetch(async (url, options) => {
    seen = options.headers;
    return new Response('[]', { status: 200 });
  }, () => githubFetch('/repos/mgifford/x/issues'));
  assert.equal('If-None-Match' in seen, false);
});

test('githubFetch: a 304 is reported as notModified, not as success data', async () => {
  const result = await withStubbedFetch(
    async () => new Response(null, { status: 304 }),
    () => githubFetch('/repos/mgifford/x/issues', { etag: '"old"' })
  );
  assert.equal(result.notModified, true);
  assert.equal(result.status, 304);
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
});

test('githubFetch: a 200 returns the new ETag alongside the data', async () => {
  const result = await withStubbedFetch(
    async () => new Response('[{"number":1}]', { status: 200, headers: { etag: '"fresh"' } }),
    () => githubFetch('/repos/mgifford/x/issues')
  );
  assert.equal(result.ok, true);
  assert.equal(result.etag, '"fresh"');
  assert.deepEqual(result.data, [{ number: 1 }]);
});
