import { ethers } from 'ethers';
import { ORDER_CONSTANTS } from '../config/index.js';
import { getNetworkConfig } from '../config/networks.js';
import { tryAggregate as multicallTryAggregate, isMulticallAvailable } from './MulticallService.js';
import { erc20Abi } from '../abi/erc20.js';
import { createLogger } from './LogService.js';
import { tokenIconService } from './TokenIconService.js';

export class WebSocketService {
    constructor(options = {}) {
        this.provider = null;
        this.subscribers = new Map();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.orderCache = new Map();
        this.isInitialized = false;
        this.contractAddress = null;
        this.contractABI = null;
        this.contract = null;
        
        // Injected dependencies (preferred over window globals)
        this.pricingService = options.pricingService || null;
        
        // Add rate limiting properties
        this.requestQueue = [];
        this.processingQueue = false;
        this.lastRequestTime = 0;
        this.minRequestInterval = 100; // Increase from 100ms to 500ms between requests
        this.maxConcurrentRequests = 2; // Reduce from 3 to 1 concurrent request
        this.activeRequests = 0;
        
        // Add contract constants
        this.orderExpiry = null;
        this.gracePeriod = null;

        // Throttle state for block logs
        this.lastBlockLogTime = 0;
        
        // Chain-time cache (authoritative source for expiry/grace checks)
        this.lastKnownChainTimestamp = null;
        this.lastKnownChainBlock = null;
        this.chainTimeSyncedAtMonotonicMs = null;
        this.chainTimeSyncPromise = null;
        this.chainTimeMaxAgeMs = 30000;
        

        const logger = createLogger('WEBSOCKET');
        this.debug = logger.debug.bind(logger);
        this.error = logger.error.bind(logger);
        this.warn = logger.warn.bind(logger);
        
        this.tokenCache = new Map();  // Add token cache
    }

    hasContractEvent(contract, eventName) {
        if (!contract?.interface?.getEvent) {
            return false;
        }
        try {
            contract.interface.getEvent(eventName);
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * Monotonic clock helper for elapsed-time calculations.
     * Uses `performance.now()` when available and falls back to `Date.now()`.
     * @returns {number} Milliseconds since an arbitrary monotonic origin.
     */
    getMonotonicNowMs() {
        if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
            return performance.now();
        }
        return Date.now();
    }

    /**
     * Check whether chain time has been initialized.
     * @returns {boolean} True when chain timestamp and sync time are both present.
     */
    hasChainTime() {
        return Number.isFinite(this.lastKnownChainTimestamp) &&
            Number.isFinite(this.chainTimeSyncedAtMonotonicMs);
    }

    /**
     * Age of the cached chain timestamp.
     * @returns {number} Milliseconds since last chain-time sync, or `Infinity` if unavailable.
     */
    getChainTimeAgeMs() {
        if (!this.hasChainTime()) {
            return Infinity;
        }
        return Math.max(0, this.getMonotonicNowMs() - this.chainTimeSyncedAtMonotonicMs);
    }

    /**
     * Synchronize local chain-time cache from the provider.
     * @param {string|number} [blockRef='latest'] - Block tag or number to query.
     * @returns {Promise<number|null>} Synced chain timestamp in seconds, or `null` on failure.
     */
    async syncChainTime(blockRef = 'latest') {
        if (!this.provider) {
            return null;
        }

        if (this.chainTimeSyncPromise) {
            return this.chainTimeSyncPromise;
        }

        this.chainTimeSyncPromise = (async () => {
            try {
                const block = await this.provider.getBlock(blockRef);
                const blockTimestamp = Number(block?.timestamp);
                const blockNumber = Number(block?.number);

                if (!Number.isFinite(blockTimestamp)) {
                    return null;
                }

                if (Number.isFinite(this.lastKnownChainBlock) &&
                    Number.isFinite(blockNumber) &&
                    blockNumber < this.lastKnownChainBlock) {
                    return this.lastKnownChainTimestamp;
                }

                this.lastKnownChainTimestamp = blockTimestamp;
                this.lastKnownChainBlock = Number.isFinite(blockNumber)
                    ? blockNumber
                    : this.lastKnownChainBlock;
                this.chainTimeSyncedAtMonotonicMs = this.getMonotonicNowMs();

                return this.lastKnownChainTimestamp;
            } catch (error) {
                this.debug('Failed to sync chain time:', error);
                return null;
            } finally {
                this.chainTimeSyncPromise = null;
            }
        })();

        return this.chainTimeSyncPromise;
    }

    /**
     * Get best-known current chain timestamp by extrapolating from last synced block time.
     * @returns {number|null} Current chain time in seconds, or `null` if unknown.
     */
    getCurrentTimestamp() {
        if (this.hasChainTime()) {
            const elapsedSecs = Math.floor(
                (this.getMonotonicNowMs() - this.chainTimeSyncedAtMonotonicMs) / 1000
            );
            return this.lastKnownChainTimestamp + Math.max(0, elapsedSecs);
        }

        return null;
    }

    /**
     * Ensure cached chain time exists and is recent enough for UI/eligibility checks.
     * @param {number} [maxAgeMs=this.chainTimeMaxAgeMs] - Maximum tolerated cache age in ms.
     * @returns {Promise<number|null>} Current chain timestamp in seconds, or `null` if sync failed.
     */
    async ensureFreshChainTime(maxAgeMs = this.chainTimeMaxAgeMs) {
        const requestedMaxAgeMs = Number(maxAgeMs);
        const effectiveMaxAgeMs = Number.isFinite(requestedMaxAgeMs) && requestedMaxAgeMs >= 0
            ? requestedMaxAgeMs
            : this.chainTimeMaxAgeMs;

        if (!this.hasChainTime() || this.getChainTimeAgeMs() > effectiveMaxAgeMs) {
            await this.syncChainTime();
        }

        return this.getCurrentTimestamp();
    }

    /**
     * Compare a timestamp against best-known current chain time.
     * @param {number|string|null|undefined} targetTimestamp - Target unix timestamp (seconds).
     * @returns {boolean} True when current time is greater than target.
     * Falls back to local wall-clock time if chain time is temporarily unavailable.
     */
    isPastTimestamp(targetTimestamp) {
        const timestamp = Number(targetTimestamp);
        if (!Number.isFinite(timestamp)) {
            return false;
        }

        const chainTime = this.getCurrentTimestamp();
        if (Number.isFinite(chainTime)) {
            return chainTime > timestamp;
        }

        return Math.floor(Date.now() / 1000) > timestamp;
    }

    /**
     * Build derived timing fields for an order using configured expiry and grace constants.
     * @param {number|string|null|undefined} createdAtInput - Order creation unix timestamp (seconds).
     * @returns {{createdAt:number|null, expiresAt:number|null, graceEndsAt:number|null}} Derived timings.
     */
    buildOrderTimings(createdAtInput) {
        const createdAt = Number(createdAtInput);
        if (!Number.isFinite(createdAt)) {
            return {
                createdAt: null,
                expiresAt: null,
                graceEndsAt: null
            };
        }

        const orderExpirySecs = this.orderExpiry
            ? this.orderExpiry.toNumber()
            : ORDER_CONSTANTS.DEFAULT_ORDER_EXPIRY_SECS;
        const gracePeriodSecs = this.gracePeriod
            ? this.gracePeriod.toNumber()
            : ORDER_CONSTANTS.DEFAULT_GRACE_PERIOD_SECS;

        return {
            createdAt,
            expiresAt: createdAt + orderExpirySecs,
            graceEndsAt: createdAt + orderExpirySecs + gracePeriodSecs
        };
    }

    /**
     * Resolve order grace-end timestamp from cached timings or base order timestamp.
     * @param {Object} order - Order-like object from cache.
     * @returns {number|null} Grace-end unix timestamp (seconds), or `null` when unavailable.
     */
    getOrderGraceEndTime(order) {
        const graceEndsAt = Number(order?.timings?.graceEndsAt);
        if (Number.isFinite(graceEndsAt)) {
            return graceEndsAt;
        }

        if (Number.isFinite(Number(order?.timestamp))) {
            return this.buildOrderTimings(order.timestamp).graceEndsAt;
        }

        return null;
    }

    async queueRequest(callback) {
        while (this.activeRequests >= this.maxConcurrentRequests) {
            await new Promise(resolve => setTimeout(resolve, 100)); // Increase wait time
        }
        
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < this.minRequestInterval) {
            await new Promise(resolve => 
                setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest)
            );
        }
        
        try {
            this.activeRequests++;
            this.debug(`Making request (active: ${this.activeRequests})`);
            const result = await callback();
            this.lastRequestTime = Date.now();
            return result;
        } catch (error) {
            if (error?.error?.code === -32005) {
                this.warn('Rate limit hit, waiting before retry...');
                await new Promise(resolve => setTimeout(resolve, 2000));
                return this.queueRequest(callback);
            }
            this.error('Request failed:', error);
            throw error;
        } finally {
            this.activeRequests--;
        }
    }

    async initialize() {
        if (this.isInitialized) {
            this.debug('Already initialized, skipping...');
            return;
        }

        try {
            this.debug('Starting initialization...');
            this.initializationPromise = (async () => {
                // Wait for provider connection
                const config = getNetworkConfig();
                
                const wsUrls = [config.wsUrl, ...config.fallbackWsUrls];
                let connected = false;
                
                for (const url of wsUrls) {
                    try {
                        this.debug('Attempting to connect to WebSocket URL:', url);
                        this.provider = new ethers.providers.WebSocketProvider(url);
                        
                        // Wait for provider to be ready
                        await this.provider.ready;
                        this.debug('Connected to WebSocket:', url);
                        connected = true;
                        break;
                    } catch (error) {
                        this.debug('Failed to connect to WebSocket URL:', url, error);
                    }
                }
                
                if (!connected) {
                    throw new Error('Failed to connect to any WebSocket URL');
                }

                await this.syncChainTime();

                // Initialize contract before fetching constants
                this.debug('Initializing contract...');
                this.contractAddress = config.contractAddress;
                this.contractABI = config.contractABI;

                if (!this.contractABI) {
                    throw new Error('Contract ABI not found in network config');
                }

                this.contract = new ethers.Contract(
                    this.contractAddress,
                    this.contractABI,
                    this.provider
                );

                this.debug('Contract initialized:', {
                    address: this.contract.address,
                    abi: this.contract.interface.format()
                });

                this.debug('Fetching contract constants...');
                this.orderExpiry = await this.contract.ORDER_EXPIRY();
                this.gracePeriod = await this.contract.GRACE_PERIOD();
                this.debug('Contract constants loaded:', {
                    orderExpiry: this.orderExpiry.toString(),
                    gracePeriod: this.gracePeriod.toString()
                });
                
                // Subscribe to pricing service after everything else is ready
                const pricing = this.pricingService;
                if (pricing) {
                    this.debug('Subscribing to pricing service...');
                    pricing.subscribe(() => {
                        this.debug('Price update received, updating all deals...');
                        this.updateAllDeals();
                    });
                    // Trigger initial allowed token price fetch in background.
                    // Do not block initial UI readiness on pricing API requests.
                    Promise.resolve()
                        .then(async () => {
                            await pricing.getAllowedTokens();
                            await pricing.fetchAllowedTokensPrices();
                        })
                        .catch((err) => {
                            this.debug('Initial allowed token fetch after WS init failed:', err);
                        });
                } else {
                    this.debug('Warning: PricingService not available');
                }
                
                this.isInitialized = true;
                this.debug('Initialization complete');
                this.reconnectAttempts = 0;
                
                return true;
            })();

            return await this.initializationPromise;
        } catch (error) {
            this.error('Initialization failed:', {
                message: error.message,
                stack: error.stack
            });
            this.initializationPromise = null;
            return this.reconnect();
        }
    }

    async waitForInitialization() {
        if (this.isInitialized) return true;
        if (this.initializationPromise) {
            return await this.initializationPromise;
        }
        return this.initialize();
    }

    async setupEventListeners(contract) {
        try {
            this.debug('Setting up event listeners for contract:', contract.address);
            
            // Clean up any existing event listeners first
            if (this.provider) {
                this.provider.removeAllListeners("block");
            }

            // Test event subscription
            const filter = contract.filters.OrderCreated();
            this.debug('Created filter:', filter);
            
            // Listen for new blocks to ensure connection is alive (throttled logging)
            this.provider.on("block", async (blockNumber) => {
                try {
                    await this.syncChainTime(blockNumber);
                    const now = Date.now();
                    if (now - this.lastBlockLogTime >= 5000) { // log at most every 5s
                        this.lastBlockLogTime = now;
                        this.debug('New block received:', blockNumber);
                    }
                } catch (error) {
                    this.debug('Error processing block event:', error);
                    // Don't let block processing errors crash the app
                }
            });

            // Add error handling for WebSocket connection
            this.provider._websocket.onopen = () => {
                this.debug('WebSocket connected');
            };

            this.provider._websocket.onerror = (error) => {
                this.debug('WebSocket error:', error);
            };

            this.provider._websocket.onclose = (event) => {
                this.debug('WebSocket closed:', event);
                // Attempt to reconnect if not manually closed
                if (event.code !== 1000) {
                    this.debug('WebSocket closed unexpectedly, attempting to reconnect...');
                    setTimeout(() => {
                        this.reconnect();
                    }, 5000);
                }
            };

            contract.on("OrderCreated", async (...args) => {
                try {
                    if (!args || args.length < 9) {
                        this.debug('Invalid OrderCreated event args:', args);
                        return;
                    }
                    const [orderId, maker, taker, sellToken, sellAmount, buyToken, buyAmount, timestamp, fee, event] = args;
                    const createdAt = timestamp.toNumber();
                    
                    let orderData = {
                        id: orderId.toNumber(),
                        maker,
                        taker,
                        sellToken,
                        sellAmount,
                        buyToken,
                        buyAmount,
                        timestamp: createdAt,
                        timings: this.buildOrderTimings(createdAt),
                        status: 'Active',
                        orderCreationFee: fee,
                        tries: 0
                    };

                    // Calculate and add deal metrics
                    orderData = await this.calculateDealMetrics(orderData);
                    
                    // Add to cache
                    this.orderCache.set(orderId.toNumber(), orderData);
                    
                    // Debug logging
                    this.debug('New order added to cache:', {
                        id: orderData.id,
                        maker: orderData.maker,
                        status: orderData.status,
                        timestamp: orderData.timings?.createdAt || 0
                    });
                    
                    // Notify subscribers
                    this.notifySubscribers("OrderCreated", orderData);
                    
                    // Force UI update
                    this.notifySubscribers("ordersUpdated", Array.from(this.orderCache.values()));
                } catch (error) {
                    this.debug('Error in OrderCreated handler:', error);
                    console.error('Failed to process OrderCreated event:', error);
                }
            });

            contract.on("OrderFilled", (...args) => {
                const [orderId] = args;
                const orderIdNum = orderId.toNumber();
                const order = this.orderCache.get(orderIdNum);
                if (order) {
                    order.status = 'Filled';
                    this.orderCache.set(orderIdNum, order);
                    this.debug('Cache updated for filled order:', order);
                    this.notifySubscribers("OrderFilled", order);
                }
            });

            contract.on("OrderCanceled", (orderId, maker, timestamp, event) => {
                const orderIdNum = orderId.toNumber();
                const order = this.orderCache.get(orderIdNum);
                if (order) {
                    order.status = 'Canceled';
                    this.orderCache.set(orderIdNum, order);
                    this.debug('Updated order to Canceled:', orderIdNum);
                    this.notifySubscribers("OrderCanceled", order);
                }
            });

            contract.on("OrderCleanedUp", (orderId) => {
                const orderIdNum = orderId.toNumber();
                if (this.orderCache.has(orderIdNum)) {
                    this.orderCache.delete(orderIdNum);
                    this.debug('Removed cleaned up order:', orderIdNum);
                    this.notifySubscribers("OrderCleanedUp", { id: orderIdNum });
                }
            });
            
            if (this.hasContractEvent(contract, "RetryOrder")) {
                contract.on("RetryOrder", (oldOrderId, newOrderId, maker, tries, timestamp) => {
                    const oldOrderIdNum = oldOrderId.toNumber();
                    const newOrderIdNum = newOrderId.toNumber();
                    
                    const order = this.orderCache.get(oldOrderIdNum);
                    if (order) {
                        const createdAt = timestamp.toNumber();
                        order.id = newOrderIdNum;
                        order.tries = tries.toNumber();
                        order.timestamp = createdAt;
                        order.timings = this.buildOrderTimings(createdAt);
                        
                        this.orderCache.delete(oldOrderIdNum);
                        this.orderCache.set(newOrderIdNum, order);
                        this.debug('Updated retried order:', {oldId: oldOrderIdNum, newId: newOrderIdNum, tries: tries.toString()});
                        this.notifySubscribers("RetryOrder", order);
                    }
                });
            } else {
                this.debug('RetryOrder event not found in ABI, skipping listener registration');
            }
            
            this.debug('Event listeners setup complete');
        } catch (error) {
            this.debug('Error setting up event listeners:', error);
        }
    }

    /**
     * Build Interface for decoding the orders(uint256) response
     */
    static getOrdersInterface() {
        if (!this._ordersInterface) {
            this._ordersInterface = new ethers.utils.Interface([
                'function orders(uint256) view returns (address maker, address taker, address sellToken, uint256 sellAmount, address buyToken, uint256 buyAmount, uint256 timestamp, uint8 status, address feeToken, uint256 orderCreationFee, uint256 tries)'
            ]);
        }
        return this._ordersInterface;
    }

    /**
     * Fetch a contiguous range of orders via Multicall2.
     * Returns an array of decoded order objects (filtered for non-zero maker).
     * If multicall is unavailable, returns null to signal fallback.
     */
    async fetchOrdersViaMulticall(startIndex, endIndex) {
        try {
            if (!isMulticallAvailable()) {
                this.debug('Multicall not available, skipping multicall path');
                return null;
            }

            const iface = WebSocketService.getOrdersInterface();
            const calls = [];
            for (let i = startIndex; i < endIndex; i++) {
                calls.push({
                    target: this.contract.address,
                    callData: iface.encodeFunctionData('orders', [i])
                });
            }

            // Try once, then retry once on failure before falling back
            // Apply a simple timeout wrapper to multicall
            const withTimeout = (p, ms) => Promise.race([
                p,
                new Promise((_, rej) => setTimeout(() => rej(new Error('multicall timeout')), ms))
            ]);

            let results = await withTimeout(multicallTryAggregate(calls, { requireSuccess: false }), 5000);
            if (!results) {
                this.debug('Multicall returned null, retrying once after short delay...');
                await new Promise(r => setTimeout(r, 150));
                try {
                    results = await withTimeout(multicallTryAggregate(calls, { requireSuccess: false }), 5000);
                } catch (_) {
                    results = null;
                }
                if (!results) {
                    this.debug('Multicall retry failed');
                    return null;
                }
            }

            const orders = [];
            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                const orderId = startIndex + i;
                if (!result || result.success !== true) {
                    continue;
                }
                try {
                    const decoded = iface.decodeFunctionResult('orders', result.returnData);
                    const [maker, taker, sellToken, sellAmount, buyToken, buyAmount, timestamp, status, feeToken, orderCreationFee, tries] = decoded;
                    if (maker === ethers.constants.AddressZero) {
                        continue;
                    }
                    orders.push({
                        id: orderId,
                        maker,
                        taker,
                        sellToken,
                        sellAmount,
                        buyToken,
                        buyAmount,
                        timestamp: timestamp.toNumber(),
                        status: ORDER_CONSTANTS.STATUS_MAP[Number(status)],
                        feeToken,
                        orderCreationFee,
                        tries: (tries && tries.toNumber) ? tries.toNumber() : Number(tries)
                    });
                } catch (e) {
                    this.debug(`Failed to decode order ${orderId} from multicall`, e);
                }
            }
            return orders;
        } catch (error) {
            this.debug('fetchOrdersViaMulticall error:', error);
            return null;
        }
    }

    /**
     * Fallback: fetch orders individually with small concurrency.
     */
    async fetchOrdersIndividually(startIndex, endIndex, concurrency = 3) {
        const indices = [];
        for (let i = startIndex; i < endIndex; i++) indices.push(i);
        const results = [];

        let cursor = 0;
        const worker = async () => {
            const iface = WebSocketService.getOrdersInterface();
            while (true) {
                const idx = cursor++;
                if (idx >= indices.length) break;
                const orderId = indices[idx];
                try {
                    const order = await this.contract.orders(orderId);
                    if (order.maker === ethers.constants.AddressZero) {
                        continue;
                    }
                    results.push({
                        id: orderId,
                        maker: order.maker,
                        taker: order.taker,
                        sellToken: order.sellToken,
                        sellAmount: order.sellAmount,
                        buyToken: order.buyToken,
                        buyAmount: order.buyAmount,
                        timestamp: order.timestamp.toNumber(),
                        status: ORDER_CONSTANTS.STATUS_MAP[Number(order.status)],
                        feeToken: order.feeToken,
                        orderCreationFee: order.orderCreationFee,
                        tries: (order.tries && order.tries.toNumber) ? order.tries.toNumber() : Number(order.tries)
                    });
                } catch (e) {
                    this.debug(`Failed to read order ${orderId} via fallback`, e);
                }
            }
        };

        const workers = Array.from({ length: Math.min(concurrency, indices.length) }, () => worker());
        await Promise.all(workers);
        // Keep results sorted by id
        results.sort((a, b) => a.id - b.id);
        return results;
    }

    /**
     * High-level helper: fetch orders in batches using multicall with fallback.
     * Returns an array of decoded orders (without timing expansion).
     */
    async fetchOrdersBatched(totalOrders, batchSize = 50) {
        const all = [];
        if (!this.contract) {
            throw new Error('Contract not initialized. Call initialize() first.');
        }
        const totalBatches = Math.ceil(totalOrders / batchSize);
        this.debug(`Batched order fetch: ${totalOrders} orders in ${totalBatches} batches of ${batchSize}`);
        let fetchedSoFar = 0;

        for (let batch = 0; batch < totalBatches; batch++) {
            const startIndex = batch * batchSize;
            const endIndex = Math.min(startIndex + batchSize, totalOrders);
            this.debug(`Fetching batch ${batch + 1}/${totalBatches} (orders ${startIndex}-${endIndex - 1})`);
            let batchOrders = await this.fetchOrdersViaMulticall(startIndex, endIndex);
            if (!batchOrders) {
                batchOrders = await this.fetchOrdersIndividually(startIndex, endIndex, 3);
            }
            all.push(...batchOrders);
            fetchedSoFar += batchOrders.length;
            // Emit progress for UI consumers
            try {
                this.notifySubscribers('orderSyncProgress', {
                    fetched: fetchedSoFar,
                    total: totalOrders,
                    batch: batch + 1,
                    totalBatches
                });
            } catch (_) {}
            if (batch < totalBatches - 1) {
                // Short delay between batches
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
        this.debug(`Batched order fetch complete: ${all.length} orders retrieved`);
        return all;
    }

    cleanup() {
        try {
            this.debug('Cleaning up WebSocket service...');
            
            // Remove provider event listeners
            if (this.provider) {
                this.provider.removeAllListeners("block");
            }
            
            // Remove contract event listeners
            if (this.contract) {
                this.contract.removeAllListeners("OrderCreated");
                this.contract.removeAllListeners("OrderFilled");
                this.contract.removeAllListeners("OrderCanceled");
                this.contract.removeAllListeners("OrderCleanedUp");
                if (this.hasContractEvent(this.contract, "RetryOrder")) {
                    this.contract.removeAllListeners("RetryOrder");
                }
            }
            
            // Clear cache
            this.orderCache.clear();
            this.lastKnownChainTimestamp = null;
            this.lastKnownChainBlock = null;
            this.chainTimeSyncedAtMonotonicMs = null;
            this.chainTimeSyncPromise = null;
            
            this.debug('WebSocket service cleanup complete');
        } catch (error) {
            this.debug('Error during cleanup:', error);
        }
    }

        async syncAllOrders() {
        this.debug('Starting order sync with existing contract...');
        
        if (!this.contract) {
            throw new Error('Contract not initialized. Call initialize() first.');
        }
        try {
            this.debug('Starting order sync with contract:', this.contract.address);
            await this.syncChainTime();
            
            let nextOrderId = 0;
            try {
                nextOrderId = await this.contract.nextOrderId();
                this.debug('nextOrderId result:', nextOrderId.toString());
            } catch (error) {
                this.debug('nextOrderId call failed, using default value:', error);
            }

            // Clear existing cache before sync
            this.orderCache.clear();

            // Use optimized batched fetch (multicall with fallback)
            const fetchedOrders = await this.fetchOrdersBatched(Number(nextOrderId), 50);

            // Enrich with timings and populate cache
            for (const o of fetchedOrders) {
                const orderData = {
                    ...o,
                    timings: this.buildOrderTimings(o.timestamp)
                };
                // Calculate deal metrics for the order
                try {
                    const enrichedOrderData = await this.calculateDealMetrics(orderData);
                    this.orderCache.set(o.id, enrichedOrderData);
                    this.debug('Added order to cache with deal metrics:', enrichedOrderData);
                } catch (error) {
                    this.debug('Failed to calculate deal metrics for order', o.id, ':', error);
                    // Still add the order without deal metrics as fallback
                    this.orderCache.set(o.id, orderData);
                    this.debug('Added order to cache without deal metrics:', orderData);
                }
            }

            // Validate and summarize order cache
            try {
                this.validateOrderCache();
            } catch (_) {}

            this.debug('Order sync complete. Cache size:', this.orderCache.size);
            this.notifySubscribers('orderSyncComplete', Object.fromEntries(this.orderCache));
            this.debug('Setting up event listeners...');
            await this.setupEventListeners(this.contract);

        } catch (error) {
            this.debug('Order sync failed:', error);
            this.orderCache.clear();
            this.notifySubscribers('orderSyncComplete', {});
        }
    }

    // Basic validation and summary for testing/diagnostics
    validateOrderCache() {
        const orders = Array.from(this.orderCache.values());
        const summary = orders.reduce((acc, o) => {
            const s = o.status || 'Unknown';
            acc[s] = (acc[s] || 0) + 1;
            return acc;
        }, {});
        this.debug('Order cache validation:', {
            total: orders.length,
            byStatus: summary
        });
        // Spot-check required fields on a few entries
        for (let i = 0; i < Math.min(3, orders.length); i++) {
            const o = orders[i];
            if (!o.maker || !o.sellToken || !o.buyToken) {
                this.warn('Order missing critical fields:', o.id);
            }
        }
    }

    getOrders(filterStatus = null) {
        try {
            this.debug('Getting orders with filter:', filterStatus);
            const orders = Array.from(this.orderCache.values());
            
            // Add detailed logging of order cache
            this.debug('Current order cache:', {
                size: this.orderCache.size,
                orderStatuses: orders.map(o => ({
                    id: o.id,
                    status: o.status,
                    timestamp: o.timestamp
                }))
            });
            
            if (filterStatus) {
                return orders.filter(order => order.status === filterStatus);
            }
            
            return orders;
        } catch (error) {
            this.debug('Error getting orders:', error);
            return [];
        }
    }

    subscribe(eventName, callback) {
        if (!this.subscribers.has(eventName)) {
            this.subscribers.set(eventName, new Set());
        }
        this.subscribers.get(eventName).add(callback);
    }

    unsubscribe(eventName, callback) {
        if (this.subscribers.has(eventName)) {
            this.subscribers.get(eventName).delete(callback);
        }
    }

    // Example method to listen to contract events
    listenToContractEvents(contract, eventName) {
        if (!this.provider) {
            throw new Error('WebSocket not initialized');
        }

        contract.on(eventName, (...args) => {
            const event = args[args.length - 1]; // Last argument is the event object
            const subscribers = this.subscribers.get(eventName);
            if (subscribers) {
                subscribers.forEach(callback => callback(event));
            }
        });
    }

    updateOrderCache(orderId, orderData) {
        this.orderCache.set(orderId, orderData);
    }

    removeOrder(orderId) {
        this.orderCache.delete(orderId);
    }

    removeOrders(orderIds) {
        if (!Array.isArray(orderIds)) {
            console.warn('[WebSocket] removeOrders called with non-array:', orderIds);
            return;
        }
        
        this.debug('Removing orders:', orderIds);
        orderIds.forEach(orderId => {
            this.orderCache.delete(orderId);
        });
        
        // Notify subscribers of the update
        this.notifySubscribers('ordersUpdated', this.getOrders());
    }

    notifySubscribers(eventName, data) {
        this.debug('Notifying subscribers for event:', eventName);
        const subscribers = this.subscribers.get(eventName);
        if (subscribers) {
            this.debug('Found', subscribers.size, 'subscribers');
            subscribers.forEach(callback => {
                try {
                    this.debug('Calling subscriber callback');
                    callback(data);
                    this.debug('Subscriber callback completed');
                } catch (error) {
                    this.debug('Error in subscriber callback:', error);
                }
            });
        } else {
            this.debug('No subscribers found for event:', eventName);
        }
    }

    isOrderExpired(order) {
        try {
            const expiryTime = this.getOrderExpiryTime(order);
            return this.isPastTimestamp(expiryTime);
        } catch (error) {
            this.debug('Error checking order expiry:', error);
            return false;
        }
    }

    getOrderExpiryTime(order) {
        const expiresAt = Number(order?.timings?.expiresAt);
        if (Number.isFinite(expiresAt)) {
            return expiresAt;
        }

        const createdAt = Number(order?.timestamp);
        if (Number.isFinite(createdAt)) {
            return this.buildOrderTimings(createdAt).expiresAt;
        }

        return null;
    }

    //TODO: calculate deal metric based on buy value / sell value where buy value is the amount of buy tokens * token price and sell value is the amount of sell tokens * token price
    async calculateDealMetrics(orderData) {
        const buyTokenInfo = await this.getTokenInfo(orderData.buyToken); // person who created order set this
        const sellTokenInfo = await this.getTokenInfo(orderData.sellToken);// person who created order set this
        const pricing = this.pricingService;
        if (!pricing) {
            this.debug('PricingService not available for deal calculation');
            return orderData;
        }
        const buyTokenUsdPrice = pricing.getPrice(orderData.buyToken);
        const sellTokenUsdPrice = pricing.getPrice(orderData.sellToken);
        if (buyTokenUsdPrice === undefined || sellTokenUsdPrice === undefined || buyTokenUsdPrice === 0 || sellTokenUsdPrice === 0) {
            this.debug('Missing price data, skipping deal calculation for order:', orderData.id);
            return orderData;
        }
        const buyValue = Number(orderData.buyAmount) * buyTokenUsdPrice;
        const sellValue = Number(orderData.sellAmount) * sellTokenUsdPrice;
        const deal = buyValue / sellValue;
        return {
            ...orderData,
            dealMetrics: {
                deal
            }
        };
    }

    async getTokenInfo(tokenAddress) {
        try {
            // Normalize address to lowercase for consistent comparison
            const normalizedAddress = tokenAddress.toLowerCase();

            // 1. First check cache
            if (this.tokenCache.has(normalizedAddress)) {
                this.debug('Token info found in cache:', normalizedAddress);
                return this.tokenCache.get(normalizedAddress);
            }

            // 2. Fetch from contract using queueRequest
            this.debug('Fetching token info from contract:', normalizedAddress);
            return await this.queueRequest(async () => {
                const contract = new ethers.Contract(tokenAddress, erc20Abi, this.provider);
                const [symbol, decimals, name] = await Promise.all([
                    contract.symbol(),
                    contract.decimals(),
                    contract.name()
                ]);

                // Get icon URL for the token
                let iconUrl = null;
                try {
                    const chainId = Number.parseInt(getNetworkConfig().chainId, 16) || 137;
                    iconUrl = await tokenIconService.getIconUrl(tokenAddress, chainId);
                } catch (err) {
                    this.debug(`Failed to get icon for token ${tokenAddress}:`, err);
                }

                const tokenInfo = {
                    address: normalizedAddress,
                    symbol,
                    decimals: Number(decimals),
                    name,
                    iconUrl: iconUrl
                };

                // Cache the result
                this.tokenCache.set(normalizedAddress, tokenInfo);
                this.debug('Added token to cache:', tokenInfo);

                return tokenInfo;
            });

        } catch (error) {
            this.debug('Error getting token info:', error);
            // Return a basic fallback object
            const fallback = {
                address: tokenAddress.toLowerCase(),
                symbol: `${tokenAddress.slice(0, 4)}...${tokenAddress.slice(-4)}`,
                decimals: 18,
                name: 'Unknown Token'
            };
            this.tokenCache.set(tokenAddress.toLowerCase(), fallback);
            return fallback;
        }
    }

    // Update all deals when prices change
    // Will be used with refresh button in the UI 
    async updateAllDeals() {
        const pricing = this.pricingService;
        if (!pricing) {
            this.debug('Cannot update deals: PricingService not available');
            return;
        }

        this.debug('Updating deal metrics for all orders...');
        for (const [orderId, order] of this.orderCache.entries()) {
            try {
                const updatedOrder = await this.calculateDealMetrics(order);
                this.orderCache.set(orderId, updatedOrder);
            } catch (error) {
                this.debug('Error updating deal metrics for order:', orderId, error);
            }
        }

        // Notify subscribers about the updates
        this.notifySubscribers("ordersUpdated", Array.from(this.orderCache.values()));
    }

    // Check if an order can be filled by the current account
    // Use this to determine to provide a fill button in the UI
    canFillOrder(order, currentAccount) {
        if (order.status !== 'Active') return false;
        if (this.isPastTimestamp(this.getOrderExpiryTime(order))) return false;
        if (order.maker?.toLowerCase() === currentAccount?.toLowerCase()) return false;
        return order.taker === ethers.constants.AddressZero || 
               order.taker?.toLowerCase() === currentAccount?.toLowerCase();
    }

    // Check if an order can be canceled by the current account
    // Use this to determine to provide a cancel button in the UI
    canCancelOrder(order, currentAccount) {
        if (order.status !== 'Active') return false;
        if (this.isPastTimestamp(this.getOrderGraceEndTime(order))) return false;
        return order.maker?.toLowerCase() === currentAccount?.toLowerCase();
    }

    // Get the status of an order
    // Use this to determine to provide a fill button in the UI
    getOrderStatus(order) {
        // Check explicit status first
        if (order.status === 'Canceled') return 'Canceled';
        if (order.status === 'Filled') return 'Filled';

        // Then check timing using cached timings
        const currentTime = this.getCurrentTimestamp();
        const expiresAt = this.getOrderExpiryTime(order);
        const graceEndsAt = this.getOrderGraceEndTime(order);

        this.debug(`Checking order ${order.id} status: currentTime=${currentTime}, expiresAt=${expiresAt}, graceEndsAt=${graceEndsAt}`);

        if (this.isPastTimestamp(graceEndsAt)) {
            this.debug(`Order ${order.id} status: Expired (past grace period)`);
            return 'Expired';
        }
        if (this.isPastTimestamp(expiresAt)) {
            this.debug(`Order ${order.id} status: Expired (past expiry time)`);
            return 'Expired';
        }

        this.debug(`Order ${order.id} status: Active`);
        return 'Active';
    }

    // Reconnect method for handling WebSocket disconnections
    async reconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.debug('Max reconnection attempts reached');
            return false;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        this.debug(`Reconnecting in ${delay}ms... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        // Clean up existing connection
        if (this.provider) {
            try {
                this.provider.removeAllListeners();
                if (this.provider._websocket) {
                    this.provider._websocket.close();
                }
            } catch (error) {
                this.debug('Error cleaning up old connection:', error);
            }
        }

        // Reset state
        this.isInitialized = false;
        this.provider = null;
        this.contract = null;
        this.initializationPromise = null;
        this.lastKnownChainTimestamp = null;
        this.lastKnownChainBlock = null;
        this.chainTimeSyncedAtMonotonicMs = null;
        this.chainTimeSyncPromise = null;

        await new Promise(resolve => setTimeout(resolve, delay));
        return this.initialize();
    }
}
