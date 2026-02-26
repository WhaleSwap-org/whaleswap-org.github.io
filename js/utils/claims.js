import { ethers } from 'ethers';

const CLAIMABLE_CHECK_CONCURRENCY = 4;

function hasClaimAbi(contract) {
    return !!contract
        && typeof contract.getClaimableTokens === 'function'
        && typeof contract.claimable === 'function';
}

function normalizeAddress(address) {
    try {
        return ethers.utils.getAddress(address);
    } catch (_) {
        return null;
    }
}

function toBigNumber(value) {
    try {
        return ethers.BigNumber.from(value ?? 0);
    } catch (_) {
        return ethers.BigNumber.from(0);
    }
}

function formatUnits(value, decimals = 18) {
    try {
        return ethers.utils.formatUnits(value, decimals);
    } catch (_) {
        return '0';
    }
}

async function getTokenMetadata(ws, tokenAddress) {
    const fallbackSymbol = `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`;
    const fallback = {
        symbol: fallbackSymbol,
        name: fallbackSymbol,
        decimals: 18,
        iconUrl: 'fallback'
    };

    if (!ws || typeof ws.getTokenInfo !== 'function') {
        return fallback;
    }

    try {
        const info = await ws.getTokenInfo(tokenAddress);
        if (!info) return fallback;

        const decimals = Number.isInteger(info.decimals) ? info.decimals : 18;
        return {
            symbol: info.symbol || fallbackSymbol,
            name: info.name || info.symbol || fallbackSymbol,
            decimals,
            iconUrl: info.iconUrl || 'fallback'
        };
    } catch (_) {
        return fallback;
    }
}

export async function getClaimableSnapshot({
    contract,
    ws = null,
    userAddress,
    includeMetadata = false
}) {
    const normalizedUser = normalizeAddress(userAddress);
    if (!normalizedUser || !hasClaimAbi(contract)) {
        return [];
    }

    const tokens = await contract.getClaimableTokens(normalizedUser);
    if (!Array.isArray(tokens)) {
        throw new Error('Invalid getClaimableTokens response');
    }
    if (tokens.length === 0) {
        return [];
    }

    const normalizedTokens = [...new Set(
        tokens
            .map(normalizeAddress)
            .filter(Boolean)
            .map((address) => address.toLowerCase())
    )].map((address) => ethers.utils.getAddress(address));
    if (normalizedTokens.length === 0) {
        throw new Error('No valid claimable token addresses found');
    }

    let hasSuccessfulRead = false;
    let lastReadError = null;

    const rows = await Promise.all(normalizedTokens.map(async (token) => {
        let rawAmount;
        try {
            rawAmount = toBigNumber(await contract.claimable(normalizedUser, token));
            hasSuccessfulRead = true;
        } catch (error) {
            lastReadError = error;
            return null;
        }

        if (rawAmount.isZero()) {
            return null;
        }

        if (!includeMetadata) {
            return {
                token,
                tokenLower: token.toLowerCase(),
                rawAmount,
                amount: rawAmount.toString(),
                formattedAmount: formatUnits(rawAmount, 18),
                symbol: `${token.slice(0, 6)}...${token.slice(-4)}`,
                name: token,
                decimals: 18,
                iconUrl: 'fallback'
            };
        }

        const metadata = await getTokenMetadata(ws, token);
        return {
            token,
            tokenLower: token.toLowerCase(),
            rawAmount,
            amount: rawAmount.toString(),
            formattedAmount: formatUnits(rawAmount, metadata.decimals),
            symbol: metadata.symbol,
            name: metadata.name,
            decimals: metadata.decimals,
            iconUrl: metadata.iconUrl
        };
    }));

    // If every token read failed, surface an error so UI can show a failure state.
    if (!hasSuccessfulRead) {
        throw lastReadError || new Error('Failed to read claimable balances');
    }

    return rows
        .filter(Boolean)
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export async function hasAnyClaimables({ contract, userAddress }) {
    const normalizedUser = normalizeAddress(userAddress);
    if (!normalizedUser || !hasClaimAbi(contract)) {
        return false;
    }

    const tokens = await contract.getClaimableTokens(normalizedUser);
    if (!Array.isArray(tokens) || tokens.length === 0) {
        return false;
    }

    const normalizedTokens = [...new Set(
        tokens
            .map(normalizeAddress)
            .filter(Boolean)
            .map((address) => address.toLowerCase())
    )].map((address) => ethers.utils.getAddress(address));
    if (normalizedTokens.length === 0) {
        return false;
    }

    let hasSuccessfulRead = false;
    let lastReadError = null;
    let foundClaimable = false;
    let nextIndex = 0;

    const worker = async () => {
        while (nextIndex < normalizedTokens.length && !foundClaimable) {
            const token = normalizedTokens[nextIndex++];
            try {
                const amount = toBigNumber(await contract.claimable(normalizedUser, token));
                hasSuccessfulRead = true;
                if (!amount.isZero()) {
                    foundClaimable = true;
                    return;
                }
            } catch (error) {
                lastReadError = error;
                // Continue scanning other tokens.
            }
        }
    };

    const workerCount = Math.min(CLAIMABLE_CHECK_CONCURRENCY, normalizedTokens.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (foundClaimable) {
        return true;
    }

    // If no token reads succeeded, callers should treat this as "unknown" instead of "zero claimables".
    if (!hasSuccessfulRead) {
        throw lastReadError || new Error('Failed to read claimable balances');
    }

    return false;
}
