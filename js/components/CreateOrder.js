import { BaseComponent } from './BaseComponent.js';
import { ethers } from 'ethers';
import { getNetworkConfig } from '../config/networks.js';
import { walletManager } from '../services/WalletManager.js';
import { setVisibility } from '../utils/ui.js';
import { erc20Abi } from '../abi/erc20.js';
import { getAllWalletTokens, clearTokenCaches } from '../utils/contractTokens.js';
import { contractService } from '../services/ContractService.js';
import { createLogger } from '../services/LogService.js';
import { validateSellBalance } from '../utils/balanceValidation.js';
import { tokenIconService } from '../services/TokenIconService.js';
import { generateTokenIconHTML, getFallbackIconData } from '../utils/tokenIcons.js';
import { handleTransactionError } from '../utils/ui.js';
import { getExplorerUrl } from '../utils/orderUtils.js';

export class CreateOrder extends BaseComponent {
    constructor() {
        super('create-order');
        this.contract = null;
        this.provider = null;
        this.initialized = false;
        this.isRendered = false;
        this.hasLoadedData = false;
        // Token cache removed - use WebSocket's centralized token cache via ctx.getWebSocket()
        this.boundCreateOrderHandler = this.handleCreateOrder.bind(this);
        this.isSubmitting = false;
        this.tokens = [];
        this.allowedTokens = [];
        this.tokensLoading = false;
        this.allowedTokensLoadPromise = null;
        this.feeLoadPromise = null;
        this.sellToken = null;
        this.buyToken = null;
        this.isContractDisabled = false;
        this.contractStateReadError = false;
        this.tokenSelectorListeners = {};  // Store listeners to prevent duplicates
        this.boundWindowClickHandler = null;
        this.boundTooltipOutsideClickHandler = null;
        this.amountInputListeners = {};
        this.boundTooltipEscapeHandler = null;
        this.tooltipCleanupCallbacks = [];
        
        // Initialize logger
        const logger = createLogger('CREATE_ORDER');
        this.debug = logger.debug.bind(logger);
        this.error = logger.error.bind(logger);
        this.warn = logger.warn.bind(logger);
    }

    // Add debounce as a class method
    debounce(func, wait) {
        let timeout;
        return (...args) => {
            const later = () => {
                clearTimeout(timeout);
                func.apply(this, args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    getDefaultTokenSelectorMarkup() {
        return `
            <span class="token-selector-content">
                <span>Select token</span>
                <svg width="12" height="12" viewBox="0 0 12 12">
                    <path d="M3 5L6 8L9 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
            </span>
        `;
    }

    clearSelectedTokens() {
        this.sellToken = null;
        this.buyToken = null;

        ['sell', 'buy'].forEach(type => {
            this[`${type}Token`] = null;

            const selector = document.getElementById(`${type}TokenSelector`);
            if (selector) {
                selector.innerHTML = this.getDefaultTokenSelectorMarkup();
            }

            const tokenInput = document.getElementById(`${type}Token`);
            if (tokenInput) {
                tokenInput.value = '';
            }

            const amountInput = document.getElementById(`${type}Amount`);
            if (amountInput) {
                amountInput.value = '';
            }

            const usdDisplay = document.getElementById(`${type}AmountUSD`);
            if (usdDisplay) {
                usdDisplay.textContent = '≈ $0.00';
                setVisibility(usdDisplay, false);
            }
        });

        this.resetBalanceDisplays();
        this.updateCreateButtonState();
        this.debug('Cleared selected tokens from create order form');
    }

    // Method to reset component state for account switching/disconnects
    resetState(options = {}) {
        const { clearSelections = false } = options;
        this.debug('Resetting CreateOrder component state...');
        this.initialized = false;
        this.initializing = false;
        this.hasLoadedData = false;
        this.tokens = [];
        this.allowedTokens = [];
        this.tokensLoading = false;
        this.allowedTokensLoadPromise = null;
        this.feeLoadPromise = null;
        this.feeToken = null;
        this.isContractDisabled = false;
        this.contractStateReadError = false;
        if (clearSelections) {
            this.clearSelectedTokens();
        }
        // Token cache is centralized in WebSocket - no local cache to clear
        this.resetBalanceDisplays();
    }

    applyDisconnectedState() {
        this.contractStateReadError = false;
        this.isContractDisabled = false;
        this.isSubmitting = false;
        this.updateCreateButtonState();
    }

    async initializeContract() {
        try {
            this.debug('Initializing contract...');
            const networkConfig = getNetworkConfig();
            
            this.debug('Network config:', {
                address: networkConfig.contractAddress,
                abiLength: networkConfig.contractABI?.length
            });

            if (!networkConfig.contractABI) {
                this.error('Contract ABI is undefined');
                throw new Error('Contract ABI is undefined');
            }
            
            // Get provider and signer from walletManager
            const signer = walletManager.getSigner();
            if (!signer) {
                this.error('No signer available - wallet may be disconnected');
                throw new Error('No signer available - wallet may be disconnected');
            }
            
            // Initialize contract with signer from walletManager
            this.contract = new ethers.Contract(
                networkConfig.contractAddress,
                networkConfig.contractABI,
                signer
            );
            
            this.debug('Contract initialized successfully');
            return this.contract;
        } catch (error) {
            this.error('Contract initialization error:', error);
            throw error;
        }
    }

    async initialize(readOnlyMode = true, options = {}) {
        if (this.initializing || this.initialized) {
            this.debug('Already initializing or initialized, skipping...');
            return;
        }
        this.initializing = true;
        
        // Reset balance displays when re-initializing
        this.resetBalanceDisplays();
        
        try {
            this.debug('Starting initialization...');
            
            // Render the HTML once
            const container = document.getElementById('create-order');
            if (!this.isRendered) {
                container.innerHTML = this.render();
                this.isRendered = true;

                // Initialize initial visibility state for static elements
                const sellUsd = document.getElementById('sellAmountUSD');
                const buyUsd = document.getElementById('buyAmountUSD');
                const sellBal = document.getElementById('sellTokenBalanceDisplay');
                setVisibility(sellUsd, false);
                setVisibility(buyUsd, false);
                setVisibility(sellBal, false);
            }
            
            // Keep status area quiet in read-only mode, but continue initialization so
            // users can still view enhanced inputs and token lists while disconnected.
            if (readOnlyMode) {
                const statusElement = document.getElementById('status');
                if (statusElement) {
                    statusElement.style.display = 'none';
                }
            }

            const ws = this.ctx.getWebSocket();
            // CreateOrder only creates orders, it doesn't need to listen to order events

            // Wait for WebSocket to be fully initialized
            if (!ws?.isInitialized) {
                this.debug('Waiting for WebSocket initialization...');
                await new Promise(resolve => {
                    const checkInterval = setInterval(() => {
                        if (ws?.isInitialized) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 100);
                });
            }

            // Clear existing content before re-populating
            const sellContainer = document.getElementById('sellContainer');
            const buyContainer = document.getElementById('buyContainer');
            if (sellContainer) sellContainer.innerHTML = '';
            if (buyContainer) buyContainer.innerHTML = '';

            // Use WebSocket's contract instance
            this.contract = ws.contract;
            this.provider = ws.provider;

            if (!this.contract) {
                throw new Error('Contract not initialized');
            }
            
            // Initialize contract service
            contractService.initialize();
            
            if (readOnlyMode) {
                this.setReadOnlyMode();
            } else {
                this.setConnectedMode();
            }
            
            // Setup UI only on first render to preserve user input on tab switches
            if (!this.hasLoadedData) {
                this.populateTokenDropdowns();
            }
            if (!Array.isArray(this.allowedTokens) || this.allowedTokens.length === 0) {
                this.setAllowedTokenListsLoadingState('Loading allowed tokens...');
            }
            this.setupCreateOrderListener();
            
            // Wait for contract to be ready
            await this.waitForContract();
            await this.refreshContractDisabledState();
            
            // Load fee/token data in background so initial tab render is not blocked.
            this.startBackgroundDataLoading();
            this.hasLoadedData = true;
            
            // Initialize token selectors
            this.initializeTokenSelectors();
            
            // Initialize amount input listeners
            this.initializeAmountInputs();
            
            this.initialized = true;
            this.debug('Initialization complete');

        } catch (error) {
            this.error('Error in initialization:', error);
            // Only show errors if not in read-only mode
            if (!readOnlyMode) {
                this.showError('Failed to initialize. Please try again.');
            }
        } finally {
            this.initializing = false;
        }
    }

    startBackgroundDataLoading() {
        if (!this.feeLoadPromise && !(this.feeToken?.address && this.feeToken?.amount && this.feeToken?.symbol)) {
            this.feeLoadPromise = this.loadOrderCreationFee()
                .then(() => this.updateFeeDisplay())
                .catch((error) => {
                    this.debug('Background fee load failed:', error);
                })
                .finally(() => {
                    this.feeLoadPromise = null;
                });
        }

        const hasAllowedTokens = Array.isArray(this.allowedTokens) && this.allowedTokens.length > 0;
        if (!this.allowedTokensLoadPromise && !hasAllowedTokens) {
            this.tokensLoading = true;
            this.setAllowedTokenListsLoadingState('Loading allowed tokens...');
            this.allowedTokensLoadPromise = this.loadContractTokens()
                .catch((error) => {
                    this.debug('Background token load failed:', error);
                })
                .finally(() => {
                    this.tokensLoading = false;
                    this.allowedTokensLoadPromise = null;
                });
        }
    }

    async loadOrderCreationFee() {
        try {
            // Check if we have a cached value
            if (this.feeToken?.address && this.feeToken?.amount &&this.feeToken?.symbol) {
                this.debug('Using cached fee token data');
                return;
            }

            const maxRetries = 3;
            let retryCount = 0;
            let lastError;

            while (retryCount < maxRetries) {
                try {
                    const feeTokenAddress = await this.contract.feeToken();
                    this.debug('Fee token address:', feeTokenAddress);

                    const feeAmount = await this.contract.orderCreationFeeAmount();
                    this.debug('Fee amount:', feeAmount);

                    // Get token details
                    const tokenContract = new ethers.Contract(
                        feeTokenAddress,
                        [
                            'function symbol() view returns (string)',
                            'function decimals() view returns (uint8)'
                        ],
                        this.provider
                    );

                    const [symbol, decimals] = await Promise.all([
                       tokenContract.symbol(),
                        tokenContract.decimals()
                    ]);

                    // Cache the results
                    this.feeToken = {
                        address: feeTokenAddress,
                        amount: feeAmount,
                        symbol: symbol,
                        decimals: decimals
                    };

                    // Update the fee display
                    const feeDisplay = document.querySelector('.fee-amount');
                    if (feeDisplay) {
                        const formattedAmount = ethers.utils.formatUnits(feeAmount, decimals);
                        feeDisplay.textContent = `${formattedAmount} ${symbol}`;
                    }

                    return;
                } catch (error) {
                    lastError = error;
                    retryCount++;
                    if (retryCount < maxRetries) {
                        // Exponential backoff: 1s, 2s, 4s, etc.
                        const delay = Math.pow(2, retryCount - 1) * 1000;
                        this.debug(`Retry ${retryCount}/${maxRetries} after ${delay}ms`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                }
            }
            throw lastError;
        } catch (error) {
            this.debug('Error loading fee:', error);
            throw error;
        }
    }

    // Add a method to check if contract is ready
    async waitForContract(timeout = 10000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (this.contract && await this.contract.provider.getNetwork()) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Contract not ready after timeout');
    }

    async refreshContractDisabledState(options = {}) {
        try {
            const ws = this.ctx.getWebSocket();
            if (!ws?.getContractDisabledState) {
                throw new Error('Disabled-state accessor unavailable');
            }

            const contractDisabled = await ws.getContractDisabledState(options);
            this.contractStateReadError = false;
            this.isContractDisabled = Boolean(contractDisabled);
        } catch (error) {
            // Fail closed: if we cannot verify state, block order creation.
            this.contractStateReadError = true;
            this.isContractDisabled = true;
            this.debug('Error fetching contract disabled state:', error);
        } finally {
            this.updateCreateButtonState();
        }

        return this.isContractDisabled;
    }

    setReadOnlyMode() {
        this.debug('Setting read-only mode');
        
        // Ensure UI is hidden per styles by removing wallet-connected
        const swapSection = document.querySelector('.swap-section');
        if (swapSection) {
            swapSection.classList.remove('wallet-connected');
        }
        
        // Disable input fields
        ['partner', 'sellToken', 'sellAmount', 'buyToken', 'buyAmount'].forEach(id => {
            const element = document.getElementById(id);
            if (element) element.disabled = true;
        });

        this.updateCreateButtonState();
    }

    setConnectedMode() {
        // Make sure the swap section is marked as wallet-connected so CSS reveals inputs
        const swapSection = document.querySelector('.swap-section');
        if (swapSection) {
            swapSection.classList.add('wallet-connected');
        }
        
        // Enable input fields
        ['partner', 'sellToken', 'sellAmount', 'buyToken', 'buyAmount'].forEach(id => {
            const element = document.getElementById(id);
            if (element) element.disabled = false;
        });

        // Reload fee if we have it cached
        if (this.feeToken) {
            const feeElement = document.getElementById('orderFee');
            if (feeElement) {
                const formattedFee = ethers.utils.formatUnits(this.feeToken.amount, this.feeToken.decimals);
                feeElement.textContent = `${formattedFee} ${this.feeToken.symbol}`;
            }
        }

        this.updateCreateButtonState();
    }

    /**
     * Update the new balance display elements outside the token selectors
     * @param {string} type - 'sell' or 'buy'
     * @param {string} formattedBalance - Formatted balance amount
     * @param {string} balanceUSD - USD equivalent of the balance
     */
    updateBalanceDisplay(type, formattedBalance, balanceUSD) {
        try {
            // Buy amount should not show clickable balance chip.
            if (type === 'buy') {
                this.hideBalanceDisplay(type);
                return;
            }

            const balanceDisplay = document.getElementById(`${type}TokenBalanceDisplay`);
            const balanceAmount = document.getElementById(`${type}TokenBalanceAmount`);
            const balanceUSDElement = document.getElementById(`${type}TokenBalanceUSD`);
            
            if (balanceDisplay && balanceAmount && balanceUSDElement) {
                // Update the balance values
                balanceAmount.textContent = formattedBalance;
                balanceUSDElement.textContent = `• $${balanceUSD}`;
                
                // Show the balance display without layout shift
                setVisibility(balanceDisplay, true);
                
                // Update ARIA label with current balance
                const balanceBtn = document.getElementById(`${type}TokenBalanceBtn`);
                if (balanceBtn) {
                    balanceBtn.setAttribute('aria-label', `Click to fill ${type} amount with available balance: ${formattedBalance}`);
                }
                
                this.debug(`Updated ${type} balance display: ${formattedBalance} ($${balanceUSD})`);
            }
        } catch (error) {
            this.error(`Error updating ${type} balance display:`, error);
        }
    }

    /**
     * Hide balance display when no token is selected
     * @param {string} type - 'sell' or 'buy'
     */
    hideBalanceDisplay(type) {
        try {
            const balanceDisplay = document.getElementById(`${type}TokenBalanceDisplay`);
            if (balanceDisplay) {
                setVisibility(balanceDisplay, false);
                this.debug(`Hidden ${type} balance display`);
            }
        } catch (error) {
            this.error(`Error hiding ${type} balance display:`, error);
        }
    }

    /**
     * Reset all balance displays to initial state
     */
    resetBalanceDisplays() {
        try {
            ['sell', 'buy'].forEach(type => {
                this.hideBalanceDisplay(type);
                
                // Reset balance values to default
                const balanceAmount = document.getElementById(`${type}TokenBalanceAmount`);
                const balanceUSD = document.getElementById(`${type}TokenBalanceUSD`);
                
                if (balanceAmount) balanceAmount.textContent = '0.00';
                if (balanceUSD) balanceUSD.textContent = '$0.00';
            });
            
            this.debug('Reset all balance displays to initial state');
        } catch (error) {
            this.error('Error resetting balance displays:', error);
        }
    }

    setupCreateOrderListener() {
        const createOrderBtn = this.container?.querySelector('#createOrderBtn');
        if (!createOrderBtn) {
            this.warn('Create order button not found');
            return;
        }

        // Remove ALL existing listeners using clone technique
        const newButton = createOrderBtn.cloneNode(true);
        createOrderBtn.parentNode.replaceChild(newButton, createOrderBtn);
        // Add single new listener
        newButton.addEventListener('click', this.boundCreateOrderHandler);

        // Setup taker toggle functionality
        const takerToggle = this.container?.querySelector('.taker-toggle');
        if (takerToggle) {
            this.debug('Setting up taker toggle functionality');
            // Remove existing listeners using clone technique
            const newTakerToggle = takerToggle.cloneNode(true);
            takerToggle.parentNode.replaceChild(newTakerToggle, takerToggle);
            
            // Add click listener
            newTakerToggle.addEventListener('click', (e) => {
                this.debug('Taker toggle clicked');
                e.preventDefault();
                e.stopPropagation();
                
                const isExpanded = newTakerToggle.classList.toggle('active');
                newTakerToggle.setAttribute('aria-expanded', String(isExpanded));

                const takerInputContent = this.container?.querySelector('.taker-input-content');
                if (takerInputContent) {
                    takerInputContent.classList.toggle('hidden');
                }
                
                // Update chevron direction
                const chevron = newTakerToggle.querySelector('.chevron-down');
                if (chevron) {
                    if (isExpanded) {
                        chevron.style.transform = 'rotate(180deg)';
                        // Focus on taker address input when toggle is activated
                        setTimeout(() => {
                            const takerAddressInput = this.container?.querySelector('#takerAddress');
                            if (takerAddressInput) {
                                takerAddressInput.focus();
                            }
                        }, 100); // Small delay to ensure DOM is updated
                    } else {
                        chevron.style.transform = 'rotate(0deg)';
                    }
                }
            });
        } else {
            this.debug('Taker toggle button not found');
        }

        this.setupInfoTooltipInteractions();
    }

    setTooltipExpanded(tooltipElement, isExpanded, persistState = null) {
        if (!tooltipElement) return;

        const trigger = tooltipElement.querySelector('.info-tooltip-trigger');
        const tooltipText = tooltipElement.querySelector('.tooltip-text');

        if (persistState !== null) {
            tooltipElement.classList.toggle('is-open', persistState);
        }
        if (trigger) {
            trigger.setAttribute('aria-expanded', String(isExpanded));
        }
        if (tooltipText) {
            tooltipText.setAttribute('aria-hidden', String(!isExpanded));
        }
    }

    setupInfoTooltipInteractions() {
        this.clearInfoTooltipInteractions();

        const tooltipElements = document.querySelectorAll('.info-tooltip');
        if (!tooltipElements.length) {
            return;
        }

        const syncTooltipFromState = (tooltipElement) => {
            const shouldBeExpanded = tooltipElement.classList.contains('is-open')
                || tooltipElement.matches(':hover')
                || tooltipElement.matches(':focus-within');
            this.setTooltipExpanded(tooltipElement, shouldBeExpanded);
        };

        const closeOtherTooltips = (activeTooltip = null) => {
            tooltipElements.forEach((tooltipElement) => {
                if (tooltipElement !== activeTooltip) {
                    this.setTooltipExpanded(tooltipElement, false, false);
                }
            });
        };

        tooltipElements.forEach((tooltipElement, index) => {
            const trigger = tooltipElement.querySelector('.info-tooltip-trigger');
            const tooltipText = tooltipElement.querySelector('.tooltip-text');
            if (!trigger || !tooltipText) {
                return;
            }

            const fallbackId = `create-order-tooltip-${index + 1}`;
            const tooltipId = tooltipText.id || fallbackId;
            tooltipText.id = tooltipId;
            tooltipText.setAttribute('role', 'tooltip');
            tooltipText.setAttribute('aria-hidden', 'true');

            trigger.setAttribute('role', 'button');
            trigger.setAttribute('tabindex', '0');
            trigger.setAttribute('aria-describedby', tooltipId);
            trigger.setAttribute('aria-expanded', 'false');

            const onTriggerPointerDown = (event) => {
                event.stopPropagation();
            };

            const onTriggerClick = (event) => {
                event.preventDefault();
                event.stopPropagation();
                const shouldExpand = !tooltipElement.classList.contains('is-open');
                closeOtherTooltips(shouldExpand ? tooltipElement : null);
                this.setTooltipExpanded(tooltipElement, shouldExpand, shouldExpand);
            };

            const onTriggerKeyDown = (event) => {
                if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                    event.preventDefault();
                    event.stopPropagation();
                    const shouldExpand = !tooltipElement.classList.contains('is-open');
                    closeOtherTooltips(shouldExpand ? tooltipElement : null);
                    this.setTooltipExpanded(tooltipElement, shouldExpand, shouldExpand);
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    this.setTooltipExpanded(tooltipElement, false, false);
                }
            };

            const onTooltipMouseEnter = () => syncTooltipFromState(tooltipElement);
            const onTooltipMouseLeave = () => syncTooltipFromState(tooltipElement);
            const onTooltipFocusIn = () => syncTooltipFromState(tooltipElement);
            const onTooltipFocusOut = () => {
                requestAnimationFrame(() => syncTooltipFromState(tooltipElement));
            };

            trigger.addEventListener('pointerdown', onTriggerPointerDown);
            trigger.addEventListener('click', onTriggerClick);
            trigger.addEventListener('keydown', onTriggerKeyDown);
            tooltipElement.addEventListener('mouseenter', onTooltipMouseEnter);
            tooltipElement.addEventListener('mouseleave', onTooltipMouseLeave);
            tooltipElement.addEventListener('focusin', onTooltipFocusIn);
            tooltipElement.addEventListener('focusout', onTooltipFocusOut);

            this.tooltipCleanupCallbacks.push(() => {
                trigger.removeEventListener('pointerdown', onTriggerPointerDown);
                trigger.removeEventListener('click', onTriggerClick);
                trigger.removeEventListener('keydown', onTriggerKeyDown);
                tooltipElement.removeEventListener('mouseenter', onTooltipMouseEnter);
                tooltipElement.removeEventListener('mouseleave', onTooltipMouseLeave);
                tooltipElement.removeEventListener('focusin', onTooltipFocusIn);
                tooltipElement.removeEventListener('focusout', onTooltipFocusOut);
            });
        });

        this.boundTooltipOutsideClickHandler = (event) => {
            tooltipElements.forEach((tooltipElement) => {
                if (!tooltipElement.contains(event.target)) {
                    this.setTooltipExpanded(tooltipElement, false, false);
                }
            });
        };
        document.addEventListener('click', this.boundTooltipOutsideClickHandler);

        this.boundTooltipEscapeHandler = (event) => {
            if (event.key === 'Escape') {
                closeOtherTooltips(null);
            }
        };
        document.addEventListener('keydown', this.boundTooltipEscapeHandler);
    }

    clearInfoTooltipInteractions() {
        if (Array.isArray(this.tooltipCleanupCallbacks)) {
            this.tooltipCleanupCallbacks.forEach((cleanupFn) => {
                try {
                    cleanupFn();
                } catch (error) {
                    this.debug('Tooltip listener cleanup failed:', error);
                }
            });
            this.tooltipCleanupCallbacks = [];
        }

        if (this.boundTooltipOutsideClickHandler) {
            document.removeEventListener('click', this.boundTooltipOutsideClickHandler);
            this.boundTooltipOutsideClickHandler = null;
        }

        if (this.boundTooltipEscapeHandler) {
            document.removeEventListener('keydown', this.boundTooltipEscapeHandler);
            this.boundTooltipEscapeHandler = null;
        }
    }

    async handleCreateOrder(event) {
        event.preventDefault();
        
        if (this.isSubmitting) {
            this.debug('Already processing a transaction');
            return;
        }

        this.isSubmitting = true;
        this.updateCreateButtonState();
        
        try {
            const contractDisabled = await this.refreshContractDisabledState({ force: true });
            if (this.contractStateReadError) {
                this.showError('Unable to verify contract state. Please check your network and try again.');
                return;
            }
            if (contractDisabled) {
                this.showWarning('New orders are disabled on this contract.');
                return;
            }

            // Get fresh signer and reinitialize contract
            const signer = walletManager.getSigner();
            if (!signer) {
                throw new Error('No signer available - wallet may be disconnected');
            }

            // Reinitialize contract with fresh signer
            const networkConfig = getNetworkConfig();
            this.contract = new ethers.Contract(
                networkConfig.contractAddress,
                networkConfig.contractABI,
                signer
            );

            // Debug logs to check token state
            this.debug('Current sellToken:', this.sellToken);
            this.debug('Current buyToken:', this.buyToken);
            
            // Get form values
            let taker = document.getElementById('takerAddress')?.value.trim() || '';
            
            // Validate sell token
            if (!this.sellToken || !this.sellToken.address) {
                this.debug('Invalid sell token:', this.sellToken);
                this.showError('Please select a valid token to sell');
                return;
            }

            // Validate buy token
            if (!this.buyToken || !this.buyToken.address) {
                this.debug('Invalid buy token:', this.buyToken);
                this.showError('Please select a valid token to buy');
                return;
            }

            // Check if the same token is selected for both buy and sell
            if (this.sellToken.address.toLowerCase() === this.buyToken.address.toLowerCase()) {
                this.showError(`Cannot create an order with the same token (${this.sellToken.symbol}) for both buy and sell. Please select different tokens.`);
                return;
            }

            // Validate that both tokens are allowed in the contract
            try {
                const [sellTokenAllowed, buyTokenAllowed] = await Promise.all([
                    contractService.isTokenAllowed(this.sellToken.address),
                    contractService.isTokenAllowed(this.buyToken.address)
                ]);

                if (!sellTokenAllowed) {
                    this.showError(`Sell token ${this.sellToken.symbol} is not allowed for trading. Please select an allowed token.`);
                    return;
                }

                if (!buyTokenAllowed) {
                    this.showError(`Buy token ${this.buyToken.symbol} is not allowed for trading. Please select an allowed token.`);
                    return;
                }

                this.debug('Token validation passed - both tokens are allowed');
            } catch (validationError) {
                this.debug('Token validation error:', validationError);
                this.showError('Unable to validate tokens. Please try again.');
                return;
            }

            // Validate addresses
            if (!ethers.utils.isAddress(this.sellToken.address)) {
                this.debug('Invalid sell token address:', this.sellToken.address);
                this.showError('Invalid sell token address');
                return;
            }
            if (!ethers.utils.isAddress(this.buyToken.address)) {
                this.debug('Invalid buy token address:', this.buyToken.address);
                this.showError('Invalid buy token address');
                return;
            }

            const sellAmount = document.getElementById('sellAmount')?.value.trim();
            const buyAmount = document.getElementById('buyAmount')?.value.trim();

            // Validate inputs
            if (!sellAmount || isNaN(sellAmount) || parseFloat(sellAmount) <= 0) {
                this.showError('Please enter a valid sell amount');
                return;
            }
            if (!buyAmount || isNaN(buyAmount) || parseFloat(buyAmount) <= 0) {
                this.showError('Please enter a valid buy amount');
                return;
            }

            // Validate sell balance before proceeding
            try {
                this.debug('Validating sell balance...');
                const balanceValidation = await validateSellBalance(
                    this.sellToken.address, 
                    sellAmount, 
                    this.sellToken.decimals
                );

                if (!balanceValidation.hasSufficientBalance) {
                    const errorMessage = `Insufficient ${balanceValidation.symbol} balance for selling.\n\n` +
                        `Required: ${Number(balanceValidation.formattedRequired).toLocaleString()} ${balanceValidation.symbol}\n` +
                        `Available: ${Number(balanceValidation.formattedBalance).toLocaleString()} ${balanceValidation.symbol}\n\n` +
                        `Please reduce the sell amount or ensure you have sufficient balance.`;
                    
                    this.showError(errorMessage);
                    return;
                }

                this.debug('Sell balance validation passed');
            } catch (balanceError) {
                this.debug('Balance validation error:', balanceError);
                this.showError(`Failed to validate balance: ${balanceError.message}`);
                return;
            }

            // If taker is empty, use zero address for public order
            if (!taker) {
                taker = ethers.constants.AddressZero;
                this.debug('No taker specified, using zero address for public order');
            } else if (!ethers.utils.isAddress(taker)) {
                throw new Error('Invalid taker address format');
            }

            // Convert amounts to wei
            const sellTokenDecimals = await this.getTokenDecimals(this.sellToken.address);
            const buyTokenDecimals = await this.getTokenDecimals(this.buyToken.address);
            const sellAmountWei = ethers.utils.parseUnits(sellAmount, sellTokenDecimals);
            const buyAmountWei = ethers.utils.parseUnits(buyAmount, buyTokenDecimals);

            // Debug logs to check amounts and allowance
            this.debug('Sell amount in wei:', sellAmountWei.toString());
            this.debug('Buy amount in wei:', buyAmountWei.toString());

            // Check and approve tokens with retry mechanism
            let retryCount = 0;
            const maxRetries = 2;

            while (retryCount <= maxRetries) {
                try {
                    // Check and approve tokens
                    const sellTokenApproved = await this.checkAndApproveToken(this.sellToken.address, sellAmountWei);
                    if (!sellTokenApproved) {
                        return;
                    }

                    const feeTokenApproved = await this.checkAndApproveToken(this.feeToken.address, this.feeToken.amount);
                    if (!feeTokenApproved) {
                        return;
                    }

                    // Add small delay after approvals
                    await new Promise(resolve => setTimeout(resolve, 1000));

                    // Create order
                    this.showInfo('Creating order...');
                    const tx = await this.contract.createOrder(
                        taker,
                        this.sellToken.address,
                        sellAmountWei,
                        this.buyToken.address,
                        buyAmountWei
                    ).catch(error => {
                        if (error.code === 4001 || error.code === 'ACTION_REJECTED') {
                            this.showWarning('Order creation declined');
                            return null;
                        }
                        throw error;
                    });

                    if (!tx) return; // User rejected the transaction

                    this.showInfo('Waiting for confirmation...');
                    
                    // Add timeout handling for tx.wait()
                    const waitPromise = tx.wait();
                    const timeoutPromise = new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Transaction timeout - please check your wallet')), 30000)
                    );
                    
                    const receipt = await Promise.race([waitPromise, timeoutPromise]);
                    
                    // Verify transaction was actually successful
                    if (!receipt || receipt.status === 0) {
                        throw new Error('Transaction failed on-chain');
                    }
                    
                    this.debug('Transaction confirmed successfully:', receipt);
                    
                    // After success: clear cached balances and refresh any open token modals
                    try {
                        clearTokenCaches();
                        this.refreshOpenTokenModals();
                    } catch (e) {
                        this.debug('Post-order cache clear/refresh failed:', e);
                    }
                    
                    // Force a sync of all orders after successful creation
                    const ws = this.ctx.getWebSocket();
                    if (ws) {
                        await ws.syncAllOrders(this.contract);
                    }

                    // If we get here, the transaction was successful
                    break;

                } catch (error) {
                    retryCount++;
                    this.debug(`Create order attempt ${retryCount} failed:`, error);

                    // Handle timeout specifically
                    if (error.message?.includes('Transaction timeout')) {
                        this.showError('Transaction timed out. Please check your wallet and try again.');
                        return; // Don't retry timeouts, let user try manually
                    }

                    // Handle on-chain failures
                    if (error.message?.includes('Transaction failed on-chain')) {
                        this.showError('Transaction failed on-chain. Please check your balance and try again.');
                        return; // Don't retry on-chain failures
                    }

                    if (retryCount <= maxRetries && 
                        (error.message?.includes('nonce') || 
                         error.message?.includes('replacement fee too low'))) {
                        this.showInfo('Retrying transaction...');
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        continue;
                    }
                    throw error;
                }
            }

            this.showSuccess('Order created successfully!');
            // this.resetForm();  // Commented out - not resetting form
            
            // Reload orders if needed
            if (window.app?.loadOrders) {
                window.app.loadOrders();
            }
        } catch (error) {
            this.debug('Create order error:', error);
            // Use utility function for consistent error handling
            handleTransactionError(error, this, 'order creation');
        } finally {
            this.isSubmitting = false;
            this.updateCreateButtonState();
        }
    }

    async checkAllowance(tokenAddress, owner, amount) {
        try {
            const tokenContract = new ethers.Contract(
                tokenAddress,
                ['function allowance(address owner, address spender) view returns (uint256)'],
                this.provider
            );
            const allowance = await tokenContract.allowance(owner, this.contract.address);
            return allowance.gte(amount);
        } catch (error) {
            this.error('Error checking allowance:', error);
            return false;
        }
    }

    getReadableError(error) {
        // Add more specific error cases
        switch (error.code) {
            case 'ACTION_REJECTED':
                return 'Transaction was rejected by user';
            case 'INSUFFICIENT_FUNDS':
                return 'Insufficient funds for transaction';
            case -32603:
                return 'Network error. Please check your connection';
            case 'UNPREDICTABLE_GAS_LIMIT':
                // For contract revert errors, extract the actual revert message
                if (error.error?.data?.message) {
                    return error.error.data.message;
                } else if (error.reason) {
                    return error.reason;
                }
                return 'Error estimating gas. The transaction may fail';
            default:
                return error.reason || error.message || 'Error creating order';
        }
    }

    async loadContractTokens() {
        try {
            this.debug('Loading allowed wallet tokens...');
            const allowedTokens = await getAllWalletTokens();
            const normalizedAllowed = allowedTokens.map(token => this.normalizeTokenDisplay(token));

            this.tokens = normalizedAllowed; // Keep allowed tokens for backward compatibility
            this.allowedTokens = normalizedAllowed;
            
            this.debug('Loaded allowed tokens:', normalizedAllowed);
            
            // Trigger price fetching for allowed tokens
            const pricing = this.ctx.getPricing();
            if (pricing && normalizedAllowed.length > 0) {
                try {
                    this.debug('Triggering price fetching for allowed tokens...');
                    const allowedAddresses = normalizedAllowed.map(token => token.address);
                    await pricing.fetchPricesForTokens(allowedAddresses);
                    this.debug('Price fetching completed for allowed tokens');
                } catch (error) {
                    this.debug('Error fetching prices for allowed tokens:', error);
                    // Continue with token loading even if price fetching fails
                }
            }
            
            // Debug: Check if tokens have iconUrl
            for (const token of normalizedAllowed) {
                this.debug(`Token ${token.symbol} has iconUrl: ${!!token.iconUrl}`, token.iconUrl);
            }

            ['sell', 'buy'].forEach(type => {
                const modal = document.getElementById(`${type}TokenModal`);
                if (!modal) {
                    this.debug(`No modal found for ${type}`);
                    return;
                }

                // Display allowed tokens
                const allowedTokensList = modal.querySelector(`#${type}AllowedTokenList`);
                if (allowedTokensList) {
                    this.displayTokens(normalizedAllowed, allowedTokensList, type);
                }
            });
        } catch (error) {
            this.debug('Error loading wallet tokens:', error);
            this.setAllowedTokenListsErrorState('Failed to load allowed tokens. Please retry shortly.');
            this.showError('Failed to load tokens. Please try again.');
        }
    }

    populateTokenDropdowns() {
        ['sell', 'buy'].forEach(type => {
            const currentContainer = document.getElementById(`${type}Container`);
            if (!currentContainer) return;
            
            // Create the unified input container
            const container = document.createElement('div');
            container.className = 'unified-token-input';
            
            // Create input wrapper with label
            const inputWrapper = document.createElement('div');
            inputWrapper.className = 'token-input-wrapper';
            
            // Add the label
            const label = document.createElement('span');
            label.className = 'token-input-label';
            label.textContent = type.charAt(0).toUpperCase() + type.slice(1);
            
            // Create amount input
            const amountInput = document.createElement('input');
            amountInput.type = 'text';
            amountInput.id = `${type}Amount`;
            amountInput.className = 'token-amount-input';
            amountInput.placeholder = '0.0';
            
            // Assemble input wrapper
            inputWrapper.appendChild(label);
            inputWrapper.appendChild(amountInput);
            // Pre-create USD display to preserve layout; keep hidden until valid
            const usdDisplayStatic = document.createElement('div');
            usdDisplayStatic.id = `${type}AmountUSD`;
            usdDisplayStatic.className = 'amount-usd is-hidden';
            usdDisplayStatic.setAttribute('aria-hidden', 'true');
            usdDisplayStatic.textContent = '≈ $0.00';
            inputWrapper.appendChild(usdDisplayStatic);
            
            // Create token selector button
            const tokenSelector = document.createElement('button');
            tokenSelector.className = 'token-selector-button';
            tokenSelector.id = `${type}TokenSelector`;
            tokenSelector.innerHTML = `
                <span class="token-selector-content">
                    <span>Select token</span>
                    <svg width="12" height="12" viewBox="0 0 12 12">
                        <path d="M3 5L6 8L9 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    </svg>
                </span>
            `;
            
            // Hidden input for token address
            const tokenInput = document.createElement('input');
            tokenInput.type = 'hidden';
            tokenInput.id = `${type}Token`;
            
            // Create a selector container to hold only the selector button
            const tokenSelectorContainer = document.createElement('div');
            tokenSelectorContainer.className = 'token-selector';
            tokenSelectorContainer.appendChild(tokenSelector);

            // Keep selector rows structurally identical for sell/buy so button position stays aligned.
            const isSellBalance = type === 'sell';
            const balanceDisplay = document.createElement('div');
            balanceDisplay.className = 'token-balance-display is-hidden';
            balanceDisplay.setAttribute('aria-hidden', 'true');
            if (isSellBalance) {
                balanceDisplay.id = `${type}TokenBalanceDisplay`;
                balanceDisplay.innerHTML = `
                    <button id="${type}TokenBalanceBtn" class="balance-clickable" aria-label="Click to fill ${type} amount with available balance">
                        <span class="balance-amount" id="${type}TokenBalanceAmount">0.00</span>
                        <span class="balance-usd" id="${type}TokenBalanceUSD">• $0.00</span>
                    </button>
                `;
            } else {
                balanceDisplay.classList.add('token-balance-display--placeholder');
                balanceDisplay.innerHTML = `
                    <span class="balance-clickable balance-clickable--placeholder" aria-hidden="true">
                        <span class="balance-amount">0.00</span>
                        <span class="balance-usd">• $0.00</span>
                    </span>
                `;
            }

            // Group selector and balance vertically so balance sits under the button
            const selectorGroup = document.createElement('div');
            selectorGroup.className = 'token-selector-group';
            selectorGroup.appendChild(tokenSelectorContainer);
            selectorGroup.appendChild(balanceDisplay);

            // Assemble the components
            container.appendChild(inputWrapper);
            container.appendChild(selectorGroup);
            container.appendChild(tokenInput);

            // Clear the container and add the new structure
            currentContainer.innerHTML = '';
            currentContainer.appendChild(container);
            
            // Add event listeners
            tokenSelector.addEventListener('click', () => {
                const modal = document.getElementById(`${type}TokenModal`);
                if (modal) modal.classList.add('show');
            });
            
            // Create modal if it doesn't exist
            if (!document.getElementById(`${type}TokenModal`)) {
                const modal = this.createTokenModal(type);
                document.body.appendChild(modal);
            }
        });
    }

    createTokenModal(type) {
        const modal = document.createElement('div');
        modal.className = 'token-modal';
        modal.id = `${type}TokenModal`;
        
        modal.innerHTML = `
            <div class="token-modal-content">
                <div class="token-modal-header">
                    <h3>Select ${type.charAt(0).toUpperCase() + type.slice(1)} Token</h3>
                    <button class="token-modal-close">&times;</button>
                </div>
                <div class="token-modal-search">
                    <input type="text" 
                           class="token-search-input" 
                           placeholder="Search by name or paste address"
                           id="${type}TokenSearch">
                </div>
                <div class="token-sections">
                    <div id="${type}ContractResult"></div>
                    <div class="token-section">
                        <h4>Allowed tokens</h4>
                        <div class="token-list" id="${type}AllowedTokenList">
                            <div class="token-list-loading">
                                <div class="spinner"></div>
                                <div>Loading allowed tokens...</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Update to use the class method debounce
        const searchInput = modal.querySelector(`#${type}TokenSearch`);
        searchInput.addEventListener('input', this.debounce((e) => {
            this.handleTokenSearch(e.target.value, type);
        }, 300));

        return modal;
    }

    setAllowedTokenListsLoadingState(message = 'Loading allowed tokens...') {
        ['sell', 'buy'].forEach((type) => {
            const list = document.getElementById(`${type}AllowedTokenList`);
            if (!list) return;
            list.innerHTML = `
                <div class="token-list-loading">
                    <div class="spinner"></div>
                    <div>${message}</div>
                </div>
            `;
        });
    }

    setAllowedTokenListsErrorState(message = 'Failed to load allowed tokens. Please try again.') {
        ['sell', 'buy'].forEach((type) => {
            const list = document.getElementById(`${type}AllowedTokenList`);
            if (!list) return;
            list.innerHTML = `
                <div class="token-list-error">
                    <div>${message}</div>
                </div>
            `;
        });
    }

    async handleTokenSearch(searchTerm, type) {
        try {
            const contractResult = document.getElementById(`${type}ContractResult`);
            
            searchTerm = searchTerm.trim().toLowerCase();
            
            // Clear previous contract result only
            contractResult.innerHTML = '';

            // If search is empty, just clear the contract result
            if (!searchTerm) {
                return;
            }

            // Check if input is an address
            if (ethers.utils.isAddress(searchTerm)) {
                // Show loading state for contract result
                contractResult.innerHTML = `
                    <div class="token-section">
                        <h4>Token Contract</h4>
                        <div class="contract-loading">
                            <div class="spinner"></div>
                            <span>Loading token info...</span>
                        </div>
                    </div>
                `;

                try {
                    const tokenContract = new ethers.Contract(
                        searchTerm,
                        erc20Abi,
                        this.provider
                    );

                    const [name, symbol, decimals, balance] = await Promise.all([
                        tokenContract.name().catch(() => null),
                        tokenContract.symbol().catch(() => null),
                        tokenContract.decimals().catch(() => null),
                        tokenContract.balanceOf(await walletManager.getCurrentAddress()).catch(() => null)
                    ]);

                    if (name && symbol && decimals !== null) {
                        // Check if token is allowed in the contract
                        const isAllowed = await contractService.isTokenAllowed(searchTerm);
                        if (!isAllowed) {
                            contractResult.innerHTML = `
                                <div class="token-section">
                                    <h4>Token Contract</h4>
                                    <div class="contract-error">
                                        Token is not allowed for trading on this platform
                                    </div>
                                </div>
                            `;
                            return;
                        }
                        
                        const token = this.normalizeTokenDisplay({
                            address: searchTerm,
                            name,
                            symbol,
                            decimals,
                            balance: balance ? ethers.utils.formatUnits(balance, decimals) : '0'
                        });

                        // Get USD price and calculate USD value
                        const pricing = this.ctx.getPricing();
                        const usdPrice = pricing?.getPrice(token.address);
                        const usdValue = usdPrice !== undefined ? Number(token.balance) * usdPrice : 0;
                        const formattedUsdValue = usdPrice !== undefined ? usdValue.toLocaleString(undefined, {
                            style: 'currency',
                            currency: 'USD',
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2
                        }) : 'N/A';

                        // Format balance
                        const formattedBalance = Number(token.balance).toLocaleString(undefined, { 
                            minimumFractionDigits: 2, 
                            maximumFractionDigits: 4,
                            useGrouping: true
                        });

                        contractResult.innerHTML = `
                            <div class="token-section">
                                <h4>Token Contract</h4>
                                <div class="token-list">
                                    <div class="token-item token-allowed" data-address="${token.address}">
                                        <div class="token-item-left">
                                            <div class="token-icon">
                                                <div class="loading-spinner"></div>
                                            </div>
                                            <div class="token-item-info">
                                                <div class="token-item-symbol">
                                                    ${token.symbol}
                                                </div>
                                                <div class="token-item-name">
                                                    ${token.name}
                                                    <a href="${getExplorerUrl(token.address)}" 
                                                       target="_blank"
                                                       class="token-explorer-link"
                                                       onclick="event.stopPropagation();">
                                                        <svg class="token-explorer-icon" viewBox="0 0 24 24">
                                                            <path fill="currentColor" d="M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z" />
                                                        </svg>
                                                    </a>
                                                </div>
                                            </div>
                                        </div>
                                        <div class="token-item-right">
                                            <div class="token-balance-with-usd">
                                                <div class="token-balance-amount">${formattedBalance}</div>
                                                <div class="token-balance-usd">${formattedUsdValue}</div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `;

                        // Add click handler
                        const tokenItem = contractResult.querySelector('.token-item');
                        tokenItem.addEventListener('click', () => this.handleTokenItemClick(type, tokenItem));

                        // Render token icon asynchronously
                        const iconContainer = tokenItem.querySelector('.token-icon');
                        this.renderTokenIcon(token, iconContainer);
                    }
                } catch (error) {
                    contractResult.innerHTML = `
                        <div class="token-section">
                            <h4>Token Contract</h4>
                            <div class="contract-error">
                                Invalid or unsupported token contract
                            </div>
                        </div>
                    `;
                }
            } else {
                // Search in allowed tokens by name/symbol
                const searchSource = Array.isArray(this.tokens) ? this.tokens : [];
                if (this.tokensLoading && searchSource.length === 0) {
                    contractResult.innerHTML = `
                        <div class="token-section">
                            <h4>Search Results</h4>
                            <div class="token-list-loading">
                                <div class="spinner"></div>
                                <div>Loading allowed tokens...</div>
                            </div>
                        </div>
                    `;
                    return;
                }

                const searchResults = searchSource.filter(token => 
                    token.name.toLowerCase().includes(searchTerm) ||
                    token.symbol.toLowerCase().includes(searchTerm)
                );

                if (searchResults.length > 0) {
                    contractResult.innerHTML = `
                        <div class="token-section">
                            <h4>Search Results</h4>
                            <div class="token-list">
                                ${searchResults.map(token => {
                                    const balance = Number(token.balance) || 0;
                                    const formattedBalance = balance.toLocaleString(undefined, { 
                                        minimumFractionDigits: 2, 
                                        maximumFractionDigits: 4,
                                        useGrouping: true
                                    });
                                    const pricing = this.ctx.getPricing();
                                    const usdPrice = pricing?.getPrice(token.address);
                                    const usdValue = usdPrice !== undefined ? balance * usdPrice : 0;
                                    const formattedUsdValue = usdPrice !== undefined ? usdValue.toLocaleString(undefined, {
                                        style: 'currency',
                                        currency: 'USD',
                                        minimumFractionDigits: 2,
                                        maximumFractionDigits: 2
                                    }) : 'N/A';

                                    return `
                                        <div class="token-item token-allowed" data-address="${token.address}">
                                            <div class="token-item-left">
                                                <div class="token-icon">
                                                    <div class="loading-spinner"></div>
                                                </div>
                                                <div class="token-item-info">
                                                    <div class="token-item-symbol">
                                                        ${token.symbol}
                                                    </div>
                                                    <div class="token-item-name">
                                                        ${token.name}
                                                        <a href="${getExplorerUrl(token.address)}" 
                                                           target="_blank"
                                                           class="token-explorer-link"
                                                           onclick="event.stopPropagation();">
                                                            <svg class="token-explorer-icon" viewBox="0 0 24 24">
                                                                <path fill="currentColor" d="M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z" />
                                                            </svg>
                                                        </a>
                                                    </div>
                                                </div>
                                            </div>
                                            <div class="token-item-right">
                                                <div class="token-balance-with-usd">
                                                    <div class="token-balance-amount">${formattedBalance}</div>
                                                    <div class="token-balance-usd">${formattedUsdValue}</div>
                                                </div>
                                            </div>
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        </div>
                    `;

                    // Add click handlers for search results
                    const tokenItems = contractResult.querySelectorAll('.token-item');
                    tokenItems.forEach((item, index) => {
                        item.addEventListener('click', () => this.handleTokenItemClick(type, item));
                        
                        // Render token icon asynchronously
                        const iconContainer = item.querySelector('.token-icon');
                        this.renderTokenIcon(searchResults[index], iconContainer);
                    });
                } else {
                    contractResult.innerHTML = `
                        <div class="token-section">
                            <h4>Search Results</h4>
                            <div class="token-list-empty">
                                No tokens found matching "${searchTerm}"
                            </div>
                        </div>
                    `;
                }
            }
        } catch (error) {
            this.debug('Search error:', error);
            this.showError('Error searching for token');
        }
    }

    displayTokens(tokens, container, type) {
        if (!container) return;

        if (!tokens || tokens.length === 0) {
            container.innerHTML = `
                <div class="token-list-empty">
                    <div class="empty-state-icon">🔍</div>
                    <div class="empty-state-text">No allowed tokens found</div>
                    <div class="empty-state-subtext">Contact the contract owner to add tokens to the allowed list</div>
                </div>
            `;
            return;
        }

        // Clear existing content
        container.innerHTML = '';

        // Sort tokens: tokens with balance first, then alphabetically by symbol
        const sortedTokens = [...tokens]
            .map(token => this.normalizeTokenDisplay(token))
            .sort((a, b) => {
            const aBalance = Number(a.balance) || 0;
            const bBalance = Number(b.balance) || 0;
            
            // First sort by balance (non-zero first)
            if (aBalance > 0 && bBalance === 0) return -1;
            if (aBalance === 0 && bBalance > 0) return 1;
            
            // Then sort alphabetically by symbol
            return a.symbol.localeCompare(b.symbol);
        });

        // Add each token to the container
        sortedTokens.forEach(token => {
            const tokenElement = document.createElement('div');
            const balance = Number(token.balance) || 0;
            const hasBalance = balance > 0;
            
            // For buy tokens, don't grey out tokens with no balance and don't add border classes
            if (type === 'buy') {
                tokenElement.className = 'token-item';
            } else {
                tokenElement.className = `token-item ${hasBalance ? 'token-has-balance' : 'token-no-balance'}`;
            }
            
            tokenElement.dataset.address = token.address;
            
            // Format balance with up to 4 decimal places if they exist
            const formattedBalance = balance.toLocaleString(undefined, { 
                minimumFractionDigits: 2, 
                maximumFractionDigits: 4,
                useGrouping: true // Keeps the thousand separators
            });
            
            // Get USD price and calculate USD value
            const pricing = this.ctx.getPricing();
            const usdPrice = pricing?.getPrice(token.address);
            const usdValue = usdPrice !== undefined ? balance * usdPrice : 0;
            const formattedUsdValue = usdPrice !== undefined ? usdValue.toLocaleString(undefined, {
                style: 'currency',
                currency: 'USD',
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            }) : 'N/A';

            // Generate background color for fallback icon
            const colors = [
                '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', 
                '#FFEEAD', '#D4A5A5', '#9B59B6', '#3498DB'
            ];
            const colorIndex = token.address ? 
                parseInt(token.address.slice(-6), 16) % colors.length :
                Math.floor(Math.random() * colors.length);
            const backgroundColor = colors[colorIndex];
            
            tokenElement.innerHTML = `
                <div class="token-item-content">
                    <div class="token-item-left">
                        <div class="token-icon">
                            ${token.iconUrl && token.iconUrl !== 'fallback' ? `
                                <img src="${token.iconUrl}" 
                                    alt="${token.symbol}" 
                                    class="token-icon-image"
                                    onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
                                <div class="token-icon-fallback" style="display:none;background:${backgroundColor}">
                                    ${token.symbol.charAt(0).toUpperCase()}
                                </div>` : `
                                <div class="token-icon-fallback" style="background:${backgroundColor}">
                                    ${token.symbol.charAt(0).toUpperCase()}
                                </div>`
                            }
                        </div>
                        <div class="token-item-info">
                            <div class="token-item-symbol">
                                ${token.symbol}
                            </div>
                            <div class="token-item-name">${token.name}</div>
                        </div>
                    </div>
                    <div class="token-item-right">
                        <div class="token-balance-with-usd">
                            <div class="token-balance-amount ${hasBalance ? 'has-balance' : 'no-balance'}">
                                ${formattedBalance}
                                ${!hasBalance ? '<span class="no-balance-text">(No balance)</span>' : ''}
                            </div>
                            <div class="token-balance-usd">${formattedUsdValue}</div>
                        </div>
                        <div class="token-item-actions">
                            <a href="${getExplorerUrl(token.address)}" 
                               target="_blank"
                               class="token-explorer-link"
                               onclick="event.stopPropagation();"
                               title="View on Explorer">
                                <svg class="token-explorer-icon" viewBox="0 0 24 24">
                                    <path fill="currentColor" d="M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z" />
                                </svg>
                            </a>
                        </div>
                    </div>
                </div>
            `;

            // Add click handler
            tokenElement.addEventListener('click', () => this.handleTokenItemClick(type, tokenElement));
            
            // Add to container
            container.appendChild(tokenElement);
        });

        // Add summary information
        const tokensWithBalance = sortedTokens.filter(token => Number(token.balance) > 0).length;
        const totalTokens = sortedTokens.length;
        
        if (totalTokens > 0) {
            const summaryElement = document.createElement('div');
            summaryElement.className = 'token-list-summary';
            summaryElement.innerHTML = `
                <div class="summary-text">
                    Showing ${totalTokens} allowed tokens
                    ${tokensWithBalance > 0 ? `(${tokensWithBalance} with balance)` : ''}
                    ${type === 'sell' && tokensWithBalance < totalTokens ? ` - ${totalTokens - tokensWithBalance} with no balance` : ''}
                </div>
            `;
            container.appendChild(summaryElement);
        }
    }

    normalizeTokenDisplay(token) {
        return token;
    }

    // Add helper method for token icons
    async getTokenIcon(token) {
        try {
            this.debug(`Getting icon for token ${token.symbol} (${token.address})`);
            this.debug(`Token object:`, token);
            
            // If token already has an iconUrl, use it
            if (token.iconUrl) {
                this.debug('Using existing iconUrl for token:', token.symbol, token.iconUrl);
                return generateTokenIconHTML(token.iconUrl, token.symbol, token.address);
            }
            
            // Otherwise, get icon URL from token icon service
            const fallbackChainId = Number.parseInt(getNetworkConfig().chainId, 16) || 137;
            const chainId = walletManager.chainId ? parseInt(walletManager.chainId, 16) : fallbackChainId;
            const iconUrl = await tokenIconService.getIconUrl(token.address, chainId);
            
            // Generate HTML using the utility function
            return generateTokenIconHTML(iconUrl, token.symbol, token.address);
        } catch (error) {
            this.debug('Error getting token icon:', error);
            // Fallback to basic fallback icon
            const fallbackData = getFallbackIconData(token.address, token.symbol);
            return `
                <div class="token-icon">
                    <div class="token-icon-fallback" style="background: ${fallbackData.backgroundColor}">
                        ${fallbackData.text}
                    </div>
                </div>
            `;
        }
    }

    // Helper method to render token icon asynchronously
    async renderTokenIcon(token, container) {
        try {
            const iconHtml = await this.getTokenIcon(token);
            container.innerHTML = iconHtml;
        } catch (error) {
            this.debug('Error rendering token icon:', error);
            // Fallback to basic icon
            const fallbackData = getFallbackIconData(token.address, token.symbol);
            container.innerHTML = `
                <div class="token-icon">
                    <div class="token-icon-fallback" style="background: ${fallbackData.backgroundColor}">
                        ${fallbackData.text}
                    </div>
                </div>
            `;
        }
    }

    cleanup() {
        // Only clear timers, keep table structure
        if (this.expiryTimers) {
            this.expiryTimers.forEach(timerId => clearInterval(timerId));
            this.expiryTimers.clear();
        }
        this.clearInfoTooltipInteractions();
        // Remove global click handler for modals if present
        if (this.boundWindowClickHandler) {
            window.removeEventListener('click', this.boundWindowClickHandler);
            this.boundWindowClickHandler = null;
        }

        if (this.boundTooltipOutsideClickHandler) {
            document.removeEventListener('click', this.boundTooltipOutsideClickHandler);
            this.boundTooltipOutsideClickHandler = null;
        }
    }

    // Add this method to the CreateOrder class
    showStatus(message, type = 'info') {
        const statusElement = document.getElementById('status');
        if (statusElement) {
            statusElement.textContent = message;
            statusElement.className = `status ${type}`;
        }
        this.debug(`Status update (${type}): ${message}`);
    }

    // Override showSuccess with shorter duration for order creation UX
    showSuccess(message, duration = 3000) {
        // Use parent's implementation with custom default duration
        super.showSuccess(message, duration);
    }

    /**
     * Get token decimals using WebSocket's centralized token cache
     * Falls back to direct contract call if WebSocket not available
     * @param {string} tokenAddress - Token contract address
     * @returns {Promise<number>} Token decimals
     */
    async getTokenDecimals(tokenAddress) {
        try {
            const normalizedAddress = tokenAddress.toLowerCase();
            
            // Use WebSocket's centralized token cache
            const ws = this.ctx.getWebSocket();
            if (ws && typeof ws.getTokenInfo === 'function') {
                const tokenInfo = await ws.getTokenInfo(normalizedAddress);
                if (tokenInfo?.decimals !== undefined) {
                    this.debug(`Cache hit for decimals: ${tokenAddress} = ${tokenInfo.decimals}`);
                    return tokenInfo.decimals;
                }
            }

            // Fallback: fetch directly from contract
            this.debug(`Fetching decimals directly for: ${tokenAddress}`);
            const tokenContract = new ethers.Contract(
                tokenAddress,
                ['function decimals() view returns (uint8)'],
                this.provider
            );
            
            const decimals = await tokenContract.decimals();
            this.debug(`Fetched decimals for token ${tokenAddress}: ${decimals}`);
            
            return decimals;
        } catch (error) {
            this.debug(`Error getting token decimals: ${error.message}`);
            throw new Error(`Failed to get decimals for token ${tokenAddress}`);
        }
    }

    async checkAndApproveToken(tokenAddress, amount) {
        try {
            this.debug(`Checking allowance for token: ${tokenAddress}`);
            
            // Get signer and current address
            const signer = walletManager.getSigner();
            const currentAddress = await walletManager.getCurrentAddress();
            if (!signer || !currentAddress) {
                throw new Error('Wallet not connected');
            }

            // Calculate required amount, accounting for fee token if same as sell token
            let requiredAmount = ethers.BigNumber.from(amount);
            
            if (tokenAddress.toLowerCase() === this.feeToken?.address?.toLowerCase() &&
                tokenAddress.toLowerCase() === this.sellToken?.address?.toLowerCase()) {
                const sellAmountStr = document.getElementById('sellAmount')?.value;
                if (sellAmountStr) {
                    const tokenDecimals = await this.getTokenDecimals(tokenAddress);
                    const sellAmountWei = ethers.utils.parseUnits(sellAmountStr, tokenDecimals);
                    const feeAmountWei = ethers.BigNumber.from(this.feeToken.amount);
                    requiredAmount = sellAmountWei.add(feeAmountWei);
                    this.debug(`Combined amount for approval (sell + fee): ${requiredAmount.toString()}`);
                }
            }

            // Create token contract instance
            const tokenContract = new ethers.Contract(
                tokenAddress,
                [
                    'function allowance(address owner, address spender) view returns (uint256)',
                    'function approve(address spender, uint256 amount) returns (bool)'
                ],
                signer
            );

            // Get current allowance
            const currentAllowance = await tokenContract.allowance(
                currentAddress,
                this.contract.address
            );
            this.debug(`Current allowance: ${currentAllowance.toString()}`);
            this.debug(`Required amount: ${requiredAmount.toString()}`);

            // If allowance is insufficient, approve only what's needed
            if (currentAllowance.lt(requiredAmount)) {
                const additionalAmount = requiredAmount.sub(currentAllowance);
                
                this.showInfo(`Requesting additional token approval (${ethers.utils.formatUnits(additionalAmount, await this.getTokenDecimals(tokenAddress))} more needed)...`);
                const approveTx = await tokenContract.approve(this.contract.address, requiredAmount);
                this.showInfo('Please confirm the approval in your wallet...');
                
                await approveTx.wait();
                this.showSuccess('Token approved successfully');

                const newAllowance = await tokenContract.allowance(currentAddress, this.contract.address);
                this.debug(`New allowance after approval: ${newAllowance.toString()}`);
            }

            return true;
        } catch (error) {
            this.debug('Token approval error:', error);
            // Use utility function for consistent error handling
            handleTransactionError(error, this, 'token approval');
            return false;
        }
    }

    // Add new helper method for user-friendly error messages
    getUserFriendlyError(error) {
        // Check for common error codes and messages
        if (error.code === 4001 || error.code === 'ACTION_REJECTED') {
            return 'Transaction was declined';
        }
        
        // Handle timeout specifically
        if (error.message?.includes('Transaction timeout')) {
            return 'Transaction timed out. Please check your wallet and try again.';
        }
        
        // Handle on-chain failures
        if (error.message?.includes('Transaction failed on-chain')) {
            return 'Transaction failed on-chain. Please check your balance and try again.';
        }
        
        // Handle contract revert errors with detailed messages
        if (error.code === -32603 && error.data?.message) {
            return error.data.message;
        }
        
        // Handle other specific error cases
        if (error.message?.includes('insufficient funds')) {
            return 'Insufficient funds for gas fees';
        }
        if (error.message?.includes('nonce')) {
            return 'Transaction error - please refresh and try again';
        }
        if (error.message?.includes('gas required exceeds allowance')) {
            return 'Transaction requires too much gas';
        }
        
        // Try to extract error from ethers error structure
        if (error.error?.data?.message) {
            return error.error.data.message;
        }
        
        // Default generic message
        return 'Transaction failed - please try again';
    }

    // Helper method to verify transaction status
    async verifyTransactionStatus(txHash) {
        try {
            const provider = walletManager.getProvider();
            if (!provider) {
                throw new Error('Provider not available');
            }

            // Wait a bit for transaction to be mined
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Get transaction receipt
            const receipt = await provider.getTransactionReceipt(txHash);
            
            if (!receipt) {
                throw new Error('Transaction not found on-chain');
            }

            if (receipt.status === 0) {
                throw new Error('Transaction failed on-chain');
            }

            return receipt;
        } catch (error) {
            this.debug('Transaction verification failed:', error);
            throw error;
        }
    }

    // Update the fee display in the UI
    updateFeeDisplay() {
        if (!this.feeToken?.amount || !this.feeToken?.symbol || !this.feeToken?.decimals) {
            this.debug('Fee token data not complete:', this.feeToken);
            return;
        }

        const feeDisplay = this.container?.querySelector('.fee-amount') || document.querySelector('.fee-amount');
        if (feeDisplay) {
            const formattedAmount = ethers.utils.formatUnits(this.feeToken.amount, this.feeToken.decimals);
            feeDisplay.textContent = `${formattedAmount} ${this.feeToken.symbol}`;
        }

        const feeTokenSymbols = this.container?.querySelectorAll('.fee-token-symbol') || [];
        feeTokenSymbols.forEach((element) => {
            element.textContent = this.feeToken.symbol;
        });
    }

    async handleTokenSelect(type, token) {
        try {
            this.debug(`Token selected for ${type}:`, token);
            
            // Hide USD display if no token is selected (preserve layout)
            if (!token) {
                this[`${type}Token`] = null;
                const usdDisplay = document.getElementById(`${type}AmountUSD`);
                if (usdDisplay) {
                    setVisibility(usdDisplay, false);
                }
                // Hide balance display when no token is selected
                this.hideBalanceDisplay(type);
                return;
            }
            
            // Enhanced price fetching with loading states
            const pricing = this.ctx.getPricing();
            this.debug('Pricing service state:', {
                exists: !!pricing,
                hasGetPrice: !!pricing?.getPrice,
                tokenAddress: token.address
            });
            
            let usdPrice = 0;
            let isPriceEstimated = true;
            
            if (pricing) {
                usdPrice = pricing.getPrice(token.address);
                isPriceEstimated = pricing.isPriceEstimated(token.address);
                
                // If price is estimated, fetch it in the background (non-blocking)
                if (isPriceEstimated) {
                    this.debug(`Price for ${token.symbol} is estimated, fetching in background...`);
                    pricing.fetchPricesForTokens([token.address])
                        .then(() => {
                            // Update price display after fetching
                            const updatedPrice = pricing.getPrice(token.address);
                            this.updateTokenAmounts(type);
                            this.debug(`Updated price for ${token.symbol}: $${updatedPrice}`);
                        })
                        .catch(error => {
                            this.debug(`Failed to fetch price for ${token.symbol}:`, error);
                        });
                }
            }
            // Handle zero balance case
            const balance = parseFloat(token.balance) || 0;
            const balanceUSD = (balance > 0 && usdPrice !== undefined) ? (balance * usdPrice).toFixed(2) : (usdPrice !== undefined ? '0.00' : 'N/A');
            const formattedBalance = balance.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 4,
                useGrouping: true
            });
            
            // Store token in the component
            this[`${type}Token`] = {
                address: token.address,
                symbol: token.symbol,
                decimals: token.decimals || 18,
                balance: token.balance || '0',
                usdPrice: usdPrice
            };

            // Generate background color for fallback icon
            const colors = [
                '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', 
                '#FFEEAD', '#D4A5A5', '#9B59B6', '#3498DB'
            ];
            const colorIndex = token.address ? 
                parseInt(token.address.slice(-6), 16) % colors.length :
                Math.floor(Math.random() * colors.length);
            const backgroundColor = colors[colorIndex];
            
            // Update the selector display
            const selector = document.getElementById(`${type}TokenSelector`);
            if (selector) {
                selector.innerHTML = `
                    <div class="token-selector-content">
                        <div class="token-selector-left">
                            <div class="token-icon small">
                                ${token.iconUrl && token.iconUrl !== 'fallback' ? `
                                    <img src="${token.iconUrl}" 
                                        alt="${token.symbol}" 
                                        class="token-icon-image"
                                        onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
                                    <div class="token-icon-fallback" style="display:none;background:${backgroundColor}">
                                        ${token.symbol.charAt(0).toUpperCase()}
                                    </div>` : `
                                    <div class="token-icon-fallback" style="background:${backgroundColor}">
                                        ${token.symbol.charAt(0).toUpperCase()}
                                    </div>`
                                }
                            </div>
                            <div class="token-info">
                                <span class="token-symbol">${token.symbol}</span>
                            </div>
                        </div>
                        <svg width="12" height="12" viewBox="0 0 12 12">
                            <path d="M3 5L6 8L9 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
                        </svg>
                    </div>
                `;
            }

            // Update the new balance display elements
            this.updateBalanceDisplay(type, formattedBalance, balanceUSD);

            // Update amount USD value immediately
            this.updateTokenAmounts(type);

            // Add input event listener for amount changes
            const amountInput = document.getElementById(`${type}Amount`);
            if (amountInput) {
                // Remove existing listeners
                const newInput = amountInput.cloneNode(true);
                amountInput.parentNode.replaceChild(newInput, amountInput);
                // Add new listener
                newInput.addEventListener('input', () => this.updateTokenAmounts(type));
                
                // Focus on the input field after token selection
                setTimeout(() => {
                    newInput.focus();
                }, 100); // Small delay to ensure DOM is updated
            }
        } catch (error) {
            this.debug('Error in handleTokenSelect:', error);
            const reason = error?.reason || error?.message || 'Unknown reason';
            this.showWarning(`Unable to select ${type} token: ${reason}`);
        }
    }

    async handleTokenItemClick(type, tokenItem) {
        try {
            if (this.contractStateReadError) {
                this.showWarning('Unable to verify contract state right now. Please try again shortly.');
                void this.refreshContractDisabledState();
                return;
            }

            if (this.isContractDisabled) {
                this.showWarning('No new orders can be created because this contract is disabled.');
                return;
            }

            const isWalletConnected = walletManager.isWalletConnected();
            if (!isWalletConnected) {
                this.showWarning('Connect wallet to select a token.');
                return;
            }

            const address = tokenItem.dataset.address;
            if (!address) {
                this.showWarning('Unable to select token: missing token address.');
                return;
            }

            const token = this.tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
            
            this.debug('Token item clicked:', {
                type,
                address,
                token
            });
            
            if (!token) {
                this.showWarning('Unable to select token: token is not available in the current list.');
                return;
            }

            // For sell tokens, check if balance is zero
            if (type === 'sell') {
                const balance = Number(token.balance) || 0;
                if (balance <= 0) {
                    this.showWarning(`${token.symbol} has no balance available for selling. Please select a token with a balance.`);
                    return; // Don't allow selection of tokens with zero balance for selling
                }
            }
            
            // Add loading state to token item
            tokenItem.style.opacity = '0.6';
            tokenItem.style.pointerEvents = 'none';
            
            try {
                // Token is already validated since it's in the allowed tokens list
                await this.handleTokenSelect(type, token);
                
                // Close the modal after selection
                const modal = document.getElementById(`${type}TokenModal`);
                if (modal) {
                    modal.style.display = 'none';
                }
            } finally {
                // Remove loading state
                tokenItem.style.opacity = '1';
                tokenItem.style.pointerEvents = 'auto';
            }
        } catch (error) {
            this.debug('Error in handleTokenItemClick:', error);
            const reason = error?.reason || error?.message || 'Unknown reason';
            this.showWarning(`Unable to select token: ${reason}`);
        }
    }

    updateCreateButtonState() {
        try {
            const createButton = document.getElementById('createOrderBtn');
            if (!createButton) return;

            // Check if we have both tokens selected and valid amounts
            const isWalletConnected = walletManager.isWalletConnected();
            const hasTokens = this.sellToken && this.buyToken;
            const sellAmount = document.getElementById('sellAmount')?.value;
            const buyAmount = document.getElementById('buyAmount')?.value;
            const hasAmounts = sellAmount && buyAmount && 
                             Number(sellAmount) > 0 && 
                             Number(buyAmount) > 0;

            const canCreateOrder =
                isWalletConnected &&
                !this.contractStateReadError &&
                !this.isContractDisabled &&
                !this.isSubmitting &&
                hasTokens &&
                hasAmounts;

            createButton.disabled = !canCreateOrder;
            createButton.classList.toggle('disabled', !canCreateOrder);

            if (!isWalletConnected) {
                createButton.textContent = 'Connect Wallet to Create Order';
            } else if (this.contractStateReadError) {
                createButton.textContent = 'Unable to Verify Contract State';
            } else if (this.isContractDisabled) {
                createButton.textContent = 'New Orders Disabled';
            } else if (this.isSubmitting) {
                createButton.textContent = 'Creating Order...';
            } else {
                createButton.textContent = 'Create Order';
            }
        } catch (error) {
            this.debug('Error updating create button state:', error);
        }
    }

    updateSellAmountMax() {
        try {
            if (!this.sellToken) return;
            
            const maxButton = document.getElementById('sellAmountMax');
            if (!maxButton) return;

            // Update max button visibility based on token balance
            if (this.sellToken.balance) {
                maxButton.style.display = 'inline';
                maxButton.onclick = () => {
                    const sellAmount = document.getElementById('sellAmount');
                    if (sellAmount) {
                        sellAmount.value = this.sellToken.balance;
                        this.updateTokenAmounts('sell');
                    }
                };
            } else {
                maxButton.style.display = 'none';
            }
        } catch (error) {
            this.debug('Error updating sell amount max:', error);
        }
    }

    updateTokenAmounts(type) {
        try {
            const amount = document.getElementById(`${type}Amount`)?.value || '0';
            const token = this[`${type}Token`];
            
            // Find USD display element
            let usdDisplay = document.getElementById(`${type}AmountUSD`);
            
            // If no token selected or amount is 0/empty, hide the USD display without removing
            if (!token || !amount || amount === '0') {
                if (usdDisplay) {
                    setVisibility(usdDisplay, false);
                }
                return;
            }
            
            if (token && amount) {
                const usdValue = token.usdPrice !== undefined ? Number(amount) * token.usdPrice : 0;
                // Ensure USD display element exists (in template) and update it
                if (!usdDisplay) {
                    usdDisplay = document.getElementById(`${type}AmountUSD`);
                }
                if (usdDisplay) {
                    usdDisplay.textContent = token.usdPrice !== undefined ? `$${usdValue.toFixed(2)}` : 'N/A';
                    setVisibility(usdDisplay, true);
                }
            }
            
            this.updateCreateButtonState();
        } catch (error) {
            this.debug('Error updating token amounts:', error);
        }
    }

    initializeTokenSelectors() {
        ['sell', 'buy'].forEach(type => {
            const selector = document.getElementById(`${type}TokenSelector`);
            const modal = document.getElementById(`${type}TokenModal`);
            const closeButton = modal?.querySelector('.token-modal-close');
            
            if (selector && modal) {
                // Remove existing listener if any
                if (this.tokenSelectorListeners[type]) {
                    selector.removeEventListener('click', this.tokenSelectorListeners[type]);
                }

                // Create new listener for opening modal
                this.tokenSelectorListeners[type] = () => {
                    // Fast path: gate by known cached state to keep UI responsive.
                    if (this.contractStateReadError) {
                        this.showWarning('Unable to verify contract state right now. Please try again shortly.');
                        void this.refreshContractDisabledState();
                        return;
                    }
                    if (this.isContractDisabled) {
                        this.showWarning('No new orders can be created because this contract is disabled.');
                        return;
                    }
                    modal.style.display = 'block';

                    // Keep state fresh without blocking modal open on network issues.
                    void this.refreshContractDisabledState();
                };

                // Add new listener
                selector.addEventListener('click', this.tokenSelectorListeners[type]);

                // Add close button listener
                if (closeButton) {
                    closeButton.onclick = () => {
                        modal.style.display = 'none';
                    };
                }

                // Close modal when clicking outside (register once)
                if (!this.boundWindowClickHandler) {
                    this.boundWindowClickHandler = (event) => {
                        if (event.target.classList?.contains('token-modal')) {
                            event.target.style.display = 'none';
                        }
                    };
                    window.addEventListener('click', this.boundWindowClickHandler);
                }
            }
        });
    }

    renderTokenList(type, tokens) {
        const modalContent = document.querySelector(`#${type}TokenModal .token-list`);
        if (!modalContent) return;

        const pricing = this.ctx.getPricing();
        modalContent.innerHTML = tokens.map(token => {
            const displayToken = this.normalizeTokenDisplay(token);
            const usdPrice = pricing?.getPrice(displayToken.address);
            const balance = parseFloat(displayToken.balance) || 0;
            const balanceUSD = (balance > 0 && usdPrice !== undefined) ? (balance * usdPrice).toFixed(2) : (usdPrice !== undefined ? '0.00' : 'N/A');
            
            return `
                <div class="token-item" data-address="${displayToken.address}">
                    <div class="token-item-left">
                        <div class="token-icon">
                            ${displayToken.iconUrl && displayToken.iconUrl !== 'fallback' ? 
                                `<img src="${displayToken.iconUrl}" alt="${displayToken.symbol}" class="token-icon-image">` :
                                `<div class="token-icon-fallback">${displayToken.symbol.charAt(0)}</div>`
                            }
                        </div>
                        <div class="token-info">
                            <span class="token-symbol">${displayToken.symbol}</span>
                            <span class="token-name">${displayToken.name || ''}</span>
                        </div>
                    </div>
                    <div class="token-balance">
                        ${balance.toFixed(2)} ($${balanceUSD})
                    </div>
                </div>
            `;
        }).join('');

        // Add click handlers to token items
        modalContent.querySelectorAll('.token-item').forEach(item => {
            item.addEventListener('click', () => this.handleTokenItemClick(type, item));
        });
    }

    // Add this method to initialize amount input listeners
    initializeAmountInputs() {
        ['sell', 'buy'].forEach(type => {
            const amountInput = document.getElementById(`${type}Amount`);
            if (amountInput) {
                // Remove prior listener if present
                if (this.amountInputListeners[type]) {
                    amountInput.removeEventListener('input', this.amountInputListeners[type]);
                }
                // Create and store new listener
                this.amountInputListeners[type] = () => this.updateTokenAmounts(type);
                amountInput.addEventListener('input', this.amountInputListeners[type]);
            }
        });

        // Initialize balance click handlers for auto-fill functionality
        this.initializeBalanceClickHandlers();
    }

    /**
     * Initialize click handlers for balance auto-fill functionality
     */
    initializeBalanceClickHandlers() {
        ['sell', 'buy'].forEach(type => {
            const balanceBtn = document.getElementById(`${type}TokenBalanceBtn`);
            if (balanceBtn) {
                // Remove existing listeners using clone technique to prevent duplicates
                const newBalanceBtn = balanceBtn.cloneNode(true);
                balanceBtn.parentNode.replaceChild(newBalanceBtn, balanceBtn);
                
                // Add click handler for auto-fill functionality
                newBalanceBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.handleBalanceClick(type, newBalanceBtn);
                });

                // Add keyboard support for accessibility
                newBalanceBtn.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        this.handleBalanceClick(type, newBalanceBtn);
                    }
                });

                this.debug(`Initialized balance click handler for ${type} token`);
            }
        });
    }

    /**
     * Handle balance click to auto-fill amount input
     * @param {string} type - 'sell' or 'buy'
     */
    handleBalanceClick(type, sourceButton = null) {
        try {
            const token = this[`${type}Token`];
            if (!token) {
                this.debug(`No ${type} token selected`);
                return;
            }

            const balance = parseFloat(token.balance) || 0;
            if (balance <= 0) {
                this.debug(`${type} token has no balance`);
                return;
            }

            const amountInput = document.getElementById(`${type}Amount`);
            if (amountInput) {
                // Format balance for input (remove grouping, keep decimals)
                const formattedBalance = balance.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 4,
                    useGrouping: false
                });

                // Set the input value
                amountInput.value = formattedBalance;
                
                // Trigger input event to update calculations
                amountInput.dispatchEvent(new Event('input', { bubbles: true }));
                
                // Focus the input for better UX
                amountInput.focus();

                // Prevent persistent "selected" focus ring on the balance button after click.
                if (sourceButton && typeof sourceButton.blur === 'function') {
                    sourceButton.blur();
                }
                
                this.debug(`Auto-filled ${type} amount with balance: ${formattedBalance}`);
                
                // Show success feedback
                /* this.showSuccess(`Filled ${type} amount with available balance`); */
            }
        } catch (error) {
            this.error(`Error handling ${type} balance click:`, error);
            this.showError(`Failed to fill ${type} amount`);
        }
    }

    // Add new render method
    render() {
        return `
            <!-- Token swap form interface -->
            <div class="form-container card">
                <div class="swap-section swap-section--transparent-connected">
                    <!-- Sell token input section -->
                    <div id="sellContainer" class="swap-input-container">
                        <div class="amount-input-wrapper">
                            <input type="number" id="sellAmount" placeholder="0.0" />
                            <button id="sellAmountMax" class="max-button">MAX</button>
                        </div>
                        <div class="amount-usd is-hidden" id="sellAmountUSD" aria-hidden="true">≈ $0.00</div>
                        <div id="sellTokenSelector" class="token-selector">
                            <div class="token-selector-content">
                                <span>Select Token</span>
                            </div>
                        </div>
                        <div id="sellTokenBalanceDisplay" class="token-balance-display is-hidden" aria-hidden="true">
                            <button id="sellTokenBalanceBtn" class="balance-clickable" aria-label="Click to fill sell amount with available balance">
                                <span class="balance-amount" id="sellTokenBalanceAmount">0.00</span>
                                <span class="balance-usd" id="sellTokenBalanceUSD">• $0.00</span>
                            </button>
                        </div>
                    </div>

                    <!-- Swap direction arrow -->
                    <div class="swap-arrow">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                            <path d="M12 5l0 14M5 12l7 7 7-7" stroke-width="2" stroke-linecap="round" />
                        </svg>
                    </div>

                    <!-- Buy token input section -->
                    <div id="buyContainer" class="swap-input-container">
                        <div class="amount-input-wrapper">
                            <input type="number" id="buyAmount" placeholder="0.0" />
                        </div>
                        <div class="amount-usd is-hidden" id="buyAmountUSD" aria-hidden="true">≈ $0.00</div>
                        <div id="buyTokenSelector" class="token-selector">
                            <div class="token-selector-content">
                                <span>Select Token</span>
                            </div>
                        </div>
                        <div class="token-balance-display token-balance-display--placeholder is-hidden" aria-hidden="true">
                            <span class="balance-clickable balance-clickable--placeholder" aria-hidden="true">
                                <span class="balance-amount">0.00</span>
                                <span class="balance-usd">• $0.00</span>
                            </span>
                        </div>
                    </div>

                    <!-- Optional taker address input -->
                    <div class="taker-input-container">
                        <div class="taker-input-header">
                            <button class="taker-toggle" type="button" aria-expanded="false" aria-controls="taker-input-content">
                                <div class="taker-toggle-content">
                                    <span class="taker-toggle-text">Specify Taker Address</span>
                                    <span class="optional-text">(optional)</span>
                                </div>
                                <svg class="chevron-down" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                    <path d="M6 9l6 6 6-6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                                </svg>
                            </button>
                            <span class="info-tooltip">
                                <button
                                    type="button"
                                    class="info-tooltip-trigger"
                                    aria-label="Explain taker address"
                                    aria-describedby="taker-address-tooltip"
                                    aria-expanded="false"
                                >
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                        <circle cx="12" cy="12" r="10" stroke-width="2" />
                                        <path d="M12 16v-4" stroke-width="2" stroke-linecap="round" />
                                        <circle cx="12" cy="8" r="1" fill="currentColor" />
                                    </svg>
                                </button>
                                <span id="taker-address-tooltip" class="tooltip-text" role="tooltip">
                                    Specify a wallet address that can take this order.
                                    Leave empty to allow anyone to take it.
                                </span>
                            </span>
                        </div>
                        <div id="taker-input-content" class="taker-input-content hidden">
                            <input type="text" id="takerAddress" class="taker-address-input" placeholder="0x..." />
                        </div>
                    </div>

                    <!-- Fee display section -->
                    <div class="form-group fee-group">
                        <label>
                            Order Creation Fee:
                            <span class="info-tooltip">
                                <button
                                    type="button"
                                    class="info-tooltip-trigger"
                                    aria-label="Explain order creation fee"
                                    aria-describedby="order-fee-tooltip"
                                    aria-expanded="false"
                                >
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                        <circle cx="12" cy="12" r="10" stroke-width="2" />
                                        <path d="M12 16v-4" stroke-width="2" stroke-linecap="round" />
                                        <circle cx="12" cy="8" r="1" fill="currentColor" />
                                    </svg>
                                </button>
                                <span id="order-fee-tooltip" class="tooltip-text" role="tooltip">
                                    <strong>Order Creation Fee:</strong> A small fee in <span class="fee-token-symbol">the configured fee token</span> is required to create an order.
                                    This helps prevent spam and incentivizes users who assist in cleaning up expired orders.
                                </span>
                            </span>
                        </label>
                        <div id="orderCreationFee">
                            <span class="fee-amount"></span>
                        </div>
                    </div>

                    <!-- Create order button -->
                    <button class="action-button" id="createOrderBtn" disabled>
                        Connect Wallet to Create Order
                    </button>

                    <!-- Status messages -->
                    <div id="status" class="status"></div>
                </div>
            </div>
        `;
    }

    // Refresh token modal lists if open (balances/icons may have changed)
    refreshOpenTokenModals() {
        try {
            ['sell', 'buy'].forEach(type => {
                const modal = document.getElementById(`${type}TokenModal`);
                if (modal && modal.style.display === 'block') {
                    const allowedTokensList = modal.querySelector(`#${type}AllowedTokenList`);
                    if (allowedTokensList && Array.isArray(this.allowedTokens)) {
                        this.displayTokens(this.allowedTokens, allowedTokensList, type);
                    }
                }
            });
        } catch (error) {
            this.debug('Error refreshing open token modals:', error);
        }
    }
}
