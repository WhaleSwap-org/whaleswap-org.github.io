import { BaseComponent } from './BaseComponent.js';
import { createLogger } from '../services/LogService.js';
import { ethers } from 'ethers';
import {
    createDealCellHTML,
    handleTransactionError,
    processOrderAddress,
    generateStatusCellHTML,
    setupClickToCopy
} from '../utils/ui.js';
import { formatTimeDiff, calculateTotalValue, formatDealValue } from '../utils/orderUtils.js';
import { OrdersComponentHelper } from '../services/OrdersComponentHelper.js';
import { OrdersTableRenderer } from '../services/OrdersTableRenderer.js';
import { buildTokenDisplaySymbolMap, getDisplaySymbol } from '../utils/tokenDisplay.js';
import {
    DEFAULT_ORDER_SORT,
    normalizeOrderSort,
    sortOrdersByCurrentSort
} from '../utils/orderSort.js';
import { getMakerDealRatio } from '../utils/ordersComponentHelpers.js';

export class MyOrders extends BaseComponent {
    constructor() {
        super('my-orders');
        
        // Initialize logger
        const logger = createLogger('MY_ORDERS');
        this.debug = logger.debug.bind(logger);
        this.error = logger.error.bind(logger);
        this.warn = logger.warn.bind(logger);
        
        // Initialize state
        this.provider = null;
        this.currentPage = 1;
        this.totalOrders = 0;
        this.eventSubscriptions = new Set();
        this.expiryTimers = new Map();
        this.isLoading = false;
        this.pricingService = null;
        this.currentAccount = null;
        this._refreshTimeout = null;

        // Debounce refreshes after websocket/order events and cancel actions.
        this.debouncedRefresh = () => {
            clearTimeout(this._refreshTimeout);
            this._refreshTimeout = setTimeout(() => {
                this.refreshOrdersView().catch(error => {
                    this.error('Error refreshing orders:', error);
                });
            }, 100);
        };
        
        // Initialize helper and renderer
        this.helper = new OrdersComponentHelper(this);
        this.renderer = new OrdersTableRenderer(this, {
            rowRenderer: (order) => this.createOrderRow(order),
            filterToggleLabel: 'Show only cancellable',
            showRefreshButton: true
        });
    }

    async initialize(readOnlyMode = true) {
        // Prevent concurrent initializations
        if (this.isInitializing) {
            this.debug('Already initializing, skipping...');
            return;
        }

        this.isInitializing = true;

        try {
            this.debug('Initializing MyOrders component');
            
            // Check wallet connection first
            const wallet = this.ctx.getWallet();
            if (!wallet?.isWalletConnected()) {
                this.warn('No wallet connected, showing connect prompt');
                this.container.innerHTML = `
                    <div class="tab-content-wrapper">
                        <h2>My Orders</h2>
                        <p class="connect-prompt">Connect wallet to view your orders</p>
                    </div>`;
                return;
            }

            // Get current account
            let userAddress = wallet.getAccount();
            if (!userAddress) {
                this.warn('No account connected');
                return;
            }

            // Check if table already exists to avoid rebuilding
            const existingTable = this.container.querySelector('.orders-table');
            if (!existingTable) {
                this.debug('Table does not exist, setting up...');
                // Setup services first
                this.helper.setupServices({
                    onRefresh: () => this.refreshOrdersView()
                });
                await this.setupTable();
                await this.helper.setupWebSocket(() => this.refreshOrdersView());
            } else {
                this.debug('Table already exists, skipping setup');
            }

            // Check if WebSocket cache is already available
            const ws = this.ctx.getWebSocket();
            if (ws?.orderCache.size > 0) {
                this.debug('Using existing WebSocket cache');
                await this.refreshOrdersView();
                return;
            }

            // If no cache, then wait for WebSocket initialization
            if (!ws?.isInitialized) {
                this.warn('WebSocket not initialized, waiting...');
                await new Promise(resolve => {
                    const checkInterval = setInterval(() => {
                        if (ws?.isInitialized) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 100);
                });
            }

            // Refresh view
            await this.refreshOrdersView();

        } catch (error) {
            this.error('Initialization error:', error);
            this.showError('Failed to initialize orders view');
        } finally {
            this.isInitializing = false;
        }
    }

    async refreshOrdersView() {
        if (this.isLoading) return;
        this.isLoading = true;
        
        try {
            // Store current filter state before refresh
            const checkbox = this.container.querySelector('#fillable-orders-toggle');
            const showOnlyCancellable = checkbox?.checked ?? false; // Get current state
            
            // Get all orders first
            const ws = this.ctx.getWebSocket();
            const wallet = this.ctx.getWallet();
            this.tokenDisplaySymbolMap = buildTokenDisplaySymbolMap(
                Array.from(ws.tokenCache.values()),
                this.ctx?.getWalletChainId?.()
            );
            await ws.ensureChainTimeInitialized();
            let ordersToDisplay = Array.from(ws.orderCache.values());
            
            // Filter for user's orders only
            const userAddress = wallet?.getAccount()?.toLowerCase();
            ordersToDisplay = ordersToDisplay.filter(order => 
                order.maker?.toLowerCase() === userAddress
            );

            // Get filter states
            const sellTokenFilter = this.container.querySelector('#sell-token-filter')?.value;
            const buyTokenFilter = this.container.querySelector('#buy-token-filter')?.value;
            const orderSort = normalizeOrderSort(
                this.container.querySelector('#order-sort')?.value || DEFAULT_ORDER_SORT
            );

            // Apply filters
            ordersToDisplay = ordersToDisplay.filter(order => {
                // Apply token filters
                if (sellTokenFilter && order.sellToken.toLowerCase() !== sellTokenFilter.toLowerCase()) return false;
                if (buyTokenFilter && order.buyToken.toLowerCase() !== buyTokenFilter.toLowerCase()) return false;

                // Apply cancellable filter if checked
                if (showOnlyCancellable) {
                    return ws.canCancelOrder(order, userAddress);
                }
                
                return true;
            });

            // Set total orders after filtering
            this.totalOrders = ordersToDisplay.length;

            // Apply sorting
            ordersToDisplay = sortOrdersByCurrentSort(ordersToDisplay, {
                sortValue: orderSort,
                getDealSortValue: (order) => getMakerDealRatio(order)
            });

            // Apply pagination
            const pageSize = parseInt(this.container.querySelector('#page-size-select')?.value || '10');
            if (pageSize !== -1) {  // -1 means show all
                const startIndex = (this.currentPage - 1) * pageSize;
                const endIndex = startIndex + pageSize;
                ordersToDisplay = ordersToDisplay.slice(startIndex, endIndex);
            }
            const hasCompletedOrderSync = Boolean(ws.hasCompletedOrderSync);

            // Render orders using renderer
            if (ordersToDisplay.length === 0) {
                // Show empty state
                const tbody = this.container.querySelector('tbody');
                if (tbody) {
                    tbody.innerHTML = `
                        <tr class="empty-message">
                            <td colspan="7" class="no-orders-message">
                                <div class="placeholder-text">
                                    ${hasCompletedOrderSync
                                        ? (showOnlyCancellable ? 'No cancellable orders found' : 'No orders found')
                                        : 'Loading orders...'}
                                </div>
                            </td>
                        </tr>`;
                }
            } else {
                await this.renderer.renderOrders(ordersToDisplay);
            }

            // Update pagination controls
            this.renderer.updatePaginationControls(this.totalOrders);

            // Checkbox state is now preserved in setupTable(), no need to restore here

        } catch (error) {
            this.error('Error refreshing orders:', error);
            this.showError('Failed to refresh orders view');
        } finally {
            this.isLoading = false;
        }
    }

    async setupTable() {
        return this.renderer.setupTable(() => this.refreshOrdersView());
    }

    async createOrderRow(order) {
        try {
            // Create the row element first
            const tr = document.createElement('tr');
            tr.dataset.orderId = order.id.toString();
            tr.dataset.timestamp = order.timings?.createdAt?.toString() || '0';

            // Get token info from WebSocket cache
            const ws = this.ctx.getWebSocket();
            const sellTokenInfo = await ws.getTokenInfo(order.sellToken);
            const buyTokenInfo = await ws.getTokenInfo(order.buyToken);
            const sellDisplaySymbol = getDisplaySymbol(sellTokenInfo, this.tokenDisplaySymbolMap);
            const buyDisplaySymbol = getDisplaySymbol(buyTokenInfo, this.tokenDisplaySymbolMap);

            // Use pre-formatted values from dealMetrics
            const { 
                formattedSellAmount, 
                formattedBuyAmount, 
                deal,
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
            const sellPriceLoading = Boolean(pricing?.shouldShowPriceLoading?.(order.sellToken));
            const buyPriceLoading = Boolean(pricing?.shouldShowPriceLoading?.(order.buyToken));
            const dealLoading = !Number.isFinite(Number(deal)) && (sellPriceLoading || buyPriceLoading);

            // Mark as estimate if not explicitly present in pricing map
            const sellPriceClass = (pricing && pricing.isPriceEstimated(order.sellToken)) ? 'price-estimate' : '';
            const buyPriceClass = (pricing && pricing.isPriceEstimated(order.buyToken)) ? 'price-estimate' : '';

            const currentTime = ws.getCurrentTimestamp();
            const timeUntilExpiry = Number.isFinite(currentTime) && order?.timings?.expiresAt
                ? order.timings.expiresAt - currentTime
                : 0;
            const orderStatusForExpiry = ws.getOrderStatus(order);
            const expiryText = orderStatusForExpiry === 'Active' && Number.isFinite(currentTime)
                ? formatTimeDiff(timeUntilExpiry)
                : '';

            // Get order status from WebSocket cache
            const orderStatus = ws.getOrderStatus(order);

            // Get counterparty address for display
            const wallet = this.ctx.getWallet();
            const userAddress = wallet?.getAccount()?.toLowerCase();
            const { counterpartyAddress, isZeroAddr, formattedAddress } = processOrderAddress(order, userAddress);
            const dealText = dealLoading ? 'loading...' : formatDealValue(deal);
            const sellPriceText = sellPriceLoading
                ? 'loading...'
                : calculateTotalValue(resolvedSellPrice, safeFormattedSellAmount);
            const buyPriceText = buyPriceLoading
                ? 'loading...'
                : calculateTotalValue(resolvedBuyPrice, safeFormattedBuyAmount);
            tr.innerHTML = `
                <td>${order.id}</td>
                <td>
                    <div class="token-info">
                        <div class="token-icon"><div class="loading-spinner"></div></div>
                        <div class="token-details">
                            <div class="token-symbol-row">
                                <span class="token-symbol">${sellDisplaySymbol}</span>
                                <span class="token-price ${sellPriceClass}">${sellPriceText}</span>
                            </div>
                            <span class="token-amount">${safeFormattedSellAmount}</span>
                        </div>
                    </div>
                </td>
                <td>
                    <div class="token-info">
                        <div class="token-icon"><div class="loading-spinner"></div></div>
                        <div class="token-details">
                            <div class="token-symbol-row">
                                <span class="token-symbol">${buyDisplaySymbol}</span>
                                <span class="token-price ${buyPriceClass}">${buyPriceText}</span>
                            </div>
                            <span class="token-amount">${safeFormattedBuyAmount}</span>
                        </div>
                    </div>
                </td>
                <td class="deal-cell">${createDealCellHTML(dealText)}</td>
                <td>${expiryText}</td>
                <td class="order-status">
                    ${generateStatusCellHTML(orderStatus, counterpartyAddress, isZeroAddr, formattedAddress)}
                </td>
                <td class="action-column"></td>`;

            // Add cancel button logic to action column
            const actionCell = tr.querySelector('.action-column');
            
            // Use WebSocket helper to determine if order can be cancelled
            if (ws.canCancelOrder(order, userAddress)) {
                const cancelButton = document.createElement('button');
                cancelButton.className = 'cancel-order-btn';
                cancelButton.textContent = 'Cancel';
                
                cancelButton.addEventListener('click', async () => {
                    try {
                        if (!this.provider) {
                            throw new Error('No injected wallet detected. Please install or unlock a wallet to cancel orders.');
                        }

                        if (!await this.ensureWalletReadyForWrite(`cancel order ${order.id}`)) {
                            return;
                        }

                        cancelButton.disabled = true;
                        cancelButton.textContent = 'Cancelling...';
                        cancelButton.classList.add('disabled');

                        // Get contract from WebSocket and connect to signer
                        const contract = ws.contract;
                        if (!contract) {
                            throw new Error('Contract not available');
                        }

                        const signer = this.provider.getSigner();
                        const contractWithSigner = contract.connect(signer);
                        
                        // Add gas buffer
                        const gasEstimate = await contractWithSigner.estimateGas.cancelOrder(order.id);
                        const gasLimit = gasEstimate.mul(120).div(100); // Add 20% buffer
                        
                        cancelButton.textContent = 'Approving...';
                        
                        const tx = await contractWithSigner.cancelOrder(order.id, { gasLimit });
                        
                        cancelButton.textContent = 'Confirming...';
                        
                        const receipt = await tx.wait();
                        if (receipt.status === 0) {
                            throw new Error('Transaction reverted by contract');
                        }

                        // Show success notification
                        this.showSuccess(`Order ${order.id} cancelled successfully!`);

                        // Update the row status immediately
                        const statusCell = tr.querySelector('td.order-status');
                        if (statusCell) {
                            statusCell.textContent = 'Cancelled';
                            statusCell.classList.add('cancelled');
                        }

                        // Remove the cancel button
                        actionCell.textContent = '-';

                        if (this.debouncedRefresh) {
                            this.debouncedRefresh();
                        } else {
                            await this.refreshOrdersView();
                        }
                    } catch (error) {
                        this.debug('Error cancelling order:', error);
                        handleTransactionError(error, this, 'order cancellation');
                    } finally {
                        cancelButton.disabled = false;
                        cancelButton.textContent = 'Cancel';
                        cancelButton.classList.remove('disabled');
                    }
                });
                
                actionCell.appendChild(cancelButton);
            } else {
                actionCell.textContent = '-';
            }

            // Add click-to-copy functionality for counterparty address
            const addressElement = tr.querySelector('.counterparty-address.clickable');
            setupClickToCopy(addressElement);

            // Render token icons asynchronously (match column positions)
            const sellTokenIconContainer = tr.querySelector('td:nth-child(2) .token-icon');
            const buyTokenIconContainer = tr.querySelector('td:nth-child(3) .token-icon');
            if (sellTokenIconContainer) {
                this.helper.renderTokenIcon(sellTokenInfo, sellTokenIconContainer);
            }
            if (buyTokenIconContainer) {
                this.helper.renderTokenIcon(buyTokenInfo, buyTokenIconContainer);
            }

            // Start the expiry timer
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
        const ws = this.ctx.getWebSocket();

        if (ws.canCancelOrder(order, currentAccount)) {
            // Only update if there isn't already a cancel button
            if (!actionCell.querySelector('.cancel-order-btn')) {
                const cancelButton = document.createElement('button');
                cancelButton.className = 'cancel-order-btn';
                cancelButton.textContent = 'Cancel';
                
                cancelButton.addEventListener('click', async () => {
                    try {
                        if (!this.provider) {
                            throw new Error('No injected wallet detected. Please install or unlock a wallet to cancel orders.');
                        }

                        if (!await this.ensureWalletReadyForWrite(`cancel order ${order.id}`)) {
                            return;
                        }

                        cancelButton.disabled = true;
                        cancelButton.textContent = 'Cancelling...';
                        
                        // Get contract from WebSocket and connect to signer
                        const contract = ws.contract;
                        if (!contract) {
                            throw new Error('Contract not available');
                        }

                        const signer = this.provider.getSigner();
                        const contractWithSigner = contract.connect(signer);
                        
                        const gasEstimate = await contractWithSigner.estimateGas.cancelOrder(order.id);
                        const gasLimit = gasEstimate.mul(120).div(100); // Add 20% buffer
                        
                        const tx = await contractWithSigner.cancelOrder(order.id, { gasLimit });
                        this.showError(`Cancelling order ${order.id}... Transaction sent`);
                        
                        const receipt = await tx.wait();
                        if (receipt.status === 0) {
                            throw new Error('Transaction reverted by contract');
                        }

                        this.showSuccess(`Order ${order.id} cancelled successfully!`);
                        actionCell.textContent = '-';
                        if (this.debouncedRefresh) {
                            this.debouncedRefresh();
                        } else {
                            await this.refreshOrdersView();
                        }
                    } catch (error) {
                        this.debug('Error cancelling order:', error);
                        handleTransactionError(error, this, 'order cancellation');
                        cancelButton.disabled = false;
                        cancelButton.textContent = 'Cancel';
                    }
                });
                
                actionCell.innerHTML = '';
                actionCell.appendChild(cancelButton);
            }
        } else if (order.maker?.toLowerCase() === currentAccount) {
            actionCell.innerHTML = '<span class="your-order">Mine</span>';
        } else {
            actionCell.textContent = '-';
        }
    }

    cleanup() {
        this.debug('Cleaning up MyOrders...');
        
        // Cleanup helper and renderer
        if (this.helper) {
            this.helper.cleanup();
        }
        if (this.renderer) {
            this.renderer.cleanup();
        }
        
        // Clear expiry timers
        if (this.expiryTimers) {
            this.expiryTimers.forEach(timerId => clearInterval(timerId));
            this.expiryTimers.clear();
        }
        if (this._refreshTimeout) {
            clearTimeout(this._refreshTimeout);
            this._refreshTimeout = null;
        }
        
        // Reset state
        this.isInitializing = false;
        
        this.debug('MyOrders cleanup complete');
    }
}
