/**
 * TokenMetadataCache - Single canonical source for token metadata
 * 
 * This service provides a unified, network-scoped cache for stable token metadata:
 * - symbol, name, decimals, iconUrl, displaySymbol
 * 
 * Lifetime:
 * - Persists for the current page session
 * - NOT cleared on tab switch or order creation
 * - Cleared on network switch
 * - Cleared on wallet disconnect (full app reset)
 * 
 * Balance data is NOT part of this cache - balances are user-specific and
 * should be invalidated separately.
 */

import { ethers } from 'ethers';
import { getNetworkConfig } from '../config/networks.js';
import { contractService } from './ContractService.js';
import { createLogger } from './LogService.js';
import { tokenIconService } from './TokenIconService.js';
import { tryAggregate as multicallTryAggregate } from './MulticallService.js';
import { erc20Abi } from '../abi/erc20.js';

const ERC20_INTERFACE = new ethers.utils.Interface(erc20Abi);

const logger = createLogger('TOKEN_METADATA_CACHE');
const debug = logger.debug.bind(logger);
const warn = logger.warn.bind(logger);
const error = logger.error.bind(logger);

// Storage configuration
const STORAGE_KEY_PREFIX = 'tokenMetadataCache';
const STORAGE_SCHEMA = 'v2'; // Bumped for unified cache
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for stable metadata

/**
 * TokenMetadataCache class
 * Manages a single canonical cache per network
 */
class TokenMetadataCache {
    constructor() {
        // Map<chainId, Map<address, {value, ts}>>
        this._caches = new Map();
        this._currentChainId = null;
        this._storageLoadedForChains = new Set();
    }

    /**
     * Get the current chain ID from network config
     * @returns {number} Chain ID
     */
    _getCurrentChainId() {
        try {
            const network = getNetworkConfig();
            return parseInt(network.chainId, 16) || 137;
        } catch (_) {
            return 137; // Default to Polygon
        }
    }

    /**
     * Get the storage key for a specific chain
     * @param {number} chainId 
     * @returns {string}
     */
    _getStorageKey(chainId) {
        return `${STORAGE_KEY_PREFIX}:${STORAGE_SCHEMA}:${chainId}`;
    }

    /**
     * Get or create the cache for the current network
     * @returns {Map}
     */
    _getCacheForCurrentNetwork() {
        const chainId = this._getCurrentChainId();
        
        // Detect network switch and clear old cache from memory
        if (this._currentChainId !== null && this._currentChainId !== chainId) {
            debug(`Network switch detected: ${this._currentChainId} -> ${chainId}`);
            // Keep the old cache in _caches for potential switch back, but clear from active use
        }
        
        this._currentChainId = chainId;
        
        if (!this._caches.has(chainId)) {
            this._caches.set(chainId, new Map());
        }
        
        return this._caches.get(chainId);
    }

    /**
     * Load cache from localStorage for a specific chain
     * @param {number} chainId 
     */
    _loadFromStorage(chainId) {
        if (this._storageLoadedForChains.has(chainId)) {
            return;
        }
        
        this._storageLoadedForChains.add(chainId);
        
        if (typeof localStorage === 'undefined') {
            return;
        }

        try {
            const raw = localStorage.getItem(this._getStorageKey(chainId));
            if (!raw) {
                return;
            }

            const parsed = JSON.parse(raw);
            const now = Date.now();
            const cache = this._caches.get(chainId) || new Map();

            Object.entries(parsed).forEach(([address, entry]) => {
                if (!entry || typeof entry !== 'object') {
                    return;
                }
                if (typeof entry.ts !== 'number' || !entry.value) {
                    return;
                }
                if ((now - entry.ts) >= CACHE_TTL_MS) {
                    return;
                }
                cache.set(address.toLowerCase(), { value: entry.value, ts: entry.ts });
            });

            this._caches.set(chainId, cache);
            debug(`Loaded ${cache.size} cached tokens from storage for chain ${chainId}`);
        } catch (err) {
            debug(`Failed to load token metadata cache from storage for chain ${chainId}:`, err);
        }
    }

    /**
     * Persist cache to localStorage for a specific chain
     * @param {number} chainId 
     */
    _persistToStorage(chainId) {
        if (typeof localStorage === 'undefined') {
            return;
        }

        try {
            const cache = this._caches.get(chainId);
            if (!cache) {
                return;
            }

            const now = Date.now();
            const serializable = {};

            cache.forEach((entry, address) => {
                if (!entry || typeof entry.ts !== 'number' || !entry.value) {
                    return;
                }
                if ((now - entry.ts) >= CACHE_TTL_MS) {
                    return;
                }
                serializable[address] = entry;
            });

            localStorage.setItem(this._getStorageKey(chainId), JSON.stringify(serializable));
        } catch (err) {
            debug(`Failed to persist token metadata cache to storage for chain ${chainId}:`, err);
        }
    }

    /**
     * Get token metadata from cache
     * @param {string} tokenAddress 
     * @returns {Object|null} Token metadata or null if not cached
     */
    get(tokenAddress) {
        const cache = this._getCacheForCurrentNetwork();
        const chainId = this._currentChainId;
        
        // Ensure storage is loaded
        this._loadFromStorage(chainId);
        
        const normalizedAddress = tokenAddress.toLowerCase();
        const cached = cache.get(normalizedAddress);
        
        if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
            debug(`Cache hit for ${normalizedAddress}`);
            // Reattach address to preserve caller contract (per PR #177 review)
            return { ...cached.value, address: normalizedAddress };
        }
        
        return null;
    }

    /**
     * Set token metadata in cache
     * @param {string} tokenAddress 
     * @param {Object} metadata - {symbol, name, decimals, iconUrl?, displaySymbol?}
     * @param {number} [chainId] - Optional chain ID (defaults to current network)
     */
    set(tokenAddress, metadata, chainId) {
        const targetChainId = chainId || this._currentChainId;
        
        // Get or create cache for the target chain
        if (!this._caches.has(targetChainId)) {
            this._caches.set(targetChainId, new Map());
        }
        const cache = this._caches.get(targetChainId);
        
        const normalizedAddress = tokenAddress.toLowerCase();
        
        cache.set(normalizedAddress, { value: metadata, ts: Date.now() });
        this._persistToStorage(targetChainId);
        
        debug(`Cached metadata for ${normalizedAddress} on chain ${targetChainId}:`, metadata);
    }

    /**
     * Check if token is in cache
     * @param {string} tokenAddress 
     * @returns {boolean}
     */
    has(tokenAddress) {
        return this.get(tokenAddress) !== null;
    }

    /**
     * Get all cached tokens for current network
     * @returns {Array<Object>} Array of token metadata objects
     */
    getAll() {
        const cache = this._getCacheForCurrentNetwork();
        const chainId = this._currentChainId;
        
        // Ensure storage is loaded
        this._loadFromStorage(chainId);
        
        const now = Date.now();
        const tokens = [];
        
        cache.forEach((entry, address) => {
            if (entry && entry.value && (now - entry.ts) < CACHE_TTL_MS) {
                tokens.push({
                    address,
                    ...entry.value
                });
            }
        });
        
        return tokens;
    }

    /**
     * Fetch token metadata from chain (with caching)
     * @param {string} tokenAddress 
     * @param {Object} options - {provider?, skipCache?: boolean}
     * @returns {Promise<Object>} Token metadata
     */
    async fetch(tokenAddress, options = {}) {
        const normalizedAddress = tokenAddress.toLowerCase();
        
        // Capture the originating chain ID at the start to prevent race conditions
        const originatingChainId = this._getCurrentChainId();
        
        // Check cache first (unless skipCache is true)
        if (!options.skipCache) {
            const cached = this.get(normalizedAddress);
            if (cached) {
                return cached;
            }
        }
        
        try {
            const provider = options.provider || contractService.getProvider();
            if (!provider) {
                throw new Error('Provider not available');
            }

            // Use multicall for efficiency
            const calls = [
                { target: tokenAddress, callData: ERC20_INTERFACE.encodeFunctionData('symbol', []) },
                { target: tokenAddress, callData: ERC20_INTERFACE.encodeFunctionData('name', []) },
                { target: tokenAddress, callData: ERC20_INTERFACE.encodeFunctionData('decimals', []) }
            ];

            let symbol, name, decimals;
            const mcResult = await multicallTryAggregate(calls);
            
            if (mcResult) {
                try {
                    symbol = ERC20_INTERFACE.decodeFunctionResult('symbol', mcResult[0].returnData)[0];
                    name = ERC20_INTERFACE.decodeFunctionResult('name', mcResult[1].returnData)[0];
                    decimals = ERC20_INTERFACE.decodeFunctionResult('decimals', mcResult[2].returnData)[0];
                } catch (_) {
                    // Fallback to direct calls
                    const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, provider);
                    [symbol, name, decimals] = await Promise.all([
                        tokenContract.symbol(),
                        tokenContract.name(),
                        tokenContract.decimals()
                    ]);
                }
            } else {
                const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, provider);
                [symbol, name, decimals] = await Promise.all([
                    tokenContract.symbol(),
                    tokenContract.name(),
                    tokenContract.decimals()
                ]);
            }

            // Get icon URL
            let iconUrl = null;
            try {
                const chainId = this._getCurrentChainId();
                iconUrl = await tokenIconService.getIconUrl(tokenAddress, chainId);
            } catch (err) {
                debug(`Failed to get icon for token ${tokenAddress}:`, err);
            }

            const metadata = {
                symbol,
                name,
                decimals: parseInt(decimals),
                iconUrl
            };

            // Cache the result in the originating chain's cache (prevents race condition)
            this.set(normalizedAddress, metadata, originatingChainId);
            
            // Return with address attached (per PR #177 review - preserve caller contract)
            return { ...metadata, address: normalizedAddress };

        } catch (err) {
            error(`Failed to fetch metadata for token ${tokenAddress}:`, err);
            
            // Return fallback without caching (per issue #173 - don't poison cache with fallbacks)
            return {
                address: normalizedAddress,
                symbol: `${tokenAddress.slice(0, 4)}...${tokenAddress.slice(-4)}`,
                decimals: 18,
                name: 'Unknown Token',
                iconUrl: null,
                _isFallback: true
            };
        }
    }

    /**
     * Batch fetch metadata for multiple tokens
     * @param {string[]} tokenAddresses 
     * @param {Object} options 
     * @returns {Promise<Map<string, Object>>} Map of address -> metadata
     */
    async fetchBatch(tokenAddresses, options = {}) {
        const results = new Map();
        
        if (!tokenAddresses || tokenAddresses.length === 0) {
            return results;
        }

        // Separate cached from uncached
        const uncached = [];
        for (const address of tokenAddresses) {
            const cached = this.get(address);
            if (cached && !options.skipCache) {
                results.set(address.toLowerCase(), cached);
            } else {
                uncached.push(address);
            }
        }

        if (uncached.length === 0) {
            return results;
        }

        // Fetch uncached tokens
        // Note: Could optimize with batch multicall in the future
        for (const address of uncached) {
            try {
                const metadata = await this.fetch(address, options);
                results.set(address.toLowerCase(), metadata);
            } catch (err) {
                warn(`Failed to fetch metadata for ${address}:`, err);
            }
        }

        return results;
    }

    /**
     * Clear cache for current network
     */
    clearCurrentNetwork() {
        const chainId = this._getCurrentChainId();
        const cache = this._caches.get(chainId);
        
        if (cache) {
            cache.clear();
        }
        
        // Clear from storage
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(this._getStorageKey(chainId));
        }
        
        debug(`Cleared token metadata cache for chain ${chainId}`);
    }

    /**
     * Clear all caches (for wallet disconnect / full reset)
     */
    clearAll() {
        this._caches.clear();
        this._storageLoadedForChains.clear();
        this._currentChainId = null;
        
        // Clear all from storage
        if (typeof localStorage !== 'undefined') {
            // Find and remove all keys matching our prefix
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith(STORAGE_KEY_PREFIX)) {
                    keysToRemove.push(key);
                }
            }
            keysToRemove.forEach(key => localStorage.removeItem(key));
        }
        
        debug('Cleared all token metadata caches');
    }

    /**
     * Get cache statistics for debugging
     * @returns {Object}
     */
    getStats() {
        const chainId = this._getCurrentChainId();
        const cache = this._caches.get(chainId);
        
        return {
            currentChainId: chainId,
            cachedTokensCount: cache ? cache.size : 0,
            loadedChains: Array.from(this._storageLoadedForChains)
        };
    }
}

// Singleton instance
export const tokenMetadataCache = new TokenMetadataCache();

// Also export class for testing
export { TokenMetadataCache };

export default tokenMetadataCache;
