/**
 * Fail-closed sanitization for published resource aggregates.
 *
 * The maintenance dashboard's security model is unchanged: exact Dependabot
 * alert counts and private maintenance data are never published. Resource
 * evidence adds another rule set: no repository names, usernames, absolute
 * paths, commands, prompts, transcripts, session ids, credentials, or raw
 * provider responses may appear in a public rollup.
 *
 * `answerPublicProblems()` is a scanner, not a redactor. The only supported
 * way to publish is to build the object through an allowlist projection (see
 * scripts/lib/resource/event.cjs and rollup.cjs), then run this scanner and
 * refuse to write the file if it finds anything.
 */

const FORBIDDEN_KEYS = new Set([
  'private',
  'source_key',
  'supersedes',
  'cwd',
  'path',
  'command',
  'command_hash',
  'command_label',
  'prompt',
  'prompts',
  'response',
  'raw',
  'raw_usage',
  'transcript',
  'transcripts',
  'session_id',
  'session_ids',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'token_value',
  'username',
  'user',
  'email',
  'account',
  'full_name',
  'repository_name',
  'project_name',
  'verification_reference',
  'evidence_path',
  'description',
  'notes',
]);

const PRIVATE_PATH = /(\/Users\/|\/home\/|\.lab-cache|\.resource-cache|~\/\.claude|\.claude\/projects|[A-Za-z]:\\|\\\\\?\\|file:\/\/)/;
const SECRET_TEXT = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-|sk-[A-Za-z0-9]{20,}|xox[baprs]-|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|AKIA[0-9A-Z]{16})/;
const PRIVATE_REPO = /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\b/;
const SLASH_ALLOWED_KEYS = new Set(['model', 'requested_model', 'resolved_model', 'model_alias']);

function looksLikePrivateRepo(value) {
  // Public aggregates use hashed references (`project_ref`), never owner/repo.
  // A slash in an allowed label such as "Wh/token" or "gCO2e/kWh" is not a repo.
  if (typeof value !== 'string') return false;
  if (/^(Wh|kWh|MWh|J|kJ|gCO2e|kgCO2e|USD|CPU-seconds|bytes|ms|s)\//.test(value)) return false;
  return PRIVATE_REPO.test(value);
}

function publicProblems(value, at = '', key = '') {
  const problems = [];
  if (value == null) return problems;
  if (typeof value === 'string') {
    if (PRIVATE_PATH.test(value)) problems.push(`${at || '/'}: private path`);
    if (SECRET_TEXT.test(value)) problems.push(`${at || '/'}: secret-shaped string`);
    if (!SLASH_ALLOWED_KEYS.has(key) && looksLikePrivateRepo(value)) problems.push(`${at || '/'}: repository-shaped string`);
    return problems;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => problems.push(...publicProblems(item, `${at}/${index}`, key)));
    return problems;
  }
  if (typeof value !== 'object') return problems;
  for (const [childKey, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(childKey.toLowerCase())) problems.push(`${at || '/'}/${childKey}: forbidden public field`);
    problems.push(...publicProblems(child, `${at || ''}/${childKey}`, childKey));
  }
  return problems;
}

function assertPublicResource(value, label = 'public resource evidence') {
  const problems = publicProblems(value);
  if (problems.length) {
    throw new Error(`${label} is not publishable:\n  ${[...new Set(problems)].slice(0, 30).join('\n  ')}`);
  }
  return value;
}

module.exports = { FORBIDDEN_KEYS, publicProblems, assertPublicResource };
