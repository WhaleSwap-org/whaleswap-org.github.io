import { ethers } from 'ethers';
import { createWalletCore } from '../../vendor/liberdus-wallet-core/index.js';
import {
    addEthereumChain,
    switchEthereumChain
} from '../../vendor/liberdus-wallet-core/adapters/chain.js';
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

const STARTUP_REQUEST_TIMEOUT_MS = 4000;

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
        this.injectedProvider = null;
        this.walletCore = createWalletCore({
            walletSessionKey: 'whaleswap-ui:wallet-session',
            discoveryWaitMs: 250
        });
        this.walletCoreUnsubscribe = null;
        
        // Add user preference tracking for disconnect state
        this.userDisconnected = false;
        this.STORAGE_KEY = 'wallet_user_disconnected';
    }

    resolveInjectedProvider() {
        return this.walletCore.getEip1193Provider();
    }

    getInjectedProvider() {
        if (!this.injectedProvider) {
            this.injectedProvider = this.resolveInjectedProvider();
        }
        return this.injectedProvider;
    }

    normalizeWalletCoreChainId(chainId) {
        if (chainId === null || chainId === undefined) {
            return null;
        }
        if (typeof chainId === 'number' && Number.isFinite(chainId)) {
            return `0x${chainId.toString(16)}`;
        }
        return chainId;
    }

    syncInjectedProviderFromCore() {
        this.injectedProvider = this.walletCore.getEip1193Provider();
        return this.injectedProvider;
    }

    clearSignerAndContractState() {
        this.signer = null;
        this.contract = null;
        this.contractInitialized = false;
    }

    ensureWeb3Provider() {
        const previousInjectedProvider = this.injectedProvider;
        const injectedProvider = this.syncInjectedProviderFromCore();
        if (!injectedProvider) {
            this.provider = null;
            this.clearSignerAndContractState();
            return null;
        }

        if (!this.provider || previousInjectedProvider !== injectedProvider) {
            this.provider = new ethers.providers.Web3Provider(injectedProvider, 'any');
            this.clearSignerAndContractState();
        }

        return this.provider;
    }

    setupWalletCoreSubscription() {
        if (this.walletCoreUnsubscribe) return;
        this.walletCoreUnsubscribe = this.walletCore.subscribe((event, data) => {
            if (event === 'accountChanged') {
                this.handleAccountsChanged(data ? [data] : []);
                return;
            }
            if (event === 'chainChanged') {
                this.handleChainChanged(this.normalizeWalletCoreChainId(data));
            }
        });
    }

    syncConnectedStateFromWalletCore({ userInitiated = false } = {}) {
        const state = this.walletCore.getState();
        this.account = state.account;
        this.chainId = this.normalizeWalletCoreChainId(state.chainId);
        this.isConnected = Boolean(this.account);
        this.ensureWeb3Provider();
        return {
            account: this.account,
            chainId: this.chainId,
            userInitiated
        };
    }

    async getAvailableWallets() {
        return await this.walletCore.discoverWallets();
    }

    hasWalletSession() {
        return this.walletCore.hasWalletSession();
    }

    async selectWalletForConnection(walletId = null) {
        const wallets = await this.walletCore.discoverWallets();
        const state = this.walletCore.getState();

        if (walletId) {
            const selectedWallet = wallets.find((wallet) => wallet.id === walletId);
            if (!selectedWallet) {
                throw new Error('Selected wallet is no longer available.');
            }
            return selectedWallet;
        }

        return wallets.find((wallet) => wallet.id === state.selectedWalletId)
            || (wallets.length === 1 ? wallets[0] : null)
            || null;
    }

    hasInjectedProvider() {
        return !!this.getInjectedProvider();
    }

    async request(method, params = undefined) {
        const injectedProvider = this.getInjectedProvider();
        if (!injectedProvider?.request) {
            throw new Error('No injected wallet provider detected.');
        }

        const payload = params === undefined
            ? { method }
            : { method, params };
        return injectedProvider.request(payload);
    }

    async requestWithTimeout(method, params = undefined, timeoutMs = STARTUP_REQUEST_TIMEOUT_MS) {
        if (!timeoutMs || timeoutMs <= 0) {
            return this.request(method, params);
        }

        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                const timeoutError = new Error(`Wallet request timed out: ${method}`);
                timeoutError.code = 'WALLET_REQUEST_TIMEOUT';
                timeoutError.method = method;
                reject(timeoutError);
            }, timeoutMs);
        });

        try {
            return await Promise.race([
                this.request(method, params),
                timeoutPromise
            ]);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async init() {
        try {
            this.debug('Starting initialization...');

            if (this.isInitialized) {
                this.debug('Wallet manager already initialized');
                return;
            }

            // Set contract configuration
            const networkCfg = getNetworkConfig();
            this.contractAddress = networkCfg.contractAddress;
            this.contractABI = CONTRACT_ABI;
            
            this.debug('Contract config:', {
                address: this.contractAddress,
                hasABI: !!this.contractABI
            });

            this.setupWalletCoreSubscription();

            // Check user disconnect preference before auto-connecting
            this.loadUserDisconnectPreference();

            await this.walletCore.discoverWallets();
            
            // Only auto-connect if user hasn't manually disconnected
            if (!this.userDisconnected && this.hasWalletSession()) {
                try {
                    await this.walletCore.sync();
                    this.syncConnectedStateFromWalletCore();

                    if (this.account) {
                        this.debug('Auto-connecting to existing wallet session');
                        // Keep wallet-reported chain state; app-level logic decides if network is acceptable.
                        this.notifyListeners('chainChanged', { chainId: this.chainId });
                        // Initialize signer and contract for the session
                        await this.initializeSigner(this.account);
                        // Notify listeners so UI can react as connected
                        this.notifyListeners('connect', {
                            account: this.account,
                            chainId: this.chainId
                        });
                    }
                } catch (autoConnectError) {
                    this.warn('Wallet auto-connect check failed, continuing in read-only mode', autoConnectError);
                }
            } else {
                this.debug('No saved wallet session to restore, skipping wallet probe');
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

    async connect(options = {}) {
        const { userInitiated = false, walletId = null } = options;

        if (this.isConnecting) {
            console.log('[WalletManager] Connection already in progress');
            return null;
        }

        this.isConnecting = true;
        try {
            this.debug('Discovering wallets...');
            const wallet = await this.selectWalletForConnection(walletId);
            if (!wallet) {
                throw new Error('Select a wallet to connect.');
            }

            this.debug('Requesting accounts through wallet core...', wallet.info?.name || wallet.id);
            await this.walletCore.connect({ walletId: wallet.id });
            const result = this.syncConnectedStateFromWalletCore({ userInitiated });
            this.debug('Accounts received:', [this.account]);
            this.debug('Chain ID:', this.chainId);

            // Clear user disconnect preference when they manually connect
            this.saveUserDisconnectPreference(false);

            // Initialize signer before notifying listeners
            await this.initializeSigner(this.account);

            this.debug('Notifying listeners of connection');
            this.notifyListeners('connect', {
                account: result.account,
                chainId: result.chainId,
                userInitiated
            });

            return result;
        } catch (error) {
            this.debug('Connection error:', error);
            throw error;
        } finally {
            this.isConnecting = false;
        }
    }

    async switchToNetwork(targetNetworkRef) {
        if (!this.hasInjectedProvider()) {
            throw new Error('No injected wallet provider detected.');
        }

        const targetNetwork =
            (targetNetworkRef && typeof targetNetworkRef === 'object' && targetNetworkRef.chainId
                ? targetNetworkRef
                : (getNetworkBySlug(targetNetworkRef) || getNetworkById(targetNetworkRef)));

        if (!targetNetwork) {
            throw new Error(`Unsupported target network: ${targetNetworkRef}`);
        }

        const currentChainId = this.chainId || await this.request('eth_chainId');
        if (normalizeChainId(currentChainId) === normalizeChainId(targetNetwork.chainId)) {
            setActiveNetwork(targetNetwork);
            return targetNetwork;
        }

        try {
            await switchEthereumChain(this.getInjectedProvider(), targetNetwork.chainId);
        } catch (error) {
            if (error?.code !== 4902) {
                throw error;
            }

            try {
                await addEthereumChain(this.getInjectedProvider(), {
                    chainId: targetNetwork.chainId,
                    chainName: targetNetwork.displayName || targetNetwork.name,
                    nativeCurrency: targetNetwork.nativeCurrency,
                    rpcUrls: [targetNetwork.rpcUrl, ...(targetNetwork.fallbackRpcUrls || [])],
                    blockExplorerUrls: [targetNetwork.explorer]
                });
            } catch (addError) {
                addError.requiresWalletNetworkAddition = true;
                addError.missingNetworkSlug = targetNetwork.slug;
                addError.targetNetwork = targetNetwork;
                addError.originalSwitchError = error;
                throw addError;
            }

            try {
                await switchEthereumChain(this.getInjectedProvider(), targetNetwork.chainId);
            } catch (switchAfterAddError) {
                if (switchAfterAddError?.code === 4902) {
                    switchAfterAddError.requiresWalletNetworkAddition = true;
                    switchAfterAddError.missingNetworkSlug = targetNetwork.slug;
                    switchAfterAddError.targetNetwork = targetNetwork;
                }
                throw switchAfterAddError;
            }
        }

        const switchedChainId = await this.request('eth_chainId');
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
            this.walletCore.disconnect();
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
        this.account = null;
        this.signer = null;
        this.contract = null;
        this.contractInitialized = false;
        this.walletCore.disconnect();
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
        this.walletCore.disconnect();
        
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
            this.debug('User has manually disconnected from the wallet.');
        } else {
            this.userDisconnected = false;
            this.debug('User has not manually disconnected from the wallet.');
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
