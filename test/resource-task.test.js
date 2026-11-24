const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  startTask, updateTask, verifyTask, getTask, makeTask, validateResourceTask, taskStates, assertTaskId,
} = require('../scripts/lib/resource/tasks.cjs');
const { recordEvent } = require('../scripts/lib/resource/tasks.cjs');
const { makeEvent } = require('../scripts/lib/resource/event.cjs');
const { loadTasks } = require('../scripts/lib/resource/ledger.cjs');

function tempLedger() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmr-tasks-')), 'tasks.jsonl');
}

test('task states cover every required outcome', () => {
  for (const state of ['completed_verified', 'completed_unverified', 'failed', 'abandoned', 'blocked', 'in_progress', 'unknown']) {
    assert.ok(taskStates().includes(state));
  }
  assert.ok(taskStates().includes('planned'));
});

test('start, update and verify append revisions and preserve evidence', async () => {
  const file = tempLedger();
  const started = await startTask({ taskId: 'inventory', project: 'example/public-repo', activity: 'repository-inventory', kind: 'maintenance', label: 'Inventory', deliverable: 'inventory', file });
  assert.equal(started.state, 'in_progress');
  assert.equal(started.verified, false);
  assert.equal(started.revision, 1);
  const updated = await updateTask({ taskId: 'inventory', state: 'completed_unverified', note: 'Needs review', file });
  assert.equal(updated.state, 'completed_unverified');
  assert.equal(updated.revision, 2);
  const verified = await verifyTask({ taskId: 'inventory', evidence: { kind: 'artifact', reference: 'reports/inventory.md', summary: 'Reviewed' }, file });
  assert.equal(verified.state, 'completed_verified');
  assert.equal(verified.verified, true);
  assert.equal(verified.verification_evidence.length, 1);
  assert.equal(verified.verification_evidence[0].kind, 'artifact');
  const loaded = loadTasks({ file });
  assert.equal(loaded.invalid.length, 0);
  assert.equal(loaded.tasks.length, 1);
  assert.equal(loaded.tasks[0].revision, 3);
});

test('a task accepts several resource events and counts failed attempts', async () => {
  const file = tempLedger();
  await startTask({ taskId: 'multi', project: 'example/public-repo', activity: 'test-suite', kind: 'tooling', file });
  const success = makeEvent({
    measurement_id: 'measure-1',
    project: 'example/public-repo',
    task: { id: 'multi' },
    activity: 'test-suite',
    outcome: 'success',
    source: { adapter: 'unit-test', method: 'synthetic', confidence: 'measured' },
  });
  const failure = makeEvent({
    measurement_id: 'measure-2',
    project: 'example/public-repo',
    task: { id: 'multi' },
    activity: 'test-suite',
    outcome: 'failure',
    source: { adapter: 'unit-test', method: 'synthetic', confidence: 'measured' },
  });
  await recordEvent({ taskId: 'multi', event: success, file });
  const afterFailure = await recordEvent({ taskId: 'multi', event: failure, file });
  assert.equal(afterFailure.attempts.total, 2);
  assert.equal(afterFailure.attempts.failed, 1);
  assert.equal(afterFailure.state, 'failed');
  assert.deepEqual(afterFailure.resource_event_ids, [success.event_id, failure.event_id]);
});

test('a task record validates against its schema and rejects bad ids or states', () => {
  const task = makeTask({ task_id: 'valid-task', project: 'example/public-repo', activity: 'test-suite', kind: 'tooling', state: 'planned' });
  assert.deepEqual(validateResourceTask(task), []);
  assert.throws(() => makeTask({ task_id: 'Bad Task!', project: 'example/public-repo' }), /invalid task id/);
  assert.throws(() => assertTaskId('UPPER'), /invalid task id/);
  const badState = { ...task, state: 'done' };
  assert.ok(validateResourceTask(badState).some((problem) => problem.includes('done')));
});

test('a task can be blocked or abandoned without claiming verification', async () => {
  const file = tempLedger();
  await startTask({ taskId: 'blocked-task', project: 'example/public-repo', activity: 'dependabot-repair', file });
  const blocked = await updateTask({ taskId: 'blocked-task', state: 'blocked', note: 'Waiting for upstream', file });
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.verified, false);
  const abandoned = await updateTask({ taskId: 'blocked-task', state: 'abandoned', file });
  assert.equal(abandoned.state, 'abandoned');
  assert.equal(abandoned.verified, false);
  assert.ok(abandoned.completed_at);
});
