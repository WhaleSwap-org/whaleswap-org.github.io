import { ContractError, CONTRACT_ERRORS } from '../errors/ContractErrors.js';
import { ethers } from 'ethers';
import { getNetworkConfig } from '../config/networks.js';
import { tokenIconService } from './TokenIconService.js';
import { generateTokenIconHTML } from '../utils/tokenIcons.js';
import { createLogger } from './LogService.js';
import { erc20Abi } from '../abi/erc20.js';
import { getOrderStatusText } from '../utils/orderUtils.js';
import { handleTransactionError } from '../utils/ui.js';

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
     * Fill an active OTC order for the connected account.
     *
     * This is the shared fill path used by both View Orders and Invited Orders.
     * It performs the required client-side checks (wallet/signer, status, expiry,
     * balances, allowance), sends approval if needed, then executes `fillOrder`.
     *
     * Side effects:
     * - Disables/enables the row button while the tx is in flight
     * - Updates `component.isProcessingFill` as a re-entrancy guard
     * - Shows success/error toasts
     * - Refreshes the owning component's orders view on success
     *
     * @param {number|string} orderId - Order id to fill
     * @returns {Promise<void>}
     */
    async fillOrder(orderId) {
        // Prevent duplicate submissions while a fill tx is already in flight.
        if (this.component.isProcessingFill) {
            this.debug('Fill already in progress, ignoring duplicate request');
            return;
        }

        // Capture button state so we can restore the exact label afterward.
        const normalizedOrderId = Number(orderId);
        const button = this.component.container.querySelector(
            `button[data-order-id="${normalizedOrderId}"]`
        );
        const originalButtonLabel = button?.textContent;

        this.component.isProcessingFill = true;

        try {
            // Validate wallet/signer readiness before any contract calls.
            const provider = this.component.provider;
            if (!provider) {
                throw new Error('MetaMask is not installed. Please install MetaMask to take orders.');
            }

            const wallet = this.component.ctx.getWallet();
            const connectedAccount = wallet?.getAccount();
            if (!connectedAccount) {
                throw new Error('Please sign in to fill order');
            }

            let signer;
            try {
                signer = provider.getSigner();
                await signer.getAddress();
            } catch (_) {
                throw new Error('Please sign in to fill order');
            }

            if (button) {
                button.disabled = true;
                button.textContent = 'Filling...';
                button.classList.add('disabled');
            }

            this.debug('Starting fill order process for orderId:', normalizedOrderId);

            // Load cached order and verify current on-chain status/time constraints.
            const ws = this.component.ctx.getWebSocket();
            const order = ws.orderCache.get(normalizedOrderId);
            this.debug('Order details:', order);

            if (!order) {
                throw new Error('Order not found');
            }

            const contract = await this.component.getContract();
            if (!contract) {
                throw new Error('Contract not available');
            }

            const contractWithSigner = contract.connect(signer);

            const currentOrder = await contractWithSigner.orders(normalizedOrderId);
            const currentOrderStatus = Number(currentOrder.status);
            if (currentOrderStatus !== 0) {
                throw new Error(`Order is not active (status: ${getOrderStatusText(currentOrderStatus)})`);
            }

            await ws.ensureFreshChainTime(0);
            const now = ws.getCurrentTimestamp();
            const expiryTime = ws.getOrderExpiryTime(order);
            if (Number.isFinite(expiryTime) && now > expiryTime) {
                throw new Error('Order has expired');
            }

            // Validate taker-side token prerequisites (balance and allowance).
            const buyToken = new ethers.Contract(order.buyToken, erc20Abi, signer);
            const sellToken = new ethers.Contract(order.sellToken, erc20Abi, signer);
            const currentAccount = await signer.getAddress();

            const [buyTokenDecimals, buyTokenSymbol, buyTokenBalance] = await Promise.all([
                buyToken.decimals(),
                buyToken.symbol(),
                buyToken.balanceOf(currentAccount)
            ]);

            this.debug('Buy token balance:', {
                balance: buyTokenBalance.toString(),
                required: order.buyAmount.toString()
            });

            if (buyTokenBalance.lt(order.buyAmount)) {
                const formattedBalance = ethers.utils.formatUnits(buyTokenBalance, buyTokenDecimals);
                const formattedRequired = ethers.utils.formatUnits(order.buyAmount, buyTokenDecimals);

                throw new Error(
                    `Insufficient ${buyTokenSymbol} balance.\n` +
                    `Required: ${Number(formattedRequired).toLocaleString()} ${buyTokenSymbol}\n` +
                    `Available: ${Number(formattedBalance).toLocaleString()} ${buyTokenSymbol}`
                );
            }

            const buyTokenAllowance = await buyToken.allowance(currentAccount, contract.address);
            this.debug('Buy token allowance:', {
                current: buyTokenAllowance.toString(),
                required: order.buyAmount.toString()
            });

            if (buyTokenAllowance.lt(order.buyAmount)) {
                this.debug('Requesting buy token approval');
                const approveTx = await buyToken.approve(contract.address, order.buyAmount);
                await approveTx.wait();
                this.component.showSuccess(`${buyTokenSymbol} approval granted`);
            }

            // Ensure contract still holds maker-side sell liquidity.
            const contractSellBalance = await sellToken.balanceOf(contract.address);
            this.debug('Contract sell token balance:', {
                balance: contractSellBalance.toString(),
                required: order.sellAmount.toString()
            });

            if (contractSellBalance.lt(order.sellAmount)) {
                const [sellTokenSymbol, sellTokenDecimals] = await Promise.all([
                    sellToken.symbol(),
                    sellToken.decimals()
                ]);
                const formattedBalance = ethers.utils.formatUnits(contractSellBalance, sellTokenDecimals);
                const formattedRequired = ethers.utils.formatUnits(order.sellAmount, sellTokenDecimals);

                throw new Error(
                    `Contract has insufficient ${sellTokenSymbol} balance.\n` +
                    `Required: ${Number(formattedRequired).toLocaleString()} ${sellTokenSymbol}\n` +
                    `Available: ${Number(formattedBalance).toLocaleString()} ${sellTokenSymbol}`
                );
            }

            // Execute fill with a small gas buffer for estimator variance.
            const gasEstimate = await contractWithSigner.estimateGas.fillOrder(normalizedOrderId);
            this.debug('Gas estimate:', gasEstimate.toString());

            const gasLimit = gasEstimate.mul(120).div(100);
            const tx = await contractWithSigner.fillOrder(normalizedOrderId, { gasLimit });
            this.debug('Transaction sent:', tx.hash);

            const receipt = await tx.wait();
            this.debug('Transaction receipt:', receipt);

            if (receipt.status === 0) {
                throw new Error('Transaction reverted by contract');
            }

            order.status = 'Filled';
            await this.component.refreshOrdersView();

            this.component.showSuccess(`Order ${normalizedOrderId} filled successfully!`);
        } catch (error) {
            this.debug('Fill order error details:', error);
            handleTransactionError(error, this.component, 'fill order');
        } finally {
            // Always restore UI state and clear the in-flight guard.
            if (button) {
                button.disabled = false;
                button.textContent = originalButtonLabel;
                button.classList.remove('disabled');
            }
            this.component.isProcessingFill = false;
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
