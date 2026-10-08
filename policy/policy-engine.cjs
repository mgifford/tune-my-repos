/**
 * Deterministic policy engine for the maintenance control plane.
 *
 * No network access, no AI. Pure functions over a parsed policy object and
 * plain-object inputs describing a repository or a dependency update.
 * Works in both Node (tests, Actions) and the browser (dashboard).
 */

const VALID_RISK_STATES = ['eligible', 'needs_review', 'needs_repair', 'blocked', 'ignored'];
const VALID_DEPENDENCY_CLASSES = ['github-actions', 'development', 'production', 'major', 'unknown'];
const VALID_UPDATE_TYPES = ['patch', 'minor', 'major'];

/**
 * Validate a parsed policy object against structural invariants that go
 * beyond JSON Schema (e.g. cross-field consistency). Call validatePolicySchema
 * (policy-validator.cjs) first for full schema conformance.
 * @returns {string[]} list of error messages; empty if valid
 */
function validatePolicyInvariants(policy) {
  const errors = [];

  if (!policy || typeof policy !== 'object') {
    return ['policy must be an object'];
  }

  for (const cls of VALID_DEPENDENCY_CLASSES) {
    if (!policy.dependency_classes || !policy.dependency_classes[cls]) {
      errors.push(`dependency_classes.${cls} is required`);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const [i, override] of (policy.overrides || []).entries()) {
    if (!VALID_RISK_STATES.includes(override.risk_state)) {
      errors.push(`overrides[${i}].risk_state "${override.risk_state}" is not a valid risk state`);
    }
    if (override.expires < today) {
      errors.push(`overrides[${i}] expired on ${override.expires} and must be re-justified or removed`);
    }
  }

  return errors;
}

/**
 * Match a repository full_name ("owner/repo") against policy include/exclude
 * patterns. Patterns are either an exact "owner/repo" string or an "owner/*"
 * prefix glob.
 */
function repositoryMatchesPattern(fullName, pattern) {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1); // keep trailing "/"
    return fullName.startsWith(prefix);
  }
  return fullName === pattern;
}

function isRepositoryInPolicy(policy, fullName) {
  const included = (policy.repositories.include || []).some((p) => repositoryMatchesPattern(fullName, p));
  if (!included) return false;
  const excluded = (policy.repositories.exclude || []).some((p) => repositoryMatchesPattern(fullName, p));
  return !excluded;
}

/**
 * Resolve the tier for a repository. Defaults to "manual" when the
 * repository is not explicitly listed in any tier.
 */
function getRepositoryTier(policy, fullName) {
  const tierNames = ['pilot', 'standard', 'archive', 'manual'];
  for (const tier of tierNames) {
    const list = policy.tiers[tier] || [];
    if (list.some((p) => repositoryMatchesPattern(fullName, p))) {
      return tier;
    }
  }
  return 'manual';
}

/**
 * Find a non-expired override matching the given dependency update, if any.
 * @param {object} policy
 * @param {{repository: string, dependency_name: string, ecosystem: string}} update
 * @param {string} [todayIso] override "today" for deterministic testing
 */
function findActiveOverride(policy, update, todayIso = new Date().toISOString().slice(0, 10)) {
  const overrides = policy.overrides || [];
  return overrides.find((o) =>
    o.repository === update.repository &&
    o.dependency_name === update.dependency_name &&
    o.ecosystem === update.ecosystem &&
    o.expires >= todayIso
  ) || null;
}

/**
 * Classify one dependency update against the policy and return a
 * deterministic decision.
 *
 * @param {object} policy - parsed maintenance-policy.yml
 * @param {object} update - {
 *   repository: string,              // "owner/repo"
 *   dependency_class: string,        // one of VALID_DEPENDENCY_CLASSES
 *   update_type: string,             // one of VALID_UPDATE_TYPES ("any" also accepted for major/unknown)
 *   required_ci_passed: boolean,
 *   touches_workflow_permissions: boolean,
 *   is_lockfile_only: boolean,
 *   is_generated_output_only: boolean,
 *   requires_new_secret_or_elevated_access: boolean,
 *   required_check_failed: boolean
 * }
 * @returns {{risk_state: string, reason: string, tier: string, override_applied: boolean}}
 */
function classifyUpdate(policy, update) {
  if (!isRepositoryInPolicy(policy, update.repository)) {
    return {
      risk_state: 'ignored',
      reason: `Repository ${update.repository} is not included in policy scope`,
      tier: 'manual',
      override_applied: false,
    };
  }

  const tier = getRepositoryTier(policy, update.repository);

  // Special cases always win, regardless of dependency class, and cannot be
  // bypassed by tier. An override can still apply afterward.
  if (update.touches_workflow_permissions) {
    return withOverride(policy, update, tier, policy.special_cases.workflow_permission_change);
  }
  if (update.requires_new_secret_or_elevated_access) {
    return withOverride(policy, update, tier, policy.special_cases.requires_secret_or_elevated_access);
  }
  if (update.required_check_failed) {
    return withOverride(policy, update, tier, policy.special_cases.failing_required_check);
  }
  if (update.is_lockfile_only) {
    return withOverride(policy, update, tier, policy.special_cases.lockfile_only_change);
  }
  if (update.is_generated_output_only) {
    return withOverride(policy, update, tier, policy.special_cases.generated_output_change);
  }

  const depClass = VALID_DEPENDENCY_CLASSES.includes(update.dependency_class)
    ? update.dependency_class
    : 'unknown';
  const classRules = policy.dependency_classes[depClass];

  let rule;
  if (depClass === 'major' || depClass === 'unknown') {
    rule = classRules.any;
  } else {
    const updateType = VALID_UPDATE_TYPES.includes(update.update_type) ? update.update_type : null;
    if (!updateType) {
      rule = policy.dependency_classes.unknown.any;
      return withOverride(policy, update, tier, {
        risk_state: rule.risk_state,
        reason: `Unrecognized update_type "${update.update_type}" for dependency class "${depClass}"; treated as unknown`,
      });
    }
    rule = classRules[updateType];
  }

  let riskState = rule.risk_state;
  let reason = classRules.description;

  if (riskState === 'eligible') {
    const unmet = (rule.requires || []).filter((req) => req === 'required_ci_pass' && !update.required_ci_passed);
    if (unmet.length > 0) {
      riskState = 'needs_review';
      reason = `${classRules.description} — eligible once required CI passes`;
    } else {
      reason = `${classRules.description} — required checks passed`;
    }
  }

  return withOverride(policy, update, tier, { risk_state: riskState, reason });
}

function withOverride(policy, update, tier, base) {
  const override = findActiveOverride(policy, update);
  if (override) {
    return {
      risk_state: override.risk_state,
      reason: override.reason,
      tier,
      override_applied: true,
    };
  }
  return {
    risk_state: base.risk_state,
    reason: base.reason,
    tier,
    override_applied: false,
  };
}

const PolicyEngine = {
  VALID_RISK_STATES,
  VALID_DEPENDENCY_CLASSES,
  VALID_UPDATE_TYPES,
  validatePolicyInvariants,
  repositoryMatchesPattern,
  isRepositoryInPolicy,
  getRepositoryTier,
  findActiveOverride,
  classifyUpdate,
};

// Node (tests, Actions) vs. plain <script> in the browser — no build step.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PolicyEngine;
} else {
  window.PolicyEngine = PolicyEngine;
}
