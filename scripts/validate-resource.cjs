#!/usr/bin/env node
/**
 * Validate resource evidence against the versioned schemas.
 *
 *   node scripts/validate-resource.cjs fixtures/resource/resource-events.synthetic.jsonl
 *   node scripts/validate-resource.cjs fixtures/resource/resource-rollup.sample.json
 *
 * Detection is by shape, not filename, so a renamed file is still checked.
 */

const fs = require('node:fs');
const path = require('node:path');

const { validatePolicySchema } = require('../policy/policy-validator.cjs');
const { publicProblems } = require('../policy/resource-redaction.cjs');

const SCHEMAS = {
  event: path.join(__dirname, '..', 'policy', 'resource-evidence.schema.json'),
  task: path.join(__dirname, '..', 'policy', 'resource-task.schema.json'),
  rollup: path.join(__dirname, '..', 'policy', 'resource-rollup.schema.json'),
  factor: path.join(__dirname, '..', 'policy', 'resource-factor.schema.json'),
};

const cache = new Map();
function loadSchema(kind) {
  if (!cache.has(kind)) cache.set(kind, JSON.parse(fs.readFileSync(SCHEMAS[kind], 'utf8')));
  return cache.get(kind);
}

function detect(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.event_id === 'string' && value.measurements) return 'event';
  if (typeof value.task_id === 'string' && value.verification_evidence) return 'task';
  if (value.local_computing && value.remote_ai) return 'rollup';
  if (value.dataset_kind && Array.isArray(value.models)) return 'factor';
  return null;
}

function validateValue(value) {
  const kind = detect(value);
  if (!kind) return { kind: null, problems: ['unknown resource document shape'] };
  const problems = validatePolicySchema(value, loadSchema(kind));
  // A rollup is intended for publication; always apply the fail-closed privacy
  // scan in addition to schema validation. Local event files are not scanned
  // here because they legitimately contain local task labels and evidence paths.
  if (kind === 'rollup') problems.push(...publicProblems(value));
  return { kind, problems };
}

function validateFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const trimmed = text.trim();
  if (!trimmed) return [{ line: 1, kind: null, problems: ['empty file'] }];
  let values;
  try {
    values = [JSON.parse(trimmed)];
  } catch {
    values = trimmed.split('\n').filter((line) => line.trim()).map((line, index) => {
      try { return JSON.parse(line); } catch (error) { return { __parseError: `line ${index + 1}: ${error.message}` }; }
    });
  }
  return values.map((value, index) => {
    if (value && value.__parseError) return { line: index + 1, kind: null, problems: [value.__parseError] };
    const result = validateValue(value);
    return { line: index + 1, ...result };
  });
}

function main(files) {
  if (!files.length) {
    console.error('Usage: node scripts/validate-resource.cjs <file> [<file> ...]');
    return 2;
  }
  let failed = false;
  for (const file of files) {
    let results;
    try {
      results = validateFile(file);
    } catch (error) {
      console.error(`${file}: ${error.message}`);
      failed = true;
      continue;
    }
    for (const result of results) {
      if (result.problems.length) {
        failed = true;
        console.error(`${file}${results.length > 1 ? ` line ${result.line}` : ''}: ${result.kind || 'unknown'} has ${result.problems.length} problem(s)`);
        for (const problem of result.problems.slice(0, 12)) console.error(`  - ${problem}`);
      } else {
        console.log(`${file}${results.length > 1 ? ` line ${result.line}` : ''}: valid ${result.kind}`);
      }
    }
  }
  return failed ? 1 : 0;
}

module.exports = { SCHEMAS, detect, validateValue, validateFile, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
