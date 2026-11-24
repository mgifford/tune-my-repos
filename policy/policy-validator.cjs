/**
 * Minimal, dependency-free JSON Schema (draft-07 subset) validator for the
 * maintenance policy file and the rollup. Only implements the keywords
 * actually used in policy.schema.json and rollup.schema.json — this is not
 * a general-purpose validator.
 */

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function validateAgainstSchema(instance, schema, rootSchema = schema, path = '$') {
  const errors = [];
  const resolvedSchema = schema.$ref ? resolveRef(schema.$ref, rootSchema) : schema;

  // `type` may be a single string or an array of allowed types. Integer values
  // also satisfy `number`, matching JSON Schema semantics.
  const actualType = valueType(instance);
  if (resolvedSchema.type !== undefined) {
    const allowed = Array.isArray(resolvedSchema.type) ? resolvedSchema.type : [resolvedSchema.type];
    const matches = allowed.includes(actualType)
      || (actualType === 'integer' && allowed.includes('number'));
    if (!matches) {
      errors.push(`${path}: expected ${allowed.join(' or ')}`);
      return errors;
    }
  }

  if (resolvedSchema.const !== undefined && instance !== resolvedSchema.const) {
    errors.push(`${path}: expected constant ${JSON.stringify(resolvedSchema.const)}`);
  }

  if (resolvedSchema.enum !== undefined && !resolvedSchema.enum.includes(instance)) {
    errors.push(`${path}: ${JSON.stringify(instance)} is not one of ${JSON.stringify(resolvedSchema.enum)}`);
  }

  if (typeof instance === 'number') {
    if (resolvedSchema.minimum !== undefined && instance < resolvedSchema.minimum) {
      errors.push(`${path}: ${instance} is below minimum ${resolvedSchema.minimum}`);
    }
    if (resolvedSchema.maximum !== undefined && instance > resolvedSchema.maximum) {
      errors.push(`${path}: ${instance} is above maximum ${resolvedSchema.maximum}`);
    }
    if (resolvedSchema.exclusiveMinimum !== undefined && instance <= resolvedSchema.exclusiveMinimum) {
      errors.push(`${path}: ${instance} must be greater than ${resolvedSchema.exclusiveMinimum}`);
    }
    if (resolvedSchema.exclusiveMaximum !== undefined && instance >= resolvedSchema.exclusiveMaximum) {
      errors.push(`${path}: ${instance} must be less than ${resolvedSchema.exclusiveMaximum}`);
    }
  }

  if (actualType === 'object') {
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
  } else if (actualType === 'array') {
    if (resolvedSchema.maxItems !== undefined && instance.length > resolvedSchema.maxItems) {
      errors.push(`${path}: array longer than maxItems ${resolvedSchema.maxItems}`);
    }
    if (resolvedSchema.minItems !== undefined && instance.length < resolvedSchema.minItems) {
      errors.push(`${path}: array shorter than minItems ${resolvedSchema.minItems}`);
    }
    if (resolvedSchema.items) {
      instance.forEach((item, i) => {
        errors.push(...validateAgainstSchema(item, resolvedSchema.items, rootSchema, `${path}[${i}]`));
      });
    }
  } else if (actualType === 'string') {
    if (resolvedSchema.pattern && !new RegExp(resolvedSchema.pattern).test(instance)) {
      errors.push(`${path}: "${instance}" does not match pattern ${resolvedSchema.pattern}`);
    }
    if (resolvedSchema.minLength !== undefined && instance.length < resolvedSchema.minLength) {
      errors.push(`${path}: string shorter than minLength ${resolvedSchema.minLength}`);
    }
    if (resolvedSchema.maxLength !== undefined && instance.length > resolvedSchema.maxLength) {
      errors.push(`${path}: string longer than maxLength ${resolvedSchema.maxLength}`);
    }
  }

  return errors;
}

function resolveRef(ref, rootSchema) {
  // Supports local "#/definitions/X" and "#/$defs/X" refs, which are the only
  // forms the policy, rollup and resource schemas use.
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
