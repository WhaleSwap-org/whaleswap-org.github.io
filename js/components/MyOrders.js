import { BaseComponent } from './BaseComponent.js';
import { createLogger } from '../services/LogService.js';
import { ethers } from 'ethers';
import {
    DEAL_TOOLTIP_TEXT,
    createDealCellHTML,
    createInlineTooltipIcon,
    handleTransactionError,
    processOrderAddress,
    generateStatusCellHTML,
    setupClickToCopy,
    setupOrderTooltips
} from '../utils/ui.js';
import { formatTimeDiff, calculateTotalValue } from '../utils/orderUtils.js';
import { OrdersComponentHelper } from '../services/OrdersComponentHelper.js';
import { OrdersTableRenderer } from '../services/OrdersTableRenderer.js';

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
        
        // Initialize sort config with id as default sort, descending
        this.sortConfig = {
            column: 'id',
            direction: 'desc',
            isColumnClick: false
        };
        
        // Initialize helper and renderer
        this.helper = new OrdersComponentHelper(this);
        this.renderer = new OrdersTableRenderer(this, {
            rowRenderer: (order) => this.createOrderRow(order),
            filterToggleLabel: 'Show only cancellable',
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
                // Use MyOrders custom table setup (not renderer's generic one)
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
            await ws.ensureFreshChainTime();
            let ordersToDisplay = Array.from(ws.orderCache.values());
            
            // Filter for user's orders only
            const userAddress = wallet?.getAccount()?.toLowerCase();
            ordersToDisplay = ordersToDisplay.filter(order => 
                order.maker?.toLowerCase() === userAddress
            );

            // Get filter states
            const sellTokenFilter = this.container.querySelector('#sell-token-filter')?.value;
            const buyTokenFilter = this.container.querySelector('#buy-token-filter')?.value;
            const orderSort = this.container.querySelector('#order-sort')?.value;

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
            if (orderSort === 'newest') {
                ordersToDisplay.sort((a, b) => b.id - a.id);
            } else if (orderSort === 'best-deal') {
                ordersToDisplay.sort((a, b) => 
                    Number(b.dealMetrics?.deal || 0) - 
                    Number(a.dealMetrics?.deal || 0)
                );
            }

            // Apply pagination
            const pageSize = parseInt(this.container.querySelector('#page-size-select')?.value || '50');
            if (pageSize !== -1) {  // -1 means show all
                const startIndex = (this.currentPage - 1) * pageSize;
                const endIndex = startIndex + pageSize;
                ordersToDisplay = ordersToDisplay.slice(startIndex, endIndex);
            }

            // Render orders using renderer
            if (ordersToDisplay.length === 0) {
                // Show empty state
                const tbody = this.container.querySelector('tbody');
                if (tbody) {
                    tbody.innerHTML = `
                        <tr class="empty-message">
                            <td colspan="7" class="no-orders-message">
                                <div class="placeholder-text">
                                    ${showOnlyCancellable ? 
                                        'No cancellable orders found' : 
                                        'No orders found'}
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

    getTotalPages() {
        const pageSize = parseInt(this.container.querySelector('#page-size-select')?.value || '50');
        if (pageSize === -1) return 1; // View all
        return Math.ceil(this.totalOrders / pageSize);
    }

    // Keep the setupTable method as is since it's specific to MyOrders view
    async setupTable() {
        // Store current filter state before rebuilding table
        const existingCheckbox = this.container.querySelector('#fillable-orders-toggle');
        const showOnlyCancellable = existingCheckbox?.checked ?? true; // Default to true if no existing state
        
        // Get tokens from WebSocket's tokenCache first
        const ws = this.ctx.getWebSocket();
        const tokens = Array.from(ws.tokenCache.values())
            .sort((a, b) => a.symbol.localeCompare(b.symbol)); // Sort alphabetically by symbol
        
        this.debug('Available tokens:', tokens);

        const paginationControls = `
            <div class="pagination-controls">
                <select id="page-size-select" class="page-size-select">
                    <option value="10">10 per page</option>
                    <option value="25">25 per page</option>
                    <option value="50" selected>50 per page</option>
                    <option value="100">100 per page</option>
                    <option value="-1">View all</option>
                </select>
                
                <div class="pagination-buttons">
                    <button class="pagination-button prev-page" title="Previous page" disabled>
                        ←
                    </button>
                    <span class="page-info">Page 1 of 0</span>
                    <button class="pagination-button next-page" title="Next page" disabled>
                        →
                    </button>
                </div>
            </div>
        `;

        // Main filter controls
        const filterControls = `
            <div class="filter-controls">
                <div class="filter-row">
                    <div class="filters-left">
                        <div class="filters-group">
                            <button class="advanced-filters-toggle">
                                <svg class="filter-icon" viewBox="0 0 24 24" width="16" height="16">
                                    <path fill="currentColor" d="M14,12V19.88C14.04,20.18 13.94,20.5 13.71,20.71C13.32,21.1 12.69,21.1 12.3,20.71L10.29,18.7C10.06,18.47 9.96,18.16 10,17.87V12H9.97L4.21,4.62C3.87,4.19 3.95,3.56 4.38,3.22C4.57,3.08 4.78,3 5,3V3H19V3C19.22,3 19.43,3.08 19.62,3.22C20.05,3.56 20.13,4.19 19.79,4.62L14.03,12H14Z"/>
                                </svg>
                                Filters
                                <svg class="chevron-icon" viewBox="0 0 24 24" width="16" height="16">
                                    <path fill="currentColor" d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/>
                                </svg>
                            </button>
                            <label class="filter-toggle">
                                <input type="checkbox" id="fillable-orders-toggle" ${showOnlyCancellable ? 'checked' : ''}>
                                <span>Show only cancellable orders</span>
                            </label>
                        </div>
                    </div>
                    ${paginationControls}
                </div>
                <div class="refresh-container refresh-container--mobile">
                    <button class="refresh-prices-button js-refresh-prices" type="button">↻ Refresh Prices</button>
                    <span class="refresh-status"></span>
                    <span class="last-updated js-last-updated"></span>
                </div>
                <div class="advanced-filters" style="display: none;">
                    <div class="filter-row">
                        <div class="token-filters">
                            <select id="sell-token-filter" class="token-filter">
                                <option value="">All Sell Tokens</option>
                                ${tokens.map(token => 
                                    `<option value="${token.address}">${token.symbol}</option>`
                                ).join('')}
                            </select>
                            <select id="buy-token-filter" class="token-filter">
                                <option value="">All Buy Tokens</option>
                                ${tokens.map(token => 
                                    `<option value="${token.address}">${token.symbol}</option>`
                                ).join('')}
                            </select>
                            <select id="order-sort" class="order-sort">
                                <option value="newest">Newest First</option>
                                <option value="best-deal">Best Deal First</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>`;

        const bottomControls = `
            <div class="filter-controls bottom-controls">
                <div class="filter-row">
                    <div class="refresh-container">
                        <button class="refresh-prices-button js-refresh-prices" type="button">↻ Refresh Prices</button>
                        <span class="refresh-status"></span>
                        <span class="last-updated js-last-updated"></span>
                    </div>
                    ${paginationControls}
                </div>
            </div>
        `;

        const dealTooltipIcon = createInlineTooltipIcon(DEAL_TOOLTIP_TEXT, {
            className: 'info-icon order-tooltip-icon',
            ariaLabel: 'Explain deal value'
        });

        this.container.innerHTML = `
            <div class="table-container">
                ${filterControls}
                <table class="orders-table">
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Sell</th>
                            <th>Buy</th>
                            <th>
                                Deal
                                ${dealTooltipIcon}
                            </th>
                            <th>Expires</th>
                            <th>Status</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
                ${bottomControls}
            </div>`;

        // Setup advanced filters toggle
        const advancedFiltersToggle = this.container.querySelector('.advanced-filters-toggle');
        const advancedFilters = this.container.querySelector('.advanced-filters');
        
        if (advancedFiltersToggle && advancedFilters) {
            advancedFiltersToggle.addEventListener('click', () => {
                const isExpanded = advancedFilters.style.display !== 'none';
                advancedFilters.style.display = isExpanded ? 'none' : 'block';
                advancedFiltersToggle.classList.toggle('expanded', !isExpanded);
            });
        }

        // Add event listeners for filters
        const sellTokenFilter = this.container.querySelector('#sell-token-filter');
        const buyTokenFilter = this.container.querySelector('#buy-token-filter');
        const orderSort = this.container.querySelector('#order-sort');

        if (sellTokenFilter) sellTokenFilter.addEventListener('change', () => this.refreshOrdersView());
        if (buyTokenFilter) buyTokenFilter.addEventListener('change', () => this.refreshOrdersView());
        if (orderSort) orderSort.addEventListener('change', () => this.refreshOrdersView());

        // Initialize pagination
        this.currentPage = 1;
        const pageSize = this.container.querySelector('#page-size-select');
        if (pageSize) {
            pageSize.value = '50'; // Set default page size
        }

        // Setup pagination for both top and bottom controls
        const setupPaginationListeners = (controls) => {
            const prevButton = controls.querySelector('.prev-page');
            const nextButton = controls.querySelector('.next-page');
            const pageInfo = controls.querySelector('.page-info');
            
            if (prevButton) {
                prevButton.addEventListener('click', () => {
                    if (this.currentPage > 1) {
                        this.currentPage--;
                        this.refreshOrdersView();
                    }
                });
            }
            
            if (nextButton) {
                nextButton.addEventListener('click', () => {
                    const pageSize = parseInt(this.container.querySelector('#page-size-select').value);
                    const totalPages = Math.ceil(this.totalOrders / pageSize);
                    if (this.currentPage < totalPages) {
                        this.currentPage++;
                        this.refreshOrdersView();
                    }
                });
            }
        };

        // Sync both page size selects
        const pageSizeSelects = this.container.querySelectorAll('.page-size-select');
        pageSizeSelects.forEach(select => {
            select.addEventListener('change', (event) => {
                // Update all page size selects to match
                pageSizeSelects.forEach(otherSelect => {
                    if (otherSelect !== event.target) {
                        otherSelect.value = event.target.value;
                    }
                });
                this.currentPage = 1; // Reset to first page when changing page size
                this.refreshOrdersView();
            });
        });

        // Setup pagination for both top and bottom controls
        const controls = this.container.querySelectorAll('.filter-controls');
        controls.forEach(setupPaginationListeners);

        // Add filter toggle listener
        const filterToggles = this.container.querySelectorAll('#fillable-orders-toggle');
        filterToggles.forEach(toggle => {
            toggle.addEventListener('change', (event) => {
                filterToggles.forEach(otherToggle => {
                    if (otherToggle !== event.target) {
                        otherToggle.checked = event.target.checked;
                    }
                });
                this.refreshOrdersView();
            });
        });

        setupOrderTooltips(this.container);
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Refresh controls are rendered in top (mobile) + bottom (desktop), share one in-flight state.
        const refreshControls = Array.from(this.container.querySelectorAll('.refresh-container')).map((container) => ({
            button: container.querySelector('.js-refresh-prices'),
            status: container.querySelector('.refresh-status'),
            timestamp: container.querySelector('.js-last-updated')
        })).filter(control => control.button && control.status);

        refreshControls.forEach((control) => {
            if (control.timestamp) {
                this.helper.updateLastUpdatedTimestamp(control.timestamp);
            }
        });

        let refreshTimeout = null;
        this._refreshInFlight = false;
        const setRefreshState = ({ isLoading = false, text = '', statusClass = '' }) => {
            refreshControls.forEach((control) => {
                control.button.disabled = isLoading;
                control.button.textContent = isLoading ? '↻ Refreshing...' : '↻ Refresh Prices';
                control.status.className = `refresh-status${statusClass ? ` ${statusClass}` : ''}`;
                control.status.textContent = text;
                control.status.style.opacity = text || isLoading ? 1 : 0;
            });
        };

        refreshControls.forEach((control) => {
            control.button.addEventListener('click', async () => {
                if (this._refreshInFlight) return;
                this._refreshInFlight = true;
                setRefreshState({ isLoading: true, statusClass: 'loading' });

                try {
                    const result = await this.pricingService.refreshPrices();
                    if (result.success) {
                        setRefreshState({
                            isLoading: false,
                            text: `Updated ${new Date().toLocaleTimeString()}`,
                            statusClass: 'success'
                        });
                        refreshControls.forEach((entry) => {
                            if (entry.timestamp) {
                                this.updateLastUpdatedTimestamp(entry.timestamp);
                            }
                        });
                    } else {
                        setRefreshState({
                            isLoading: false,
                            text: result.message || 'Failed to refresh prices',
                            statusClass: 'error'
                        });
                    }
                } catch (error) {
                    setRefreshState({
                        isLoading: false,
                        text: 'Failed to refresh prices',
                        statusClass: 'error'
                    });
                } finally {
                    this._refreshInFlight = false;
                    if (refreshTimeout) clearTimeout(refreshTimeout);
                    refreshTimeout = setTimeout(() => {
                        refreshControls.forEach((entry) => {
                            entry.status.style.opacity = 0;
                        });
                        refreshTimeout = null;
                    }, 2000);
                }
            });
        });

        // Add pagination event listeners for both top and bottom controls
        const controls = this.container.querySelectorAll('.filter-controls');
        controls.forEach(control => {
            const prevButton = control.querySelector('.prev-page');
            const nextButton = control.querySelector('.next-page');
            
            if (prevButton) {
                prevButton.addEventListener('click', () => {
                    if (this.currentPage > 1) {
                        this.currentPage--;
                        this.refreshOrdersView();
                    }
                });
            }
            
            if (nextButton) {
                nextButton.addEventListener('click', () => {
                    const totalPages = this.getTotalPages();
                    this.debug('Next button clicked', { 
                        currentPage: this.currentPage, 
                        totalPages, 
                        totalOrders: this.totalOrders 
                    });
                    if (this.currentPage < totalPages) {
                        this.currentPage++;
                        this.refreshOrdersView();
                    }
                });
            }
        });

        // Add filter toggle listener
        const filterToggle = this.container.querySelector('#fillable-orders-toggle');
        if (filterToggle) {
            filterToggle.addEventListener('change', () => {
                this.currentPage = 1; // Reset to first page when filter changes
                this.refreshOrdersView();
            });
        }

        // Add token filter listeners
        const tokenFilters = this.container.querySelectorAll('.token-filter');
        tokenFilters.forEach(filter => {
            filter.addEventListener('change', () => {
                this.currentPage = 1; // Reset to first page when filter changes
                this.refreshOrdersView();
            });
        });

        // Add sort listener
        const sortSelect = this.container.querySelector('#order-sort');
        if (sortSelect) {
            sortSelect.addEventListener('change', () => {
                this.currentPage = 1; // Reset to first page when sort changes
                this.refreshOrdersView();
            });
        }
    }

    // Update last updated timestamp
    updateLastUpdatedTimestamp(element) {
        if (!element || !this.pricingService) return;
        
        const lastUpdateTime = this.pricingService.getLastUpdateTime();
        if (lastUpdateTime && lastUpdateTime !== 'Never') {
            element.textContent = `Last updated: ${lastUpdateTime}`;
            element.style.display = 'inline';
        } else {
            element.textContent = 'No prices loaded yet';
            element.style.display = 'inline';
        }
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
            const dealText = deal !== undefined ? (deal || 0).toFixed(6) : 'N/A';
            tr.innerHTML = `
                <td>${order.id}</td>
                <td>
                    <div class="token-info">
                        <div class="token-icon"><div class="loading-spinner"></div></div>
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
                        <div class="token-icon"><div class="loading-spinner"></div></div>
                        <div class="token-details">
                            <div class="token-symbol-row">
                                <span class="token-symbol">${buyTokenInfo.symbol}</span>
                                <span class="token-price ${buyPriceClass}">${calculateTotalValue(resolvedBuyPrice, safeFormattedBuyAmount)}</span>
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
                            throw new Error('MetaMask is not installed. Please install MetaMask to cancel orders.');
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
                            throw new Error('MetaMask is not installed. Please install MetaMask to cancel orders.');
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
