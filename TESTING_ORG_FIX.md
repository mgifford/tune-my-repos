# Testing Organization Repository Fetching

## Overview

This document describes how to test the organization repository fetching fix that ensures all repositories from an organization are properly fetched and displayed.

## What Was Fixed

**Problem:** Organizations like CivicActions were not showing all repositories (e.g., only showing a few repos instead of all 25).

**Root Cause:** The app was using `/users/:username/repos` endpoint for both users and organizations. This endpoint doesn't return all organization repositories.

**Solution:** The app now:
1. Detects whether the target is an organization or a user
2. Uses the appropriate GitHub API endpoint:
   - `/orgs/:org/repos` for organizations
   - `/users/:username/repos` for users

## Testing Steps

### 1. Local Testing (Recommended)

#### Setup
```bash
# Start the local server
cd /home/runner/work/tune-my-repos/tune-my-repos
python3 -m http.server 8000

# Open in browser
# http://localhost:8000
```

#### Test Case 1: Organization (CivicActions)
1. Navigate to: `http://localhost:8000/?u=civicactions`
2. Click "Analyze Repositories"
3. **Expected Result:** Should fetch all 25+ repositories
4. Check browser console for: `Detected organization: civicactions, using /orgs endpoint`

#### Test Case 2: User Account
1. Clear the input field
2. Enter: `mgifford`
3. Click "Analyze Repositories"
4. **Expected Result:** Should fetch all user repositories
5. Check browser console for: `Detected user: mgifford, using /users endpoint`

#### Test Case 3: Another Organization (CHAOSS)
1. Clear the input field
2. Enter: `chaoss`
3. Click "Analyze Repositories"
4. **Expected Result:** Should fetch all CHAOSS repositories
5. Check browser console for: `Detected organization: chaoss, using /orgs endpoint`

### 2. GitHub Pages Testing (Production)

Once deployed to GitHub Pages:

#### Test URLs
- https://mgifford.github.io/tune-my-repos/?u=civicactions
- https://mgifford.github.io/tune-my-repos/?u=mgifford
- https://mgifford.github.io/tune-my-repos/?u=chaoss

#### Verification
1. Count total repositories shown
2. Compare with https://github.com/orgs/CivicActions/repositories
3. All public repositories should be listed

### 3. Verifying the Fix in Browser Console

Open browser developer tools (F12) and check console logs:

```
Detected organization: civicactions, using /orgs endpoint
Fetched page 1: 25 repos (total so far: 25)
Fetched all repositories: 25 total
Fetched 25 repositories, filtering and analyzing...
```

For a user account:
```
Detected user: mgifford, using /users endpoint
Fetched page 1: 23 repos (total so far: 23)
Fetched all repositories: 23 total
Fetched 23 repositories, filtering and analyzing...
```

### 4. API Endpoint Verification

You can manually verify the difference between endpoints:

#### Organization endpoint (returns all public repos):
```bash
curl -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/orgs/civicactions/repos?per_page=5
```

#### User endpoint (may not return all org repos):
```bash
curl -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/users/civicactions/repos?per_page=5
```

The organization endpoint should return more/different repositories.

## Expected Behavior

### For Organizations
- ✅ All public organization repositories are fetched
- ✅ Console log shows: `Detected organization: {name}, using /orgs endpoint`
- ✅ Pagination works correctly for organizations with >100 repos
- ✅ Fork filtering works (if checkbox is checked)

### For User Accounts
- ✅ All user repositories are fetched
- ✅ Console log shows: `Detected user: {name}, using /users endpoint`
- ✅ Backward compatible with existing functionality
- ✅ No breaking changes

### Error Handling
- ✅ If account type detection fails, falls back to `/users` endpoint
- ✅ Console warning displayed on fallback
- ✅ Analysis continues without interruption

## Known Limitations

1. **Private Repositories:** 
   - Requires authentication with appropriate scopes
   - Organization repos may require organization membership

2. **Rate Limiting:**
   - Unauthenticated: 60 requests/hour
   - Authenticated: 5,000 requests/hour
   - Account type detection adds 1 extra API call per analysis

3. **Network Issues:**
   - Fallback to `/users` endpoint if detection fails
   - May result in incomplete results for organizations

## Troubleshooting

### Issue: "Error checking account type"
**Solution:** Check network connection. The app will fall back to `/users` endpoint.

### Issue: Not all repos showing for organization
**Possible Causes:**
1. Check console logs - should see "Detected organization"
2. Verify organization name is correct
3. Check if authentication is configured
4. Some repos might be private

### Issue: "Failed to fetch repositories"
**Solution:** See FIXES.md troubleshooting section for common API errors.

## Testing Checklist

- [ ] CivicActions organization shows all 25+ repositories
- [ ] User accounts (e.g., mgifford) work correctly
- [ ] Console logs show correct endpoint detection
- [ ] Error handling works (fallback to /users endpoint)
- [ ] Pagination works for organizations with >100 repos
- [ ] Fork filtering checkbox still works
- [ ] Cache still works correctly
- [ ] Export functionality (JSON, Markdown) works

## Performance Impact

- **Additional API Call:** +1 call per user/org analysis (to detect account type)
- **Impact:** Minimal (~1 second for account detection)
- **Benefit:** Ensures complete data for organizations

## Verification Commands

### Check if a target is an organization:
```bash
curl https://api.github.com/users/civicactions | jq '.type'
# Output: "Organization"
```

### Count organization repositories:
```bash
curl https://api.github.com/orgs/civicactions/repos?per_page=100 | jq 'length'
# Output: 25 (or current count)
```

### Compare endpoints:
```bash
# Organization endpoint
curl -s https://api.github.com/orgs/civicactions/repos | jq 'length'

# User endpoint (may return different/fewer results)
curl -s https://api.github.com/users/civicactions/repos | jq 'length'
```

## Success Criteria

The fix is successful when:

1. ✅ CivicActions shows all 25+ repositories (was showing fewer before)
2. ✅ Console logs confirm correct endpoint usage
3. ✅ No regression in user account analysis
4. ✅ Error handling maintains functionality even if detection fails
5. ✅ All existing features still work (caching, export, filtering)

## Additional Test Cases

### Edge Cases
1. **Non-existent account:** Should show appropriate error
2. **Private organization:** Requires authentication
3. **Very large organization (>100 repos):** Test pagination
4. **Organization with no repositories:** Should handle gracefully

### Integration Tests
1. Test with cache enabled/disabled
2. Test with "Skip forks" checkbox
3. Test with "Force refresh" option
4. Test export after organization analysis

## Related Files

- `app.js` - Lines 269-298: Organization detection logic
- `FIXES.md` - Documentation of the fix
- `README.md` - Usage examples

## References

- [GitHub API: List organization repositories](https://docs.github.com/en/rest/repos/repos#list-organization-repositories)
- [GitHub API: List repositories for a user](https://docs.github.com/en/rest/repos/repos#list-repositories-for-a-user)
- [GitHub API: Get a user](https://docs.github.com/en/rest/users/users#get-a-user)
