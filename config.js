/**
 * GitHub Configuration
 * 
 * FOR LOCAL/PERSONAL USE (RECOMMENDED FOR MOST USERS):
 * =====================================================
 * Simply add your Personal Access Token to GITHUB_TOKEN below.
 * This gives you 5,000 API requests/hour and is sufficient for most use cases.
 * 
 * Get a token from: https://github.com/settings/tokens
 * Required scopes: public_repo (or repo for private repositories)
 * 
 * Example:
 *   GITHUB_TOKEN: 'ghp_your_token_here'
 * 
 * Note: This file is gitignored and won't be committed to the repository.
 * 
 * 
 * FOR GITHUB PAGES DEPLOYMENT ONLY (Advanced):
 * ============================================
 * OAuth is ONLY needed if you're deploying to GitHub Pages and want 
 * multiple users to sign in with their own GitHub accounts.
 * 
 * If you're just running locally or for personal use, you can ignore the 
 * OAuth settings below and just use GITHUB_TOKEN.
 * 
 * To set up OAuth (requires OAuth proxy deployment):
 * See GITHUB_PAGES_SETUP.md for detailed instructions
 */

const CONFIG = { 
    // Personal Access Token (for local/personal use)
    GITHUB_TOKEN: '',
    
    // GitHub OAuth (only for GitHub Pages deployment with multiple users)
    GITHUB_OAUTH_CLIENT_ID: '',
    GITHUB_OAUTH_PROXY: ''
};
