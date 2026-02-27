# Quick Setup Guide

## Adding a GitHub Personal Access Token

For better performance and private repository access, configure a GitHub Personal Access Token:

### Step 1: Create a Token

1. Go to [GitHub Personal Access Tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
2. Click **"Generate new token"** → **"Generate new token (classic)"**
3. Give it a descriptive name (e.g., "tune-my-repos")
4. Select scopes:
   - ✅ `public_repo` - Access public repositories
   - ✅ `repo` (optional) - Access private repositories
5. Click **"Generate token"**
6. **Copy the token immediately** (you won't see it again!)

### Step 2: Configure the Token

**Option 1: .env file (Recommended for localhost)**
```bash
cp .env.example .env
# Edit .env and paste your token
```

**Option 2: config.js file (Use for custom dev setups)**
```bash
cp config.example.js config.js
# Edit config.js and paste your token
```

> **Note:** `.env` only works on localhost or file://. For Docker, VMs, or .local domains, use config.js instead.

### Step 3: Verify

1. Refresh your browser at http://localhost:8000
2. You should see **no rate limit warning**
3. Console should show: `✓ Loaded GitHub token from .env file`

**Note:** The `.env` file is only loaded in development environments (localhost or file://). In production deployments like GitHub Pages, the app will skip `.env` loading and rely on OAuth authentication or the token configured in `config.js`.

## Rate Limits

| Authentication | Rate Limit | Use Case |
|----------------|------------|----------|
| None | 60 requests/hour | Quick tests, public repos only |
| Token | 5,000 requests/hour | Production use, private repos |

## Security Notes

- ✅ `.env` and `config.js` are in `.gitignore`
- ✅ Never commit tokens to version control
- ✅ Tokens are only stored locally
- ✅ Tokens are only sent to GitHub's API
- ⚠️ Treat tokens like passwords
- 🔄 Rotate tokens regularly

## Troubleshooting

**Token not loading?**
- Hard refresh browser: `Cmd + Shift + R` (Mac) or `Ctrl + Shift + R` (Windows)
- Check browser console for errors
- Verify `.env` or `config.js` exists and has your token

**Still seeing rate limit warnings?**
- Make sure token starts with `ghp_` (classic token)
- Verify no extra spaces in `.env` file
- Check console for "Loaded GitHub token" message
