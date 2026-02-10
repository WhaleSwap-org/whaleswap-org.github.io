import { ethers } from 'ethers';
import { getNetworkConfig } from '../config.js';
import { contractService } from './ContractService.js';
import { createLogger } from './LogService.js';

// Logger (behind DEBUG_CONFIG via LogService)
const logger = createLogger('MULTICALL');
const debug = logger.debug.bind(logger);
const error = logger.error.bind(logger);

// Multicall2 ABI
const MULTICALL2_ABI = [
	'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])'
];

/**
 * Get a Multicall2 contract instance for the current network
 * Returns null if provider or multicall address is not available
 */
function getMulticallContract() {
	try {
		const networkCfg = getNetworkConfig();
		const multicallAddress = networkCfg.multicallAddress;
		if (!multicallAddress) {
			debug('No multicallAddress configured for current network');
			return null;
		}

		const provider = contractService.getProvider();
		if (!provider) {
			debug('No provider available for Multicall');
			return null;
		}

		return new ethers.Contract(multicallAddress, MULTICALL2_ABI, provider);
	} catch (e) {
		error('Failed to create Multicall contract:', e);
		return null;
	}
}

/**
 * Execute a batch of read-only calls via Multicall2.
 * @param {Array<{ target: string, callData: string }>} calls
 * @param {{ requireSuccess?: boolean }} options
 * @returns {Promise<Array<{ success: boolean, returnData: string }>> | null} Returns null if multicall is not available
 */
export async function tryAggregate(calls, options = {}) {
	const requireSuccess = options.requireSuccess === true;
	const mc = getMulticallContract();
	if (!mc) return null; // Signal to fallback

	if (!Array.isArray(calls) || calls.length === 0) {
		return [];
	}

	try {
		return await mc.tryAggregate(requireSuccess, calls);
	} catch (e) {
		debug('Multicall tryAggregate failed, will fallback to per-call path:', e?.message || e);
		return null;
	}
}

/**
 * Helper to check if multicall is configured and provider is available.
 */
export function isMulticallAvailable() {
	try {
		const networkCfg = getNetworkConfig();
		return !!(networkCfg.multicallAddress && contractService.getProvider());
	} catch {
		return false;
	}
}


