const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { publicProblems, assertPublicResource } = require('../policy/resource-redaction.cjs');
const { makeEvent, publicEvent, assertPublicEvent } = require('../scripts/lib/resource/event.cjs');
const { buildResourceRollup, renderResourceMarkdown, renderResourceCsv } = require('../scripts/lib/resource/rollup.cjs');

function sensitiveEvent() {
  return makeEvent({
    project: 'mgifford/private-repository',
    issue: '123',
    task: { id: 'secret-task', label: 'Private maintenance work', kind: 'maintenance', state: 'completed_verified', verified: true },
    activity: 'repository-inventory',
    model: 'private-model',
    provider: 'provider',
    measurements: {
      energy: { source: 'codecarbon', source_version: '3.3.3', coverage: 'partial', estimated_wh: 1, basis: 'estimated' },
      tokens: { input_total: 10, output: 2, token_basis: 'provider-reported' },
    },
    ai: { request_id: 'req-secret-123', session_id_hash: 'a'.repeat(64), outcome: 'success' },
    quality: { completeness: 'partial', missing: [], notes: ['Read /Users/alice/private/file.txt with ghp_abcdefghijklmnopqrstuvwxyz012345'] },
    private: {
      cwd: '/Users/alice/private-repo',
      command_label: 'ghp_abcdefghijklmnopqrstuvwxyz012345 npm test',
      session_id: 'raw-session-id',
      prompt: 'raw prompt text',
      raw_usage: { prompt_tokens: 10 },
    },
  });
}

test('the public problem scanner rejects paths, secrets, repository names and forbidden keys', () => {
  assert.ok(publicProblems({ value: '/Users/alice/file' }).length > 0);
  assert.ok(publicProblems({ value: 'ghp_abcdefghijklmnopqrstuvwxyz012345' }).length > 0);
  assert.ok(publicProblems({ value: 'owner/private-repo' }).length > 0);
  assert.ok(publicProblems({ notes: 'any note' }).length > 0);
  assert.ok(publicProblems({ private: {} }).length > 0);
  assert.throws(() => assertPublicResource({ project_name: 'owner/repo' }), /not publishable/);
});

test('public event projection removes every sensitive field present in the local event', () => {
  const event = sensitiveEvent();
  const projected = assertPublicEvent(event);
  const serialized = JSON.stringify(projected);
  for (const forbidden of [
    'mgifford/private-repository',
    'private-repository',
    'secret-task',
    'Private maintenance work',
    'req-secret-123',
    'raw-session-id',
    'raw prompt text',
    '/Users/alice',
    'ghp_abcdefghijklmnopqrstuvwxyz012345',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `public projection leaked ${forbidden}`);
  }
  assert.match(serialized, /"project_ref":"[0-9a-f]{12}"/);
  assert.match(serialized, /"task_ref":"[0-9a-f]{12}"/);
  assert.equal(projected.energy.estimated_wh, 1, 'safe aggregate evidence remains');
  assert.equal(projected.tokens.input_total, 10);
});

test('the public rollup and all exports contain no private repository, task label, command, path or credential', () => {
  const event = sensitiveEvent();
  const tasks = [{
    schema_version: '1.0.0', task_id: 'secret-task', project: 'mgifford/private-repository',
    activity: 'repository-inventory', kind: 'maintenance', label: 'Private maintenance work',
    issue: null, pull_request: null, expected_deliverable: 'inventory', state: 'completed_verified',
    verified: true, started_at: '2026-11-20T10:00:00.000Z', completed_at: '2026-11-20T11:00:00.000Z',
    updated_at: '2026-11-20T11:00:00.000Z', revision: 1, resource_event_ids: [], verification_evidence: [{ kind: 'artifact', reference: '/Users/alice/evidence.md', summary: 'Private', recorded_at: '2026-11-20T11:00:00.000Z' }],
    attempts: { total: 1, failed: 0, retries: 0 }, notes: ['Private note'],
  }];
  const rollup = buildResourceRollup({ events: [event], tasks });
  const outputs = [JSON.stringify(rollup), renderResourceMarkdown(rollup), renderResourceCsv(rollup)].join('\n');
  for (const forbidden of ['mgifford/private-repository', 'secret-task', 'Private maintenance work', '/Users/alice', 'ghp_', 'raw prompt']) {
    assert.equal(outputs.includes(forbidden), false, `public output leaked ${forbidden}`);
  }
  assert.equal(rollup.project_count, 1, 'the count is safe even when the name is not');
});

test('private task evidence is never included in the public task count or labels', () => {
  const event = sensitiveEvent();
  const rollup = buildResourceRollup({ events: [event], tasks: [] });
  assert.equal(JSON.stringify(rollup).includes('verification_evidence'), false);
  assert.equal(JSON.stringify(rollup).includes('resource_event_ids'), false);
});

test('raw resource storage is gitignored and reports are not committed by default', () => {
  const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.match(gitignore, /^\/?\.resource-cache\/$/m);
  assert.match(gitignore, /^\/?reports\/resources\/$/m);
});
