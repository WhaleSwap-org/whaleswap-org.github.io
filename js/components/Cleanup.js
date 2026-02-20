import { ethers } from 'ethers';
import { BaseComponent } from './BaseComponent.js';
import { createLogger } from '../services/LogService.js';
import { handleTransactionError } from '../utils/ui.js';

export class Cleanup extends BaseComponent {
    constructor(containerId) {
        super('cleanup-container');
        this.contract = null;
        this.isInitializing = false;
        this.isInitialized = false;
        this.currentMode = null; // track readOnly/connected mode to allow re-init on change
        
        // Initialize logger
        const logger = createLogger('CLEANUP');
        this.debug = logger.debug.bind(logger);
        this.error = logger.error.bind(logger);
        this.warn = logger.warn.bind(logger);
    }

    async initialize(readOnlyMode = true) {
        if (this.isInitializing) {
            this.debug('Already initializing, skipping...');
            return;
        }

        // Allow re-initialization when mode changes (read-only -> connected or vice versa)
        if (this.isInitialized && this.currentMode === readOnlyMode) {
            this.debug('Already initialized for this mode, skipping...');
            return;
        }

        this.isInitializing = true;

        try {
            this.debug('Starting Cleanup initialization...');
            this.debug('ReadOnly mode:', readOnlyMode);
            this.currentMode = readOnlyMode;
            
            // Wait for WebSocket to be fully initialized
            const ws = this.ctx.getWebSocket();
            if (!ws?.isInitialized) {
                this.debug('Waiting for WebSocket initialization...');
                await new Promise(resolve => {
                    const checkInterval = setInterval(() => {
                        if (ws?.isInitialized) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 100);
                });
            }

            // Get WebSocket and contract from context
            this.webSocket = ws;
            this.contract = ws.contract;

            // Verify contract is available
            if (!this.contract) {
                throw new Error('Contract not initialized');
            }

            // Wait for contract to be ready
            await this.waitForContract();

            // Setup WebSocket event listeners
            this.setupWebSocket();

            this.container.innerHTML = '';
            
            if (readOnlyMode) {
                this.debug('Read-only mode, showing cleanup opportunities with connect prompt');
                const wrapper = this.createElement('div', 'tab-content-wrapper');
                wrapper.innerHTML = `
                    <div class="cleanup-section">
                        <h2>Cleanup Expired Orders</h2>
                        <div class="cleanup-info">
                            <p>Help maintain the orderbook by cleaning up expired orders</p>
                            <div class="cleanup-stats">
                                <div class="cleanup-rewards">
                                    <h3>Cleanup Information</h3>
                                    <div>Next cleanup reward: <span id="current-reward">Loading...</span></div>
                                    <div>Orders ready: <span id="cleanup-ready">Loading...</span></div>
                                </div>
                            </div>
                        </div>
                        <div class="connect-prompt">
                            <p>Connect wallet to perform cleanup actions</p>
                        </div>
                        <button id="cleanup-button" class="action-button" disabled>
                            Connect Wallet to Clean Orders
                        </button>
                    </div>`;
                
                this.container.appendChild(wrapper);

                // Set up the cleanup button event listener for read-only mode
                this.cleanupButton = document.getElementById('cleanup-button');
                if (this.cleanupButton) {
                    this.cleanupButton.addEventListener('click', () => {
                        this.debug('Cleanup button clicked (read-only): attempting wallet connect');
                        const wallet = this.ctx.getWallet();
                        if (wallet) {
                            wallet.connect().catch(error => {
                                this.error('Wallet connect failed from cleanup (read-only):', error);
                                this.showError('Failed to connect wallet: ' + error.message);
                            });
                        } else {
                            this.warn('WalletManager not available on cleanup button click (read-only)');
                        }
                    });
                }

                // Add wallet connection listener to reinitialize when wallet connects
                const wallet = this.ctx.getWallet();
                if (wallet) {
                    wallet.addListener((event, data) => {
                        if (event === 'connect') {
                            this.debug('Wallet connected in read-only mode, reinitializing...');
                            // Force re-init in connected mode
                            this.isInitialized = false;
                            if (this.intervalId) {
                                clearInterval(this.intervalId);
                                this.intervalId = null;
                            }
                            this.initialize(false);
                        }
                    });
                }

                // Check cleanup opportunities even in read-only mode
                this.debug('Starting cleanup opportunities check in read-only mode');
                await this.checkCleanupOpportunities();
                
                this.intervalId = setInterval(() => this.checkCleanupOpportunities(), 5 * 60 * 1000);
                
                this.isInitialized = true;
                this.debug('Read-only mode initialization complete');
                return;
            }

            this.debug('Setting up UI components');
            const wrapper = this.createElement('div', 'tab-content-wrapper');
            wrapper.innerHTML = `
                <div class="cleanup-section">
                    <h2>Cleanup Expired Orders</h2>
                    <div class="cleanup-info">
                        <p>Help maintain the orderbook by cleaning up expired orders</p>
                        <div class="cleanup-stats">
                            <div class="cleanup-rewards">
                                <h3>Cleanup Information</h3>
                                <div>Next cleanup reward: <span id="current-reward">Loading...</span></div>
                                <div>Orders ready: <span id="cleanup-ready">Loading...</span></div>
                            </div>
                        </div>
                    </div>
                    <button id="cleanup-button" class="action-button" disabled>
                        Clean Orders
                    </button>
                </div>`;
            
            this.container.appendChild(wrapper);

            // Only set up the cleanup button event listener
            this.cleanupButton = document.getElementById('cleanup-button');
            if (this.cleanupButton) {
                this.cleanupButton.addEventListener('click', () => {
                    this.debug('Cleanup button clicked (connected): starting performCleanup');
                    this.performCleanup();
                });
            }

            this.debug('Starting cleanup opportunities check');
            await this.checkCleanupOpportunities();
            
            this.intervalId = setInterval(() => this.checkCleanupOpportunities(), 5 * 60 * 1000);
            
            this.isInitialized = true;
            this.debug('Initialization complete');

            this.debug('WebSocket connection successful:', {
                isInitialized: this.webSocket.isInitialized,
                contractAddress: this.webSocket.contract.address
            });

        } catch (error) {
            this.debug('Initialization error details:', {
                error,
                stack: error.stack,
                webSocketState: {
                    exists: !!this.webSocket,
                    isInitialized: this.webSocket?.isInitialized,
                    hasContract: !!this.webSocket?.contract
                }
            });
            this.showError('Failed to initialize cleanup component');
            this.updateUIForError();
        } finally {
            this.isInitializing = false;
        }
    }

    // Add method to check if contract is ready (similar to CreateOrder)
    async waitForContract(timeout = 10000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (this.contract && await this.contract.provider.getNetwork()) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Contract not ready after timeout');
    }

    // Update cleanup method to use class contract reference
    async checkCleanupOpportunities() {
        try {
            if (!this.webSocket?.contract) {
                this.warn('Waiting for WebSocket contract initialization...');
                await new Promise(resolve => setTimeout(resolve, 1000));
                return this.checkCleanupOpportunities();
            }

            // Get all orders from WebSocket cache
            const orders = this.webSocket.getOrders();
            const currentTime = Math.floor(Date.now() / 1000);
            
            // Filter eligible orders (defensive against missing timings)
            const eligibleOrders = orders.filter(order => {
                const graceEndsAt = order?.timings?.graceEndsAt;
                return typeof graceEndsAt === 'number' && currentTime > graceEndsAt;
            });

            // Get the first order that will be cleaned (lowest ID)
            const nextOrderToClean = eligibleOrders.length > 0 
                ? eligibleOrders.reduce((lowest, order) => 
                    (!lowest || order.id < lowest.id) ? order : lowest
                , null)
                : null;

            this.debug('Next order to clean:', nextOrderToClean);

            // Update UI elements
            const elements = {
                cleanupButton: document.getElementById('cleanup-button'),
                cleanupReady: document.getElementById('cleanup-ready'),
                currentReward: document.getElementById('current-reward')
            };
            
            if (elements.cleanupReady) {
                elements.cleanupReady.textContent = eligibleOrders.length.toString();
            }

            // Display reward for next cleanup
            if (elements.currentReward && nextOrderToClean) {
                try {
                    // Get fee information directly from contract
                    const [feeToken, feeAmount] = await Promise.all([
                        this.webSocket.contract.feeToken(),
                        this.webSocket.contract.orderCreationFeeAmount()
                    ]);

                    this.debug('Fee info from contract:', { feeToken, feeAmount: feeAmount.toString() });

                    const tokenInfo = await this.webSocket.getTokenInfo(feeToken);
                    
                    // Format with proper decimals and round to 6 decimal places
                    const formattedAmount = parseFloat(
                        ethers.utils.formatUnits(feeAmount, tokenInfo.decimals)
                    ).toFixed(6);

                    elements.currentReward.textContent = `${formattedAmount} ${tokenInfo.symbol}`;

                    this.debug('Reward formatting:', {
                        feeToken,
                        feeAmount: feeAmount.toString(),
                        decimals: tokenInfo.decimals,
                        formatted: formattedAmount,
                        symbol: tokenInfo.symbol
                    });
                } catch (error) {
                    this.debug('Error formatting reward:', error);
                    elements.currentReward.textContent = 'Error getting reward amount';
                }
            } else if (elements.currentReward) {
                elements.currentReward.textContent = 'No orders to clean';
            }

            if (elements.cleanupButton) {
                // Check if wallet is connected
                const wallet = this.ctx.getWallet();
                const isWalletConnected = wallet?.isWalletConnected();
                
                if (!isWalletConnected) {
                    elements.cleanupButton.disabled = false; // Enable button to connect wallet
                    elements.cleanupButton.textContent = 'Connect Wallet to Clean Orders';
                } else if (eligibleOrders.length === 0) {
                    elements.cleanupButton.disabled = true;
                    elements.cleanupButton.textContent = 'No Orders to Clean';
                } else {
                    elements.cleanupButton.disabled = false;
                    elements.cleanupButton.textContent = 'Clean Orders';
                }
            }

            this.debug('Cleanup opportunities:', {
                totalEligible: eligibleOrders.length,
                nextOrderToClean: nextOrderToClean ? {
                    id: nextOrderToClean.id,
                    fullOrder: nextOrderToClean
                } : null
            });

        } catch (error) {
            this.error('Error checking cleanup opportunities:', error);
            this.showError('Failed to check cleanup opportunities');
            this.updateUIForError();
        }
    }

    updateUIForError() {
        const errorText = 'Error';
        ['active-orders-count', 'active-orders-fees', 
         'cancelled-orders-count', 'cancelled-orders-fees',
         'filled-orders-count', 'filled-orders-fees',
         'cleanup-reward', 'cleanup-ready'].forEach(id => {
            const element = document.getElementById(id);
            if (element) element.textContent = errorText;
        });
    }

    setupWebSocket() {
        if (!this.webSocket) {
            this.warn('WebSocket not available for setup');
            return;
        }

        // Subscribe to all relevant events
        this.webSocket.subscribe('OrderCleaned', () => {
            this.debug('Order cleaned event received');
            this.checkCleanupOpportunities();
        });

        this.webSocket.subscribe('OrderCanceled', () => {
            this.debug('Order canceled event received');
            this.checkCleanupOpportunities();
        });

        this.webSocket.subscribe('OrderFilled', () => {
            this.debug('Order filled event received');
            this.checkCleanupOpportunities();
        });

        this.webSocket.subscribe('orderSyncComplete', () => {
            this.debug('Order sync complete event received');
            this.checkCleanupOpportunities();
        });

        // Add wallet connection event listeners
        const wallet = this.ctx.getWallet();
        if (wallet) {
            wallet.addListener((event, data) => {
                if (event === 'connect') {
                    this.debug('Wallet connected, updating cleanup button state');
                    this.checkCleanupOpportunities();
                } else if (event === 'disconnect') {
                    this.debug('Wallet disconnected, updating cleanup button state');
                    this.checkCleanupOpportunities();
                }
            });
        }
    }

    async performCleanup() {
        try {
            // Check if wallet is connected first
            const wallet = this.ctx.getWallet();
            if (!wallet?.isWalletConnected()) {
                this.debug('Wallet not connected, attempting to connect...');
                try {
                    await wallet.connect();
                    // After successful connection, refresh the button state
                    await this.checkCleanupOpportunities();
                    return;
                } catch (error) {
                    this.error('Failed to connect wallet:', error);
                    this.showError('Failed to connect wallet: ' + error.message);
                    return;
                }
            }

            const contract = this.webSocket?.contract;
            if (!contract) {
                this.error('Contract not initialized');
                throw new Error('Contract not initialized');
            }

            const signer = await wallet.getSigner();
            if (!signer) {
                throw new Error('No signer available');
            }

            const contractWithSigner = contract.connect(signer);

            this.cleanupButton.disabled = true;
            this.cleanupButton.textContent = 'Cleaning...';

            const orders = this.webSocket.getOrders();
            const currentTime = Math.floor(Date.now() / 1000);
            const eligibleOrders = orders.filter(order => {
                const graceEndsAt = order?.timings?.graceEndsAt;
                return typeof graceEndsAt === 'number' && currentTime > graceEndsAt;
            });

            if (eligibleOrders.length === 0) {
                throw new Error('No eligible orders to clean');
            }

            // More accurate base gas calculation for single order cleanup
            const baseGasEstimate = ethers.BigNumber.from('85000')  // Base transaction cost
                .add(ethers.BigNumber.from('65000'))               // Single order cost
                .add(ethers.BigNumber.from('25000'));             // Buffer for contract state changes

            // Try multiple gas estimation attempts with fallback
            let gasEstimate;
            try {
                // Try actual contract estimation first
                gasEstimate = await contractWithSigner.estimateGas.cleanupExpiredOrders();
                this.debug('Initial gas estimation:', gasEstimate.toString());
            } catch (estimateError) {
                this.warn('Primary gas estimation failed:', estimateError);
                try {
                    // Fallback: Try estimation with higher gas limit
                    gasEstimate = await contractWithSigner.estimateGas.cleanupExpiredOrders({
                        gasLimit: baseGasEstimate.mul(2) // Double the base estimate
                    });
                    this.debug('Fallback gas estimation succeeded:', gasEstimate.toString());
                } catch (fallbackError) {
                    this.warn('Fallback gas estimation failed:', fallbackError);
                    // Use calculated estimate as last resort
                    gasEstimate = baseGasEstimate;
                    this.debug('Using base gas estimate:', gasEstimate.toString());
                }
            }

            // Add 30% buffer for safety (increased from 20% due to retry mechanism)
            const gasLimit = gasEstimate.mul(130).div(100);

            const feeData = await contract.provider.getFeeData();
            if (!feeData?.gasPrice) {
                throw new Error('Unable to get current gas prices');
            }

            const txOptions = {
                gasLimit,
                gasPrice: feeData.gasPrice,
                type: 0  // Legacy transaction
            };

            this.debug('Transaction options:', {
                gasLimit: gasLimit.toString(),
                gasPrice: feeData.gasPrice.toString(),
                estimatedCost: ethers.utils.formatEther(gasLimit.mul(feeData.gasPrice)) + ' ETH'
            });

            // Execute cleanup transaction
            this.debug('Sending transaction with options:', txOptions);
            const tx = await contractWithSigner.cleanupExpiredOrders(txOptions);
            this.debug('Transaction sent:', tx.hash);

            const receipt = await tx.wait();
            this.debug('Transaction confirmed:', receipt);

            if (receipt.status === 1) {
                // Enhanced event parsing with detailed feedback
                const result = await this.parseCleanupEvents(receipt, signer);
                await this.handleCleanupResult(result);
                return;
            }
            throw new Error('Transaction failed during execution');

        } catch (error) {
            // Use utility function for consistent error handling
            handleTransactionError(error, this, 'cleanup');
        } finally {
            this.cleanupButton.textContent = 'Clean Orders';
            this.cleanupButton.disabled = false;
            await this.checkCleanupOpportunities();
        }
    }

    // TODO: if things get changed in ABI, this will need to be updated 
    // TODO: create constants for event names and use them here
    // New method to parse cleanup events with detailed analysis
    async parseCleanupEvents(receipt, signer) {
        const events = receipt.events || [];
        const userAddress = await signer.getAddress();
        
        // Parse all relevant events
        const retryEvents = [];
        const feeEvents = [];
        const cleanedEvents = [];
        const errorEvents = [];

        for (const event of events) {
            if (event.event === 'RetryOrder') {
                retryEvents.push({
                    oldOrderId: event.args.oldOrderId.toString(),
                    newOrderId: event.args.newOrderId.toString(),
                    maker: event.args.maker,
                    tries: event.args.tries.toString(),
                    timestamp: event.args.timestamp.toString()
                });
            } else if (event.event === 'CleanupFeesDistributed') {
                feeEvents.push({
                    recipient: event.args.recipient,
                    feeToken: event.args.feeToken,
                    amount: event.args.amount.toString(),
                    timestamp: event.args.timestamp.toString()
                });
            } else if (event.event === 'OrderCleanedUp') {
                cleanedEvents.push({
                    orderId: event.args.orderId.toString(),
                    maker: event.args.maker,
                    timestamp: event.args.timestamp.toString()
                });
            } else if (event.event === 'CleanupError') {
                errorEvents.push({
                    orderId: event.args.orderId.toString(),
                    reason: event.args.reason,
                    timestamp: event.args.timestamp.toString()
                });
            }
        }

        this.debug('Parsed cleanup events:', {
            retryEvents,
            feeEvents,
            cleanedEvents,
            errorEvents
        });

        return {
            retryEvents,
            feeEvents,
            cleanedEvents,
            errorEvents,
            userAddress: userAddress.toLowerCase()
        };
    }

    // New method to handle cleanup results and show appropriate feedback
    async handleCleanupResult(result) {
        const { retryEvents, feeEvents, cleanedEvents, errorEvents, userAddress } = result;
        
        // Check for errors first
        if (errorEvents.length > 0) {
            // Deduplicate error messages to avoid repetition
            const uniqueErrors = new Map();
            errorEvents.forEach(e => {
                const key = `${e.orderId}-${e.reason}`;
                if (!uniqueErrors.has(key)) {
                    uniqueErrors.set(key, `Order #${e.orderId}: ${e.reason}`);
                }
            });
            const errorMsg = Array.from(uniqueErrors.values()).join(', ');
            this.showWarning(`Cleanup completed with errors: ${errorMsg}`);
        }

        // Check if user received fees
        const userFeeEvent = feeEvents.find(f => f.recipient.toLowerCase() === userAddress);
        if (userFeeEvent) {
            try {
                const tokenInfo = await this.webSocket.getTokenInfo(userFeeEvent.feeToken);
                const formattedAmount = parseFloat(
                    ethers.utils.formatUnits(userFeeEvent.amount, tokenInfo.decimals)
                ).toFixed(6);
                
                this.showSuccess(`Cleanup successful! You received ${formattedAmount} ${tokenInfo.symbol} as reward.`);
            } catch (error) {
                this.debug('Error formatting fee amount:', error);
                this.showSuccess('Cleanup successful! You received a reward. Check your wallet.');
            }
        } else if (retryEvents.length > 0 && feeEvents.length === 0) {
            // Order was recycled but no fees were distributed
            const retryMsg = retryEvents.map(r => 
                `Order #${r.oldOrderId} → #${r.newOrderId} (tries: ${r.tries})`
            ).join(', ');
            this.showInfo(`Order recycled (no fee distribution): ${retryMsg}`);
        } else if (cleanedEvents.length > 0 && feeEvents.length === 0) {
            // Order was cleaned but no fees were distributed
            const cleanedMsg = cleanedEvents.map(c => `#${c.orderId}`).join(', ');
            this.showInfo(`Orders cleaned: ${cleanedMsg} (no fee distribution in this transaction)`);
        } else if (retryEvents.length === 0 && cleanedEvents.length === 0 && feeEvents.length === 0) {
            this.showInfo('No eligible orders to clean up at this time.');
        } else {
            // Mixed results
            let msg = 'Cleanup completed: ';
            if (cleanedEvents.length > 0) {
                msg += `${cleanedEvents.length} order(s) cleaned. `;
            }
            if (retryEvents.length > 0) {
                msg += `${retryEvents.length} order(s) recycled. `;
            }
            if (feeEvents.length > 0) {
                msg += `Fees distributed to ${feeEvents.length} recipient(s).`;
            }
            this.showSuccess(msg);
        }

        // Update WebSocket cache
        const cleanedOrderIds = cleanedEvents.map(e => e.orderId);
        const retryOrderIds = new Map(retryEvents.map(r => [r.oldOrderId, r.newOrderId]));

        if (cleanedOrderIds.length > 0) {
            this.webSocket.removeOrders(cleanedOrderIds);
        }

        if (retryOrderIds.size > 0) {
            await this.webSocket.syncAllOrders(this.webSocket.contract);
        }
    }

    // Override showSuccess to also clear fee form inputs
    showSuccess(message, duration = 5000) {
        super.showSuccess(message, duration);
        
        // Clear form inputs for fee config form
        const feeConfigForm = document.querySelector('.fee-config-form');
        if (feeConfigForm) {
            const feeTokenInput = document.getElementById('fee-token');
            const feeAmountInput = document.getElementById('fee-amount');
            if (feeTokenInput) feeTokenInput.value = '';
            if (feeAmountInput) feeAmountInput.value = '';
        }
    }

    // Override with longer default duration for cleanup warnings
    showWarning(message, duration = 15000) {
        super.showWarning(message, duration);
    }

    // Override with longer default duration for cleanup info
    showInfo(message, duration = 15000) {
        super.showInfo(message, duration);
    }

    // Add helper method to format ETH values
    formatEth(wei) {
        return ethers.utils.formatEther(wei.toString());
    }

    async disableContract() {
        try {
            const contract = this.webSocket?.contract;
            if (!contract) {
                throw new Error('Contract not initialized');
            }

            // Get signer from wallet manager
            const wallet = this.ctx.getWallet();
            const signer = await wallet.getSigner();
            if (!signer) {
                throw new Error('No signer available');
            }

            const contractWithSigner = contract.connect(signer);

            this.disableContractButton.disabled = true;
            this.disableContractButton.textContent = 'Disabling...';

            const tx = await contractWithSigner.disableContract();
            await tx.wait();

            this.showSuccess('Contract successfully disabled');
            this.disableContractButton.textContent = 'Contract Disabled';

        } catch (error) {
            this.debug('Error disabling contract:', error);
            this.showError(`Failed to disable contract: ${error.message}`);
            this.disableContractButton.disabled = false;
            this.disableContractButton.textContent = 'Disable Contract';
        }
    }

    cleanup() {
        this.debug('Cleaning up Cleanup component');
        if (this.intervalId) {
            this.debug('Cleaning up cleanup check interval');
            clearInterval(this.intervalId);
        }
        
        // Remove wallet listeners
        const wallet = this.ctx.getWallet();
        if (wallet) {
            // Note: We can't easily remove specific listeners, but the component will be recreated
            // when needed, so this is acceptable for now
            this.debug('Wallet listeners will be cleaned up on component recreation');
        }
        
        this.debug('Resetting component state');
        this.isInitialized = false;
        this.isInitializing = false;
        this.contract = null;
    }

    async updateFeeConfig() {
        try {
            const contract = this.webSocket?.contract;
            if (!contract) {
                throw new Error('Contract not initialized');
            }

            const wallet = this.ctx.getWallet();
            const signer = await wallet.getSigner();
            if (!signer) {
                throw new Error('No signer available');
            }

            const contractWithSigner = contract.connect(signer);

            const feeToken = document.getElementById('fee-token').value;
            const feeAmount = document.getElementById('fee-amount').value;

            if (!ethers.utils.isAddress(feeToken)) {
                throw new Error('Invalid fee token address');
            }

            if (!feeAmount || isNaN(feeAmount)) {
                throw new Error('Invalid fee amount');
            }

            this.updateFeeConfigButton.disabled = true;
            this.updateFeeConfigButton.textContent = 'Updating...';

            const tx = await contractWithSigner.updateFeeConfig(feeToken, feeAmount);
            await tx.wait();

            // Clear the form
            document.getElementById('fee-token').value = '';
            document.getElementById('fee-amount').value = '';

            this.showSuccess('Fee configuration updated successfully');
        } catch (error) {
            this.debug('Error updating fee config:', error);
            this.showError(`Failed to update fee config: ${error.message}`);
        } finally {
            this.updateFeeConfigButton.disabled = false;
            this.updateFeeConfigButton.textContent = 'Update Fee Config';
        }
    }
} 
