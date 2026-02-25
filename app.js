/**
 * Main application logic for tune-my-repos
 */

let allResults = [];
let paginationState = {
    userOrOrg: null,
    page: 1,
    perPage: 50,
    hasMore: false
};

// DOM elements
const form = document.getElementById('analyzeForm');
const targetInput = document.getElementById('targetInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const skipForksCheckbox = document.getElementById('skipForks');
const paginationControls = document.getElementById('paginationControls');
const loadMoreBtn = document.getElementById('loadMoreBtn');
const paginationInfo = document.getElementById('paginationInfo');
const loadingSection = document.getElementById('loadingSection');
const progressText = document.getElementById('progressText');
const batchProgress = document.getElementById('batchProgress');
const progressFill = document.getElementById('progressFill');
const progressStats = document.getElementById('progressStats');
const infoSection = document.getElementById('infoSection');
const infoMessage = document.getElementById('infoMessage');
const errorSection = document.getElementById('errorSection');
const errorMessage = document.getElementById('errorMessage');
const resultsSection = document.getElementById('resultsSection');
const exportJsonBtn = document.getElementById('exportJson');
const exportMarkdownBtn = document.getElementById('exportMarkdown');
const exportCsvBtn = document.getElementById('exportCsv');

// Event listeners
form.addEventListener('submit', handleAnalyze);
exportJsonBtn.addEventListener('click', exportAsJSON);
exportMarkdownBtn.addEventListener('click', exportAsMarkdown);
exportCsvBtn.addEventListener('click', exportAsCSV);
loadMoreBtn.addEventListener('click', handleLoadMore);

async function handleAnalyze(e) {
    e.preventDefault();
    
    const targetValue = targetInput.value.trim();
    const token = window.CONFIG?.GITHUB_TOKEN || '';
    
    if (!targetValue) {
        showError('Please enter a GitHub user, organization, or repository');
        return;
    }
    
    // Debug: Log token status
    console.log('Token status:', token ? `Present (${token.substring(0, 4)}...)` : 'Not present');
    
    // Show rate limit warning if no token provided
    if (!token) {
        showInfo('Analyzing public repositories only. Without a GitHub token, you\'re limited to 60 API requests/hour. <a href="https://github.com/settings/tokens" target="_blank">Add a token</a> in .env or config.js for higher rate limits (5,000/hour) and private repo access.');
    }
    
    // Reset UI
    hideAllSections();
    loadingSection.classList.remove('hidden');
    analyzeBtn.disabled = true;
    allResults = [];
    
    try {
        const analyzer = new GitHubAnalyzer(token);
        
        // Determine if it's a single repo (contains /) or user/org
        if (targetValue.includes('/')) {
            // Single repo mode
            const [owner, repo] = targetValue.split('/', 2);
            progressText.textContent = `Analyzing ${targetValue}...`;
            const result = await analyzer.analyzeRepository(owner, repo, (status) => {
                progressText.textContent = status;
            });
            allResults = [result];
            displayResults(allResults);
        } else {
            // User/org mode - analyze all repos
            await analyzeBatch(analyzer, targetValue);
        }
    } catch (error) {
        showError(error.message);
        console.error('Analysis error:', error);
    } finally {
        loadingSection.classList.add('hidden');
        batchProgress.classList.add('hidden');
        analyzeBtn.disabled = false;
        progressText.textContent = 'Analyzing repository...';
    }
}

async function handleLoadMore() {
    if (!paginationState.userOrOrg) return;
    
    loadMoreBtn.disabled = true;
    loadingSection.classList.remove('hidden');
    
    try {
        const analyzer = new GitHubAnalyzer(window.CONFIG?.GITHUB_TOKEN || '');
        await analyzeBatch(analyzer, paginationState.userOrOrg, paginationState.page + 1, true);
    } catch (error) {
        showError(error.message);
        console.error('Load more error:', error);
    } finally {
        loadingSection.classList.add('hidden');
        loadMoreBtn.disabled = false;
    }
}

async function analyzeBatch(analyzer, userOrOrg, page = 1, append = false) {
    try {
        // Fetch repos for this user/org with pagination
        const skipForks = skipForksCheckbox.checked;
        progressText.textContent = `Fetching repositories for ${userOrOrg}...`;
        const headers = {
            'Accept': 'application/vnd.github.v3+json'
        };
        
        // Only add Authorization header if token is provided
        if (CONFIG.GITHUB_TOKEN) {
            headers['Authorization'] = `token ${CONFIG.GITHUB_TOKEN}`;
        }
        
        let response;
        try {
            // Sort by recently updated, fetch in pages of 50
            response = await fetch(
                `https://api.github.com/users/${userOrOrg}/repos?sort=updated&direction=desc&per_page=${paginationState.perPage}&page=${page}`,
                { headers }
            );
        } catch (fetchError) {
            // Network error, CORS issue, or connection problem
            throw new Error(`Network error fetching repositories: ${fetchError.message}. Make sure you're serving the app via HTTP server (not file://) or use a GitHub token.`);
        }
        
        if (!response.ok) {
            let errorMsg = `HTTP ${response.status} ${response.statusText}`;
            try {
                const errorData = await response.json();
                if (errorData.message) {
                    errorMsg += `: ${errorData.message}`;
                }
                // Check for rate limiting
                if (response.status === 403 && response.headers.get('X-RateLimit-Remaining') === '0') {
                    const resetTime = new Date(parseInt(response.headers.get('X-RateLimit-Reset')) * 1000);
                    errorMsg += ` Rate limit exceeded. Resets at ${resetTime.toLocaleTimeString()}`;
                }
            } catch (e) {
                // If we can't parse the error response, just use the status
            }
            throw new Error(`Failed to fetch repositories: ${errorMsg}`);
        }
        
        let repos = await response.json();
        
        // Filter out forks if requested
        if (skipForks) {
            const originalCount = repos.length;
            repos = repos.filter(repo => !repo.fork);
            const skippedCount = originalCount - repos.length;
            if (skippedCount > 0) {
                console.log(`Skipped ${skippedCount} forked repositories out of ${originalCount} total`);
                if (repos.length === 0) {
                    showInfo(`All ${originalCount} repositories were forks and were skipped. Uncheck "Skip forked repositories" to analyze them.`);
                } else {
                    showInfo(`Skipped ${skippedCount} forked repositories. Analyzing ${repos.length} non-fork repositories.`);
                }
            }
        }
        
        // Update pagination state
        paginationState.userOrOrg = userOrOrg;
        paginationState.page = page;
        paginationState.hasMore = repos.length === paginationState.perPage;
        
        if (!repos || repos.length === 0) {
            if (!append) {
                showError(`No repositories found for ${userOrOrg}`);
            } else {
                showInfo('No more repositories to load');
                paginationControls.classList.add('hidden');
            }
            return;
        }
        
        // Show batch progress
        batchProgress.classList.remove('hidden');
        const progressBar = document.getElementById('progressFill');
        const progressStats = document.getElementById('progressStats');
        
        // Analyze each repo
        const batchResults = [];
        let failedCount = 0;
        for (let i = 0; i < repos.length; i++) {
            const repo = repos[i];
            const percent = Math.round(((i + 1) / repos.length) * 100);
            progressBar.style.width = `${percent}%`;
            progressStats.textContent = `${i + 1} / ${repos.length}`;
            progressText.textContent = `Analyzing ${repo.full_name}...`;
            
            try {
                const result = await analyzer.analyzeRepository(repo.owner.login, repo.name);
                batchResults.push(result);
            } catch (error) {
                console.error(`Error analyzing ${repo.full_name}:`, error);
                failedCount++;
                // Continue with other repos even if one fails
            }
        }
        
        // Log summary
        console.log(`Analysis complete: ${batchResults.length} succeeded, ${failedCount} failed out of ${repos.length} total`);
        if (failedCount > 0 && batchResults.length === 0) {
            showError(`All ${failedCount} repository analyses failed. Check the browser console for details.`);
            return;
        }
        
        if (append) {
            allResults = allResults.concat(batchResults);
        } else {
            allResults = batchResults;
        }
        
        displayResults(allResults);
        
        // Show/hide pagination controls
        if (paginationState.hasMore) {
            paginationControls.classList.remove('hidden');
            paginationInfo.textContent = `Showing ${allResults.length} repositories (sorted by recently updated)`;
        } else {
            paginationControls.classList.add('hidden');
        }
    } catch (error) {
        throw error;
    }
}

function displayOverallStats(results) {
    const statsCard = document.getElementById('summaryStats');
    statsCard.classList.remove('hidden');
    
    document.getElementById('totalRepos').textContent = results.length;
    
    const maturityCounts = { low: 0, medium: 0, high: 0 };
    results.forEach(r => maturityCounts[r.maturity_level]++);
    const avgMaturity = maturityCounts.high > results.length / 2 ? 'High' :
                       maturityCounts.low > results.length / 2 ? 'Low' : 'Medium';
    document.getElementById('avgMaturity').textContent = avgMaturity;
    
    const totalCritical = results.reduce((sum, r) => 
        sum + r.findings.filter(f => f.severity === 'critical').length, 0);
    document.getElementById('totalCritical').textContent = totalCritical;
    
    const totalImportant = results.reduce((sum, r) => 
        sum + r.findings.filter(f => f.severity === 'important').length, 0);
    document.getElementById('totalImportant').textContent = totalImportant;
}

function createRepoCard(result) {
    const card = document.createElement('div');
    card.className = 'repo-result-card';
    
    const header = document.createElement('div');
    header.className = 'repo-header';
    
    const maturityClass = `maturity-${result.maturity_level}`;
    const criticalCount = result.findings.filter(f => f.severity === 'critical').length;
    const importantCount = result.findings.filter(f => f.severity === 'important').length;
    
    header.innerHTML = `
        <h3>
            <a href="https://github.com/${result.repository}" target="_blank" rel="noopener">${result.repository}</a>
        </h3>
        <div class="repo-meta">
            <span class="badge badge-${result.classification}">${result.classification}</span>
            <span class="badge ${maturityClass}">${result.maturity_level} maturity</span>
            ${criticalCount > 0 ? `<span class="badge badge-critical">${criticalCount} critical</span>` : ''}
            ${importantCount > 0 ? `<span class="badge badge-important">${importantCount} important</span>` : ''}
        </div>
    `;
    
    card.appendChild(header);
    
    // Show top findings only
    if (result.findings.length > 0) {
        const topFindings = result.findings.slice(0, 3);
        const findingsList = document.createElement('div');
        findingsList.className = 'findings-summary';
        
        topFindings.forEach(finding => {
            const findingItem = document.createElement('div');
            findingItem.className = 'finding-item';
            
            const findingText = document.createElement('div');
            findingText.className = 'finding-text';
            findingText.innerHTML = `<strong>${finding.title}</strong>: ${finding.recommendation}`;
            
            const actionLink = getActionLink(finding, result.repository);
            
            findingItem.appendChild(findingText);
            
            if (actionLink) {
                const actionDiv = document.createElement('div');
                actionDiv.className = 'finding-action';
                actionDiv.innerHTML = actionLink;
                findingItem.appendChild(actionDiv);
            }
            
            findingsList.appendChild(findingItem);
        });
        
        card.appendChild(findingsList);
        
        if (result.findings.length > 3) {
            const more = document.createElement('p');
            more.className = 'more-findings';
            more.textContent = `+ ${result.findings.length - 3} more issues`;
            card.appendChild(more);
        }
    } else {
        const noIssues = document.createElement('p');
        noIssues.className = 'no-issues';
        noIssues.textContent = '✅ No issues found';
        card.appendChild(noIssues);
    }
    
    return card;
}

function hideAllSections() {
    errorSection.classList.add('hidden');
    infoSection.classList.add('hidden');
    resultsSection.classList.add('hidden');
}

function showError(message) {
    errorMessage.textContent = message;
    errorSection.classList.remove('hidden');
    infoSection.classList.add('hidden');
    resultsSection.classList.add('hidden');
}

function showInfo(message) {
    infoMessage.innerHTML = message;
    infoSection.classList.remove('hidden');
    errorSection.classList.add('hidden');
}

function displayResults(results) {
    resultsSection.classList.remove('hidden');
    const container = document.getElementById('resultsContainer');
    container.innerHTML = '';
    
    // Show overall stats if multiple repos
    if (results.length > 1) {
        displayOverallStats(results);
    } else {
        document.getElementById('summaryStats').classList.add('hidden');
    }
    
    results.forEach(result => {
        container.appendChild(createRepoCard(result));
    });
}

function getActionLink(finding, repoUrl) {
    const [owner, repo] = repoUrl.split('/');
    
    switch(finding.title) {
        case 'Missing LICENSE':
            return `<a href="https://github.com/${owner}/${repo}/community/license/new?branch=main" target="_blank" class="action-btn" rel="noopener">📄 Add License Now</a>`;
        
        case 'Missing CODE_OF_CONDUCT.md':
            return `<a href="https://www.contributor-covenant.org/version/2/1/code_of_conduct/" target="_blank" class="action-btn" rel="noopener">📜 Get Template</a>`;
        
        case 'Missing SECURITY.md':
            const securityPrompt = `Create a SECURITY.md file for ${repoUrl} that includes:\n- Supported versions\n- How to report vulnerabilities\n- Security update process\n- Contact information`;
            return `<button class="action-btn" onclick="copyToClipboard('${securityPrompt.replace(/'/g, "\\'")}'); return false;">📋 Copy AI Prompt</button>`;
        
        case 'Missing CONTRIBUTING.md':
            const contributingPrompt = `Create a comprehensive CONTRIBUTING.md file for the ${repoUrl} repository that includes:
- How to set up the development environment
- Coding standards and style guidelines
- How to submit changes (pull request process)
- How to report bugs and request features
- Testing requirements
- Code review process
- Community guidelines and communication channels

Tailor the content to match the project type and tech stack. Make it welcoming and clear for new contributors.`;
            return `<a href="https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors" target="_blank" class="action-btn" rel="noopener">📚 View Guide</a> <button class="action-btn" onclick="copyToClipboard('${contributingPrompt.replace(/'/g, "\\'")}'); return false;">📋 Copy AI Prompt</button>`;
        
        case 'Missing README.md':
            return `<a href="https://github.com/${owner}/${repo}/new/main?filename=README.md" target="_blank" class="action-btn" rel="noopener">📖 Create README</a>`;
        
        case 'Missing CHANGELOG.md':
            return `<a href="https://github.com/${owner}/${repo}/new/main?filename=CHANGELOG.md" target="_blank" class="action-btn" rel="noopener">📋 Create Changelog</a>`;
        
        default:
            return null;
    }
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showInfo('Prompt copied to clipboard! Paste it into your AI assistant.');
    }).catch(err => {
        console.error('Failed to copy:', err);
    });
}

function displayResults(results) {
    if (!results || results.length === 0) {
        showError('No results to display. This could mean: (1) All repositories were skipped as forks, (2) No repositories were found, or (3) All analyses failed. Check the browser console for details.');
        return;
    }
    
    // Show overall stats for batch mode
    if (results.length > 1) {
        displayOverallStats(results);
    }
    
    // Display individual repo results
    const container = document.getElementById('resultsContainer');
    container.innerHTML = '';
    
    results.forEach(result => {
        const repoCard = createRepoCard(result);
        container.appendChild(repoCard);
    });
    
    errorSection.classList.add('hidden');
    resultsSection.classList.remove('hidden');
}

function displayFindings(findings) {
    const container = document.getElementById('findingsContainer');
    container.innerHTML = '';
    
    if (findings.length === 0) {
        container.innerHTML = '<div class="summary-card"><h3>✅ No issues found!</h3></div>';
        return;
    }
    
    // Group by severity
    const bySeverity = {
        critical: findings.filter(f => f.severity === 'critical'),
        important: findings.filter(f => f.severity === 'important'),
        recommended: findings.filter(f => f.severity === 'recommended'),
        optional: findings.filter(f => f.severity === 'optional')
    };
    
    const severityIcons = {
        critical: '🔴',
        important: '🟡',
        recommended: '🔵',
        optional: '⚪'
    };
    
    for (const [severity, items] of Object.entries(bySeverity)) {
        if (items.length === 0) continue;
        
        const section = document.createElement('div');
        section.className = 'findings-category';
        
        const header = document.createElement('div');
        header.className = 'category-header';
        header.innerHTML = `
            <span style="font-size: 1.5rem">${severityIcons[severity]}</span>
            <h3>${severity.toUpperCase()}</h3>
            <span class="severity-badge severity-${severity}">${items.length} issue${items.length > 1 ? 's' : ''}</span>
        `;
        section.appendChild(header);
        
        items.forEach(finding => {
            const card = createFindingCard(finding);
            section.appendChild(card);
        });
        
        container.appendChild(section);
    }
}

function createFindingCard(finding) {
    const card = document.createElement('div');
    card.className = `finding-card ${finding.severity}`;
    
    const title = document.createElement('div');
    title.className = 'finding-title';
    title.textContent = finding.title;
    
    const meta = document.createElement('div');
    meta.className = 'finding-meta';
    meta.innerHTML = `
        <span>📁 ${finding.category}</span>
        <span>⏱️ ${finding.time_estimate}</span>
        <span>🤖 ${finding.automated ? 'Can automate' : 'Manual'}</span>
        ${finding.requires_write_access ? '<span>🔒 Requires write access</span>' : ''}
    `;
    
    const description = document.createElement('div');
    description.className = 'finding-description';
    description.innerHTML = `<strong>Impact:</strong> ${finding.description}`;
    
    const recommendation = document.createElement('div');
    recommendation.className = 'finding-recommendation';
    recommendation.innerHTML = `<strong>Recommended action:</strong> ${finding.recommendation}`;
    
    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(description);
    card.appendChild(recommendation);
    
    return card;
}

function exportAsJSON() {
    if (!allResults || allResults.length === 0) return;
    
    const json = JSON.stringify(allResults, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    const filename = allResults.length === 1 
        ? `${allResults[0].repository.replace('/', '-')}-analysis.json`
        : 'batch-analysis.json';
    a.href = url;
    a.download = filename;
    a.click();
    
    URL.revokeObjectURL(url);
}

function exportAsCSV() {
    if (!allResults || allResults.length === 0) return;
    
    let csv = 'Repository,Classification,Maturity,Fork,Critical,Important,Recommended,Optional\n';
    
    allResults.forEach(result => {
        const critical = result.findings.filter(f => f.severity === 'critical').length;
        const important = result.findings.filter(f => f.severity === 'important').length;
        const recommended = result.findings.filter(f => f.severity === 'recommended').length;
        const optional = result.findings.filter(f => f.severity === 'optional').length;
        
        csv += `"${result.repository}","${result.classification}","${result.maturity_level}","${result.is_fork}",${critical},${important},${recommended},${optional}\n`;
    });
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = 'repository-analysis.csv';
    a.click();
    
    URL.revokeObjectURL(url);
}

function exportAsMarkdown() {
    if (!allResults || allResults.length === 0) return;
    
    let md = `# Repository Analysis Report\n\n`;
    md += `**Analyzed:** ${new Date().toLocaleString()}\n`;
    md += `**Total Repositories:** ${allResults.length}\n\n`;
    
    allResults.forEach(result => {
        md += `## ${result.repository}\n\n`;
        md += `- **Classification:** ${result.classification}\n`;
        md += `- **Maturity:** ${result.maturity_level}\n`;
        md += `- **Fork:** ${result.is_fork}\n\n`;
        
        if (result.findings.length > 0) {
            md += `### Issues (${result.findings.length})\n\n`;
            result.findings.forEach(f => {
                md += `- **${f.title}** (${f.severity}): ${f.recommendation}\n`;
            });
            md += `\n`;
        }
    });
    
    md += `---\n*Generated by tune-my-repos*\n`;
    
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = 'repository-analysis.md';
    a.click();
    
    URL.revokeObjectURL(url);
}
