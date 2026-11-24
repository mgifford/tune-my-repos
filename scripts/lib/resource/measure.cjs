/**
 * Measured command execution.
 *
 * Wall clock and (where the platform provides it) child CPU time and peak RSS
 * come from `/usr/bin/time`. CodeCarbon is an optional outer wrapper; it is
 * invoked in offline mode so no geographic lookup or emissions API call is
 * made. The wrapped command's exit status is always what the caller sees.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const { ensureDir, rawRoot, lockRoot } = require('./paths.cjs');
const { parseTimeOutput, parseCodeCarbonCsv, normalizeCodeCarbonRow, finite } = require('./units.cjs');

const TIME_BIN = '/usr/bin/time';

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(name, { timeoutMs = 30000, staleMs = 10 * 60 * 1000 } = {}) {
  const dir = ensureDir(lockRoot());
  const file = path.join(dir, `${name}.lock`);
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, created_at: nowIso() }));
      fs.closeSync(fd);
      return {
        waited_ms: Date.now() - started,
        release() {
          try { fs.unlinkSync(file); } catch { /* already released */ }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const stat = fs.statSync(file);
        stale = Date.now() - stat.mtimeMs > staleMs;
      } catch { stale = true; }
      if (stale) {
        try { fs.unlinkSync(file); } catch { /* raced */ }
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`timed out waiting for the ${name} measurement lock (${file})`);
      }
      await sleep(50);
    }
  }
}

function which(bin) {
  if (!bin) return null;
  if (bin.includes(path.sep)) return fs.existsSync(bin) ? bin : null;
  const result = spawnSync('sh', ['-c', `command -v ${JSON.stringify(bin)}`], { encoding: 'utf8' });
  const found = (result.stdout || '').trim();
  return result.status === 0 && found ? found : null;
}

function git(args, cwd) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function parseRemote(remote) {
  if (!remote) return null;
  const cleaned = String(remote).trim().replace(/\.git$/, '');
  const ssh = cleaned.match(/^git@[^:]+:(.+)$/);
  const url = cleaned.match(/^https?:\/\/[^/]+\/(.+)$/);
  const value = ssh ? ssh[1] : (url ? url[1] : null);
  if (!value) return null;
  const parts = value.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
}

function projectInfo(cwd = process.cwd()) {
  const remote = git(['remote', 'get-url', 'origin'], cwd);
  const name = parseRemote(remote);
  return {
    project: name || `local/${path.basename(path.resolve(cwd))}`,
    commit: git(['rev-parse', 'HEAD'], cwd),
    dirty: Boolean(git(['status', '--porcelain'], cwd)),
  };
}

function buildTimeFlags({ platform = process.platform, timeFile }) {
  if (platform === 'darwin') return ['-l', '-o', timeFile];
  if (platform === 'linux') return ['-v', '-o', timeFile];
  return null;
}

function buildTimeArgs({ platform = process.platform, timeFile, command }) {
  const flags = buildTimeFlags({ platform, timeFile });
  return flags ? [...flags, ...command] : null;
}

function buildCodeCarbonArgs({
  binary = 'codecarbon',
  rawDir,
  countryIsoCode = 'CAN',
  region = 'quebec',
  measurePowerSecs = 1,
  projectName = 'tune-my-repos',
  experimentName = 'resource-measurement',
  timeFile,
  timeFlags,
  command,
}) {
  const args = [
    'monitor',
    '--offline',
    '--country-iso-code', String(countryIsoCode),
    '--no-api',
    '--measure-power-secs', String(measurePowerSecs),
    '--output-dir', rawDir,
    '--output-file', 'emissions.csv',
    '--project-name', String(projectName),
    '--experiment-name', String(experimentName),
    '--log-level', 'error',
  ];
  if (region) args.push('--region', String(region));
  args.push('--');
  if (timeFlags) args.push(TIME_BIN, ...timeFlags, '--');
  args.push(...command);
  return { binary, args };
}

function killTree(child) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch { /* already gone */ }
  setTimeout(() => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* already gone */ }
  }, 2000).unref();
}

function runProcess(bin, args, { cwd, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const startedPerf = process.hrtime.bigint();
    const child = spawn(bin, args, {
      cwd,
      stdio: ['inherit', 'inherit', 'inherit'],
      detached: process.platform !== 'win32',
      env: process.env,
    });
    let timedOut = false;
    let interrupted = false;
    let timer = null;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    }
    const onSignal = () => { interrupted = true; killTree(child); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    const finish = (code, signal, error) => {
      if (timer) clearTimeout(timer);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      resolve({
        status: code,
        signal,
        error: error ? error.message : null,
        timed_out: timedOut,
        interrupted,
        wall_ms: Number(process.hrtime.bigint() - startedPerf) / 1e6,
      });
    };
    child.on('error', (error) => finish(null, null, error));
    child.on('exit', (code, signal) => finish(code, signal, null));
  });
}

function readTimeFile(file) {
  try {
    return parseTimeOutput(fs.readFileSync(file, 'utf8'));
  } catch {
    return parseTimeOutput(''); // format none, all null
  }
}

function readCodeCarbon(rawDir) {
  const csvPath = path.join(rawDir, 'emissions.csv');
  if (!fs.existsSync(csvPath)) return { path: csvPath, rows: [], parsed: null, problems: ['emissions.csv missing'] };
  const text = fs.readFileSync(csvPath, 'utf8');
  const parsed = parseCodeCarbonCsv(text);
  const rows = parsed.rows.map((row, index) => ({ index, ...normalizeCodeCarbonRow(row) }));
  const problems = [...parsed.problems];
  if (rows.length === 0) problems.push('emissions.csv has no data rows');
  if (rows.length > 1) problems.push(`emissions.csv has ${rows.length} rows for one unique measurement directory`);
  return { path: csvPath, rows, parsed: rows.length ? rows[rows.length - 1] : null, problems };
}

/**
 * Run one command. The returned `codecarbon` object is always present; its
 * `attempted` flag distinguishes "not requested" from "requested but failed".
 */
async function measureCommand({
  command,
  cwd = process.cwd(),
  codecarbon = false,
  requireCodecarbon = false,
  codecarbonBin = process.env.CODECARBON_BIN || 'codecarbon',
  countryIsoCode = 'CAN',
  region = 'quebec',
  measurePowerSecs = 1,
  timeoutMs = null,
  experimentName = 'resource-measurement',
  cacheState = null,
} = {}) {
  if (!Array.isArray(command) || command.length === 0) throw new Error('a command is required');
  const measurementId = randomUUID();
  const rawDir = ensureDir(path.join(rawRoot(), measurementId));
  const timeFile = path.join(rawDir, 'time.txt');
  const startedAt = nowIso();
  const platform = process.platform;
  const timeFlags = buildTimeFlags({ platform, timeFile });
  const timeArgs = buildTimeArgs({ platform, timeFile, command });

  const cc = {
    requested: Boolean(codecarbon),
    attempted: false,
    available: null,
    binary: codecarbonBin,
    csv_path: null,
    parsed: null,
    rows: 0,
    problems: [],
    lock_wait_ms: null,
    error: null,
  };
  let result = null;
  let release = null;

  if (codecarbon) {
    const binary = which(codecarbonBin);
    cc.available = Boolean(binary);
    if (!binary) {
      cc.error = `CodeCarbon binary not found: ${codecarbonBin}`;
      cc.problems.push('codecarbon-unavailable');
      if (requireCodecarbon) {
        const endedAt = nowIso();
        return {
          measurement_id: measurementId,
          command,
          raw_dir: rawDir,
          started_at: startedAt,
          ended_at: endedAt,
          wall_ms: 0,
          status: 127,
          signal: null,
          timed_out: false,
          error: cc.error,
          time: readTimeFile(timeFile),
          codecarbon: cc,
          refused: true,
        };
      }
    } else {
      let lock = null;
      try {
        lock = await acquireLock('codecarbon');
        release = lock.release;
        cc.lock_wait_ms = lock.waited_ms;
      } catch (error) {
        cc.error = error.message;
        cc.problems.push('codecarbon-lock-timeout');
      }
      if (lock) {
        const built = buildCodeCarbonArgs({
          binary,
          rawDir,
          countryIsoCode,
          region,
          measurePowerSecs,
          experimentName,
          timeFile,
          timeFlags,
          command,
        });
        cc.attempted = true;
        result = await runProcess(built.binary, built.args, { cwd, timeoutMs });
        cc.output = readCodeCarbon(rawDir);
        cc.csv_path = cc.output.path;
        cc.parsed = cc.output.parsed;
        cc.rows = cc.output.rows.length;
        cc.problems.push(...cc.output.problems);
        if (cc.output.parsed) {
          for (const warning of cc.output.parsed.warnings) cc.problems.push(warning.code);
        }
      }
    }
  }

  if (!result) {
    const bin = timeArgs ? TIME_BIN : command[0];
    const args = timeArgs || command.slice(1);
    result = await runProcess(bin, args, { cwd, timeoutMs });
  }
  if (release) release();

  const endedAt = nowIso();
  const time = readTimeFile(timeFile);
  const innerWallMs = time.wall_ms;
  const overheadMs = innerWallMs === null ? null : result.wall_ms - innerWallMs;

  return {
    measurement_id: measurementId,
    command,
    raw_dir: rawDir,
    started_at: startedAt,
    ended_at: endedAt,
    wall_ms: result.wall_ms,
    status: result.status,
    signal: result.signal,
    timed_out: result.timed_out,
    interrupted: Boolean(result.interrupted),
    error: result.error,
    time,
    inner_wall_ms: innerWallMs,
    measurement_overhead_ms: overheadMs,
    cache_state: cacheState,
    codecarbon: cc,
    refused: false,
  };
}

function codecarbonVersion(binary = process.env.CODECARBON_BIN || 'codecarbon') {
  const resolved = which(binary);
  if (!resolved) return null;
  const result = spawnSync(resolved, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) return null;
  const match = `${result.stdout || ''}${result.stderr || ''}`.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

module.exports = {
  TIME_BIN,
  nowIso,
  acquireLock,
  which,
  git,
  parseRemote,
  projectInfo,
  buildTimeArgs,
  buildTimeFlags,
  buildCodeCarbonArgs,
  measureCommand,
  codecarbonVersion,
  readCodeCarbon,
  readTimeFile,
  finite,
};
