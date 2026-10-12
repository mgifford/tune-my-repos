#!/usr/bin/env node
/**
 * Brings repositories owned by one GitHub account up to a baseline of
 * GitHub-native security settings, so security updates need less hands-on
 * maintenance. Deterministic: no AI, no inference.
 *
 * Per repository it reads the current state, then (only with --apply) enables
 * whatever is missing:
 *   - Dependabot alerts
 *   - Dependabot security updates
 *   - Secret scanning + push protection   (public repos; private needs GHAS)
 *   - Private vulnerability reporting     (public repos only)
 * It also detects package ecosystems from root manifests and writes a
 * proposed .github/dependabot.yml to --out-dir for REVIEW. It never commits
 * files to repositories or opens PRs.
 *
 * Safe by default: DRY RUN unless --apply is passed. Idempotent: settings that
 * are already enabled are never rewritten. Never disables anything.
 *
 * Usage: node scripts/enable-security-defaults.cjs --owner <user> [options]
 *   --apply            perform writes (default: dry run, read-only)
 *   --repos a,b,c      only these repository names (default: all owned, non-fork, non-archived)
 *   --include-forks    also process forks
 *   --out-dir <dir>    where proposed dependabot.yml files go (default: ./dependabot-proposals)
 * Env:   GITHUB_TOKEN - fine-grained PAT, repository access limited to the
 *        repos to change, with: Administration (read+write), Contents (read),
 *        Metadata (read). Never printed or written to disk by this script.
 */

const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.github.com';

const MANIFESTS = [
  ['package.json', 'npm'],
  ['composer.json', 'composer'],
  ['requirements.txt', 'pip'],
  ['pyproject.toml', 'pip'],
  ['Pipfile', 'pip'],
  ['Gemfile', 'bundler'],
  ['go.mod', 'gomod'],
  ['Cargo.toml', 'cargo'],
  ['pom.xml', 'maven'],
  ['build.gradle', 'gradle'],
  ['Dockerfile', 'docker'],
];

function detectEcosystems(rootFiles, hasWorkflows) {
  const names = new Set(rootFiles);
  const found = new Set();
  for (const [file, eco] of MANIFESTS) if (names.has(file)) found.add(eco);
  if (hasWorkflows) found.add('github-actions');
  return [...found].sort();
}

// Ecosystems with no lockfile-free runtime deps are not special-cased: the
// reviewer decides. Grouping keeps it to one PR per ecosystem per week, and
// cooldown delays brand-new releases to reduce exposure to hijacked versions.
function buildDependabotYml(ecosystems) {
  const lines = ['version: 2', 'updates:'];
  for (const eco of ecosystems) {
    lines.push(
      `  - package-ecosystem: "${eco}"`,
      '    directory: "/"',
      '    schedule:',
      '      interval: "weekly"',
      '    cooldown:',
      '      default-days: 3',
      '    groups:',
      `      ${eco}-minor-patch:`,
      '        update-types:',
      '          - "minor"',
      '          - "patch"',
    );
  }
  return lines.join('\n') + '\n';
}

function parseArgs(argv) {
  const opts = { apply: false, includeForks: false, repos: null, owner: null, outDir: 'dependabot-proposals' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--include-forks') opts.includeForks = true;
    else if (a === '--owner') opts.owner = argv[++i];
    else if (a === '--repos') opts.repos = new Set((argv[++i] || '').split(',').filter(Boolean));
    else if (a === '--out-dir') opts.outDir = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.owner || !/^[A-Za-z0-9-]+$/.test(opts.owner)) throw new Error('--owner <github-user> is required');
  return opts;
}

function makeClient(token, fetchImpl = fetch) {
  return async function api(method, route, body) {
    const res = await fetchImpl(`${API}${route}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new Error('GitHub rate limit reached; stopping. Re-run later (the script is idempotent).');
    }
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };
}

async function listRepos(api, owner, opts) {
  const out = [];
  for (let page = 1; ; page++) {
    const { status, data } = await api('GET', `/user/repos?affiliation=owner&per_page=100&page=${page}`);
    if (status !== 200) throw new Error(`Listing repositories failed (HTTP ${status})`);
    out.push(...data);
    if (data.length < 100) break;
  }
  return out.filter((r) =>
    r.owner.login.toLowerCase() === owner.toLowerCase() &&
    !r.archived && !r.disabled &&
    (opts.includeForks || !r.fork) &&
    (!opts.repos || opts.repos.has(r.name)));
}

async function readState(api, repo) {
  const base = `/repos/${repo.full_name}`;
  const sa = repo.security_and_analysis || {};
  const alerts = await api('GET', `${base}/vulnerability-alerts`);
  const fixes = await api('GET', `${base}/automated-security-fixes`);
  const pvr = await api('GET', `${base}/private-vulnerability-reporting`);
  return {
    alerts: alerts.status === 204,
    securityUpdates: fixes.status === 200 && fixes.data && fixes.data.enabled === true,
    secretScanning: (sa.secret_scanning || {}).status === 'enabled',
    pushProtection: (sa.secret_scanning_push_protection || {}).status === 'enabled',
    privateReporting: pvr.status === 200 && pvr.data && pvr.data.enabled === true,
  };
}

function plannedActions(repo, state) {
  const isPublic = !repo.private;
  const actions = [];
  if (!state.alerts) actions.push({ name: 'Dependabot alerts', method: 'PUT', route: `/repos/${repo.full_name}/vulnerability-alerts` });
  if (!state.securityUpdates) actions.push({ name: 'Dependabot security updates', method: 'PUT', route: `/repos/${repo.full_name}/automated-security-fixes` });
  if (isPublic && (!state.secretScanning || !state.pushProtection)) {
    actions.push({
      name: 'Secret scanning + push protection', method: 'PATCH', route: `/repos/${repo.full_name}`,
      body: { security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } },
    });
  }
  if (isPublic && !state.privateReporting) actions.push({ name: 'Private vulnerability reporting', method: 'PUT', route: `/repos/${repo.full_name}/private-vulnerability-reporting` });
  return actions;
}

async function proposeConfig(api, repo, outDir) {
  const root = await api('GET', `/repos/${repo.full_name}/contents/`);
  const files = root.status === 200 && Array.isArray(root.data) ? root.data.map((f) => f.name) : [];
  const wf = await api('GET', `/repos/${repo.full_name}/contents/.github/workflows`);
  const hasDependabotYml = (await api('GET', `/repos/${repo.full_name}/contents/.github/dependabot.yml`)).status === 200;
  const ecosystems = detectEcosystems(files, wf.status === 200);
  if (hasDependabotYml || ecosystems.length === 0) return { hasDependabotYml, ecosystems, written: null };
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, `${repo.name}.dependabot.yml`);
  fs.writeFileSync(target, buildDependabotYml(ecosystems));
  return { hasDependabotYml, ecosystems, written: target };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Set GITHUB_TOKEN (fine-grained PAT). It is read from the environment only.');
  const api = makeClient(token);
  const repos = await listRepos(api, opts.owner, opts);
  console.log(`${opts.apply ? 'APPLY' : 'DRY RUN'}: ${repos.length} repositories for ${opts.owner}`);
  let changes = 0;
  for (const repo of repos) {
    const state = await readState(api, repo);
    const actions = plannedActions(repo, state);
    const cfg = await proposeConfig(api, repo, opts.outDir);
    console.log(`\n${repo.full_name} (${repo.private ? 'private' : 'public'})`);
    console.log(`  ecosystems: ${cfg.ecosystems.join(', ') || 'none detected'}; dependabot.yml: ${cfg.hasDependabotYml ? 'present' : 'missing'}${cfg.written ? ` -> proposal ${cfg.written}` : ''}`);
    if (!actions.length) console.log('  settings: already at baseline');
    for (const a of actions) {
      if (!opts.apply) { console.log(`  would enable: ${a.name}`); continue; }
      const res = await api(a.method, a.route, a.body);
      const ok = res.status >= 200 && res.status < 300;
      if (ok) changes++;
      console.log(`  ${ok ? 'enabled' : `FAILED (HTTP ${res.status})`}: ${a.name}`);
    }
  }
  console.log(`\nDone. ${opts.apply ? `${changes} settings enabled.` : 'No changes made. Re-run with --apply to write.'}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
}

module.exports = { detectEcosystems, buildDependabotYml, parseArgs, plannedActions };
