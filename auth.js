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

        // Set up PAT modal event listeners once the DOM is ready
        window.addEventListener('DOMContentLoaded', () => this.initPATModal());
    }

    /**
     * Wire up PAT modal buttons and keyboard handlers (idempotent — runs only once)
     */
    initPATModal() {
        if (this._patModalInitialized) return;
        this._patModalInitialized = true;

        const modal = document.getElementById('patModal');
        if (!modal) return;

        const closeBtn = document.getElementById('patModalClose');
        const cancelBtn = document.getElementById('patCancel');
        const form = document.getElementById('patForm');

        if (closeBtn) closeBtn.addEventListener('click', () => this.closePATModal());
        if (cancelBtn) cancelBtn.addEventListener('click', () => this.closePATModal());
        if (form) {
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                const token = document.getElementById('patInput')?.value;
                this.submitPAT(token);
            });
        }

        // Close when clicking the backdrop
        this._backdropHandler = (e) => {
            if (e.target === modal) this.closePATModal();
        };
        modal.addEventListener('click', this._backdropHandler);

        // Close on Escape key
        this._escapeHandler = (e) => {
            if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
                this.closePATModal();
            }
        };
        document.addEventListener('keydown', this._escapeHandler);
    }

    /**
     * Show the PAT input modal and focus the input field
     */
    showPATModal() {
        const modal = document.getElementById('patModal');
        if (!modal) return;
        modal.classList.remove('hidden');
        const patInput = document.getElementById('patInput');
        if (patInput) {
            patInput.value = '';
            patInput.focus();
        }
        this.clearPATError();
    }

    /**
     * Hide the PAT input modal and reset its state
     */
    closePATModal() {
        const modal = document.getElementById('patModal');
        if (modal) modal.classList.add('hidden');
        const patInput = document.getElementById('patInput');
        if (patInput) patInput.value = '';
        this.clearPATError();
    }

    /**
     * Validate the supplied PAT against the GitHub API and store it on success
     */
    async submitPAT(token) {
        if (!token || !token.trim()) {
            this.showPATError('Please enter a token.');
            return;
        }

        const submitBtn = document.getElementById('patSubmit');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Verifying…';
        }

        try {
            const response = await fetch('https://api.github.com/user', {
                headers: {
                    'Authorization': `Bearer ${token.trim()}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            if (!response.ok) {
                const msg = response.status === 401
                    ? 'Invalid token. Please check it and try again.'
                    : 'Could not verify token (GitHub returned ' + response.status + '). Please try again.';
                this.showPATError(msg);
                return;
            }

            this.setToken(token.trim());
            this.closePATModal();
            window.location.reload();
        } catch (error) {
            console.error('PAT validation error:', error);
            this.showPATError('Network error. Please check your connection and try again.');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Sign in';
            }
        }
    }

    /**
     * Show an error message inside the PAT modal
     */
    showPATError(message) {
        const patError = document.getElementById('patError');
        if (patError) {
            patError.textContent = message;
            patError.classList.remove('hidden');
        }
    }

    /**
     * Clear any error message inside the PAT modal
     */
    clearPATError() {
        const patError = document.getElementById('patError');
        if (patError) {
            patError.textContent = '';
            patError.classList.add('hidden');
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
            // No OAuth App configured — fall back to the PAT input modal
            this.showPATModal();
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
