import { formatTimeDiff } from '../utils/orderUtils.js';
import { createLogger } from './LogService.js';
import { createInlineTooltipIcon, setupOrderTooltips } from '../utils/ui.js';

/**
 * OrdersTableRenderer - Handles table structure, pagination, and expiry timers
 * 
 * Provides common rendering infrastructure for order tables:
 * - Table structure creation
 * - Pagination controls
 * - Expiry countdown timers
 * 
 * Components provide custom row renderers via options.rowRenderer
 */
export class OrdersTableRenderer {
    constructor(component, options = {}) {
        this.component = component; // Reference to the component using this renderer
        this.options = {
            // Custom row renderer function: (order) => HTMLElement
            rowRenderer: options.rowRenderer || null,
            // Table headers (array of header objects: { text, title? })
            headers: options.headers || [
                { text: 'ID' },
                { text: 'Buy' },
                { text: 'Sell' },
                { text: 'Deal', title: 'Deal = Buy Value / Sell Value\n\n• Higher deal number is better\n• Deal > 1: better deal based on market prices\n• Deal < 1: worse deal based on market prices' },
                { text: 'Expires' },
                { text: 'Status' },
                { text: 'Action' }
            ],
            // Filter toggle label
            filterToggleLabel: options.filterToggleLabel || 'Show only fillable orders',
            // Show refresh button
            showRefreshButton: options.showRefreshButton !== false,
            // Custom filter controls HTML (optional)
            customFilterControls: options.customFilterControls || null
        };
        
        const logger = createLogger('ORDERS_RENDERER');
        this.debug = logger.debug.bind(logger);
        this.error = logger.error.bind(logger);
        this.warn = logger.warn.bind(logger);

        this._refreshInFlight = false;
        this._refreshStatusTimeout = null;
    }

    /**
     * Setup the table structure
     * @param {Function} onRefresh - Callback when refresh is triggered
     */
    async setupTable(onRefresh) {
        // Prevent multiple table setups
        if (this.component._tableSetup) {
            this.debug('Table already setup, skipping...');
            return;
        }
        this.component._tableSetup = true;
        
        // Ensure container exists
        if (!this.component.container) {
            this.error('Component container not available for setupTable');
            throw new Error('Component container not initialized');
        }
        
        // Clear existing content
        this.component.container.innerHTML = '';
        
        const tableContainer = this.component.createElement('div', 'table-container');
        
        // Main filter controls
        const filterControls = this._createFilterControls(onRefresh);
        tableContainer.appendChild(filterControls);
        
        // Add table
        const table = this._createTable();
        tableContainer.appendChild(table);
        
        // Bottom controls
        const bottomControls = this._createBottomControls(onRefresh);
        tableContainer.appendChild(bottomControls);
        
        // Append table container to component container first
        this.component.container.appendChild(tableContainer);
        
        // Setup event listeners AFTER appending (so elements exist in DOM)
        this._setupTableEventListeners(onRefresh);
        setupOrderTooltips(this.component.container);
    }

    /**
     * Create filter controls section
     */
    _createFilterControls(onRefresh) {
        const filterControls = this.component.createElement('div', 'filter-controls');
        
        // Get tokens for filters
        const ws = this.component.ctx.getWebSocket();
        const tokens = Array.from(ws.tokenCache.values())
            .sort((a, b) => a.symbol.localeCompare(b.symbol));
        
        let mobileRefreshSection = '';
        if (this.options.showRefreshButton) {
            mobileRefreshSection = `
                <div class="refresh-container refresh-container--mobile">
                    <button class="refresh-prices-button js-refresh-prices" type="button">↻ Refresh Prices</button>
                    <span class="refresh-status"></span>
                    <span class="last-updated js-last-updated"></span>
                </div>
            `;
        }

        filterControls.innerHTML = `
            <div class="filter-row">
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
                        <input type="checkbox" id="fillable-orders-toggle" checked>
                        <span>${this.options.filterToggleLabel}</span>
                    </label>
                </div>

                <div class="pagination-controls">
                    <select id="page-size-select" class="page-size-select">
                        <option value="10">10 per page</option>
                        <option value="25" selected>25 per page</option>
                        <option value="50">50 per page</option>
                        <option value="100">100 per page</option>
                        <option value="-1">View all</option>
                    </select>
                    
                    <div class="pagination-buttons">
                        <button class="pagination-button prev-page" title="Previous page">←</button>
                        <span class="page-info">Page 1 of 1</span>
                        <button class="pagination-button next-page" title="Next page">→</button>
                    </div>
                </div>
            </div>
            ${mobileRefreshSection}
        `;

        // Advanced filters
        const advancedFilters = this._createAdvancedFilters(tokens);
        filterControls.appendChild(advancedFilters);
        
        // Setup advanced filters toggle
        const toggle = filterControls.querySelector('.advanced-filters-toggle');
        toggle.addEventListener('click', () => {
            const isExpanded = advancedFilters.style.display !== 'none';
            advancedFilters.style.display = isExpanded ? 'none' : 'block';
            toggle.classList.toggle('expanded', !isExpanded);
        });

        return filterControls;
    }

    /**
     * Create advanced filters section
     */
    _createAdvancedFilters(tokens) {
        const advancedFilters = this.component.createElement('div', 'advanced-filters');
        advancedFilters.style.display = 'none';
        advancedFilters.innerHTML = `
            <div class="filter-row">
                <div class="token-filters">
                    <select id="sell-token-filter" class="token-filter">
                        <option value="">All Buy Tokens</option>
                        ${tokens.map(token => 
                            `<option value="${token.address}">${token.symbol}</option>`
                        ).join('')}
                    </select>
                    <select id="buy-token-filter" class="token-filter">
                        <option value="">All Sell Tokens</option>
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
        `;
        return advancedFilters;
    }

    /**
     * Create table element
     */
    _createTable() {
        const table = this.component.createElement('table', 'orders-table');
        
        const thead = this.component.createElement('thead');
        const headerRow = this.component.createElement('tr');
        
        this.options.headers.forEach(header => {
            const th = this.component.createElement('th');
            th.textContent = header.text;
            if (header.title) {
                const tooltipIcon = createInlineTooltipIcon(header.title, {
                    className: 'info-icon order-tooltip-icon',
                    ariaLabel: `${header.text} information`
                });
                th.innerHTML = `${header.text} ${tooltipIcon}`;
            }
            headerRow.appendChild(th);
        });
        
        thead.appendChild(headerRow);
        table.appendChild(thead);
        table.appendChild(this.component.createElement('tbody'));
        
        return table;
    }

    /**
     * Create bottom controls section
     */
    _createBottomControls(onRefresh) {
        const bottomControls = this.component.createElement('div', 'filter-controls bottom-controls');
        
        let refreshSection = '';
        if (this.options.showRefreshButton) {
            refreshSection = `
                <div class="refresh-container">
                    <button class="refresh-prices-button js-refresh-prices" type="button">↻ Refresh Prices</button>
                    <span class="refresh-status"></span>
                    <span class="last-updated js-last-updated"></span>
                </div>
            `;
        }
        
        bottomControls.innerHTML = `
            <div class="filter-row">
                ${refreshSection}
                <div class="pagination-controls">
                    <div class="pagination-buttons">
                        <button class="pagination-button prev-page" title="Previous page">←</button>
                        <span class="page-info">Page 1 of 1</span>
                        <button class="pagination-button next-page" title="Next page">→</button>
                    </div>
                </div>
            </div>
        `;
        
        return bottomControls;
    }

    /**
     * Setup table event listeners
     */
    _setupTableEventListeners(onRefresh) {
        if (!this.component.container) {
            this.error('Component container not available');
            return;
        }
        
        const filterControls = this.component.container.querySelector('.filter-controls');
        if (!filterControls) {
            this.warn('Filter controls not found, skipping event listener setup');
            return;
        }
        
        // Filter change listeners
        const sellTokenFilter = filterControls.querySelector('#sell-token-filter');
        const buyTokenFilter = filterControls.querySelector('#buy-token-filter');
        const orderSort = filterControls.querySelector('#order-sort');
        const toggle = filterControls.querySelector('#fillable-orders-toggle');
        const pageSizeSelect = filterControls.querySelector('#page-size-select');
        
        if (sellTokenFilter) {
            sellTokenFilter.addEventListener('change', () => {
                this.component.currentPage = 1;
                if (onRefresh) onRefresh();
            });
        }
        if (buyTokenFilter) {
            buyTokenFilter.addEventListener('change', () => {
                this.component.currentPage = 1;
                if (onRefresh) onRefresh();
            });
        }
        if (orderSort) {
            orderSort.addEventListener('change', () => {
                if (onRefresh) onRefresh();
            });
        }
        if (toggle) {
            toggle.addEventListener('change', () => {
                this.component.currentPage = 1;
                if (onRefresh) onRefresh();
            });
        }
        if (pageSizeSelect) {
            pageSizeSelect.addEventListener('change', () => {
                this.component.currentPage = 1;
                if (onRefresh) onRefresh();
            });
        }
        
        // Pagination listeners
        this._setupPaginationListeners(onRefresh);

        if (this.options.showRefreshButton) {
            this._setupRefreshControls(onRefresh);
        }
    }

    /**
     * Setup pagination event listeners
     */
    _setupPaginationListeners(onRefresh) {
        const setupPaginationListeners = (controls) => {
            const prevButton = controls.querySelector('.prev-page');
            const nextButton = controls.querySelector('.next-page');
            const pageInfo = controls.querySelector('.page-info');
            
            prevButton.addEventListener('click', () => {
                this.debug('Previous clicked, current page:', this.component.currentPage);
                if (this.component.currentPage > 1) {
                    this.component.currentPage--;
                    this.updatePageInfo(pageInfo);
                    if (onRefresh) onRefresh();
                }
            });
            
            nextButton.addEventListener('click', () => {
                const pageSize = parseInt(this.component.container.querySelector('#page-size-select')?.value || '25');
                const totalPages = Math.ceil(this.component.totalOrders / pageSize);
                this.debug('Next clicked, current page:', this.component.currentPage, 'total orders:', this.component.totalOrders, 'page size:', pageSize);
                if (this.component.currentPage < totalPages) {
                    this.component.currentPage++;
                    this.updatePageInfo(pageInfo);
                    if (onRefresh) onRefresh();
                }
            });
        };

        const controls = this.component.container.querySelectorAll('.filter-controls');
        controls.forEach(setupPaginationListeners);
    }

    _setupRefreshControls(onRefresh) {
        if (!this.options.showRefreshButton || !this.component.helper || !this.component.pricingService) {
            return;
        }

        const refreshContainers = Array.from(this.component.container.querySelectorAll('.refresh-container'));
        if (refreshContainers.length === 0) {
            return;
        }

        const controls = refreshContainers.map((container) => ({
            button: container.querySelector('.js-refresh-prices'),
            status: container.querySelector('.refresh-status'),
            timestamp: container.querySelector('.js-last-updated')
        })).filter(control => control.button && control.status);

        if (controls.length === 0) {
            return;
        }

        controls.forEach((control) => {
            if (control.timestamp) {
                this.component.helper.updateLastUpdatedTimestamp(control.timestamp);
            }

            control.button.addEventListener('click', async () => {
                if (this._refreshInFlight) return;
                this._refreshInFlight = true;

                this._setRefreshControlsState(controls, {
                    isLoading: true,
                    text: '',
                    statusClass: 'loading'
                });

                try {
                    const result = await this.component.pricingService.refreshPrices();
                    if (result.success) {
                        this._setRefreshControlsState(controls, {
                            isLoading: false,
                            text: `Updated ${new Date().toLocaleTimeString()}`,
                            statusClass: 'success'
                        });
                        controls.forEach((entry) => {
                            if (entry.timestamp) {
                                this.component.helper.updateLastUpdatedTimestamp(entry.timestamp);
                            }
                        });
                        if (onRefresh) await onRefresh();
                    } else {
                        this._setRefreshControlsState(controls, {
                            isLoading: false,
                            text: result.message || 'Failed to refresh prices',
                            statusClass: 'error'
                        });
                    }
                } catch (error) {
                    this._setRefreshControlsState(controls, {
                        isLoading: false,
                        text: 'Failed to refresh prices',
                        statusClass: 'error'
                    });
                } finally {
                    this._refreshInFlight = false;
                    if (this._refreshStatusTimeout) {
                        clearTimeout(this._refreshStatusTimeout);
                    }
                    this._refreshStatusTimeout = setTimeout(() => {
                        controls.forEach((entry) => {
                            entry.status.style.opacity = 0;
                        });
                        this._refreshStatusTimeout = null;
                    }, 2000);
                }
            });
        });
    }

    _setRefreshControlsState(controls, { isLoading = false, text = '', statusClass = '' }) {
        controls.forEach((control) => {
            control.button.disabled = isLoading;
            control.button.textContent = isLoading ? '↻ Refreshing...' : '↻ Refresh Prices';
            control.status.className = `refresh-status${statusClass ? ` ${statusClass}` : ''}`;
            control.status.textContent = text;
            control.status.style.opacity = text || isLoading ? 1 : 0;
        });
    }

    /**
     * Update page info display
     */
    updatePageInfo(pageInfoElement) {
        const pageSize = parseInt(this.component.container.querySelector('#page-size-select')?.value || '25');
        const totalPages = Math.ceil(this.component.totalOrders / pageSize);
        pageInfoElement.textContent = `Page ${this.component.currentPage} of ${totalPages}`;
    }

    /**
     * Update pagination controls
     */
    updatePaginationControls(totalOrders) {
        this.component.totalOrders = totalOrders;
        const pageSize = parseInt(this.component.container.querySelector('#page-size-select')?.value || '25');
        
        const updateControls = (container) => {
            const prevButton = container.querySelector('.prev-page');
            const nextButton = container.querySelector('.next-page');
            const pageInfo = container.querySelector('.page-info');
            
            if (pageSize === -1) {
                // Show all orders
                prevButton.disabled = true;
                nextButton.disabled = true;
                pageInfo.textContent = `Showing all ${totalOrders} orders`;
                return;
            }
            
            const totalPages = Math.max(1, Math.ceil(totalOrders / pageSize));
            
            // Ensure current page is within bounds
            this.component.currentPage = Math.min(Math.max(1, this.component.currentPage), totalPages);
            
            prevButton.disabled = this.component.currentPage <= 1;
            nextButton.disabled = this.component.currentPage >= totalPages;
            
            const startItem = ((this.component.currentPage - 1) * pageSize) + 1;
            const endItem = Math.min(this.component.currentPage * pageSize, totalOrders);
            
            pageInfo.textContent = `${startItem}-${endItem} of ${totalOrders} orders (Page ${this.component.currentPage} of ${totalPages})`;
        };
        
        // Update both top and bottom controls
        const controls = this.component.container.querySelectorAll('.filter-controls');
        controls.forEach(updateControls);
    }

    /**
     * Start expiry timer for a row
     */
    startExpiryTimer(row) {
        // Clear any existing timer
        if (!this.component.expiryTimers) {
            this.component.expiryTimers = new Map();
        }
        
        const existingTimer = this.component.expiryTimers.get(row.dataset.orderId);
        if (existingTimer) {
            clearInterval(existingTimer);
        }

        const updateExpiryAndButton = async () => {
            const expiresCell = row.querySelector('.order-cell--expires') || row.querySelector('td:nth-child(5)');
            const statusCell = row.querySelector('.order-status');
            const actionCell = row.querySelector('.action-column');
            if (!expiresCell || !statusCell || !actionCell) return;

            const orderId = row.dataset.orderId;
            const ws = this.component.ctx.getWebSocket();
            const wallet = this.component.ctx.getWallet();
            const order = ws.orderCache.get(Number(orderId));
            if (!order) return;

            await ws.ensureFreshChainTime();
            const currentTime = ws.getCurrentTimestamp();
            const expiresAt = order?.timings?.expiresAt;
            const timeDiff = Number.isFinite(currentTime) && typeof expiresAt === 'number'
                ? expiresAt - currentTime
                : null;
            const orderStatusForExpiry = ws.getOrderStatus(order);
            const newExpiryText = orderStatusForExpiry === 'Active' && Number.isFinite(timeDiff)
                ? formatTimeDiff(timeDiff)
                : '';
            
            if (expiresCell.textContent !== newExpiryText) {
                expiresCell.textContent = newExpiryText;
            }

            // Update status
            const currentStatus = ws.getOrderStatus(order);
            const statusMainElement = statusCell.querySelector('.status-main');
            if (statusMainElement && statusMainElement.textContent !== currentStatus) {
                statusMainElement.textContent = currentStatus;
            } else if (!statusMainElement && statusCell.textContent !== currentStatus) {
                statusCell.textContent = currentStatus;
            }

            // Let component handle action column updates
            if (this.component.updateActionColumn) {
                this.component.updateActionColumn(actionCell, order, wallet);
            }
        };

        // Update immediately and then every minute
        updateExpiryAndButton();
        const timerId = setInterval(updateExpiryAndButton, 60000);
        this.component.expiryTimers.set(row.dataset.orderId, timerId);
    }

    /**
     * Render orders into the table
     * @param {Array} orders - Orders to render
     */
    async renderOrders(orders) {
        const tbody = this.component.container.querySelector('tbody');
        if (!tbody) {
            this.error('Table body not found');
            return;
        }

        // Clear existing rows
        tbody.innerHTML = '';

        if (!this.options.rowRenderer) {
            this.error('No row renderer provided');
            return;
        }

        // Render each order
        for (const order of orders) {
            try {
                const row = await this.options.rowRenderer(order);
                if (row) {
                    this._applyRowCellMetadata(row);
                    tbody.appendChild(row);
                    // Start expiry timer
                    this.startExpiryTimer(row);
                }
            } catch (error) {
                this.error('Error rendering order row:', error);
            }
        }

        setupOrderTooltips(this.component.container);
    }

    _applyRowCellMetadata(row) {
        if (!row || row.classList.contains('empty-message')) {
            return;
        }

        row.classList.add('orders-row');
        const descriptors = this._getTableColumnDescriptors();
        const cells = Array.from(row.querySelectorAll('td'));
        cells.forEach((cell, index) => {
            const descriptor = descriptors[index] || {
                label: `Column ${index + 1}`,
                key: `col-${index + 1}`
            };
            cell.dataset.label = descriptor.label;
            cell.dataset.colKey = descriptor.key;
            cell.classList.add('order-cell', `order-cell--${descriptor.key}`);
        });
    }

    _getTableColumnDescriptors() {
        const defaultKeys = ['id', 'buy', 'sell', 'deal', 'expires', 'status', 'action'];
        const headerCells = Array.from(this.component.container.querySelectorAll('thead th'));
        return headerCells.map((headerCell, index) => {
            const label = this._extractHeaderLabel(headerCell);
            const normalized = label.toLowerCase();
            let key = defaultKeys[index] || `col-${index + 1}`;
            if (normalized.includes('id')) key = 'id';
            else if (normalized.includes('buy')) key = 'buy';
            else if (normalized.includes('sell')) key = 'sell';
            else if (normalized.includes('deal')) key = 'deal';
            else if (normalized.includes('expire')) key = 'expires';
            else if (normalized.includes('status')) key = 'status';
            else if (normalized.includes('action')) key = 'action';
            return { label, key };
        });
    }

    _extractHeaderLabel(headerCell) {
        if (!headerCell) return '';
        const clone = headerCell.cloneNode(true);
        clone.querySelectorAll('.info-icon').forEach((icon) => icon.remove());
        return clone.textContent.replace(/\s+/g, ' ').trim();
    }

    /**
     * Cleanup timers
     */
    cleanup() {
        if (this._refreshStatusTimeout) {
            clearTimeout(this._refreshStatusTimeout);
            this._refreshStatusTimeout = null;
        }
        if (this.component.expiryTimers) {
            this.component.expiryTimers.forEach(timerId => clearInterval(timerId));
            this.component.expiryTimers.clear();
        }
    }
}
