#!/usr/bin/env node
/**
 * Configurable resource benchmark facility.
 *
 *   node scripts/resource-benchmark.cjs --workload=noop --repetitions=5
 *   node scripts/resource-benchmark.cjs --workload=test-suite --repetitions=3 --codecarbon
 *
 * Only local/fixture workloads are available. Live GitHub inventory is
 * deliberately refused so a benchmark cannot generate unbounded API traffic.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  MAX_REPETITIONS,
  WORKLOADS,
  runWorkload,
  buildBenchmarkResult,
  benchmarkEvent,
  renderBenchmarkMarkdown,
  writeBenchmarkReports,
} = require('./lib/resource/benchmark.cjs');
const { projectInfo, nowIso } = require('./lib/resource/measure.cjs');
const { appendEvents, monitoringEvent, ledgerFile } = require('./lib/resource/ledger.cjs');

function usage() {
  return `Usage: node scripts/resource-benchmark.cjs --workload=<id> [options]

Workloads:
${Object.entries(WORKLOADS).map(([id, definition]) => `  ${id.padEnd(24)} ${definition.description}`).join('\n')}

Options:
  --repetitions=<n>          Repetitions, 1-${MAX_REPETITIONS} (default: 3).
  --baseline=<id>            Also measure a baseline workload; reported separately.
  --codecarbon               Run CodeCarbon offline for every repetition.
  --codecarbon-bin=<path>    CodeCarbon executable.
  --country-iso-code=<code>  Offline grid country (default: CAN).
  --region=<name>            Offline grid region (default: quebec).
  --measure-power-secs=<n>   CodeCarbon sampling interval (default: 1).
  --timeout=<seconds>        Per-repetition timeout.
  --out=<dir>                Report directory (default: reports/resources/benchmarks).
  --no-record                Do not write the ledger event.
  --json                     Print the JSON report to stdout.
  --help                     Show this help.

Reports are written as JSON and Markdown. Raw CodeCarbon CSVs stay in the
gitignored resource cache.`;
}

function parseArgs(argv) {
  const value = (name) => {
    const prefix = `--${name}=`;
    const found = argv.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  };
  const has = (name) => argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  return { value, has };
}

async function main(argv) {
  const { value, has } = parseArgs(argv);
  if (has('help')) { console.log(usage()); return 0; }
  const workload = value('workload');
  if (!workload) { console.error(usage()); return 2; }
  if (!WORKLOADS[workload]) { console.error(`unknown workload "${workload}"\n\n${usage()}`); return 2; }
  const repetitions = Number(value('repetitions') || 3);
  const baselineWorkload = value('baseline');
  if (baselineWorkload && !WORKLOADS[baselineWorkload]) {
    console.error(`unknown baseline workload "${baselineWorkload}"`);
    return 2;
  }
  const codecarbon = has('codecarbon');
  const options = {
    repetitions,
    codecarbon,
    codecarbonBin: value('codecarbon-bin') || process.env.CODECARBON_BIN || 'codecarbon',
    countryIsoCode: value('country-iso-code') || 'CAN',
    region: value('region') || 'quebec',
    measurePowerSecs: Number(value('measure-power-secs') || 1),
    timeoutMs: Number(value('timeout') || 0) > 0 ? Number(value('timeout')) * 1000 : null,
  };
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > MAX_REPETITIONS) {
    console.error(`--repetitions must be an integer from 1 to ${MAX_REPETITIONS}`);
    return 2;
  }

  const info = projectInfo(process.cwd());
  const started = Date.now();
  const runs = await runWorkload(workload, options);
  const baselineRuns = baselineWorkload ? await runWorkload(baselineWorkload, options) : null;
  const result = buildBenchmarkResult({ workload, runs, baselineRuns, baselineWorkload, info });

  const outDir = value('out') ? path.resolve(value('out')) : undefined;
  const overheadStarted = Date.now();
  const files = writeBenchmarkReports(result, outDir ? { outDir } : {});
  const markdown = renderBenchmarkMarkdown(result);

  if (!has('no-record')) {
    const event = benchmarkEvent(result, { project: info.project, codecarbon });
    await appendEvents([event]);
    await appendEvents([monitoringEvent({
      adapter: 'resource-benchmark',
      startedAt: new Date(overheadStarted).toISOString(),
      durationMs: Date.now() - overheadStarted,
      note: 'Benchmark report writing and ledger overhead; per-repetition measurements are recorded separately in the benchmark event.',
      project: info.project,
    })]);
    console.error(`[benchmark] event=${event.event_id} ledger=${path.relative(process.cwd(), ledgerFile())}`);
  }

  console.error(`[benchmark] workload=${workload} repetitions=${repetitions} median=${result.statistics.median === null ? 'unavailable' : `${result.statistics.median.toFixed(1)}ms`} min=${result.statistics.minimum === null ? 'unavailable' : `${result.statistics.minimum.toFixed(1)}ms`} max=${result.statistics.maximum === null ? 'unavailable' : `${result.statistics.maximum.toFixed(1)}ms`}`);
  console.error(`[benchmark] energy=${result.energy.total_wh === null ? 'unavailable' : `${result.energy.total_wh.toFixed(6)}Wh`} (${result.energy.coverage}) emissions=${result.energy.total_gco2e === null ? 'unavailable' : `${result.energy.total_gco2e.toFixed(8)}gCO2e`}`);
  if (baselineWorkload) console.error(`[benchmark] baseline=${baselineWorkload} median=${result.baseline.statistics.median === null ? 'unavailable' : `${result.baseline.statistics.median.toFixed(1)}ms`} (reported separately, not subtracted)`);
  for (const file of files) console.error(`[benchmark] wrote ${path.relative(process.cwd(), file)}`);
  if (has('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(markdown);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[benchmark] ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = { parseArgs, main };
