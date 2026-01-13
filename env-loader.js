/**
 * Simple .env file loader for browser-based apps
 * Attempts to load GITHUB_TOKEN from .env file if present
 */

// Make sure CONFIG exists
if (typeof CONFIG === 'undefined') {
    window.CONFIG = { GITHUB_TOKEN: '' };
}

(async function loadEnv() {
    try {
        const response = await fetch('.env');
        if (response.ok) {
            const text = await response.text();
            const lines = text.split('\n');
            
            for (const line of lines) {
                // Skip comments and empty lines
                if (!line || line.trim().startsWith('#')) continue;
                
                // Parse KEY=value format
                const match = line.match(/^([^=]+)=(.*)$/);
                if (match) {
                    const key = match[1].trim();
                    const value = match[2].trim();
                    
                    // Only load GITHUB_TOKEN from .env
                    if (key === 'GITHUB_TOKEN' && value && value !== 'your_token_here') {
                        // Override CONFIG token
                        window.CONFIG.GITHUB_TOKEN = value;
                        console.log('✓ Loaded GitHub token from .env file');
                        console.log('Token starts with:', value.substring(0, 4) + '...');
                    }
                }
            }
        }
    } catch (error) {
        // .env file doesn't exist or couldn't be loaded - that's OK
        // Fall back to config.js
        console.log('No .env file found, using config.js');
    }
})();
