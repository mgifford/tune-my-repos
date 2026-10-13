/**
 * Deterministic library-change suggestions for npm dependencies. Two
 * sources, both explicit:
 *   1. KNOWN_REPLACEMENTS: a curated, reviewable list of packages with a
 *      documented deprecation or a native/lighter replacement.
 *   2. npm registry facts, fetched by the caller: the latest version's
 *      "deprecated" message and its publish date (unmaintained check).
 * No AI and no guessing: a package is flagged only by a rule below or by
 * what the registry itself reports. Suggestions are advisory; replacing a
 * library is a human decision.
 */

const UNMAINTAINED_AFTER_DAYS = 730; // AGENTS.md: no updates for more than 2 years
const MAX_ADVICE_PER_REPO = 20;

// kind: 'deprecated' (upstream says stop using it), 'compromised' (a
// published release was sabotaged), 'native' (the platform now does this),
// 'lighter' (a smaller maintained option exists; also cuts bytes shipped).
const KNOWN_REPLACEMENTS = {
  'request': { kind: 'deprecated', suggestion: 'Use the built-in fetch (Node 18+ and browsers).' },
  'request-promise': { kind: 'deprecated', suggestion: 'Use the built-in fetch (Node 18+ and browsers).' },
  'request-promise-native': { kind: 'deprecated', suggestion: 'Use the built-in fetch (Node 18+ and browsers).' },
  'node-fetch': { kind: 'native', suggestion: 'Node 18+ has a global fetch; the package is only needed for older Node.' },
  'node-sass': { kind: 'deprecated', suggestion: 'Use sass (Dart Sass); LibSass and node-sass are deprecated.' },
  'tslint': { kind: 'deprecated', suggestion: 'Use ESLint with typescript-eslint.' },
  'babel-eslint': { kind: 'deprecated', suggestion: 'Use @babel/eslint-parser.' },
  'uglify-es': { kind: 'deprecated', suggestion: 'Use terser, the maintained fork.' },
  'istanbul': { kind: 'deprecated', suggestion: 'Use c8 (native V8 coverage) or nyc.' },
  'node-uuid': { kind: 'deprecated', suggestion: 'Use crypto.randomUUID() for v4 IDs, or the uuid package.' },
  'popper.js': { kind: 'deprecated', suggestion: 'Renamed to @popperjs/core; or use @floating-ui/dom.' },
  'colors': { kind: 'compromised', suggestion: 'A sabotaged release was published in 2022; use picocolors or node:util styleText.' },
  'faker': { kind: 'compromised', suggestion: 'The original package was wiped by its author in 2022; use @faker-js/faker.' },
  'moment': { kind: 'lighter', suggestion: 'Moment is in maintenance mode; consider Intl.DateTimeFormat, date-fns or Day.js.' },
  'left-pad': { kind: 'native', suggestion: 'Use String.prototype.padStart.' },
  'object-assign': { kind: 'native', suggestion: 'Use Object.assign or object spread.' },
  'es6-promise': { kind: 'native', suggestion: 'Promise is built in to every supported runtime.' },
  'querystring': { kind: 'native', suggestion: 'Use URLSearchParams.' },
  'mkdirp': { kind: 'native', suggestion: 'Use fs.mkdir(path, { recursive: true }) (Node 10.12+).' },
  'rimraf': { kind: 'native', suggestion: 'Use fs.rm(path, { recursive: true, force: true }) (Node 14.14+).' },
  'jquery': { kind: 'lighter', suggestion: 'For new code, native DOM APIs (querySelector, fetch, classList) cover most uses.' },
};

/**
 * Direct dependencies from a parsed package.json, with their type.
 * @returns {{name: string, type: 'production'|'development'}[]}
 */
function listDirectDependencies(packageJson) {
  if (!packageJson || typeof packageJson !== 'object') return [];
  const out = [];
  for (const [field, type] of [['dependencies', 'production'], ['devDependencies', 'development']]) {
    const deps = packageJson[field];
    if (deps && typeof deps === 'object') {
      for (const name of Object.keys(deps)) out.push({ name, type });
    }
  }
  return out;
}

/**
 * @param {{name: string, type: string}[]} dependencies
 * @param {Map<string, {deprecated?: string, lastPublished?: string}|null>} registryFacts
 * @param {Date} now
 * @returns {{package: string, dependency_type: string, kind: string, suggestion: string}[]}
 */
function evaluateLibraryAdvice(dependencies, registryFacts, now) {
  const advice = [];
  for (const dep of dependencies) {
    const known = KNOWN_REPLACEMENTS[dep.name];
    const facts = registryFacts.get(dep.name) || null;
    if (known) {
      advice.push({ package: dep.name, dependency_type: dep.type, kind: known.kind, suggestion: known.suggestion });
    } else if (facts && facts.deprecated) {
      advice.push({ package: dep.name, dependency_type: dep.type, kind: 'deprecated', suggestion: `npm says: ${facts.deprecated}` });
    } else if (facts && facts.lastPublished) {
      const days = Math.floor((now.getTime() - Date.parse(facts.lastPublished)) / 86400000);
      if (days > UNMAINTAINED_AFTER_DAYS) {
        const years = Math.floor(days / 365);
        advice.push({ package: dep.name, dependency_type: dep.type, kind: 'unmaintained', suggestion: `No npm release in over ${years} years; check for a maintained alternative.` });
      }
    }
  }
  const order = { compromised: 0, deprecated: 1, unmaintained: 2, native: 3, lighter: 4 };
  advice.sort((a, b) => order[a.kind] - order[b.kind] || (a.dependency_type === 'production' ? -1 : 1) - (b.dependency_type === 'production' ? -1 : 1) || a.package.localeCompare(b.package));
  return advice.slice(0, MAX_ADVICE_PER_REPO);
}

const LibraryAdvice = {
  KNOWN_REPLACEMENTS,
  UNMAINTAINED_AFTER_DAYS,
  MAX_ADVICE_PER_REPO,
  listDirectDependencies,
  evaluateLibraryAdvice,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LibraryAdvice;
} else {
  window.LibraryAdvice = LibraryAdvice;
}
