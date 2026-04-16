import { BaseComponent } from './BaseComponent.js';
import { createLogger } from '../services/LogService.js';
import { contractService } from '../services/ContractService.js';
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
        this.REQUEST_TIMEOUT_MS = 7000;
        this.RECONNECT_TIMEOUT_MS = 45000;
        this.RECONNECT_RETRY_LIMIT = 1;
        this.feeConfigUpdatedHandler = null;
        this.contractDisabledHandler = null;
        this.allowedTokensUpdatedHandler = null;
    }

    setupFeeConfigSubscription(ws) {
        if (!ws?.subscribe) {
            return;
        }

        if (!this.feeConfigUpdatedHandler) {
            this.feeConfigUpdatedHandler = () => {
                this.debug('FeeConfigUpdated received, invalidating cached contract parameters');
                this.cachedParams = null;
                this.lastFetchTime = 0;

                // If this tab is visible, refresh immediately so UI reflects the new fee config.
                if (this.container?.classList?.contains('active') && !this.isInitializing) {
                    this.initialize().catch((error) => {
                        this.debug('Failed to refresh contract parameters after FeeConfigUpdated:', error);
                    });
                }
            };
        }

        if (ws.unsubscribe) {
            ws.unsubscribe('FeeConfigUpdated', this.feeConfigUpdatedHandler);
        }
        ws.subscribe('FeeConfigUpdated', this.feeConfigUpdatedHandler);
    }

    setupContractDisabledSubscription(ws) {
        if (!ws?.subscribe) {
            return;
        }

        if (!this.contractDisabledHandler) {
            this.contractDisabledHandler = () => {
                this.debug('ContractDisabled received, updating contract state display');
                this.applyContractDisabledState();
            };
        }

        if (ws.unsubscribe) {
            ws.unsubscribe('ContractDisabled', this.contractDisabledHandler);
        }
        ws.subscribe('ContractDisabled', this.contractDisabledHandler);
    }

    setupAllowedTokensSubscription(ws) {
        if (!ws?.subscribe) {
            return;
        }

        if (!this.allowedTokensUpdatedHandler) {
            this.allowedTokensUpdatedHandler = () => {
                this.debug('AllowedTokensUpdated received, invalidating cached contract parameters');
                this.cachedParams = null;
                this.lastFetchTime = 0;

                if (this.container?.classList?.contains('active') && !this.isInitializing) {
                    this.initialize().catch((error) => {
                        this.debug('Failed to refresh contract parameters after AllowedTokensUpdated:', error);
                    });
                }
            };
        }

        if (ws.unsubscribe) {
            ws.unsubscribe('AllowedTokensUpdated', this.allowedTokensUpdatedHandler);
        }
        ws.subscribe('AllowedTokensUpdated', this.allowedTokensUpdatedHandler);
    }

    applyContractDisabledState() {
        if (!this.cachedParams) {
            if (this.container?.classList?.contains('active') && !this.isInitializing) {
                this.initialize().catch((error) => {
                    this.debug('Failed to refresh contract parameters after ContractDisabled:', error);
                });
            }
            return;
        }

        this.cachedParams = {
            ...this.cachedParams,
            isDisabled: true
        };
        this.lastFetchTime = Date.now();

        const paramsContainer = this.container?.querySelector?.('.params-container');
        if (paramsContainer) {
            paramsContainer.innerHTML = this.generateParametersHTML(this.cachedParams);
        }
    }

    async initialize(readOnlyMode = true) {
        if (this.isInitializing) {
            this.debug('Already initializing, skipping...');
            return;
        }

        this.isInitializing = true;

        try {
            const ws = this.ctx.getWebSocket();
            this.setupFeeConfigSubscription(ws);
            this.setupContractDisabledSubscription(ws);
            this.setupAllowedTokensSubscription(ws);

            const now = Date.now();
            if (this.cachedParams && (now - this.lastFetchTime) < this.CACHE_DURATION) {
                this.debug('Using cached parameters');
                this.container.innerHTML = this.generateContainerHTML(this.cachedParams);
                this.isInitialized = true;
                return;
            }

            this.debug('Initializing ContractParams component');
            this.container.innerHTML = this.generateContainerHTML();

            const params = await this.fetchParametersWithRecovery();

            this.cachedParams = params;
            this.lastFetchTime = Date.now();
            this.container.innerHTML = this.generateContainerHTML(params);

            this.isInitialized = true;
            this.debug('Initialization complete');

        } catch (error) {
            this.debug('Initialization error:', error);
            const message = this.getLoadErrorMessage(error);

            if (this.cachedParams) {
                this.container.innerHTML = this.generateContainerHTML(this.cachedParams);
                this.showWarning(`Unable to refresh contract parameters: ${message}`);
                this.isInitialized = true;
            } else {
                this.container.innerHTML = this.generateContainerHTML(null, {
                    error: true
                });
                this.showError(`Failed to load contract parameters: ${message}`);
            }
        } finally {
            this.isInitializing = false;
        }
    }

    async fetchParametersWithRecovery() {
        const ws = this.ctx.getWebSocket();
        if (!ws) {
            throw new Error('WebSocket not available');
        }

        let lastError = null;

        for (let attempt = 0; attempt <= this.RECONNECT_RETRY_LIMIT; attempt++) {
            try {
                return await this.fetchParameters(ws);
            } catch (error) {
                lastError = error;
                this.debug(`Contract params fetch attempt ${attempt + 1} failed:`, error);

                if (attempt >= this.RECONNECT_RETRY_LIMIT || typeof ws.reconnect !== 'function') {
                    break;
                }

                this.warn('Contract params fetch failed, reconnecting WebSocket before retry');

                let reconnected = false;
                try {
                    reconnected = await this.waitForWsRecovery(ws);
                } catch (reconnectError) {
                    lastError = reconnectError;
                    this.debug('WebSocket reconnect failed while retrying contract params:', reconnectError);
                    break;
                }

                if (!reconnected) {
                    break;
                }
            }
        }

        throw lastError || new Error('Unable to load contract parameters');
    }

    async fetchParameters(ws) {
        const wsReady = await this.readWithTimeout(
            () => ws.waitForInitialization(),
            'WebSocket initialization'
        );
        if (!wsReady) {
            throw new Error('WebSocket initialization failed');
        }

        const contract = ws.contract;
        if (!contract) {
            throw new Error('Contract not initialized');
        }

        // Non-blocking read: only wait if a sync is already in flight.
        // App.startInitialOrderSync() owns the first triggerIfNeeded:true call.
        void ws.waitForOrderSync({ triggerIfNeeded: false }).catch((error) => {
            this.debug('Failed while checking order sync state:', error);
        });

        this.debug('Contract instance found, fetching parameters...');

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
        let successCount = 0;

        // Use HTTP RPC for contract parameter reads (avoids WebSocket timeout issues)
        console.log('[CONTRACT_PARAMS] Starting HTTP RPC reads for contract parameters');
        await Promise.all(
            Object.entries(paramMethods).map(async ([key, method]) => {
                try {
                    params[key] = await this.readWithTimeout(
                        () => contractService._readViaHttpRpc((c) => c[method]()),
                        method
                    );
                    successCount++;
                    this.debug(`Fetched ${key}:`, params[key]);
                } catch (error) {
                    this.debug(`Error fetching ${key}:`, error);
                }
            })
        );

        if (successCount === 0) {
            throw new Error('Timed out loading contract parameters');
        }

        try {
            const network = await this.readWithTimeout(
                () => contract.provider.getNetwork(),
                'network info'
            );
            params.chainId = network?.chainId;
            params.contractAddress = contract.address;
        } catch (error) {
            this.debug('Error fetching network info:', error);
            params.contractAddress = contract.address || 'N/A';
        }

        if (params.feeToken) {
            try {
                const tokenInfo = await this.readWithTimeout(
                    () => ws.getTokenInfo(params.feeToken),
                    `token info for ${params.feeToken}`
                );
                params.tokenSymbol = tokenInfo.symbol;
                params.tokenDecimals = tokenInfo.decimals;
                this.debug('Fetched token details:', tokenInfo);
            } catch (error) {
                this.debug('Error fetching token details:', error);
                params.tokenSymbol = 'Unknown';
                params.tokenDecimals = 18;
            }
        }

        const currentFeeToken = this.normalizeAddress(params.feeToken);
        const feeTokenSet = new Set();
        if (currentFeeToken) {
            feeTokenSet.add(currentFeeToken);
        }

        try {
            const orders = typeof ws.getOrders === 'function'
                ? ws.getOrders()
                : Array.from(ws.orderCache?.values?.() || []);

            for (const order of orders) {
                const orderFeeToken = this.normalizeAddress(order?.feeToken);
                if (!orderFeeToken || orderFeeToken === currentFeeToken) {
                    continue;
                }
                feeTokenSet.add(orderFeeToken);
            }
        } catch (error) {
            this.debug('Error collecting fee tokens from loaded orders:', error);
        }

        params.accumulatedFeeRows = [];
        if (typeof contract.accumulatedFeesByToken === 'function') {
            await Promise.all(
                Array.from(feeTokenSet).map(async (tokenAddress) => {
                    try {
                        // Use HTTP RPC for accumulated fees read
                        const [amount, tokenInfo] = await Promise.all([
                            this.readWithTimeout(
                                () => contractService._readViaHttpRpc((c) => c.accumulatedFeesByToken(tokenAddress)),
                                `accumulated fees for ${tokenAddress}`,
                            ),
                            this.readWithTimeout(
                                () => ws.getTokenInfo(tokenAddress),
                                `token info for ${tokenAddress}`
                            )
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
                    } catch (error) {
                        this.debug(`Error fetching accumulated fee data for ${tokenAddress}:`, error);
                    }
                })
            );
        }

        params.accumulatedFeeRows.sort((a, b) => {
            if (a.isCurrent && !b.isCurrent) return -1;
            if (!a.isCurrent && b.isCurrent) return 1;
            const left = `${a.symbol || ''}:${a.tokenAddress}`.toLowerCase();
            const right = `${b.symbol || ''}:${b.tokenAddress}`.toLowerCase();
            return left.localeCompare(right);
        });

        return params;
    }

    async waitForWsRecovery(ws) {
        const recoveryPromise = ws.isInitialized
            ? ws.reconnect()
            : ws.waitForInitialization();

        return await this.withTimeout(
            Promise.resolve(recoveryPromise),
            this.RECONNECT_TIMEOUT_MS,
            'WebSocket recovery timeout'
        );
    }

    async readWithTimeout(callback, label) {
        return await this.withTimeout(
            Promise.resolve().then(callback),
            this.REQUEST_TIMEOUT_MS,
            `${label} timeout`
        );
    }

    normalizeAddress(value) {
        try {
            return ethers.utils.getAddress(value);
        } catch (_) {
            return null;
        }
    }

    getLoadErrorMessage(error) {
        if (typeof error?.message === 'string' && error.message.trim()) {
            return error.message;
        }
        return 'Unknown error';
    }

    withTimeout(promise, timeoutMs, message) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error(message));
            }, timeoutMs);

            promise.then(
                (result) => {
                    clearTimeout(timeoutId);
                    resolve(result);
                },
                (error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                }
            );
        });
    }

    generateContainerHTML(params = null, options = {}) {
        const { error = false } = options;

        return `
            <div class="tab-content-wrapper">
                <h2 class="main-heading">Contract Parameters</h2>
                <div class="params-container">
                    ${params ? this.generateParametersHTML(params) : (
                        error
                            ? `<div class="params-error">Unable to load contract parameters right now. Please try again.</div>`
                            : `
                                <div class="loading-spinner"></div>
                                <div class="loading-text">Loading parameters...</div>
                            `
                    )}
                </div>
            </div>`;
    }

    generateParametersHTML(params) {
        const safe = (value, formatter = (v) => v?.toString() || 'N/A') => {
            try {
                return formatter(value);
            } catch (e) {
                return 'N/A';
            }
        };
        const newOrdersStatus = params.isDisabled === true
            ? 'Disabled'
            : params.isDisabled === false
                ? 'Enabled'
                : 'N/A';
        const newOrdersClass = params.isDisabled === true
            ? 'status-disabled'
            : params.isDisabled === false
                ? 'status-enabled'
                : '';

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
                        <p class="${newOrdersClass}">
                            ${newOrdersStatus}
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
        const totalSeconds = Number(seconds?.toString?.() ?? seconds);
        if (!Number.isFinite(totalSeconds)) {
            return 'N/A';
        }

        const days = Math.floor(totalSeconds / (24 * 60 * 60));
        const hours = Math.floor((totalSeconds % (24 * 60 * 60)) / (60 * 60));
        const minutes = Math.floor((totalSeconds % (60 * 60)) / 60);
        
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
        const ws = this.ctx.getWebSocket();
        if (ws?.unsubscribe && this.feeConfigUpdatedHandler) {
            ws.unsubscribe('FeeConfigUpdated', this.feeConfigUpdatedHandler);
        }
        if (ws?.unsubscribe && this.contractDisabledHandler) {
            ws.unsubscribe('ContractDisabled', this.contractDisabledHandler);
        }
        if (ws?.unsubscribe && this.allowedTokensUpdatedHandler) {
            ws.unsubscribe('AllowedTokensUpdated', this.allowedTokensUpdatedHandler);
        }
        // Don't clear the cache on cleanup
        this.isInitialized = false;
        this.isInitializing = false;
    }
}
