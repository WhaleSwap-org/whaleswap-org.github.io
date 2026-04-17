// Log toggles (default ON). The Debug Panel (Ctrl+Shift+D) persists
// per-browser overrides in localStorage under `whaleswap_debug`, so if
// you previously saved an override for any of these, it will take
// precedence over the defaults below. Clear that key or hit "Select
// all" + "Apply" in the panel to reset.
//
// NOTE: entries below that end in a comment like `// feature flag`
// are NOT loggers - they change application behavior and should be
// left false unless you know what you are doing.
export const DEBUG_CONFIG = {
    APP: true,
    WEBSOCKET: true,
    WALLET: true,
    WALLET_UI: true,
    BASE_COMPONENT: true,
    VIEW_ORDERS: true,
    CREATE_ORDER: true,
    MY_ORDERS: true,
    TAKER_ORDERS: true,
    CLEANUP: true,
    CLAIM: true,
    ADMIN: true,
    CONTRACT_SERVICE: true,
    CONTRACT_PARAMS: true,
    CONTRACT_TOKENS: true,
    ORDERS_HELPER: true,
    ORDERS_RENDERER: true,
    MULTICALL: true,
    TOKEN_METADATA_CACHE: true,
    TOKEN_ICON_SERVICE: true,
    TOKEN_ICONS: true,
    BALANCE_VALIDATION: true,
    PRICING: true,
    TOKENS: true,
    TOAST: true,
    VersionService: true,

    // --- feature flags (NOT log toggles) --------------------------------
    PRICING_DEFAULT_TO_ONE: false, // feature flag: default missing prices to 1 (test-only)
    ADMIN_BYPASS_OWNER_CHECK: false, // feature flag: bypass owner gating for Admin tab
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
