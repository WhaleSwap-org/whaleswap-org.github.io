import { TOKEN_ICON_CONFIG } from '../config/index.js';
import { createLogger } from '../services/LogService.js';

// Initialize logger
const logger = createLogger('TOKEN_ICONS');
const debug = logger.debug.bind(logger);
const error = logger.error.bind(logger);
const warn = logger.warn.bind(logger);

/**
 * Validate if an icon URL exists and is accessible
 * @param {string} iconUrl - Icon URL to validate
 * @returns {Promise<boolean>} True if icon exists
 */
export async function validateIconUrl(iconUrl) {
    if (!iconUrl) {
        debug('No icon URL provided for validation');
        return false;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TOKEN_ICON_CONFIG.VALIDATION_TIMEOUT);

        const response = await fetch(iconUrl, {
            method: 'HEAD',
            mode: 'no-cors', // Handle CORS issues
            signal: controller.signal
        });

        clearTimeout(timeoutId);
        
        // For no-cors requests, we can't check status, so assume it exists
        // In a production environment, you might want to use a proxy or different approach
        debug('Icon URL validation successful:', iconUrl);
        return true;
    } catch (err) {
        if (err.name === 'AbortError') {
            debug('Icon URL validation timed out:', iconUrl);
        } else {
            debug('Icon URL validation failed:', iconUrl, err);
        }
        return false;
    }
}

/**
 * Get fallback icon data for tokens without icons
 * @param {string} tokenAddress - Token contract address
 * @param {string} symbol - Token symbol (optional)
 * @returns {Object} Fallback icon data
 */
export function getFallbackIconData(tokenAddress, symbol = null) {
    try {
        if (!tokenAddress) {
            return {
                type: 'fallback',
                backgroundColor: TOKEN_ICON_CONFIG.FALLBACK_COLORS[0],
                text: '?'
            };
        }

        const normalizedAddress = tokenAddress.toLowerCase();
        const symbolText = symbol ? symbol.charAt(0).toUpperCase() : '?';
        
        // Generate consistent color based on address
        const colorIndex = parseInt(normalizedAddress.slice(-6), 16) % TOKEN_ICON_CONFIG.FALLBACK_COLORS.length;
        const backgroundColor = TOKEN_ICON_CONFIG.FALLBACK_COLORS[colorIndex];

        return {
            type: 'fallback',
            backgroundColor,
            text: symbolText
        };
    } catch (err) {
        error('Error generating fallback icon data:', err);
        return {
            type: 'fallback',
            backgroundColor: TOKEN_ICON_CONFIG.FALLBACK_COLORS[0],
            text: '?'
        };
    }
}

/**
 * Generate HTML for a token icon with fallback support
 * @param {string} iconUrl - Icon URL (can be 'fallback' for fallback icons)
 * @param {string} symbol - Token symbol
 * @param {string} address - Token address
 * @param {string} size - Icon size ('normal', 'small', 'large')
 * @returns {string} HTML string for the token icon
 */
export function generateTokenIconHTML(iconUrl, symbol, address, size = 'normal') {
    try {
        const sizeClass = size !== 'normal' ? ` ${size}` : '';
        
        if (iconUrl && iconUrl !== 'fallback') {
            // Use actual icon URL
            return `
                <div class="token-icon${sizeClass}">
                    <img src="${iconUrl}" alt="${symbol}" class="token-icon-image" 
                         onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                    ${generateFallbackIconHTML(symbol, address, size, true)}
                </div>
            `;
        } else {
            // Use fallback icon
            return `
                <div class="token-icon${sizeClass}">
                    ${generateFallbackIconHTML(symbol, address, size, false)}
                </div>
            `;
        }
    } catch (err) {
        error('Error generating token icon HTML:', err);
        return generateFallbackIconHTML(symbol, address, size);
    }
}

/**
 * Generate HTML for fallback icon
 * @param {string} symbol - Token symbol
 * @param {string} address - Token address
 * @param {string} size - Icon size
 * @returns {string} HTML string for fallback icon
 */
function generateFallbackIconHTML(symbol, address, size, forceHidden = false) {
    const fallbackData = getFallbackIconData(address, symbol);
    const sizeClass = size !== 'normal' ? ` ${size}` : '';
    const displayStyle = forceHidden ? 'display: none; ' : '';
    
    return `
        <div class="token-icon-fallback${sizeClass}" style="${displayStyle}background: ${fallbackData.backgroundColor}">
            ${fallbackData.text}
        </div>
    `;
}

/**
 * Preload an icon image
 * @param {string} iconUrl - Icon URL to preload
 * @returns {Promise<boolean>} True if preload successful
 */
export function preloadIcon(iconUrl) {
    return new Promise((resolve) => {
        if (!iconUrl || iconUrl === 'fallback') {
            resolve(false);
            return;
        }

        const img = new Image();
        img.onload = () => {
            debug('Icon preloaded successfully:', iconUrl);
            resolve(true);
        };
        img.onerror = () => {
            debug('Icon preload failed:', iconUrl);
            resolve(false);
        };
        img.src = iconUrl;
    });
}

/**
 * Preload multiple icons
 * @param {Array} iconUrls - Array of icon URLs to preload
 * @returns {Promise<Array>} Array of preload results
 */
export async function preloadIcons(iconUrls) {
    const preloadPromises = iconUrls.map(url => preloadIcon(url));
    return Promise.allSettled(preloadPromises);
}

/**
 * Get icon size class based on context
 * @param {string} context - Context where icon will be used
 * @returns {string} Size class
 */
export function getIconSizeClass(context) {
    const sizeMap = {
        'table': 'small',
        'modal': 'normal',
        'header': 'large',
        'list': 'normal',
        'dropdown': 'small'
    };
    
    return sizeMap[context] || 'normal';
}

/**
 * Sanitize token address for URL generation
 * @param {string} address - Token address
 * @returns {string} Sanitized address
 */
export function sanitizeTokenAddress(address) {
    if (!address) return '';
    
    // Remove 0x prefix and convert to lowercase
    const cleanAddress = address.replace(/^0x/, '').toLowerCase();
    
    // Validate it's a valid hex address
    if (!/^[0-9a-f]{40}$/.test(cleanAddress)) {
        warn('Invalid token address format:', address);
        return '';
    }
    
    return cleanAddress;
}

/**
 * Get token address -> CoinGecko ID map used for price fallback.
 * @returns {Object} Token address to CoinGecko ID mapping
 */
export function getCoinGeckoPriceIds() {
    return TOKEN_ICON_CONFIG.COINGECKO_PRICE_IDS;
}
