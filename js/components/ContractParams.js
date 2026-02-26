import { BaseComponent } from './BaseComponent.js';
import { createLogger } from '../services/LogService.js';
import { ethers } from 'ethers';

export class ContractParams extends BaseComponent {
    constructor() {
        super('contract-params');
        
        // Use centralized LogService instead of manual isDebugEnabled check
        const logger = createLogger('CONTRACT_PARAMS');
        this.debug = logger.debug.bind(logger);
        this.error = logger.error.bind(logger);
        this.warn = logger.warn.bind(logger);
        
        this.isInitializing = false;
        this.isInitialized = false;
        this.cachedParams = null;
        this.lastFetchTime = 0;
        this.CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds
    }

    async initialize(readOnlyMode = true) {
        if (this.isInitializing) {
            this.debug('Already initializing, skipping...');
            return;
        }

        this.isInitializing = true;

        try {
            // Check if we have valid cached data
            const now = Date.now();
            if (this.cachedParams && (now - this.lastFetchTime) < this.CACHE_DURATION) {
                this.debug('Using cached parameters');
                this.container.innerHTML = this.generateContainerHTML(this.cachedParams);
                return;
            }

            this.debug('Initializing ContractParams component');
            this.container.innerHTML = this.generateContainerHTML();

            // Wait for WebSocket initialization using WebSocket's promise
            const ws = this.ctx.getWebSocket();
            await ws?.waitForInitialization();

            const contract = ws.contract;
            if (!contract) {
                throw new Error('Contract not initialized');
            }

            // Non-blocking read: only wait if a sync is already in flight.
            // App.startInitialOrderSync() owns the first triggerIfNeeded:true call.
            void ws.waitForOrderSync({ triggerIfNeeded: false }).catch((e) => {
                this.debug('Failed while checking order sync state:', e);
            });

            this.debug('Contract instance found, fetching parameters...');

            // Fetch all parameters with individual error handling
            const params = {};
            const paramMethods = {
                orderCreationFee: 'orderCreationFeeAmount',
                firstOrderId: 'firstOrderId',
                nextOrderId: 'nextOrderId',
                isDisabled: 'isDisabled',
                feeToken: 'feeToken',
                owner: 'owner',
                gracePeriod: 'GRACE_PERIOD',
                orderExpiry: 'ORDER_EXPIRY',
                allowedTokensCount: 'getAllowedTokensCount'
            };

            // Use WebSocket's queueRequest for rate limiting
            await Promise.all(
                Object.entries(paramMethods).map(async ([key, method]) => {
                    try {
                        params[key] = await ws.queueRequest(
                            async () => contract[method]()
                        );
                        this.debug(`Fetched ${key}:`, params[key]);
                    } catch (e) {
                        this.debug(`Error fetching ${key}:`, e);
                    }
                })
            );

            // Add chain ID and contract address
            try {
                params.chainId = (await contract.provider.getNetwork()).chainId;
                params.contractAddress = contract.address;
            } catch (e) {
                this.debug('Error fetching network info:', e);
            }

            // Use WebSocket's token info cache for fee token details
            if (params.feeToken) {
                try {
                    const tokenInfo = await ws.getTokenInfo(params.feeToken);
                    params.tokenSymbol = tokenInfo.symbol;
                    params.tokenDecimals = tokenInfo.decimals;
                    this.debug('Fetched token details:', tokenInfo);
                } catch (e) {
                    this.debug('Error fetching token details:', e);
                    params.tokenSymbol = 'Unknown';
                    params.tokenDecimals = 18;
                }
            }

            // Build fee-token set from current fee token + loaded orders feeToken snapshots
            const feeTokenSet = new Set();
            const normalizeAddress = (value) => {
                try {
                    return ethers.utils.getAddress(value);
                } catch (_) {
                    return null;
                }
            };

            const currentFeeToken = normalizeAddress(params.feeToken);
            if (currentFeeToken) {
                feeTokenSet.add(currentFeeToken);
            }

            try {
                const orders = typeof ws.getOrders === 'function'
                    ? ws.getOrders()
                    : Array.from(ws.orderCache?.values?.() || []);

                for (const order of orders) {
                    const orderFeeToken = normalizeAddress(order?.feeToken);
                    if (!orderFeeToken || (currentFeeToken && orderFeeToken === currentFeeToken)) {
                        continue;
                    }
                    feeTokenSet.add(orderFeeToken);
                }
            } catch (e) {
                this.debug('Error collecting fee tokens from loaded orders:', e);
            }

            params.accumulatedFeeRows = [];
            if (typeof contract.accumulatedFeesByToken === 'function') {
                await Promise.all(
                    Array.from(feeTokenSet).map(async (tokenAddress) => {
                        try {
                            const [amount, tokenInfo] = await Promise.all([
                                ws.queueRequest(async () => contract.accumulatedFeesByToken(tokenAddress)),
                                ws.getTokenInfo(tokenAddress)
                            ]);
                            const keepRow = tokenAddress === currentFeeToken || !amount.isZero();
                            if (!keepRow) {
                                return;
                            }
                            params.accumulatedFeeRows.push({
                                tokenAddress,
                                amount,
                                symbol: tokenInfo?.symbol || 'Unknown',
                                decimals: tokenInfo?.decimals ?? 18,
                                isCurrent: currentFeeToken === tokenAddress
                            });
                        } catch (e) {
                            this.debug(`Error fetching accumulated fee data for ${tokenAddress}:`, e);
                        }
                    })
                );
            }

            // Keep current token first, then alphabetical by symbol/address
            params.accumulatedFeeRows.sort((a, b) => {
                if (a.isCurrent && !b.isCurrent) return -1;
                if (!a.isCurrent && b.isCurrent) return 1;
                const left = `${a.symbol || ''}:${a.tokenAddress}`.toLowerCase();
                const right = `${b.symbol || ''}:${b.tokenAddress}`.toLowerCase();
                return left.localeCompare(right);
            });

            // Update UI with available parameters
            const paramsContainer = this.container.querySelector('.params-container');
            paramsContainer.innerHTML = this.generateParametersHTML(params);

            // Cache the fetched parameters
            this.cachedParams = params;
            this.lastFetchTime = now;

            this.isInitialized = true;
            this.debug('Initialization complete');

        } catch (error) {
            this.debug('Initialization error:', error);
            this.showError(`Failed to load contract parameters: ${error.message}`);
        } finally {
            this.isInitializing = false;
        }
    }

    generateContainerHTML(params = null) {
        return `
            <div class="tab-content-wrapper">
                <h2 class="main-heading">Contract Parameters</h2>
                <div class="params-container">
                    ${params ? this.generateParametersHTML(params) : `
                        <div class="loading-spinner"></div>
                        <div class="loading-text">Loading parameters...</div>
                    `}
                </div>
            </div>`;
    }

    generateParametersHTML(params) {
        // Helper function to safely display values
        const safe = (value, formatter = (v) => v?.toString() || 'N/A') => {
            try {
                return formatter(value);
            } catch (e) {
                return 'N/A';
            }
        };

        return `
            <div class="param-grid">
                <div class="param-section">
                    <h3>Contract State</h3>
                    <div class="param-item">
                        <h4>Order Creation Fee</h4>
                        <p>${safe(params.orderCreationFee, (v) => this.formatTokenAmount(v, params.tokenDecimals))} ${safe(params.tokenSymbol)}</p>
                    </div>
                    <div class="param-item">
                        <h4>Fee Token</h4>
                        <p>${safe(params.feeToken)}</p>
                    </div>
                    <div class="param-item">
                        <h4>Accumulated Fees (By Fee Token)</h4>
                        ${this.renderAccumulatedFees(params)}
                    </div>
                    <div class="param-item">
                        <h4>New Orders</h4>
                        <p class="${params.isDisabled ? 'status-disabled' : 'status-enabled'}">
                            ${params.isDisabled ? 'Disabled' : 'Enabled'}
                        </p>
                    </div>
                </div>

                <div class="param-section">
                    <h3>Order Tracking</h3>
                    <div class="param-item">
                        <h4>First Order ID</h4>
                        <p>${safe(params.firstOrderId)}</p>
                    </div>
                    <div class="param-item">
                        <h4>Next Order ID</h4>
                        <p>${safe(params.nextOrderId)}</p>
                    </div>
                    <div class="param-item">
                        <h4>Total Orders</h4>
                        <p>${safe(params.nextOrderId && params.firstOrderId ? 
                            params.nextOrderId.sub(params.firstOrderId) : 'N/A')}</p>
                    </div>
                </div>

                <div class="param-section">
                    <h3>Contract Configuration</h3>
                    <div class="param-item">
                        <h4>Owner</h4>
                        <p>${safe(params.owner)}</p>
                    </div>
                    <div class="param-item">
                        <h4>Grace Period</h4>
                        <p>${safe(params.gracePeriod, (v) => this.formatTime(v))}</p>
                    </div>
                    <div class="param-item">
                        <h4>Order Expiry</h4>
                        <p>${safe(params.orderExpiry, (v) => this.formatTime(v))}</p>
                    </div>
                    <div class="param-item">
                        <h4>Allowed Tokens Count</h4>
                        <p>${safe(params.allowedTokensCount)}</p>
                    </div>
                </div>

                <div class="param-section">
                    <h3>Network Info</h3>
                    <div class="param-item">
                        <h4>Chain ID</h4>
                        <p>${safe(params.chainId)}</p>
                    </div>
                    <div class="param-item">
                        <h4>Contract Address</h4>
                        <p>${safe(params.contractAddress)}</p>
                    </div>
                </div>
            </div>`;
    }

    formatTime(seconds) {
        const days = Math.floor(seconds / (24 * 60 * 60));
        const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
        const minutes = Math.floor((seconds % (60 * 60)) / 60);
        
        return `${days}d ${hours}h ${minutes}m`;
    }

    formatTokenAmount(amount, decimals = 18) {
        return ethers.utils.formatUnits(amount, decimals);
    }

    renderAccumulatedFees(params) {
        const rows = Array.isArray(params.accumulatedFeeRows) ? params.accumulatedFeeRows : [];
        if (rows.length === 0) {
            return '<p>N/A</p>';
        }

        return rows.map((row) => {
            const label = `${this.formatTokenAmount(row.amount, row.decimals)} ${row.symbol}`;
            return `<p>${label}</p>`;
        }).join('');
    }

    cleanup() {
        this.debug('Cleaning up ContractParams component');
        // Don't clear the cache on cleanup
        this.isInitialized = false;
        this.isInitializing = false;
    }
}
