import { ethers } from 'ethers';
import { getNetworkConfig } from '../config/networks.js';
import { walletManager } from './WalletManager.js';
import { createLogger } from './LogService.js';

class ContractService {
    constructor() {
        this.initialized = false;
        this.webSocket = null; // Injected dependency
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
     * Run a read-only contract call via HTTP RPC (tries primary rpcUrl then fallbackRpcUrls).
     * Used for allowed-token reads to avoid WebSocket timeout on startup.
     * @param {function(ethers.Contract): Promise<any>} readFn - Function that receives the HTTP-backed contract and returns the read result
     * @returns {Promise<any>} Result of readFn(contract)
     * @private
     */
    async _readViaHttpRpc(readFn) {
        if (!this.initialized) {
            throw new Error('Contract service not initialized');
        }
        const net = getNetworkConfig();
        const rpcUrls = [net?.rpcUrl, ...(net?.fallbackRpcUrls || [])].filter(Boolean);
        if (rpcUrls.length === 0) {
            throw new Error('No HTTP RPC URL configured for current network');
        }
        let lastErr;
        for (const url of rpcUrls) {
            try {
                this.debug(`Trying HTTP RPC: ${url}`);
                const httpProvider = new ethers.providers.JsonRpcProvider(url);
                const httpContract = new ethers.Contract(net.contractAddress, net.contractABI, httpProvider);
                const result = await readFn(httpContract);
                this.debug(`HTTP RPC succeeded: ${url}`);
                return result;
            } catch (e) {
                lastErr = e;
                this.warn(`HTTP RPC failed (${url}):`, e?.message || e);
                continue;
            }
        }
        throw lastErr || new Error('All HTTP RPC URLs failed');
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
