/**
 * GitHubAnalyzer - Repository analysis based on AGENTS.md
 */

class GitHubAnalyzer {
    constructor(token = null) {
        this.token = token;
        this.apiBase = 'https://api.github.com';
    }

    async fetchJSON(url) {
        const headers = {
            'Accept': 'application/vnd.github.v3+json'
        };
        if (this.token) {
            headers['Authorization'] = `token ${this.token}`;
        }

        const response = await fetch(url, { headers });
        
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.message || `GitHub API error: ${response.status}`);
        }
        
        return response.json();
    }

    async analyzeRepository(owner, repo, progressCallback = null) {
        const result = {
            repository: `${owner}/${repo}`,
            analyzed_at: new Date().toISOString(),
            classification: 'unknown',
            is_fork: false,
            fork_upstream: null,
            fork_status: null,
            maturity_level: 'low',
            findings: [],
            metrics: {},
            limitations: []
        };

        try {
            // Fetch repository metadata
            if (progressCallback) progressCallback('Fetching repository metadata...');
            const repoData = await this.fetchJSON(`${this.apiBase}/repos/${owner}/${repo}`);
            
            if (progressCallback) progressCallback('Analyzing fork status...');
            result.is_fork = repoData.fork;
            if (repoData.parent) {
                result.fork_upstream = repoData.parent.full_name;
                result.fork_status = 'unknown';
                result.limitations.push('Fork ahead/behind status requires additional API calls');
            }

            // Fetch file tree
            if (progressCallback) progressCallback('Fetching repository file tree...');
            const tree = await this.fetchJSON(`${this.apiBase}/repos/${owner}/${repo}/git/trees/${repoData.default_branch}?recursive=1`);
            const files = new Set(tree.tree.map(item => item.path));
            if (progressCallback) progressCallback(`Found ${files.size} files in repository`);

            // Classify repository
            if (progressCallback) progressCallback('Classifying repository type...');
            result.classification = this.classifyRepository(files, repoData);
            if (progressCallback) progressCallback(`Classified as: ${result.classification}`);

            // Run analysis checks
            if (progressCallback) progressCallback('Checking governance files (LICENSE, CONTRIBUTING, etc.)...');
            this.checkGovernanceFiles(files, result);
            
            if (progressCallback) progressCallback('Checking README quality...');
            this.checkReadme(files, result);
            
            if (progressCallback) progressCallback('Checking CI/CD workflows...');
            this.checkCIWorkflows(files, result);
            
            if (progressCallback) progressCallback('Checking community health files...');
            this.checkCommunityFiles(files, result);
            
            if (progressCallback) progressCallback('Checking dependencies...');
            this.checkDependencies(files, result);

            // Calculate maturity
            if (progressCallback) progressCallback('Calculating maturity score...');
            result.maturity_level = this.calculateMaturity(result);
            
            if (progressCallback) progressCallback('Analysis complete!');

        } catch (error) {
            throw new Error(`Analysis failed: ${error.message}`);
        }

        return result;
    }

    classifyRepository(files, repoData) {
        // Check for web application indicators
        if (files.has('package.json') || files.has('index.html')) {
            const hasWebFiles = Array.from(files).some(f => 
                f.startsWith('public/') || f.startsWith('static/') || f.startsWith('templates/')
            );
            if (hasWebFiles) return 'webapp';
        }

        // Check for CLI tool indicators
        if (Array.from(files).some(f => f.startsWith('cmd/') || f.startsWith('cli/'))) {
            return 'cli';
        }
        if (files.has('setup.py') || files.has('pyproject.toml')) {
            if (Array.from(files).some(f => f.includes('__main__.py'))) {
                return 'cli';
            }
        }

        // Check for library indicators
        if (files.has('setup.py') || files.has('pyproject.toml') || 
            files.has('package.json') || files.has('Cargo.toml')) {
            return 'library';
        }

        // Check for documentation-only
        const mdFiles = Array.from(files).filter(f => f.endsWith('.md'));
        if (mdFiles.length >= files.size * 0.7) {
            return 'docs';
        }

        // Check for config/policy repository
        if (files.has('AGENTS.md') || Array.from(files).some(f => f.startsWith('.github/workflows'))) {
            const codeFiles = Array.from(files).filter(f => 
                f.endsWith('.py') || f.endsWith('.js') || f.endsWith('.go') || f.endsWith('.rs')
            );
            if (codeFiles.length < 5) {
                return 'config';
            }
        }

        return 'mixed';
    }

    checkGovernanceFiles(files, result) {
        const governanceFiles = {
            'LICENSE': { severity: 'critical', purpose: 'usage rights and legal terms' },
            'CONTRIBUTING.md': { severity: 'important', purpose: 'contribution process' },
            'CODE_OF_CONDUCT.md': { severity: 'recommended', purpose: 'community standards' },
            'SECURITY.md': { severity: 'important', purpose: 'vulnerability reporting' },
            'CHANGELOG.md': { severity: 'recommended', purpose: 'change tracking' }
        };

        for (const [filename, config] of Object.entries(governanceFiles)) {
            const variations = [
                filename,
                filename.toLowerCase(),
                `.github/${filename}`,
                `.github/${filename.toLowerCase()}`
            ];
            const found = variations.some(v => files.has(v));

            if (!found) {
                result.findings.push({
                    category: 'governance',
                    severity: config.severity,
                    title: `Missing ${filename}`,
                    description: this.getGovernanceRisk(filename),
                    recommendation: `Add ${filename} to clarify ${config.purpose}`,
                    automated: ['SECURITY.md', 'CONTRIBUTING.md'].includes(filename),
                    time_estimate: filename === 'LICENSE' ? '1–3 hours' : '15–45 minutes',
                    requires_write_access: true
                });
            }
        }
    }

    checkReadme(files, result) {
        const hasReadme = Array.from(files).some(f => 
            f.toLowerCase() === 'readme.md' || f.toLowerCase() === 'readme'
        );

        if (!hasReadme) {
            result.findings.push({
                category: 'documentation',
                severity: 'critical',
                title: 'Missing README.md',
                description: 'README is essential for communicating purpose, scope, and usage',
                recommendation: 'Create README.md with purpose, audience, scope, and basic usage',
                automated: true,
                time_estimate: '1–3 hours',
                requires_write_access: true
            });
        }
    }

    checkCIWorkflows(files, result) {
        const hasWorkflows = Array.from(files).some(f => f.startsWith('.github/workflows/'));

        if (!hasWorkflows) {
            result.findings.push({
                category: 'testing',
                severity: 'important',
                title: 'No CI/CD workflows detected',
                description: 'Automated testing and quality checks reduce bugs and improve confidence',
                recommendation: 'Add GitHub Actions workflow for tests, linting, and security scanning',
                automated: false,
                time_estimate: '1–3 hours',
                requires_write_access: true
            });
        }
    }

    checkCommunityFiles(files, result) {
        const hasIssueTemplates = Array.from(files).some(f => 
            f.startsWith('.github/ISSUE_TEMPLATE/')
        );
        const hasPRTemplate = files.has('.github/PULL_REQUEST_TEMPLATE.md') || 
                              files.has('.github/pull_request_template.md');

        if (!hasIssueTemplates) {
            result.findings.push({
                category: 'documentation',
                severity: 'recommended',
                title: 'Missing issue templates',
                description: 'Issue templates guide contributors and improve issue quality',
                recommendation: 'Add issue templates for bug reports and feature requests',
                automated: true,
                time_estimate: '15–45 minutes',
                requires_write_access: true
            });
        }

        if (!hasPRTemplate) {
            result.findings.push({
                category: 'documentation',
                severity: 'optional',
                title: 'Missing pull request template',
                description: 'PR templates ensure consistent, complete pull requests',
                recommendation: 'Add .github/PULL_REQUEST_TEMPLATE.md with checklist',
                automated: true,
                time_estimate: '15–45 minutes',
                requires_write_access: true
            });
        }
    }

    checkDependencies(files, result) {
        const dependencyFiles = {
            'package.json': 'npm',
            'requirements.txt': 'pip',
            'pyproject.toml': 'python',
            'Gemfile': 'bundler',
            'go.mod': 'go',
            'Cargo.toml': 'cargo'
        };

        const foundDeps = Object.entries(dependencyFiles)
            .filter(([f, _]) => files.has(f))
            .map(([_, lang]) => lang);

        if (foundDeps.length > 0) {
            result.limitations.push(
                `Dependency vulnerability scanning for ${foundDeps.join(', ')} requires package analysis`
            );
        }
    }

    calculateMaturity(result) {
        const critical = result.findings.filter(f => f.severity === 'critical').length;
        const important = result.findings.filter(f => f.severity === 'important').length;

        if (critical > 0) return 'low';
        if (important > 2) return 'medium';
        return 'high';
    }

    getGovernanceRisk(filename) {
        const risks = {
            'LICENSE': 'Legal uncertainty, unclear usage rights, potential compliance violations',
            'CONTRIBUTING.md': 'Contributors lack guidance, inconsistent contributions, review friction',
            'CODE_OF_CONDUCT.md': 'No community standards, potential for unaddressed harassment',
            'SECURITY.md': 'Security researchers lack reporting channel, delayed vulnerability disclosure',
            'CHANGELOG.md': 'Users cannot track changes, difficult to assess upgrade impact'
        };
        return risks[filename] || 'Governance gap';
    }
}
