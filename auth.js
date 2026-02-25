/**
 * GitHub OAuth Authentication Module
 * Handles OAuth flow for static GitHub Pages deployment
 */

class GitHubAuth {
    constructor() {
        // GitHub OAuth App Configuration
        // These will be set in config.js for each deployment
        this.clientId = window.CONFIG?.GITHUB_OAUTH_CLIENT_ID || '';
        this.redirectUri = window.location.origin + window.location.pathname;
        this.storageKey = 'github_oauth_token';
        this.stateKey = 'github_oauth_state';
        
        // Initialize on load
        this.init();
    }
    
    init() {
        // Check if we're returning from OAuth
        const urlParams = new URLSearchParams(window.location.search);
        const code = urlParams.get('code');
        const state = urlParams.get('state');
        
        if (code && state) {
            this.handleOAuthCallback(code, state);
        }
    }
    
    /**
     * Check if user is authenticated
     */
    isAuthenticated() {
        const token = this.getToken();
        return !!token;
    }
    
    /**
     * Get stored OAuth token
     */
    getToken() {
        return sessionStorage.getItem(this.storageKey);
    }
    
    /**
     * Store OAuth token
     */
    setToken(token) {
        sessionStorage.setItem(this.storageKey, token);
    }
    
    /**
     * Remove stored token
     */
    clearToken() {
        sessionStorage.removeItem(this.storageKey);
        sessionStorage.removeItem(this.stateKey);
    }
    
    /**
     * Initiate GitHub OAuth flow
     */
    login() {
        if (!this.clientId) {
            alert('GitHub OAuth is not configured.\n\n' +
                  'For most users, you don\'t need OAuth!\n' +
                  'Simply add a Personal Access Token to config.js:\n' +
                  '  1. Get a token: https://github.com/settings/tokens\n' +
                  '  2. Add to GITHUB_TOKEN in config.js\n' +
                  '  3. This gives you 5,000 requests/hour\n\n' +
                  'OAuth is only needed for GitHub Pages deployment with multiple users.\n' +
                  'See GITHUB_PAGES_SETUP.md for details.');
            return;
        }
        
        // Generate random state for CSRF protection
        const state = this.generateRandomState();
        sessionStorage.setItem(this.stateKey, state);
        
        // Build OAuth authorization URL
        const params = new URLSearchParams({
            client_id: this.clientId,
            redirect_uri: this.redirectUri,
            scope: 'public_repo', // Minimal scope for public repo analysis
            state: state
        });
        
        // Redirect to GitHub OAuth
        window.location.href = `https://github.com/login/oauth/authorize?${params.toString()}`;
    }
    
    /**
     * Handle OAuth callback
     */
    async handleOAuthCallback(code, state) {
        // Verify state to prevent CSRF
        const storedState = sessionStorage.getItem(this.stateKey);
        if (state !== storedState) {
            console.error('OAuth state mismatch - possible CSRF attack');
            this.clearState();
            return;
        }
        
        try {
            // For static sites, we need a proxy to exchange code for token
            // GitHub doesn't allow CORS for the token endpoint
            // Users should deploy their own proxy or use a service like:
            // - https://github.com/prose/gatekeeper
            // - https://github.com/cloudflare/oauth-worker
            // - Their own serverless function
            
            const proxyUrl = window.CONFIG?.GITHUB_OAUTH_PROXY || '';
            
            if (!proxyUrl) {
                throw new Error('OAuth proxy not configured. Please set GITHUB_OAUTH_PROXY in config.js');
            }
            
            const response = await fetch(proxyUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    code: code,
                    client_id: this.clientId,
                    redirect_uri: this.redirectUri
                })
            });
            
            if (!response.ok) {
                throw new Error('Failed to exchange OAuth code for token');
            }
            
            const data = await response.json();
            
            if (data.access_token) {
                this.setToken(data.access_token);
                console.log('✓ Successfully authenticated with GitHub OAuth');
                
                // Clean up URL and reload
                window.history.replaceState({}, document.title, window.location.pathname);
                window.location.reload();
            } else {
                throw new Error('No access token in response');
            }
            
        } catch (error) {
            console.error('OAuth error:', error);
            alert('Authentication failed: ' + error.message);
            this.clearState();
        }
    }
    
    /**
     * Clear OAuth state
     */
    clearState() {
        sessionStorage.removeItem(this.stateKey);
        // Clean up URL
        window.history.replaceState({}, document.title, window.location.pathname);
    }
    
    /**
     * Logout - clear token
     */
    logout() {
        this.clearToken();
        window.location.reload();
    }
    
    /**
     * Generate random state for CSRF protection
     */
    generateRandomState() {
        const array = new Uint8Array(16);
        crypto.getRandomValues(array);
        return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
    }
    
    /**
     * Get user info from GitHub API
     */
    async getUserInfo() {
        const token = this.getToken();
        if (!token) return null;
        
        try {
            const response = await fetch('https://api.github.com/user', {
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            
            if (!response.ok) {
                // Token might be invalid
                if (response.status === 401) {
                    this.clearToken();
                }
                return null;
            }
            
            return await response.json();
        } catch (error) {
            console.error('Failed to get user info:', error);
            return null;
        }
    }
}

// Initialize auth globally
window.githubAuth = new GitHubAuth();
