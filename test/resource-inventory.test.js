const test = require('node:test');
const assert = require('node:assert/strict');

const {
  githubFetch,
  resetApiMetrics,
  getApiMetrics,
  collectActionsMetrics,
  buildInventoryResourceEvents,
  actionsOutcome,
} = require('../scripts/generate-maintenance-rollup.cjs');
const { validateEvent, publicEvent } = require('../scripts/lib/resource/event.cjs');
const { publicProblems } = require('../policy/resource-redaction.cjs');

async function withFetch(handler, body) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

test('githubFetch counts requests, 200/304, cache outcomes, bytes and security reads', async () => {
  resetApiMetrics();
  await withFetch(
    async () => new Response('[{"number":1}]', { status: 200, headers: { etag: '"fresh"' } }),
    () => githubFetch('/repos/example/repo/issues', { cacheCheck: true }),
  );
  let metrics = getApiMetrics();
  assert.equal(metrics.requests, 1);
  assert.equal(metrics.status_200, 1);
  assert.equal(metrics.cache_misses, 1);
  assert.ok(metrics.response_bytes > 0);

  await withFetch(
    async () => new Response(null, { status: 304 }),
    () => githubFetch('/repos/example/repo/issues', { etag: '"old"', cacheCheck: true }),
  );
  metrics = getApiMetrics();
  assert.equal(metrics.status_304, 1);
  assert.equal(metrics.cache_hits, 1);

  await withFetch(
    async () => new Response('{"message":"rate limited"}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    () => githubFetch('/repos/example/repo', { security: true }),
  );
  metrics = getApiMetrics();
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.rate_limited, 1);
  assert.equal(metrics.security_checks, 1);
});

test('a 404 with allow404 still counts as a failed request, not a crash', async () => {
  resetApiMetrics();
  await withFetch(
    async () => new Response('{"message":"not found"}', { status: 404 }),
    () => githubFetch('/repos/example/repo/branches/main/protection', { allow404: true, security: true }),
  );
  assert.equal(getApiMetrics().failed, 1);
  assert.equal(getApiMetrics().security_checks, 1);
});

test('inventory resource events report API counters and scan completeness without repository names', () => {
  resetApiMetrics();
  const metrics = getApiMetrics();
  Object.assign(metrics, {
    requests: 42,
    status_200: 30,
    status_304: 8,
    failed: 4,
    rate_limited: 0,
    cache_hits: 8,
    cache_misses: 34,
    security_checks: 10,
    response_bytes: 123456,
    repositories_discovered: 10,
    repositories_evaluated: 8,
    completeness: false,
  });
  const events = buildInventoryResourceEvents({
    startedAt: '2026-11-24T10:00:00.000Z',
    endedAt: '2026-11-24T10:00:05.000Z',
    project: 'example/control-repo',
    commit: '0123456789abcdef0123456789abcdef01234567',
    candidateCount: 10,
    evaluatedCount: 8,
    carriedForward: 2,
    probeCounts: { not_modified: 5, modified: 3, unknown: 2 },
    dryRun: true,
  });
  assert.equal(events.length, 1);
  const event = events[0];
  assert.deepEqual(validateEvent(event), []);
  assert.equal(event.event_type, 'github-api');
  assert.equal(event.task.id, 'repository-inventory');
  assert.equal(event.measurements.github_api.requests, 42);
  assert.equal(event.measurements.github_api.status_304, 8);
  assert.equal(event.measurements.github_api.repositories_evaluated, 8);
  assert.equal(event.measurements.github_api.repositories_skipped, 2);
  assert.equal(event.measurements.github_api.carried_forward, 2);
  assert.equal(event.measurements.github_api.complete, false);
  assert.equal(event.outcome, 'partial');
  assert.equal(event.quality.completeness, 'partial');
  assert.ok(event.quality.warnings.includes('incomplete-inventory-scan'));
  assert.ok(!JSON.stringify(event).includes('example/repo'));
});

test('Actions evidence separates workflow elapsed time from summed job execution', () => {
  const actions = {
    workflow: 'Maintenance Inventory',
    job: 'inventory',
    event: 'workflow_dispatch',
    runner: 'ubuntu-latest',
    attempt: 1,
    potentially_superseded: null,
    billable_minutes: null,
    queue_seconds: 2,
    run_id: '123',
    job_id: '456',
    conclusion: 'success',
    started_at: '2026-11-24T10:00:00.000Z',
    completed_at: '2026-11-24T10:02:00.000Z',
    artifact_retention_days: null,
    cache_bytes: null,
    job_elapsed_ms: 90000,
    workflow_elapsed_ms: 120000,
    api_available: true,
    requested: true,
    note: 'synthetic',
  };
  const [apiEvent, actionsEvent] = buildInventoryResourceEvents({
    startedAt: '2026-11-24T10:00:00.000Z',
    endedAt: '2026-11-24T10:02:00.000Z',
    project: 'example/control-repo',
    candidateCount: 8,
    evaluatedCount: 8,
    actions,
  });
  assert.equal(apiEvent.measurements.github_api.complete, false);
  assert.equal(actionsEvent.event_type, 'github-actions');
  assert.equal(actionsEvent.duration_ms, 120000);
  assert.equal(actionsEvent.measurements.github.job_elapsed_ms, 90000);
  assert.equal(actionsEvent.measurements.github.runner, 'ubuntu-latest');
  assert.equal(actionsEvent.measurements.github.billable_minutes, null);
  assert.equal(validateEvent(actionsEvent).length, 0);
  const projected = publicEvent(actionsEvent);
  assert.deepEqual(publicProblems(projected), []);
  assert.equal(projected.github.workflow, 'Maintenance Inventory');
});

test('Actions collection is opt-in and records environment metadata without API calls', async () => {
  const previous = { ...process.env };
  process.env.GITHUB_ACTIONS = 'true';
  process.env.GITHUB_RUN_ID = '123';
  process.env.GITHUB_REPOSITORY = 'example/control-repo';
  process.env.GITHUB_WORKFLOW = 'Maintenance Inventory';
  process.env.GITHUB_JOB = 'inventory';
  process.env.GITHUB_EVENT_NAME = 'schedule';
  process.env.GITHUB_RUN_ATTEMPT = '2';
  delete process.env.RESOURCE_COLLECT_ACTIONS;
  resetApiMetrics();
  try {
    const metrics = await collectActionsMetrics();
    assert.equal(metrics.requested, false);
    assert.equal(metrics.api_available, false);
    assert.equal(metrics.workflow, 'Maintenance Inventory');
    assert.equal(metrics.job, 'inventory');
    assert.equal(metrics.attempt, 2);
    assert.equal(getApiMetrics().requests, 0);
  } finally {
    process.env = previous;
  }
});

test('opt-in Actions collection reads the current run and sums job durations', async () => {
  const previous = { ...process.env };
  process.env.GITHUB_ACTIONS = 'true';
  process.env.GITHUB_RUN_ID = '123';
  process.env.GITHUB_REPOSITORY = 'example/control-repo';
  process.env.GITHUB_WORKFLOW = 'Maintenance Inventory';
  process.env.GITHUB_JOB = 'inventory';
  process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
  process.env.GITHUB_RUN_ATTEMPT = '1';
  process.env.GITHUB_TOKEN = 'ghp_synthetic_token_for_test_only_1234567890';
  process.env.RESOURCE_COLLECT_ACTIONS = '1';
  resetApiMetrics();
  try {
    const metrics = await withFetch(async (url) => {
      if (url.includes('/jobs')) {
        return new Response(JSON.stringify({
          jobs: [
            { id: 1, name: 'inventory', status: 'completed', conclusion: 'success', started_at: '2026-11-24T10:00:10.000Z', completed_at: '2026-11-24T10:01:40.000Z', labels: ['ubuntu-latest'] },
            { id: 2, name: 'matrix-extra', status: 'completed', conclusion: 'success', started_at: '2026-11-24T10:01:40.000Z', completed_at: '2026-11-24T10:02:00.000Z', labels: ['ubuntu-latest'] },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: 123,
        name: 'Maintenance Inventory',
        event: 'workflow_dispatch',
        status: 'completed',
        conclusion: 'success',
        run_attempt: 1,
        created_at: '2026-11-24T10:00:00.000Z',
        run_started_at: '2026-11-24T10:00:05.000Z',
        updated_at: '2026-11-24T10:02:00.000Z',
      }), { status: 200 });
    }, () => collectActionsMetrics());
    assert.equal(metrics.api_available, true);
    assert.equal(metrics.workflow_elapsed_ms, 115000);
    assert.equal(metrics.job_elapsed_ms, 110000);
    assert.equal(metrics.runner, 'ubuntu-latest');
    assert.equal(getApiMetrics().requests, 0, 'optional Actions metadata must not distort scan API efficiency');
  } finally {
    process.env = previous;
  }
});

test('Actions conclusions map to the normalized outcome enum', () => {
  assert.equal(actionsOutcome('success'), 'success');
  assert.equal(actionsOutcome('failure'), 'failure');
  assert.equal(actionsOutcome('cancelled'), 'cancelled');
  assert.equal(actionsOutcome('skipped'), 'partial');
  assert.equal(actionsOutcome(null), 'unknown');
});
