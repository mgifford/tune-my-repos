# Deployment Checklist for GitHub Pages OAuth

This checklist helps you deploy OAuth authentication for your GitHub Pages site.

## Prerequisites

- [ ] Repository is hosted on GitHub
- [ ] GitHub Pages is enabled (Settings → Pages → Source: main branch)
- [ ] Site is accessible at https://yourusername.github.io/tune-my-repos/

## Step 1: Create GitHub OAuth App (5 minutes)

- [ ] Go to https://github.com/settings/developers
- [ ] Click "OAuth Apps" → "New OAuth App"
- [ ] Fill in:
  - [ ] Application name: `tune-my-repos` (or your choice)
  - [ ] Homepage URL: `https://yourusername.github.io/tune-my-repos/`
  - [ ] Callback URL: Same as homepage URL
- [ ] Click "Register application"
- [ ] **Save Client ID** (you'll commit this)
- [ ] **Save Client Secret** (keep this private!)

## Step 2: Deploy OAuth Proxy (15-20 minutes)

Choose ONE option:

### Option A: Cloudflare Workers (Recommended - Free)

- [ ] Sign up at https://workers.cloudflare.com/ (free tier)
- [ ] Install Wrangler: `npm install -g wrangler`
- [ ] Login: `wrangler login`
- [ ] Clone template: `git clone https://github.com/gr2m/cloudflare-worker-github-oauth-login.git`
- [ ] Configure secrets:
  ```bash
  wrangler secret put GITHUB_CLIENT_ID      # Enter your Client ID
  wrangler secret put GITHUB_CLIENT_SECRET   # Enter your Client Secret
  ```
- [ ] Deploy: `wrangler publish`
- [ ] **Save Worker URL** (e.g., `https://your-worker.workers.dev`)

### Option B: Netlify Functions (Free)

- [ ] Sign up at https://netlify.com/ (free tier)
- [ ] Create new site from repository
- [ ] Add function (see GITHUB_PAGES_SETUP.md for code)
- [ ] Set environment variable: `GITHUB_CLIENT_SECRET`
- [ ] Deploy
- [ ] **Save Function URL** (e.g., `https://your-site.netlify.app/.netlify/functions/oauth-token`)

### Option C: Self-Hosted (Gatekeeper)

- [ ] Clone: `git clone https://github.com/prose/gatekeeper.git`
- [ ] Install: `npm install`
- [ ] Set environment variables: `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `PORT`
- [ ] Deploy to your hosting provider (Heroku, AWS, etc.)
- [ ] **Save Server URL**

## Step 3: Configure Repository (2 minutes)

- [ ] Edit `config.js` in your repository:
  ```javascript
  const CONFIG = {
      GITHUB_TOKEN: '',  // Leave empty
      GITHUB_OAUTH_CLIENT_ID: 'your_client_id_here',          // Paste Client ID
      GITHUB_OAUTH_PROXY: 'https://your-proxy-url.com/token'  // Paste Proxy URL
  };
  ```
- [ ] Commit changes: `git add config.js && git commit -m "Configure OAuth"`
- [ ] Push: `git push origin main`

## Step 4: Wait for GitHub Pages Build (1-2 minutes)

- [ ] Go to repository → Actions
- [ ] Wait for "pages build and deployment" to complete (green checkmark)
- [ ] Or go to Settings → Pages to see deployment status

## Step 5: Test Authentication (2 minutes)

- [ ] Visit your GitHub Pages site
- [ ] Look for "Sign in with GitHub" button in header
- [ ] Click the button
- [ ] Authorize the app on GitHub
- [ ] You should be redirected back and see your username
- [ ] Try analyzing a repository - should work without rate limit errors!

## Troubleshooting

### Sign in button shows alert about OAuth not configured

- **Cause:** `config.js` changes not deployed yet
- **Fix:** Wait for GitHub Pages build, then hard refresh (Ctrl+Shift+R)

### "OAuth proxy not configured" error

- **Cause:** `GITHUB_OAUTH_PROXY` is empty or incorrect
- **Fix:** Double-check proxy URL in `config.js`, ensure it includes full path

### "Failed to exchange code for token"

- **Cause:** Proxy not working or Client Secret incorrect
- **Fix:** 
  - Test proxy independently
  - Verify Client Secret in proxy configuration
  - Check proxy logs for errors

### Still seeing rate limit errors after login

- **Cause:** Token not being used
- **Fix:**
  - Check browser console for errors
  - Verify you see your username in header
  - Sign out and sign in again

### Callback URL mismatch error

- **Cause:** OAuth App callback URL doesn't match site URL
- **Fix:** Update OAuth App settings to exactly match your GitHub Pages URL (including trailing slash)

## Verification Checklist

After deployment, verify:

- [ ] ✅ Sign in button appears in header
- [ ] ✅ Clicking Sign in redirects to GitHub
- [ ] ✅ After authorization, username appears in header
- [ ] ✅ Can analyze repositories without rate limit errors
- [ ] ✅ Sign out button works (reloads page, removes username)
- [ ] ✅ Authentication persists across page refreshes (same session)
- [ ] ✅ Authentication clears when browser tab closes

## Security Checklist

- [ ] ✅ Client Secret is only in OAuth proxy (not in repository)
- [ ] ✅ `config.js` only contains Client ID (public value)
- [ ] ✅ OAuth proxy uses HTTPS
- [ ] ✅ Tokens stored in sessionStorage (not localStorage)
- [ ] ✅ OAuth App has minimal scopes (`public_repo` only)

## Maintenance

### Rotating OAuth App Credentials

If you need to rotate credentials:

1. Create new Client Secret in OAuth App settings
2. Update proxy with new Client Secret
3. No repository changes needed (Client ID stays same)

### Monitoring Usage

- Cloudflare: Workers dashboard shows request metrics
- Netlify: Functions tab shows invocation count
- GitHub: OAuth App settings show authorization count

### Cost Monitoring

All recommended options have free tiers:
- Cloudflare: 100,000 requests/day free
- Netlify: 125,000 requests/month free
- Monitor usage to avoid unexpected charges

## Getting Help

If you encounter issues:

1. Check browser console for JavaScript errors
2. Review [GITHUB_PAGES_SETUP.md](GITHUB_PAGES_SETUP.md) troubleshooting section
3. Test OAuth proxy independently (curl test)
4. Open GitHub issue with:
   - Error messages
   - Browser console logs
   - Steps to reproduce

## Success Criteria

✅ You're done when:
- Users can click "Sign in with GitHub"
- Users see their username after signing in
- Users can analyze organizations (e.g., "civicactions") without rate limit errors
- No JavaScript errors in browser console

🎉 **Congratulations!** Your GitHub Pages site now has OAuth authentication!

## Optional Enhancements

Consider these optional improvements:

- [ ] Add loading spinner during OAuth redirect
- [ ] Show rate limit remaining in UI
- [ ] Add logout confirmation dialog
- [ ] Track analytics for sign-in usage
- [ ] Add user avatar next to username
- [ ] Remember last analyzed repository
