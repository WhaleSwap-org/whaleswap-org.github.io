import { abi as CONTRACT_ABI } from '../abi/OTCSwap.js';
import { localDeployment } from '../local-dev.deployment.js';

const isLocalHostname = () => {
    if (typeof window === 'undefined' || !window.location) {
        return false;
    }
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1';
};

const localNetworkConfig = {
    "1337": {
        slug: "local",
        name: "Localhost",
        displayName: "Localhost 8545",
        logo: null,
        isDefault: false,
        contractAddress: localDeployment?.contracts?.otcSwap || "0x0000000000000000000000000000000000000000",
        contractABI: CONTRACT_ABI,
        explorer: "http://127.0.0.1:8545",
        rpcUrl: "http://127.0.0.1:8545",
        fallbackRpcUrls: [
            "http://localhost:8545"
        ],
        chainId: "0x539",
        nativeCurrency: {
            name: "ETH",
            symbol: "ETH",
            decimals: 18
        },
        multicallAddress: null,
        wsUrl: "ws://127.0.0.1:8545",
        fallbackWsUrls: [
            "ws://localhost:8545"
        ]
    },
};

const primaryNetworkConfig = {
    "56": {
        slug: "bnb",
        name: "BNB Chain",
        displayName: "BNB Chain",
        logo: "img/token-logos/0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c.png",
        isDefault: false,
        contractAddress: "0x324d9b90A07D587B4FA0D68c22645B9c8D321079",
        contractABI: CONTRACT_ABI,
        explorer: "https://bscscan.com",
        rpcUrl: "https://bsc-dataseed.binance.org",
        fallbackRpcUrls: [
            "https://bsc-dataseed1.binance.org",
            "https://bsc-dataseed1.defibit.io",
            "https://rpc.ankr.com/bsc"
        ],
        chainId: "0x38",
        nativeCurrency: {
            name: "BNB",
            symbol: "BNB",
            decimals: 18
        },
        // Multicall3
        multicallAddress: "0xca11bde05977b3631167028862be2a173976ca11",
        wsUrl: "wss://bsc-rpc.publicnode.com",
        fallbackWsUrls: [
            "wss://bsc.publicnode.com"
        ]
    },
    "137": {
        slug: "polygon",
        name: "Polygon",
        displayName: "Polygon Mainnet",
        logo: "img/token-logos/0x0000000000000000000000000000000000001010.png",
        isDefault: true,
        contractAddress: "0x324d9b90A07D587B4FA0D68c22645B9c8D321079",
        contractABI: CONTRACT_ABI,
        explorer: "https://polygonscan.com",
        rpcUrl: "https://polygon-rpc.com",
        fallbackRpcUrls: [
            "https://rpc-mainnet.matic.network",
            "https://polygon-bor.publicnode.com",
            "https://polygon.api.onfinality.io/public"
        ],
        chainId: "0x89",
        nativeCurrency: {
            name: "MATIC",
            symbol: "MATIC",
            decimals: 18
        },
        // Multicall2 contract (Uniswap) deployed on Polygon mainnet
        multicallAddress: "0x275617327c958bD06b5D6b871E7f491D76113dd8",
        wsUrl: "wss://polygon.gateway.tenderly.co",
        fallbackWsUrls: [
            "wss://polygon-bor.publicnode.com",
            "wss://polygon-bor-rpc.publicnode.com",
            "wss://polygon.api.onfinality.io/public-ws"
        ]
    },
    "80002": {
        slug: "amoy",
        name: "Polygon Amoy",
        displayName: "Polygon Amoy",
        logo: "img/token-logos/0x0000000000000000000000000000000000001010.png",
        isDefault: false,
        contractAddress: "0x0aB6ca718d12349B5477fD480a13F5e21a786222",
        contractABI: CONTRACT_ABI,
        explorer: "https://amoy.polygonscan.com",
        rpcUrl: "https://rpc-amoy.polygon.technology",
        fallbackRpcUrls: [
            "https://polygon-amoy-bor-rpc.publicnode.com"
        ],
        chainId: "0x13882",
        nativeCurrency: {
            name: "POL",
            symbol: "POL",
            decimals: 18
        },
        multicallAddress: null,
        wsUrl: "wss://polygon-amoy-bor-rpc.publicnode.com",
        fallbackWsUrls: [
            "wss://polygon-amoy.gateway.tenderly.co"
        ]
    },
};

const networkConfig = isLocalHostname()
    ? { ...primaryNetworkConfig, ...localNetworkConfig }
    : primaryNetworkConfig;

const normalizeChainId = (chainId) => {
    if (chainId === null || chainId === undefined) {
        return null;
    }

    const chainIdStr = String(chainId).toLowerCase();
    if (/^0x[0-9a-f]+$/.test(chainIdStr)) {
        const decimalValue = parseInt(chainIdStr, 16);
        return Number.isNaN(decimalValue) ? null : String(decimalValue);
    }

    if (/^\d+$/.test(chainIdStr)) {
        return chainIdStr;
    }

    return null;
};

export const getAllNetworks = () => Object.values(networkConfig);

export const getDefaultNetwork = () => {
    // Find the first network marked as default
    const defaultNetwork = Object.values(networkConfig).find(net => net.isDefault);
    if (!defaultNetwork) {
        throw new Error('No default network configured');
    }
    return defaultNetwork;
};

let activeNetworkSlug = getDefaultNetwork().slug;

export const getNetworkBySlug = (slug) => {
    if (!slug) return null;
    const normalizedSlug = String(slug).toLowerCase();
    return Object.values(networkConfig).find(net => net.slug === normalizedSlug) || null;
};

export const getNetworkById = (chainId) => {
    const decimalChainId = normalizeChainId(chainId);
    if (!decimalChainId) return null;
    return networkConfig[decimalChainId];
};

export const getActiveNetwork = () => {
    return getNetworkBySlug(activeNetworkSlug) || getDefaultNetwork();
};

export const setActiveNetwork = (networkRef) => {
    let network = null;

    if (networkRef && typeof networkRef === 'object' && networkRef.slug) {
        network = getNetworkBySlug(networkRef.slug);
    } else {
        network = getNetworkBySlug(networkRef) || getNetworkById(networkRef);
    }

    if (!network) {
        throw new Error(`Cannot set active network. Unsupported value: ${networkRef}`);
    }

    activeNetworkSlug = network.slug;
    return network;
};

export const getNetworkConfig = (chainId = null) => {
    if (chainId !== null && chainId !== undefined) {
        const network = getNetworkById(chainId);
        if (!network) {
            throw new Error(`Network configuration not found for chain ID: ${chainId}`);
        }
        return network;
    }
    return getActiveNetwork();
};
