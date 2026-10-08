# tune-my-repos

AI-powered repository analysis and improvement tool based on open source and inner source best practices.

## Purpose

This tool evaluates repositories against established compliance, security, accessibility, and governance standards defined in [AGENTS.md](AGENTS.md). It acts as a **Compliance Lead and Head of the Open Source Program Office (OSPO)**, providing actionable recommendations to improve repository quality and sustainability.

## Features

- **Repository classification** - Automatically identifies repo type (library, webapp, CLI, docs, etc.)
- **Fork analysis** - Detects upstream divergence and sync recommendations
- **Governance evaluation** - Checks LICENSE, CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md
- **Organization-level governance** - Detects inherited files from organization `.github` repositories (e.g., `https://github.com/chaoss/.github`)
- **About box metadata** - Validates repository description, website, and topics for better discoverability
- **Dependency security** - Scans for outdated packages and vulnerabilities
- **Accessibility compliance** - Validates WCAG 2.2 AA requirements
- **Test coverage** - Ensures unit tests and CI/CD pipelines exist
- **OpenChain evidence** - Reports signals for ISO/IEC 5230 compliance programs
- **CHAOSS metrics** - Measures community health indicators
- **Smart caching** - Results cached for 1 hour to reduce API calls and improve performance
- **Collapsible findings** - Top 3 findings shown prominently, with all others accessible via expandable section
- **Configurable priorities** - Customize which findings appear first using `priorities.json` (see [PRIORITIES_CONFIG.md](PRIORITIES_CONFIG.md))
- **Export options** - Download results as JSON or Markdown
- **Debug mode** - Enhanced error logging and debugging (press `Ctrl+Shift+D` to toggle)

## Usage

### Web Interface (GitHub Pages)

1. **Open in browser:**
   ```bash
   python -m http.server 8000
   # Visit http://localhost:8000
   ```

2. **Analyze repositories:**
   - **User/Org:** Enter `mgifford` or `civicactions` to scan all repos
   - **Single repo:** Enter `mgifford/tune-my-repos` to analyze one repo
   - **Skip forks:** Check to exclude forked repositories (recommended)
   - **Force refresh:** Check to bypass the 1-hour cache and fetch fresh data

3. **Caching behavior:**
   - Analysis results are automatically cached for **1 hour** to reduce API calls
   - A green indicator shows when cached results are being displayed
   - Use "Force refresh" checkbox to bypass cache and fetch fresh data
   - Cache is stored in browser localStorage and cleared automatically after expiration
   - Different cache entries for different skipForks settings

4. **Debugging and Troubleshooting:**
   - Press `Ctrl+Shift+D` to toggle debug mode
   - When enabled, detailed logs appear in the browser console (F12)
   - See [DEBUGGING.md](DEBUGGING.md) for complete debugging guide
   - Error messages now include helpful tips and context

5. **Optional - Configure authentication** (for higher rate limits and private repos):
   
   **For local development:**
   
   Use a Personal Access Token with .env file or config.js:
   ```bash
   # Copy the example file
   cp .env.example .env
   
   # Edit .env and add your GitHub Personal Access Token
   # Get a token from: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
   ```
   
   **For GitHub Pages deployment:**
   
   Use GitHub OAuth for users to sign in with their own accounts:
   - See [GITHUB_PAGES_SETUP.md](GITHUB_PAGES_SETUP.md) for complete OAuth configuration guide
   - Allows users to authenticate with their GitHub account
   - Each user gets their own 5,000 requests/hour rate limit
   
   **Rate limits:**
   - Without authentication: 60 requests/hour (unauthenticated)
   - With authentication: 5,000 requests/hour
   - With authentication: Access to private repositories (if granted)
   - **Caching reduces API usage:** Repeated scans within 1 hour use cached data

5. **Export results:**
   - **JSON** - Complete analysis data for further processing
   - **Markdown** - Human-readable report
   - **CSV** - Spreadsheet with repo name, classification, maturity, issue counts

### GitHub Actions (Automated Analysis)

See [.github/workflows/analyze.yml](.github/workflows/analyze.yml) for automated repository scanning.

## Standards and Compliance

All evaluations follow the rules defined in [AGENTS.md](AGENTS.md), which include:

- Open source and inner source best practices
- Security and legal risk reduction
- Accessibility standards (WCAG 2.2 AA)
- OpenChain ISO/IEC 5230 evidence signals
- CHAOSS community health metrics

## Output Formats

- **Console** - Human-readable summary with prioritized recommendations
- **JSON** - Machine-readable for CI/CD integration
- **Markdown** - GitHub Issues or discussion format
- **YAML** - Configuration-friendly output

## Architecture

- **index.html** - Main web interface (repository analysis)
- **analyzer.js** - Core analysis logic (repository classification, governance checks)
- **app.js** - UI interactions and result rendering
- **maintenance.html** - Maintenance control plane dashboard (security visibility, Dependabot status)
- **maintenance.js** - Maintenance dashboard rendering and rollup loading
- **styles.css** / **maintenance.css** - Responsive design with dark mode support
- **AGENTS.md** - Complete governance rules and standards

All analysis runs client-side using the GitHub REST API. No backend required.

## Maintenance Control Plane

`maintenance.html` is a separate, deterministic dashboard for ongoing repository maintenance: security
alert visibility, open Dependabot update PRs, and which updates are eligible for a low-risk merge path.
It is **not** an autonomous coding system and does not merge anything itself — normal repository CI
remains the merge gate for every change.

### What this proves, and what it doesn't

- It reports **evidence and policy-derived classifications**, not compliance or security guarantees.
- A repository with zero alerts shown may simply have `not_available` or `unknown` coverage for that
  signal (shown explicitly in the "Unavailable or unknown data" section) — absence of a finding is not
  the same as absence of risk.
- "Eligible for low-risk merge" means the policy in `maintenance-policy.yml` classifies the update as
  low-risk *once required CI passes* — it is a routing decision, not a merge action.
- No AI or LLM is involved in collecting evidence, classifying updates, or rendering this dashboard.

### Policy and data model

- **`maintenance-policy.yml`** (documented) / **`maintenance-policy.json`** (loaded) - versioned,
  conservative policy: which repositories are in scope, their tier, and how dependency updates are
  classified into risk states (`eligible`, `needs_review`, `needs_repair`, `blocked`, `ignored`). No
  implicit allow-all: an update that cannot be classified is always `needs_review`.
- **`policy/policy-engine.cjs`** - deterministic classifier (`classifyUpdate`) that applies the policy to
  one dependency update. Pure function, no network access, fully unit tested.
- **`policy/policy-validator.cjs`** - dependency-free JSON Schema validator used for both the policy file
  and the rollup data file.
- **`policy/policy.schema.json`** / **`policy/rollup.schema.json`** - the two schemas.
- **`fixtures/maintenance-rollup.sample.json`** - static sample rollup so the dashboard can be reviewed
  without any GitHub credentials.
- **`scripts/generate-maintenance-rollup.cjs`** - calls the GitHub REST API read-only for every repository
  in policy scope (every API call it makes to a *scanned* repository is a read), classifies each open
  Dependabot PR through `policy/policy-engine.cjs`, redacts anything token-shaped, caps text fields, and
  writes a schema-conformant `maintenance-rollup.json`. Runs with reduced coverage (reported as
  `unknown`, never guessed) when no token is available.
- **Repository discovery and scan scope** (`maintenance-policy.yml`'s `discovery` section) - when
  `repositories.include` contains an `"owner/*"` glob, candidate repositories are discovered via the
  GitHub API across `discovery.owners` (default: `mgifford`, `CivicActions`) rather than listed by hand.
  `discovery.exclude_forks` / `exclude_archived` (both default `true`) drop noise before anything is
  scanned; `repositories.include`/`exclude` patterns are still applied afterward as the final filter, so
  widening `discovery.owners` alone does not widen what is actually scanned. **As of this writing,
  `repositories.include` is still the single exact entry `mgifford/tune-my-repos`** — discovery across
  the full `mgifford`/`CivicActions` owner set is built and tested but not yet turned on; widening
  `repositories.include` to `"mgifford/*"` / `"CivicActions/*"` is a deliberate follow-up decision, not
  a side effect of this change.
- **`maintenance-scan-state.json`** (committed) / **`policy/scan-state.cjs`** - tracks when each
  repository was last scanned. A repository whose `pushed_at` is unchanged since its last scan skips the
  expensive PR/CI-status work (`discovery.rescan_prs_after_days`, default 7, forces a rescan regardless)
  — but Dependabot alerts are always re-checked every run, since a new alert can appear against an
  unchanged dependency with no new push. `discovery.max_repos_per_run` (default 50) caps how many
  repositories one run processes. Ordering (`orderByActivityThenStaleness`) prioritizes coverage first
  (never-scanned repositories always come before already-scanned ones) and, within each of those two
  groups, more recently pushed-to repositories before long-dormant ones — so actively maintained work
  surfaces issues first, while coverage of everything still builds up over several scheduled runs rather
  than one very long/expensive run. Forks and archived repositories are excluded entirely before this
  ordering ever runs (`discovery.exclude_forks` / `exclude_archived`, both default `true`) — this
  project's own work takes priority over code merely hosted in the same account.
- **`.github/workflows/maintenance-inventory.yml`** - runs the script on a weekly schedule or on demand.
  Defaults to dry-run on manual dispatch (prints the rollup, writes nothing); scheduled runs publish the
  rollup as a 90-day workflow artifact. It never writes to, labels, comments on, or merges anything in
  any repository it *scans*. It does commit one file in *this* repository —
  `maintenance-scan-state.json` — and does so through a small pull request that must pass the same
  required `npm test` check as any other change to `main`, rather than bypassing branch protection.
  Works with or without the optional `MAINTENANCE_RO_TOKEN` repository secret (a fine-grained PAT scoped
  to read-only Metadata, Dependabot alerts, and Pull requests); without it, Dependabot alert and
  branch-protection coverage report as `unknown` rather than failing the run.

### Security alert visibility on the public dashboard

The live `maintenance-rollup.json` is currently **only** a private workflow artifact (90-day retention,
visible to repository collaborators via the Actions tab) — it is not published to the public
`maintenance.html` page today. GitHub Pages for a public repo cannot require authentication, so this was
designed with that constraint in mind from the start:

- Dependabot *security alerts* are private on GitHub even for public repositories — only people with
  repository access can see exact counts natively. `maintenance.html`, `scripts/generate-maintenance-rollup.cjs`'s
  public-safe fields, and every export path (JSON, Markdown) therefore only ever expose a derived
  `has_urgent_alerts` boolean (`policy/public-redaction.cjs`), never the exact `critical`/`high`/`moderate`/`low`
  counts, and link out to `github.com/{repo}/security/dependabot` — GitHub's own page, with GitHub's own
  access control — for anyone who needs the real numbers. The rollup JSON produced by the scheduled
  workflow still *contains* exact counts (useful for the private 90-day artifact and any future
  authenticated consumer); only the rendering and export paths strip them.
- Dependabot *update PRs* (dependency names, versions) are already fully public on this repository's own
  Pull Requests tab, so there is nothing to protect by hiding that detail in the rollup — it is shown as-is.
- A client-side "sign in and check org membership" gate was considered and rejected: GitHub Pages has no
  backend, so such a gate only changes what renders in a browser that runs the page's JavaScript honestly —
  it does not stop anyone from fetching the underlying files directly. Given the reduction above already
  removes the only genuinely private signal, no gate is needed.

### Tests

Run `npm test` (uses Node's built-in test runner, no dependencies) to run the policy engine, schema
validator, rollup generator, and fixture-conformance test suites in `test/`.

### Phase 3 pilot: Dependabot auto-merge (tune-my-repos only)

`tune-my-repos` is currently the **only** repository running the Dependabot pilot
(`.github/workflows/dependabot-pilot.yml` + `.github/dependabot.yml`, scoped to the `github-actions`
ecosystem only — this repo has no other dependencies today). The pilot:

- Labels every Dependabot PR with its computed dependency class, update type, and risk state
  (`maintenance:github-actions`, `maintenance:patch`, `maintenance:eligible`, etc.)
- Requires branch protection on `main` with `npm test` as a required status check (configured via a
  repository ruleset; this was a prerequisite, not something this workflow sets up itself)
- Only *requests* GitHub's native auto-merge (`gh pr merge --auto`) for PRs the policy classifies as
  `eligible` — it never bypasses or overrides the required check; GitHub itself still waits for `npm test`
  to pass before merging anything
- Is **off by default**: auto-merge only activates when the repository variable
  `MAINTENANCE_AUTOMERGE_ENABLED` is set to `true` in Settings → Secrets and variables → Actions → Variables.
  Labeling runs regardless, so you can review classifications before opting in to auto-merge.
- Never auto-merges: major updates, anything outside policy scope, anything the title parser can't
  classify, or anything a human hasn't enabled auto-merge for at the repository level.

#### Rollout checklist for additional pilot repositories

Before copying this pilot to another repository:

1. [ ] Add the repository to `maintenance-policy.yml`'s `repositories.include` and to the `pilot` tier
   (or `standard`, once past the pilot stage), and regenerate `maintenance-policy.json` to match.
2. [ ] Confirm the repository's actual dependency ecosystems (npm, pip, etc.) and write a
   `.github/dependabot.yml` scoped to what's really there — do not copy this repo's github-actions-only
   config blindly.
3. [ ] Set up branch protection / a ruleset on the repository's default branch requiring at least one
   real CI check to pass (the repository's own test suite, not `tune-my-repos`' `npm test`).
4. [ ] Copy `.github/workflows/dependabot-pilot.yml`, `.github/scripts/classify-dependabot-pr.js`,
   `.github/scripts/ensure-maintenance-labels.sh`, and `.github/scripts/maintenance-label-names.js` as-is
   — no path edits needed. The workflow fetches a fresh, read-only copy of the policy engine (`policy/`,
   `scripts/`, `maintenance-policy.json`) from `mgifford/tune-my-repos` on every run (see
   `POLICY_ROOT` in `classify-dependabot-pr.js`), so these four files are the only things that live in
   the pilot repository itself; a future policy or bug fix in `tune-my-repos` takes effect on the next PR
   event with no manual re-sync.
5. [ ] Leave `MAINTENANCE_AUTOMERGE_ENABLED` unset (auto-merge off) for at least one full review cycle of
   labeled-but-not-merged PRs before enabling it.
6. [ ] Confirm with the repository's actual maintainer(s) — not just `mgifford` — before enabling
   auto-merge on a repository with other contributors.

### Tracked follow-up: package-swap suggestions (not built yet)

Idea, not yet designed or built: suggest (never automatically apply) swapping a poorly-supported
dependency for a better-supported alternative in the same role — e.g. a package with no release in
years and a pile of open security advisories, versus a well-maintained equivalent. This is explicitly
a **suggestion surfaced to a human**, never an automated action; nothing in this policy model may ever
choose a replacement dependency on its own. Needs real design before building: what signals indicate
"better supported" (release recency, maintainer count, open advisory count — some combination, pulled
from where), where the suggestion surfaces (a new rollup field? a separate report?), and how false
positives are avoided (a less-active package is not automatically worse — some are simply stable).

## GitHub Actions Integration

Use the provided workflow to analyze repositories automatically:

```yaml
# .github/workflows/analyze.yml
# Trigger manually or on schedule
```

## Standards and Compliance

All evaluations follow the rules defined in [AGENTS.md](AGENTS.md), including:

- Open source and inner source best practices
- Security and legal risk reduction
- Accessibility standards (WCAG 2.2 AA)
- OpenChain ISO/IEC 5230 evidence signals
- CHAOSS community health metrics

## Frequently Asked Questions

### Do I need to set up GitHub OAuth?

**Short answer: No, for most users!**

GitHub OAuth is only needed if you're deploying to GitHub Pages and want multiple users to authenticate with their own accounts. For local/personal use, a Personal Access Token is simpler and sufficient.

**When to use Personal Access Token (recommended for most users):**
- Running locally for personal use
- Single-user scenarios
- Testing and development
- Gives you 5,000 API requests/hour

**When to use GitHub OAuth (advanced):**
- Deploying to GitHub Pages
- Multiple users need to authenticate
- Each user needs their own rate limit
- Requires setting up an OAuth proxy (see [GITHUB_PAGES_SETUP.md](GITHUB_PAGES_SETUP.md))

### How do I add my GitHub token?

1. **Create a Personal Access Token:**
   - Go to https://github.com/settings/tokens
   - Click "Generate new token (classic)"
   - Select scope: `public_repo` (or `repo` for private repositories)
   - Copy the token (starts with `ghp_`)

2. **Add the token to config.js:**
   ```javascript
   const CONFIG = { 
       GITHUB_TOKEN: 'ghp_your_token_here',
       // OAuth settings can be left empty for local use
   };
   ```

3. **Verify it works:**
   - Open the app in your browser
   - The app will use your token automatically
   - You'll get 5,000 requests/hour instead of 60

### How do I check if authentication is working?

- **Without any token:** You'll see "60 requests/hour" rate limit
- **With token or OAuth:** You'll see "5,000 requests/hour" rate limit
- Check the browser console for messages like "✓ Loaded GitHub token"
- If OAuth is configured, you'll see your username in the top-right corner

### How does organization-level governance file detection work?

Organizations can maintain governance files (like CODE_OF_CONDUCT.md, CONTRIBUTING.md, SECURITY.md) in a special `.github` repository that are automatically inherited by all repositories in the organization.

**Examples:**
- https://github.com/chaoss/.github - CHAOSS organization-level files
- https://github.com/civicactions/.github - CivicActions organization-level files

**How tune-my-repos handles this:**
1. When analyzing a repository, the tool checks if the owner has a `.github` repository
2. For missing governance files, it checks if they exist in the organization's `.github` repository
3. If found at the organization level, the file is marked as "inherited" rather than "missing"
4. Results include a note in the limitations section indicating which files are inherited

**Benefits:**
- Avoids false positives for missing governance files
- Recognizes organization-wide policies
- Reduces maintenance burden (files managed in one place)
- Follows GitHub's community health file inheritance feature

This feature respects GitHub's built-in community health file inheritance, ensuring accurate analysis for organizations with centralized governance.

## Related Resources

This tool recommends governance files based on open standards:

- **[ACCESSIBILITY.md template](https://github.com/mgifford/ACCESSIBILITY.md)** - Open standard for project accessibility transparency and WCAG conformance tracking
- **[SUSTAINABILITY.md template](https://github.com/mgifford/SUSTAINABILITY.md)** - Project instructions for reducing digital emissions and environmental impact
- **[agents.md](https://agents.md/)** - The agents.md standard for AI agent instructions

## AI Disclosure

This project was built with AI assistance. The following AI tools have been used:

### GitHub Copilot (code generation and maintenance)

**Used to build this project.** GitHub Copilot and the GitHub Copilot Agent have been used to:
- Generate and refactor JavaScript source code (`analyzer.js`, `app.js`, `auth.js`, `cache.js`, `env-loader.js`)
- Draft and update documentation (`README.md`, `AGENTS.md`, and other Markdown files)
- Implement feature branches and bug fixes (evidenced by branches prefixed `copilot/` and the `IMPLEMENTATION_SUMMARY.md` file)

The `.github/copilot-instructions.md` file configures Copilot's behavior for this repository.

### Runtime AI use

**No AI is used at runtime.** When the application runs in a browser, it calls the GitHub REST API directly using vanilla JavaScript. No LLM or AI inference service is invoked during normal operation.

### Browser-based AI

**No browser-based AI is used.** The application does not use browser built-in AI APIs (e.g., the Chrome `window.ai` API), WebLLM, ONNX Runtime Web, or any other client-side model inference. All logic is pure JavaScript with no on-device model inference.

---

## License

AGPL

## Security

TODO: Add SECURITY.md

---

**Note**: This tool provides recommendations and evidence signals. It does not claim compliance or make legal determinations. Consult appropriate experts for legal, security, and accessibility decisions.
