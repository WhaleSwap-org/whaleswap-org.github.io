export const APP_BRAND = 'WhaleSwap';
export const APP_LOGO = 'img/whaleSwap.png';

// Centralized order-related constants
export const ORDER_CONSTANTS = {
    STATUS_MAP: ['Active', 'Filled', 'Canceled'],
    DEFAULT_ORDER_EXPIRY_SECS: 7 * 24 * 60 * 60, // 7 days
    DEFAULT_GRACE_PERIOD_SECS: 7 * 24 * 60 * 60 // 7 days
};

// Token Icon Service Configuration
export const TOKEN_ICON_CONFIG = {
    // CoinGecko API configuration
    COINGECKO_API_BASE: 'https://api.coingecko.com/api/v3',
    COINGECKO_ICON_BASE: 'https://assets.coingecko.com/coins/images',
    
    // Token address -> CoinGecko ID map for price fallback
    COINGECKO_PRICE_IDS: {
        "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": "usd-coin", // Polygon USDC
        "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6": "wrapped-bitcoin", // Polygon WBTC
        "0x0000000000000000000000000000000000001010": "polygon-ecosystem-token", // Polygon native POL
        "0x3ba4c387f786bfee076a58914f5bd38d668b42c3": "binancecoin", // Polygon BNB (PoS)
        "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39": "chainlink", // Polygon LINK
        "0xb0897686c545045afc77cf20ec7a532e3120e0f1": "chainlink", // Polygon LINK legacy bridge
        "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "usd-coin", // BNB USDC
        "0x0555e30da8f98308edb960aa94c0db47230d2b9c": "wrapped-bitcoin", // BNB WBTC
        "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": "weth", // WETH
        "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": "matic-network", // WMATIC
    },
    
    // Local token logo management
    // Runtime icon lookup probes `img/token-logos/{token-address}.{ext}`.
    // Bump LOCAL_ICON_VERSION when replacing existing logo files to invalidate browser cache.
    LOCAL_ICON_VERSION: '2026-02-19',
    
    // Icon validation configuration
    VALIDATION_TIMEOUT: 5000, // 5 seconds timeout for icon validation
    
    // Fallback configuration
    ENABLE_FALLBACK_ICONS: true, // Enable color-based fallback icons
    FALLBACK_COLORS: [
        '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', 
        '#FFEEAD', '#D4A5A5', '#9B59B6', '#3498DB'
    ]
};
