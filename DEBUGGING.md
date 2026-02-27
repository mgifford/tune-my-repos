# Debugging Guide for Tune My Repos

This guide explains the debugging features available in Tune My Repos to help troubleshoot issues when analyzing repositories.

## Debug Mode

### Enabling Debug Mode

There are two ways to enable debug mode:

1. **Keyboard Shortcut** (Recommended)
   - Press `Ctrl+Shift+D` while on the application page
   - You'll see a console message confirming debug mode is enabled/disabled
   - This setting persists across page reloads

2. **Console Command**
   - Open the browser console (F12)
   - Type: `localStorage.setItem('tune-my-repos-debug', 'true')`
   - Reload the page

### What Debug Mode Does

When debug mode is enabled, you'll see detailed logging in the browser console for:

- **App initialization**: What happens when the page loads
- **Analysis workflow**: Each step of the analysis process
- **API calls**: Every GitHub API request with URL and response status
- **Cache operations**: When cache is checked, hit, or missed
- **Repository analysis**: Detailed progress for each repository being analyzed
- **Error traces**: Full error stack traces when errors occur

### Debug Log Format

Debug logs are prefixed with tags for easy filtering:

- `[DEBUG]` - General debug information from app.js
- `[ANALYZER]` - Debug information from the analyzer module
- `[ERROR]` - Error messages with context

## Error Handling Improvements

### Enhanced Error Messages

The application now provides more helpful error messages:

1. **Main Error**: Clear description of what went wrong
2. **Additional Context**: Tips based on the error type
3. **Debug Instructions**: How to get more detailed information

Example error messages include:

- **404 Errors**: "Make sure the repository or user/organization exists and is accessible"
- **403/Rate Limit Errors**: "Try authenticating or wait for the limit to reset"
- **Network Errors**: "Check your internet connection or make sure you're using an HTTP server"

### Console Logging

Even without debug mode, the application logs important events:

- Token status (present/absent)
- Account type detection (user vs organization)
- Repository fetch progress
- Analysis success/failure summary
- Individual repository analysis errors

## Common Issues and Debugging Steps

### Issue: "Analyzing repository..." keeps spinning

**Debugging steps:**

1. Enable debug mode: Press `Ctrl+Shift+D`
2. Open browser console: Press `F12`
3. Try the analysis again
4. Look for:
   - The last debug message before it stalls
   - Any error messages in red
   - Network errors in the Network tab

**Common causes:**
- Network connectivity issues
- GitHub API rate limits exceeded
- Invalid repository name or access denied
- CORS issues when running from `file://` protocol

### Issue: "All repositories analyses failed"

**Debugging steps:**

1. Enable debug mode
2. Check console for error patterns
3. Look for:
   - Authentication issues (401/403 errors)
   - Rate limiting (403 with rate limit message)
   - Network failures

### Issue: No error message shown, but analysis doesn't start

**Debugging steps:**

1. Open browser console
2. Look for JavaScript errors
3. Check if all scripts loaded correctly in Network tab
4. Verify config.js exists and is valid JavaScript

## GitHub API Rate Limits

Without authentication:
- 60 requests per hour

With authentication:
- 5,000 requests per hour

**To check your current rate limit:**

```javascript
// In browser console:
fetch('https://api.github.com/rate_limit', {
  headers: { 'Authorization': 'token YOUR_TOKEN' }
}).then(r => r.json()).then(console.log)
```

## Helpful Browser Console Commands

### Check if debug mode is enabled
```javascript
localStorage.getItem('tune-my-repos-debug')
```

### Enable debug mode
```javascript
localStorage.setItem('tune-my-repos-debug', 'true')
```

### Disable debug mode
```javascript
localStorage.setItem('tune-my-repos-debug', 'false')
// or
localStorage.removeItem('tune-my-repos-debug')
```

### Clear cache
```javascript
localStorage.clear()
```

### Check current cache
```javascript
Object.keys(localStorage).filter(k => k.startsWith('tune-my-repos'))
```

## Reporting Issues

When reporting issues, please include:

1. **Error message** shown in the UI (if any)
2. **Console logs** with debug mode enabled
3. **Steps to reproduce** the issue
4. **Repository URL** you were trying to analyze (if specific to one repo)
5. **Browser and version** you're using
6. **Authentication status** (authenticated or not)

### Collecting Logs

With debug mode enabled:

1. Open the console (F12)
2. Right-click in the console
3. Select "Save as..." to save the entire log
4. Attach to your issue report

## Technical Details

### Debug Mode Implementation

Debug mode is implemented using:

- `debugLog()` function that checks `localStorage` before logging
- `errorLog()` function that always logs errors with stack traces
- Keyboard event listener for `Ctrl+Shift+D` toggle
- Persistent storage in `localStorage`

### Error Propagation

The error handling flow:

1. `analyzer.fetchJSON()` catches network and API errors
2. `analyzer.analyzeRepository()` catches analysis errors
3. `handleAnalyze()` catches top-level errors
4. `showError()` displays errors to the user with helpful context

### Logging Hierarchy

```
app.js (main application)
  ├── debugLog() - Debug messages
  ├── errorLog() - Error messages
  └── console.log() - Always-on logs

analyzer.js (analysis engine)
  ├── this.debugLog() - Analysis debug messages
  └── console.error() - Analysis errors
```

## Performance Considerations

Debug mode adds minimal overhead:

- Log statements are guarded by a conditional check
- Only strings are logged (no expensive object serialization unless debug is enabled)
- No impact on API calls or analysis logic
- Logs can be cleared from console without reloading page

## Privacy and Security

Debug mode logs may contain:
- Repository names and URLs
- API endpoint URLs
- Response status codes
- Error messages

Debug mode does NOT log:
- Authentication tokens (only first 4 characters shown)
- File contents
- Personal information
- Sensitive GitHub API responses

Always review logs before sharing publicly to ensure no sensitive information is included.
