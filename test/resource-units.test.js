const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseCodeCarbonCsv,
  normalizeCodeCarbonRow,
  toWh,
  toGramsCO2e,
  toBytes,
  parseTimeOutput,
  percent,
} = require('../scripts/lib/resource/units.cjs');

const fixture = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'resource', 'codecarbon-3.3.3-sample.csv'),
  'utf8',
);
const parsed = parseCodeCarbonCsv(fixture);
const rows = parsed.rows.map((row) => normalizeCodeCarbonRow(row));
function rowFor(prefix) {
  const index = parsed.rows.findIndex((row) => row.run_id.startsWith(prefix));
  assert.notEqual(index, -1, `fixture row ${prefix} is present`);
  return rows[index];
}

test('CodeCarbon CSV fixture parses with the documented 3.3.3 header', () => {
  assert.equal(parsed.headers.length, 38);
  assert.equal(parsed.rows.length, 5);
  assert.deepEqual(parsed.problems, []);
  assert.ok(parsed.headers.includes('energy_consumed'));
  assert.ok(parsed.headers.includes('emissions_rate'));
});

test('CodeCarbon kWh energy is normalized to Wh and kg emissions to g', () => {
  const row = rowFor('11111111');
  assert.equal(row.normalized.energy_wh, 0.025);
  assert.equal(row.normalized.emissions_gco2e, 0.000065);
  assert.equal(row.normalized.duration_ms, 12500);
  assert.ok(Math.abs(row.normalized.cpu_wh - 0.015) < 1e-15);
  assert.equal(row.normalized.ram_wh, 0.01);
  assert.ok(Math.abs(row.normalized.carbon_intensity_g_per_kwh - 2.6) < 1e-12);
});

test('source values preserve the original kWh and kg units', () => {
  const row = rowFor('11111111');
  const energy = row.source_values.find((entry) => entry.field === 'energy_consumed');
  const emissions = row.source_values.find((entry) => entry.field === 'emissions');
  assert.deepEqual(energy, { field: 'energy_consumed', value: 2.5e-5, unit: 'kWh', quantity: 'energy' });
  assert.deepEqual(emissions, { field: 'emissions', value: 6.5e-8, unit: 'kgCO2eq', quantity: 'emissions' });
});

test('emissions_rate is kg/s in the CSV and is normalized to g/s', () => {
  const row = rowFor('11111111');
  assert.equal(row.normalized.emissions_rate_g_per_s, 5.2e-6);
});

test('generic unit conversion rejects unsupported units instead of guessing', () => {
  assert.deepEqual(toWh(1, 'kWh'), { value: 1000, ok: true, unit: 'Wh' });
  assert.equal(toWh(3600, 'J').value, 1);
  assert.equal(toWh(1, 'furlongs').ok, false);
  assert.equal(toGramsCO2e(1, 'kg').value, 1000);
  assert.equal(toGramsCO2e(1, 'lb').value, null);
  assert.equal(toBytes(1, 'MiB'), 1024 ** 2);
  assert.equal(percent(1, 4), 25);
  assert.equal(percent(1, 0), null);
});

test('a measured zero stays zero, while missing energy stays null', () => {
  const zero = rowFor('44444444');
  const missing = rowFor('55555555');
  assert.equal(zero.normalized.energy_wh, 0);
  assert.equal(zero.normalized.emissions_gco2e, 0);
  assert.equal(missing.normalized.energy_wh, null);
  assert.equal(missing.normalized.emissions_gco2e, null);
  assert.ok(missing.missing.includes('energy'));
});

test('an undetected GPU is unavailable, not a measured zero', () => {
  const row = rowFor('11111111');
  assert.equal(row.hardware.gpu_available, false);
  assert.equal(row.normalized.gpu_wh, null);
  assert.equal(row.normalized.gpu_power_w, null);
  assert.ok(row.missing.includes('gpu_energy'));
});

test('a detected GPU keeps its energy and power values', () => {
  const row = rowFor('66666666');
  assert.equal(row.hardware.gpu_available, true);
  assert.equal(row.normalized.gpu_wh, 1);
  assert.equal(row.normalized.gpu_power_w, 10);
});

test('water is not reported as a measured zero when WUE is zero', () => {
  const row = rowFor('11111111');
  assert.equal(row.normalized.water_l, null);
  assert.ok(row.warnings.some((warning) => warning.code === 'water-not-modelled'));
});

test('a component-sum mismatch is warned about, not silently corrected', () => {
  const row = { ...parsed.rows[0], energy_consumed: '0.1', cpu_energy: '0.01', ram_energy: '0.01', gpu_energy: '0' };
  const normalized = normalizeCodeCarbonRow(row);
  assert.equal(normalized.normalized.energy_wh, 100);
  assert.ok(normalized.warnings.some((warning) => warning.code === 'component-sum-mismatch'));
});

test('an unverified CodeCarbon version is flagged rather than assumed compatible', () => {
  const row = { ...parsed.rows[0], codecarbon_version: '9.9.9' };
  const normalized = normalizeCodeCarbonRow(row);
  assert.equal(normalized.source.units_verified, false);
  assert.ok(normalized.warnings.some((warning) => warning.code === 'unverified-codecarbon-version'));
});

test('macOS and Linux /usr/bin/time output are parsed without guessing', () => {
  const mac = parseTimeOutput(`        0.04 real         0.02 user         0.00 sys\n            47644672  maximum resident set size\n`, 'darwin');
  assert.equal(mac.wall_ms, 40);
  assert.equal(mac.user_seconds, 0.02);
  assert.equal(mac.system_seconds, 0);
  assert.equal(mac.max_rss_bytes, 47644672);
  const linux = parseTimeOutput(`\tUser time (seconds): 0.25\n\tSystem time (seconds): 0.05\n\tMaximum resident set size (kbytes): 2048\n\tElapsed (wall clock) time (h:mm:ss or m:ss): 0:01.50\n`, 'linux');
  assert.equal(linux.wall_ms, 1500);
  assert.equal(linux.user_seconds, 0.25);
  assert.equal(linux.system_seconds, 0.05);
  assert.equal(linux.max_rss_bytes, 2097152);
  const none = parseTimeOutput('', 'darwin');
  assert.equal(none.format, 'none');
  assert.equal(none.wall_ms, null);
});
