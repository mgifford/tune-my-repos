const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const actionDir = path.join(__dirname, '..', '.github', 'actions', 'site-check');
const {
  deriveSite,
  resolveStaticPath,
  pickPages,
  compareProblems,
  renderSummary,
  runCheck,
  startStaticServer,
} = require(path.join(actionDir, 'site-check.cjs'));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-check-'));
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
function writeSite(name, files) {
  const dir = path.join(tempDir, name);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

// --- Where the site lives ---

test('deriveSite: a project site is served under /<repo>/ on github.io', () => {
  assert.deepEqual(deriveSite({ repository: 'mgifford/a11y-svg' }), {
    basePath: '/a11y-svg/',
    liveUrl: 'https://mgifford.github.io/a11y-svg/',
  });
});

test('deriveSite: the user site and a CNAME file are served at the root', () => {
  assert.deepEqual(deriveSite({ repository: 'mgifford/mgifford.github.io' }), {
    basePath: '/',
    liveUrl: 'https://mgifford.github.io/',
  });
  assert.deepEqual(deriveSite({ repository: 'mgifford/ox.ca', cname: 'ox.ca\n' }), {
    basePath: '/',
    liveUrl: 'https://ox.ca/',
  });
});

test('deriveSite: inputs override the derived values, and "none" turns off the comparison', () => {
  assert.deepEqual(deriveSite({ repository: 'mgifford/x', basePath: 'docs', liveUrl: 'none' }), {
    basePath: '/docs/',
    liveUrl: null,
  });
  assert.equal(deriveSite({ repository: 'mgifford/x', liveUrl: 'https://example.test/x' }).liveUrl, 'https://example.test/x/');
});

// --- The local copy is served the way GitHub Pages serves it ---

test('resolveStaticPath: index files, extensionless pages, and nothing outside the site', () => {
  const dir = writeSite('static', { 'index.html': 'home', 'about.html': 'about', 'docs/index.html': 'docs' });
  const outside = writeSite('static-secret', { 'secret.txt': 'no' });
  assert.equal(resolveStaticPath(dir, '/x/', '/x/'), path.join(dir, 'index.html'));
  assert.equal(resolveStaticPath(dir, '/x/', '/x/about'), path.join(dir, 'about.html'));
  assert.equal(resolveStaticPath(dir, '/x/', '/x/docs/'), path.join(dir, 'docs', 'index.html'));
  assert.equal(resolveStaticPath(dir, '/x/', '/x/missing.html'), null);
  assert.equal(resolveStaticPath(dir, '/x/', '/other/index.html'), null);
  assert.equal(resolveStaticPath(dir, '/x/', `/x/../${path.basename(outside)}/secret.txt`), null);
  assert.equal(resolveStaticPath(dir, '/x/', '/x/%2e%2e/static-secret/secret.txt'), null);
});

// --- Which pages to check ---

test('pickPages: the home page plus same-site pages, without fragments, files or duplicates', () => {
  const site = 'http://127.0.0.1:9/x/';
  const links = [
    'http://127.0.0.1:9/x/about.html#team',
    'http://127.0.0.1:9/x/about.html',
    'http://127.0.0.1:9/x/docs/',
    'http://127.0.0.1:9/x/report.pdf',
    'http://127.0.0.1:9/other/',
    'https://example.com/',
    'mailto:someone@example.com',
  ];
  assert.deepEqual(pickPages(links, site, 10), ['/', '/about.html', '/docs/']);
  assert.deepEqual(pickPages(links, site, 2), ['/', '/about.html']);
});

// --- Only problems the live site does not already have block the PR ---

test('compareProblems: new problems block, existing ones and third-party failures do not', () => {
  const pr = [
    { kind: 'js-error', page: '/', detail: 'x is not defined' },
    { kind: 'missing-file', page: '/', detail: '/app.js (404)' },
    { kind: 'axe', page: '/', detail: 'image-alt', count: 3 },
    { kind: 'axe', page: '/', detail: 'color-contrast', count: 2 },
    { kind: 'third-party', page: '/', detail: 'cdn.example.com (net::ERR_FAILED)' },
  ];
  const live = [
    { kind: 'missing-file', page: '/', detail: '/app.js (404)' },
    { kind: 'axe', page: '/', detail: 'image-alt', count: 1 },
    { kind: 'axe', page: '/', detail: 'color-contrast', count: 2 },
  ];
  const result = compareProblems(pr, live);
  assert.deepEqual(result.newProblems.map((p) => `${p.kind}:${p.detail}`), ['js-error:x is not defined', 'axe:image-alt']);
  assert.equal(result.newProblems[1].liveCount, 1);
  assert.deepEqual(result.existingProblems.map((p) => p.kind), ['missing-file', 'axe']);
  assert.deepEqual(result.nonBlocking.map((p) => p.kind), ['third-party']);
});

test('compareProblems: without a live comparison, every blocking problem is new', () => {
  const pr = [
    { kind: 'broken-link', page: '/', detail: '/gone.html (404)' },
    { kind: 'third-party', page: '/', detail: 'cdn.example.com (500)' },
  ];
  const result = compareProblems(pr, null);
  assert.deepEqual(result.newProblems.map((p) => p.kind), ['broken-link']);
  assert.deepEqual(result.nonBlocking.map((p) => p.kind), ['third-party']);
});

test('renderSummary: states the result in words and says when there was no comparison', () => {
  const result = compareProblems([{ kind: 'js-error', page: '/', detail: 'boom `x`' }], null);
  const md = renderSummary({ result, pages: ['/'], liveUrl: null, comparisonNote: 'live site returned 503' });
  assert.match(md, /^## Site check/m);
  assert.match(md, /\*\*Result: failed\.\*\*/);
  assert.match(md, /live site returned 503/);
  assert.match(md, /### New problems/);
  assert.match(md, /JavaScript error on `\/`/);
  assert.doesNotMatch(md, /`x`/, 'backticks in details are escaped so they cannot break the markdown');
  const passed = renderSummary({ result: compareProblems([], []), pages: ['/'], liveUrl: 'https://e.test/' });
  assert.match(passed, /\*\*Result: passed\.\*\*/);
});

// --- End to end in a real browser (skipped when Chrome or the action's packages are missing) ---

function browserAvailable() {
  try {
    require.resolve('playwright-core', { paths: [actionDir] });
    require.resolve('axe-core', { paths: [actionDir] });
  } catch {
    return 'run npm ci in .github/actions/site-check to enable';
  }
  const chrome = process.env.CHROME_PATH
    || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/google/chrome/chrome');
  return fs.existsSync(chrome) ? false : 'Google Chrome not found';
}

test('runCheck: finds only what the PR breaks, compared with a live copy', { skip: browserAvailable() }, async () => {
  const shared = {
    'about.html': '<!doctype html><html lang="en"><title>About</title><main><h1>About</h1></main></html>',
  };
  // The live copy already has an image without alt text.
  const liveDir = writeSite('live', {
    ...shared,
    'index.html': '<!doctype html><html lang="en"><title>Home</title><main><h1>Home</h1><img src="logo.svg"><a href="about.html">About</a></main></html>',
    'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  });
  // The PR adds a script error, a missing script file and a broken link.
  const prDir = writeSite('pr', {
    ...shared,
    'index.html': '<!doctype html><html lang="en"><title>Home</title><main><h1>Home</h1><img src="logo.svg"><a href="about.html">About</a> <a href="gone.html">Gone</a></main>'
      + '<script src="missing.js"></script><script>notDefinedAnywhere();</script></html>',
    'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  });
  const live = await startStaticServer(liveDir, '/x/');
  let result;
  try {
    ({ result } = await runCheck({ siteDir: prDir, repository: 'mgifford/x', liveUrl: `${live.origin}/x/` }));
  } finally {
    live.close();
  }
  const found = result.newProblems.map((p) => p.kind).sort();
  assert.deepEqual(found, ['broken-link', 'js-error', 'missing-file']);
  assert.ok(result.existingProblems.some((p) => p.kind === 'axe' && p.detail === 'image-alt'));
});
