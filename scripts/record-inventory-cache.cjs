#!/usr/bin/env node
/**
 * Record a quarterly inventory cache-efficiency observation from a sanitized
 * resource rollup. The history is aggregate-only and contains no repository
 * names, task labels, commands or paths.
 *
 * Usage:
 *   node scripts/record-inventory-cache.cjs \
 *     --report=resource-rollup.public.json \
 *     --history=resource-cache-history.json \
 *     --out-dir=resource-report
 */

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const value = (name) => {
    const prefix = `--${name}=`;
    const found = argv.find((arg) => arg.startsWith(prefix));
    if (found) return found.slice(prefix.length);
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : null;
  };
  return { value };
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function entryFrom(report) {
  const api = report.maintenance?.api || {};
  const ci = report.maintenance?.ci || {};
  return {
    checked_at: report.generated_at || new Date().toISOString(),
    window: report.window || { start: null, end: null },
    requests: number(api.requests),
    status_200: number(api.status_200),
    status_304: number(api.status_304),
    failed: number(api.failed),
    rate_limited: number(api.rate_limited),
    cache_hits: number(api.cache_hits),
    cache_misses: number(api.cache_misses),
    cache_hit_rate: number(api.cache_hit_rate),
    not_modified_rate: number(api.not_modified_rate),
    requests_per_evaluated_repository: number(api.requests_per_evaluated_repository),
    repositories_discovered: number(api.repositories_discovered),
    repositories_evaluated: number(api.repositories_evaluated),
    repositories_skipped: number(api.repositories_skipped),
    carried_forward: number(api.carried_forward),
    security_checks: number(api.security_checks),
    complete: typeof api.complete === 'boolean' ? api.complete : null,
    workflow_elapsed_ms: number(ci.workflow_elapsed_ms),
    job_elapsed_ms: number(ci.job_elapsed_ms),
  };
}

function fmt(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function renderMarkdown(history, current) {
  const lines = [
    '# Inventory cache efficiency',
    '',
    `Checked: ${current.checked_at}`,
    '',
    'This is a conditional-request check, not an energy measurement. A 304 response means an unchanged open issue/PR list was validated without consuming a primary rate-limit request; a 200 is a cache miss/full read.',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| API requests | ${current.requests ?? '—'} |`,
    `| HTTP 200 | ${current.status_200 ?? '—'} |`,
    `| HTTP 304 | ${current.status_304 ?? '—'} |`,
    `| Cache hits / misses | ${current.cache_hits ?? '—'} / ${current.cache_misses ?? '—'} |`,
    `| Cache hit rate | ${current.cache_hit_rate === null ? '—' : `${(current.cache_hit_rate * 100).toFixed(1)}%`} |`,
    `| 304 rate | ${current.not_modified_rate === null ? '—' : `${(current.not_modified_rate * 100).toFixed(1)}%`} |`,
    `| Requests per evaluated repository | ${fmt(current.requests_per_evaluated_repository)} |`,
    `| Repositories evaluated / discovered | ${current.repositories_evaluated ?? '—'} / ${current.repositories_discovered ?? '—'} |`,
    `| Carried forward | ${current.carried_forward ?? '—'} |`,
    `| Scan complete | ${current.complete === null ? '—' : (current.complete ? 'yes' : 'no')} |`,
    `| Workflow elapsed | ${current.workflow_elapsed_ms === null ? '—' : `${current.workflow_elapsed_ms} ms`} |`,
    `| Summed job execution | ${current.job_elapsed_ms === null ? '—' : `${current.job_elapsed_ms} ms`} |`,
    '',
    '## Recent checks',
    '',
    '| Checked | Requests | 304 | Cache hit rate | Requests/evaluated repo | Complete |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const item of history.entries.slice(-8)) {
    lines.push(`| ${item.checked_at} | ${item.requests ?? '—'} | ${item.status_304 ?? '—'} | ${item.cache_hit_rate === null ? '—' : `${(item.cache_hit_rate * 100).toFixed(1)}%`} | ${fmt(item.requests_per_evaluated_repository)} | ${item.complete === null ? '—' : (item.complete ? 'yes' : 'no')} |`);
  }
  lines.push('');
  lines.push('The history is aggregate-only. Raw measurements, repository names, task labels, commands and paths stay local/private.');
  lines.push('');
  return lines.join('\n');
}

function main(argv) {
  const { value } = parseArgs(argv);
  const reportFile = value('report');
  const historyFile = value('history');
  const outDir = value('out-dir') || path.dirname(reportFile || '.');
  if (!reportFile || !historyFile) {
    console.error('Usage: node scripts/record-inventory-cache.cjs --report=<file> --history=<file> [--out-dir=<dir>]');
    return 2;
  }
  if (!fs.existsSync(reportFile)) {
    console.error(`[cache-check] report not found: ${reportFile}`);
    return 2;
  }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const current = entryFrom(report);
  let history = { schema_version: '1.0.0', entries: [] };
  if (fs.existsSync(historyFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      if (Array.isArray(parsed.entries)) history = { schema_version: '1.0.0', entries: parsed.entries };
    } catch {
      // Unreadable history is replaced by a fresh, explicit history.
    }
  }
  history.entries.push(current);
  history.entries = history.entries.slice(-40);
  fs.mkdirSync(path.dirname(path.resolve(historyFile)), { recursive: true });
  fs.writeFileSync(path.resolve(historyFile), `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
  fs.mkdirSync(outDir, { recursive: true });
  const markdown = renderMarkdown(history, current);
  fs.writeFileSync(path.join(outDir, 'CACHE-EFFICIENCY.md'), markdown, { mode: 0o600 });
  console.log(`[cache-check] recorded ${current.requests ?? '—'} requests, ${current.status_304 ?? '—'} 304s, cache hit rate ${current.cache_hit_rate === null ? '—' : `${(current.cache_hit_rate * 100).toFixed(1)}%`}`);
  return 0;
}

module.exports = { parseArgs, entryFrom, renderMarkdown, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
