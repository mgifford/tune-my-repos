# GitHub Pages OAuth Setup Guide

This guide explains how to configure GitHub OAuth authentication for the GitHub Pages deployment of tune-my-repos.

## Why OAuth?

When deployed to GitHub Pages, this application can't securely store GitHub Personal Access Tokens. OAuth allows users to authenticate with their own GitHub accounts, giving them:

- **Higher rate limits**: 5,000 API requests/hour (vs. 60/hour unauthenticated)
- **Access to private repositories**: If they grant permission
- **No shared credentials**: Each user uses their own authentication

## Prerequisites

1. A GitHub account
2. Your GitHub Pages site URL (e.g., `https://yourusername.github.io/tune-my-repos/`)
3. An OAuth proxy service (required for static sites)

## Step 1: Create a GitHub OAuth App

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click **"OAuth Apps"** → **"New OAuth App"**
3. Fill in the application details:
   - **Application name**: `tune-my-repos` (or your preferred name)
   - **Homepage URL**: Your GitHub Pages URL (e.g., `https://yourusername.github.io/tune-my-repos/`)
   - **Authorization callback URL**: Same as homepage URL (e.g., `https://yourusername.github.io/tune-my-repos/`)
   - **Application description**: (optional) "Repository analysis tool"
4. Click **"Register application"**
5. **Save your Client ID** - you'll need this later
6. **Save your Client Secret** - you'll need this for the OAuth proxy

⚠️ **Security Note**: The Client ID is public and can be committed to your repository. The Client Secret must be kept private and should only be used in your OAuth proxy.

## Step 2: Deploy an OAuth Proxy

GitHub's token exchange endpoint doesn't support CORS, so static sites need a proxy to exchange the OAuth code for an access token.

### Option A: Cloudflare Workers (Recommended)

**Pros**: Free tier available, easy to deploy, serverless
**Cons**: Requires Cloudflare account

1. **Install Wrangler CLI**:
   ```bash
   npm install -g wrangler
   ```

2. **Login to Cloudflare**:
   ```bash
   wrangler login
   ```

3. **Clone the OAuth worker template**:
   ```bash
   git clone https://github.com/gr2m/cloudflare-worker-github-oauth-login.git
   cd cloudflare-worker-github-oauth-login
   ```

4. **Configure your worker**:
   - Copy `wrangler.toml.example` to `wrangler.toml`
   - Update with your account ID
   - Set your GitHub OAuth App credentials as secrets:
     ```bash
     wrangler secret put GITHUB_CLIENT_ID
     # Enter your Client ID when prompted
     
     wrangler secret put GITHUB_CLIENT_SECRET
     # Enter your Client Secret when prompted
     ```

5. **Deploy**:
   ```bash
   wrangler publish
   ```

6. **Save your worker URL**: Something like `https://your-worker.workers.dev`

### Option B: Netlify Functions

**Pros**: Free tier available, integrates with Netlify hosting
**Cons**: Requires Netlify account

1. Create a new Netlify site
2. Add a function in `netlify/functions/oauth-token.js`:
   ```javascript
   exports.handler = async (event) => {
     if (event.httpMethod !== 'POST') {
       return { statusCode: 405, body: 'Method Not Allowed' };
     }

     const { code, client_id } = JSON.parse(event.body);
     
     const response = await fetch('https://github.com/login/oauth/access_token', {
       method: 'POST',
       headers: {
         'Content-Type': 'application/json',
         'Accept': 'application/json'
       },
       body: JSON.stringify({
         client_id: client_id,
         client_secret: process.env.GITHUB_CLIENT_SECRET,
         code: code
       })
     });

     const data = await response.json();
     return {
       statusCode: 200,
       body: JSON.stringify(data)
     };
   };
   ```

3. Set `GITHUB_CLIENT_SECRET` as an environment variable in Netlify
4. Your proxy URL will be: `https://your-site.netlify.app/.netlify/functions/oauth-token`

### Option C: Self-Hosted with Gatekeeper

**Pros**: Full control, can run on your own infrastructure
**Cons**: Requires server maintenance

1. **Clone Gatekeeper**:
   ```bash
   git clone https://github.com/prose/gatekeeper.git
   cd gatekeeper
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment**:
   ```bash
   export OAUTH_CLIENT_ID=your_client_id
   export OAUTH_CLIENT_SECRET=your_client_secret
   export PORT=9999
   ```

4. **Start the server**:
   ```bash
   node server.js
   ```

5. Deploy to your hosting provider (Heroku, AWS, etc.)

## Step 3: Configure tune-my-repos

1. **Edit `config.js`** in your repository:
   ```javascript
   const CONFIG = {
       GITHUB_TOKEN: '',  // Leave empty for OAuth
       GITHUB_OAUTH_CLIENT_ID: 'your_client_id_here',
       GITHUB_OAUTH_PROXY: 'https://your-worker.workers.dev/api/github/oauth/token'
   };
   ```

2. **Commit and push to GitHub**:
   ```bash
   git add config.js
   git commit -m "Configure GitHub OAuth"
   git push origin main
   ```

3. **GitHub Pages will automatically rebuild** with the new configuration

## Step 4: Test Authentication

1. Visit your GitHub Pages site
2. You should see a **"Sign in with GitHub"** button in the header
3. Click the button to authenticate
4. You'll be redirected to GitHub to authorize the app
5. After authorization, you'll be redirected back to your site
6. Your username should appear in the header
7. Analyze a repository - you should no longer see rate limit errors!

## Troubleshooting

### "OAuth proxy not configured" error

- Make sure `GITHUB_OAUTH_PROXY` is set in `config.js`
- Verify the proxy URL is correct and accessible
- Check that your OAuth proxy is deployed and running

### "OAuth state mismatch" error

- This is a security check to prevent CSRF attacks
- Clear your browser's session storage: `sessionStorage.clear()`
- Try logging in again

### "Failed to exchange OAuth code for token" error

- Check that your OAuth proxy has the correct Client ID and Client Secret
- Verify the proxy is returning the expected JSON format: `{ "access_token": "..." }`
- Check proxy logs for errors

### Still seeing rate limit errors after authentication

- Make sure you see your username in the header after login
- Check the browser console for authentication errors
- Try signing out and signing in again
- Verify your token is valid: check Network tab for 401 errors

### Callback URL mismatch

- The authorization callback URL in your OAuth App settings must exactly match your site URL
- Include trailing slashes if your site uses them
- Make sure you're using HTTPS for GitHub Pages

## Security Considerations

### Token Storage

- OAuth tokens are stored in `sessionStorage` (not `localStorage`)
- Tokens are cleared when the browser tab is closed
- Tokens are never sent to any server except GitHub's API

### Client ID vs Client Secret

- **Client ID**: Public, can be committed to repository
- **Client Secret**: Private, must only be used in OAuth proxy
- Never commit the Client Secret to your repository

### OAuth Scopes

By default, the app requests `public_repo` scope (read-only access to public repositories). You can request additional scopes if needed:

- `repo` - Full access to private repositories
- `read:org` - Read organization data
- `read:user` - Read user profile data

Modify the scope in `auth.js` if you need different permissions.

## Local Development

For local development, you don't need OAuth. Use a Personal Access Token instead:

1. Create a `.env` file:
   ```bash
   cp .env.example .env
   ```

2. Add your token:
   ```
   GITHUB_TOKEN=ghp_your_token_here
   ```

3. Start a local server:
   ```bash
   python -m http.server 8000
   ```

4. Visit `http://localhost:8000`

The local token will be used automatically if OAuth is not configured.

## Alternative: GitHub Actions + Artifacts

If you don't want to set up OAuth, you can run analyses using GitHub Actions:

1. Store your token as a GitHub Secret (`GITHUB_TOKEN`)
2. Run the analysis in a GitHub Actions workflow
3. Export results as artifacts
4. Download and view the results

See the Actions workflow documentation for details.

## FAQ

### Can I use this without OAuth?

Yes, but with limitations:
- Unauthenticated requests: 60 API calls/hour
- No access to private repositories
- Not practical for analyzing organizations with many repositories

### Do I need to pay for the OAuth proxy?

Most proxy services have free tiers:
- Cloudflare Workers: 100,000 requests/day free
- Netlify Functions: 125,000 requests/month free
- You can also self-host for free

### Can multiple users use the same OAuth App?

Yes! Each user authenticates with their own GitHub account and uses their own rate limits.

### How do I revoke access?

1. Go to [GitHub Settings > Applications](https://github.com/settings/applications)
2. Find your OAuth App
3. Click **"Revoke"**

Or simply click "Sign out" in the app - this clears the token from your browser.

## Support

If you encounter issues:

1. Check the browser console for errors
2. Verify your OAuth App settings match your site URL
3. Test your OAuth proxy independently
4. Open an issue on GitHub with:
   - Browser and version
   - Error messages from console
   - Steps to reproduce

## Additional Resources

- [GitHub OAuth Documentation](https://docs.github.com/en/developers/apps/building-oauth-apps/authorizing-oauth-apps)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Netlify Functions Documentation](https://docs.netlify.com/functions/overview/)
- [Gatekeeper OAuth Proxy](https://github.com/prose/gatekeeper)
