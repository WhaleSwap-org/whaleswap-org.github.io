import { createLogger } from './LogService.js';
import { TOKEN_ICON_CONFIG } from '../config/index.js';

// Simple ethers-like utilities for address validation
const ethers = {
    utils: {
        isAddress: (address) => {
            return /^0x[a-fA-F0-9]{40}$/.test(address);
        }
    }
};

// Initialize logger
const logger = createLogger('TOKEN_ICON_SERVICE');
const debug = logger.debug.bind(logger);
const error = logger.error.bind(logger);
const warn = logger.warn.bind(logger);

// Cache configuration
const MAX_CACHE_SIZE = 1000; // Maximum number of cached icons
const CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours
const UNKNOWN_TOKEN_CACHE_EXPIRY = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const ICON_CACHE_SCHEMA_VERSION = 'v7';
const ICON_CACHE_KEY_PREFIX = 'tokenIconCache';

// Local icon configuration
const LOCAL_ICON_VERSION = TOKEN_ICON_CONFIG.LOCAL_ICON_VERSION || '';
const LOCAL_ICON_EXTENSIONS = ['png', 'webp', 'jpg', 'jpeg', 'svg'];

/**
 * Token Icon Service for managing token icons.
 * Local logos are resolved by probing flat address-based file paths.
 */
export class TokenIconService {
    constructor() {
        this.cache = new Map();
        this.cacheTimestamps = new Map();
        this.iconPathProbeCache = new Map();
        this.cacheStorageKey = this.getCacheStorageKey();

        // Load cache from localStorage on initialization
        this.loadCacheFromStorage();

        debug('TokenIconService initialized');
    }

    normalizeChainId(chainId) {
        if (chainId === null || chainId === undefined) {
            return null;
        }

        if (typeof chainId === 'string' && chainId.toLowerCase().startsWith('0x')) {
            const parsed = parseInt(chainId, 16);
            return Number.isNaN(parsed) ? null : String(parsed);
        }

        const parsed = Number(chainId);
        return Number.isFinite(parsed) ? String(parsed) : null;
    }

    buildCacheKey(tokenAddress, chainId) {
        return `${tokenAddress.toLowerCase()}-${this.normalizeChainId(chainId)}`;
    }

    buildVersionedIconUrl(iconPath) {
        if (!iconPath || !LOCAL_ICON_VERSION) {
            return iconPath;
        }

        const separator = iconPath.includes('?') ? '&' : '?';
        return `${iconPath}${separator}v=${encodeURIComponent(LOCAL_ICON_VERSION)}`;
    }

    buildLocalIconCandidates(tokenAddress, _chainId) {
        const normalizedAddress = tokenAddress?.toLowerCase();
        if (!normalizedAddress) {
            return [];
        }

        const candidates = [];
        for (const ext of LOCAL_ICON_EXTENSIONS) {
            candidates.push(`img/token-logos/${normalizedAddress}.${ext}`);
        }

        return candidates;
    }

    async doesLocalIconExist(iconUrl) {
        const cachedProbe = this.iconPathProbeCache.get(iconUrl);
        if (cachedProbe && (Date.now() - cachedProbe.ts) < CACHE_EXPIRY) {
            return cachedProbe.exists;
        }

        if (typeof Image === 'undefined') {
            return false;
        }

        const exists = await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src = iconUrl;
        });

        this.iconPathProbeCache.set(iconUrl, { exists, ts: Date.now() });
        return exists;
    }

    async getLocalIconUrl(tokenAddress, chainId) {
        const localCandidates = this.buildLocalIconCandidates(tokenAddress, chainId);
        for (const iconPath of localCandidates) {
            const candidateUrl = this.buildVersionedIconUrl(iconPath);
            if (await this.doesLocalIconExist(candidateUrl)) {
                return candidateUrl;
            }
        }

        return null;
    }

    trimCacheIfNeeded() {
        if (this.cache.size <= MAX_CACHE_SIZE) {
            return;
        }

        // Remove oldest entries first.
        const sortedEntries = Array.from(this.cache.entries())
            .sort(([, a], [, b]) => (a.timestamp || 0) - (b.timestamp || 0));

        const entriesToRemove = this.cache.size - MAX_CACHE_SIZE;
        for (let i = 0; i < entriesToRemove; i++) {
            const [key] = sortedEntries[i] || [];
            if (key) {
                this.cache.delete(key);
                this.cacheTimestamps.delete(key);
            }
        }
    }

    persistCacheEntry(cacheKey, iconUrl, isUnknown = false) {
        const cacheData = {
            iconUrl,
            timestamp: Date.now(),
            ...(isUnknown ? { isUnknown: true } : {})
        };

        this.cache.set(cacheKey, cacheData);
        this.cacheTimestamps.set(cacheKey, cacheData.timestamp);
        this.trimCacheIfNeeded();
        this.saveCacheToStorage();
    }

    /**
     * Get icon URL for a token with local mapping + cache.
     * @param {string} tokenAddress - Token contract address
     * @param {string|number} chainId - Network chain ID
     * @returns {Promise<string>} Icon URL or fallback data
     */
    async getIconUrl(tokenAddress, chainId) {
        try {
            if (!tokenAddress || chainId === null || chainId === undefined) {
                debug('Invalid parameters provided:', { tokenAddress, chainId });
                return this.getFallbackIconData(tokenAddress);
            }

            const normalizedAddress = tokenAddress.toLowerCase();
            const normalizedChainId = this.normalizeChainId(chainId);
            if (!ethers.utils.isAddress(normalizedAddress) || !normalizedChainId) {
                debug('Invalid token address or chain ID provided:', { tokenAddress, chainId });
                return this.getFallbackIconData(tokenAddress);
            }

            const cacheKey = this.buildCacheKey(normalizedAddress, normalizedChainId);

            // Resolve local icon by address filename from flat token-logos folder.
            const mappedLocalIconUrl = await this.getLocalIconUrl(normalizedAddress, normalizedChainId);
            if (mappedLocalIconUrl) {
                const existing = this.cache.get(cacheKey);
                if (!existing || existing.iconUrl !== mappedLocalIconUrl) {
                    this.persistCacheEntry(cacheKey, mappedLocalIconUrl);
                }
                return mappedLocalIconUrl;
            }

            // Fall back to cached result for unknown tokens.
            if (this.cache.has(cacheKey)) {
                const cachedData = this.cache.get(cacheKey);
                if (this.isCacheValid(cachedData)) {
                    if (cachedData.iconUrl === null) {
                        return this.getFallbackIconData(tokenAddress);
                    }
                    return cachedData.iconUrl;
                }

                this.cache.delete(cacheKey);
                this.cacheTimestamps.delete(cacheKey);
            }

            // Unknown token for current local map.
            this.persistCacheEntry(cacheKey, null, true);
            return this.getFallbackIconData(tokenAddress);
        } catch (err) {
            error('Error getting icon URL:', err);
            return this.getFallbackIconData(tokenAddress);
        }
    }

    /**
     * Get fallback icon data for tokens without icons
     * @param {string} tokenAddress - Token contract address
     * @returns {string} Fallback icon data identifier
     */
    getFallbackIconData(tokenAddress) {
        return 'fallback';
    }

    /**
     * Check if cache entry is still valid
     * @param {Object} cacheEntry - Cached token icon entry
     * @returns {boolean} True if cache is valid
     */
    isCacheValid(cacheEntry) {
        if (!cacheEntry || !cacheEntry.timestamp) {
            return false;
        }

        const entryExpiry = cacheEntry.isUnknown ? UNKNOWN_TOKEN_CACHE_EXPIRY : CACHE_EXPIRY;
        return Date.now() - cacheEntry.timestamp < entryExpiry;
    }

    getCacheStorageKey() {
        const appVersion = localStorage.getItem('app_version') || '0';
        return `${ICON_CACHE_KEY_PREFIX}:${ICON_CACHE_SCHEMA_VERSION}:${appVersion}`;
    }

    cleanupOldStorageKeys() {
        const activeKey = this.cacheStorageKey;

        for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i);
            if (key && key.startsWith(ICON_CACHE_KEY_PREFIX) && key !== activeKey) {
                localStorage.removeItem(key);
            }
        }
    }

    /**
     * Preload icons for multiple tokens
     * @param {Array} tokenAddresses - Array of token addresses
     * @param {string|number} chainId - Network chain ID
     * @returns {Promise<void>}
     */
    async preloadIcons(tokenAddresses, chainId) {
        debug('Preloading icons for', tokenAddresses.length, 'tokens');

        const preloadPromises = tokenAddresses.map(address =>
            this.getIconUrl(address, chainId).catch(err => {
                debug('Failed to preload icon for', address, err);
                return null;
            })
        );

        await Promise.allSettled(preloadPromises);
        debug('Icon preloading completed');
    }

    /**
     * Clear all caches
     */
    clearCache() {
        this.cache.clear();
        this.cacheTimestamps.clear();
        this.iconPathProbeCache.clear();
        this.cleanupOldStorageKeys();
        localStorage.removeItem(this.cacheStorageKey);
        debug('All caches cleared');
    }

    /**
     * Get cache statistics
     * @returns {Object} Cache statistics
     */
    getCacheStats() {
        const validEntries = Array.from(this.cache.entries()).filter(([, data]) =>
            this.isCacheValid(data)
        );

        return {
            totalEntries: this.cache.size,
            validEntries: validEntries.length,
            expiredEntries: this.cache.size - validEntries.length
        };
    }

    /**
     * Save cache to localStorage
     */
    saveCacheToStorage() {
        try {
            const cacheData = {
                cache: Array.from(this.cache.entries()),
                timestamps: Array.from(this.cacheTimestamps.entries()),
                timestamp: Date.now()
            };

            localStorage.setItem(this.cacheStorageKey, JSON.stringify(cacheData));
        } catch (err) {
            warn('Failed to save cache to localStorage:', err);
        }
    }

    /**
     * Load cache from localStorage
     */
    loadCacheFromStorage() {
        try {
            this.cleanupOldStorageKeys();

            const cacheData = localStorage.getItem(this.cacheStorageKey);
            if (!cacheData) return;

            const parsed = JSON.parse(cacheData);
            const now = Date.now();

            // Only load cache if it's not too old (7 days)
            if (now - parsed.timestamp > CACHE_MAX_AGE) {
                localStorage.removeItem(this.cacheStorageKey);
                return;
            }

            // Restore cache entries
            parsed.cache.forEach(([key, data]) => {
                if (this.isCacheValid(data)) {
                    this.cache.set(key, data);
                    this.cacheTimestamps.set(key, data.timestamp);
                }
            });

            this.trimCacheIfNeeded();
            debug('Cache loaded from localStorage:', this.cache.size, 'entries');
        } catch (err) {
            warn('Failed to load cache from localStorage:', err);
            localStorage.removeItem(this.cacheStorageKey);
        }
    }
}

// Export singleton instance
export const tokenIconService = new TokenIconService();
