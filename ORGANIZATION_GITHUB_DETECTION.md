# Organization-Level Governance File Detection

## Overview

This document describes the implementation of organization-level `.github` repository checking in tune-my-repos. This feature detects governance files that are inherited from an organization's centralized `.github` repository.

## Background

GitHub allows organizations to maintain a special `.github` repository that provides default community health files for all repositories in the organization. Files like `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`, and others placed in this repository are automatically inherited by all repositories that don't have their own versions.

### Examples of Organization `.github` Repositories

- **CHAOSS:** https://github.com/chaoss/.github
- **CivicActions:** https://github.com/civicactions/.github
- **Your Organization:** https://github.com/[YOUR-ORG]/.github

## Implementation Details

### API Endpoints Used

1. **Check if organization has `.github` repository:**
   ```
   GET /repos/{owner}/.github
   ```
   Returns 200 if the `.github` repository exists, 404 otherwise.

2. **Check for specific file in organization `.github`:**
   ```
   GET /repos/{owner}/.github/contents/{filename}
   ```
   Returns 200 if the file exists, 404 otherwise.

### Code Changes

#### 1. Cache for Organization Checks (`analyzer.js`)

```javascript
class GitHubAnalyzer {
    constructor(token = null) {
        this.token = token;
        this.apiBase = 'https://api.github.com';
        // Cache for organization .github repository checks
        this.orgGithubCache = new Map();
    }
}
```

#### 2. Method to Check Organization `.github` Repository

```javascript
async hasOrgGithubRepo(owner) {
    const cacheKey = `${owner}:_has_github_repo`;
    if (this.orgGithubCache.has(cacheKey)) {
        return this.orgGithubCache.get(cacheKey);
    }

    try {
        await this.fetchJSON(`${this.apiBase}/repos/${owner}/.github`);
        this.orgGithubCache.set(cacheKey, true);
        return true;
    } catch (error) {
        this.orgGithubCache.set(cacheKey, false);
        return false;
    }
}
```

#### 3. Method to Check Specific File in Organization Repository

```javascript
async checkOrgGithubFile(owner, filename) {
    const cacheKey = `${owner}:${filename}`;
    if (this.orgGithubCache.has(cacheKey)) {
        return this.orgGithubCache.get(cacheKey);
    }

    try {
        await this.fetchJSON(`${this.apiBase}/repos/${owner}/.github/contents/${filename}`);
        this.orgGithubCache.set(cacheKey, true);
        return true;
    } catch (error) {
        this.orgGithubCache.set(cacheKey, false);
        return false;
    }
}
```

#### 4. Updated Analysis Flow

```javascript
async analyzeRepository(owner, repo, progressCallback = null) {
    // ... existing code ...
    
    // Check if owner has an organization .github repository
    if (progressCallback) progressCallback('Checking for organization-level governance files...');
    const hasOrgGithub = await this.hasOrgGithubRepo(owner);
    
    // ... existing code ...
    
    // Pass org info to governance check
    await this.checkGovernanceFiles(files, result, owner, hasOrgGithub);
}
```

#### 5. Updated Governance File Checking

```javascript
async checkGovernanceFiles(files, result, owner, hasOrgGithub) {
    // ... governance files definition ...
    
    for (const [filename, config] of Object.entries(governanceFiles)) {
        const foundInRepo = variations.some(v => files.has(v));
        
        // Check if file exists in organization .github repository
        let foundInOrgGithub = false;
        if (!foundInRepo && hasOrgGithub) {
            foundInOrgGithub = await this.checkOrgGithubFile(owner, filename);
        }
        
        if (!foundInRepo && !foundInOrgGithub) {
            // Flag as missing
            result.findings.push({...});
        } else if (foundInOrgGithub) {
            // File is inherited from organization
            result.limitations.push(
                `${filename} inherited from organization-level https://github.com/${owner}/.github`
            );
        }
    }
}
```

## Benefits

1. **Accurate Analysis:** Prevents false positives for repositories that inherit governance files from their organization.

2. **Performance Optimization:** Caching prevents redundant API calls when analyzing multiple repositories from the same organization.

3. **Transparency:** Results clearly indicate which files are inherited from the organization level.

4. **Alignment with GitHub:** Follows GitHub's built-in community health file inheritance feature.

## Testing

### Test Scenarios

1. **Organization with `.github` repository:**
   - Example: `chaoss/community`
   - Should detect inherited `CODE_OF_CONDUCT.md` from `chaoss/.github`
   - Should not flag inherited files as missing

2. **Organization without `.github` repository:**
   - Should check and handle gracefully when `.github` repo doesn't exist
   - Should flag governance files as missing normally

3. **Individual user repositories:**
   - Should check but find no organization `.github` (users typically don't have this)
   - Should flag governance files as missing normally

4. **Batch analysis:**
   - When analyzing multiple repos from same org
   - Should use cached results for organization checks
   - Should improve performance significantly

### Validation

Run the validation script to ensure implementation correctness:

```bash
node /tmp/validate-implementation.js
```

Expected output: All 10 validation tests should pass.

## API Rate Limit Considerations

- Each organization check requires 1 API call to check if `.github` repo exists
- Each file check requires 1 API call to check if the file exists in `.github`
- Caching ensures these calls are made only once per organization per session
- For batch analysis of N repos from same org: ~8 API calls (1 for repo + 7 for governance files)
- Without caching: Would require ~8N API calls

## Limitations

1. The feature checks for files in the root of the `.github` repository, not in subdirectories.
2. Does not check for template files in `.github/ISSUE_TEMPLATE/` at the organization level.
3. Requires network access to GitHub API - cannot be tested fully in blocked environments.

## Future Enhancements

1. Check for issue and PR templates in organization `.github` repository
2. Support for `.github/profile/README.md` organization profile detection
3. Display organization-level files alongside repository analysis results
4. Add organization governance score in batch analysis summaries

## References

- [GitHub Community Health Files Documentation](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file)
- [Issue #X: Look for where these are defined for the organization](https://github.com/mgifford/tune-my-repos/issues/X)
- CHAOSS `.github` repository: https://github.com/chaoss/.github
- CivicActions `.github` repository: https://github.com/civicactions/.github
