#!/usr/bin/env node
'use strict';

/**
 * Usage:
 *   node scripts/generate-digest.cjs --previous prev.json --current curr.json [--out digest.md]
 *   node scripts/generate-digest.cjs --current curr.json --summary
 *
 * --previous may name a file that does not exist (first run): the digest then
 * reports a baseline. No network access, no model calls.
 */

const fs = require('fs');
const { computeDelta, renderDigest, renderSummary } = require('../policy/digest.cjs');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const currentPath = arg('--current');
  if (!currentPath) {
    console.error('--current <rollup.json> is required');
    process.exit(2);
  }
  const current = readJson(currentPath);

  if (process.argv.includes('--summary')) {
    process.stdout.write(renderSummary(current));
    return;
  }

  const previousPath = arg('--previous');
  let previous = null;
  if (previousPath && fs.existsSync(previousPath)) {
    try {
      previous = readJson(previousPath);
    } catch (error) {
      console.error(`Previous rollup unreadable, treating this run as a baseline: ${error.message}`);
    }
  }

  const markdown = renderDigest(computeDelta(previous, current), current);
  const out = arg('--out');
  if (out) fs.writeFileSync(out, markdown);
  else process.stdout.write(markdown);
}

if (require.main === module) main();
