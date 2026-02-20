import { ContractError, CONTRACT_ERRORS } from '../errors/ContractErrors.js';
import { getNetworkConfig } from '../config/networks.js';
import { tokenIconService } from './TokenIconService.js';
import { generateTokenIconHTML } from '../utils/tokenIcons.js';
import { createLogger } from './LogService.js';

/**
 * OrdersComponentHelper - Shared setup and utility logic for order components
 * 
 * Provides common functionality for ViewOrders, MyOrders, and TakerOrders:
 * - Service setup (provider, pricing, WebSocket subscriptions)
 * - Error handling
 * - Token icon rendering
 * - WebSocket event subscriptions
 */
export class OrdersComponentHelper {
    constructor(component) {
        this.component = component; // Reference to the component using this helper
        const logger = createLogger('ORDERS_HELPER');
        this.debug = logger.debug.bind(logger);
        this.error = logger.error.bind(logger);
        this.warn = logger.warn.bind(logger);
    }

    /**
     * Setup provider, services, and subscriptions
     * @param {Object} options - Configuration options
     * @param {Function} options.onRefresh - Callback when orders should refresh
     */
    setupServices(options = {}) {
        const { onRefresh } = options;
        
        // Setup provider from wallet
        if (!this.component.provider) {
            const wallet = this.component.ctx.getWallet();
            this.component.provider = wallet?.provider || null;
            
            if (!this.component.provider) {
                this.debug('No provider available from walletManager');
            }
        }
        
        // Setup pricing service
        this.component.pricingService = this.component.ctx.getPricing();
        
        // Setup error handling
        this.setupErrorHandling();
        
        // Subscribe to pricing updates
        if (this.component.pricingService && !this.component._boundPricingHandler) {
            this.component._boundPricingHandler = (event) => {
                if (event === 'refreshComplete') {
                    this.debug('Prices updated, refreshing orders view');
                    if (onRefresh) {
                        onRefresh().catch(error => {
                            this.component.error('Error refreshing orders after price update:', error);
                        });
                    }
                }
            };
            this.component.pricingService.subscribe(this.component._boundPricingHandler);
        }

        // Subscribe to WebSocket updates
        const ws = this.component.ctx.getWebSocket();
        if (ws && !this.component._boundOrdersUpdatedHandler) {
            this.component._boundOrdersUpdatedHandler = () => {
                this.debug('Orders updated via WebSocket, refreshing view');
                if (onRefresh) {
                    onRefresh().catch(error => {
                        this.component.error('Error refreshing orders after WebSocket update:', error);
                    });
                }
            };
            ws.subscribe("ordersUpdated", this.component._boundOrdersUpdatedHandler);
        }
    }

    /**
     * Setup WebSocket error handling
     */
    setupErrorHandling() {
        const ws = this.component.ctx.getWebSocket();
        if (!ws) {
            if (!this.component._retryAttempt) {
                this.warn('WebSocket not available, waiting for initialization...');
                this.component._retryAttempt = true;
            }
            setTimeout(() => this.setupErrorHandling(), 1000);
            return;
        }
        this.component._retryAttempt = false;

        ws.subscribe('error', (error) => {
            let userMessage = 'An error occurred';
            
            if (error instanceof ContractError) {
                switch(error.code) {
                    case CONTRACT_ERRORS.INVALID_ORDER.code:
                        userMessage = 'This order no longer exists';
                        break;
                    case CONTRACT_ERRORS.INSUFFICIENT_ALLOWANCE.code:
                        userMessage = 'Please approve tokens before proceeding';
                        break;
                    case CONTRACT_ERRORS.UNAUTHORIZED.code:
                        userMessage = 'You are not authorized to perform this action';
                        break;
                    case CONTRACT_ERRORS.EXPIRED_ORDER.code:
                        userMessage = 'This order has expired';
                        break;
                    default:
                        userMessage = error.message;
                }
            }

            this.component.showError(userMessage);
            this.component.error('Order error:', {
                code: error.code,
                message: error.message,
                details: error.details
            });
        });
    }

    /**
     * Setup WebSocket event subscriptions
     * @param {Function} onRefresh - Callback when orders should refresh
     */
    async setupWebSocket(onRefresh) {
        this.debug('Setting up WebSocket subscriptions');
        
        const ws = this.component.ctx.getWebSocket();
        if (!ws?.provider) {
            this.debug('WebSocket provider not available, waiting for reconnection...');
            return;
        }

        // Clear existing subscriptions
        if (this.component.eventSubscriptions) {
            this.component.eventSubscriptions.forEach(sub => {
                ws.unsubscribe(sub.event, sub.callback);
            });
            this.component.eventSubscriptions.clear();
        } else {
            this.component.eventSubscriptions = new Set();
        }

        // Add new subscriptions with error handling
        const addSubscription = (event, callback) => {
            const wrappedCallback = async (...args) => {
                try {
                    await callback(...args);
                } catch (error) {
                    this.debug(`Error in ${event} callback:`, error);
                    this.component.showError('Error processing order update');
                }
            };
            ws.subscribe(event, wrappedCallback);
            this.component.eventSubscriptions.add({ event, callback: wrappedCallback });
        };

        // Subscribe to order events
        addSubscription('OrderCreated', async (orderData) => {
            this.debug('Order created event received');
            if (onRefresh) {
                await onRefresh();
            }
        });

        addSubscription('OrderFilled', async (orderData) => {
            this.debug('Order filled event received');
            if (onRefresh) {
                await onRefresh();
            }
        });

        addSubscription('OrderCanceled', async (orderData) => {
            this.debug('Order canceled event received');
            if (onRefresh) {
                await onRefresh();
            }
        });
    }

    /**
     * Initialize WebSocket and wait for it to be ready
     * @param {Function} onRefresh - Callback when orders should refresh
     */
    async initWebSocket(onRefresh) {
        try {
            this.debug('Initializing WebSocket...');
            
            const ws = this.component.ctx.getWebSocket();
            if (!ws) {
                this.debug('WebSocket not available, showing loading state...');
                this.component.showLoadingState();
                await new Promise(resolve => setTimeout(resolve, 1000));
                return this.initWebSocket(onRefresh); // Retry
            }

            // Wait for WebSocket to be fully initialized
            await ws.waitForInitialization();
            
            // Get current account
            const wallet = this.component.ctx.getWallet();
            this.component.currentAccount = wallet?.getAccount()?.toLowerCase();
            this.debug('Current account:', this.component.currentAccount);
            
            // Add wallet state listener
            this.component.walletListener = (event, data) => {
                this.debug('Wallet event received:', event, data);
                if (event === 'connect' || event === 'disconnect' || event === 'accountsChanged') {
                    this.debug('Wallet state changed, refreshing orders view');
                    this.component.currentAccount = wallet?.getAccount()?.toLowerCase();
                    if (onRefresh) {
                        onRefresh().catch(error => {
                            this.component.error('Error refreshing orders after wallet state change:', error);
                        });
                    }
                }
            };
            wallet?.addListener(this.component.walletListener);
            
            // Setup WebSocket subscriptions
            await this.setupWebSocket(onRefresh);
            
            this.debug('WebSocket initialization complete');
        } catch (error) {
            this.debug('Error in WebSocket initialization:', error);
            this.component.showError('Failed to initialize orders view');
        }
    }

    /**
     * Get token icon HTML
     * @param {Object} token - Token object with address, symbol, etc.
     * @returns {Promise<string>} Icon HTML
     */
    async getTokenIcon(token) {
        try {
            if (!token?.address) {
                this.debug('No token address provided:', token);
                return this.getDefaultTokenIcon();
            }

            // If token already has an iconUrl, use it
            if (token.iconUrl) {
                this.debug('Using existing iconUrl for token:', token.symbol);
                return generateTokenIconHTML(token.iconUrl, token.symbol, token.address);
            }
            
            // Otherwise, get icon URL from token icon service
            const wallet = this.component.ctx.getWallet();
            const fallbackChainId = Number.parseInt(getNetworkConfig().chainId, 16) || 137;
            const chainId = wallet?.chainId ? parseInt(wallet.chainId, 16) : fallbackChainId;
            const iconUrl = await tokenIconService.getIconUrl(token.address, chainId);
            
            // Generate HTML using the utility function
            return generateTokenIconHTML(iconUrl, token.symbol, token.address);
        } catch (error) {
            this.debug('Error getting token icon:', error);
            return this.getDefaultTokenIcon();
        }
    }

    /**
     * Get default token icon HTML
     * @returns {string} Default icon HTML
     */
    getDefaultTokenIcon() {
        return generateTokenIconHTML('fallback', '?', 'unknown');
    }

    /**
     * Render token icon asynchronously into a container
     * @param {Object} token - Token object
     * @param {HTMLElement} container - Container element
     */
    async renderTokenIcon(token, container) {
        try {
            const iconHtml = await this.getTokenIcon(token);
            container.innerHTML = iconHtml;
        } catch (error) {
            this.debug('Error rendering token icon:', error);
            // Fallback to basic icon
            container.innerHTML = generateTokenIconHTML('fallback', token.symbol, token.address);
        }
    }

    /**
     * Update last updated timestamp element
     * @param {HTMLElement} element - Element to update
     */
    updateLastUpdatedTimestamp(element) {
        if (!element || !this.component.pricingService) return;
        
        const lastUpdateTime = this.component.pricingService.getLastUpdateTime();
        if (lastUpdateTime && lastUpdateTime !== 'Never') {
            element.textContent = `Last updated: ${lastUpdateTime}`;
            element.style.display = 'inline';
        } else {
            element.textContent = 'No prices loaded yet';
            element.style.display = 'inline';
        }
    }

    /**
     * Cleanup subscriptions and listeners
     */
    cleanup() {
        // Unsubscribe from WebSocket events
        const ws = this.component.ctx.getWebSocket();
        if (ws && this.component.eventSubscriptions) {
            this.component.eventSubscriptions.forEach(sub => {
                ws.unsubscribe(sub.event, sub.callback);
            });
            this.component.eventSubscriptions.clear();
        }

        // Unsubscribe from pricing service
        if (this.component.pricingService && this.component._boundPricingHandler) {
            this.component.pricingService.unsubscribe(this.component._boundPricingHandler);
            this.component._boundPricingHandler = null;
        }

        // Unsubscribe from WebSocket ordersUpdated
        if (ws && this.component._boundOrdersUpdatedHandler) {
            ws.unsubscribe("ordersUpdated", this.component._boundOrdersUpdatedHandler);
            this.component._boundOrdersUpdatedHandler = null;
        }

        // Remove wallet listener
        const wallet = this.component.ctx.getWallet();
        if (wallet && this.component.walletListener) {
            wallet.removeListener(this.component.walletListener);
            this.component.walletListener = null;
        }

        // Clear refresh timeout
        if (this.component._refreshTimeout) {
            clearTimeout(this.component._refreshTimeout);
            this.component._refreshTimeout = null;
        }
    }
}
