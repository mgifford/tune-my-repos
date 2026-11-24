#!/usr/bin/env node
/**
 * Stable task records for resource accounting.
 *
 *   node scripts/resource-task.cjs start repository-inventory --activity=repository-inventory \
 *     --label="Weekly inventory" --deliverable=inventory
 *   node scripts/resource-task.cjs verify repository-inventory --kind=artifact \
 *     --evidence=reports/resources/RESOURCE-SUMMARY.md --summary="Inventory report reviewed"
 *   node scripts/resource-task.cjs list
 *
 * A task only becomes completed_verified through `verify`. A successful
 * command run does not do that automatically.
 */

const path = require('node:path');

const { projectInfo, nowIso } = require('./lib/resource/measure.cjs');
const {
  startTask, updateTask, verifyTask, getTask, taskStates, taskFile,
} = require('./lib/resource/tasks.cjs');
const { loadTasks } = require('./lib/resource/ledger.cjs');

function usage() {
  return `Usage: node scripts/resource-task.cjs <command> [options]

Commands:
  start <task-id>     Create or resume a task (state in_progress).
  update <task-id>    Update state and optionally add evidence.
  verify <task-id>    Mark completed_verified with evidence.
  list                List tasks (latest revision per task).
  show <task-id>      Show one task.

Options:
  --activity=<id>          Task activity/workload.
  --project=<owner/name>   Project (default: derived from git origin).
  --kind=<id>              Task kind.
  --label=<text>           Local-only label.
  --issue=<ref>            Related issue.
  --pr=<ref>               Related pull request.
  --deliverable=<id>       Expected deliverable.
  --state=<state>          ${taskStates().join(', ')}
  --verified               Record verification state true.
  --no-verified            Record verification state false.
  --evidence=<ref>         Verification evidence reference (local path/hash/description).
  --evidence-kind=<kind>   command, test, review, artifact, manual, other.
  --summary=<text>         Short evidence summary.
  --note=<text>            Add a local note.
  --file=<path>            Task ledger path (default: .resource-cache/ledger/tasks.jsonl).
  --json                   Print JSON.
  --help                   Show this help.

Task records and evidence paths are local only and are never published.`;
}

function parseArgs(argv) {
  const value = (name) => {
    const prefix = `--${name}=`;
    const found = argv.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  };
  const has = (name) => argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  return { value, has, positional };
}

function printTask(task, json) {
  if (json) { console.log(JSON.stringify(task, null, 2)); return; }
  console.log(`${task.task_id}: ${task.state}${task.verified ? ' (verified)' : ''}`);
  console.log(`  project: ${task.project}`);
  console.log(`  activity: ${task.activity}; kind: ${task.kind}`);
  console.log(`  started: ${task.started_at || '—'}; completed: ${task.completed_at || '—'}`);
  console.log(`  attempts: ${task.attempts?.total ?? 0} (${task.attempts?.failed ?? 0} failed, ${task.attempts?.retries ?? 0} retries)`);
  console.log(`  resource events: ${task.resource_event_ids.length}`);
  console.log(`  verification evidence: ${task.verification_evidence.length}`);
}

async function main(argv) {
  const { value, has, positional } = parseArgs(argv);
  if (has('help') || positional.length === 0) { console.log(usage()); return has('help') ? 0 : 2; }
  const command = positional[0];
  const taskId = positional[1];
  const file = value('file') || taskFile();
  const info = projectInfo(process.cwd());
  const json = has('json');

  if (command === 'list') {
    const loaded = loadTasks({ file });
    if (json) console.log(JSON.stringify({ tasks: loaded.tasks, invalid: loaded.invalid }, null, 2));
    else {
      if (loaded.tasks.length === 0) console.log('No tasks recorded.');
      for (const task of loaded.tasks) {
        console.log(`${task.task_id}\t${task.state}\tverified=${task.verified}\tevents=${task.resource_event_ids.length}\tattempts=${task.attempts.total}\t${task.label || ''}`);
      }
    }
    return loaded.invalid.length ? 1 : 0;
  }

  if (!taskId) { console.error(`"${command}" requires a task id\n\n${usage()}`); return 2; }

  if (command === 'start') {
    const task = await startTask({
      taskId,
      project: value('project') || info.project,
      activity: value('activity') || 'unknown',
      kind: value('kind') || 'maintenance',
      label: value('label'),
      issue: value('issue'),
      pullRequest: value('pr'),
      deliverable: value('deliverable') || 'none',
      startedAt: nowIso(),
      file,
    });
    printTask(task, json);
    return 0;
  }

  if (command === 'update') {
    const state = value('state');
    if (state && !taskStates().includes(state)) { console.error(`invalid state "${state}"`); return 2; }
    const current = getTask(taskId, { file });
    const verified = has('verified')
      ? true
      : (has('no-verified')
        ? false
        : (state && state !== 'completed_verified' ? false : Boolean(current?.verified)));
    const task = await updateTask({
      taskId,
      state,
      verified,
      evidence: value('evidence') ? {
        kind: value('evidence-kind') || 'manual',
        reference: value('evidence'),
        summary: value('summary'),
        recorded_at: nowIso(),
      } : null,
      note: value('note'),
      file,
    });
    printTask(task, json);
    return 0;
  }

  if (command === 'verify') {
    if (!value('evidence')) { console.error('verify requires --evidence=<ref>'); return 2; }
    const task = await verifyTask({
      taskId,
      evidence: {
        kind: value('evidence-kind') || 'manual',
        reference: value('evidence'),
        summary: value('summary'),
      },
      file,
    });
    printTask(task, json);
    return 0;
  }

  if (command === 'show') {
    const task = getTask(taskId, { file });
    if (!task) { console.error(`unknown task "${taskId}"`); return 1; }
    printTask(task, true);
    return 0;
  }

  console.error(`unknown command "${command}"\n\n${usage()}`);
  return 2;
}

module.exports = { parseArgs, main };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[resource-task] ${error.message}`);
    process.exitCode = 2;
  });
}
