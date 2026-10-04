/**
 * Public-safe redaction applied to a maintenance rollup before it is
 * rendered or exported from an unauthenticated page (maintenance.html has
 * no access control). Dependabot security alerts are private on GitHub
 * even for public repos, so exact critical/high/moderate/low counts must
 * never be exposed here — only the has_urgent_alerts boolean. See
 * policy/rollup.schema.json.
 */

function redactExactAlertCounts(rollup) {
  return {
    ...rollup,
    repositories: rollup.repositories.map((repo) => ({
      ...repo,
      security_alerts: { has_urgent_alerts: repo.security_alerts.has_urgent_alerts },
    })),
  };
}

const PublicRedaction = { redactExactAlertCounts };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PublicRedaction;
} else {
  window.PublicRedaction = PublicRedaction;
}
