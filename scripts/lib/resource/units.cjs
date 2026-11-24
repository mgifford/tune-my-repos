/**
 * Unit handling for resource evidence.
 *
 * Two rules matter more than the arithmetic:
 *   1. A unit is only converted after the source column's unit is established
 *      from the tool's own header/field contract (never guessed from magnitude).
 *   2. Missing is null and a measured zero stays zero. A zero that means
 *      "this hardware was not detected" is converted to null, with a reason.
 */

const CODECARBON_SUPPORTED_VERSIONS = Object.freeze(['3.3.3']);

// CodeCarbon 3.3.3 CSV contract. Verified against
// codecarbon/output_methods/emissions_data.py and FileOutput in the installed
// package. Units are not present in the CSV header, so this map is the
// evidence for every conversion.
const CODECARBON_FIELDS = Object.freeze({
  duration: { unit: 's', quantity: 'duration' },
  emissions: { unit: 'kgCO2eq', quantity: 'emissions' },
  emissions_rate: { unit: 'kgCO2eq/s', quantity: 'emissions_rate' },
  cpu_power: { unit: 'W', quantity: 'power' },
  gpu_power: { unit: 'W', quantity: 'power' },
  ram_power: { unit: 'W', quantity: 'power' },
  cpu_energy: { unit: 'kWh', quantity: 'energy' },
  gpu_energy: { unit: 'kWh', quantity: 'energy' },
  ram_energy: { unit: 'kWh', quantity: 'energy' },
  energy_consumed: { unit: 'kWh', quantity: 'energy' },
  water_consumed: { unit: 'L', quantity: 'water' },
});

const ENERGY_TO_WH = Object.freeze({
  wh: 1,
  kwh: 1000,
  mwh: 1e6,
  j: 1 / 3600,
  kj: 1000 / 3600,
  mj: 1e6 / 3600,
  gj: 1e9 / 3600,
});

const EMISSIONS_TO_G = Object.freeze({
  g: 1,
  kg: 1000,
  mg: 1e-3,
  ug: 1e-6,
  t: 1e6,
});

const BYTES = Object.freeze({
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
});

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function toWh(value, unit) {
  const n = finite(value);
  if (n === null) return { value: null, ok: false, reason: 'not-a-number' };
  const factor = ENERGY_TO_WH[String(unit || '').toLowerCase()];
  if (factor === undefined) return { value: null, ok: false, reason: `unsupported-energy-unit:${unit}` };
  return { value: n * factor, ok: true, unit: 'Wh' };
}

function toGramsCO2e(value, unit) {
  const n = finite(value);
  if (n === null) return { value: null, ok: false, reason: 'not-a-number' };
  const key = String(unit || '').toLowerCase().replace('co2e', '').replace('co2', '').trim();
  const factor = EMISSIONS_TO_G[key];
  if (factor === undefined) return { value: null, ok: false, reason: `unsupported-emissions-unit:${unit}` };
  return { value: n * factor, ok: true, unit: 'gCO2e' };
}

function toBytes(value, unit) {
  const n = finite(value);
  if (n === null) return null;
  const factor = BYTES[String(unit || '').toLowerCase()];
  return factor === undefined ? null : n * factor;
}

function parseBytes(text) {
  const match = String(text || '').trim().match(/^([\d.]+)\s*([kmgt]?i?b)$/i);
  if (!match) return null;
  return toBytes(match[1], match[2]);
}

/** A small RFC 4180-ish CSV parser: enough for CodeCarbon output, no dependency. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text || '');
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell !== ''));
}

function parseCodeCarbonCsv(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { headers: [], rows: [], problems: ['empty CSV'] };
  const headers = rows[0].map((h) => h.trim());
  const problems = [];
  if (!headers.includes('energy_consumed')) problems.push('missing energy_consumed column');
  if (!headers.includes('duration')) problems.push('missing duration column');
  const records = rows.slice(1).map((cells) => {
    const record = {};
    headers.forEach((header, i) => { record[header] = cells[i] ?? ''; });
    return record;
  });
  return { headers, rows: records, problems };
}

function note(code, message) {
  return { code, message };
}

/**
 * Normalize one CodeCarbon 3.3.3 CSV row. The raw source values are retained
 * in `source_values`; normalized values are derived from the documented units.
 */
function normalizeCodeCarbonRow(row) {
  const sourceValues = [];
  const warnings = [];
  const missing = [];

  const raw = (field) => {
    if (!Object.prototype.hasOwnProperty.call(row, field)) { missing.push(field); return null; }
    const value = row[field];
    const n = finite(value);
    if (value !== '' && value !== null && value !== undefined && n === null) {
      warnings.push(note('unparseable-field', `${field} is not numeric`));
    }
    return n;
  };

  for (const [field, meta] of Object.entries(CODECARBON_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(row, field) && row[field] !== '') {
      sourceValues.push({ field, value: raw(field), unit: meta.unit, quantity: meta.quantity });
    }
  }

  const durationS = raw('duration');
  const emissionsKg = raw('emissions');
  const emissionsRateKgS = raw('emissions_rate');
  const cpuPowerW = raw('cpu_power');
  const gpuPowerW = raw('gpu_power');
  const ramPowerW = raw('ram_power');
  const cpuKwh = raw('cpu_energy');
  const gpuKwh = raw('gpu_energy');
  const ramKwh = raw('ram_energy');
  const totalKwh = raw('energy_consumed');
  const waterL = raw('water_consumed');
  const gpuCount = raw('gpu_count');
  const gpuModel = String(row.gpu_model || '').trim();
  const version = String(row.codecarbon_version || '').trim();
  const trackingMode = String(row.tracking_mode || '').trim() || null;
  const wue = raw('wue');
  const pue = raw('pue');

  const gpuAvailable = gpuCount !== null ? gpuCount > 0 : Boolean(gpuModel);
  const unitVerified = CODECARBON_SUPPORTED_VERSIONS.includes(version);
  if (version && !unitVerified) {
    warnings.push(note(
      'unverified-codecarbon-version',
      `CSV field units were verified for CodeCarbon ${CODECARBON_SUPPORTED_VERSIONS.join(', ')}; got ${version}`,
    ));
  }

  const totalWh = toWh(totalKwh, 'kWh');
  const cpuWh = toWh(cpuKwh, 'kWh');
  const gpuWh = toWh(gpuKwh, 'kWh');
  const ramWh = toWh(ramKwh, 'kWh');
  const emissionsG = toGramsCO2e(emissionsKg, 'kg');
  const emissionsRateGS = toGramsCO2e(emissionsRateKgS, 'kg');

  if (totalWh.value === null) missing.push('energy');
  if (emissionsG.value === null) missing.push('emissions');
  if (cpuWh.value === null) missing.push('cpu_energy');
  if (ramWh.value === null) missing.push('ram_energy');
  if (!gpuAvailable) missing.push('gpu_energy');

  // A detected component sum that disagrees with the reported total is
  // reported, not corrected. The tool's total is the source of truth.
  if (totalWh.value !== null && cpuWh.value !== null && ramWh.value !== null) {
    const sum = cpuWh.value + (gpuAvailable ? (gpuWh.value || 0) : 0) + ramWh.value;
    const diff = Math.abs(sum - totalWh.value);
    if (diff > Math.max(1e-12, Math.abs(totalWh.value) * 1e-6)) {
      warnings.push(note('component-sum-mismatch', `component energy ${sum} Wh differs from energy_consumed ${totalWh.value} Wh`));
    }
  }

  // Derive intensity only when both measured totals are present and non-zero.
  const carbonIntensityGKwh = totalWh.value && emissionsG.value !== null
    ? (emissionsG.value * 1000) / totalWh.value
    : null;

  const waterModelled = wue !== null && wue > 0 && waterL !== null;
  if (waterL !== null && !waterModelled) {
    warnings.push(note(
      'water-not-modelled',
      'water_consumed is 0 because WUE is 0; it is not a measured zero',
    ));
  }

  const trackingNote = trackingMode === 'process'
    ? 'Process tracking covers the tracked process and its children; system-wide CPU utilization columns are not process attribution.'
    : `Tracking mode "${trackingMode || 'unknown'}" is recorded as reported; attribution is not inferred.`;

  return {
    source: {
      tool: 'codecarbon',
      version: version || null,
      tracking_mode: trackingMode,
      units_verified: unitVerified,
    },
    normalized: {
      duration_ms: durationS === null ? null : durationS * 1000,
      energy_wh: totalWh.value,
      cpu_wh: cpuWh.value,
      gpu_wh: gpuAvailable ? gpuWh.value : null,
      ram_wh: ramWh.value,
      emissions_gco2e: emissionsG.value,
      emissions_rate_g_per_s: emissionsRateGS.value,
      cpu_power_w: cpuPowerW,
      gpu_power_w: gpuAvailable ? gpuPowerW : null,
      ram_power_w: ramPowerW,
      water_l: waterModelled ? waterL : null,
      carbon_intensity_g_per_kwh: carbonIntensityGKwh,
      pue: pue ?? null,
      wue: wue ?? null,
    },
    hardware: {
      cpu_model: row.cpu_model || null,
      cpu_threads: finite(row.cpu_count),
      gpu_model: gpuModel || null,
      gpu_count: gpuCount,
      gpu_available: gpuAvailable,
      ram_total_gb: finite(row.ram_total_size),
      country_name: row.country_name || null,
      country_iso_code: row.country_iso_code || null,
      region: row.region || null,
      os: row.os || null,
      python_version: row.python_version || null,
      codecarbon_version: version || null,
      tracking_mode: trackingMode,
      on_cloud: row.on_cloud || null,
      cloud_provider: row.cloud_provider || null,
      cloud_region: row.cloud_region || null,
      longitude: finite(row.longitude),
      latitude: finite(row.latitude),
    },
    source_values: sourceValues,
    warnings,
    missing: [...new Set(missing)],
  };
}

function parseTimeOutput(text, platform = process.platform) {
  const out = {
    wall_ms: null,
    user_seconds: null,
    system_seconds: null,
    max_rss_bytes: null,
    read_ops: null,
    write_ops: null,
    format: 'none',
  };
  const s = String(text || '');
  if (platform === 'darwin') {
    const line = s.match(/^\s*([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys\s*$/m);
    if (line) {
      out.wall_ms = Number(line[1]) * 1000;
      out.user_seconds = Number(line[2]);
      out.system_seconds = Number(line[3]);
      out.format = 'bsd';
    }
    const rss = s.match(/^\s*(\d+)\s+maximum resident set size\s*$/m);
    if (rss) out.max_rss_bytes = Number(rss[1]);
    const read = s.match(/^\s*(\d+)\s+block input operations\s*$/m);
    if (read) out.read_ops = Number(read[1]);
    const write = s.match(/^\s*(\d+)\s+block output operations\s*$/m);
    if (write) out.write_ops = Number(write[1]);
  } else {
    const wall = s.match(/Elapsed \(wall clock\) time \(h:mm:ss or m:ss\):\s*([^\n]+)/);
    if (wall) {
      const parts = wall[1].trim().split(':').map(Number);
      if (parts.every((n) => Number.isFinite(n))) {
        out.wall_ms = parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
      }
    }
    const user = s.match(/User time \(seconds\):\s*([\d.]+)/);
    if (user) out.user_seconds = Number(user[1]);
    const sys = s.match(/System time \(seconds\):\s*([\d.]+)/);
    if (sys) out.system_seconds = Number(sys[1]);
    const rss = s.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
    if (rss) out.max_rss_bytes = Number(rss[1]) * 1024;
    const read = s.match(/File system inputs:\s*(\d+)/);
    if (read) out.read_ops = Number(read[1]);
    const write = s.match(/File system outputs:\s*(\d+)/);
    if (write) out.write_ops = Number(write[1]);
    if (out.user_seconds !== null || out.system_seconds !== null) out.format = 'gnu';
  }
  if (out.wall_ms === null && (out.user_seconds !== null || out.max_rss_bytes !== null)) {
    out.format = 'partial';
  }
  return out;
}

function percent(part, whole) {
  if (finite(part) === null || finite(whole) === null || whole === 0) return null;
  return (part / whole) * 100;
}

module.exports = {
  CODECARBON_FIELDS,
  CODECARBON_SUPPORTED_VERSIONS,
  finite,
  toWh,
  toGramsCO2e,
  toBytes,
  parseBytes,
  parseCsv,
  parseCodeCarbonCsv,
  normalizeCodeCarbonRow,
  parseTimeOutput,
  percent,
};
