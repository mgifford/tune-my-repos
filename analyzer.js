/**
 * GitHubAnalyzer - Repository analysis based on AGENTS.md
 */

class GitHubAnalyzer {
    constructor(token = null) {
        this.token = token;
        this.apiBase = 'https://api.github.com';
        // Cache for organization .github repository checks
        this.orgGithubCache = new Map();
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

    /**
     * Check if a file exists in the organization's .github repository
     * @param {string} owner - The organization name
     * @param {string} filename - The filename to check (e.g., 'CODE_OF_CONDUCT.md')
     * @returns {Promise<boolean>} - True if the file exists in org .github repo
     */
    async checkOrgGithubFile(owner, filename) {
        // Check cache first
        const cacheKey = `${owner}:${filename}`;
        if (this.orgGithubCache.has(cacheKey)) {
            return this.orgGithubCache.get(cacheKey);
        }

        try {
            // Try to fetch the file from organization's .github repository
            // This will check if https://github.com/[owner]/.github/blob/main/[filename] exists
            await this.fetchJSON(`${this.apiBase}/repos/${owner}/.github/contents/${filename}`);
            
            // File exists
            this.orgGithubCache.set(cacheKey, true);
            return true;
        } catch (error) {
            // File doesn't exist or .github repo doesn't exist
            this.orgGithubCache.set(cacheKey, false);
            return false;
        }
    }

    /**
     * Check if owner is an organization and has a .github repository
     * @param {string} owner - The owner name
     * @returns {Promise<boolean>} - True if owner is an org with .github repo
     */
    async hasOrgGithubRepo(owner) {
        const cacheKey = `${owner}:_has_github_repo`;
        if (this.orgGithubCache.has(cacheKey)) {
            return this.orgGithubCache.get(cacheKey);
        }

        try {
            // Check if the .github repository exists
            await this.fetchJSON(`${this.apiBase}/repos/${owner}/.github`);
            this.orgGithubCache.set(cacheKey, true);
            return true;
        } catch (error) {
            // Either not an org, or no .github repo
            this.orgGithubCache.set(cacheKey, false);
            return false;
        }
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

            // Check if owner has an organization .github repository
            if (progressCallback) progressCallback('Checking for organization-level governance files...');
            const hasOrgGithub = await this.hasOrgGithubRepo(owner);

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
            await this.checkGovernanceFiles(files, result, owner, hasOrgGithub);
            
            if (progressCallback) progressCallback('Checking README quality...');
            this.checkReadme(files, result);
            
            if (progressCallback) progressCallback('Checking About box metadata...');
            this.checkAboutMetadata(repoData, result);
            
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
        const documentationFiles = Array.from(files).filter(f => f.endsWith('.md') || f.endsWith('.rst'));
        if (documentationFiles.length >= files.size * 0.7) {
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

    async checkGovernanceFiles(files, result, owner, hasOrgGithub) {
        const governanceFiles = {
            'LICENSE': { severity: 'critical', purpose: 'usage rights and legal terms' },
            'CONTRIBUTING.md': { severity: 'important', purpose: 'contribution process' },
            'CODE_OF_CONDUCT.md': { severity: 'recommended', purpose: 'community standards' },
            'SECURITY.md': { severity: 'important', purpose: 'vulnerability reporting' },
            'CHANGELOG.md': { severity: 'recommended', purpose: 'change tracking' },
            'ACCESSIBILITY.md': { severity: 'recommended', purpose: 'accessibility commitment and transparency' },
            'SUSTAINABILITY.md': { severity: 'optional', purpose: 'digital sustainability and environmental impact' }
        };

        for (const [filename, config] of Object.entries(governanceFiles)) {
            // Extract base filename (remove .md extension if present)
            const baseName = filename.replace(/\.md$/, '');
            const variations = [
                filename,
                filename.toLowerCase(),
                `.github/${filename}`,
                `.github/${filename.toLowerCase()}`
            ];
            
            // Generate .rst variations if the original filename has .md extension
            if (filename.endsWith('.md')) {
                const rstFilename = baseName + '.rst';
                variations.push(
                    rstFilename,
                    rstFilename.toLowerCase(),
                    `.github/${rstFilename}`,
                    `.github/${rstFilename.toLowerCase()}`
                );
            }
            
            const foundInRepo = variations.some(v => files.has(v));

            // Check if file exists in organization .github repository
            let foundInOrgGithub = false;
            if (!foundInRepo && hasOrgGithub) {
                foundInOrgGithub = await this.checkOrgGithubFile(owner, filename);
            }

            if (!foundInRepo && !foundInOrgGithub) {
                let recommendation = `Add ${filename} (or .rst equivalent) to clarify ${config.purpose}`;
                
                // Add template links for specific files
                if (filename === 'ACCESSIBILITY.md') {
                    recommendation += '. Template: https://github.com/mgifford/ACCESSIBILITY.md';
                } else if (filename === 'SUSTAINABILITY.md') {
                    recommendation += '. Template: https://github.com/mgifford/SUSTAINABILITY.md';
                }
                
                result.findings.push({
                    category: 'governance',
                    severity: config.severity,
                    title: `Missing ${filename}`,
                    description: this.getGovernanceRisk(filename),
                    recommendation: recommendation,
                    automated: ['SECURITY.md', 'CONTRIBUTING.md'].includes(filename),
                    time_estimate: filename === 'LICENSE' ? '1–3 hours' : '15–45 minutes',
                    requires_write_access: true
                });
            } else if (foundInOrgGithub) {
                // File is inherited from organization .github repository
                // Add this as informational note, not a finding
                result.limitations.push(
                    `${filename} inherited from organization-level https://github.com/${owner}/.github`
                );
            }
        }
    }

    checkReadme(files, result) {
        const hasReadme = Array.from(files).some(f => 
            f.toLowerCase() === 'readme.md' || 
            f.toLowerCase() === 'readme.rst' || 
            f.toLowerCase() === 'readme'
        );

        if (!hasReadme) {
            result.findings.push({
                category: 'documentation',
                severity: 'critical',
                title: 'Missing README',
                description: 'README is essential for communicating purpose, scope, and usage',
                recommendation: 'Create README.md or README.rst with purpose, audience, scope, and basic usage',
                automated: true,
                time_estimate: '1–3 hours',
                requires_write_access: true
            });
        }
    }

    checkAboutMetadata(repoData, result) {
        // Check for description
        const hasDescription = repoData.description && repoData.description.trim().length > 0;
        
        // Check for homepage/website
        const hasHomepage = repoData.homepage && repoData.homepage.trim().length > 0;
        
        // Check for topics (tags)
        const hasTopics = repoData.topics && repoData.topics.length > 0;
        
        // Missing description
        if (!hasDescription) {
            result.findings.push({
                category: 'documentation',
                severity: 'important',
                title: 'Missing repository description',
                description: 'Repository description helps users understand the project at a glance and improves discoverability',
                recommendation: 'Add a clear, concise description in the About section (Settings → Description)',
                automated: false,
                time_estimate: '15–45 minutes',
                requires_write_access: true
            });
        }
        
        // Missing website
        if (!hasHomepage) {
            result.findings.push({
                category: 'documentation',
                severity: 'recommended',
                title: 'Missing repository website',
                description: 'A website URL (documentation, demo, or project homepage) provides quick access to additional resources',
                recommendation: 'Add a website URL in the About section if documentation or demo site exists',
                automated: false,
                time_estimate: '15–45 minutes',
                requires_write_access: true
            });
        }
        
        // Missing topics
        if (!hasTopics) {
            result.findings.push({
                category: 'documentation',
                severity: 'recommended',
                title: 'Missing repository topics',
                description: 'Topics (tags) help users discover your repository through GitHub search and trending pages',
                recommendation: 'Add relevant topics in the About section (e.g., language, framework, domain keywords)',
                automated: false,
                time_estimate: '15–45 minutes',
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
                              files.has('.github/pull_request_template.md') ||
                              files.has('.github/PULL_REQUEST_TEMPLATE.rst') ||
                              files.has('.github/pull_request_template.rst');

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
            'CHANGELOG.md': 'Users cannot track changes, difficult to assess upgrade impact',
            'ACCESSIBILITY.md': 'No accessibility transparency, unclear WCAG conformance, potential barriers for disabled users',
            'SUSTAINABILITY.md': 'No sustainability policy, unclear environmental impact, missed opportunity for carbon reduction'
        };
        return risks[filename] || 'Governance gap';
    }
}
