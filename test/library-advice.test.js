const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KNOWN_REPLACEMENTS,
  MAX_ADVICE_PER_REPO,
  listDirectDependencies,
  evaluateLibraryAdvice,
} = require('../policy/library-advice.cjs');

const NOW = new Date('2026-10-13T00:00:00Z');
const prod = (name) => ({ name, type: 'production' });
const dev = (name) => ({ name, type: 'development' });

test('listDirectDependencies: reads dependencies and devDependencies with their type', () => {
  assert.deepEqual(
    listDirectDependencies({ dependencies: { a: '1' }, devDependencies: { b: '2' } }),
    [prod('a'), dev('b')],
  );
});

test('listDirectDependencies: missing or malformed manifest yields nothing', () => {
  assert.deepEqual(listDirectDependencies(null), []);
  assert.deepEqual(listDirectDependencies({ dependencies: 'nope' }), []);
});

test('evaluateLibraryAdvice: curated rule applies without registry data', () => {
  const [advice] = evaluateLibraryAdvice([prod('request')], new Map(), NOW);
  assert.equal(advice.kind, 'deprecated');
  assert.match(advice.suggestion, /fetch/);
});

test('evaluateLibraryAdvice: registry deprecation message is reported verbatim', () => {
  const facts = new Map([['old-lib', { deprecated: 'Use new-lib instead' }]]);
  const [advice] = evaluateLibraryAdvice([prod('old-lib')], facts, NOW);
  assert.equal(advice.kind, 'deprecated');
  assert.equal(advice.suggestion, 'npm says: Use new-lib instead');
});

test('evaluateLibraryAdvice: no release in over two years is unmaintained', () => {
  const facts = new Map([['stale', { lastPublished: '2023-01-01T00:00:00Z' }]]);
  const [advice] = evaluateLibraryAdvice([dev('stale')], facts, NOW);
  assert.equal(advice.kind, 'unmaintained');
  assert.match(advice.suggestion, /over 3 years/);
});

test('evaluateLibraryAdvice: recently published, unknown or unreachable packages get no advice', () => {
  const facts = new Map([['fresh', { lastPublished: '2026-09-01T00:00:00Z' }], ['offline', null]]);
  assert.deepEqual(evaluateLibraryAdvice([prod('fresh'), prod('offline'), prod('never-looked-up')], facts, NOW), []);
});

test('evaluateLibraryAdvice: riskiest kind first, then production before development', () => {
  const facts = new Map([['stale', { lastPublished: '2020-01-01T00:00:00Z' }]]);
  const advice = evaluateLibraryAdvice([dev('left-pad'), dev('stale'), prod('left-pad-2'), dev('colors'), prod('object-assign')], facts, NOW);
  assert.deepEqual(advice.map((a) => a.package), ['colors', 'stale', 'object-assign', 'left-pad']);
});

test('evaluateLibraryAdvice: capped per repository', () => {
  const names = Object.keys(KNOWN_REPLACEMENTS);
  const many = Array.from({ length: 30 }, (_, i) => prod(names[i % names.length]));
  assert.equal(evaluateLibraryAdvice(many, new Map(), NOW).length, MAX_ADVICE_PER_REPO);
});

test('KNOWN_REPLACEMENTS: every rule has a valid kind and a suggestion', () => {
  for (const [name, rule] of Object.entries(KNOWN_REPLACEMENTS)) {
    assert.ok(['compromised', 'deprecated', 'native', 'lighter'].includes(rule.kind), name);
    assert.ok(rule.suggestion.length > 10 && rule.suggestion.length <= 300, name);
  }
});
