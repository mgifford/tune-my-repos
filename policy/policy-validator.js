/**
 * Minimal, dependency-free JSON Schema (draft-07 subset) validator for the
 * maintenance policy file. Only implements the keywords actually used in
 * policy.schema.json — this is not a general-purpose validator.
 */

function validateAgainstSchema(instance, schema, rootSchema = schema, path = '$') {
  const errors = [];
  const resolvedSchema = schema.$ref ? resolveRef(schema.$ref, rootSchema) : schema;

  if (resolvedSchema.type === 'object') {
    if (typeof instance !== 'object' || instance === null || Array.isArray(instance)) {
      errors.push(`${path}: expected object`);
      return errors;
    }
    for (const key of resolvedSchema.required || []) {
      if (!(key in instance)) {
        errors.push(`${path}: missing required property "${key}"`);
      }
    }
    if (resolvedSchema.additionalProperties === false) {
      const allowed = new Set(Object.keys(resolvedSchema.properties || {}));
      const patternKeys = Object.keys(resolvedSchema.patternProperties || {}).map((p) => new RegExp(p));
      for (const key of Object.keys(instance)) {
        const matchesPattern = patternKeys.some((re) => re.test(key));
        if (!allowed.has(key) && !matchesPattern) {
          errors.push(`${path}: unexpected property "${key}"`);
        }
      }
    }
    for (const [key, subSchema] of Object.entries(resolvedSchema.properties || {})) {
      if (key in instance) {
        errors.push(...validateAgainstSchema(instance[key], subSchema, rootSchema, `${path}.${key}`));
      }
    }
    for (const [pattern, subSchema] of Object.entries(resolvedSchema.patternProperties || {})) {
      const re = new RegExp(pattern);
      for (const key of Object.keys(instance)) {
        if (re.test(key)) {
          errors.push(...validateAgainstSchema(instance[key], subSchema, rootSchema, `${path}.${key}`));
        }
      }
    }
  } else if (resolvedSchema.type === 'array') {
    if (!Array.isArray(instance)) {
      errors.push(`${path}: expected array`);
      return errors;
    }
    if (resolvedSchema.items) {
      instance.forEach((item, i) => {
        errors.push(...validateAgainstSchema(item, resolvedSchema.items, rootSchema, `${path}[${i}]`));
      });
    }
  } else if (resolvedSchema.type === 'string') {
    if (typeof instance !== 'string') {
      errors.push(`${path}: expected string`);
    } else {
      if (resolvedSchema.pattern && !new RegExp(resolvedSchema.pattern).test(instance)) {
        errors.push(`${path}: "${instance}" does not match pattern ${resolvedSchema.pattern}`);
      }
      if (resolvedSchema.enum && !resolvedSchema.enum.includes(instance)) {
        errors.push(`${path}: "${instance}" is not one of ${JSON.stringify(resolvedSchema.enum)}`);
      }
      if (resolvedSchema.minLength && instance.length < resolvedSchema.minLength) {
        errors.push(`${path}: string shorter than minLength ${resolvedSchema.minLength}`);
      }
    }
  } else if (resolvedSchema.type === 'integer') {
    if (!Number.isInteger(instance)) {
      errors.push(`${path}: expected integer`);
    } else if (resolvedSchema.minimum !== undefined && instance < resolvedSchema.minimum) {
      errors.push(`${path}: ${instance} is below minimum ${resolvedSchema.minimum}`);
    }
  }

  return errors;
}

function resolveRef(ref, rootSchema) {
  // Only supports local "#/definitions/X" refs, which is all this schema uses.
  const parts = ref.replace('#/', '').split('/');
  return parts.reduce((node, part) => node[part], rootSchema);
}

/**
 * @param {object} policyJson - parsed maintenance-policy.json
 * @param {object} schema - parsed policy.schema.json
 * @returns {string[]} list of error messages; empty if valid
 */
function validatePolicySchema(policyJson, schema) {
  return validateAgainstSchema(policyJson, schema, schema, '$');
}

const PolicyValidator = { validatePolicySchema };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PolicyValidator;
} else {
  window.PolicyValidator = PolicyValidator;
}
