import { ethers } from 'ethers';
import { getNetworkConfig } from '../config.js';
import { contractService } from '../services/ContractService.js';
import { createLogger } from '../services/LogService.js';
import { tokenIconService } from '../services/TokenIconService.js';
import { tryAggregate as multicallTryAggregate } from '../services/MulticallService.js';

// Initialize logger
const logger = createLogger('CONTRACT_TOKENS');
const debug = logger.debug.bind(logger);
const error = logger.error.bind(logger);
const warn = logger.warn.bind(logger);

// Concurrency control
const CONCURRENCY_LIMIT = 5; // Max concurrent metadata/icon tasks

// No global rate limiting state needed with multicall + caching

// Simple in-memory caches
const TOKEN_METADATA_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const BALANCE_CACHE_TTL_MS = 30 * 1000; // 30 seconds
const tokenMetadataCache = new Map(); // key: tokenAddress (lowercase) -> { value, ts }
const balanceCache = new Map(); // key: `${token}-${user}` -> { value, ts }
const LIBERDUS_ADDRESS = '0x693ed886545970f0a3adf8c59af5ccdb6ddf0a76';
const LIBERDUS_METADATA = {
    symbol: 'LIB',
    name: 'Liberdus',
    decimals: 18
};

/**
 * Batch fetch balances and decimals for many tokens using multicall
 * Returns a map of lowercase tokenAddress -> { rawBalance, decimals, formatted }
 */
async function getBatchTokenBalances(tokenAddresses, userAddress) {
    const resultMap = new Map();
    if (!tokenAddresses || tokenAddresses.length === 0 || !userAddress) {
        return resultMap;
    }

    // Prepare calls: for each token, balanceOf + decimals
    const iface = new ethers.utils.Interface([
        'function balanceOf(address) view returns (uint256)',
        'function decimals() view returns (uint8)'
    ]);

    const calls = [];
    for (const token of tokenAddresses) {
        calls.push({ target: token, callData: iface.encodeFunctionData('balanceOf', [userAddress]) });
        calls.push({ target: token, callData: iface.encodeFunctionData('decimals') });
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
                const rawBalance = iface.decodeFunctionResult('balanceOf', balRes.returnData)[0];
                const decimals = iface.decodeFunctionResult('decimals', decRes.returnData)[0];
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
export async function getContractAllowedTokens() {
    try {
        debug('Getting contract allowed tokens...');
        
        // Get allowed tokens from contract
        const allowedTokenAddresses = await contractService.getAllowedTokens();
        debug(`Found ${allowedTokenAddresses.length} allowed tokens:`, allowedTokenAddresses);

        if (allowedTokenAddresses.length === 0) {
            debug('No allowed tokens found');
            return [];
        }

        // Fetch all balances in a single multicall
        const userAddress = await contractService.getUserAddress();
        const balanceMap = await getBatchTokenBalances(allowedTokenAddresses, userAddress);

        // Process metadata and icons with concurrency limits
        const tokensWithData = await mapWithConcurrency(allowedTokenAddresses, async (address) => {
            try {
                const metadata = await getTokenMetadata(address);
                const lc = address.toLowerCase();
                const balanceEntry = balanceMap.get(lc);
                const balance = balanceEntry?.formatted || '0';

                // Get icon URL (deferred priority)
                let iconUrl = null;
                try {
                    await new Promise(resolve => setTimeout(resolve, 150));
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
                    iconUrl
                };
            } catch (err) {
                error(`Error processing token ${address}:`, err);
                return {
                    address,
                    symbol: 'UNKNOWN',
                    name: 'Unknown Token',
                    decimals: 18,
                    balance: '0'
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
 * Get token metadata (symbol, name, decimals)
 * @param {string} tokenAddress - The token address
 * @returns {Promise<Object>} Token metadata
 */
async function getTokenMetadata(tokenAddress) {
    try {
        // Cache lookup first
        const normalizedAddress = tokenAddress.toLowerCase();
        const cached = tokenMetadataCache.get(normalizedAddress);
        if (cached && (Date.now() - cached.ts) < TOKEN_METADATA_CACHE_TTL_MS) {
            return cached.value;
        }
        // Always normalize Liberdus naming regardless of token contract metadata
        if (normalizedAddress === LIBERDUS_ADDRESS) {
            tokenMetadataCache.set(normalizedAddress, { value: LIBERDUS_METADATA, ts: Date.now() });
            return LIBERDUS_METADATA;
        }
        // Known token fallbacks for common tokens
        const knownTokens = {
            // Polygon Mainnet tokens
            '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': {
                symbol: 'WBTC',
                name: 'Wrapped Bitcoin',
                decimals: 8
            },
            '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': {
                symbol: 'USDC',
                name: 'USD Coin',
                decimals: 6
            },
            // BNB Chain tokens
            '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': {
                symbol: 'USDC',
                name: 'USD Coin',
                decimals: 18
            },
            '0x0555e30da8f98308edb960aa94c0db47230d2b9c': {
                symbol: 'WBTC',
                name: 'Wrapped Bitcoin',
                decimals: 8
            },
            '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': {
                symbol: 'USDT',
                name: 'Tether USD',
                decimals: 6
            },
            [LIBERDUS_ADDRESS]: LIBERDUS_METADATA,
            '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': {
                symbol: 'WETH',
                name: 'Wrapped Ether',
                decimals: 18
            },
            '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': {
                symbol: 'WPOL',
                name: 'Wrapped Polygon Ecosystem Token',
                decimals: 18
            },
        };

        // Check if we have known metadata for this token
        const knownToken = knownTokens[normalizedAddress];
        
        if (knownToken) {
            debug(`Using known metadata for ${knownToken.symbol}`);
            tokenMetadataCache.set(normalizedAddress, { value: knownToken, ts: Date.now() });
            return knownToken;
        }

        const provider = contractService.getProvider();

        // Prepare multicall for symbol, name, decimals
        const iface = new ethers.utils.Interface([
            'function symbol() view returns (string)',
            'function name() view returns (string)',
            'function decimals() view returns (uint8)'
        ]);
        const calls = [
            { target: tokenAddress, callData: iface.encodeFunctionData('symbol') },
            { target: tokenAddress, callData: iface.encodeFunctionData('name') },
            { target: tokenAddress, callData: iface.encodeFunctionData('decimals') }
        ];

        let symbol, name, decimals;
        const mcResult = await multicallTryAggregate(calls);
        if (mcResult) {
            // Decode gracefully; if any fail, fallback to direct
            try {
                symbol = iface.decodeFunctionResult('symbol', mcResult[0].returnData)[0];
                name = iface.decodeFunctionResult('name', mcResult[1].returnData)[0];
                decimals = iface.decodeFunctionResult('decimals', mcResult[2].returnData)[0];
            } catch (_) {
                const tokenContract = new ethers.Contract(tokenAddress, [
                    'function symbol() view returns (string)',
                    'function name() view returns (string)',
                    'function decimals() view returns (uint8)'
                ], provider);
                [symbol, name, decimals] = await Promise.all([
                    tokenContract.symbol(),
                    tokenContract.name(),
                    tokenContract.decimals()
                ]);
            }
        } else {
            const tokenContract = new ethers.Contract(tokenAddress, [
                'function symbol() view returns (string)',
                'function name() view returns (string)',
                'function decimals() view returns (uint8)'
            ], provider);
            [symbol, name, decimals] = await Promise.all([
            tokenContract.symbol(),
            tokenContract.name(),
            tokenContract.decimals()
        ]);
        }

        const metadata = {
            symbol,
            name,
            decimals: parseInt(decimals)
        };

        tokenMetadataCache.set(normalizedAddress, { value: metadata, ts: Date.now() });
        return metadata;

    } catch (err) {
        // Check if it's a rate limit error
        if (err.code === -32005 || err.message?.includes('rate limit')) {
            warn(`Rate limit hit while getting metadata for token ${tokenAddress}, using fallback`);
            
            // Return fallback metadata for rate-limited requests
            const fallbackMetadata = {
                symbol: 'UNKNOWN',
                name: 'Unknown Token',
                decimals: 18
            };
            
            tokenMetadataCache.set(tokenAddress.toLowerCase(), { value: fallbackMetadata, ts: Date.now() });
            return fallbackMetadata;
        }
        
        error(`Failed to get metadata for token ${tokenAddress}:`, err);
        
        // Return fallback metadata
        const fallbackMetadata = {
            symbol: 'UNKNOWN',
            name: 'Unknown Token',
            decimals: 18
        };
        tokenMetadataCache.set(tokenAddress.toLowerCase(), { value: fallbackMetadata, ts: Date.now() });
        return fallbackMetadata;
    }
}

/**
 * Get user's balance for a specific token
 * @param {string} tokenAddress - The token address
 * @returns {Promise<string>} Formatted balance string
 */
async function getUserTokenBalance(tokenAddress) {
    try {
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
        
        const provider = contractService.getProvider();

        // First, try multicall for decimals and balanceOf
        const iface = new ethers.utils.Interface([
            'function balanceOf(address) view returns (uint256)',
            'function decimals() view returns (uint8)'
        ]);
        const calls = [
            { target: tokenAddress, callData: iface.encodeFunctionData('balanceOf', [userAddress]) },
            { target: tokenAddress, callData: iface.encodeFunctionData('decimals') }
        ];
        let rawBalance, decimals;
        const mcResult = await multicallTryAggregate(calls);
        if (mcResult) {
            try {
                rawBalance = iface.decodeFunctionResult('balanceOf', mcResult[0].returnData)[0];
                decimals = iface.decodeFunctionResult('decimals', mcResult[1].returnData)[0];
            } catch (_) {
                const tokenContract = new ethers.Contract(tokenAddress, [
                    'function balanceOf(address) view returns (uint256)',
                    'function decimals() view returns (uint8)'
                ], provider);
                [rawBalance, decimals] = await Promise.all([
                    tokenContract.balanceOf(userAddress),
                    tokenContract.decimals()
                ]);
            }
        } else {
            const tokenContract = new ethers.Contract(tokenAddress, [
                'function balanceOf(address) view returns (uint256)',
                'function decimals() view returns (uint8)'
            ], provider);
            [rawBalance, decimals] = await Promise.all([
            tokenContract.balanceOf(userAddress),
            tokenContract.decimals()
        ]);
        }

        const balance = ethers.utils.formatUnits(rawBalance, decimals);
        balanceCache.set(cacheKey, { value: balance, ts: Date.now() });
        return balance;

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
 * @returns {Promise<{balance: string, symbol: string, decimals: number}>}
 */
export async function getTokenBalanceInfo(tokenAddress) {
    try {
        if (!tokenAddress || !ethers.utils.isAddress(tokenAddress)) {
            debug(`Invalid token address provided: ${tokenAddress}`);
            return { balance: '0', symbol: 'N/A', decimals: 18 };
        }

        const userAddress = await contractService.getUserAddress();
        if (!userAddress) {
            debug('Wallet not connected');
            const md = await getTokenMetadata(tokenAddress).catch(() => ({ symbol: 'N/A', decimals: 18 }));
            return { balance: '0', symbol: md.symbol ?? 'N/A', decimals: md.decimals ?? 18 };
        }

        const metadata = await getTokenMetadata(tokenAddress);
        const balance = await getUserTokenBalance(tokenAddress);
        return {
            balance: balance || '0',
            symbol: metadata.symbol ?? 'N/A',
            decimals: metadata.decimals ?? 18
        };
    } catch (err) {
        if (err.code === -32005 || err.message?.includes('rate limit')) {
            warn(`Rate limit hit while getting balance info for token ${tokenAddress}`);
            return { balance: '0', symbol: 'N/A', decimals: 18 };
        }
        debug(`Failed to get balance info for token ${tokenAddress}:`, err);
        return { balance: '0', symbol: 'N/A', decimals: 18 };
    }
}

/**
 * Clear all caches (useful for testing or when switching networks)
 */
export function clearTokenCaches() {
    tokenMetadataCache.clear();
    balanceCache.clear();
    debug('Token caches cleared');
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
 * Get all tokens in user's wallet (both allowed and not allowed)
 * @returns {Promise<Object>} Object with allowed and notAllowed token arrays
 */
export async function getAllWalletTokens() {
    try {
        debug('Getting all wallet tokens...');
        
        // Get allowed tokens only (no wallet scanning)
        const allowedTokens = await getContractAllowedTokens();
        
        // Get user's wallet address
        const userAddress = await contractService.getUserAddress();
        if (!userAddress) {
            debug('No user address available');
            return { allowed: allowedTokens, notAllowed: [] };
        }

        // Mark allowed tokens
        const markedAllowedTokens = allowedTokens.map(token => ({
            ...token,
            isAllowed: true
        }));

        const result = {
            allowed: markedAllowedTokens,
            notAllowed: []
        };

        debug(`Successfully processed ${markedAllowedTokens.length} allowed tokens`);
        return result;

    } catch (err) {
        error('Failed to get all wallet tokens:', err);
        return { allowed: [], notAllowed: [] };
    }
}
