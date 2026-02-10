export function setVisibility(element, isVisible) {
    if (!element) return;
    element.classList.toggle('is-hidden', !isVisible);
    element.setAttribute('aria-hidden', String(!isVisible));
}

/**
 * Check if an error represents a user rejection of a transaction
 * @param {Error} error - The error object to check
 * @returns {boolean} - True if the error is a user rejection
 */
export function isUserRejection(error) {
    return error.code === 4001 || 
           error.code === 'ACTION_REJECTED' ||
           error.message?.includes('user rejected') ||
           error.message?.includes('User denied transaction signature') ||
           error.reason === 'user rejected transaction';
}

/**
 * Handle transaction errors with silent user rejection handling
 * @param {Error} error - The error object
 * @param {Object} component - The component instance with debug and showError methods
 * @param {string} action - Description of the action being performed (e.g., 'cleanup', 'order creation')
 * @returns {boolean} - True if the error was a user rejection (handled silently), false otherwise
 */
export function handleTransactionError(error, component, action = 'transaction') {
    if (isUserRejection(error)) {
        // Silently handle user rejection - no error toast needed
        component.debug(`User rejected ${action}`);
        return true; // Indicates user rejection was handled
    } else {
        // Extract the most meaningful error message
        let errorMessage = error.message || 'Unknown error occurred';
        
        // For contract revert errors, try to extract the actual revert message
        if (error.code === 'UNPREDICTABLE_GAS_LIMIT' && error.error?.data?.message) {
            // This is a contract revert - use the actual revert message
            errorMessage = error.error.data.message;
        } else if (error.reason) {
            // Use the reason if available (often contains the actual error)
            errorMessage = error.reason;
        } else if (error.error?.data?.message) {
            // Fallback to nested error message
            errorMessage = error.error.data.message;
        }
        
        // Show error for actual failures
        component.error(`${action} failed:`, {
            message: error.message,
            code: error.code,
            error: error.error,
            reason: error.reason,
            transaction: error.transaction,
            extractedMessage: errorMessage
        });
        
        // Show the extracted error message to the user
        component.showError(errorMessage);
        return false; // Indicates error was shown to user
    }
}

/**
 * Formats an Ethereum address to show first 6 and last 4 characters
 * @param {string} address - The full Ethereum address
 * @param {string} fallbackText - Text to show if address is null/undefined
 * @returns {string} Formatted address or fallback text
 */
export function formatAddress(address, fallbackText = 'Open to anyone') {
    if (!address) return fallbackText;
    
    // Validate address format (basic check)
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        console.warn('Invalid Ethereum address format:', address);
        return fallbackText;
    }
    
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Gets the counterparty address for an order based on user's role
 * @param {Object} order - The order object
 * @param {string} userAddress - The current user's address
 * @returns {string} The counterparty address or null if open order
 */
export function getCounterpartyAddress(order, userAddress) {
    if (!order || !userAddress) return null;
    
    const userAddressLower = userAddress.toLowerCase();
    const isUserMaker = order.maker?.toLowerCase() === userAddressLower;
    
    return isUserMaker ? order.taker : order.maker;
}

/**
 * Test function to verify address formatting utilities work correctly
 * This can be called from browser console for testing
 */
export function testAddressUtils() {
    const testAddress = '0x1234567890123456789012345678901234567890';
    const zeroAddress = '0x0000000000000000000000000000000000000000';
    const testOrder = {
        maker: '0x1111111111111111111111111111111111111111',
        taker: '0x2222222222222222222222222222222222222222'
    };
    
    console.log('Testing address utilities:');
    console.log('formatAddress(testAddress):', formatAddress(testAddress));
    console.log('formatAddress(null):', formatAddress(null));
    console.log('isZeroAddress(zeroAddress):', isZeroAddress(zeroAddress));
    console.log('isZeroAddress(testAddress):', isZeroAddress(testAddress));
    console.log('getCounterpartyAddress(testOrder, testOrder.maker):', getCounterpartyAddress(testOrder, testOrder.maker));
    console.log('getCounterpartyAddress(testOrder, testOrder.taker):', getCounterpartyAddress(testOrder, testOrder.taker));
    
    // Test copy functionality (will show in console)
    copyToClipboard(testAddress).then(success => {
        console.log('copyToClipboard success:', success);
    });
    
    return 'Address utilities test completed';
}

/**
 * Copies text to clipboard
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} Success status
 */
export async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        } else {
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            const result = document.execCommand('copy');
            textArea.remove();
            return result;
        }
    } catch (error) {
        console.error('Failed to copy to clipboard:', error);
        return false;
    }
}

/**
 * Checks if an address is a zero address
 * @param {string} address - The address to check
 * @returns {boolean} True if it's a zero address
 */
export function isZeroAddress(address) {
    if (!address) return true;
    return address.toLowerCase() === '0x0000000000000000000000000000000000000000';
}

/**
 * Test function specifically for taker orders debugging
 * This can be called from browser console for testing
 */
export function testTakerOrdersLogic() {
    const testUserAddress = '0x7F772C7D3C6d6b5c6777C927827F119e59DDcdb0';
    const testOrder = {
        id: 70,
        maker: '0xb5A5bD462A0a76c02990d0FBE3321e92E0B03ABC',
        taker: '0x7F772C7D3C6d6b5c6777C927827F119e59DDcdb0',
        status: 'Active'
    };
    
    console.log('Testing TakerOrders logic:');
    console.log('User address:', testUserAddress);
    console.log('Order:', testOrder);
    console.log('Is user taker?', testOrder.taker.toLowerCase() === testUserAddress.toLowerCase());
    console.log('Counterparty address:', getCounterpartyAddress(testOrder, testUserAddress));
    console.log('Is zero address?', isZeroAddress(getCounterpartyAddress(testOrder, testUserAddress)));
    console.log('Formatted address:', formatAddress(getCounterpartyAddress(testOrder, testUserAddress)));
    
    return 'TakerOrders logic test completed';
}

/**
 * Generates the status cell HTML with counterparty address
 * @param {string} orderStatus - The order status text
 * @param {string} counterpartyAddress - The counterparty address
 * @param {boolean} isZeroAddr - Whether the address is a zero address
 * @param {string} formattedAddress - The formatted address for display
 * @returns {string} HTML string for the status cell
 */
export function generateStatusCellHTML(orderStatus, counterpartyAddress, isZeroAddr, formattedAddress) {
    return `
        <div class="status-main">${orderStatus}</div>
        ${!isZeroAddr ? `
            <div class="counterparty-address clickable" 
                 data-tooltip="Click to copy: ${counterpartyAddress}" 
                 data-address="${counterpartyAddress}">
                ${formattedAddress}
            </div>
        ` : ''}
    `;
}

/**
 * Sets up click-to-copy functionality for an address element
 * @param {HTMLElement} addressElement - The address element to add functionality to
 */
export function setupClickToCopy(addressElement) {
    if (!addressElement) return;
    
    addressElement.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        
        const address = addressElement.dataset.address;
        if (address) {
            const success = await copyToClipboard(address);
            if (success) {
                addressElement.classList.add('copied');
                setTimeout(() => {
                    addressElement.classList.remove('copied');
                }, 2000);
            }
        }
    });
}

/**
 * Processes order data to get counterparty address information
 * @param {Object} order - The order object
 * @param {string} userAddress - The current user's address
 * @returns {Object} Object containing address processing results
 */
export function processOrderAddress(order, userAddress) {
    const counterpartyAddress = getCounterpartyAddress(order, userAddress);
    const isZeroAddr = isZeroAddress(counterpartyAddress);
    const formattedAddress = formatAddress(counterpartyAddress);
    
    return {
        counterpartyAddress,
        isZeroAddr,
        formattedAddress
    };
}


