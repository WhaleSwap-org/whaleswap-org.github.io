import { BaseComponent } from './BaseComponent.js';
import { ethers } from 'ethers';
import { erc20Abi } from '../abi/erc20.js';
import { createLogger } from '../services/LogService.js';
import { handleTransactionError } from '../utils/ui.js';
import { formatTimeDiff, getOrderStatusText, calculateTotalValue } from '../utils/orderUtils.js';
import { OrdersComponentHelper } from '../services/OrdersComponentHelper.js';
import { OrdersTableRenderer } from '../services/OrdersTableRenderer.js';

export class ViewOrders extends BaseComponent {
    constructor(containerId = 'view-orders') {
        super(containerId);
        
        // Initialize logger first
        const logger = createLogger('VIEW_ORDERS');
        this.debug = logger.debug.bind(logger);
        this.error = logger.error.bind(logger);
        this.warn = logger.warn.bind(logger);
        
        // Initialize state (no side effects)
        this.provider = null;
        this.currentPage = 1;
        this.totalOrders = 0;
        this.eventSubscriptions = new Set();
        this.expiryTimers = new Map();
        this.tokenList = [];
        this.currentAccount = null;
        this.isLoading = false;
        this.pricingService = null;
        
        // Bound handlers for cleanup
        this._boundPricingHandler = null;
        this._boundOrdersUpdatedHandler = null;
        this._refreshTimeout = null;
        
        // Initialize helper and renderer
        this.helper = new OrdersComponentHelper(this);
        this.renderer = new OrdersTableRenderer(this, {
            rowRenderer: (order) => this.createOrderRow(order),
            showRefreshButton: true
        });
        
        // Debounce mechanism
        this.debouncedRefresh = () => {
            clearTimeout(this._refreshTimeout);
            this._refreshTimeout = setTimeout(() => {
                this.refreshOrdersView().catch(error => {
                    this.error('Error refreshing orders:', error);
                });
            }, 100);
        };
        
        this.debug('Constructor completed (no side effects)');
    }
    
    /**
     * Setup provider, services, and subscriptions
     * Called once during first initialize()
     */
    setupServices() {
        this.helper.setupServices({
            onRefresh: () => this.refreshOrdersView()
        });
    }


    showLoadingState() {
        this.container.innerHTML = `
            <div class="loading-container">
                <div class="loading-spinner"></div>
                <div class="loading-text">Loading orders...</div>
            </div>`;
    }

    // Token icon and timestamp methods now handled by helper
    async getTokenIcon(token) { return this.helper.getTokenIcon(token); }
    getDefaultTokenIcon() { return this.helper.getDefaultTokenIcon(); }
    async renderTokenIcon(token, container) { return this.helper.renderTokenIcon(token, container); }
    updateLastUpdatedTimestamp(element) { return this.helper.updateLastUpdatedTimestamp(element); }
    setupErrorHandling() { return this.helper.setupErrorHandling(); }

    async initialize(readOnlyMode = true) {
        if (this.initializing) {
            this.debug('Already initializing, skipping...');
            return;
        }
        
        this.initializing = true;
        
        try {
            if (!this.initialized) {
                // First time setup - initialize services, create table, setup WebSocket
                this.setupServices();
                await this.renderer.setupTable(() => this.refreshOrdersView());
                await this.helper.setupWebSocket(() => this.refreshOrdersView());
                this.initialized = true;
            }
            // Just refresh the view with current cache
            await this.refreshOrdersView();
        } catch (error) {
            this.error('Error in initialize:', error);
        } finally {
            this.initializing = false;
        }
    }

    // setupWebSocket now handled by helper
    async setupWebSocket() {
        return this.helper.setupWebSocket(() => this.refreshOrdersView());
    }

    async refreshOrdersView() {
        if (this.isLoading) return;
        this.isLoading = true;
        
        try {
            // Get all orders first
            const ws = this.ctx.getWebSocket();
            const wallet = this.ctx.getWallet();
            let ordersToDisplay = Array.from(ws.orderCache.values());
            
            // Apply token filters
            const sellTokenFilter = this.container.querySelector('#sell-token-filter')?.value;
            const buyTokenFilter = this.container.querySelector('#buy-token-filter')?.value;
            const orderSort = this.container.querySelector('#order-sort')?.value;
            const showOnlyActive = this.container.querySelector('#fillable-orders-toggle')?.checked;

            // Reset to page 1 when filters change
            if (this._lastFilters?.sellToken !== sellTokenFilter ||
                this._lastFilters?.buyToken !== buyTokenFilter ||
                this._lastFilters?.showOnlyActive !== showOnlyActive) {
                this.currentPage = 1;
            }

            // Store current filter state
            this._lastFilters = {
                sellToken: sellTokenFilter,
                buyToken: buyTokenFilter,
                showOnlyActive: showOnlyActive
            };

            // Filter orders based on status and fillable flag
            ordersToDisplay = ordersToDisplay.filter(order => {
                const currentTime = Math.floor(Date.now() / 1000);
                const expiresAt = order?.timings?.expiresAt;
                const isExpired = typeof expiresAt === 'number' ? currentTime > expiresAt : false;
                const isActive = order.status === 'Active' && !isExpired;
                const canFill = ws.canFillOrder(order, wallet?.getAccount());
                const isUserOrder = order.maker?.toLowerCase() === wallet?.getAccount()?.toLowerCase();

                // Apply token filters
                if (sellTokenFilter && order.sellToken.toLowerCase() !== sellTokenFilter.toLowerCase()) return false;
                if (buyTokenFilter && order.buyToken.toLowerCase() !== buyTokenFilter.toLowerCase()) return false;

                // Apply active/fillable filter
                if (showOnlyActive) {
                    return isActive && (canFill || isUserOrder);
                }
                
                return true; // Show all orders when checkbox is unchecked
            });

            // Set total orders after filtering
            this.totalOrders = ordersToDisplay.length;

            // Apply sorting
            if (orderSort === 'newest') {
                ordersToDisplay.sort((a, b) => b.id - a.id);
            } else if (orderSort === 'best-deal') {
                ordersToDisplay.sort((a, b) => {
                    const dealA = a.dealMetrics?.deal > 0 ? 1 / a.dealMetrics.deal : Infinity;
                    const dealB = b.dealMetrics?.deal > 0 ? 1 / b.dealMetrics.deal : Infinity;
                    return dealB - dealA; // Higher deal is better for buyer perspective
                });
            }

            // Apply pagination
            const pageSizeSelect = this.container.querySelector('#page-size-select');
            const pageSize = pageSizeSelect ? parseInt(pageSizeSelect.value) : 25; // Default to 25 if element doesn't exist
            const startIndex = (this.currentPage - 1) * pageSize;
            const endIndex = pageSize === -1 ? ordersToDisplay.length : startIndex + pageSize;
            const paginatedOrders = pageSize === -1 ? 
                ordersToDisplay : 
                ordersToDisplay.slice(startIndex, endIndex);

            // Render orders using renderer
            if (paginatedOrders.length === 0) {
                // Show empty state
                const tbody = this.container.querySelector('tbody');
                if (tbody) {
                    tbody.innerHTML = `
                        <tr class="empty-message">
                            <td colspan="7" class="no-orders-message">
                                <div class="placeholder-text">
                                    ${showOnlyActive ? 
                                        'No fillable orders found' : 
                                        'No orders found'}
                                </div>
                            </td>
                        </tr>`;
                }
            } else {
                await this.renderer.renderOrders(paginatedOrders);
            }

            // Update pagination controls
            this.renderer.updatePaginationControls(this.totalOrders);

        } catch (error) {
            this.debug('Error refreshing orders:', error);
            this.showError('Failed to refresh orders view');
        } finally {
            this.isLoading = false;
        }
    }

    showReadOnlyMessage() {
        this.container.innerHTML = `
            <div class="tab-content-wrapper">
                <h2>Orders</h2>
                <p class="connect-prompt">Connect wallet to view orders</p>
            </div>`;
    }

    // setupTable now handled by renderer
    async setupTable() {
        return this.renderer.setupTable(() => this.refreshOrdersView());
    }

    setupEventListeners() {
        const tbody = this.container.querySelector('tbody');
        if (tbody) {
            tbody.addEventListener('click', async (e) => {
                if (e.target.classList.contains('fill-button')) {
                    const orderId = e.target.dataset.orderId;
                    await this.fillOrder(orderId);
                }
            });
        }
    }

    async checkAllowance(tokenAddress, owner, amount) {
        try {
            if (!this.provider) {
                return false;
            }
            const tokenContract = new ethers.Contract(
                tokenAddress,
                ['function allowance(address owner, address spender) view returns (uint256)'],
                this.provider
            );
            const ws = this.ctx.getWebSocket();
            const allowance = await tokenContract.allowance(owner, ws.contractAddress);
            return allowance.gte(amount);
        } catch (error) {
            this.error('Error checking allowance:', error);
            return false;
        }
    }

    async fillOrder(orderId) {
        const button = this.container.querySelector(`button[data-order-id="${orderId}"]`);
        
        try {
            if (!this.provider) {
                throw new Error('MetaMask is not installed. Please install MetaMask to take orders.');
            }

            // Check if wallet is connected and has an account
            const wallet = this.ctx.getWallet();
            const connectedAccount = wallet?.getAccount();
            if (!connectedAccount) {
                throw new Error('Please sign in to fill order');
            }

            // Additional check to ensure signer is properly connected
            try {
                const signer = this.provider.getSigner();
                await signer.getAddress(); // This will throw if not properly connected
            } catch (error) {
                throw new Error('Please sign in to fill order');
            }

            if (button) {
                button.disabled = true;
                button.textContent = 'Filling...';
                button.classList.add('disabled');
            }

            this.debug('Starting fill order process for orderId:', orderId);
            
            const ws = this.ctx.getWebSocket();
            const order = ws.orderCache.get(Number(orderId));
            this.debug('Order details:', order);

            if (!order) {
                throw new Error('Order not found');
            }

            // Get contract from WebSocket and connect to signer
            const contract = await this.getContract();
            if (!contract) {
                throw new Error('Contract not available');
            }
            const signer = this.provider.getSigner();
            const contractWithSigner = contract.connect(signer);

            // Check order status first
            const currentOrder = await contractWithSigner.orders(orderId);
            this.debug('Current order state:', currentOrder);
            
            if (currentOrder.status !== 0) {
                throw new Error(`Order is not active (status: ${getOrderStatusText(currentOrder.status)})`);
            }

            // Check expiry
            const now = Math.floor(Date.now() / 1000);
            const orderExpiry = await contract.ORDER_EXPIRY();
            const expiryTime = Number(order.timestamp) + orderExpiry.toNumber();
            
            if (now >= expiryTime) {
                throw new Error('Order has expired');
            }

            // Get token contracts
            const buyToken = new ethers.Contract(
                order.buyToken,
                erc20Abi,
                this.provider.getSigner()
            );
            
            const sellToken = new ethers.Contract(
                order.sellToken,
                erc20Abi,
                this.provider.getSigner()
            );

            const currentAccount = await this.provider.getSigner().getAddress();

            // Get token details for proper formatting
            const buyTokenDecimals = await buyToken.decimals();
            const buyTokenSymbol = await buyToken.symbol();
            
            // Check balances first
            const buyTokenBalance = await buyToken.balanceOf(currentAccount);
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

            // Check allowances
            const buyTokenAllowance = await buyToken.allowance(currentAccount, contract.address);
            this.debug('Buy token allowance:', {
                current: buyTokenAllowance.toString(),
                required: order.buyAmount.toString()
            });

            if (buyTokenAllowance.lt(order.buyAmount)) {
                this.debug('Requesting buy token approval');
                const approveTx = await buyToken.approve(
                    contract.address, 
                    order.buyAmount  // Use exact order amount instead of MaxUint256
                );
                await approveTx.wait();
                this.showSuccess(`${buyTokenSymbol} approval granted`);
            }

            // Verify contract has enough sell tokens
            const contractSellBalance = await sellToken.balanceOf(contract.address);
            this.debug('Contract sell token balance:', {
                balance: contractSellBalance.toString(),
                required: order.sellAmount.toString()
            });

            if (contractSellBalance.lt(order.sellAmount)) {
                const sellTokenSymbol = await sellToken.symbol();
                const sellTokenDecimals = await sellToken.decimals();
                const formattedBalance = ethers.utils.formatUnits(contractSellBalance, sellTokenDecimals);
                const formattedRequired = ethers.utils.formatUnits(order.sellAmount, sellTokenDecimals);
                
                throw new Error(
                    `Contract has insufficient ${sellTokenSymbol} balance.\n` +
                    `Required: ${Number(formattedRequired).toLocaleString()} ${sellTokenSymbol}\n` +
                    `Available: ${Number(formattedBalance).toLocaleString()} ${sellTokenSymbol}`
                );
            }

            // Add gas buffer and execute transaction
            const gasEstimate = await contractWithSigner.estimateGas.fillOrder(orderId);
            this.debug('Gas estimate:', gasEstimate.toString());
            
            const gasLimit = gasEstimate.mul(120).div(100); // Add 20% buffer
            const tx = await contractWithSigner.fillOrder(orderId, { gasLimit });
            this.debug('Transaction sent:', tx.hash);
            
            const receipt = await tx.wait();
            this.debug('Transaction receipt:', receipt);

            if (receipt.status === 0) {
                throw new Error('Transaction reverted by contract');
            }

            order.status = 'Filled';
            await this.refreshOrdersView();

            this.showSuccess(`Order ${orderId} filled successfully!`);

        } catch (error) {
            this.debug('Fill order error details:', error);
            
            // Use utility function for consistent error handling
            handleTransactionError(error, this, 'fill order');
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = 'Fill Order';
                button.classList.remove('disabled');
            }
        }
    }

    getReadableError(error) {
        if (error.message?.includes('insufficient allowance')) {
            return 'Insufficient token allowance';
        }
        if (error.message?.includes('insufficient balance')) {
            return 'Insufficient token balance';
        }
        
        // Handle contract revert errors with detailed messages
        if (error.code === -32603 && error.data?.message) {
            return error.data.message;
        }
        
        // Try to extract error from ethers error structure
        if (error.error?.data?.message) {
            return error.error.data.message;
        }
        
        switch (error.code) {
            case 'ACTION_REJECTED':
                return 'Transaction was rejected by user';
            case 'INSUFFICIENT_FUNDS':
                return 'Insufficient funds for gas';
            case -32603:
                return 'Transaction would fail. Check order status and approvals.';
            case 'UNPREDICTABLE_GAS_LIMIT':
                // For contract revert errors, extract the actual revert message
                if (error.error?.data?.message) {
                    return error.error.data.message;
                } else if (error.reason) {
                    return error.reason;
                }
                return 'Error estimating gas. The transaction may fail.';
            default:
                return error.reason || error.message || 'Unknown error occurred';
        }
    }

    cleanup() {
        this.debug('Cleaning up ViewOrders...');
        
        // Cleanup helper and renderer
        if (this.helper) {
            this.helper.cleanup();
        }
        if (this.renderer) {
            this.renderer.cleanup();
        }
        
        // Remove wallet listener
        if (this.walletListener) {
            const wallet = this.ctx.getWallet();
            wallet?.removeListener(this.walletListener);
            this.walletListener = null;
        }
        
        // Unsubscribe from pricing service
        if (this._boundPricingHandler && this.pricingService) {
            this.pricingService.unsubscribe(this._boundPricingHandler);
            this._boundPricingHandler = null;
        }
        
        // Unsubscribe from WebSocket
        if (this._boundOrdersUpdatedHandler) {
            const ws = this.ctx.getWebSocket();
            ws?.unsubscribe("ordersUpdated", this._boundOrdersUpdatedHandler);
            this._boundOrdersUpdatedHandler = null;
        }
        
        // Clear refresh timeout
        if (this._refreshTimeout) {
            clearTimeout(this._refreshTimeout);
            this._refreshTimeout = null;
        }
        
        // Clear expiry timers
        if (this.expiryTimers) {
            this.expiryTimers.forEach(timerId => clearInterval(timerId));
            this.expiryTimers.clear();
        }
        
        // Reset table setup flag to allow re-initialization if needed
        this._tableSetup = false;
        
        this.debug('ViewOrders cleanup complete');
    }

    async createOrderRow(order) {
        try {
            const tr = document.createElement('tr');
            tr.dataset.orderId = order.id.toString();
            tr.dataset.timestamp = order.timings?.createdAt?.toString() || '0';

            // Get token info from WebSocket cache
            const ws = this.ctx.getWebSocket();
            const sellTokenInfo = await ws.getTokenInfo(order.sellToken);
            const buyTokenInfo = await ws.getTokenInfo(order.buyToken);
            const deal = order.dealMetrics?.deal > 0 ? 1 / order.dealMetrics?.deal : undefined; // view as buyer/taker
            // Use pre-formatted values from dealMetrics
            const { 
                formattedSellAmount,
                formattedBuyAmount,
                sellTokenUsdPrice,
                buyTokenUsdPrice 
            } = order.dealMetrics || {};

            // Fallback amount formatting if dealMetrics not yet populated
            const safeFormattedSellAmount = typeof formattedSellAmount !== 'undefined'
                ? formattedSellAmount
                : (order?.sellAmount && sellTokenInfo?.decimals != null
                    ? ethers.utils.formatUnits(order.sellAmount, sellTokenInfo.decimals)
                    : '0');
            const safeFormattedBuyAmount = typeof formattedBuyAmount !== 'undefined'
                ? formattedBuyAmount
                : (order?.buyAmount && buyTokenInfo?.decimals != null
                    ? ethers.utils.formatUnits(order.buyAmount, buyTokenInfo.decimals)
                    : '0');

            // Determine prices with fallback to current pricing service map
            const pricing = this.ctx.getPricing();
            const resolvedSellPrice = typeof sellTokenUsdPrice !== 'undefined' 
                ? sellTokenUsdPrice 
                : (pricing ? pricing.getPrice(order.sellToken) : undefined);
            const resolvedBuyPrice = typeof buyTokenUsdPrice !== 'undefined' 
                ? buyTokenUsdPrice 
                : (pricing ? pricing.getPrice(order.buyToken) : undefined);

            // Mark as estimate if not explicitly present in pricing map
            const sellPriceClass = (pricing && pricing.isPriceEstimated(order.sellToken)) ? 'price-estimate' : '';
            const buyPriceClass = (pricing && pricing.isPriceEstimated(order.buyToken)) ? 'price-estimate' : '';

            const orderStatus = ws.getOrderStatus(order);
            const expiryEpoch = order?.timings?.expiresAt;
            const expiryText = orderStatus === 'Active' && typeof expiryEpoch === 'number' 
                ? formatTimeDiff(expiryEpoch - Math.floor(Date.now() / 1000)) 
                : '';

            tr.innerHTML = `
                <td>${order.id}</td>
                <td>
                    <div class="token-info">
                        <div class="token-icon">
                            <div class="loading-spinner"></div>
                        </div>
                        <div class="token-details">
                            <div class="token-symbol-row">
                                <span class="token-symbol">${sellTokenInfo.symbol}</span>
                                <span class="token-price ${sellPriceClass}">${calculateTotalValue(resolvedSellPrice, safeFormattedSellAmount)}</span>
                            </div>
                            <span class="token-amount">${safeFormattedSellAmount}</span>
                        </div>
                    </div>
                </td>
                <td>
                    <div class="token-info">
                        <div class="token-icon">
                            <div class="loading-spinner"></div>
                        </div>
                        <div class="token-details">
                            <div class="token-symbol-row">
                                <span class="token-symbol">${buyTokenInfo.symbol}</span>
                                <span class="token-price ${buyPriceClass}">${calculateTotalValue(resolvedBuyPrice, safeFormattedBuyAmount)}</span>
                            </div>
                            <span class="token-amount">${safeFormattedBuyAmount}</span>
                        </div>
                    </div>
                </td>
                <td>${deal !== undefined ? (deal || 0).toFixed(6) : 'N/A'}</td>
                <td>${expiryText}</td>
                <td class="order-status">${orderStatus}</td>
                <td class="action-column"></td>`;

            // Render token icons asynchronously (target explicit columns)
            const sellTokenIconContainer = tr.querySelector('td:nth-child(2) .token-icon');
            const buyTokenIconContainer = tr.querySelector('td:nth-child(3) .token-icon');
            
            if (sellTokenIconContainer) {
                this.helper.renderTokenIcon(sellTokenInfo, sellTokenIconContainer);
            }
            if (buyTokenIconContainer) {
                this.helper.renderTokenIcon(buyTokenInfo, buyTokenIconContainer);
            }

            // Start expiry timer for this row (handled by renderer)
            this.renderer.startExpiryTimer(tr);

            return tr;
        } catch (error) {
            this.error('Error creating order row:', error);
            return null;
        }
    }

    // updatePaginationControls and startExpiryTimer now handled by renderer
    updatePaginationControls(totalOrders) {
        return this.renderer.updatePaginationControls(totalOrders);
    }

    // Method called by renderer to update action column during expiry timer updates
    updateActionColumn(actionCell, order, wallet) {
        const currentAccount = wallet?.getAccount()?.toLowerCase();
        const isUserOrder = order.maker?.toLowerCase() === currentAccount;
        const ws = this.ctx.getWebSocket();

        if (isUserOrder) {
            actionCell.innerHTML = '<span class="mine-label">Mine</span>';
        } else if (!isUserOrder && ws.canFillOrder(order, currentAccount)) {
            actionCell.innerHTML = `<button class="fill-button" data-order-id="${order.id}">Fill</button>`;
            const fillButton = actionCell.querySelector('.fill-button');
            if (fillButton) {
                fillButton.addEventListener('click', () => this.fillOrder(order.id));
            }
        } else {
            actionCell.innerHTML = '';
        }
    }

    async getContract() {
        const ws = this.ctx.getWebSocket();
        if (!ws?.contract) {
            throw new Error('WebSocket contract not initialized');
        }
        return ws.contract;
    }
}
