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

4. **Optional - Configure authentication** (for higher rate limits and private repos):
   
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

- **index.html** - Main web interface
- **analyzer.js** - Core analysis logic (repository classification, governance checks)
- **app.js** - UI interactions and result rendering
- **styles.css** - Responsive design with dark mode support
- **AGENTS.md** - Complete governance rules and standards

All analysis runs client-side using the GitHub REST API. No backend required.

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

## License

AGPL

## Security

TODO: Add SECURITY.md

---

**Note**: This tool provides recommendations and evidence signals. It does not claim compliance or make legal determinations. Consult appropriate experts for legal, security, and accessibility decisions.
