const test = require('node:test');
const assert = require('node:assert/strict');

const { getMaintenanceLabelNames } = require('../.github/scripts/maintenance-label-names.js');
const { VALID_DEPENDENCY_CLASSES, VALID_UPDATE_TYPES, VALID_RISK_STATES } = require('../policy/policy-engine.js');

test('getMaintenanceLabelNames: includes a label for every dependency class', () => {
  const names = getMaintenanceLabelNames();
  for (const cls of VALID_DEPENDENCY_CLASSES) {
    assert.ok(names.includes(`maintenance:${cls}`), `missing label for dependency class "${cls}"`);
  }
});

test('getMaintenanceLabelNames: includes a label for every update type', () => {
  const names = getMaintenanceLabelNames();
  for (const type of VALID_UPDATE_TYPES) {
    assert.ok(names.includes(`maintenance:${type}`), `missing label for update type "${type}"`);
  }
});

test('getMaintenanceLabelNames: includes a label for every risk state', () => {
  const names = getMaintenanceLabelNames();
  for (const state of VALID_RISK_STATES) {
    assert.ok(names.includes(`maintenance:${state}`), `missing label for risk state "${state}"`);
  }
});

test('getMaintenanceLabelNames: includes "maintenance:unknown" for an unparseable update_type, not just dependency_class', () => {
  const names = getMaintenanceLabelNames();
  assert.ok(names.includes('maintenance:unknown'));
});

test('getMaintenanceLabelNames: contains no duplicate names even though some values overlap (e.g. "major", "unknown")', () => {
  const names = getMaintenanceLabelNames();
  assert.equal(names.length, new Set(names).size);
});

test('getMaintenanceLabelNames: every name has the maintenance: prefix', () => {
  const names = getMaintenanceLabelNames();
  assert.ok(names.every((n) => n.startsWith('maintenance:')));
});
