import { BaseComponent } from './BaseComponent.js';
import { getDefaultNetwork, getNetworkById, getNetworkBySlug } from '../config/networks.js';
import { walletManager } from '../services/WalletManager.js';
import { createLogger } from '../services/LogService.js';

export class WalletUI extends BaseComponent {
    constructor() {
        super('wallet-container');
        
        const logger = createLogger('WALLET_UI');
        this.debug = logger.debug.bind(logger);
        this.error = logger.error.bind(logger);
        this.warn = logger.warn.bind(logger);
        
        // Store bound handlers for cleanup
        this._boundConnectHandler = null;
        this._boundWalletInfoHandler = null;
        this._boundPopupContainerHandler = null;
        this._boundDocumentClickHandler = null;
        this._boundWalletSelectionHandler = null;
        this._boundWalletListener = null;
        this.popupContainer = null;
        this.popupAccount = null;
        this.walletPopup = null;
        this.walletSelectionMenu = null;
        
        this.debug('Constructor completed (no side effects)');
    }

    /**
     * Initialize the WalletUI component
     * Sets up DOM references, event listeners, and checks connection state
     */
    async initialize(readOnlyMode = true) {
        if (this.initializing) {
            this.debug('Already initializing, skipping...');
            return;
        }
        
        if (this.initialized) {
            this.debug('Already initialized, skipping...');
            return;
        }
        
        this.initializing = true;
        
        try {
            this.debug('Initializing WalletUI...');
            
            // Initialize DOM elements
            this.initializeElements();
            
            // Setup event listeners
            this.setupEventListeners();
            
            // Check connection state
            await this.checkInitialConnectionState();
            
            this.initialized = true;
            this.debug('WalletUI initialization complete');
        } catch (error) {
            this.error('Error in initialize:', error);
        } finally {
            this.initializing = false;
        }
    }

    /**
     * Cleanup event listeners and subscriptions
     */
    cleanup() {
        this.debug('Cleaning up WalletUI...');
        
        // Remove connect button listener
        if (this.connectButton && this._boundConnectHandler) {
            this.connectButton.removeEventListener('click', this._boundConnectHandler);
        }
        
        // Remove wallet info listener
        if (this.walletInfo && this._boundWalletInfoHandler) {
            this.walletInfo.removeEventListener('click', this._boundWalletInfoHandler);
        }

        // Remove popup container listener
        if (this.popupContainer && this._boundPopupContainerHandler) {
            this.popupContainer.removeEventListener('click', this._boundPopupContainerHandler);
        }

        if (this.walletSelectionMenu && this._boundWalletSelectionHandler) {
            this.walletSelectionMenu.removeEventListener('click', this._boundWalletSelectionHandler);
        }

        // Remove outside click listener
        if (this._boundDocumentClickHandler) {
            document.removeEventListener('click', this._boundDocumentClickHandler);
        }

        this.hideWalletSelection();
        this.hideWalletPopup();
        
        // Remove wallet manager listener
        if (this._boundWalletListener) {
            walletManager.removeListener(this._boundWalletListener);
        }
        
        this.debug('WalletUI cleanup complete');
    }

    initializeElements() {
        try {
            this.debug('Initializing elements...');
            
            // Initialize DOM elements with error checking
            this.connectButton = document.getElementById('walletConnect');
            this.walletInfo = document.getElementById('walletInfo');
            this.accountAddress = document.getElementById('accountAddress');
            this.popupContainer = document.getElementById('wallet-popup-container');

            if (!this.connectButton || !this.walletInfo || !this.accountAddress || !this.popupContainer) {
                this.error('Required wallet UI elements not found');
                throw new Error('Required wallet UI elements not found');
            }

            this.walletSelectionMenu = document.createElement('div');
            this.walletSelectionMenu.id = 'walletSelectionMenu';
            this.walletSelectionMenu.className = 'wallet-selection-menu hidden';
            this.walletSelectionMenu.setAttribute('role', 'menu');
            this.walletSelectionMenu.setAttribute('aria-label', 'Select wallet');
            this.connectButton.insertAdjacentElement('afterend', this.walletSelectionMenu);
            this.connectButton.setAttribute('aria-haspopup', 'menu');
            this.connectButton.setAttribute('aria-expanded', 'false');

            this.debug('DOM elements initialized');
        } catch (error) {
            this.error('Error in initializeElements:', error);
            throw error;
        }
    }

    setupEventListeners() {
        // Create bound handler for connect button
        this._boundConnectHandler = (e) => {
            this.debug('Connect button clicked!', e);
            this.handleConnectClick(e);
        };
        this.connectButton.addEventListener('click', this._boundConnectHandler);
        this.debug('Click listener added to connect button');

        this._boundWalletSelectionHandler = async (e) => {
            const target = e.target;
            if (!(target instanceof Element)) return;

            const walletOption = target.closest('[data-wallet-id]');
            if (!walletOption) return;

            e.preventDefault();
            e.stopPropagation();
            await this.connectWallet(walletOption.dataset.walletId || null);
        };
        this.walletSelectionMenu.addEventListener('click', this._boundWalletSelectionHandler);

        // Click on connected wallet chip opens popup
        this._boundWalletInfoHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.hideWalletSelection();
            this.toggleWalletPopup();
        };
        this.walletInfo.addEventListener('click', this._boundWalletInfoHandler);

        // Static popup event delegation (listener attached once on load)
        this._boundPopupContainerHandler = async (e) => {
            const target = e.target;
            if (!(target instanceof Element)) return;

            const closeBtn = target.closest('[data-wallet-close]');
            if (closeBtn) {
                e.preventDefault();
                e.stopPropagation();
                this.hideWalletPopup();
                return;
            }

            const copyBtn = target.closest('[data-wallet-copy]');
            if (copyBtn) {
                e.preventDefault();
                e.stopPropagation();
                if (!this.popupAccount) return;
                try {
                    await navigator.clipboard.writeText(this.popupAccount);
                    this.showInfo('Address copied');
                } catch (_) {
                    this.showError('Failed to copy address');
                }
                return;
            }

            const disconnectBtn = target.closest('[data-wallet-disconnect]');
            if (disconnectBtn) {
                await this.disconnectWallet(e);
            }
        };
        this.popupContainer.addEventListener('click', this._boundPopupContainerHandler);

        // Close popup on outside click
        this._boundDocumentClickHandler = (e) => {
            const target = e.target;
            if (!(target instanceof Element)) {
                this.hideWalletPopup();
                this.hideWalletSelection();
                return;
            }
            if (!target.closest('.wallet-selection-menu') && !target.closest('#walletConnect')) {
                this.hideWalletSelection();
            }
            if (!this.walletPopup) return;
            if (!target.closest('.wallet-info-popup') && !target.closest('#walletInfo')) {
                this.hideWalletPopup();
            }
        };
        document.addEventListener('click', this._boundDocumentClickHandler);

        // Setup wallet manager listener
        this._boundWalletListener = (event, data) => {
            this.debug('Wallet event:', event, data);
            switch (event) {
                case 'connect':
                    this.debug('Connect event received');
                    this.updateUI(data.account);
                    break;
                case 'disconnect':
                    this.debug('Disconnect event received');
                    this.hideWalletPopup();
                    this.showConnectButton();
                    break;
                case 'accountsChanged':
                    this.debug('Account change event received');
                    this.updateUI(data.account);
                    this.hideWalletPopup();
                    break;
                case 'chainChanged':
                    this.debug('Chain change event received');
                    this.updateNetworkBadge(data.chainId);
                    this.hideWalletPopup();
                    break;
            }
        };
        walletManager.addListener(this._boundWalletListener);
    }

    async disconnectWallet(e = null) {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        this.debug('Disconnect button clicked');
        try {
            this.hideWalletPopup();

            // Clean up CreateOrder component before disconnecting
            if (window.app?.components['create-order']?.cleanup) {
                window.app.components['create-order'].cleanup();
            }
            
            // Use the new disconnect method that saves user preference
            walletManager.disconnect();

            // Let CreateOrder own its button state/messages.
            const createOrderComponent = window.app?.components?.['create-order'];
            if (createOrderComponent?.applyDisconnectedState) {
                createOrderComponent.applyDisconnectedState();
            } else if (createOrderComponent?.updateCreateButtonState) {
                createOrderComponent.updateCreateButtonState();
            }
            
            // Reset UI
            this.showConnectButton();
            this.accountAddress.textContent = '';
            
            // Update tab visibility
            if (window.app?.updateTabVisibility) {
                window.app.updateTabVisibility(false);
            }
            
            // Only trigger app-level disconnect handler (which will show the message)
            if (window.app?.handleWalletDisconnect) {
                window.app.handleWalletDisconnect();
            }
        } catch (error) {
            this.error('[WalletUI] Error disconnecting:', error);
        }
    }

    async checkInitialConnectionState() {
        try {
            this.debug('Checking initial connection state...');
            
            // Check if user has manually disconnected
            if (walletManager.hasUserDisconnected()) {
                this.debug('User has manually disconnected, showing connect button');
                this.showConnectButton();
                return;
            }

            // WalletManager.init() already handles session auto-connect.
            // Here we only reflect current connected state in the UI.
            const existingAccount = walletManager.getAccount?.();
            if (existingAccount) {
                this.debug('Found existing wallet manager session, syncing UI');
                this.updateUI(existingAccount);
                this.updateNetworkBadge(walletManager.chainId);
                return;
            }

            if (!walletManager.hasWalletSession()) {
                this.debug('No saved wallet session found, showing connect button');
                this.showConnectButton();
                return;
            }

            if (!walletManager.hasInjectedProvider()) {
                this.debug('No injected wallet provider found, initializing in read-only mode');
                return;
            }

            // Recovery path: if wallet init partially failed, probe session and sync state.
            if (!walletManager.isConnecting) {
                try {
                    const accounts = await walletManager.requestWithTimeout('eth_accounts', undefined, 3000);
                    if (accounts && accounts.length > 0) {
                        const chainId = await walletManager.requestWithTimeout('eth_chainId', undefined, 3000);
                        walletManager.account = accounts[0];
                        walletManager.chainId = chainId;
                        walletManager.isConnected = true;
                        await walletManager.initializeSigner(accounts[0]);
                        this.ctx?.setWalletChainId?.(walletManager.chainId || null);

                        this.debug('Recovered existing provider session, syncing UI');
                        this.updateUI(accounts[0]);
                        this.updateNetworkBadge(walletManager.chainId);
                    }
                } catch (fallbackError) {
                    this.warn('Failed to recover wallet session after init fallback', fallbackError);
                }
            }
        } catch (error) {
            this.error('Error checking initial connection state:', error);
        }
    }

    async handleConnectClick(e) {
        try {
            this.debug('Handle connect click called');
            e.preventDefault();

            if (this.walletSelectionMenu && !this.walletSelectionMenu.classList.contains('hidden')) {
                this.hideWalletSelection();
                return;
            }

            await this.showWalletSelection();
        } catch (error) {
            this.error('Error in handleConnectClick:', error);
            this.showError("Failed to load wallets: " + error.message);
        }
    }

    async connectWallet(walletId = null) {
        try {
            this.debug('Connecting wallet...');
            
            if (walletManager.isConnecting) {
                this.debug('Connection already in progress, skipping...');
                return null;
            }

            // Add a small delay to ensure any previous pending requests are cleared
            await new Promise(resolve => setTimeout(resolve, 500));

            this.hideWalletSelection();
            this.setConnectButtonBusy(true);

            const result = await walletManager.connect({ userInitiated: true, walletId });
            this.debug('Connect result:', result);
            if (result && result.account) {
                this.updateUI(result.account);
            }
            return result;
        } catch (error) {
            this.error('Failed to connect wallet:', error);
            this.showError("Failed to connect wallet: " + error.message);
            return null;
        } finally {
            this.setConnectButtonBusy(false);
        }
    }

    async showWalletSelection() {
        this.hideWalletPopup();
        if (!this.walletSelectionMenu) return;

        this.walletSelectionMenu.classList.remove('hidden');
        this.walletSelectionMenu.replaceChildren(this.createWalletSelectionMessage('Loading wallets...'));
        this.connectButton.setAttribute('aria-expanded', 'true');

        const wallets = await walletManager.getAvailableWallets();
        this.walletSelectionMenu.replaceChildren();

        const title = document.createElement('div');
        title.className = 'wallet-selection-title';
        title.textContent = 'Select Wallet';
        this.walletSelectionMenu.append(title);

        if (!wallets.length) {
            this.walletSelectionMenu.append(this.createWalletSelectionMessage('No compatible browser wallet was detected.'));
            return;
        }

        for (const wallet of wallets) {
            this.walletSelectionMenu.append(this.createWalletOption(wallet));
        }
    }

    createWalletOption(wallet) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'wallet-selection-option';
        option.dataset.walletId = wallet.id;
        option.setAttribute('role', 'menuitem');

        const icon = document.createElement('span');
        icon.className = 'wallet-selection-icon';

        const name = wallet?.info?.name || 'Injected Wallet';
        icon.textContent = name.trim().slice(0, 2).toUpperCase() || 'W';

        if (wallet?.info?.icon) {
            const image = document.createElement('img');
            image.src = wallet.info.icon;
            image.alt = '';
            image.addEventListener('load', () => {
                icon.textContent = '';
                icon.append(image);
            });
        }

        const copy = document.createElement('span');
        copy.className = 'wallet-selection-copy';

        const label = document.createElement('span');
        label.className = 'wallet-selection-name';
        label.textContent = name;

        const meta = document.createElement('span');
        meta.className = 'wallet-selection-meta';
        meta.textContent = wallet?.info?.rdns || wallet?.source || 'Injected provider';

        copy.append(label, meta);
        option.append(icon, copy);
        return option;
    }

    createWalletSelectionMessage(messageText) {
        const message = document.createElement('div');
        message.className = 'wallet-selection-message';
        message.textContent = messageText;
        return message;
    }

    hideWalletSelection() {
        if (!this.walletSelectionMenu) return;
        this.walletSelectionMenu.classList.add('hidden');
        this.walletSelectionMenu.replaceChildren();
        this.connectButton?.setAttribute('aria-expanded', 'false');
    }

    setConnectButtonBusy(isBusy) {
        if (!this.connectButton) return;
        this.connectButton.disabled = isBusy;
        const label = document.createElement('span');
        label.className = 'wallet-button-text';
        label.textContent = isBusy ? 'Connecting...' : 'Connect Wallet';
        this.connectButton.replaceChildren(label);
    }

    updateUI(account) {
        try {
            this.debug('Updating UI with account:', account);
            if (!account) {
                this.debug('No account provided, showing connect button');
                this.showConnectButton();
                // Remove wallet-connected class
                document.querySelector('.swap-section')?.classList.remove('wallet-connected');
                return;
            }

            const shortAddress = `${account.slice(0, 6)}...${account.slice(-4)}`;
            this.debug('Setting short address:', shortAddress);
            
            this.connectButton.classList.add('hidden');
            this.hideWalletSelection();
            this.walletInfo.classList.remove('hidden');
            this.accountAddress.textContent = shortAddress;
            
            // Add wallet-connected class
            document.querySelector('.swap-section')?.classList.add('wallet-connected');
            
            if (walletManager.chainId) {
                this.updateNetworkBadge(walletManager.chainId);
            }
            
            this.debug('UI updated successfully');
        } catch (error) {
            this.error('[WalletUI] Error in updateUI:', error);
        }
    }

    showConnectButton() {
        try {
            this.debug('Showing connect button');
            this.connectButton.classList.remove('hidden');
            this.walletInfo.classList.add('hidden');
            this.hideWalletPopup();
            this.hideWalletSelection();
            // Remove wallet-connected class
            document.querySelector('.swap-section')?.classList.remove('wallet-connected');
            this.debug('Connect button shown');
        } catch (error) {
            this.error('[WalletUI] Error in showConnectButton:', error);
        }
    }

    updateNetworkBadge(chainId) {
        try {
            this.debug('Updating network badge for chain:', chainId);

            if (window.app?.ctx?.setWalletChainId) {
                window.app.ctx.setWalletChainId(chainId ?? null);
            }

            if (typeof window.syncNetworkBadgeFromState === 'function') {
                window.syncNetworkBadgeFromState();
                return;
            }

            const networkBadge = document.querySelector('.network-badge');
            if (!networkBadge) {
                this.error('[WalletUI] Network badge element not found');
                return;
            }

            const selectedSlug = window.app?.ctx?.getSelectedChainSlug?.() || getDefaultNetwork().slug;
            const selectedNetwork = getNetworkBySlug(selectedSlug) || getDefaultNetwork();
            const walletNetwork = getNetworkById(chainId);

            networkBadge.textContent = selectedNetwork.displayName || selectedNetwork.name;
            networkBadge.classList.remove('has-logo');
            networkBadge.classList.remove('setup-needed', 'wrong-network', 'connected', 'disconnected');
            if (!chainId) {
                networkBadge.classList.add('disconnected');
            } else if (walletNetwork && walletNetwork.slug === selectedNetwork.slug) {
                networkBadge.classList.add('connected');
            } else {
                networkBadge.classList.add('wrong-network');
            }
            this.debug('Network badge updated');
        } catch (error) {
            this.error('[WalletUI] Error updating network badge:', error);
        }
    }

    toggleWalletPopup() {
        if (this.walletInfo.classList.contains('hidden')) return;

        if (this.walletPopup) {
            this.hideWalletPopup();
            return;
        }

        this.showWalletPopup();
    }

    showWalletPopup() {
        const account = walletManager.getAccount?.();
        if (!account || !this.walletInfo || !this.popupContainer) return;

        this.hideWalletPopup();
        this.popupAccount = account;
        const short = `${account.slice(0, 6)}...${account.slice(-4)}`;

        this.popupContainer.innerHTML = `
            <div class="wallet-info-popup" role="dialog" aria-label="Wallet actions">
                <div class="wallet-info-popup-content">
                    <button class="wallet-popup-close" type="button" title="Close" data-wallet-close>×</button>
                    <div class="wallet-popup-row">
                        <span class="wallet-popup-label">Wallet Address</span>
                        <div class="wallet-popup-address-box">
                            <span class="wallet-popup-address address-text" data-wallet-copy title="${account}">${short}</span>
                            <button type="button" class="copy-icon-button" data-wallet-copy>Copy</button>
                        </div>
                    </div>
                    <div class="wallet-popup-actions">
                        <button type="button" class="disconnect-button" data-wallet-disconnect>Disconnect</button>
                    </div>
                </div>
            </div>
        `;
        this.walletPopup = this.popupContainer.querySelector('.wallet-info-popup');
        this.positionWalletPopup();
    }

    positionWalletPopup() {
        if (!this.walletPopup || !this.walletInfo) return;

        const rect = this.walletInfo.getBoundingClientRect();
        const popupRect = this.walletPopup.getBoundingClientRect();

        let top = rect.bottom + 8;
        let left = rect.right - popupRect.width;

        if (left < 8) left = 8;
        if (top + popupRect.height > window.innerHeight - 8) {
            top = rect.top - popupRect.height - 8;
        }

        this.walletPopup.style.top = `${top}px`;
        this.walletPopup.style.left = `${left}px`;
    }

    hideWalletPopup() {
        if (this.popupContainer) {
            this.popupContainer.innerHTML = '';
        }
        this.popupAccount = null;
        this.walletPopup = null;
    }
}
