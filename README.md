# tune-my-repos

AI-powered repository analysis and improvement tool based on open source and inner source best practices.

## Purpose

This tool evaluates repositories against established compliance, security, accessibility, and governance standards defined in [AGENTS.md](AGENTS.md). It acts as a **Compliance Lead and Head of the Open Source Program Office (OSPO)**, providing actionable recommendations to improve repository quality and sustainability.

## Features

- **Repository classification** - Automatically identifies repo type (library, webapp, CLI, docs, etc.)
- **Fork analysis** - Detects upstream divergence and sync recommendations
- **Governance evaluation** - Checks LICENSE, CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md
- **Dependency security** - Scans for outdated packages and vulnerabilities
- **Accessibility compliance** - Validates WCAG 2.2 AA requirements
- **Test coverage** - Ensures unit tests and CI/CD pipelines exist
- **OpenChain evidence** - Reports signals for ISO/IEC 5230 compliance programs
- **CHAOSS metrics** - Measures community health indicators
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

3. **Optional - Configure GitHub token** (for higher rate limits and private repos):
   ```bash
   # Copy the example config
   cp config.example.js config.js
   
   # Edit config.js and add your GitHub Personal Access Token
   # Get a token from: https://github.com/settings/tokens
   ```
   
   **Without a token:**
   - Rate limit: 60 requests/hour
   - Public repositories only
   
   **With a token:**
   - Rate limit: 5,000 requests/hour
   - Access to private repositories

4. **Export results:**
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

## License

TODO: Add license information

## Contributing

TODO: Add CONTRIBUTING.md

## Security

TODO: Add SECURITY.md

---

**Note**: This tool provides recommendations and evidence signals. It does not claim compliance or make legal determinations. Consult appropriate experts for legal, security, and accessibility decisions.
