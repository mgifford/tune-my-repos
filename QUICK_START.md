# Quick Start: Resolving Rate Limit Errors

## Problem

When using https://mgifford.github.io/tune-my-repos/ (or any GitHub Pages deployment), you may see this error:

```
⚠️ Error
Analysis failed: API rate limit exceeded for [IP]. (But here's the good news: 
Authenticated requests get a higher rate limit. Check out the documentation for more details.)
```

This happens because unauthenticated requests to GitHub's API are limited to **60 requests per hour** per IP address.

## Solution

There are two solutions depending on how you're using the tool:

### Option 1: For GitHub Pages Users (Recommended)

**Enable OAuth authentication** so users can sign in with their GitHub accounts.

✅ **Benefits:**
- Each user gets their own 5,000 requests/hour rate limit
- No shared credentials needed
- Works on any static hosting (GitHub Pages, Netlify, Vercel, etc.)

📖 **Setup Instructions:**
See [GITHUB_PAGES_SETUP.md](GITHUB_PAGES_SETUP.md) for complete step-by-step guide.

**Quick Summary:**
1. Create a GitHub OAuth App
2. Deploy an OAuth proxy (Cloudflare Workers, Netlify Functions, or self-hosted)
3. Configure OAuth settings in `config.js`
4. Commit and deploy

⏱️ **Setup Time:** ~20-30 minutes for first-time setup

### Option 2: For Local Development

**Use a Personal Access Token** in a local `.env` file.

✅ **Benefits:**
- Simple and fast
- No OAuth setup needed
- Good for local testing and development

📖 **Setup Instructions:**

1. **Create a token:**
   - Go to https://github.com/settings/tokens
   - Click "Generate new token (classic)"
   - Select scope: `public_repo`
   - Copy the token

2. **Configure locally:**
   ```bash
   cp .env.example .env
   # Edit .env and paste your token
   ```

3. **Start local server:**
   ```bash
   python -m http.server 8000
   # Visit http://localhost:8000
   ```

⏱️ **Setup Time:** ~5 minutes

## Comparison

| Method | Rate Limit | Setup Time | Best For |
|--------|-----------|------------|----------|
| **Unauthenticated** | 60/hour | 0 min | Quick tests only |
| **Personal Token (local)** | 5,000/hour | 5 min | Local development |
| **OAuth (GitHub Pages)** | 5,000/hour per user | 20-30 min | Production deployment |

## What's New in This Release

This release adds **OAuth authentication support** to solve rate limit issues on GitHub Pages:

### New Features

1. **"Sign in with GitHub" button** in the header
2. **Automatic token management** (uses OAuth token when available, falls back to local token)
3. **User-friendly messaging** about rate limits and authentication status
4. **Session-based security** (tokens cleared when browser closes)

### Files Added

- `auth.js` - OAuth authentication module
- `GITHUB_PAGES_SETUP.md` - Complete OAuth setup guide
- `QUICK_START.md` - This file

### Files Modified

- `index.html` - Added OAuth UI (Sign in/Sign out buttons)
- `app.js` - Integrated OAuth token management
- `styles.css` - Styled authentication UI
- `config.js` / `config.example.js` - Added OAuth configuration options
- `README.md` - Updated with OAuth information

## Need Help?

1. **For GitHub Pages deployment:** Follow [GITHUB_PAGES_SETUP.md](GITHUB_PAGES_SETUP.md)
2. **For local development:** Follow [SETUP.md](SETUP.md)
3. **For troubleshooting:** Check the [Troubleshooting section](GITHUB_PAGES_SETUP.md#troubleshooting) in GITHUB_PAGES_SETUP.md

## FAQ

### Q: Do I need OAuth for local development?

**A:** No! For local development, just use a Personal Access Token in `.env` file. OAuth is only needed for GitHub Pages deployment.

### Q: Is OAuth setup required now?

**A:** No, it's optional but recommended for GitHub Pages. The tool still works without authentication, but with only 60 requests/hour.

### Q: Can I still use a Personal Access Token?

**A:** Yes! Personal tokens still work for local development. OAuth is an additional option for GitHub Pages deployment.

### Q: Is this secure?

**A:** Yes! OAuth tokens are stored in sessionStorage (cleared when browser closes), and only your OAuth proxy has access to the Client Secret. See the [Security section](GITHUB_PAGES_SETUP.md#security-considerations) for details.

### Q: How much does the OAuth proxy cost?

**A:** Most providers have generous free tiers:
- Cloudflare Workers: 100,000 requests/day free
- Netlify Functions: 125,000 requests/month free
- Self-hosted: Free if you have your own server

### Q: What if I don't want to set up OAuth?

**A:** You have three options:
1. Use the tool with unauthenticated access (60 requests/hour limit)
2. Run it locally with a Personal Access Token (5,000 requests/hour)
3. Use GitHub Actions to run analysis with a repository secret

Choose the option that best fits your needs!
