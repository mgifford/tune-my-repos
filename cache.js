/**
 * Cache module for repository analysis results
 * Stores results in localStorage with 1-hour TTL
 */

class AnalysisCache {
    constructor(ttlMinutes = 60) {
        this.ttl = ttlMinutes * 60 * 1000; // Convert to milliseconds
        this.storagePrefix = 'tune-my-repos-cache-';
        this.statsKey = 'tune-my-repos-cache-stats';
    }

    /**
     * Generate a cache key based on target and options
     */
    generateKey(target, skipForks) {
        const normalizedTarget = target.trim().toLowerCase();
        const key = `${this.storagePrefix}${normalizedTarget}-skipForks:${skipForks}`;
        return key;
    }

    /**
     * Store analysis results in cache
     */
    set(target, skipForks, results, analysisStats = null) {
        try {
            const key = this.generateKey(target, skipForks);
            const cacheEntry = {
                timestamp: Date.now(),
                target: target,
                skipForks: skipForks,
                results: results,
                analysisStats: analysisStats
            };
            
            localStorage.setItem(key, JSON.stringify(cacheEntry));
            this.updateStats('set');
            
            console.log(`Cached results for ${target} (skipForks: ${skipForks})`);
            return true;
        } catch (error) {
            console.error('Failed to cache results:', error);
            // localStorage might be full or disabled
            return false;
        }
    }

    /**
     * Retrieve analysis results from cache
     * Returns null if not found or expired
     */
    get(target, skipForks) {
        try {
            const key = this.generateKey(target, skipForks);
            const cached = localStorage.getItem(key);
            
            if (!cached) {
                return null;
            }

            const cacheEntry = JSON.parse(cached);
            const age = Date.now() - cacheEntry.timestamp;

            // Check if cache has expired
            if (age > this.ttl) {
                console.log(`Cache expired for ${target} (age: ${Math.round(age / 1000 / 60)} minutes)`);
                this.delete(target, skipForks);
                return null;
            }

            console.log(`Cache hit for ${target} (age: ${Math.round(age / 1000 / 60)} minutes)`);
            this.updateStats('hit');
            return {
                results: cacheEntry.results,
                analysisStats: cacheEntry.analysisStats || null,
                age: age,
                timestamp: cacheEntry.timestamp
            };
        } catch (error) {
            console.error('Failed to retrieve from cache:', error);
            return null;
        }
    }

    /**
     * Delete a specific cache entry
     */
    delete(target, skipForks) {
        try {
            const key = this.generateKey(target, skipForks);
            localStorage.removeItem(key);
            console.log(`Removed cache for ${target}`);
            return true;
        } catch (error) {
            console.error('Failed to delete cache entry:', error);
            return false;
        }
    }

    /**
     * Clear all cached results
     */
    clearAll() {
        try {
            const keys = Object.keys(localStorage);
            let cleared = 0;
            
            keys.forEach(key => {
                if (key.startsWith(this.storagePrefix)) {
                    localStorage.removeItem(key);
                    cleared++;
                }
            });
            
            // Reset stats
            localStorage.removeItem(this.statsKey);
            
            console.log(`Cleared ${cleared} cache entries`);
            return cleared;
        } catch (error) {
            console.error('Failed to clear cache:', error);
            return 0;
        }
    }

    /**
     * Clean up expired cache entries
     */
    cleanupExpired() {
        try {
            const keys = Object.keys(localStorage);
            let cleaned = 0;
            
            keys.forEach(key => {
                if (key.startsWith(this.storagePrefix)) {
                    try {
                        const cached = localStorage.getItem(key);
                        const cacheEntry = JSON.parse(cached);
                        const age = Date.now() - cacheEntry.timestamp;
                        
                        if (age > this.ttl) {
                            localStorage.removeItem(key);
                            cleaned++;
                        }
                    } catch (e) {
                        // Invalid cache entry, remove it
                        localStorage.removeItem(key);
                        cleaned++;
                    }
                }
            });
            
            if (cleaned > 0) {
                console.log(`Cleaned up ${cleaned} expired cache entries`);
            }
            return cleaned;
        } catch (error) {
            console.error('Failed to cleanup cache:', error);
            return 0;
        }
    }

    /**
     * Get cache statistics
     */
    getStats() {
        try {
            const statsStr = localStorage.getItem(this.statsKey);
            if (!statsStr) {
                return { hits: 0, sets: 0, size: 0 };
            }
            return JSON.parse(statsStr);
        } catch (error) {
            return { hits: 0, sets: 0, size: 0 };
        }
    }

    /**
     * Update cache statistics
     */
    updateStats(operation) {
        try {
            const stats = this.getStats();
            
            if (operation === 'hit') {
                stats.hits = (stats.hits || 0) + 1;
            } else if (operation === 'set') {
                stats.sets = (stats.sets || 0) + 1;
            }
            
            // Calculate current cache size
            const keys = Object.keys(localStorage);
            stats.size = keys.filter(k => k.startsWith(this.storagePrefix)).length;
            
            localStorage.setItem(this.statsKey, JSON.stringify(stats));
        } catch (error) {
            // Silently fail for stats
        }
    }

    /**
     * Get information about all cached entries
     */
    listCached() {
        try {
            const keys = Object.keys(localStorage);
            const entries = [];
            
            keys.forEach(key => {
                if (key.startsWith(this.storagePrefix)) {
                    try {
                        const cached = localStorage.getItem(key);
                        const cacheEntry = JSON.parse(cached);
                        const age = Date.now() - cacheEntry.timestamp;
                        const expired = age > this.ttl;
                        
                        entries.push({
                            target: cacheEntry.target,
                            skipForks: cacheEntry.skipForks,
                            timestamp: cacheEntry.timestamp,
                            age: age,
                            ageMinutes: Math.round(age / 1000 / 60),
                            expired: expired,
                            resultCount: cacheEntry.results?.length || 0
                        });
                    } catch (e) {
                        // Skip invalid entries
                    }
                }
            });
            
            return entries;
        } catch (error) {
            console.error('Failed to list cache:', error);
            return [];
        }
    }
}

// Create a global instance
window.analysisCache = new AnalysisCache(60); // 60 minutes TTL

// Cleanup expired entries on load
window.addEventListener('DOMContentLoaded', () => {
    if (window.analysisCache) {
        window.analysisCache.cleanupExpired();
    }
});
