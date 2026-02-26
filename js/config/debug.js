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
    ADMIN_BYPASS_OWNER_CHECK: false, // Temporary: bypass owner gating for Admin tab access
    // Add more specific flags as needed
};

export const DEBUG_STORAGE_KEY = 'whaleswap_debug';

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const parseDebugSettings = (rawValue) => {
    if (!rawValue || typeof rawValue !== 'string') {
        return null;
    }

    try {
        const parsed = JSON.parse(rawValue);
        return isPlainObject(parsed) ? parsed : null;
    } catch (_) {
        return null;
    }
};

export const getStoredDebugSettings = () => {
    return parseDebugSettings(localStorage.getItem(DEBUG_STORAGE_KEY)) || {};
};

export const saveDebugSettings = (settings) => {
    if (!isPlainObject(settings)) {
        return;
    }

    localStorage.setItem(DEBUG_STORAGE_KEY, JSON.stringify(settings));
};

export const isDebugEnabled = (component) => {
    const debugSettings = getStoredDebugSettings();
    if (Object.prototype.hasOwnProperty.call(debugSettings, component)) {
        return debugSettings[component];
    }

    return DEBUG_CONFIG[component];
};
