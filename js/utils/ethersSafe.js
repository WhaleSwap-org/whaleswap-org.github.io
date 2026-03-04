import { ethers } from 'ethers';

export function safeGetAddress(address, fallback = null) {
    try {
        return ethers.utils.getAddress(address);
    } catch (_) {
        return fallback;
    }
}

export function safeBigNumberFrom(value, fallback = 0) {
    try {
        return ethers.BigNumber.from(value ?? 0);
    } catch (_) {
        try {
            return ethers.BigNumber.from(fallback ?? 0);
        } catch (_) {
            return ethers.BigNumber.from(0);
        }
    }
}

export function safeFormatUnits(value, decimals = 18, fallback = '0') {
    try {
        return ethers.utils.formatUnits(value, decimals);
    } catch (_) {
        return String(fallback);
    }
}
