/**
 * Main application logic for tune-my-repos
 */

// GitHub API rate limits (as of 2024)
const GITHUB_RATE_LIMITS = {
    unauthenticated: 60,  // requests per hour
    authenticated: 5000   // requests per hour
};

let allResults = [];
let analysisStats = {
    succeeded: 0,
    failed: 0,
    total: 0
};
let paginationState = {
    userOrOrg: null,
    page: 1,
    perPage: 50,
    hasMore: false
};

// Debug mode
let debugMode = false;

// Priorities configuration
let prioritiesConfig = null;

// Debug logging helper - checks localStorage for cross-session persistence
function debugLog(message, ...args) {
    // Check both debugMode and localStorage to support:
    // 1. debugMode variable (for same-session checks)
    // 2. localStorage (for persistence across reloads and cross-module access)
    if (debugMode || localStorage.getItem('tune-my-repos-debug') === 'true') {
        console.log(`[DEBUG] ${message}`, ...args);
    }
}

// Error logging helper with stack trace
function errorLog(message, error) {
    console.error(`[ERROR] ${message}`, error);
    if (error && error.stack) {
        console.error('Stack trace:', error.stack);
    }
}

// Global unhandled rejection handler
// Catches any unhandled promise rejections to prevent console clutter
window.addEventListener('unhandledrejection', (event) => {
    // Check if the error is from a browser extension
    // Extension errors typically have filenames that aren't part of our app
    const isExtensionError = event.reason && (
        event.filename?.includes('extension://') ||
        event.filename?.includes('chrome-extension://') ||
        event.filename?.includes('moz-extension://') ||
        // Common extension file patterns
        event.filename?.includes('background-redux') ||
        event.filename?.includes('content_script')
    );
    
    if (isExtensionError) {
        // Silently prevent extension errors from showing in console
        event.preventDefault();
        debugLog('Suppressed browser extension error:', event.reason);
        return;
    }
    
    // Log application errors for debugging
    errorLog('Unhandled promise rejection', event.reason);
    debugLog('Promise rejection details:', {
        reason: event.reason,
        promise: event.promise
    });
});

// Load priorities configuration
async function loadPrioritiesConfig() {
    try {
        debugLog('Loading priorities configuration...');
        const response = await fetch('priorities.json');
        if (response.ok) {
            prioritiesConfig = await response.json();
            console.log('Priorities configuration loaded');
            debugLog('Priorities config:', prioritiesConfig);
        } else {
            console.warn('Priorities configuration file not found (404), using default severity sorting');
        }
    } catch (error) {
        console.warn('Failed to fetch priorities configuration, using default severity sorting:', error);
        errorLog('Error loading priorities configuration', error);
    }
}

// Sort findings based on priority configuration
function sortFindings(findings) {
    if (!prioritiesConfig || prioritiesConfig.options.sort_strategy !== 'priority') {
        // Default: sort by severity
        const severityOrder = { critical: 0, important: 1, recommended: 2, optional: 3 };
        return [...findings].sort((a, b) => {
            return severityOrder[a.severity] - severityOrder[b.severity];
        });
    }
    
    // Build priority map
    const priorityMap = new Map();
    prioritiesConfig.priorities.forEach(p => {
        priorityMap.set(p.title, p);
    });
    
    // Sort by priority if available, then by severity
    const severityOrder = { critical: 0, important: 1, recommended: 2, optional: 3 };
    return [...findings].sort((a, b) => {
        const aPriority = priorityMap.get(a.title);
        const bPriority = priorityMap.get(b.title);
        
        // If both have priority, sort by priority number
        if (aPriority && bPriority) {
            return aPriority.priority - bPriority.priority;
        }
        
        // If only one has priority, it comes first
        if (aPriority) return -1;
        if (bPriority) return 1;
        
        // Neither has priority, sort by severity
        return severityOrder[a.severity] - severityOrder[b.severity];
    });
}

// DOM elements
const form = document.getElementById('analyzeForm');
const targetInput = document.getElementById('targetInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const skipForksCheckbox = document.getElementById('skipForks');
const forceRefreshCheckbox = document.getElementById('forceRefresh');
const cacheStatusDiv = document.getElementById('cacheStatus');
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

// Auth DOM elements
const authControls = document.getElementById('authControls');
const authLoading = document.getElementById('authLoading');
const authLoggedOut = document.getElementById('authLoggedOut');
const authLoggedIn = document.getElementById('authLoggedIn');
const authUsername = document.getElementById('authUsername');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const debugIndicator = document.getElementById('debugIndicator');

// Initialize auth UI and URL params when page loads
window.addEventListener('DOMContentLoaded', async () => {
    debugLog('DOMContentLoaded - initializing app');
    
    // Initialize synchronous components first
    initDebugMode();
    initURLParams();
    
    // Initialize async components with error handling
    try {
        await loadPrioritiesConfig();
    } catch (error) {
        console.error('Failed to load priorities config:', error);
    }
    
    try {
        await initAuthUI();
    } catch (error) {
        console.error('Failed to initialize auth UI:', error);
    }
});

// Initialize debug mode
function initDebugMode() {
    debugMode = localStorage.getItem('tune-my-repos-debug') === 'true';
    debugLog('Debug mode initialized:', debugMode);
    
    // Update UI indicator
    updateDebugIndicator();
    
    // Add keyboard shortcut for debug toggle (Ctrl+Shift+D)
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'D') {
            debugMode = !debugMode;
            localStorage.setItem('tune-my-repos-debug', debugMode ? 'true' : 'false');
            console.log(`Debug mode ${debugMode ? 'ENABLED' : 'DISABLED'}. Press Ctrl+Shift+D to toggle.`);
            if (debugMode) {
                console.log('Debug logging is now active. All API calls and errors will be logged.');
            }
            updateDebugIndicator();
        }
    });
    
    // Log debug instructions on startup
    console.log('💡 Tip: Press Ctrl+Shift+D to toggle debug mode for detailed logging');
}

// Update debug mode indicator
function updateDebugIndicator() {
    if (debugIndicator) {
        if (debugMode) {
            debugIndicator.classList.remove('hidden');
        } else {
            debugIndicator.classList.add('hidden');
        }
    }
}

async function initAuthUI() {
    try {
        if (!window.githubAuth) {
            console.warn('Auth module not loaded');
            debugLog('githubAuth object not found on window');
            return;
        }
        
        debugLog('Initializing auth UI...');
        
        // Show loading state - hide all other states
        authLoading.classList.remove('hidden');
        authLoggedOut.classList.add('hidden');
        authLoggedIn.classList.add('hidden');
        
        if (window.githubAuth.isAuthenticated()) {
            debugLog('User is authenticated, fetching user info...');
            // User is logged in - show username
            try {
                const userInfo = await window.githubAuth.getUserInfo();
                if (userInfo) {
                    debugLog('User info retrieved:', userInfo.login);
                    authUsername.textContent = `@${userInfo.login}`;
                    authLoggedIn.classList.remove('hidden');
                    authLoggedOut.classList.add('hidden');
                } else {
                    debugLog('Failed to retrieve user info - token may be invalid');
                    // Token invalid, show logged out state
                    authLoggedIn.classList.add('hidden');
                    authLoggedOut.classList.remove('hidden');
                }
            } catch (error) {
                console.error('Error fetching user info:', error);
                debugLog('getUserInfo error:', error);
                // Show logged out state on error, hide logged in state
                authLoggedIn.classList.add('hidden');
                authLoggedOut.classList.remove('hidden');
            }
        } else {
            debugLog('User is not authenticated');
            // Not logged in - ensure logged in state is hidden
            authLoggedIn.classList.add('hidden');
            authLoggedOut.classList.remove('hidden');
        }
        
        // Hide loading state
        authLoading.classList.add('hidden');
    } catch (error) {
        console.error('Error in initAuthUI:', error);
        // Ensure we hide loading and show only logged out state on any error
        authLoading.classList.add('hidden');
        authLoggedIn.classList.add('hidden');
        if (authLoggedOut) {
            authLoggedOut.classList.remove('hidden');
        }
    }
}

/**
 * Initialize URL parameter handling
 * Reads the 'u' parameter from URL and populates the input field
 */
function initURLParams() {
    const urlParams = new URLSearchParams(window.location.search);
    const userParam = urlParams.get('u');
    
    if (userParam) {
        targetInput.value = userParam;
    }
}

/**
 * Update URL when the targetInput field changes
 * Updates the browser URL without reloading the page
 */
function updateURL() {
    const value = targetInput.value.trim();
    const url = new URL(window.location);
    
    if (value) {
        url.searchParams.set('u', value);
    } else {
        url.searchParams.delete('u');
    }
    
    // Update URL without reloading the page
    window.history.replaceState({}, '', url);
}

// Event listeners
form.addEventListener('submit', handleAnalyze);
exportJsonBtn.addEventListener('click', exportAsJSON);
exportMarkdownBtn.addEventListener('click', exportAsMarkdown);
exportCsvBtn.addEventListener('click', exportAsCSV);
loadMoreBtn.addEventListener('click', handleLoadMore);
loginBtn.addEventListener('click', () => window.githubAuth.login());
logoutBtn.addEventListener('click', () => window.githubAuth.logout());
targetInput.addEventListener('input', updateURL);

/**
 * Get the current GitHub token from either OAuth or config
 */
function getGitHubToken() {
    // Priority: OAuth token > local token from config/env
    if (window.githubAuth && window.githubAuth.isAuthenticated()) {
        return window.githubAuth.getToken();
    }
    return window.CONFIG?.GITHUB_TOKEN || '';
}

async function handleAnalyze(e) {
    e.preventDefault();
    
    const targetValue = targetInput.value.trim();
    const token = getGitHubToken();
    const skipForks = skipForksCheckbox.checked;
    const forceRefresh = forceRefreshCheckbox.checked;
    
    debugLog('=== Starting analysis ===');
    debugLog('Target:', targetValue);
    debugLog('Skip forks:', skipForks);
    debugLog('Force refresh:', forceRefresh);
    debugLog('Token present:', !!token);
    
    if (!targetValue) {
        showError('Please enter a GitHub user, organization, or repository');
        return;
    }
    
    // Check cache first (unless force refresh is enabled)
    if (!forceRefresh && window.analysisCache) {
        debugLog('Checking cache...');
        const cached = window.analysisCache.get(targetValue, skipForks);
        if (cached) {
            debugLog('Cache hit! Using cached results');
            const ageMinutes = Math.round(cached.age / 1000 / 60);
            showCacheStatus(true, ageMinutes);
            allResults = cached.results;
            
            // Restore analysis stats from cache
            if (cached.analysisStats) {
                analysisStats = cached.analysisStats;
            } else {
                // Legacy cache without stats - we can't know if there were failures
                // Assume all cached results were successful (may not be accurate for old partial analyses)
                // Impact: Legacy cached results won't show failure counts in exports even if failures occurred
                analysisStats = {
                    succeeded: cached.results.length,
                    failed: 0,
                    total: cached.results.length
                };
            }
            
            displayResults(allResults);
            return;
        }
        debugLog('Cache miss, proceeding with fresh analysis');
    }
    
    // Clear cache status indicator
    hideCacheStatus();
    
    // Debug: Log token status
    console.log('Token status:', token ? `Present (${token.substring(0, 4)}...)` : 'Not present');
    debugLog('Token length:', token ? token.length : 0);
    
    // Show rate limit warning if no token provided
    if (!token) {
        const hasOAuthConfig = window.CONFIG?.GITHUB_OAUTH_CLIENT_ID;
        if (hasOAuthConfig) {
            showInfo(`⚡ Not authenticated. Click "Sign in with GitHub" above for higher rate limits (${GITHUB_RATE_LIMITS.authenticated.toLocaleString()}/hour) vs. ${GITHUB_RATE_LIMITS.unauthenticated}/hour unauthenticated.`);
        } else {
            showInfo(`Analyzing public repositories only. Without authentication, you're limited to ${GITHUB_RATE_LIMITS.unauthenticated} API requests/hour. For higher limits (${GITHUB_RATE_LIMITS.authenticated.toLocaleString()}/hour), <a href="https://github.com/settings/tokens" target="_blank">add a Personal Access Token</a> in .env or config.js for local development. See README for deployment options.`);
        }
    }
    
    // Reset UI
    hideAllSections();
    loadingSection.classList.remove('hidden');
    analyzeBtn.disabled = true;
    allResults = [];
    
    try {
        debugLog('Creating GitHubAnalyzer instance...');
        const analyzer = new GitHubAnalyzer(token);
        
        // Determine if it's a single repo (contains /) or user/org
        if (targetValue.includes('/')) {
            debugLog('Single repository mode detected');
            // Single repo mode
            const [owner, repo] = targetValue.split('/', 2);
            debugLog(`Analyzing repository: ${owner}/${repo}`);
            progressText.textContent = `Analyzing ${targetValue}...`;
            const result = await analyzer.analyzeRepository(owner, repo, (status) => {
                debugLog('Progress:', status);
                progressText.textContent = status;
            });
            debugLog('Repository analysis complete', result);
            allResults = [result];
            
            // Reset stats for single repo
            analysisStats.succeeded = 1;
            analysisStats.failed = 0;
            analysisStats.total = 1;
            
            // Cache the result
            if (window.analysisCache) {
                debugLog('Caching results...');
                window.analysisCache.set(targetValue, skipForks, allResults, analysisStats);
            }
            
            displayResults(allResults);
        } else {
            debugLog('User/organization mode detected');
            // User/org mode - analyze all repos
            await analyzeBatch(analyzer, targetValue);
        }
    } catch (error) {
        errorLog('Analysis failed', error);
        
        // Create a more detailed error message
        let errorDetails = error.message;
        if (error.stack) {
            debugLog('Error stack:', error.stack);
        }
        
        // Provide helpful context based on error type
        if (error.message.includes('404')) {
            errorDetails += '\n\n💡 Tip: Make sure the repository or user/organization exists and is accessible.';
        } else if (error.message.includes('403') || error.message.includes('rate limit')) {
            errorDetails += '\n\n💡 Tip: You may have hit the GitHub API rate limit. Try authenticating or wait for the limit to reset.';
        } else if (error.message.includes('Network')) {
            errorDetails += '\n\n💡 Tip: Check your internet connection. If you\'re running locally, make sure you\'re using an HTTP server (not file://).';
        }
        
        showError(errorDetails);
        console.error('Analysis error:', error);
    } finally {
        debugLog('Analysis completed, cleaning up UI');
        loadingSection.classList.add('hidden');
        batchProgress.classList.add('hidden');
        analyzeBtn.disabled = false;
        progressText.textContent = 'Analyzing repository...';
    }
}

// Load More is no longer needed since we fetch all repos at once
// Keeping this function for backwards compatibility but it won't be used
async function handleLoadMore() {
    // This function is deprecated - we now fetch all repositories automatically
    console.warn('handleLoadMore called but is deprecated - all repos are fetched automatically');
}

async function analyzeBatch(analyzer, userOrOrg, page = 1, append = false) {
    try {
        debugLog(`=== Starting batch analysis for ${userOrOrg} ===`);
        
        // Fetch ALL repos for this user/org across all pages
        const skipForks = skipForksCheckbox.checked;
        progressText.textContent = `Fetching repositories for ${userOrOrg}...`;
        const headers = {
            'Accept': 'application/vnd.github.v3+json'
        };
        
        // Get current token (OAuth or config)
        const token = getGitHubToken();
        
        // Only add Authorization header if token is provided
        if (token) {
            headers['Authorization'] = `token ${token}`;
        }
        
        debugLog('Determining account type (user vs organization)...');
        
        // Determine if this is an organization or a user
        let reposEndpoint;
        try {
            const accountResponse = await fetch(
                `https://api.github.com/users/${userOrOrg}`,
                { headers }
            );
            
            debugLog('Account check response status:', accountResponse.status);
            
            if (accountResponse.ok) {
                const accountData = await accountResponse.json();
                // GitHub API returns 'type' field: 'User' or 'Organization'
                const isOrg = accountData.type === 'Organization';
                
                if (isOrg) {
                    reposEndpoint = `https://api.github.com/orgs/${userOrOrg}/repos`;
                    console.log(`Detected organization: ${userOrOrg}, using /orgs endpoint`);
                    debugLog('Organization detected:', accountData);
                } else {
                    reposEndpoint = `https://api.github.com/users/${userOrOrg}/repos`;
                    console.log(`Detected user: ${userOrOrg}, using /users endpoint`);
                    debugLog('User account detected:', accountData);
                }
            } else {
                // If we can't determine the type, fall back to /users endpoint
                console.warn(`Could not determine account type for ${userOrOrg}, falling back to /users endpoint`);
                debugLog('Account type check failed with status:', accountResponse.status);
                reposEndpoint = `https://api.github.com/users/${userOrOrg}/repos`;
            }
        } catch (error) {
            // If there's an error checking the account type, fall back to /users endpoint
            console.warn(`Error checking account type for ${userOrOrg}:`, error.message);
            errorLog('Error checking account type', error);
            reposEndpoint = `https://api.github.com/users/${userOrOrg}/repos`;
        }
        
        debugLog('Using endpoint:', reposEndpoint);
        
        // Fetch all pages of repositories
        let allRepos = [];
        let currentPage = page;
        let hasMorePages = true;
        
        while (hasMorePages) {
            progressText.textContent = `Fetching repositories for ${userOrOrg} (page ${currentPage})...`;
            debugLog(`Fetching page ${currentPage}...`);
            
            let response;
            try {
                // Sort by recently updated, fetch in pages of 100 (max per page)
                const fetchUrl = `${reposEndpoint}?sort=updated&direction=desc&per_page=100&page=${currentPage}`;
                debugLog('Fetching:', fetchUrl);
                response = await fetch(fetchUrl, { headers });
            } catch (fetchError) {
                // Network error, CORS issue, or connection problem
                errorLog('Network error fetching repositories', fetchError);
                throw new Error(`Network error fetching repositories: ${fetchError.message}. Make sure you're serving the app via HTTP server (not file://) or use authentication.`);
            }
            
            debugLog('Repos page response status:', response.status);
            
            if (!response.ok) {
                let errorMsg = `HTTP ${response.status} ${response.statusText}`;
                try {
                    const errorData = await response.json();
                    debugLog('Error response data:', errorData);
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
            
            const repos = await response.json();
            
            // If we got fewer repos than the max per page, we've reached the end
            if (repos.length === 0) {
                hasMorePages = false;
            } else {
                allRepos = allRepos.concat(repos);
                console.log(`Fetched page ${currentPage}: ${repos.length} repos (total so far: ${allRepos.length})`);
                
                // Check if there are more pages (if we got 100 repos, there might be more)
                if (repos.length < 100) {
                    hasMorePages = false;
                } else {
                    currentPage++;
                }
            }
        }
        
        console.log(`Fetched all repositories: ${allRepos.length} total`);
        progressText.textContent = `Fetched ${allRepos.length} repositories, filtering and analyzing...`;
        
        // Filter out forks if requested
        let repos = allRepos;
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
        paginationState.page = currentPage;
        paginationState.hasMore = false; // We fetched everything
        
        if (!repos || repos.length === 0) {
            showError(`No repositories found for ${userOrOrg}`);
            return;
        }
        
        // Show batch progress
        batchProgress.classList.remove('hidden');
        const progressBar = document.getElementById('progressFill');
        const progressStats = document.getElementById('progressStats');
        
        debugLog(`Starting analysis of ${repos.length} repositories`);
        
        // Analyze each repo
        const batchResults = [];
        let failedCount = 0;
        for (let i = 0; i < repos.length; i++) {
            const repo = repos[i];
            const percent = Math.round(((i + 1) / repos.length) * 100);
            progressBar.style.width = `${percent}%`;
            progressStats.textContent = `${i + 1} / ${repos.length}`;
            progressText.textContent = `Analyzing ${repo.full_name}...`;
            
            debugLog(`[${i + 1}/${repos.length}] Analyzing ${repo.full_name}...`);
            
            try {
                const result = await analyzer.analyzeRepository(repo.owner.login, repo.name);
                batchResults.push(result);
                debugLog(`[${i + 1}/${repos.length}] ✓ ${repo.full_name} completed`);
            } catch (error) {
                console.error(`Error analyzing ${repo.full_name}:`, error);
                errorLog(`Failed to analyze ${repo.full_name}`, error);
                failedCount++;
                // Continue with other repos even if one fails
            }
        }
        
        // Log summary
        console.log(`Analysis complete: ${batchResults.length} succeeded, ${failedCount} failed out of ${repos.length} total`);
        debugLog(`=== Batch analysis complete ===`);
        debugLog('Results:', {
            succeeded: batchResults.length,
            failed: failedCount,
            total: repos.length
        });
        
        // Update analysis stats
        analysisStats.succeeded = batchResults.length;
        analysisStats.failed = failedCount;
        analysisStats.total = repos.length;
        
        if (failedCount > 0 && batchResults.length === 0) {
            showError(`All ${failedCount} repository analyses failed. Check the browser console for details.`);
            return;
        }
        
        allResults = batchResults;
        
        // Cache the results
        if (window.analysisCache) {
            window.analysisCache.set(userOrOrg, skipForksCheckbox.checked, allResults, analysisStats);
        }
        
        // Show warning if there were partial failures
        if (failedCount > 0) {
            const token = getGitHubToken();
            let warningMessage = `⚠️ Partial analysis: ${batchResults.length} repositories analyzed successfully, but ${failedCount} failed. `;
            if (!token) {
                warningMessage += `You are not authenticated. Without authentication, you are limited to ${GITHUB_RATE_LIMITS.unauthenticated} API requests per hour. <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">Get a Personal Access Token</a> for ${GITHUB_RATE_LIMITS.authenticated.toLocaleString()} requests/hour, or click "Sign in with GitHub" above.`;
            } else {
                warningMessage += `This may be due to rate limiting or individual repository access issues. Check the browser console for details.`;
            }
            showInfo(warningMessage);
        }
        
        displayResults(allResults);
        
        // Hide pagination controls since we fetched everything
        paginationControls.classList.add('hidden');
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
    
    // Show top findings and collapsible details
    if (result.findings.length > 0) {
        // Sort findings based on priority configuration
        const sortedFindings = sortFindings(result.findings);
        
        // Determine how many top findings to show
        const topCount = prioritiesConfig?.options?.top_findings_count || 3;
        const topFindings = sortedFindings.slice(0, topCount);
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
        
        // Show collapsible details for additional findings
        if (sortedFindings.length > topCount) {
            const details = document.createElement('details');
            details.className = 'findings-details';
            
            const remainingCount = sortedFindings.length - topCount;
            const summary = document.createElement('summary');
            summary.className = 'findings-summary-toggle';
            summary.textContent = `View ${remainingCount} more issue${remainingCount !== 1 ? 's' : ''}`;
            details.appendChild(summary);
            
            const additionalFindings = document.createElement('div');
            additionalFindings.className = 'findings-summary additional-findings';
            
            sortedFindings.slice(topCount).forEach(finding => {
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
                
                additionalFindings.appendChild(findingItem);
            });
            
            details.appendChild(additionalFindings);
            card.appendChild(details);
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
    // Don't show empty or whitespace-only messages
    if (!message || !message.trim()) {
        debugLog('showError called with empty message, ignoring');
        return;
    }
    
    errorMessage.innerHTML = '';
    
    // Split message into main error and tips/details
    const parts = message.split('\n\n');
    const mainError = parts[0];
    const additionalInfo = parts.slice(1);
    
    // Create main error text (safe - no user input)
    const errorText = document.createElement('div');
    errorText.textContent = mainError;
    errorText.style.marginBottom = '10px';
    errorMessage.appendChild(errorText);
    
    // Add additional info if present (safe - generated internally)
    if (additionalInfo.length > 0) {
        const infoDiv = document.createElement('div');
        infoDiv.style.marginTop = '10px';
        infoDiv.style.padding = '10px';
        infoDiv.style.background = 'rgba(255, 255, 255, 0.1)';
        infoDiv.style.borderRadius = '4px';
        // Note: innerHTML used here for internal content only (tips with emoji, no user input)
        infoDiv.innerHTML = additionalInfo.join('<br><br>');
        errorMessage.appendChild(infoDiv);
    }
    
    // Add debug instructions with kbd element
    const debugInfo = document.createElement('div');
    debugInfo.style.marginTop = '15px';
    debugInfo.style.fontSize = '0.9em';
    debugInfo.style.opacity = '0.8';
    
    const strong = document.createElement('strong');
    strong.textContent = 'Need more details?';
    
    const kbd = document.createElement('kbd');
    kbd.textContent = 'Ctrl+Shift+D';
    
    debugInfo.appendChild(document.createTextNode('💡 '));
    debugInfo.appendChild(strong);
    debugInfo.appendChild(document.createTextNode(' Press '));
    debugInfo.appendChild(kbd);
    debugInfo.appendChild(document.createTextNode(' to enable debug mode, then check the browser console (F12) for detailed logs.'));
    
    errorMessage.appendChild(debugInfo);
    
    errorSection.classList.remove('hidden');
    infoSection.classList.add('hidden');
    resultsSection.classList.add('hidden');
    
    console.error('[ERROR] Error displayed to user:', mainError);
}

function showInfo(message) {
    // Don't show empty or whitespace-only messages
    if (!message || !message.trim()) {
        debugLog('showInfo called with empty message, ignoring');
        return;
    }
    infoMessage.innerHTML = message;
    infoSection.classList.remove('hidden');
    errorSection.classList.add('hidden');
}

function showCacheStatus(isHit, ageMinutes) {
    if (!cacheStatusDiv) return;
    
    cacheStatusDiv.classList.remove('hidden');
    cacheStatusDiv.classList.add('cache-hit');
    cacheStatusDiv.innerHTML = `<strong>📦 Cached results</strong> (${ageMinutes} ${ageMinutes === 1 ? 'minute' : 'minutes'} old) - Check "Force refresh" to fetch fresh data`;
}

function hideCacheStatus() {
    if (!cacheStatusDiv) return;
    
    cacheStatusDiv.classList.add('hidden');
    cacheStatusDiv.classList.remove('cache-hit');
    cacheStatusDiv.innerHTML = '';
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
            return `<a href="https://github.com/${owner}/${repo}/community/license/new?branch=main" target="_blank" class="action-btn" rel="noopener">📄 Add License</a> (GitHub makes this easy)`;
        
        case 'Missing CODE_OF_CONDUCT.md':
            const cocPrompt = `Create a CODE_OF_CONDUCT.md file for ${repoUrl} using the Contributor Covenant template. Ensure it is written in valid Markdown. Include:
- A welcoming and inclusive statement
- Standards for behavior (Be Respectful, Be Professional, Be Considerate)
- Examples of unacceptable behavior
- Responsibilities of maintainers
- Scope of application (project spaces and public spaces when representing the project)
- Enforcement process and consequences
- Contact information for reporting issues

Base it on the Contributor Covenant 2.1: https://www.contributor-covenant.org/version/2/1/code_of_conduct/`;
            const cocPromptEscaped = cocPrompt.replace(/'/g, "\\'").replace(/\n/g, '\\n');
            return `
                <a href="https://www.contributor-covenant.org/version/2/1/code_of_conduct/" target="_blank" class="action-btn" rel="noopener">📚 View <span class="visually-hidden">CODE_OF_CONDUCT.md</span> Guide</a>
                <button class="action-btn" onclick="copyToClipboard('${cocPromptEscaped}'); return false;">📋 Copy AI Prompt<span class="visually-hidden"> for CODE_OF_CONDUCT.md</span></button> <a href="https://github.com/${owner}/${repo}/new/main?filename=CODE_OF_CONDUCT.md" target="_blank" class="action-btn" rel="noopener">📝 Create CODE_OF_CONDUCT.md</a>
            `;
        
        case 'Missing SECURITY.md':
            const securityPrompt = `Create a SECURITY.md file for ${repoUrl} that includes:\n- Supported versions\n- How to report vulnerabilities\n- Security update process\n- Contact information`;
            const securityPromptEscaped = securityPrompt.replace(/'/g, "\\'").replace(/\n/g, '\\n');
            return `<a href="https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository" target="_blank" class="action-btn" rel="noopener">📚 View <span class="visually-hidden">SECURITY.md</span> Guide</a>
                    <button class="action-btn" onclick="copyToClipboard('${securityPromptEscaped}'); return false;">📋 Copy AI Prompt<span class="visually-hidden"> for SECURITY.md</span></button> <a href="https://github.com/${owner}/${repo}/new/main?filename=SECURITY.md" target="_blank" class="action-btn" rel="noopener">📝 Create SECURITY.md</a>`;
        
        case 'Missing CONTRIBUTING.md':
            const contributingPrompt = `Create a comprehensive CONTRIBUTING.md file for the ${repoUrl} repository. Ensure it is written in valid Markdown. It should includes:
- How to set up the development environment
- Coding standards and style guidelines
- How to submit changes (pull request process)
- How to report bugs and request features
- Testing requirements
- Code review process
- Community guidelines and communication channels

Tailor the content to match the project type and tech stack. Make it welcoming and clear for new contributors. It should clearly welcome people with disabilities as valuable contributors. It should be inspired by https://gitlab.com/tgdp/templates/-/blob/main/CONTRIBUTING.md `;
            const contributingPromptEscaped = contributingPrompt.replace(/'/g, "\\'").replace(/\n/g, '\\n');
            return `<a href="https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors" target="_blank" class="action-btn" rel="noopener">📚 View <span class="visually-hidden">CONTRIBUTING.md</span> Guide</a> 
            <button class="action-btn" onclick="copyToClipboard('${contributingPromptEscaped}'); return false;">📋 Copy AI Prompt<span class="visually-hidden"> for CONTRIBUTING.md</span></button><a href="https://github.com/${owner}/${repo}/new/main?filename=CONTRIBUTING.md" target="_blank" class="action-btn" rel="noopener">📖 Create CONTRIBUTING.md</a>`;
        
        case 'Missing README':
            const readmePrompt = `Create a comprehensive README.md file for the ${repoUrl} repository. Ensure it is written in valid Markdown. It should include:
- What the project does
- How to get started installing this project
- How to get involved

Tailor the content to match the project type and tech stack. Make it welcoming and clear. It should be inspired by https://github.com/banesullivan/README`;
            const readmePromptEscaped = readmePrompt.replace(/'/g, "\\'").replace(/\n/g, '\\n');
            return `<a href="https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes" target="_blank" class="action-btn" rel="noopener">📚 View <span class="visually-hidden">README</span> Guide</a> 
            <button class="action-btn" onclick="copyToClipboard('${readmePromptEscaped}'); return false;">📋 Copy AI Prompt<span class="visually-hidden"> for README</span></button> <a href="https://github.com/${owner}/${repo}/new/main?filename=README.md" target="_blank" class="action-btn" rel="noopener">📖 Create README.md</a>`;
        
        case 'Missing repository description':
            return `<a href="https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics#about-topics" target="_blank" class="action-btn" rel="noopener">📚 View <span class="visually-hidden">About section</span> Guide</a> <a href="https://github.com/${owner}/${repo}/settings" target="_blank" class="action-btn" rel="noopener">⚙️ Edit About Section</a>`;
        
        case 'Missing repository website':
            return `<a href="https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics" target="_blank" class="action-btn" rel="noopener">📚 View <span class="visually-hidden">About section</span> Guide</a> <a href="https://github.com/${owner}/${repo}/settings" target="_blank" class="action-btn" rel="noopener">⚙️ Edit About Section</a>`;
        
        case 'Missing repository topics':
            return `<a href="https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics" target="_blank" class="action-btn" rel="noopener">📚 View <span class="visually-hidden">repository topics</span> Guide</a> <a href="https://github.com/${owner}/${repo}" target="_blank" class="action-btn" rel="noopener">🏷️ Add Topics</a>`;
        
        case 'Missing CHANGELOG.md':
            return `<a href="https://github.com/${owner}/${repo}/new/main?filename=CHANGELOG.txt" target="_blank" class="action-btn" rel="noopener">📋 Create CHANGELOG.txt</a>`;
        
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
    
    const exportData = {
        analyzed_at: new Date().toISOString(),
        total_analyzed: allResults.length,
        failed_count: analysisStats.failed,
        total_attempted: analysisStats.total,
        repositories: allResults
    };
    
    const json = JSON.stringify(exportData, null, 2);
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
    
    let csv = '';
    
    // Add summary as header comment if there were failures
    if (analysisStats.failed > 0) {
        csv += `# Summary: ${allResults.length} analyzed successfully, ${analysisStats.failed} failed out of ${analysisStats.total} total\n`;
    }
    
    csv += 'Repository,Classification,Maturity,Fork,Critical,Important,Recommended,Optional\n';
    
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
    md += `**Total Repositories:** ${allResults.length}\n`;
    
    // Add info about failures if any
    if (analysisStats.failed > 0) {
        md += `**⚠️ Note:** ${analysisStats.failed} repositories failed analysis out of ${analysisStats.total} total\n`;
    }
    md += `\n`;
    
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
