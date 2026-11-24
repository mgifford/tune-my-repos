/**
 * Stable task records for maintenance activities.
 *
 * A successful command is not a successful maintenance outcome. The wrapper
 * records each attempt and its resource events; only an explicit verification
 * call moves a task to completed_verified.
 */

const fs = require('node:fs');
const path = require('node:path');

const { validatePolicySchema } = require('../../../policy/policy-validator.cjs');
const { iso } = require('./event.cjs');
const { ensureDir, ledgerRoot } = require('./paths.cjs');

const SCHEMA_PATH = path.join(__dirname, '..', '..', '..', 'policy', 'resource-task.schema.json');
const SCHEMA_VERSION = '1.0.0';
let cachedSchema = null;

function schema() {
  if (!cachedSchema) cachedSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return cachedSchema;
}

function validateResourceTask(record) {
  return validatePolicySchema(record, schema());
}

function taskFile() {
  return path.join(ledgerRoot(), 'tasks.jsonl');
}

function assertTaskId(taskId) {
  if (!/^[a-z0-9][a-z0-9._:-]{0,119}$/.test(String(taskId || ''))) {
    throw new Error(`invalid task id "${taskId}"; use lower-case letters, digits, dot, colon, underscore or hyphen`);
  }
  return taskId;
}

function makeTask(input = {}) {
  const now = input.updated_at || iso();
  return {
    schema_version: SCHEMA_VERSION,
    task_id: assertTaskId(input.task_id || 'unfiled'),
    project: input.project || 'local/unfiled',
    activity: input.activity || 'unknown',
    kind: input.kind || 'other',
    label: input.label ?? null,
    issue: input.issue ?? null,
    pull_request: input.pull_request ?? null,
    expected_deliverable: input.expected_deliverable || 'none',
    state: input.state || 'planned',
    verified: Boolean(input.verified),
    started_at: input.started_at ?? null,
    completed_at: input.completed_at ?? null,
    updated_at: now,
    revision: input.revision || 1,
    ...(input.replaces ? { replaces: input.replaces } : {}),
    resource_event_ids: [...new Set(input.resource_event_ids || [])],
    verification_evidence: input.verification_evidence || [],
    attempts: input.attempts || { total: 0, failed: 0, retries: 0 },
    notes: (input.notes || []).map((note) => String(note).slice(0, 500)),
    ...(input.private ? { private: input.private } : {}),
  };
}

function assertTask(record) {
  const problems = validateResourceTask(record);
  if (problems.length) throw new Error(`resource task is invalid:\n  ${problems.slice(0, 10).join('\n  ')}`);
  return record;
}

function getTask(taskId, { file = taskFile() } = {}) {
  const { loadTasks } = require('./ledger.cjs');
  return loadTasks({ file }).tasks.find((task) => task.task_id === taskId) || null;
}

async function startTask({
  taskId,
  project,
  activity = 'unknown',
  kind = 'maintenance',
  label = null,
  issue = null,
  pullRequest = null,
  deliverable = 'none',
  startedAt = iso(),
  file = taskFile(),
} = {}) {
  const { appendTask } = require('./ledger.cjs');
  assertTaskId(taskId);
  const previous = getTask(taskId, { file });
  const next = makeTask({
    ...(previous || {}),
    task_id: taskId,
    project: project || previous?.project || 'local/unfiled',
    activity,
    kind,
    label: label ?? previous?.label ?? null,
    issue: issue ?? previous?.issue ?? null,
    pull_request: pullRequest ?? previous?.pull_request ?? null,
    expected_deliverable: deliverable || previous?.expected_deliverable || 'none',
    state: 'in_progress',
    verified: false,
    started_at: previous?.started_at || startedAt,
    completed_at: null,
    updated_at: startedAt,
    resource_event_ids: previous?.resource_event_ids || [],
    verification_evidence: previous?.verification_evidence || [],
    attempts: previous?.attempts || { total: 0, failed: 0, retries: 0 },
    notes: previous?.notes || [],
    private: previous?.private,
  });
  return appendTask(next, { file });
}

async function recordEvent({ taskId, event, project, activity, issue = null, pullRequest = null, label = null, deliverable = 'none', file = taskFile() } = {}) {
  const { appendTask } = require('./ledger.cjs');
  assertTaskId(taskId);
  let current = getTask(taskId, { file });
  if (!current) {
    current = await startTask({
      taskId,
      project: project || event?.project,
      activity: activity || event?.activity,
      kind: event?.task?.kind || 'maintenance',
      label: label || event?.task?.label || null,
      issue,
      pullRequest,
      deliverable,
      startedAt: event?.occurred_at || iso(),
      file,
    });
  }
  const failed = event?.outcome === 'failure' ? 1 : 0;
  const attempts = {
    total: (current.attempts.total || 0) + 1,
    failed: (current.attempts.failed || 0) + failed,
    retries: Math.max(0, (current.attempts.total || 0) + 1 - 1),
  };
  const terminal = ['completed_verified', 'completed_unverified', 'abandoned'].includes(current.state);
  const state = event?.outcome === 'failure'
    ? 'failed'
    : (current.state === 'blocked' ? 'blocked' : (terminal ? current.state : 'in_progress'));
  const next = makeTask({
    ...current,
    project: project || current.project,
    activity: activity || current.activity,
    state,
    verified: current.state === 'completed_verified',
    completed_at: terminal ? current.completed_at : null,
    updated_at: event?.recorded_at || iso(),
    resource_event_ids: [...new Set([...(current.resource_event_ids || []), event.event_id])],
    attempts,
  });
  return appendTask(next, { file });
}

async function updateTask({
  taskId,
  state,
  verified = false,
  evidence = null,
  note = null,
  completedAt = null,
  file = taskFile(),
} = {}) {
  const { appendTask } = require('./ledger.cjs');
  assertTaskId(taskId);
  const current = getTask(taskId, { file });
  if (!current) throw new Error(`unknown task "${taskId}"`);
  const evidenceList = [...(current.verification_evidence || [])];
  if (evidence) {
    evidenceList.push({
      kind: evidence.kind || 'manual',
      reference: evidence.reference ?? null,
      summary: evidence.summary ?? null,
      recorded_at: evidence.recorded_at || iso(),
    });
  }
  const next = makeTask({
    ...current,
    state: state || current.state,
    verified: Boolean(verified),
    completed_at: ['completed_verified', 'completed_unverified', 'failed', 'abandoned'].includes(state)
      ? (completedAt || iso())
      : null,
    updated_at: iso(),
    verification_evidence: evidenceList,
    notes: note ? [...(current.notes || []), String(note).slice(0, 500)] : current.notes,
  });
  return appendTask(next, { file });
}

function verifyTask({ taskId, evidence, summary = null, file = taskFile() } = {}) {
  return updateTask({
    taskId,
    state: 'completed_verified',
    verified: true,
    evidence: {
      kind: evidence?.kind || 'manual',
      reference: evidence?.reference ?? null,
      summary: evidence?.summary || summary,
    },
    file,
  });
}

function taskStates() {
  return Object.freeze([
    'planned', 'in_progress', 'completed_verified', 'completed_unverified',
    'failed', 'abandoned', 'blocked', 'unknown',
  ]);
}

module.exports = {
  SCHEMA_PATH,
  SCHEMA_VERSION,
  schema,
  validateResourceTask,
  taskFile,
  makeTask,
  assertTask,
  assertTaskId,
  getTask,
  startTask,
  recordEvent,
  updateTask,
  verifyTask,
  taskStates,
};
