/**
 * AppContext - Centralized dependency container for the application
 * 
 * Provides a single point of access for all shared services, replacing
 * scattered window.* globals with a structured, testable interface.
 * 
 * Usage:
 *   // In app.js, create and populate the context:
 *   const ctx = createAppContext();
 *   ctx.wallet = walletManager;
 *   ctx.ws = webSocketService;
 *   // ...
 * 
 *   // Pass to components:
 *   component.setContext(ctx);
 * 
 *   // In components, access via this.ctx:
 *   const account = this.ctx.wallet.getAccount();
 *   const orders = this.ctx.ws.getOrders();
 */

/**
 * @typedef {Object} AppContext
 * @property {Object} wallet - WalletManager instance
 * @property {Object} ws - WebSocketService instance  
 * @property {Object} pricing - PricingService instance
 * @property {Object} toast - Toast functions (showError, showSuccess, etc.)
 * @property {Object} contractService - ContractService instance
 */

/**
 * Creates a new AppContext with null/undefined values
 * Values are populated by App during initialization
 * @returns {AppContext}
 */
export function createAppContext() {
    return {
        // Core services (set by App during load)
        wallet: null,
        ws: null,
        pricing: null,
        contractService: null,
        selectedChainSlug: null,
        walletChainId: null,
        
        // Toast functions
        toast: {
            showError: null,
            showSuccess: null,
            showWarning: null,
            showInfo: null,
        },
        
        /**
         * Check if context is fully initialized
         * @returns {boolean}
         */
        isReady() {
            return !!(this.wallet && this.ws);
        },
        
        /**
         * Get wallet manager
         * @returns {Object|null}
         */
        getWallet() {
            return this.wallet;
        },
        
        /**
         * Get WebSocket service
         * @returns {Object|null}
         */
        getWebSocket() {
            return this.ws;
        },
        
        /**
         * Get pricing service
         * @returns {Object|null}
         */
        getPricing() {
            return this.pricing;
        },

        /**
         * Set currently selected chain slug (URL/UI intent)
         * @param {string|null} slug
         */
        setSelectedChainSlug(slug) {
            this.selectedChainSlug = slug ? String(slug).toLowerCase() : null;
        },

        /**
         * Get currently selected chain slug (URL/UI intent)
         * @returns {string|null}
         */
        getSelectedChainSlug() {
            return this.selectedChainSlug;
        },

        /**
         * Set wallet runtime chain ID (provider-reported)
         * @param {string|number|null} chainId
         */
        setWalletChainId(chainId) {
            this.walletChainId = chainId ?? null;
        },

        /**
         * Get wallet runtime chain ID
         * @returns {string|number|null}
         */
        getWalletChainId() {
            return this.walletChainId;
        },
        
        /**
         * Show error toast
         * @param {string} message
         * @param {number} duration
         */
        showError(message, duration = 0) {
            const fn = this.toast.showError;
            if (fn) return fn(message, duration);
            console.error('[AppContext] showError:', message);
        },
        
        /**
         * Show success toast
         * @param {string} message
         * @param {number} duration
         */
        showSuccess(message, duration = 5000) {
            const fn = this.toast.showSuccess;
            if (fn) return fn(message, duration);
            console.log('[AppContext] showSuccess:', message);
        },
        
        /**
         * Show warning toast
         * @param {string} message
         * @param {number} duration
         */
        showWarning(message, duration = 5000) {
            const fn = this.toast.showWarning;
            if (fn) return fn(message, duration);
            console.warn('[AppContext] showWarning:', message);
        },
        
        /**
         * Show info toast
         * @param {string} message
         * @param {number} duration
         */
        showInfo(message, duration = 5000) {
            const fn = this.toast.showInfo;
            if (fn) return fn(message, duration);
            console.log('[AppContext] showInfo:', message);
        }
    };
}

/**
 * Global context instance
 * Components can import this directly, but prefer receiving context via setContext()
 */
let globalContext = null;

/**
 * Get or create the global context instance
 * @returns {AppContext}
 */
export function getAppContext() {
    if (!globalContext) {
        globalContext = createAppContext();
    }
    return globalContext;
}

/**
 * Set the global context instance (called by App during initialization)
 * @param {AppContext} ctx
 */
export function setGlobalContext(ctx) {
    globalContext = ctx;
    // Also expose on window for debugging
    window.appContext = ctx;
}
