# Copilot Instructions for tune-my-repos

## Primary instruction source

**Always read [`/AGENTS.md`](../AGENTS.md) first.**

`AGENTS.md` is the authoritative governance document for this repository. It defines the agent's role (Compliance Lead / OSPO Head), non-negotiable principles, output requirements, and the full evaluation rubric. All coding and review work must conform to the rules stated there. If any instruction in this file conflicts with `AGENTS.md`, follow the stricter rule.

---

## Repository overview

**Type:** Web application (client-side only, no build step)  
**Deployment:** GitHub Pages  
**Stack:** Vanilla JavaScript (ES modules), HTML5, CSS3 — no framework, no bundler, no package manager

This tool analyzes GitHub repositories against open source best-practice standards and produces prioritized, actionable recommendations.

---

## Key files and their roles

| File | Purpose |
|---|---|
| `index.html` | Entry point — loads all JS modules via `<script type="module">` |
| `analyzer.js` | Core logic: repo classification, governance checks, fork analysis |
| `app.js` | UI rendering, event handling, caching orchestration, debug mode |
| `styles.css` | Responsive layout with dark-mode support |
| `auth.js` | GitHub OAuth and Personal Access Token handling |
| `cache.js` | localStorage-backed 1-hour result cache |
| `env-loader.js` | Loads `.env` on localhost/`file://` only; no-op in production |
| `config.js` | GitHub token and OAuth config (not committed; see `config.example.js`) |
| `priorities.json` / `priorities.yaml` | Configurable finding sort order (see `PRIORITIES_CONFIG.md`) |
| `AGENTS.md` | **Full governance ruleset — read before every task** |

---

## Working conventions

### No build step
There is no `npm install`, `npm run build`, or compilation step. Edit source files directly. Validate changes by opening `index.html` in a browser or running `python -m http.server 8000`.

### JavaScript style
- Vanilla ES2020+ (no TypeScript, no transpilation).
- Modules loaded via native `<script type="module">`.
- Debug logging uses `debugLog()` / `errorLog()` helpers defined at the top of `app.js`. Do **not** use bare `console.log` for new code.
- Debug mode is toggled with `Ctrl+Shift+D`; state persists in `localStorage`. See `DEBUGGING.md`.

### Error handling
- `showError()` in `app.js` creates DOM elements directly — do **not** set `innerHTML` with user-supplied strings.
- The global `unhandledrejection` handler in `app.js` suppresses browser-extension noise while surfacing real app errors.

### Caching
- Analysis results are cached for 1 hour in `localStorage` using the key format `tune-my-repos-cache-{target}-skipForks:{boolean}`.
- `cache.js` stores `analysisStats` alongside results; legacy entries without stats assume zero failures.
- Force-refresh is available via the "Force refresh" checkbox.

### GitHub API
- Unauthenticated: 60 req/hr. Authenticated: 5 000 req/hr.
- Organizations use `/orgs/:org/repos`, not `/users/:username/repos`.
- Organization-level governance files (from the owner's `.github` repo) are checked and cached in `orgGithubCache` inside `analyzer.js`.

### Findings display
- Top 3 findings are shown prominently; the rest are in a `<details>` collapsible element.
- Display order is controlled by `priorities.json`.

### Accessibility
- The UI targets **WCAG 2.2 AA**. Maintain keyboard operability, visible focus indicators, semantic HTML, and proper ARIA labels.
- An automated accessibility scan runs via `.github/workflows/accessibility.yml` against the live GitHub Pages URL.

---

## Related documentation in this repository

| Document | Topic |
|---|---|
| `README.md` | User-facing setup and usage guide |
| `DEBUGGING.md` | Debug mode, console logging, troubleshooting |
| `PRIORITIES_CONFIG.md` | Customizing finding sort order via `priorities.json` |
| `SETUP.md` | Local development setup |
| `QUICK_START.md` | Fast onboarding for new contributors |
| `GITHUB_PAGES_SETUP.md` | OAuth proxy configuration for GitHub Pages deployment |
| `DEPLOYMENT_CHECKLIST.md` | Pre-deployment checklist |

---

## Related external standards referenced by AGENTS.md

- **agents.md standard** — <https://agents.md/>
- **ACCESSIBILITY.md template** — <https://github.com/mgifford/ACCESSIBILITY.md>  
  Open standard for project accessibility transparency.
- **SUSTAINABILITY.md template** — <https://github.com/mgifford/SUSTAINABILITY.md>  
  Template for documenting digital sustainability practices.

> **Note:** `ACCESSIBILITY.md` and `SUSTAINABILITY.md` do not currently exist as files in this repository. The links above point to the upstream templates that define their format. Adding these files to the repo root is a recommended future improvement (see `AGENTS.md` → *Default recommendation order*, items 3 and 10). Do **not** create them automatically — they require human review and decision.

---

## Change guidelines (summary from AGENTS.md)

1. **Do not invent facts** — only state what can be verified from repo contents or GitHub API data.
2. **Do not change runtime behavior** without explicit human instruction.
3. **Prefer small, reviewable changes** over large rewrites.
4. **Do not add dependencies** without justification and a rollback path.
5. **Do not automate** LICENSE changes, dependency upgrades, security policy edits, or code refactors.
6. **Batch limits**: max 5 files and 200 lines per automated change batch.
7. Bug fixes require a failing test added before the fix wherever feasible.
