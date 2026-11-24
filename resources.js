/**
 * Resource dashboard: loads one sanitized rollup, validates it against the
 * published schema, and renders accessible tables. No network calls beyond
 * the rollup/schema files on this static site. No AI, no telemetry.
 */

(function initResourceDashboard() {
  const sourceSelect = document.getElementById('resourceSource');
  const status = document.getElementById('resourceStatus');
  const error = document.getElementById('resourceError');
  const content = document.getElementById('resourceContent');
  const exportJson = document.getElementById('exportResourceJson');
  const exportCsv = document.getElementById('exportResourceCsv');
  let currentRollup = null;

  function setStatus(message) {
    status.textContent = message;
  }

  function setError(message) {
    error.textContent = message;
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return response.json();
  }

  async function loadSchema() {
    try {
      return await fetchJson('policy/resource-rollup.schema.json');
    } catch {
      return null;
    }
  }

  function validate(rollup, schema) {
    if (!schema || !window.PolicyValidator) return [];
    return window.PolicyValidator.validatePolicySchema(rollup, schema);
  }

  function render(rollup) {
    currentRollup = rollup;
    content.innerHTML = window.ResourceView.renderResourceDashboard(rollup);
    exportJson.disabled = false;
    exportCsv.disabled = false;
  }

  function safeRender(rollup) {
    try {
      render(rollup);
      return true;
    } catch (renderError) {
      console.error('Resource dashboard render error', renderError);
      setStatus('');
      setError(`The resource rollup could not be rendered: ${renderError.message}`);
      return false;
    }
  }

  function download(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function load(url, { fallback = true } = {}) {
    setError('');
    setStatus('Loading resource rollup…');
    exportJson.disabled = true;
    exportCsv.disabled = true;
    try {
      const [rollup, schema] = await Promise.all([fetchJson(url), loadSchema()]);
      const problems = validate(rollup, schema);
      if (problems.length) {
        setStatus('');
        setError(`The resource rollup did not pass schema validation (${problems.length} problem(s)). The page is not rendering unvalidated data.`);
        console.error('Resource rollup validation problems', problems);
        return;
      }
      if (!safeRender(rollup)) return;
      setStatus(`Loaded ${rollup.event_count} events generated ${rollup.generated_at}. Coverage: local energy ${rollup.local_computing.energy.coverage}; remote estimates ${rollup.remote_ai.complete_estimates} complete, ${rollup.remote_ai.partial_estimates} partial, ${rollup.remote_ai.unavailable_estimates} unavailable.`);
    } catch (loadError) {
      if (fallback && url !== 'fixtures/resource/resource-rollup.sample.json') {
        setStatus('Published rollup not found; loading the synthetic sample fixture instead.');
        await load('fixtures/resource/resource-rollup.sample.json', { fallback: false });
        return;
      }
      setStatus('');
      setError(`Could not load the resource rollup: ${loadError.message}`);
    }
  }

  sourceSelect.addEventListener('change', () => {
    load(sourceSelect.value);
  });

  exportJson.addEventListener('click', () => {
    if (!currentRollup) return;
    download('resource-rollup.public.json', `${JSON.stringify(currentRollup, null, 2)}\n`, 'application/json');
  });

  exportCsv.addEventListener('click', () => {
    if (!currentRollup) return;
    download('resource-summary.csv', window.ResourceView.renderCsv(currentRollup), 'text/csv');
  });

  load(sourceSelect.value);
}());
