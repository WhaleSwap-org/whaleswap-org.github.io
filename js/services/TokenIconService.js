import { createLogger } from './LogService.js';

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

// CoinGecko API configuration
const COINGECKO_API_BASE = 'https://api.coingecko.com/api/v3';
const COINGECKO_ICON_BASE = 'https://assets.coingecko.com/coins/images';

// Rate limiting configuration
const RATE_LIMIT_DELAY = 100; // ms between requests
const MAX_CACHE_SIZE = 1000; // Maximum number of cached icons
const CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours in ms

/**
 * Rate limiter utility class
 */
class RateLimiter {
    constructor() {
        this.lastRequestTime = 0;
        this.requestQueue = [];
        this.isProcessing = false;
    }

    async execute(fn) {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({ fn, resolve, reject });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.isProcessing || this.requestQueue.length === 0) {
            return;
        }

        this.isProcessing = true;

        while (this.requestQueue.length > 0) {
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;

            if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
                const delay = RATE_LIMIT_DELAY - timeSinceLastRequest;
                await new Promise(resolve => setTimeout(resolve, delay));
            }

            const { fn, resolve, reject } = this.requestQueue.shift();
            this.lastRequestTime = Date.now();

            try {
                const result = await fn();
                resolve(result);
            } catch (err) {
                reject(err);
            }
        }

        this.isProcessing = false;
    }
}

/**
 * Token Icon Service for managing token icons with Trust Wallet Assets
 */
export class TokenIconService {
    constructor() {
        this.cache = new Map();
        this.loadingPromises = new Map();
        this.rateLimiter = new RateLimiter();
        this.cacheTimestamps = new Map();
        
        // Load cache from localStorage on initialization
        this.loadCacheFromStorage();
        
        debug('TokenIconService initialized');
    }

    /**
     * Get icon URL for a token with caching and fallbacks
     * @param {string} tokenAddress - Token contract address
     * @param {string|number} chainId - Network chain ID
     * @returns {Promise<string>} Icon URL or fallback data
     */
    async getIconUrl(tokenAddress, chainId) {
        try {
            if (!tokenAddress || !chainId) {
                debug('Invalid parameters provided:', { tokenAddress, chainId });
                return this.getFallbackIconData(tokenAddress);
            }

            const normalizedAddress = tokenAddress.toLowerCase();
            const cacheKey = `${normalizedAddress}-${chainId}`;

            // Check memory cache first
            if (this.cache.has(cacheKey)) {
                const cachedData = this.cache.get(cacheKey);
                if (this.isCacheValid(cachedData.timestamp)) {
                    debug('Icon found in memory cache:', normalizedAddress);
                    // If cached iconUrl is null (unknown token), return fallback
                    if (cachedData.iconUrl === null) {
                        debug('Cached unknown token, using fallback icon');
                        return this.getFallbackIconData(tokenAddress);
                    }
                    return cachedData.iconUrl;
                } else {
                    // Remove expired cache entry
                    this.cache.delete(cacheKey);
                    this.cacheTimestamps.delete(cacheKey);
                }
            }

            // Check if already loading
            if (this.loadingPromises.has(cacheKey)) {
                debug('Icon already loading, waiting for result:', normalizedAddress);
                return await this.loadingPromises.get(cacheKey);
            }

            // Start loading process
            const loadingPromise = this.loadIconUrl(normalizedAddress, chainId, cacheKey);
            this.loadingPromises.set(cacheKey, loadingPromise);

            try {
                const iconUrl = await loadingPromise;
                return iconUrl;
            } finally {
                // Clean up loading promise
                this.loadingPromises.delete(cacheKey);
            }

        } catch (err) {
            error('Error getting icon URL:', err);
            return this.getFallbackIconData(tokenAddress);
        }
    }

    /**
     * Load icon URL with rate limiting and validation
     * @param {string} tokenAddress - Normalized token address
     * @param {string|number} chainId - Network chain ID
     * @param {string} cacheKey - Cache key for this request
     * @returns {Promise<string>} Icon URL
     */
            async loadIconUrl(tokenAddress, chainId, cacheKey) {
            return this.rateLimiter.execute(async () => {
                try {
                    // Special case for Liberdus - use local icon
                    if (tokenAddress.toLowerCase() === "0x693ed886545970f0a3adf8c59af5ccdb6ddf0a76") {
                        debug('Using local Liberdus icon');
                        const cacheData = {
                            iconUrl: "assets/32.png",
                            timestamp: Date.now()
                        };
                        this.cache.set(cacheKey, cacheData);
                        this.cacheTimestamps.set(cacheKey, cacheData.timestamp);
                        this.saveCacheToStorage();
                        return "assets/32.png";
                    }

                    // Try to get CoinGecko icon URL with retry logic
                    let iconUrl = null;
                    let retryCount = 0;
                    const maxRetries = 2;

                    while (retryCount <= maxRetries && !iconUrl) {
                        try {
                            debug(`Attempting to get CoinGecko icon for ${tokenAddress} (attempt ${retryCount + 1})`);
                            iconUrl = await this.getCoinGeckoIconUrl(tokenAddress, chainId);
                            
                            if (iconUrl) {
                                debug('Found CoinGecko icon for:', tokenAddress, iconUrl);
                                const cacheData = {
                                    iconUrl,
                                    timestamp: Date.now()
                                };
                                this.cache.set(cacheKey, cacheData);
                                this.cacheTimestamps.set(cacheKey, cacheData.timestamp);
                                this.saveCacheToStorage();
                                return iconUrl;
                            } else {
                                // If iconUrl is null, it means the token is unknown
                                // Cache this result to prevent infinite retries
                                debug(`Token ${tokenAddress} is unknown, caching result to prevent retries`);
                                const cacheData = {
                                    iconUrl: null,
                                    timestamp: Date.now(),
                                    isUnknown: true
                                };
                                this.cache.set(cacheKey, cacheData);
                                this.cacheTimestamps.set(cacheKey, cacheData.timestamp);
                                this.saveCacheToStorage();
                                break; // Exit the retry loop for unknown tokens
                            }
                        } catch (error) {
                            retryCount++;
                            debug(`CoinGecko icon fetch failed for ${tokenAddress} (attempt ${retryCount}):`, error.message);
                            
                            if (retryCount <= maxRetries) {
                                // Wait before retry with exponential backoff
                                const delay = Math.pow(2, retryCount) * 1000; // 2s, 4s
                                debug(`Waiting ${delay}ms before retry...`);
                                await new Promise(resolve => setTimeout(resolve, delay));
                            }
                        }
                    }

                    // If all attempts failed, log the failure
                    if (!iconUrl) {
                        debug(`All CoinGecko attempts failed for ${tokenAddress}, using fallback`);
                    }
                } catch (error) {
                    debug('Unexpected error in loadIconUrl for:', tokenAddress, error.message);
                }

                // Fallback to generated icon
                debug('Using fallback icon for:', tokenAddress);
                return this.getFallbackIconData(tokenAddress);
            });
        }

    /**
     * Get CoinGecko icon URL for a token
     * @param {string} tokenAddress - Token contract address
     * @param {string|number} chainId - Network chain ID
     * @returns {Promise<string|null>} CoinGecko icon URL or null
     */
    async getCoinGeckoIconUrl(tokenAddress, chainId) {
        // CoinGecko chain mapping
        const chainMap = {
            1: "ethereum",
            137: "polygon-pos",
            56: "binance-smart-chain",
            42161: "arbitrum-one",
            10: "optimistic-ethereum",
            43114: "avalanche",
            250: "fantom",
            25: "cronos"
        };

        const chainName = chainMap[chainId];
        if (!chainName) {
            debug('Unsupported chain for CoinGecko:', chainId);
            return null;
        }

        // Known token mappings for Polygon (we'll expand this)
        const knownTokens = {
            "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": "usd-coin", // USDC
            "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": "tether", // USDT
            "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": "weth", // WETH
            "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": "matic-network", // WMATIC
            "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6": "wrapped-bitcoin", // WBTC
        };

        const coinId = knownTokens[tokenAddress.toLowerCase()];
        if (!coinId) {
            debug('Unknown token for CoinGecko:', tokenAddress);
            return null;
        }

        try {
            const response = await fetch(`https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`);
            
            if (response.ok) {
                const data = await response.json();
                if (data.image && data.image.small) {
                    debug('Found CoinGecko icon URL:', data.image.small);
                    return data.image.small;
                }
            }
        } catch (error) {
            debug('CoinGecko API call failed:', error.message);
        }

        return null;
    }



    /**
     * Validate if an icon URL exists and is accessible
     * @param {string} iconUrl - Icon URL to validate
     * @returns {Promise<boolean>} True if icon exists
     */
    async validateIconUrl(iconUrl) {
        if (!iconUrl) return false;

        try {
            const response = await fetch(iconUrl, {
                method: 'HEAD',
                mode: 'no-cors' // Handle CORS issues
            });
            
            // For no-cors requests, we can't check status, so assume it exists
            // In a real implementation, you might want to use a proxy or different approach
            return true;
        } catch (err) {
            debug('Icon validation failed:', err);
            return false;
        }
    }

    /**
     * Get fallback icon data for tokens without icons
     * @param {string} tokenAddress - Token contract address
     * @returns {string} Fallback icon data (color-based)
     */
    getFallbackIconData(tokenAddress) {
        // Return a special identifier for fallback icons
        // Components will handle the actual fallback rendering
        return 'fallback';
    }

    /**
     * Check if cache entry is still valid
     * @param {number} timestamp - Cache timestamp
     * @returns {boolean} True if cache is valid
     */
    isCacheValid(timestamp) {
        return Date.now() - timestamp < CACHE_EXPIRY;
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
        this.loadingPromises.clear();
        localStorage.removeItem('tokenIconCache');
        debug('All caches cleared');
    }

    /**
     * Get cache statistics
     * @returns {Object} Cache statistics
     */
    getCacheStats() {
        const validEntries = Array.from(this.cache.entries()).filter(([key, data]) => 
            this.isCacheValid(data.timestamp)
        );

        return {
            totalEntries: this.cache.size,
            validEntries: validEntries.length,
            expiredEntries: this.cache.size - validEntries.length,
            loadingPromises: this.loadingPromises.size
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
            
            localStorage.setItem('tokenIconCache', JSON.stringify(cacheData));
        } catch (err) {
            warn('Failed to save cache to localStorage:', err);
        }
    }

    /**
     * Load cache from localStorage
     */
    loadCacheFromStorage() {
        try {
            const cacheData = localStorage.getItem('tokenIconCache');
            if (!cacheData) return;

            const parsed = JSON.parse(cacheData);
            const now = Date.now();

            // Only load cache if it's not too old (7 days)
            if (now - parsed.timestamp > 7 * 24 * 60 * 60 * 1000) {
                localStorage.removeItem('tokenIconCache');
                return;
            }

            // Restore cache entries
            parsed.cache.forEach(([key, data]) => {
                if (this.isCacheValid(data.timestamp)) {
                    this.cache.set(key, data);
                    this.cacheTimestamps.set(key, data.timestamp);
                }
            });

            debug('Cache loaded from localStorage:', this.cache.size, 'entries');
        } catch (err) {
            warn('Failed to load cache from localStorage:', err);
            localStorage.removeItem('tokenIconCache');
        }
    }
}

// Export singleton instance
export const tokenIconService = new TokenIconService();
