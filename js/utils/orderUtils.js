import { ethers } from 'ethers';
import { getNetworkConfig } from '../config/networks.js';

/**
 * Utility functions for order-related formatting and display
 */

/**
 * Format an Ethereum address to shortened form (0x1234...5678)
 * @param {string} address - Ethereum address
 * @returns {string} Formatted address
 */
export function formatAddress(address) {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Format a Unix timestamp to a readable date string
 * @param {number|string} timestamp - Unix timestamp in seconds
 * @returns {string} Formatted date string (e.g., "12/25 3:45 PM")
 */
export function formatTimestamp(timestamp) {
    if (!timestamp) return '';
    const date = new Date(Number(timestamp) * 1000);
    return date.toLocaleDateString('en-US', {
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}

/**
 * Format a time difference in seconds to a human-readable string
 * @param {number} seconds - Time difference in seconds
 * @returns {string} Formatted time string (e.g., "2D 5H 30M", "3H 15M", "45M")
 */
export function formatTimeDiff(seconds) {
    if (seconds <= 0) return 'Expired';
    
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) {
        return `${days}D ${hours}H ${minutes}M`;
    } else if (hours > 0) {
        return `${hours}H ${minutes}M`;
    } else {
        return `${minutes}M`;
    }
}

/**
 * Get the blockchain explorer URL for an address
 * @param {string} address - Ethereum address
 * @returns {string} Explorer URL or '#' if not configured
 */
export function getExplorerUrl(address) {
    if (!address) return '#';
    
    const networkConfig = getNetworkConfig();
    if (!networkConfig?.explorer) {
        console.warn('[orderUtils] Explorer URL not configured');
        return '#';
    }
    return `${networkConfig.explorer}/address/${ethers.utils.getAddress(address)}`;
}

/**
 * Get human-readable text for order status
 * @param {number} status - Order status code (0=Active, 1=Filled, 2=Cancelled)
 * @returns {string} Status text
 */
export function getOrderStatusText(status) {
    const statusMap = {
        0: 'Active',
        1: 'Filled',
        2: 'Cancelled'
        // Note: Status 3 (Expired) removed - we keep showing 'Active' for expired orders
    };
    return statusMap[status] || `Unknown (${status})`;
}

/**
 * Format a USD price with appropriate precision
 * @param {number|undefined|null} price - USD price
 * @returns {string} Formatted price string (e.g., "$100", "$45.23", "$0.1234") or empty string
 */
export function formatUsdPrice(price) {
    if (price === undefined || price === null || price === 0) return '';
    if (price >= 100) return `$${price.toFixed(0)}`;
    if (price >= 1) return `$${price.toFixed(2)}`;
    return `$${price.toFixed(4)}`;
}

/**
 * Calculate and format total USD value (price × amount)
 * @param {number|undefined|null} price - USD price per unit
 * @param {string|number} amount - Token amount
 * @returns {string} Formatted total value (e.g., "$150.50") or "N/A" if invalid
 */
export function calculateTotalValue(price, amount) {
    if (price === undefined || price === null || price === 0 || !amount) return 'N/A';
    const total = price * parseFloat(amount);
    if (isNaN(total) || total === 0) return 'N/A';
    if (total >= 100) return `$${total.toFixed(0)}`;
    if (total >= 1) return `$${total.toFixed(2)}`;
    return `$${total.toFixed(4)}`;
}

/**
 * Format deal ratio with up to 6 decimal places, trimming trailing zeros.
 * @param {number|undefined|null} deal - Deal ratio value
 * @returns {string} Formatted deal value or "N/A" if invalid
 */
export function formatDealValue(deal) {
    if (deal === undefined || deal === null || !Number.isFinite(Number(deal))) return 'N/A';

    const normalized = Number(deal);
    const fixed = normalized.toFixed(6);
    return fixed.replace(/\.?0+$/, '');
}
