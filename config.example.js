/**
 * GitHub Configuration
 * 
 * LOCAL DEVELOPMENT OPTIONS:
 * 
 * Option 1 (Recommended): Use .env file
 *   1. Copy .env.example to .env
 *   2. Add your token to the .env file
 *   3. The .env file is gitignored and won't be committed
 *   4. This app will automatically load from .env if present
 * 
 * Option 2: Use this config.js file
 *   1. Copy this file to config.js
 *   2. Add your token below
 *   3. config.js is gitignored and won't be committed
 * 
 * Create a Personal Access Token:
 *   https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
 * 
 * Required scopes:
 *   - public_repo (for public repositories)
 *   - repo (for private repositories - optional)
 * 
 * Benefits:
 *   - Without token: 60 API requests/hour (unauthenticated)
 *   - With token: 5,000 API requests/hour
 *   - Access to private repositories (if granted)
 * 
 * 
 * GITHUB PAGES / PRODUCTION DEPLOYMENT:
 * 
 * For GitHub Pages deployment, configure GitHub OAuth:
 * 
 * 1. Create a GitHub OAuth App:
 *    https://github.com/settings/developers
 *    - Application name: Your app name
 *    - Homepage URL: https://yourusername.github.io/tune-my-repos/
 *    - Authorization callback URL: https://yourusername.github.io/tune-my-repos/
 * 
 * 2. Deploy an OAuth proxy (required for static sites):
 *    Option A: Use Cloudflare Workers (recommended)
 *      https://github.com/gr2m/cloudflare-worker-github-oauth-login
 *    
 *    Option B: Deploy your own proxy
 *      https://github.com/prose/gatekeeper
 * 
 * 3. Configure OAuth settings below and commit to repository
 */

const CONFIG = {
    // Local development token (not committed, optional)
    GITHUB_TOKEN: '',
    
    // GitHub OAuth App Configuration (for GitHub Pages deployment)
    // These values CAN be committed as they are public (client ID is not secret)
    GITHUB_OAUTH_CLIENT_ID: '',  // Your OAuth App Client ID
    GITHUB_OAUTH_PROXY: ''        // Your OAuth proxy URL (e.g., https://your-worker.workers.dev/api/github/oauth/token)
};
