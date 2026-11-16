/**
 * Checks rollup files against policy/rollup.schema.json. The Maintenance
 * Inventory workflow runs it after the rollup is generated and before
 * anything is uploaded or published; any violation fails the job.
 *
 * Usage: node scripts/validate-rollup.cjs <file> [<file> ...]
 */

const fs = require('node:fs');
const path = require('node:path');
const { validatePolicySchema } = require('../policy/policy-validator.cjs');

/** @returns {string[]} problems found; empty if the file is valid */
function validateRollupFile(filePath, schema) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return [`cannot read file: ${error.code || error.message}`];
  }
  let rollup;
  try {
    rollup = JSON.parse(text);
  } catch {
    return ['not valid JSON'];
  }
  return validatePolicySchema(rollup, schema);
}

function main(files) {
  if (files.length === 0) {
    console.error('Usage: node scripts/validate-rollup.cjs <file> [<file> ...]');
    return 1;
  }
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'policy', 'rollup.schema.json'), 'utf8'));
  let failed = false;
  for (const file of files) {
    const errors = validateRollupFile(file, schema);
    if (errors.length === 0) {
      console.log(`${file}: valid`);
      continue;
    }
    failed = true;
    console.error(`${file}: ${errors.length} schema violation(s)`);
    for (const e of errors) console.error(`  - ${e}`);
  }
  return failed ? 1 : 0;
}

module.exports = { validateRollupFile };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
