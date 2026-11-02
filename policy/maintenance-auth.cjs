/**
 * Pure helpers for the maintenance dashboard's sign-in gate. The rollup is
 * stored in a PRIVATE repository, so the only way to read it is the GitHub
 * API with a token the viewer supplies; nothing here touches the network.
 */

const DATA_REPO = 'mgifford/tune-my-repos-data';
const DATA_PATH = 'maintenance-rollup.public.json';

function normalizeToken(value) {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  if (token === '' || /\s/.test(token)) return null;
  return token;
}

function buildDataRequest(token) {
  const clean = normalizeToken(token);
  if (!clean) throw new Error('A GitHub token is required');
  return {
    url: `https://api.github.com/repos/${DATA_REPO}/contents/${DATA_PATH}`,
    headers: {
      Accept: 'application/vnd.github.raw+json',
      Authorization: `Bearer ${clean}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };
}

function describeAuthFailure(status) {
  if (status === 401) return 'GitHub rejected that token. Check that it is correct and has not expired.';
  if (status === 403) return 'The token lacks permission, or GitHub rate-limited the request. Try again shortly.';
  if (status === 404) {
    return `Could not find the private data repository ${DATA_REPO}, or this token cannot access it. The token needs read-only Contents access to that repository.`;
  }
  return `GitHub returned an unexpected response (HTTP ${status}).`;
}

const MaintenanceAuth = { normalizeToken, buildDataRequest, describeAuthFailure, DATA_REPO, DATA_PATH };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MaintenanceAuth;
} else {
  window.MaintenanceAuth = MaintenanceAuth;
}
