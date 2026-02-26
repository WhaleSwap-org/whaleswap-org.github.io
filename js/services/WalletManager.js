import { ethers } from 'ethers';
import { abi as CONTRACT_ABI } from '../abi/OTCSwap.js';
import { createLogger } from './LogService.js';
import {
    getActiveNetwork,
    getNetworkConfig,
    getNetworkById,
    getNetworkBySlug,
    setActiveNetwork
} from '../config/networks.js';

const normalizeChainId = (chainId) => {
    if (chainId === null || chainId === undefined) {
        return null;
    }

    const chainIdStr = String(chainId).toLowerCase();
    if (/^0x[0-9a-f]+$/.test(chainIdStr)) {
        const decimalValue = parseInt(chainIdStr, 16);
        return Number.isNaN(decimalValue) ? null : String(decimalValue);
    }

    if (/^\d+$/.test(chainIdStr)) {
        return chainIdStr;
    }

    return null;
};

export class WalletManager {
    constructor() {
        // Initialize logger
        const logger = createLogger('WALLET');
        this.debug = logger.debug.bind(logger);
        this.error = logger.error.bind(logger);
        this.warn = logger.warn.bind(logger);

        this.listeners = new Set();
        this.isConnecting = false;
        this.account = null;
        this.chainId = null;
        this.isConnected = false;
        this.onAccountChange = null;
        this.onChainChange = null;
        this.onConnect = null;
        this.onDisconnect = null;
        this.provider = null;
        this.signer = null;
        this.contract = null;
        this.contractAddress = getActiveNetwork().contractAddress;
        this.contractABI = getActiveNetwork().contractABI;
        this.isInitialized = false;
        this.contractInitialized = false;
        
        // Add user preference tracking for disconnect state
        this.userDisconnected = false;
        this.STORAGE_KEY = 'wallet_user_disconnected';
    }

    async init() {
        try {
            this.debug('Starting initialization...');
            
            if (typeof window.ethereum === 'undefined') {
                this.debug('MetaMask is not installed, initializing in read-only mode');
                this.provider = null;
                this.isInitialized = true;
                return;
            }

            this.provider = new ethers.providers.Web3Provider(window.ethereum);
            
            // Set contract configuration
            const networkCfg = getNetworkConfig();
            this.contractAddress = networkCfg.contractAddress;
            this.contractABI = CONTRACT_ABI;
            
            this.debug('Provider initialized');
            this.debug('Contract config:', {
                address: this.contractAddress,
                hasABI: !!this.contractABI
            });

            // Setup event listeners
            window.ethereum.on('accountsChanged', this.handleAccountsChanged.bind(this));
            window.ethereum.on('chainChanged', this.handleChainChanged.bind(this));
            window.ethereum.on('connect', this.handleConnect.bind(this));
            window.ethereum.on('disconnect', this.handleDisconnect.bind(this));

            // Check user disconnect preference before auto-connecting
            this.loadUserDisconnectPreference();
            
            // Only auto-connect if user hasn't manually disconnected
            if (!this.userDisconnected) {
                const accounts = await window.ethereum.request({ method: 'eth_accounts' });
                if (accounts.length > 0) {
                    this.debug('Auto-connecting to existing MetaMask session');
                    // Ensure internal state reflects connected session
                    this.account = accounts[0];
                    const chainId = await window.ethereum.request({ method: 'eth_chainId' });
                    this.chainId = chainId;
                    // Keep wallet-reported chain state; app-level logic decides if network is acceptable.
                    this.notifyListeners('chainChanged', { chainId });
                    this.isConnected = true;
                    // Initialize signer and contract for the session
                    await this.initializeSigner(this.account);
                    // Notify listeners so UI can react as connected
                    this.notifyListeners('connect', {
                        account: this.account,
                        chainId: this.chainId
                    });
                }
            } else {
                this.debug('User has manually disconnected, skipping auto-connect');
            }

            this.isInitialized = true;
            this.debug('Initialization complete');
        } catch (error) {
            console.error("[WalletManager] Error in init:", error);
            throw error;
        }
    }

    async checkConnection() {
        try {
            if (!this.provider) {
                return false;
            }
            const accounts = await this.provider.listAccounts();
            return accounts.length > 0;
        } catch (error) {
            console.error('[WalletManager] Connection check failed:', error);
            return false;
        }
    }

    async initializeSigner(account) {
        try {
            if (!this.provider) {
                throw new Error('No provider available');
            }
            this.signer = this.provider.getSigner();
            await this.initializeContract();
            return this.signer;
        } catch (error) {
            console.error('[WalletManager] Error initializing signer:', error);
            throw error;
        }
    }

    async initializeContract() {
        if (this.contractInitialized) {
            this.debug('Contract already initialized, skipping...');
            return this.contract;
        }

        try {
            const currentNetwork = getNetworkById(this.chainId) || getNetworkConfig();
            this.contractAddress = currentNetwork.contractAddress;
            this.contractABI = currentNetwork.contractABI;

            this.contract = new ethers.Contract(
                currentNetwork.contractAddress,
                CONTRACT_ABI,
                this.signer
            );
            
            this.debug('Contract initialized with ABI:', 
                this.contract.interface.format());
            this.contractInitialized = true;
            return this.contract;
        } catch (error) {
            console.error('[WalletManager] Error initializing contract:', error);
            throw error;
        }
    }

    async connect() {
        if (this.isConnecting) {
            console.log('[WalletManager] Connection already in progress');
            return null;
        }

        if (!this.provider) {
            throw new Error('MetaMask is not installed');
        }

        this.isConnecting = true;
        try {
            this.debug('Requesting accounts...');
            const accounts = await window.ethereum.request({ 
                method: 'eth_requestAccounts' 
            });
            
            this.debug('Accounts received:', accounts);
            
            const chainId = await window.ethereum.request({ 
                method: 'eth_chainId' 
            });
            this.debug('Chain ID:', chainId);

            const decimalChainId = parseInt(chainId, 16).toString();
            this.debug('Decimal Chain ID:', decimalChainId);

            this.account = accounts[0];
            this.chainId = chainId;
            this.isConnected = true;

            // Clear user disconnect preference when they manually connect
            this.saveUserDisconnectPreference(false);

            // Initialize signer before notifying listeners
            await this.initializeSigner(this.account);

            this.debug('Notifying listeners of connection');
            this.notifyListeners('connect', {
                account: this.account,
                chainId: this.chainId
            });

            return {
                account: this.account,
                chainId: this.chainId
            };
        } catch (error) {
            this.debug('Connection error:', error);
            throw error;
        } finally {
            this.isConnecting = false;
        }
    }

    async switchToNetwork(targetNetworkRef) {
        if (typeof window.ethereum === 'undefined') {
            throw new Error('MetaMask is not installed');
        }

        const targetNetwork =
            (targetNetworkRef && typeof targetNetworkRef === 'object' && targetNetworkRef.chainId
                ? targetNetworkRef
                : (getNetworkBySlug(targetNetworkRef) || getNetworkById(targetNetworkRef)));

        if (!targetNetwork) {
            throw new Error(`Unsupported target network: ${targetNetworkRef}`);
        }

        const currentChainId = this.chainId || await window.ethereum.request({ method: 'eth_chainId' });
        if (normalizeChainId(currentChainId) === normalizeChainId(targetNetwork.chainId)) {
            setActiveNetwork(targetNetwork);
            return targetNetwork;
        }

        try {
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: targetNetwork.chainId }]
            });
        } catch (error) {
            if (error?.code !== 4902) {
                throw error;
            }

            try {
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: targetNetwork.chainId,
                        chainName: targetNetwork.displayName || targetNetwork.name,
                        nativeCurrency: targetNetwork.nativeCurrency,
                        rpcUrls: [targetNetwork.rpcUrl, ...(targetNetwork.fallbackRpcUrls || [])],
                        blockExplorerUrls: [targetNetwork.explorer]
                    }]
                });
            } catch (addError) {
                addError.requiresWalletNetworkAddition = true;
                addError.missingNetworkSlug = targetNetwork.slug;
                addError.targetNetwork = targetNetwork;
                addError.originalSwitchError = error;
                throw addError;
            }

            try {
                await window.ethereum.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: targetNetwork.chainId }]
                });
            } catch (switchAfterAddError) {
                if (switchAfterAddError?.code === 4902) {
                    switchAfterAddError.requiresWalletNetworkAddition = true;
                    switchAfterAddError.missingNetworkSlug = targetNetwork.slug;
                    switchAfterAddError.targetNetwork = targetNetwork;
                }
                throw switchAfterAddError;
            }
        }

        const switchedChainId = await window.ethereum.request({ method: 'eth_chainId' });
        this.chainId = switchedChainId;
        setActiveNetwork(targetNetwork);

        if (this.signer) {
            this.contractInitialized = false;
            await this.initializeContract();
        }

        return targetNetwork;
    }

    async handleAccountsChanged(accounts) {
        this.debug('Accounts changed:', accounts);
        if (accounts.length === 0) {
            this.account = null;
            this.isConnected = false;
            this.signer = null;
            this.contract = null;
            this.contractInitialized = false;
            this.debug('No accounts, triggering disconnect');
            this.notifyListeners('disconnect', {});
        } else if (accounts[0] !== this.account) {
            this.account = accounts[0];
            this.isConnected = true;
            try {
                await this.initializeSigner(this.account);
            } catch (e) {
                this.error('Error reinitializing signer on account change:', e);
            }
            this.debug('New account:', this.account);
            this.notifyListeners('accountsChanged', { account: this.account });
        }
    }

    handleChainChanged(chainId) {
        this.chainId = chainId;
        this.notifyListeners('chainChanged', { chainId });
        if (this.onChainChange) {
            this.onChainChange(chainId);
        }
    }

    handleConnect(connectInfo) {
        if (this.onConnect) {
            this.onConnect(connectInfo);
        }
    }

    handleDisconnect(error) {
        this.isConnected = false;
        if (this.onDisconnect) {
            this.onDisconnect(error);
        }
    }

    // Utility methods
    getAccount() {
        return this.account;
    }

    isWalletConnected() {
        if (!this.provider) {
            return false;
        }
        return this.isConnected;
    }

    disconnect() {
        this.debug('User manually disconnecting wallet');
        
        // Save user's disconnect preference
        this.saveUserDisconnectPreference(true);
        
        // Clear connection state
        this.account = null;
        this.chainId = null;
        this.isConnected = false;
        this.signer = null;
        this.contract = null;
        this.contractInitialized = false;
        
        // Notify listeners of disconnect
        this.notifyListeners('disconnect', {});
        
        if (this.onDisconnect) {
            this.onDisconnect();
        }
        
        this.debug('Wallet disconnected and preference saved');
    }

    addListener(callback) {
        this.listeners.add(callback);
    }

    removeListener(callback) {
        this.listeners.delete(callback);
    }

    notifyListeners(event, data) {
        this.listeners.forEach(callback => callback(event, data));
    }

    // Add getter methods
    getSigner() {
        if (!this.provider) {
            return null;
        }
        return this.signer;
    }

    getContract() {
        if (!this.provider) {
            return null;
        }
        return this.contract;
    }

    getProvider() {
        return this.provider;
    }

    async initializeProvider() {
        try {
            const config = getNetworkConfig();
            let provider;
            let error;

            // Try main RPC URL first
            try {
                provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
                await provider.getNetwork();
                return provider;
            } catch (e) {
                error = e;
            }

            // Try fallback URLs
            for (const rpcUrl of config.fallbackRpcUrls) {
                try {
                    provider = new ethers.providers.JsonRpcProvider(rpcUrl);
                    await provider.getNetwork();
                    return provider;
                } catch (e) {
                    error = e;
                }
            }

            throw error;
        } catch (error) {
            console.error('[WalletManager] Error initializing provider:', error);
            throw error;
        }
    }

    // Add method to check initialization status
    isWalletInitialized() {
        return this.isInitialized;
    }

    // Add method to get contract configuration
    getContractConfig() {
        return {
            address: this.contractAddress,
            abi: this.contractABI
        };
    }

    getFallbackProviders() {
        const config = getNetworkConfig();
        return config.fallbackRpcUrls.map(url => 
            new ethers.providers.JsonRpcProvider(url)
        );
    }

    // Add this new method
    async getCurrentAddress() {
        if (!this.signer) {
            throw new Error('No signer available');
        }
        return await this.signer.getAddress();
    }

    isConnected() {
        return this.account !== null && this.chainId !== null;
    }

    loadUserDisconnectPreference() {
        const disconnected = localStorage.getItem(this.STORAGE_KEY);
        if (disconnected === 'true') {
            this.userDisconnected = true;
            this.debug('User has manually disconnected from MetaMask.');
        } else {
            this.userDisconnected = false;
            this.debug('User has not manually disconnected from MetaMask.');
        }
    }

    saveUserDisconnectPreference(disconnected) {
        localStorage.setItem(this.STORAGE_KEY, disconnected);
        this.userDisconnected = disconnected;
        this.debug(`User disconnect preference saved: ${disconnected}`);
    }

    /**
     * Check if the user has manually disconnected
     * @returns {boolean} True if user has manually disconnected
     */
    hasUserDisconnected() {
        return this.userDisconnected;
    }

    /**
     * Clear the user's disconnect preference (useful for testing or admin actions)
     */
    clearDisconnectPreference() {
        localStorage.removeItem(this.STORAGE_KEY);
        this.userDisconnected = false;
        this.debug('User disconnect preference cleared');
    }
}

export const walletManager = new WalletManager();
