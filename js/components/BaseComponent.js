import { walletManager } from '../services/WalletManager.js';
import { ethers } from 'ethers';
import { erc20Abi } from '../abi/erc20.js';
import { createLogger } from '../services/LogService.js';
import { getAppContext } from '../services/AppContext.js';

/**
 * BaseComponent - Base class for all UI components
 * 
 * LIFECYCLE CONTRACT:
 * 
 * 1. constructor(containerId)
 *    - MUST be side-effect free (no network calls, no event subscriptions)
 *    - Sets up container reference and default state
 *    - Initializes logger
 * 
 * 2. setContext(ctx) [optional]
 *    - Called by App to inject dependencies
 *    - Provides access to wallet, websocket, pricing, toast services
 * 
 * 3. initialize(readOnlyMode = true)
 *    - Called by App when component should set up
 *    - Handles rendering, event subscriptions, data loading
 *    - readOnlyMode=true means no wallet connected
 *    - Should be idempotent (safe to call multiple times)
 * 
 * 4. cleanup()
 *    - Called by App before switching away from component
 *    - Removes event listeners, clears timers, unsubscribes from services
 *    - Should NOT clear rendered content (preserve for quick tab switches)
 * 
 * INITIALIZATION FLAGS:
 * - this.initialized: true after first successful initialize()
 * - this.initializing: true while initialize() is running (prevents concurrent calls)
 * 
 * Note: Components use isInitialized/isInitializing properties via getters/setters for consistency.
 */
export class BaseComponent {
    constructor(containerId) {
        // Initialize logger
        const logger = createLogger('BASE_COMPONENT');
        this.debug = logger.debug.bind(logger);
        this.error = logger.error.bind(logger);
        this.warn = logger.warn.bind(logger);

        this.debug('Constructor called with:', containerId);
        this.container = document.querySelector(`#${containerId}, .${containerId}`);
        if (!this.container) {
            this.error(`Container not found: ${containerId}`);
            throw new Error(`Container with id or class ${containerId} not found`);
        }
        
        // Standardized initialization flags
        this.initialized = false;
        this.initializing = false;
        
        // App context (injected via setContext, falls back to global)
        this._ctx = null;
        
        // Token cache removed - use WebSocketService.getTokenInfo() via ctx.getWebSocket()
        // Balance cache for user-specific balance lookups
        this.balanceCache = new Map();
        
        // Provider is accessed lazily via getProvider() to ensure we get the latest from context
        this._provider = null;
    }
    
    /**
     * Set the application context for this component
     * @param {import('../services/AppContext.js').AppContext} ctx
     */
    setContext(ctx) {
        this._ctx = ctx;
    }
    
    /**
     * Get the application context (must be injected via setContext())
     * @returns {import('../services/AppContext.js').AppContext}
     * @throws {Error} if context not set
     */
    get ctx() {
        if (!this._ctx) {
            // Fallback to global context as last resort (shouldn't be needed)
            const globalCtx = getAppContext();
            if (!globalCtx || !globalCtx.isReady()) {
                this.error('AppContext not set on component. Call setContext() before using this component.');
            }
            return globalCtx;
        }
        return this._ctx;
    }
    
    /**
     * Get the provider from walletManager via context
     * Returns the connected wallet provider or null if not connected
     * @returns {ethers.providers.Web3Provider|null}
     */
    get provider() {
        // If explicitly set, use that
        if (this._provider) return this._provider;
        
        // Otherwise get from wallet manager via context
        const wallet = this.ctx.getWallet();
        return wallet?.provider || null;
    }
    
    /**
     * Allow explicit provider override for components that need it
     * @param {ethers.providers.Provider} value
     */
    set provider(value) {
        this._provider = value;
    }

    // Standardized initialization state accessors
    get isInitialized() {
        return this.initialized;
    }
    
    set isInitialized(value) {
        this.initialized = value;
    }
    
    get isInitializing() {
        return this.initializing;
    }
    
    set isInitializing(value) {
        this.initializing = value;
    }

    createElement(tag, className = '', textContent = '') {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (textContent) element.textContent = textContent;
        return element;
    }

    /**
     * Show error toast via AppContext (with global fallback)
     * @param {string} message - Error message to display
     * @param {number} duration - Display duration in ms (0 = persistent)
     */
    showError(message, duration = 0) {
        this.debug('Showing error toast:', message);
        this.ctx.showError(message, duration);
    }

    /**
     * Show success toast via AppContext (with global fallback)
     * @param {string} message - Success message to display
     * @param {number} duration - Display duration in ms
     */
    showSuccess(message, duration = 5000) {
        this.debug('Showing success toast:', message);
        this.ctx.showSuccess(message, duration);
    }

    /**
     * Show warning toast via AppContext (with global fallback)
     * @param {string} message - Warning message to display
     * @param {number} duration - Display duration in ms
     */
    showWarning(message, duration = 5000) {
        this.debug('Showing warning toast:', message);
        this.ctx.showWarning(message, duration);
    }

    /**
     * Show info toast via AppContext (with global fallback)
     * @param {string} message - Info message to display
     * @param {number} duration - Display duration in ms
     */
    showInfo(message, duration = 5000) {
        this.debug('Showing info toast:', message);
        this.ctx.showInfo(message, duration);
    }

    /**
     * Default initialize method - subclasses should override
     * @param {boolean} readOnlyMode - true if no wallet connected
     */
    async initialize(readOnlyMode = true) {
        // Default implementation - subclasses override
        if (!this.initialized) {
            this.initialized = true;
        }
    }

    /**
     * Default cleanup method - subclasses should override
     * Cleans up event listeners, timers, subscriptions
     */
    cleanup() {
        // Default implementation - subclasses override
        this.debug('Base cleanup called');
    }


    // Add method to get contract (used by CreateOrder)
    async getContract() {
        try {
            // If we're in read-only mode, return null without throwing
            const wallet = this.ctx.getWallet();
            if (!wallet?.provider) {
                this.debug('No wallet connected - running in read-only mode');
                return null;
            }

            // Wallet should be initialized by this point (app initializes wallet before components)
            const contract = await wallet.getContract();
            if (!contract) {
                this.warn('Contract not initialized');
                return null;
            }
            return contract;
        } catch (error) {
            this.error('Error getting contract:', error);
            return null;
        }
    }

    // Add method to get signer (used by CreateOrder)
    async getSigner() {
        try {
            const wallet = this.ctx.getWallet();
            if (!wallet?.provider) {
                this.error('No wallet provider available');
                throw new Error('Please connect your wallet first');
            }
            this.signer = await wallet.provider.getSigner();
            return this.signer;
        } catch (error) {
            this.error('Error getting signer:', error);
            throw error;
        }
    }

    /**
     * Get token details for one or more addresses
     * Uses WebSocket's centralized token cache for symbol/decimals/name,
     * and fetches balance on-demand for the connected user.
     * 
     * @param {string|string[]} tokenAddresses - Token address(es) to look up
     * @returns {Promise<Object[]>} Array of token details with balance info
     */
    async getTokenDetails(tokenAddresses) {
        try {
            this.debug('Getting token details for:', tokenAddresses);
            
            // Ensure tokenAddresses is always an array
            const addressArray = Array.isArray(tokenAddresses) ? tokenAddresses : [tokenAddresses];
            
            // Get signer for balance check
            let userAddress = null;
            try {
                const signer = await this.getSigner().catch(() => null);
                userAddress = signer ? await signer.getAddress() : null;
            } catch (error) {
                this.debug('No signer available - skipping balance check');
            }

            const validAddresses = addressArray
                .filter(addr => typeof addr === 'string' && ethers.utils.isAddress(addr))
                .map(addr => addr.toLowerCase());

            if (validAddresses.length === 0) {
                this.warn('No valid token addresses provided');
                return addressArray.map(() => null);
            }

            // Get WebSocket service for centralized token cache
            const ws = this.ctx.getWebSocket();

            const results = await Promise.all(validAddresses.map(async (tokenAddress) => {
                try {
                    // Use WebSocket's centralized token cache for symbol/decimals/name
                    // WebSocket is always available via context
                    if (!ws || typeof ws.getTokenInfo !== 'function') {
                        this.warn('WebSocket service not available for token info');
                        return null;
                    }
                    
                    const tokenInfo = await ws.getTokenInfo(tokenAddress);
                    if (!tokenInfo) {
                        this.warn(`Token info not found for: ${tokenAddress}`);
                        return null;
                    }
                    
                    // Fetch balance if user is connected
                    let balance = '0';
                    let formattedBalance = '0';
                    if (userAddress) {
                        const tokenContract = new ethers.Contract(
                            tokenAddress,
                            erc20Abi,
                            this.provider
                        );
                        balance = await tokenContract.balanceOf(userAddress).catch(() => '0');
                        formattedBalance = ethers.utils.formatUnits(balance, tokenInfo.decimals);
                    }
                    
                    return {
                        ...tokenInfo,
                        address: tokenAddress,
                        balance,
                        formattedBalance
                    };
                } catch (error) {
                    this.debug('Error fetching token details:', {
                        address: tokenAddress,
                        error: error.message
                    });
                    return null;
                }
            }));

            return results;
        } catch (error) {
            this.error('Error in getTokenDetails:', error);
            return Array.isArray(tokenAddresses) ? tokenAddresses.map(() => null) : null;
        }
    }

    // New helper method to determine if an error is retryable
    isRetryableError(error) {
        const retryableCodes = [-32603, -32000]; // Common RPC error codes
        const retryableMessages = [
            'header not found',
            'Internal JSON-RPC error',
            'timeout',
            'network error',
            'missing response',
            'missing trie node',
            'connection reset',
            'connection refused'
        ];

        // Check RPC error codes
        const rpcCode = error.error?.code || error.code;
        if (retryableCodes.includes(rpcCode)) {
            this.debug('Retryable RPC code detected:', rpcCode);
            return true;
        }

        // Check error messages
        const errorMessage = (error.message || '').toLowerCase();
        const rpcMessage = (error.error?.message || '').toLowerCase();
        const dataMessage = (error.data?.message || '').toLowerCase();

        const hasRetryableMessage = retryableMessages.some(msg => 
            errorMessage.includes(msg.toLowerCase()) ||
            rpcMessage.includes(msg.toLowerCase()) ||
            dataMessage.includes(msg.toLowerCase())
        );

        if (hasRetryableMessage) {
            this.debug('Retryable message detected:', {
                errorMessage,
                rpcMessage,
                dataMessage
            });
            return true;
        }

        return false;
    }

    // New helper method for detailed error logging
    logDetailedError(prefix, error) {
        const errorDetails = {
            message: error.message,
            code: error.code,
            data: error.data,
            reason: error.reason,
            // RPC specific details
            rpcError: error.error?.data || error.data,
            rpcCode: error.error?.code || error.code,
            rpcMessage: error.error?.message,
            // Transaction details if available
            transaction: error.transaction && {
                from: error.transaction.from,
                to: error.transaction.to,
                data: error.transaction.data,
                value: error.transaction.value?.toString(),
            },
            // Receipt if available
            receipt: error.receipt && {
                status: error.receipt.status,
                gasUsed: error.receipt.gasUsed?.toString(),
                blockNumber: error.receipt.blockNumber,
            },
            // Stack trace
            stack: error.stack,
        };

        this.error('Detailed error:', prefix, errorDetails);
        return errorDetails;
    }

    // Modified retry call with better logging
    async retryCall(fn, maxRetries = 3, delay = 1000) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                this.debug(`Attempt ${i + 1}/${maxRetries}`);
                return await fn();
            } catch (error) {
                const errorDetails = this.logDetailedError(
                    `Attempt ${i + 1} failed:`,
                    error
                );

                const isRetryable = this.isRetryableError(error);
                this.debug('Error is retryable:', isRetryable, {
                    errorCode: errorDetails.code,
                    rpcCode: errorDetails.rpcCode,
                    message: errorDetails.message
                });

                if (i === maxRetries - 1 || !isRetryable) {
                    this.error('Max retries reached or non-retryable error');
                    throw error;
                }
                
                const waitTime = delay * Math.pow(2, i);
                this.warn(`Retrying in ${waitTime}ms...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
    }
}
