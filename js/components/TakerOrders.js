import { BaseComponent } from './BaseComponent.js';
import { createLogger } from '../services/LogService.js';
import { ethers } from 'ethers';
import { processOrderAddress, generateStatusCellHTML, setupClickToCopy } from '../utils/ui.js';
import { formatTimeDiff, calculateTotalValue } from '../utils/orderUtils.js';
import { OrdersComponentHelper } from '../services/OrdersComponentHelper.js';
import { OrdersTableRenderer } from '../services/OrdersTableRenderer.js';

export class TakerOrders extends BaseComponent {
    constructor() {
        super('taker-orders');
        this.isProcessingFill = false;
        
        // Initialize logger
        const logger = createLogger('TAKER_ORDERS');
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
        
        // Initialize helper and renderer
        this.helper = new OrdersComponentHelper(this);
        this.renderer = new OrdersTableRenderer(this, {
            rowRenderer: (order) => this.createOrderRow(order),
            showRefreshButton: false
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
            if (!this.initialized) {
                // First time setup
                this.helper.setupServices({
                    onRefresh: () => this.refreshOrdersView()
                });
                await this.renderer.setupTable(() => this.refreshOrdersView());
                await this.setupWebSocket();
                this.initialized = true;
            }
            await this.refreshOrdersView();
        } catch (error) {
            this.error('Error in initialize:', error);
        } finally {
            this.isInitializing = false;
        }
    }

    async refreshOrdersView() {
        if (this.isLoading) return;
        this.isLoading = true;

        try {
            this.debug('Refreshing taker orders view');
            
            // Get current user address
            const wallet = this.ctx.getWallet();
            const userAddress = wallet?.getAccount();
            if (!userAddress) {
                this.debug('No wallet connected, showing empty state');
                // Show empty state for taker orders when no wallet is connected
                const tbody = this.container.querySelector('tbody');
                if (tbody) {
                    tbody.innerHTML = `
                        <tr class="empty-message">
                            <td colspan="7" class="no-orders-message">
                                <div class="placeholder-text">
                                    Please connect your wallet to view your taker orders
                                </div>
                            </td>
                        </tr>`;
                }
                return; // Exit early without throwing error
            }

            // Get all orders and filter for taker
            const ws = this.ctx.getWebSocket();
            await ws.ensureFreshChainTime();
            let ordersToDisplay = Array.from(ws.orderCache.values())
                .filter(order => 
                    order?.taker && 
                    order.taker.toLowerCase() === userAddress.toLowerCase()
                );

            this.debug(`Found ${ordersToDisplay.length} taker orders`);

            // Get filter states
            const sellTokenFilter = this.container.querySelector('#sell-token-filter')?.value;
            const buyTokenFilter = this.container.querySelector('#buy-token-filter')?.value;
            const orderSort = this.container.querySelector('#order-sort')?.value;
            const showOnlyActive = this.container.querySelector('#fillable-orders-toggle')?.checked ?? true;
            const pageSize = parseInt(this.container.querySelector('#page-size-select')?.value || '25');

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

            // Apply token filters
            if (sellTokenFilter) {
                ordersToDisplay = ordersToDisplay.filter(order => 
                    order.sellToken.toLowerCase() === sellTokenFilter.toLowerCase()
                );
            }
            if (buyTokenFilter) {
                ordersToDisplay = ordersToDisplay.filter(order => 
                    order.buyToken.toLowerCase() === buyTokenFilter.toLowerCase()
                );
            }

            // Filter active orders if needed
            if (showOnlyActive) {
                ordersToDisplay = ordersToDisplay.filter(order => 
                    ws.canFillOrder(order, userAddress)
                );
            }

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
                                        'No active orders where you are the taker' : 
                                        'No orders found where you are the taker'}
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
            this.error('Error refreshing orders:', error);
            this.showError('Failed to refresh orders view');
        } finally {
            this.isLoading = false;
        }
    }

    // Setup WebSocket with taker-specific event handling
    async setupWebSocket() {
        try {
            // Setup base WebSocket subscriptions
            await this.helper.setupWebSocket(() => this.refreshOrdersView());

            // Add taker-specific event handling
            const ws = this.ctx.getWebSocket();
            if (ws && !this._takerSyncHandler) {
                this._takerSyncHandler = async (orders) => {
                    if (this.isProcessingFill) {
                        this.debug('Skipping sync while processing fill');
                        return;
                    }
                    
                    const wallet = this.ctx.getWallet();
                    const userAddress = wallet?.getAccount();
                    if (!userAddress) return;
                    
                    const takerOrders = Object.values(orders || {})
                        .filter(order => 
                            order.taker?.toLowerCase() === userAddress.toLowerCase()
                        );
                    
                    this.debug(`Synced ${takerOrders.length} taker orders`);
                    await this.refreshOrdersView();
                };
                
                ws.subscribe('orderSyncComplete', this._takerSyncHandler);
                if (this.eventSubscriptions) {
                    this.eventSubscriptions.add({ 
                        event: 'orderSyncComplete', 
                        callback: this._takerSyncHandler 
                    });
                }
            }
        } catch (error) {
            this.error('Error setting up WebSocket:', error);
        }
    }

    // Setup table with taker-specific customizations
    async setupTable() {
        try {
            await this.renderer.setupTable(() => this.refreshOrdersView());
            
            // Show advanced filters by default
            const advancedFilters = this.container.querySelector('.advanced-filters');
            if (advancedFilters) {
                advancedFilters.style.display = 'block';
                const advancedFiltersToggle = this.container.querySelector('.advanced-filters-toggle');
                if (advancedFiltersToggle) {
                    advancedFiltersToggle.classList.add('expanded');
                }
            } else {
                this.warn('Advanced filters element not found');
            }
            
            // Customize table header
            const thead = this.container.querySelector('thead tr');
            if (!thead) {
                this.error('Table header element not found');
                return;
            }

            thead.innerHTML = `
                <th>ID</th>
                <th>Buy</th>
                <th>Sell</th>
                <th>
                    Deal
                    <span class="info-icon" title="Deal = Buy Value / Sell Value

• Higher deal number is better
• Deal > 1: better deal based on market prices
• Deal < 1: worse deal based on market prices">ⓘ</span>
                </th>
                <th>Expires</th>
                <th>Status</th>
                <th>Action</th>
            `;
        } catch (error) {
            this.error('Error setting up table:', error);
        }
    }

    /**
     * Override createOrderRow to add counterparty address display
     * @param {Object} order - The order object
     * @returns {HTMLElement} The table row element
     */
    async createOrderRow(order) {
        try {
            const tr = document.createElement('tr');
            tr.dataset.orderId = order.id.toString();
            tr.dataset.timestamp = order.timings?.createdAt?.toString() || '0';

            // Get token info from WebSocket cache
            const ws = this.ctx.getWebSocket();
            const sellTokenInfo = await ws.getTokenInfo(order.sellToken);
            const buyTokenInfo = await ws.getTokenInfo(order.buyToken);

            // Use pre-formatted values from dealMetrics
            const { 
                formattedSellAmount,
                formattedBuyAmount,
                sellTokenUsdPrice,
                buyTokenUsdPrice 
            } = order.dealMetrics || {};
            
            const deal = order.dealMetrics?.deal > 0 ? 1 / order.dealMetrics?.deal : undefined; // view as buyer/taker

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
            const currentTime = ws.getCurrentTimestamp();
            const expiryText = orderStatus === 'Active' && typeof expiryEpoch === 'number' 
                && Number.isFinite(currentTime)
                ? formatTimeDiff(expiryEpoch - currentTime) 
                : '';

            // Get counterparty address for display
            const wallet = this.ctx.getWallet();
            const userAddress = wallet?.getAccount()?.toLowerCase();
            const { counterpartyAddress, isZeroAddr, formattedAddress } = processOrderAddress(order, userAddress);

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
                <td class="order-status">
                    ${generateStatusCellHTML(orderStatus, counterpartyAddress, isZeroAddr, formattedAddress)}
                </td>
                <td class="action-column"></td>`;

            // Add click-to-copy functionality for counterparty address
            const addressElement = tr.querySelector('.counterparty-address.clickable');
            setupClickToCopy(addressElement);

            // Render token icons asynchronously (target explicit columns)
            const sellTokenIconContainer = tr.querySelector('td:nth-child(2) .token-icon');
            const buyTokenIconContainer = tr.querySelector('td:nth-child(3) .token-icon');
            
            if (sellTokenIconContainer) {
                this.helper.renderTokenIcon(sellTokenInfo, sellTokenIconContainer);
            }
            if (buyTokenIconContainer) {
                this.helper.renderTokenIcon(buyTokenInfo, buyTokenIconContainer);
            }

            // Start expiry timer for this row
            this.renderer.startExpiryTimer(tr);

            return tr;
        } catch (error) {
            this.error('Error creating order row:', error);
            return null;
        }
    }

    // Method called by renderer to update action column during expiry timer updates
    updateActionColumn(actionCell, order, wallet) {
        const currentAccount = wallet?.getAccount()?.toLowerCase();
        const ws = this.ctx.getWebSocket();

        // For taker orders, user is the taker - show fill button if they can fill
        if (ws.canFillOrder(order, currentAccount)) {
            if (!actionCell.querySelector('.fill-button')) {
                actionCell.innerHTML = `<button class="fill-button" data-order-id="${order.id}">Fill</button>`;
                const fillButton = actionCell.querySelector('.fill-button');
                if (fillButton) {
                    fillButton.addEventListener('click', () => this.fillOrder(order.id));
                }
            }
        } else {
            actionCell.innerHTML = '-';
        }
    }

    async fillOrder(orderId) {
        // Delegate to helper or implement fill logic
        this.debug('Fill order requested:', orderId);
        this.showInfo(`Fill order ${orderId} - functionality inherited from ViewOrders`);
    }

    cleanup() {
        this.debug('Cleaning up TakerOrders...');
        
        // Cleanup helper and renderer
        if (this.helper) {
            this.helper.cleanup();
        }
        if (this.renderer) {
            this.renderer.cleanup();
        }
        
        // Cleanup taker-specific handler
        if (this._takerSyncHandler) {
            const ws = this.ctx.getWebSocket();
            ws?.unsubscribe('orderSyncComplete', this._takerSyncHandler);
            this._takerSyncHandler = null;
        }
        
        // Clear expiry timers
        if (this.expiryTimers) {
            this.expiryTimers.forEach(timerId => clearInterval(timerId));
            this.expiryTimers.clear();
        }
        
        // Reset state
        this.initialized = false;
        this.isInitializing = false;
        
        this.debug('TakerOrders cleanup complete');
    }
}
