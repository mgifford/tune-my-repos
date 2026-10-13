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
 * The published GitHub Pages site has no sign-in. A static page cannot
 * complete GitHub's OAuth flow without a server holding the client secret,
 * so tokens are for local development only and must never be committed.
 */

const CONFIG = {
    // Local development token (not committed, optional)
    GITHUB_TOKEN: ''
};
