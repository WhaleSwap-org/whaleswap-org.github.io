export const DEBUG_CONFIG = {
    APP: false,
    WEBSOCKET: true, // Enable to debug status calculation
    WALLET: false,
    VIEW_ORDERS: true, // Enable to debug status updates
    CREATE_ORDER: false,
    MY_ORDERS: false,
    TAKER_ORDERS: false,
    CLEANUP_ORDERS: false,
    WALLET_UI: false,
    BASE_COMPONENT: false,
    PRICING: false,
    TOKENS: false,
    TOKEN_ICON_SERVICE: false, // Add token icon service debugging
    TOAST: false, // Enable toast debugging for testing
    PRICING_DEFAULT_TO_ONE: false, // Default missing prices to 1 for testing, false for production
    LIBERDUS_VALIDATION: true, // Enable frontend Liberdus token validation
    ADMIN_BYPASS_OWNER_CHECK: false, // Temporary: bypass owner gating for Admin tab access
    // Add more specific flags as needed
};

export const isDebugEnabled = (component) => {
    // Check if debug mode is forced via localStorage
    const localDebug = localStorage.getItem('debug');
    if (localDebug) {
        const debugSettings = JSON.parse(localDebug);
        return debugSettings[component] ?? DEBUG_CONFIG[component];
    }
    return DEBUG_CONFIG[component];
};
