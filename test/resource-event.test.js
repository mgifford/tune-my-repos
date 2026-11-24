const test = require('node:test');
const assert = require('node:assert/strict');

const {
  makeEvent,
  eventId,
  validateEvent,
  publicEvent,
  assertPublicEvent,
  toDrupalCoreLabEvent,
  DCL_ACTIVITY,
  DCL_TASK_STATE,
} = require('../scripts/lib/resource/event.cjs');
const { publicProblems } = require('../policy/resource-redaction.cjs');

function base(overrides = {}) {
  return {
    project: 'example/public-repo',
    task: { id: 'task-1', label: 'Private label', kind: 'maintenance', state: 'completed_unverified', expected_deliverable: 'inventory', verified: false },
    activity: 'repository-inventory',
    tool: 'unit-test',
    outcome: 'success',
    validation: 'not-run',
    commit: '0123456789abcdef0123456789abcdef01234567',
    source: { adapter: 'unit-test', method: 'synthetic', confidence: 'estimated' },
    measurements: {
      energy: {
        boundary: 'process-and-descendants',
        method: 'codecarbon-process-energy-model',
        source: 'codecarbon',
        source_version: '3.3.3',
        estimated_wh: 0,
        basis: 'estimated',
        coverage: 'partial',
        components: { cpu_wh: 0, ram_wh: 0 },
      },
    },
    quality: { completeness: 'partial', missing: ['gpu_energy'], notes: ['Local note with /Users/example'] },
    private: { command_label: 'npm test', session_id: 'secret-session' },
    ...overrides,
  };
}

test('makeEvent produces a schema-valid event with stable defaults', () => {
  const event = makeEvent(base());
  assert.deepEqual(validateEvent(event), []);
  assert.equal(event.schema_version, '1.0.0');
  assert.match(event.event_id, /^[0-9a-f]{64}$/);
  assert.equal(event.measurements.tokens.token_basis, 'unavailable');
  assert.equal(event.measurements.energy.measured_wh, null);
  assert.equal(event.measurements.energy.estimated_wh, 0, 'a measured/modeled zero stays zero');
  assert.equal(event.measurements.energy.lower_wh, null);
});

test('event ids are deterministic for identical content and change with measurements', () => {
  const identity = { measurement_id: 'measurement-1', occurred_at: '2026-11-20T10:00:00.000Z', recorded_at: '2026-11-20T10:00:01.000Z' };
  const first = makeEvent({ ...base(), ...identity });
  const second = makeEvent({ ...base(), ...identity });
  assert.equal(eventId(first), eventId(second));
  const changed = makeEvent({
    ...base(),
    ...identity,
    measurements: { ...base().measurements, cpu: { total_seconds: 1.5, measurement: 'measured' } },
  });
  assert.notEqual(eventId(first), eventId(changed));
});

test('the schema rejects a missing required field, bad activity and negative numbers', () => {
  const missing = makeEvent(base());
  delete missing.project;
  assert.ok(validateEvent(missing).some((problem) => problem.includes('project')));
  const badActivity = makeEvent(base({ activity: 'not-a-real-activity' }));
  assert.ok(validateEvent(badActivity).some((problem) => problem.includes('not-a-real-activity')));
  const negative = makeEvent(base({ measurements: { energy: { estimated_wh: -1 } } }));
  assert.ok(validateEvent(negative).some((problem) => problem.includes('below minimum')));
});

test('Drupal Core Lab export maps TMR activity and task state and preserves energy in private', () => {
  const event = makeEvent(base());
  const dcl = toDrupalCoreLabEvent(event);
  assert.equal(dcl.activity, DCL_ACTIVITY['repository-inventory']);
  assert.equal(dcl.task.state, DCL_TASK_STATE.completed_unverified);
  assert.equal(dcl.measurements.energy, undefined, 'DCL 1.0.0 has no energy measurement block');
  assert.equal(dcl.measurements.tokens.reasoning_included_in_output, undefined);
  assert.equal(dcl.environment.ddev, null);
  assert.equal(dcl.environment.docker, null);
  assert.equal(dcl.private.tmr_resource.energy.estimated_wh, 0);
  assert.equal(dcl.private.command_label, 'npm test', 'DCL private data stays local');
});

test('public projection hashes attribution and removes private, label, notes and session data', () => {
  const event = makeEvent(base());
  const projected = assertPublicEvent(event);
  assert.match(projected.project_ref, /^[0-9a-f]{12}$/);
  assert.match(projected.task_ref, /^[0-9a-f]{12}$/);
  assert.equal(projected.task_kind, 'maintenance');
  assert.equal(projected.private, undefined);
  assert.equal(projected.task_label, undefined);
  assert.equal(projected.quality.notes, undefined);
  assert.equal(projected.session_id, undefined);
  assert.equal(projected.project, undefined);
  assert.equal(projected.energy.estimated_wh, 0);
});

test('public privacy scanner catches paths, credentials, repository names and forbidden keys', () => {
  assert.ok(publicProblems({ path: '/Users/alice/private' }).some((problem) => problem.includes('private path')));
  assert.ok(publicProblems({ token: 'ghp_abcdefghijklmnopqrstuvwxyz012345' }).some((problem) => problem.includes('secret-shaped')));
  assert.ok(publicProblems({ label: 'mgifford/private-repo' }).some((problem) => problem.includes('repository-shaped')));
  assert.ok(publicProblems({ private: {} }).some((problem) => problem.includes('forbidden public field')));
  assert.deepEqual(publicProblems({ model: 'meta-llama/Llama-3.1-8B-Instruct' }), [], 'model ids may contain slashes');
});

test('public projection of an AI request omits the request id, session hash and raw usage', () => {
  const event = makeEvent(base({
    event_type: 'ai-request',
    activity: 'ai-assisted-investigation',
    provider: 'anthropic',
    model: 'synthetic-model',
    ai: { request_id: 'req-secret-1', session_id_hash: 'a'.repeat(64), requested_model: 'synthetic-model', outcome: 'success' },
    measurements: { tokens: { input_total: 10, uncached_input: 5, output: 2, token_basis: 'provider-reported' } },
  }));
  const projected = publicEvent(event);
  assert.equal(projected.ai.request_id, undefined);
  assert.equal(projected.ai.session_id_hash, undefined);
  assert.equal(projected.tokens.input_total, 10);
});
