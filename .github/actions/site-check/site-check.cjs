'use strict';
// Site check: serve a static site the way GitHub Pages does, open its pages in
// Chrome, and report JavaScript errors, files that fail to load, broken
// internal links and serious axe issues. Problems the live site already has
// are listed but do not fail the check, so existing issues do not block every
// update. See action.yml for inputs.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const BLOCKING = ['js-error', 'console-error', 'missing-file', 'broken-link', 'axe'];
const LABELS = {
  'js-error': 'JavaScript error',
  'console-error': 'Console error',
  'missing-file': 'File failed to load',
  'broken-link': 'Broken internal link',
  axe: 'Accessibility (axe)',
  'third-party': 'Third-party request failed',
};
const MAX_LINKS = 100;
const LOCAL_HOST = 'site-check.test';
const TYPES = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain', '.xml': 'application/xml', '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json',
};

const slashes = (p) => `/${p}/`.replace(/\/{2,}/g, '/');

function deriveSite({ repository, cname, basePath, liveUrl }) {
  const [owner, name] = repository.split('/');
  const domain = (cname || '').split('\n')[0].trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  let site;
  if (domain) site = { basePath: '/', liveUrl: `https://${domain}/` };
  else if (name.toLowerCase() === `${owner.toLowerCase()}.github.io`) site = { basePath: '/', liveUrl: `https://${name.toLowerCase()}/` };
  else site = { basePath: `/${name}/`, liveUrl: `https://${owner.toLowerCase()}.github.io/${name}/` };
  if (basePath) site.basePath = slashes(basePath);
  if (liveUrl === 'none') site.liveUrl = null;
  else if (liveUrl) site.liveUrl = liveUrl.replace(/\/*$/, '/');
  return site;
}

function resolveStaticPath(siteDir, basePath, urlPath) {
  let pathname;
  try { pathname = decodeURIComponent(urlPath); } catch { return null; }
  if (!pathname.startsWith(basePath)) return null;
  const root = path.resolve(siteDir);
  const full = path.resolve(root, `./${pathname.slice(basePath.length)}`);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  const isFile = (f) => fs.existsSync(f) && fs.statSync(f).isFile();
  for (const candidate of [full, path.join(full, 'index.html'), `${full}.html`]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function startStaticServer(siteDir, basePath) {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://local');
    if (`${pathname}/` === basePath) {
      res.writeHead(301, { location: basePath });
      return res.end();
    }
    const file = resolveStaticPath(siteDir, basePath, pathname);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Not found</title>');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}

function toSitePath(url, siteUrl) {
  if (!url.startsWith(siteUrl)) return null;
  return `/${url.slice(siteUrl.length)}`.replace(/[?#].*$/, '');
}

function pickPages(links, siteUrl, max) {
  const pages = ['/'];
  for (const link of links) {
    const p = toSitePath(link, siteUrl);
    if (p === null || pages.includes(p) || !/(\/|\.html?|\/[^./]+)$/.test(p)) continue;
    pages.push(p);
  }
  return pages.slice(0, max);
}

function compareProblems(prProblems, liveProblems) {
  const key = (p) => `${p.kind}|${p.page}|${p.detail}`;
  const live = new Map();
  for (const p of liveProblems || []) {
    if (!live.has(key(p)) || (p.count || 0) > (live.get(key(p)).count || 0)) live.set(key(p), p);
  }
  const result = { newProblems: [], existingProblems: [], nonBlocking: [] };
  for (const p of prProblems) {
    if (!BLOCKING.includes(p.kind)) result.nonBlocking.push(p);
    else if (!liveProblems) result.newProblems.push(p);
    else if (p.kind === 'axe') {
      const liveCount = live.has(key(p)) ? live.get(key(p)).count : 0;
      (p.count > liveCount ? result.newProblems : result.existingProblems).push({ ...p, liveCount });
    } else (live.has(key(p)) ? result.existingProblems : result.newProblems).push(p);
  }
  return result;
}

function describe(p) {
  const detail = String(p.detail).replace(/`/g, "'").replace(/\s+/g, ' ').slice(0, 300);
  const count = p.kind === 'axe' ? `, ${p.count} element(s)${p.liveCount !== undefined ? `, live site: ${p.liveCount}` : ''}` : '';
  return `${LABELS[p.kind]} on \`${p.page}\`: ${detail}${count}`;
}

function renderSummary({ result, pages, liveUrl, comparisonNote }) {
  const n = result.newProblems.length;
  const lines = ['## Site check', ''];
  lines.push(n ? `**Result: failed.** ${n} new problem(s).` : '**Result: passed.** No new problems.');
  lines.push('', `Checked ${pages.length} page(s): ${pages.map((p) => `\`${p}\``).join(', ')}.`);
  lines.push(liveUrl
    ? `Compared with the live site: ${liveUrl}`
    : `No live comparison${comparisonNote ? ` (${comparisonNote})` : ''}, so every problem counts as new.`);
  const section = (title, list) => {
    if (list.length) lines.push('', `### ${title}`, '', ...list.map((p) => `- ${describe(p)}`));
  };
  section('New problems', result.newProblems);
  section('Already on the live site (not blocking)', result.existingProblems);
  section('Third-party requests that failed (not blocking)', result.nonBlocking);
  return `${lines.join('\n')}\n`;
}

async function inspectSite(context, siteUrl, pages, axeSource, axeImpacts) {
  const problems = [];
  const seen = new Set();
  const add = (kind, page, detail, extra) => {
    const k = `${kind}|${page}|${detail}`;
    if (!seen.has(k)) { seen.add(k); problems.push({ kind, page, detail, ...extra }); }
  };
  const clean = (text) => String(text).split(siteUrl).join('/');
  const checkedLinks = new Set();
  for (const pagePath of pages) {
    const page = await context.newPage();
    let linkPhase = false;
    const failed = (url, why) => {
      if (linkPhase) return;
      const sp = toSitePath(url, siteUrl);
      if (sp !== null) add('missing-file', pagePath, `${sp} (${why})`);
      else if (/^https?:/.test(url)) add('third-party', pagePath, `${url.replace(/[?#].*$/, '')} (${why})`);
    };
    page.on('pageerror', (e) => add('js-error', pagePath, clean(e.message)));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) add('console-error', pagePath, clean(m.text()));
    });
    page.on('response', (r) => { if (r.status() >= 400) failed(r.url(), r.status()); });
    page.on('requestfailed', (r) => {
      const why = r.failure() ? r.failure().errorText : 'failed';
      if (why !== 'net::ERR_ABORTED') failed(r.url(), why);
    });
    try {
      await page.goto(siteUrl + pagePath.slice(1), { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(500);
      // Fetch links from inside the page, so they resolve the same way the page did.
      const links = [];
      for (const href of await page.$$eval('a[href]', (as) => as.map((a) => a.href.replace(/#.*$/, '')))) {
        const sp = toSitePath(href, siteUrl);
        if (sp === null || checkedLinks.has(sp) || checkedLinks.size >= MAX_LINKS) continue;
        checkedLinks.add(sp);
        links.push([href, sp]);
      }
      linkPhase = true;
      const statuses = await page.evaluate((urls) => Promise.all(urls.map((u) => fetch(u).then((r) => r.status, () => 'no response'))),
        links.map(([href]) => href));
      linkPhase = false;
      statuses.forEach((s, i) => { if (s === 'no response' || s >= 400) add('broken-link', pagePath, `${links[i][1]} (${s})`); });
      await page.addScriptTag({ content: axeSource });
      const violations = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations
        .map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length })));
      for (const v of violations) if (axeImpacts.includes(v.impact)) add('axe', pagePath, v.id, { count: v.count });
    } catch (e) {
      add('missing-file', pagePath, `${pagePath} did not load (${e.message.split('\n')[0]})`);
    }
    await page.close();
  }
  return problems;
}

async function runCheck(opts) {
  const siteDir = opts.siteDir || '.';
  const cnameFile = path.join(siteDir, 'CNAME');
  const site = deriveSite({
    repository: opts.repository,
    cname: fs.existsSync(cnameFile) ? fs.readFileSync(cnameFile, 'utf8') : '',
    basePath: opts.basePath,
    liveUrl: opts.liveUrl,
  });
  const axeImpacts = opts.axeImpacts || ['serious', 'critical'];
  const axeSource = fs.readFileSync(path.join(path.dirname(require.resolve('axe-core')), 'axe.min.js'), 'utf8');
  const { chromium } = require('playwright-core');
  const server = await startStaticServer(siteDir, site.basePath);
  // Serve the copy under a name that is not localhost, and treat it as secure like the
  // live HTTPS site, so code that switches on localhost or on secure contexts behaves as it does live.
  const port = new URL(server.origin).port;
  const localUrl = `http://${LOCAL_HOST}:${port}${site.basePath}`;
  const browser = await chromium.launch({
    ...(opts.chromePath ? { executablePath: opts.chromePath } : { channel: 'chrome' }),
    args: [`--host-resolver-rules=MAP ${LOCAL_HOST} 127.0.0.1`, `--unsafely-treat-insecure-origin-as-secure=http://${LOCAL_HOST}:${port}`],
  });
  try {
    const context = await browser.newContext({ bypassCSP: true, serviceWorkers: 'block' });
    let pages = opts.pages && opts.pages.length ? opts.pages : null;
    if (!pages) {
      const home = await context.newPage();
      const hrefs = await home.goto(localUrl, { timeout: 30000 }).then(() => home.$$eval('a[href]', (as) => as.map((a) => a.href)), () => []);
      await home.close();
      pages = pickPages(hrefs, localUrl, opts.maxPages || 10);
    }
    const prProblems = await inspectSite(context, localUrl, pages, axeSource, axeImpacts);
    let liveProblems = null;
    let comparisonNote = '';
    let liveUrl = site.liveUrl;
    if (liveUrl) {
      const status = await context.request.get(liveUrl, { timeout: 15000 }).then((r) => r.status(), (e) => e.message.split('\n')[0]);
      if (status === 200) liveProblems = await inspectSite(context, liveUrl, pages, axeSource, axeImpacts);
      else { comparisonNote = `${liveUrl} returned ${status}`; liveUrl = null; }
    } else comparisonNote = 'turned off';
    let result = compareProblems(prProblems, liveProblems);
    if (liveProblems && result.newProblems.length) {
      // Check the live pages once more so a passing glitch there does not count as new.
      const again = [...new Set(result.newProblems.map((p) => p.page))];
      liveProblems.push(...await inspectSite(context, liveUrl, again, axeSource, axeImpacts));
      result = compareProblems(prProblems, liveProblems);
    }
    return { result, pages, liveUrl, comparisonNote };
  } finally {
    await browser.close();
    server.close();
  }
}

async function main(env) {
  const list = (v) => (v || '').split(/[\s,]+/).filter(Boolean);
  const report = await runCheck({
    siteDir: env.SITE_DIR,
    repository: env.GITHUB_REPOSITORY,
    pages: list(env.PAGES).map((p) => (p.startsWith('/') ? p : `/${p}`)),
    maxPages: Number(env.MAX_PAGES) || 10,
    basePath: env.BASE_PATH,
    liveUrl: env.LIVE_URL,
    axeImpacts: list(env.AXE_IMPACTS || 'serious,critical'),
    chromePath: env.CHROME_PATH,
  });
  const md = renderSummary(report);
  process.stdout.write(md);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md);
  for (const p of report.result.newProblems.slice(0, 10)) {
    console.log(`::error title=Site check::${describe(p).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  }
  return report.result.newProblems.length ? 1 : 0;
}

if (require.main === module) {
  main(process.env).then((code) => { process.exitCode = code; }, (e) => {
    console.log(`::error title=Site check::The check could not run: ${e.message.split('\n')[0]}`);
    process.exitCode = 1;
  });
}

module.exports = { deriveSite, resolveStaticPath, startStaticServer, pickPages, compareProblems, renderSummary, runCheck };
