const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Runs the auto-merge step's shell from dependabot-pilot.yml against a stub
// `gh`, so its decisions are tested without GitHub. Set PILOT_WORKFLOW to
// check another repository's copy of the workflow.
const workflowPath = process.env.PILOT_WORKFLOW
  || path.join(__dirname, '..', '.github', 'workflows', 'dependabot-pilot.yml');

function stepScript(name) {
  const lines = fs.readFileSync(workflowPath, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  const runAt = lines.findIndex((l, i) => i > start && /^ {8}run: \|$/.test(l));
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-automerge-'));
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
fs.writeFileSync(path.join(tempDir, 'gh'), [
  '#!/usr/bin/env bash',
  'echo "$*" >> "$GH_CALLS"',
  'case "$1 $2" in',
  '  "pr view") echo "$FAKE_MERGE_STATE" ;;',
  '  "pr merge") exit "${FAKE_MERGE_EXIT:-0}" ;;',
  'esac',
].join('\n'), { mode: 0o755 });

function runStep(mergeState, mergeExit = 0) {
  const calls = path.join(tempDir, `calls-${mergeState}-${mergeExit}`);
  fs.writeFileSync(calls, '');
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', stepScript('Enable auto-merge for eligible updates only')], {
    encoding: 'utf8',
    env: {
      PATH: `${tempDir}:${process.env.PATH}`,
      GH_CALLS: calls,
      FAKE_MERGE_STATE: mergeState,
      FAKE_MERGE_EXIT: String(mergeExit),
      GH_TOKEN: 'stub',
      PR_NUMBER: '61',
      HEAD_SHA: 'f943c99',
    },
  });
  return { status: result.status, stdout: result.stdout, calls: fs.readFileSync(calls, 'utf8') };
}

// gh merges at once instead of queueing for these states (cli/cli
// pkg/cmd/pr/merge/merge.go, isImmediatelyMergeable). The pilot's token
// cannot merge directly, so the job must not try (a11y-svg PR 61 failed so).
for (const state of ['CLEAN', 'HAS_HOOKS', 'UNSTABLE']) {
  test(`auto-merge step: an already mergeable PR (${state}) is left for a person, not merged`, () => {
    const result = runStep(state, 1);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.calls, /pr merge/);
    assert.match(result.stdout, /::notice::.*merge it by hand/i);
  });
}

test('auto-merge step: a PR still waiting on checks gets auto-merge queued', () => {
  const result = runStep('BLOCKED');
  assert.equal(result.status, 0);
  assert.match(result.calls, /^pr merge --auto --squash --match-head-commit f943c99 61$/m);
});

test('auto-merge step: any other gh failure still fails the job', () => {
  assert.notEqual(runStep('BLOCKED', 1).status, 0);
});
