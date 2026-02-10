import { getNetworkConfig, isDebugEnabled } from '../config.js';
import { createLogger } from './LogService.js';
import { contractService } from './ContractService.js';

export class PricingService {
    constructor(options = {}) {
        this.prices = new Map();
        this.lastUpdate = null;
        this.updating = false;
        this.subscribers = new Set();
        this.rateLimitDelay = 250; // Ensure we stay under 300 requests/minute
        this.networkConfig = getNetworkConfig();
        
        // Injected dependencies (preferred over window globals)
        this.webSocket = options.webSocket || null;
        
        // Simplified: Track allowed tokens for pre-fetching
        this.allowedTokens = new Set();
        this.allowedTokensLastFetched = null;
        
        // Performance optimizations
        this.pendingRequests = new Map(); // Track pending requests to prevent duplicates
        this.priceCacheExpiry = 5 * 60 * 1000; // 5 minutes cache expiry
        this.lastPriceFetch = new Map(); // Track when each price was last fetched
        
        const logger = createLogger('PRICING');
        this.debug = logger.debug.bind(logger);
        this.error = logger.error.bind(logger);
        this.warn = logger.warn.bind(logger);

        this.refreshPromise = null; // Track current refresh promise
    }

    async initialize() {
        await this.refreshPrices();
    }

    subscribe(callback) {
        this.subscribers.add(callback);
    }

    unsubscribe(callback) {
        this.subscribers.delete(callback);
    }

    notifySubscribers(event, data) {
        this.subscribers.forEach(callback => callback(event, data));
    }

    async fetchTokenPrices(tokenAddresses) {
        this.debug('Fetching prices for tokens:', tokenAddresses);
        const prices = new Map();
        
        // Validate token addresses
        const validAddresses = this.validateTokenAddresses(tokenAddresses);
        if (validAddresses.length === 0) {
            this.warn('No valid token addresses provided for price fetching');
            return prices;
        }
        
        // Use smart batching for mixed token lists
        const chunks = this.createSmartBatches(validAddresses, 30);

        for (const chunk of chunks) {
            try {
                const addresses = chunk.join(',');
                const url = `https://api.dexscreener.com/latest/dex/tokens/${addresses}`;
                const response = await fetch(url);
                const data = await response.json();
                
                if (data.pairs) {
                    this.processTokenPairs(data.pairs, prices);
                }
                
                await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay));
            } catch (error) {
                this.error('Error fetching chunk prices:', error);
            }
        }

        // For any tokens that didn't get prices, try individual requests
        const missingTokens = validAddresses.filter(addr => !prices.has(addr.toLowerCase()));
        if (missingTokens.length > 0) {
            this.debug('Fetching missing token prices individually:', missingTokens);
            
            for (const addr of missingTokens) {
                try {
                    const url = `https://api.dexscreener.com/latest/dex/tokens/${addr}`;
                    const response = await fetch(url);
                    const data = await response.json();
                    
                    if (data.pairs && data.pairs.length > 0) {
                        this.processTokenPairs(data.pairs, prices);
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay));
                } catch (error) {
                    this.error('Error fetching individual token price:', { token: addr, error });
                }
            }
        }

        return prices;
    }

    // New method to fetch prices for specific token addresses
    /**
     * Fetches prices for specific token addresses with deduplication and caching.
     * 
     * @param {string[]} tokenAddresses - Array of token addresses to fetch prices for
     * @returns {Promise<Map<string, {price: number, liquidity: number}>>} Map of fetched prices
     */
    async fetchPricesForTokens(tokenAddresses) {
        if (!Array.isArray(tokenAddresses) || tokenAddresses.length === 0) {
            this.debug('No token addresses provided for price fetching');
            return new Map();
        }

        this.debug('Fetching prices for specific tokens:', tokenAddresses);
        
        // Use deduplicated price fetching for better performance
        const newPrices = await this.deduplicatedPriceFetch(tokenAddresses);
        
        // Update internal price map with new prices
        for (const [address, data] of newPrices.entries()) {
            this.prices.set(address, data.price);
            this.debug(`Updated price for ${address}: ${data.price}`);
        }

        return newPrices;
    }

    processTokenPairs(pairs, prices) {
        // Sort pairs by liquidity
        const sortedPairs = pairs.sort((a, b) => 
            (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
        );

        for (const pair of sortedPairs) {
            const baseAddr = pair.baseToken.address.toLowerCase();
            const quoteAddr = pair.quoteToken.address.toLowerCase();
            const priceUsd = parseFloat(pair.priceUsd);
            
            // Enhanced price validation
            if (!isNaN(priceUsd) && this.validatePrice(priceUsd, baseAddr)) {
                if (!prices.has(baseAddr)) {
                    prices.set(baseAddr, {
                        price: priceUsd,
                        liquidity: pair.liquidity?.usd || 0
                    });
                }
                
                // Calculate and set quote token price if we don't have it yet
                if (!prices.has(quoteAddr)) {
                    const basePrice = prices.get(baseAddr).price;
                    const priceNative = parseFloat(pair.priceNative);
                    if (!isNaN(priceNative) && priceNative > 0) {
                        const quotePrice = basePrice / priceNative;
                        if (this.validatePrice(quotePrice, quoteAddr)) {
                            prices.set(quoteAddr, {
                                price: quotePrice,
                                liquidity: pair.liquidity?.usd || 0
                            });
                        }
                    }
                }
            }
        }
    }

    async refreshPrices() {
        if (this.updating) {
            return this.refreshPromise;
        }
        
        this.updating = true;
        this.notifySubscribers('refreshStart');

        this.refreshPromise = (async () => {
            try {
                // Simplified: Get allowed tokens for price fetching
                const tokenAddresses = Array.from(this.allowedTokens);

                if (tokenAddresses.length === 0) {
                    this.warn('No allowed tokens to fetch prices for');
                    // Set lastUpdate even when no tokens to fetch
                    this.lastUpdate = Date.now();
                    this.notifySubscribers('refreshComplete');
                    return { success: true, message: 'No tokens to update' };
                }

                this.debug('Fetching prices for allowed tokens:', tokenAddresses);
                const prices = await this.fetchTokenPrices(tokenAddresses);
                this.debug('Fetched prices:', prices);
                
                // Update internal price map
                this.prices.clear();
                for (const [address, data] of prices.entries()) {
                    this.debug(`Setting price for ${address}:`, data.price);
                    this.prices.set(address, data.price);
                }
                
                const ws = this.webSocket;
                if (ws) {
                    await ws.updateAllDeals();
                }
                
                this.lastUpdate = Date.now();
                this.notifySubscribers('refreshComplete');
                
                this.debug('Prices updated:', Object.fromEntries(this.prices));
                return { success: true, message: 'Prices updated successfully' };
            } catch (error) {
                const errorResult = this.handleFetchError(error, 'refreshPrices');
                this.notifySubscribers('refreshError', errorResult);
                return errorResult;
            } finally {
                this.updating = false;
                this.refreshPromise = null;
            }
        })();

        return this.refreshPromise;
    }

    getPrice(tokenAddress) {
        const price = this.prices.get(tokenAddress.toLowerCase());
        
        if (price === undefined) {
            // Check if we should default to 1 for testing
            if (isDebugEnabled('PRICING_DEFAULT_TO_ONE')) {
                return 1; // Default to 1 for testing
            }
            return undefined; // Return undefined for production
        }
        
        return price;
    }

    isPriceEstimated(tokenAddress) {
        return !this.prices.has(tokenAddress.toLowerCase());
    }

    getLastUpdateTime() {
        return this.lastUpdate ? new Date(this.lastUpdate).toLocaleTimeString() : 'Never';
    }

    // Check if price is stale and needs refreshing
    /**
     * Checks if a cached price is stale and needs refreshing.
     * 
     * @param {string} tokenAddress - The token address to check
     * @returns {boolean} True if price is stale or doesn't exist
     */
    isPriceStale(tokenAddress) {
        const lastFetch = this.lastPriceFetch.get(tokenAddress.toLowerCase());
        return !lastFetch || (Date.now() - lastFetch) > this.priceCacheExpiry;
    }

    /**
     * Deduplicates price fetching requests to prevent duplicate API calls.
     * Skips tokens with fresh prices, pending requests, or already cached prices.
     * 
     * @param {string[]} tokenAddresses - Array of token addresses to fetch prices for
     * @returns {Promise<Map<string, {price: number, liquidity: number}>>} Map of token addresses to price data
     */
    async deduplicatedPriceFetch(tokenAddresses) {
        const uniqueAddresses = [...new Set(tokenAddresses.map(addr => addr.toLowerCase()))];
        const addressesToFetch = uniqueAddresses.filter(addr => 
            !this.prices.has(addr) || this.isPriceStale(addr)
        ).filter(addr => !this.pendingRequests.has(addr));

        if (addressesToFetch.length === 0) {
            this.debug('No new addresses to fetch, using cached prices');
            return new Map();
        }

        // Mark addresses as pending and fetch prices
        addressesToFetch.forEach(addr => this.pendingRequests.set(addr, Date.now()));
        
        try {
            const newPrices = await this.fetchTokenPrices(addressesToFetch);
            addressesToFetch.forEach(addr => this.lastPriceFetch.set(addr, Date.now()));
            return newPrices;
        } finally {
            addressesToFetch.forEach(addr => this.pendingRequests.delete(addr));
        }
    }

    /**
     * Notifies subscribers of price updates with optional specific addresses.
     * 
     * @param {string[]} [updatedAddresses=[]] - Array of updated token addresses
     */
    notifyPriceUpdates(updatedAddresses = []) {
        this.notifySubscribers(
            updatedAddresses.length === 0 ? 'refreshComplete' : 'priceUpdates',
            updatedAddresses.length === 0 ? undefined : updatedAddresses
        );
    }

    /**
     * Removes stale cache entries to free memory and maintain fresh data.
     * 
     * @returns {number} Number of cache entries cleared
     */
    clearStaleCache() {
        const now = Date.now();
        let clearedCount = 0;
        
        for (const [address, lastFetch] of this.lastPriceFetch.entries()) {
            if ((now - lastFetch) > this.priceCacheExpiry) {
                this.prices.delete(address);
                this.lastPriceFetch.delete(address);
                clearedCount++;
            }
        }
        
        if (clearedCount > 0) {
            this.debug(`Cleared ${clearedCount} stale cache entries`);
        }
        
        return clearedCount;
    }

    /**
     * Handles and formats price fetching errors with detailed context.
     * 
     * @param {Error} error - The error that occurred
     * @param {string} context - Context where the error occurred
     * @returns {Object} Formatted error response with details
     */
    handleFetchError(error, context) {
        const errorInfo = {
            message: error.message,
            context,
            timestamp: new Date().toISOString(),
            stack: error.stack
        };
        
        this.error('Price fetching error:', errorInfo);
        if (this.debug.enabled) {
            console.error('PricingService Error:', errorInfo);
        }
        
        return {
            success: false,
            error: errorInfo,
            message: `Failed to fetch prices: ${error.message}`
        };
    }

    /**
     * Validates the service state and identifies potential issues.
     * 
     * @returns {Object} Validation result with issues list
     */
    validateServiceState() {
        const issues = [];
        
        if (!this.networkConfig) issues.push('Network configuration not available');
        if (this.updating && Date.now() - this.lastUpdate > 30000) issues.push('Service stuck in updating state');
        if (this.pendingRequests.size > 50) issues.push('Too many pending requests');
        
        return { isValid: issues.length === 0, issues };
    }

    /**
     * Returns comprehensive health status and metrics for the pricing service.
     * 
     * @returns {Object} Health status with metrics and issues
     */
    getHealthStatus() {
        const state = this.validateServiceState();
        return {
            status: state.isValid ? 'healthy' : 'degraded',
            issues: state.issues,
            metrics: {
                cacheSize: this.prices.size,
                pendingRequests: this.pendingRequests.size,
                lastUpdate: this.getLastUpdateTime(),
                allowedTokensCount: this.allowedTokens.size
            }
        };
    }

    /**
     * Fetches allowed tokens from the contract and updates internal tracking.
     * 
     * @returns {Promise<string[]>} Array of allowed token addresses
     * @throws {Error} If contract service fails to fetch tokens
     */
    async getAllowedTokens() {
        try {
            this.debug('Fetching allowed tokens from contract...');
            // If WebSocket/contract not ready yet, return empty list gracefully
            const ws = this.webSocket;
            if (!ws?.contract) {
                this.warn('Contract not available yet; skipping allowed tokens fetch');
                this.allowedTokens.clear();
                this.allowedTokensLastFetched = Date.now();
                return [];
            }
            const allowedTokenAddresses = await contractService.getAllowedTokens();
            
            // Update allowed tokens set
            this.allowedTokens.clear();
            allowedTokenAddresses.forEach(addr => this.allowedTokens.add(addr.toLowerCase()));
            
            this.allowedTokensLastFetched = Date.now();
            this.debug(`Fetched ${allowedTokenAddresses.length} allowed tokens:`, allowedTokenAddresses);
            
            return allowedTokenAddresses;
        } catch (error) {
            this.error('Failed to get allowed tokens:', error);
            throw error;
        }
    }

    /**
     * Pre-fetches prices for all allowed tokens from the contract.
     * 
     * @returns {Promise<Object>} Result object with success status and message
     */
    async fetchAllowedTokensPrices() {
        try {
            this.debug('Fetching prices for allowed tokens...');
            
            // Get allowed tokens if we haven't fetched them yet
            if (this.allowedTokens.size === 0) {
                await this.getAllowedTokens();
            }
            
            if (this.allowedTokens.size === 0) {
                this.warn('No allowed tokens found to fetch prices for');
                // Phase 3: Set lastUpdate even when no allowed tokens
                this.lastUpdate = Date.now();
                return { success: true, message: 'No allowed tokens to update' };
            }
            
            const allowedTokenAddresses = Array.from(this.allowedTokens);
            const newPrices = await this.fetchPricesForTokens(allowedTokenAddresses);
            
            this.debug(`Fetched prices for ${newPrices.size} allowed tokens`);
            return { 
                success: true, 
                message: `Updated prices for ${newPrices.size} allowed tokens`,
                updatedCount: newPrices.size
            };
        } catch (error) {
            return this.handleFetchError(error, 'fetchAllowedTokensPrices');
        }
    }

    // Enhanced error handling for mixed token lists
    /**
     * Validates and normalizes token addresses, filtering out invalid ones.
     * 
     * @param {string[]} tokenAddresses - Array of token addresses to validate
     * @returns {string[]} Array of valid, normalized token addresses
     */
    validateTokenAddresses(tokenAddresses) {
        if (!Array.isArray(tokenAddresses)) {
            throw new Error('Token addresses must be an array');
        }
        
        const validAddresses = [];
        const invalidAddresses = [];
        
        for (const addr of tokenAddresses) {
            if (typeof addr === 'string' && addr.length === 42 && addr.startsWith('0x')) {
                validAddresses.push(addr.toLowerCase());
            } else {
                invalidAddresses.push(addr);
            }
        }
        
        if (invalidAddresses.length > 0) {
            this.warn('Invalid token addresses found:', invalidAddresses);
        }
        
        return validAddresses;
    }

    // Enhanced price validation and fallback mechanisms
    /**
     * Validates price data for sanity and reasonable bounds.
     * 
     * @param {number} price - The price to validate
     * @param {string} tokenAddress - Token address for error context
     * @returns {boolean} True if price is valid
     */
    validatePrice(price, tokenAddress) {
        if (typeof price !== 'number' || isNaN(price)) {
            this.warn(`Invalid price for token ${tokenAddress}: ${price}`);
            return false;
        }
        
        if (price < 0) {
            this.warn(`Negative price for token ${tokenAddress}: ${price}`);
            return false;
        }
        
        if (price > 1000000) {
            this.warn(`Suspiciously high price for token ${tokenAddress}: ${price}`);
            return false;
        }
        
        return true;
    }

    // Smart batching for mixed token lists
    /**
     * Creates optimized batches for API requests to improve performance.
     * 
     * @param {string[]} tokenAddresses - Array of token addresses to batch
     * @param {number} [maxBatchSize=30] - Maximum size of each batch
     * @returns {string[][]} Array of token address batches
     */
    createSmartBatches(tokenAddresses, maxBatchSize = 30) {
        const batches = [];
        const currentBatch = [];
        
        for (const addr of tokenAddresses) {
            currentBatch.push(addr);
            
            if (currentBatch.length >= maxBatchSize) {
                batches.push([...currentBatch]);
                currentBatch.length = 0;
            }
        }
        
        // Add remaining tokens
        if (currentBatch.length > 0) {
            batches.push(currentBatch);
        }
        
        this.debug(`Created ${batches.length} batches for ${tokenAddresses.length} tokens`);
        return batches;
    }
}