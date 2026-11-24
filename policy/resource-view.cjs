/**
 * Accessible static rendering for the public resource rollup.
 *
 * Pure string functions: no DOM, no network, no AI. Every table has a caption
 * and column headers with scope="col"; missing values render as an em dash and
 * a measured zero renders as "0". No single sustainability score is produced.
 */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(value, digits = 4) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  if (Math.abs(value) < 1e-4) return value.toExponential(3);
  if (digits === 0) return String(Math.round(value));
  return value.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function formatBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value === 0) return '0 B';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

function formatMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value === 0) return '0 ms';
  if (value >= 60000) return `${(value / 60000).toFixed(1)} min`;
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${value.toFixed(0)} ms`;
}

function renderTable({ id, caption, description = null, columns, rows, empty = 'No evidence in this window.' }) {
  const captionId = `${id}-caption`;
  const descriptionId = `${id}-description`;
  const describedBy = description ? ` aria-describedby="${descriptionId}"` : '';
  const lines = [];
  if (description) lines.push(`<p id="${descriptionId}" class="table-description">${escapeHtml(description)}</p>`);
  lines.push(`<table id="${escapeHtml(id)}"${describedBy}>`);
  lines.push(`  <caption id="${captionId}">${escapeHtml(caption)}</caption>`);
  lines.push('  <thead>');
  lines.push('    <tr>');
  for (const column of columns) {
    lines.push(`      <th scope="col"${column.numeric ? ' class="numeric"' : ''}>${escapeHtml(column.label)}</th>`);
  }
  lines.push('    </tr>');
  lines.push('  </thead>');
  lines.push('  <tbody>');
  if (!rows.length) {
    lines.push(`    <tr><td colspan="${columns.length}">${escapeHtml(empty)}</td></tr>`);
  } else {
    for (const row of rows) {
      lines.push('    <tr>');
      for (const column of columns) {
        const value = typeof column.value === 'function' ? column.value(row) : row[column.key];
        lines.push(`      <td${column.numeric ? ' class="numeric"' : ''}>${escapeHtml(value === null || value === undefined ? '—' : value)}</td>`);
      }
      lines.push('    </tr>');
    }
  }
  lines.push('  </tbody>');
  lines.push('</table>');
  return lines.join('\n');
}


function renderCsv(rollup) {
  const rows = [['section', 'metric', 'unit', 'value', 'coverage']];
  rows.push(['local', 'wall_clock', 'ms', rollup.local_computing.wall_ms ?? '', '']);
  rows.push(['local', 'cpu_time', 'CPU-seconds', rollup.local_computing.cpu_seconds ?? '', '']);
  rows.push(['local', 'peak_rss', 'bytes', rollup.local_computing.peak_rss_bytes ?? '', '']);
  rows.push(['local', 'energy', 'Wh', rollup.local_computing.energy.estimated_wh ?? rollup.local_computing.energy.measured_wh ?? '', rollup.local_computing.energy.coverage]);
  rows.push(['local', 'operational_emissions', 'gCO2e', rollup.local_computing.emissions_gco2e ?? '', rollup.local_computing.energy.coverage]);
  for (const row of rollup.maintenance.by_activity) {
    rows.push(['activity', row.activity, 'Wh', row.estimated_wh ?? '', row.coverage]);
  }
  rows.push(['remote_ai', 'requests', 'count', rollup.remote_ai.requests, '']);
  for (const row of rollup.remote_ai.energy_by_methodology) {
    rows.push(['remote_ai', `${row.source || 'unknown'}_${row.dataset_version || 'unknown'}`, 'Wh', row.mean_wh ?? '', row.coverage]);
  }
  rows.push(['monitoring', 'collection_time', 'ms', rollup.monitoring.duration_ms ?? '', '']);
  rows.push(['monitoring', 'ledger_size', 'bytes', rollup.monitoring.ledger_bytes, '']);
  return `${rows.map((row) => row.map((cell) => {
    const text = String(cell ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',')).join('\n')}\n`;
}

function renderResourceDashboard(rollup) {
  if (!rollup || rollup.schema_version !== '1.0.0') {
    return '<p class="error-message" role="alert">The resource rollup is missing or has an unsupported schema version.</p>';
  }
  const local = rollup.local_computing;
  const remote = rollup.remote_ai;
  const sections = [];

  sections.push(`<section class="resource-section" aria-labelledby="resource-overview-heading">
  <h2 id="resource-overview-heading">Resource accounting overview</h2>
  <p>${rollup.event_count} events across ${rollup.project_count} project(s) and ${rollup.task_count} task(s). Generated ${escapeHtml(rollup.generated_at)}.</p>
  <p class="section-note">No single sustainability score is calculated. Energy is reported in Wh, emissions in gCO2e, CPU time in CPU-seconds, elapsed time in milliseconds and memory in bytes. A missing value is shown as “—” and is not zero. A partial estimate is never presented as a complete total.</p>
</section>`);

  sections.push(`<section class="resource-section" aria-labelledby="local-computing-heading">
  <h2 id="local-computing-heading">Local computing</h2>
  <p class="section-note">Energy from a local tracker or model is an estimate of the tracked process boundary. It does not include remote AI inference or GitHub-hosted runners.</p>
  ${renderTable({
    id: 'local-computing-table',
    caption: 'Local computing totals',
    description: 'Totals for local measured commands in this window. Coverage describes how complete the energy evidence is.',
    columns: [
      { key: 'metric', label: 'Metric' },
      { key: 'value', label: 'Value', numeric: true },
      { key: 'coverage', label: 'Coverage' },
    ],
    rows: [
      { metric: 'Wall clock', value: formatMs(local.wall_ms), coverage: '—' },
      { metric: 'CPU time', value: `${formatNumber(local.cpu_seconds, 3)} CPU-seconds`, coverage: '—' },
      { metric: 'Peak resident memory', value: formatBytes(local.peak_rss_bytes), coverage: '—' },
      { metric: 'Energy', value: `${formatNumber(local.energy.estimated_wh ?? local.energy.measured_wh, 6)} Wh`, coverage: local.energy.coverage },
      { metric: 'Operational emissions', value: `${formatNumber(local.emissions_gco2e, 8)} gCO2e`, coverage: local.energy.coverage },
    ],
  })}
  <h3>By activity</h3>
  ${renderTable({
    id: 'local-activity-table',
    caption: 'Local computing by activity',
    columns: [
      { key: 'activity', label: 'Activity' },
      { key: 'events', label: 'Events', numeric: true },
      { key: 'cpu', label: 'CPU-seconds', numeric: true },
      { key: 'energy', label: 'Energy (Wh)', numeric: true },
      { key: 'coverage', label: 'Coverage' },
    ],
    rows: rollup.maintenance.by_activity.map((row) => ({
      activity: row.activity,
      events: row.events,
      cpu: formatNumber(row.cpu_seconds, 3),
      energy: formatNumber(row.estimated_wh, 6),
      coverage: row.coverage,
    })),
    empty: 'No local activity in this window.',
  })}
  <p class="section-note">Methods: ${local.energy.methods.length ? escapeHtml(local.energy.methods.join(', ')) : 'unavailable'}. Boundaries: ${local.energy.boundaries.length ? escapeHtml(local.energy.boundaries.join(', ')) : 'unavailable'}.</p>
</section>`);

  sections.push(`<section class="resource-section" aria-labelledby="remote-ai-heading">
  <h2 id="remote-ai-heading">Remote AI inference</h2>
  <p class="section-note">Token counts are provider-reported where available. A model without a local per-token factor dataset remains unsupported; it is not silently mapped to another model. CLEER and EcoLogits estimates are reported separately and are never added together.</p>
  ${renderTable({
    id: 'remote-ai-table',
    caption: 'Remote AI usage and energy',
    columns: [
      { key: 'metric', label: 'Metric' },
      { key: 'value', label: 'Value', numeric: true },
      { key: 'coverage', label: 'Coverage' },
    ],
    rows: [
      { metric: 'Requests', value: formatNumber(remote.requests, 0), coverage: '—' },
      { metric: 'Complete estimates', value: formatNumber(remote.complete_estimates, 0), coverage: '—' },
      { metric: 'Partial estimates', value: formatNumber(remote.partial_estimates, 0), coverage: '—' },
      { metric: 'Unavailable estimates', value: formatNumber(remote.unavailable_estimates, 0), coverage: '—' },
      { metric: 'Uncached input tokens', value: formatNumber(remote.tokens.uncached_input, 0), coverage: 'provider-reported where available' },
      { metric: 'Cache creation tokens', value: formatNumber(remote.tokens.cache_creation, 0), coverage: 'provider-reported where available' },
      { metric: 'Cache read tokens', value: formatNumber(remote.tokens.cache_read, 0), coverage: 'provider-reported where available' },
      { metric: 'Output tokens', value: formatNumber(remote.tokens.output, 0), coverage: 'provider-reported where available' },
      { metric: 'Reasoning tokens (not added to output)', value: formatNumber(remote.tokens.reasoning, 0), coverage: 'provider-reported where available' },
    ],
  })}
  <h3>By model</h3>
  ${renderTable({
    id: 'remote-ai-model-table',
    caption: 'Remote AI energy by model',
    columns: [
      { key: 'provider', label: 'Provider' },
      { key: 'model', label: 'Model' },
      { key: 'requests', label: 'Requests', numeric: true },
      { key: 'energy', label: 'Energy (Wh)', numeric: true },
      { key: 'coverage', label: 'Coverage' },
      { key: 'methodology', label: 'Methodology' },
    ],
    rows: remote.by_model.map((row) => ({
      provider: row.provider ?? '—',
      model: row.model ?? '—',
      requests: row.requests,
      energy: formatNumber(row.energy_mean_wh, 6),
      coverage: row.coverage,
      methodology: row.methodology ?? '—',
    })),
    empty: 'No AI requests in this window.',
  })}
  <h3>By methodology and dataset</h3>
  ${renderTable({
    id: 'remote-ai-methodology-table',
    caption: 'Remote AI energy estimates by methodology and dataset',
    description: 'Each row is a separate methodology and accounting boundary. Rows are not summed across methodologies.',
    columns: [
      { key: 'source', label: 'Source' },
      { key: 'dataset', label: 'Dataset version' },
      { key: 'boundary', label: 'Boundary' },
      { key: 'requests', label: 'Requests', numeric: true },
      { key: 'mean', label: 'Mean Wh', numeric: true },
      { key: 'sd', label: 'Standard deviation Wh', numeric: true },
      { key: 'coverage', label: 'Coverage' },
    ],
    rows: remote.energy_by_methodology.map((row) => ({
      source: row.source ?? '—',
      dataset: row.dataset_version ?? '—',
      boundary: row.boundary ?? '—',
      requests: row.requests,
      mean: formatNumber(row.mean_wh, 6),
      sd: formatNumber(row.standard_deviation_wh, 6),
      coverage: row.coverage,
    })),
    empty: 'No estimated inference energy in this window.',
  })}
  <h3>Supported and unsupported models</h3>
  ${renderTable({
    id: 'remote-ai-unsupported-table',
    caption: 'Models without a usable per-token factor',
    columns: [
      { key: 'model', label: 'Model' },
      { key: 'requests', label: 'Requests', numeric: true },
      { key: 'reason', label: 'Reason' },
    ],
    rows: remote.unsupported_models.map((row) => ({
      model: row.model ?? '—',
      requests: row.requests,
      reason: row.reason,
    })),
    empty: 'Every observed model had a usable factor in this window.',
  })}
  <p class="section-note">Financial cost: reported ${formatNumber(remote.cost.reported_usd, 4)} ${remote.cost.currency ?? ''}; estimated ${formatNumber(remote.cost.estimated_usd, 4)} ${remote.cost.currency ?? ''}. A cost is not used to infer token categories or energy.</p>
</section>`);

  sections.push(`<section class="resource-section" aria-labelledby="maintenance-heading">
  <h2 id="maintenance-heading">Repository maintenance and verification</h2>
  <p class="section-note">A successful command is not a verified maintenance outcome. Only explicitly verified tasks count as verified.</p>
  ${renderTable({
    id: 'maintenance-table',
    caption: 'Maintenance outcomes and hosted-service evidence',
    columns: [
      { key: 'metric', label: 'Metric' },
      { key: 'value', label: 'Value', numeric: true },
    ],
    rows: [
      { metric: 'Verified tasks', value: formatNumber(rollup.maintenance.verified_tasks, 0) },
      { metric: 'Unverified or in-progress tasks', value: formatNumber(rollup.maintenance.unverified_tasks, 0) },
      { metric: 'Failed tasks', value: formatNumber(rollup.maintenance.failed_tasks, 0) },
      { metric: 'GitHub API requests', value: formatNumber(rollup.maintenance.api?.requests, 0) },
      { metric: 'Requests per evaluated repository', value: formatNumber(rollup.maintenance.api?.requests_per_evaluated_repository, 2) },
      { metric: 'HTTP 304 responses', value: formatNumber(rollup.maintenance.api?.status_304, 0) },
      { metric: 'Cache hit rate', value: rollup.maintenance.api?.cache_hit_rate === null || rollup.maintenance.api?.cache_hit_rate === undefined ? '—' : `${(rollup.maintenance.api.cache_hit_rate * 100).toFixed(1)}%` },
      { metric: 'Repositories evaluated', value: formatNumber(rollup.maintenance.api?.repositories_evaluated, 0) },
      { metric: 'Inventory scan complete', value: rollup.maintenance.api?.complete === null || rollup.maintenance.api?.complete === undefined ? '—' : (rollup.maintenance.api.complete ? 'yes' : 'no') },
      { metric: 'Workflow runs', value: formatNumber(rollup.maintenance.ci?.workflow_runs, 0) },
      { metric: 'Workflow elapsed time', value: formatMs(rollup.maintenance.ci?.workflow_elapsed_ms) },
      { metric: 'Summed job execution time', value: formatMs(rollup.maintenance.ci?.job_elapsed_ms) },
    ],
  })}
  <p class="section-note">GitHub Actions elapsed time is not CPU time or electricity consumption. API request counts are not converted into energy with an arbitrary factor.</p>
</section>`);

  sections.push(`<section class="resource-section" aria-labelledby="quality-heading">
  <h2 id="quality-heading">Measurement quality</h2>
  ${renderTable({
    id: 'quality-table',
    caption: 'Evidence by measurement quality',
    columns: [
      { key: 'quality', label: 'Quality class' },
      { key: 'events', label: 'Events', numeric: true },
    ],
    rows: [
      { quality: 'Measured', events: rollup.measurement_quality.measured },
      { quality: 'Provider-reported', events: rollup.measurement_quality.provider_reported },
      { quality: 'Derived', events: rollup.measurement_quality.derived },
      { quality: 'Estimated', events: rollup.measurement_quality.estimated },
      { quality: 'Partial', events: rollup.measurement_quality.partial },
      { quality: 'Unavailable', events: rollup.measurement_quality.unavailable },
    ],
  })}
</section>`);

  sections.push(`<section class="resource-section" aria-labelledby="functional-units-heading">
  <h2 id="functional-units-heading">Functional units</h2>
  <p class="section-note">Absolute totals remain the primary record. A ratio is withheld when its denominator or measurement coverage is insufficient, and failed or abandoned work remains in the totals.</p>
  ${renderTable({
    id: 'functional-units-table',
    caption: 'Resource consumption per useful outcome',
    columns: [
      { key: 'unit', label: 'Functional unit' },
      { key: 'value', label: 'Wh', numeric: true },
      { key: 'denominator', label: 'Denominator', numeric: true },
      { key: 'coverage', label: 'Coverage' },
      { key: 'reason', label: 'Note' },
    ],
    rows: rollup.functional_units.map((row) => ({
      unit: row.label,
      value: formatNumber(row.value_wh, 6),
      denominator: formatNumber(row.denominator, 0),
      coverage: row.coverage,
      reason: row.reason ?? '—',
    })),
    empty: 'No functional unit is calculable from this evidence.',
  })}
</section>`);

  sections.push(`<section class="resource-section" aria-labelledby="monitoring-heading">
  <h2 id="monitoring-heading">Monitoring overhead</h2>
  ${renderTable({
    id: 'monitoring-table',
    caption: 'Cost of collection and storage',
    columns: [
      { key: 'metric', label: 'Metric' },
      { key: 'value', label: 'Value', numeric: true },
    ],
    rows: [
      { metric: 'Monitoring events', value: formatNumber(rollup.monitoring.events, 0) },
      { metric: 'Collection time', value: formatMs(rollup.monitoring.duration_ms) },
      { metric: 'Collector CPU time', value: `${formatNumber(rollup.monitoring.cpu_seconds, 3)} CPU-seconds` },
      { metric: 'Ledger size', value: formatBytes(rollup.monitoring.ledger_bytes) },
      { metric: 'Raw measurement size', value: formatBytes(rollup.monitoring.raw_bytes) },
    ],
  })}
  <p class="section-note">Collector overhead is reported separately and is not mixed into the activity it measured.</p>
</section>`);

  sections.push(`<section class="resource-section" aria-labelledby="limitations-heading">
  <h2 id="limitations-heading">Limitations and methodology</h2>
  <ul>
    ${rollup.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join('\n    ')}
  </ul>
  <p><a href="docs/RESOURCE-METHODOLOGY.md">Resource methodology</a> · <a href="docs/CODECARBON.md">CodeCarbon notes</a> · <a href="docs/AI-RESOURCE-ACCOUNTING.md">AI resource accounting</a> · <a href="docs/RESOURCE-PRIVACY.md">Privacy</a></p>
</section>`);

  return sections.join('\n');
}

const ResourceView = {
  escapeHtml,
  formatNumber,
  formatBytes,
  formatMs,
  renderTable,
  renderCsv,
  renderResourceDashboard,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ResourceView;
} else {
  window.ResourceView = ResourceView;
}
