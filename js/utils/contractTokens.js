import { ethers } from 'ethers';
import { getNetworkConfig } from '../config/networks.js';
import { contractService } from '../services/ContractService.js';
import { createLogger } from '../services/LogService.js';
import { tokenIconService } from '../services/TokenIconService.js';
import { tryAggregate as multicallTryAggregate } from '../services/MulticallService.js';
import { tokenMetadataCache } from '../services/TokenMetadataCache.js';
import { erc20Abi } from '../abi/erc20.js';

const ERC20_INTERFACE = new ethers.utils.Interface(erc20Abi);

// Initialize logger
const logger = createLogger('CONTRACT_TOKENS');
const debug = logger.debug.bind(logger);
const error = logger.error.bind(logger);
const warn = logger.warn.bind(logger);

// Concurrency control
const CONCURRENCY_LIMIT = 5; // Max concurrent metadata/icon tasks

// Balance cache is kept separate from metadata cache (per issue #174)
// Balances are user-specific and should be invalidated on create/fill/cancel
const BALANCE_CACHE_TTL_MS = 30 * 1000; // 30 seconds
const balanceCache = new Map(); // key: `${token}-${user}` -> { value, ts }

// Note: Token metadata cache is now managed by TokenMetadataCache service
// This provides a unified cache shared across WebSocketService, CreateOrder, and order views

/**
 * Batch fetch balances and decimals for many tokens using multicall
 * Returns a map of lowercase tokenAddress -> { rawBalance, decimals, formatted }
 */
async function getBatchTokenBalances(tokenAddresses, userAddress) {
    const resultMap = new Map();
    if (!tokenAddresses || tokenAddresses.length === 0 || !userAddress) {
        return resultMap;
    }

    // Prepare calls: for each token, balanceOf + decimals (single ABI source: erc20.js)
    const calls = [];
    for (const token of tokenAddresses) {
        calls.push({ target: token, callData: ERC20_INTERFACE.encodeFunctionData('balanceOf', [userAddress]) });
        calls.push({ target: token, callData: ERC20_INTERFACE.encodeFunctionData('decimals', []) });
    }

    const mc = await multicallTryAggregate(calls);
    if (mc) {
        for (let i = 0; i < tokenAddresses.length; i++) {
            const token = tokenAddresses[i];
            const lc = token.toLowerCase();
            try {
                const balRes = mc[2 * i];
                const decRes = mc[2 * i + 1];
                if (!balRes || !decRes || !balRes.success || !decRes.success) {
                    resultMap.set(lc, { rawBalance: ethers.BigNumber.from(0), decimals: 18, formatted: '0' });
                    continue;
                }
                const rawBalance = ERC20_INTERFACE.decodeFunctionResult('balanceOf', balRes.returnData)[0];
                const decimals = ERC20_INTERFACE.decodeFunctionResult('decimals', decRes.returnData)[0];
                const formatted = ethers.utils.formatUnits(rawBalance, decimals);
                resultMap.set(lc, { rawBalance, decimals, formatted });
                // Update single balance cache too
                const cacheKey = `${lc}-${userAddress.toLowerCase()}`;
                balanceCache.set(cacheKey, { value: formatted, ts: Date.now() });
            } catch (_) {
                resultMap.set(lc, { rawBalance: ethers.BigNumber.from(0), decimals: 18, formatted: '0' });
            }
        }
        return resultMap;
    }

    // Fallback: per-token (still cached)
    for (const token of tokenAddresses) {
        try {
            const formatted = await getUserTokenBalance(token);
            const lc = token.toLowerCase();
            resultMap.set(lc, { rawBalance: null, decimals: null, formatted });
        } catch {
            const lc = token.toLowerCase();
            resultMap.set(lc, { rawBalance: null, decimals: null, formatted: '0' });
        }
    }
    return resultMap;
}

// Simple concurrency-limited map utility
async function mapWithConcurrency(items, mapper, concurrency = CONCURRENCY_LIMIT) {
    const results = new Array(items.length);
    let cursor = 0;

    async function worker() {
        while (true) {
            const idx = cursor++;
            if (idx >= items.length) break;
            try {
                results[idx] = await mapper(items[idx], idx);
            } catch (err) {
                error('mapWithConcurrency item failed:', err);
                results[idx] = null;
            }
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results.filter(r => r !== null);
}

// Removed older batch/delay logic in favor of concurrency-limited mapping

/**
 * Get allowed tokens from contract with metadata and balances
 * @returns {Promise<Array>} Array of token objects with metadata and balances
 */
export async function getContractAllowedTokens(options = {}) {
    try {
        const { includeBalances = true } = options;
        debug('Getting contract allowed tokens...');
        
        // Get allowed tokens from contract
        const allowedTokenAddresses = await contractService.getAllowedTokens();
        debug(`Found ${allowedTokenAddresses.length} allowed tokens:`, allowedTokenAddresses);

        if (allowedTokenAddresses.length === 0) {
            debug('No allowed tokens found');
            return [];
        }

        let balanceMap = new Map();
        if (includeBalances) {
            const userAddress = await contractService.getUserAddress();
            balanceMap = await getBatchTokenBalances(allowedTokenAddresses, userAddress);
        }

        // Process metadata and icons with concurrency limits
        const tokensWithData = await mapWithConcurrency(allowedTokenAddresses, async (address) => {
            try {
                const metadata = await getTokenMetadata(address);
                const lc = address.toLowerCase();
                const balanceEntry = balanceMap.get(lc);
                const balance = includeBalances ? (balanceEntry?.formatted || '0') : null;

                // Get icon URL from local map/cache.
                let iconUrl = null;
                try {
                    const networkConfig = getNetworkConfig();
                    const chainId = parseInt(networkConfig.chainId, 16);
                    iconUrl = await tokenIconService.getIconUrl(address, chainId);
                } catch (err) {
                    debug(`Icon fetch failed for ${address} (${metadata.symbol}):`, err?.message || err);
                }
                
                return {
                    address,
                    ...metadata,
                    balance,
                    balanceLoading: !includeBalances,
                    iconUrl
                };
            } catch (err) {
                error(`Error processing token ${address}:`, err);
                return {
                    address,
                    symbol: 'UNKNOWN',
                    name: 'Unknown Token',
                    decimals: 18,
                    balance: includeBalances ? '0' : null,
                    balanceLoading: !includeBalances
                };
            }
        });

        debug(`Successfully processed ${tokensWithData.length} tokens`);
        return tokensWithData;

    } catch (err) {
        error('Failed to get contract allowed tokens:', err);
        // Note: Toast notifications should be handled by calling components
        return [];
    }
}

/**
 * Get token metadata (symbol, name, decimals) - uses shared TokenMetadataCache
 * @param {string} tokenAddress - The token address
 * @returns {Promise<Object>} Token metadata
 */
async function getTokenMetadata(tokenAddress) {
    // Delegate to shared cache
    return tokenMetadataCache.fetch(tokenAddress);
}

/**
 * Get user's balance for a specific token
 * @param {string} tokenAddress - The token address
 * @returns {Promise<string>} Formatted balance string
 */
async function readUserTokenBalance(tokenAddress) {
    // Get user's wallet address using the same method as getAllWalletTokens
    const userAddress = await contractService.getUserAddress();
    if (!userAddress) {
        return '0';
    }

    // Cache check
    const cacheKey = `${tokenAddress.toLowerCase()}-${userAddress.toLowerCase()}`;
    const cached = balanceCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < BALANCE_CACHE_TTL_MS) {
        return cached.value;
    }
    
    // Balance reads should be HTTP-only; WS can flap during network switches.
    const provider = contractService.getHttpProvider() || contractService.getProvider();

    // First, try multicall for decimals and balanceOf (single ABI source: erc20.js)
    const calls = [
        { target: tokenAddress, callData: ERC20_INTERFACE.encodeFunctionData('balanceOf', [userAddress]) },
        { target: tokenAddress, callData: ERC20_INTERFACE.encodeFunctionData('decimals', []) }
    ];
    let rawBalance, decimals;
    const mcResult = await multicallTryAggregate(calls);
    if (mcResult) {
        try {
            rawBalance = ERC20_INTERFACE.decodeFunctionResult('balanceOf', mcResult[0].returnData)[0];
            decimals = ERC20_INTERFACE.decodeFunctionResult('decimals', mcResult[1].returnData)[0];
        } catch (_) {
            const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, provider);
            [rawBalance, decimals] = await Promise.all([
                tokenContract.balanceOf(userAddress),
                tokenContract.decimals()
            ]);
        }
    } else {
        const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, provider);
        [rawBalance, decimals] = await Promise.all([
            tokenContract.balanceOf(userAddress),
            tokenContract.decimals()
        ]);
    }

    const balance = ethers.utils.formatUnits(rawBalance, decimals);
    balanceCache.set(cacheKey, { value: balance, ts: Date.now() });
    return balance;
}

async function getUserTokenBalance(tokenAddress) {
    try {
        return await readUserTokenBalance(tokenAddress);
    } catch (err) {
        // Check if it's a rate limit error
        if (err.code === -32005 || err.message?.includes('rate limit')) {
            warn(`Rate limit hit while getting balance for token ${tokenAddress}, returning 0`);
            return '0';
        }
        
        debug(`Failed to get balance for token ${tokenAddress}:`, err);
        return '0';
    }
}

/**
 * Check if a token is allowed by the contract
 * @param {string} tokenAddress - The token address to check
 * @returns {Promise<boolean>} True if token is allowed
 */
export async function isTokenAllowed(tokenAddress) {
    try {
        return await contractService.isTokenAllowed(tokenAddress);
    } catch (err) {
        error(`Failed to check if token ${tokenAddress} is allowed:`, err);
        return false;
    }
}

/**
 * Get formatted balance information for display using cached/multicall-backed paths
 * @param {string} tokenAddress
 * @returns {Promise<
 *   | { type: 'ok', balance: string, symbol: string, decimals: number }
 *   | { type: 'unavailable', symbol: string, decimals: number }
 * >}
 */
export async function getTokenBalanceInfo(tokenAddress) {
    if (!tokenAddress || !ethers.utils.isAddress(tokenAddress)) {
        debug(`Invalid token address provided: ${tokenAddress}`);
        return { type: 'ok', balance: '0', symbol: 'N/A', decimals: 18 };
    }

    const { symbol, decimals } = await getTokenMetadata(tokenAddress)
        .then((metadata) => ({
            symbol: metadata.symbol ?? 'N/A',
            decimals: metadata.decimals ?? 18,
        }))
        .catch(() => ({ symbol: 'N/A', decimals: 18 }));

    const userAddress = await contractService.getUserAddress();
    if (!userAddress) {
        debug('Wallet not connected');
        return { type: 'ok', balance: '0', symbol, decimals };
    }

    try {
        const balance = await readUserTokenBalance(tokenAddress);
        return { type: 'ok', balance, symbol, decimals };
    } catch (err) {
        if (err.code === -32005 || err.message?.includes('rate limit')) {
            warn(`Rate limit hit while getting balance info for token ${tokenAddress}`);
        } else {
            debug(`Failed to get balance info for token ${tokenAddress}:`, err);
        }

        return { type: 'unavailable', symbol, decimals };
    }
}

/**
 * Clear balance cache only (balances are user-specific and should be invalidated on create/fill/cancel)
 */
export function clearBalanceCache() {
    balanceCache.clear();
    debug('Balance cache cleared');
}

/**
 * Clear all caches (metadata + balance) - use for network switch or full reset
 * Note: Token metadata cache is now managed by TokenMetadataCache service
 */
export function clearTokenCaches() {
    // Clear balance cache (local)
    balanceCache.clear();
    
    // Clear shared metadata cache for current network
    tokenMetadataCache.clearCurrentNetwork();

    debug('Token caches cleared (metadata + balance)');
}

/**
 * Clear all caches for all networks - use for wallet disconnect / full app reset
 */
export function clearAllTokenCaches() {
    balanceCache.clear();
    tokenMetadataCache.clearAll();
    debug('All token caches cleared (all networks)');
}

// Removed deprecated resetRateLimiting() - no longer needed with multicall + caching

/**
 * Get current rate limiting status for debugging
 * @returns {Object} Current rate limiting state
 */
export function getRateLimitingStatus() {
    return {
        queueLength: 0,
        isProcessingQueue: false,
        baseDelay: 0,
        maxConsecutiveErrors: 0,
        batchSize: 0
    };
}

/**
 * Get cache statistics (for debugging)
 * @returns {Object} Cache statistics
 */
export function getCacheStats() {
    return {
        tokenCacheSize: 0,
        metadataCacheSize: 0,
        balanceCacheSize: 0,
        cachingEnabled: false
    };
}

/**
 * Validate that the contract service is properly initialized
 * @returns {Promise<boolean>} True if contract service is valid
 */
export async function validateContractService() {
    try {
        return await contractService.validateContract();
    } catch (err) {
        error('Contract service validation failed:', err);
        return false;
    }
}

/**
 * Get contract information for debugging
 * @returns {Promise<Object>} Contract information
 */
export async function getContractInfo() {
    try {
        return await contractService.getContractInfo();
    } catch (err) {
        error('Failed to get contract info:', err);
        throw err;
    }
}

/**
 * Get wallet tokens available for swap (allowed tokens only)
 * @returns {Promise<Array>} Array of allowed token objects
 */
export async function getAllWalletTokens() {
    try {
        debug('Getting allowed wallet tokens...');
        
        // Fetch allowed tokens with metadata and balances
        const allowedTokens = await getContractAllowedTokens();

        // Mark allowed tokens
        const markedAllowedTokens = allowedTokens.map(token => ({
            ...token,
            isAllowed: true
        }));

        debug(`Successfully processed ${markedAllowedTokens.length} allowed tokens`);
        return markedAllowedTokens;

    } catch (err) {
        error('Failed to get all wallet tokens:', err);
        return [];
    }
}
