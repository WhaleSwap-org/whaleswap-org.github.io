import { ethers } from 'ethers';
import { getNetworkConfig } from '../config/networks.js';
import { walletManager } from './WalletManager.js';
import { createLogger } from './LogService.js';

class ContractService {
    constructor() {
        this.initialized = false;
        this.webSocket = null; // Injected dependency
        this.lastSuccessfulRpcUrl = null; // Track successful RPC URL for subsequent calls
        // Initialize logger per instance
        const logger = createLogger('CONTRACT_SERVICE');
        this.debug = logger.debug.bind(logger);
        this.error = logger.error.bind(logger);
        this.warn = logger.warn.bind(logger);
    }

    /**
     * Initialize the contract service (uses existing WebSocket instances)
     * @param {Object} options - Optional initialization options
     * @param {Object} options.webSocket - WebSocket service instance
     */
    initialize(options = {}) {
        if (options.webSocket) {
            this.webSocket = options.webSocket;
        }
        this.initialized = true;
        this.lastSuccessfulRpcUrl = null; // Reset on re-initialization (network change)
        this.debug('Contract service initialized');
    }

    /**
     * Get the contract instance from WebSocket service
     * @returns {ethers.Contract|null} The contract instance
     */
    getContract() {
        if (!this.initialized) {
            throw new Error('Contract service not initialized');
        }
        const ws = this.webSocket;
        if (!ws?.contract) {
            throw new Error('WebSocket contract not available');
        }
        return ws.contract;
    }

    /**
     * Get the provider instance from WebSocket service
     * @returns {ethers.providers.Provider|null} The provider instance
     */
    getProvider() {
        if (!this.initialized) {
            throw new Error('Contract service not initialized');
        }
        const ws = this.webSocket;
        if (!ws?.provider) {
            throw new Error('WebSocket provider not available');
        }
        return ws.provider;
    }

    /**
     * Get configured HTTP RPC URLs for the active network.
     * @returns {string[]} Primary RPC followed by configured fallbacks
     */
    getHttpRpcUrls() {
        const net = getNetworkConfig();
        return [net?.rpcUrl, ...(net?.fallbackRpcUrls || [])].filter(Boolean);
    }

    /**
     * Get an HTTP provider for the current network.
     * Prefers the last successful RPC URL if available, otherwise uses primary rpcUrl.
     * @returns {ethers.providers.JsonRpcProvider|null} HTTP provider or null if not configured
     */
    getHttpProvider() {
        const rpcUrls = this.getHttpRpcUrls();
        if (rpcUrls.length === 0) {
            this.warn('No HTTP RPC URL configured for current network');
            return null;
        }
        // Use last successful URL if available, otherwise primary
        const url = this.lastSuccessfulRpcUrl || rpcUrls[0];
        return new ethers.providers.JsonRpcProvider(url);
    }

    /**
     * Run a read-only contract call via HTTP RPC (tries primary rpcUrl then fallbackRpcUrls).
     * Used for allowed-token reads to avoid WebSocket timeout on startup.
     * @param {function({ provider: ethers.providers.JsonRpcProvider, contract: ethers.Contract|null, url: string, networkConfig: object }): Promise<any>} readFn
     * @param {Object} options
     * @param {string} [options.contractAddress]
     * @param {Array|Object} [options.contractAbi]
     * @returns {Promise<any>} Result of readFn(contract)
     */
    async readViaHttpRpc(readFn, options = {}) {
        if (!this.initialized) {
            throw new Error('Contract service not initialized');
        }

        const net = getNetworkConfig();
        const rpcUrls = this.getHttpRpcUrls();
        if (rpcUrls.length === 0) {
            throw new Error('No HTTP RPC URL configured for current network');
        }

        const contractAddress = options.contractAddress ?? net?.contractAddress ?? null;
        const contractAbi = options.contractAbi ?? net?.contractABI ?? null;
        let lastErr;

        for (const url of rpcUrls) {
            try {
                this.debug(`Trying HTTP RPC: ${url}`);
                const httpProvider = new ethers.providers.JsonRpcProvider(url);
                const httpContract = contractAddress && contractAbi
                    ? new ethers.Contract(contractAddress, contractAbi, httpProvider)
                    : null;
                const result = await readFn({
                    provider: httpProvider,
                    contract: httpContract,
                    url,
                    networkConfig: net
                });
                this.debug(`HTTP RPC succeeded: ${url}`);
                // Track successful URL for subsequent calls
                this.lastSuccessfulRpcUrl = url;
                return result;
            } catch (e) {
                lastErr = e;
                this.warn(`HTTP RPC failed (${url}):`, e?.message || e);
                continue;
            }
        }
        throw lastErr || new Error('All HTTP RPC URLs failed');
    }

    async _readViaHttpRpc(readFn) {
        console.log('[CONTRACT_SERVICE] _readViaHttpRpc called');
        return this.readViaHttpRpc(({ contract }) => readFn(contract));
    }

    /**
     * Get all allowed tokens from the contract (via HTTP RPC to avoid WS timeout on startup).
     * @returns {Promise<string[]>} Array of allowed token addresses
     */
    async getAllowedTokens() {
        try {
            this.debug('Fetching allowed tokens from contract via HTTP RPC...');
            const allowedTokens = await this._readViaHttpRpc((contract) => contract.getAllowedTokens());
            this.debug(`Found ${allowedTokens.length} allowed tokens`);
            return allowedTokens;
        } catch (error) {
            this.error('Failed to get allowed tokens:', error);
            throw new Error(`Failed to get allowed tokens: ${error.message}`);
        }
    }

    /**
     * Get the count of allowed tokens (via HTTP RPC to avoid WS timeout on startup).
     * @returns {Promise<number>} Number of allowed tokens
     */
    async getAllowedTokensCount() {
        try {
            this.debug('Fetching allowed tokens count via HTTP RPC...');
            const count = await this._readViaHttpRpc((contract) => contract.getAllowedTokensCount());
            this.debug(`Allowed tokens count: ${count}`);
            return count.toNumber();
        } catch (error) {
            this.error('Failed to get allowed tokens count:', error);
            throw new Error(`Failed to get allowed tokens count: ${error.message}`);
        }
    }

    /**
     * Get the fee token address (via HTTP RPC to avoid WS timeout on startup).
     * @returns {Promise<string>} Fee token address
     */
    async getFeeToken() {
        try {
            this.debug('Fetching fee token address via HTTP RPC...');
            const feeToken = await this._readViaHttpRpc((contract) => contract.feeToken());
            this.debug(`Fee token: ${feeToken}`);
            return feeToken;
        } catch (error) {
            this.error('Failed to get fee token:', error);
            throw new Error(`Failed to get fee token: ${error.message}`);
        }
    }

    /**
     * Get the order creation fee amount (via HTTP RPC to avoid WS timeout on startup).
     * @returns {Promise<ethers.BigNumber>} Fee amount
     */
    async getOrderCreationFeeAmount() {
        try {
            this.debug('Fetching order creation fee amount via HTTP RPC...');
            const feeAmount = await this._readViaHttpRpc((contract) => contract.orderCreationFeeAmount());
            this.debug(`Order creation fee: ${feeAmount.toString()}`);
            return feeAmount;
        } catch (error) {
            this.error('Failed to get order creation fee amount:', error);
            throw new Error(`Failed to get order creation fee amount: ${error.message}`);
        }
    }

    /**
     * Get fee configuration (fee token and amount) in a single call (via HTTP RPC).
     * @returns {Promise<{feeToken: string, feeAmount: ethers.BigNumber}>}
     */
    async getFeeConfig() {
        try {
            this.debug('Fetching fee config via HTTP RPC...');
            const result = await this.readViaHttpRpc(({ contract }) => {
                return Promise.all([
                    contract.feeToken(),
                    contract.orderCreationFeeAmount()
                ]);
            });
            const [feeToken, feeAmount] = result;
            this.debug(`Fee config: token=${feeToken}, amount=${feeAmount.toString()}`);
            return { feeToken, feeAmount };
        } catch (error) {
            this.error('Failed to get fee config:', error);
            throw new Error(`Failed to get fee config: ${error.message}`);
        }
    }

    /**
     * Check if a specific token is allowed
     * @param {string} tokenAddress - The token address to check
     * @returns {Promise<boolean>} True if token is allowed
     */
    async isTokenAllowed(tokenAddress) {
        try {
            const contract = this.getContract();
            
            if (!ethers.utils.isAddress(tokenAddress)) {
                return false;
            }

            this.debug(`Checking if token ${tokenAddress} is allowed...`);
            const isAllowed = await contract.allowedTokens(tokenAddress);
            this.debug(`Token ${tokenAddress} allowed: ${isAllowed}`);
            
            return isAllowed;
        } catch (err) {
            this.error('Failed to check if token is allowed:', err);
            return false;
        }
    }

    /**
     * Get the current user's wallet address
     * @returns {Promise<string|null>} User's wallet address or null if not connected
     */
    async getUserAddress() {
        try {
            // Use the existing wallet manager to get the current address
            const address = await walletManager.getCurrentAddress();
            
            if (address) {
                this.debug(`User address: ${address}`);
                return address;
            }
            
            this.debug('No wallet address available - user not connected');
            return null;
        } catch (err) {
            this.error('Failed to get user address:', err);
            return null;
        }
    }

    /**
     * Validate that the contract has the required functions
     * @returns {Promise<boolean>} True if contract has required functions
     */
    async validateContract() {
        try {
            const contract = this.getContract();
            this.debug('Validating contract functions...');
            
            // Check if required functions exist
            const hasGetAllowedTokens = typeof contract.getAllowedTokens === 'function';
            const hasGetAllowedTokensCount = typeof contract.getAllowedTokensCount === 'function';
            const hasAllowedTokens = typeof contract.allowedTokens === 'function';

            if (!hasGetAllowedTokens || !hasGetAllowedTokensCount || !hasAllowedTokens) {
                this.error('Contract missing required functions');
                return false;
            }

            // Test the functions
            await this.getAllowedTokensCount();
            this.debug('Contract validation successful');
            
            return true;
        } catch (err) {
            this.error('Contract validation failed:', err);
            return false;
        }
    }

    /**
     * Get contract information for debugging
     * @returns {Promise<Object>} Contract information
     */
    async getContractInfo() {
        try {
            // Ensure contract is available
            this.getContract();

            const networkConfig = getNetworkConfig();
            const allowedTokensCount = await this.getAllowedTokensCount();
            const allowedTokens = await this.getAllowedTokens();

            return {
                address: networkConfig.contractAddress,
                network: networkConfig.name,
                allowedTokensCount,
                allowedTokens: allowedTokens.slice(0, 5), // First 5 for display
                hasMoreTokens: allowedTokens.length > 5
            };
        } catch (err) {
            this.error('Failed to get contract info:', err);
            throw err;
        }
    }
}

// Create singleton instance
const contractService = new ContractService();

export { ContractService, contractService };
