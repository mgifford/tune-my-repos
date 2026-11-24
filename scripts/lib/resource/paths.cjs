/**
 * Filesystem layout for local resource accounting.
 *
 * Everything here is local-only unless a caller explicitly asks for a public
 * projection. The raw ledger is never committed. Tests set
 * RESOURCE_CACHE_DIR to a temporary directory.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function cacheRoot() {
  return path.resolve(process.env.RESOURCE_CACHE_DIR || path.join(REPO_ROOT, '.resource-cache'));
}

function rawRoot() {
  return path.join(cacheRoot(), 'raw');
}

function ledgerRoot() {
  return path.join(cacheRoot(), 'ledger');
}

function factorRoot() {
  return path.join(cacheRoot(), 'factors');
}

function lockRoot() {
  return path.join(cacheRoot(), 'locks');
}

function reportsRoot() {
  return path.resolve(process.env.RESOURCE_REPORTS_DIR || path.join(REPO_ROOT, 'reports', 'resources'));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function relativeToRepo(file) {
  const rel = path.relative(REPO_ROOT, path.resolve(file));
  return rel.startsWith('..') ? null : rel.split(path.sep).join('/');
}

module.exports = {
  REPO_ROOT,
  cacheRoot,
  rawRoot,
  ledgerRoot,
  factorRoot,
  lockRoot,
  reportsRoot,
  ensureDir,
  relativeToRepo,
};
