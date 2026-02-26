import { ethers } from 'ethers';
import { BaseComponent } from './BaseComponent.js';
import { createLogger } from '../services/LogService.js';
import { handleTransactionError, isUserRejection } from '../utils/ui.js';
import { generateTokenIconHTML } from '../utils/tokenIcons.js';
import { getClaimableSnapshot } from '../utils/claims.js';

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toBigNumber(value) {
    try {
        return ethers.BigNumber.from(value ?? 0);
    } catch (_) {
        return ethers.BigNumber.from(0);
    }
}

export class Claim extends BaseComponent {
    constructor(containerId = 'claim') {
        super(containerId);

        const logger = createLogger('CLAIM');
        this.debug = logger.debug.bind(logger);
        this.error = logger.error.bind(logger);
        this.warn = logger.warn.bind(logger);

        this.isInitializing = false;
        this.isInitialized = false;
        this.currentMode = null;
        this.contract = null;
        this.webSocket = null;
        this.claims = [];
        this.pendingClaims = new Set();
        this.refreshRequestId = 0;
        this.refreshDebounceTimer = null;

        this.claimsUpdatedHandler = null;
        this.walletListener = null;
        this.handleContainerClick = this.onContainerClick.bind(this);
    }

    async initialize(readOnlyMode = true) {
        if (this.isInitializing) return;

        if (this.isInitialized && this.currentMode === readOnlyMode) {
            await this.refreshClaimables();
            return;
        }

        this.isInitializing = true;
        this.currentMode = readOnlyMode;

        try {
            const ws = this.ctx.getWebSocket();
            await ws?.waitForInitialization?.();
            this.webSocket = ws;
            this.contract = ws?.contract || null;

            this.renderShell();
            this.container.removeEventListener('click', this.handleContainerClick);
            this.container.addEventListener('click', this.handleContainerClick);
            this.setupSubscriptions();
            await this.refreshClaimables();

            this.isInitialized = true;
        } catch (error) {
            this.error('Failed to initialize Claim tab:', error);
            this.container.innerHTML = `
                <div class="tab-content-wrapper claim-panel">
                    <h2 class="main-heading">Claim</h2>
                    <p class="claim-empty">Unable to load claim balances.</p>
                </div>
            `;
        } finally {
            this.isInitializing = false;
        }
    }

    renderShell() {
        this.container.innerHTML = `
            <div class="tab-content-wrapper claim-panel">
                <h2 class="main-heading">Claim</h2>
                <p class="claim-description">Withdraw claimable token balances for your connected wallet.</p>
                <div class="claim-feedback" data-claim-feedback></div>
                <div class="claim-list" data-claim-list></div>
            </div>
        `;
    }

    setFeedback(message = '', tone = '') {
        const feedback = this.container.querySelector('[data-claim-feedback]');
        if (!feedback) return;

        feedback.textContent = message;
        feedback.classList.remove('is-success', 'is-warning', 'is-error');
        if (tone === 'success') feedback.classList.add('is-success');
        if (tone === 'warning') feedback.classList.add('is-warning');
        if (tone === 'error') feedback.classList.add('is-error');
    }

    getListElement() {
        return this.container.querySelector('[data-claim-list]');
    }

    renderLoadingState() {
        const list = this.getListElement();
        if (!list) return;
        list.innerHTML = '<div class="claim-empty">Loading claimable balances...</div>';
    }

    renderReadOnlyState() {
        const list = this.getListElement();
        if (!list) return;
        list.innerHTML = '<div class="claim-empty">Connect wallet to view claimable balances.</div>';
    }

    renderEmptyState() {
        const list = this.getListElement();
        if (!list) return;
        list.innerHTML = '<div class="claim-empty">No claimable balances for this wallet.</div>';
    }

    formatDisplayAmount(amount) {
        const [wholeRaw = '0', fractionRaw = ''] = String(amount || '0').split('.');
        let whole = wholeRaw;
        try {
            whole = ethers.utils.commify(wholeRaw);
        } catch (_) {}

        const fraction = fractionRaw.replace(/0+$/, '').slice(0, 8);
        return fraction ? `${whole}.${fraction}` : whole;
    }

    renderClaimRows(claims) {
        const list = this.getListElement();
        if (!list) return;

        const rowsMarkup = claims.map((claim) => {
            const tokenLower = claim.tokenLower || claim.token.toLowerCase();
            const pending = this.pendingClaims.has(tokenLower);
            const iconHtml = generateTokenIconHTML(
                claim.iconUrl,
                claim.symbol,
                claim.token
            );

            return `
                <div class="claim-row" data-token="${escapeHtml(claim.token)}">
                    <div class="claim-token">
                        ${iconHtml}
                        <div class="claim-token-meta">
                            <div class="claim-token-symbol">${escapeHtml(claim.symbol)}</div>
                            <div class="claim-token-name">${escapeHtml(claim.name || claim.symbol)}</div>
                        </div>
                    </div>
                    <div class="claim-actions">
                        <div class="claim-amount">${escapeHtml(this.formatDisplayAmount(claim.formattedAmount))}</div>
                        <button
                            type="button"
                            class="action-button claim-action-button"
                            data-token="${escapeHtml(claim.token)}"
                            ${pending ? 'disabled' : ''}
                        >
                            ${pending ? 'Claiming...' : 'Claim'}
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        list.innerHTML = rowsMarkup;
    }

    async refreshClaimables() {
        const requestId = ++this.refreshRequestId;

        if (this.currentMode) {
            this.setFeedback('');
            this.renderReadOnlyState();
            return;
        }

        const wallet = this.ctx.getWallet();
        const isConnected = !!wallet?.isWalletConnected?.();
        const account = wallet?.getAccount?.();
        if (!isConnected || !account) {
            this.setFeedback('');
            this.renderReadOnlyState();
            return;
        }

        if (!this.contract) {
            this.setFeedback('Contract unavailable for claim checks.', 'error');
            this.renderEmptyState();
            return;
        }

        this.setFeedback('');
        this.renderLoadingState();

        try {
            const claims = await getClaimableSnapshot({
                contract: this.contract,
                ws: this.webSocket,
                userAddress: account,
                includeMetadata: true
            });

            if (requestId !== this.refreshRequestId) return;

            this.claims = claims;
            if (!claims.length) {
                this.renderEmptyState();
                return;
            }

            this.renderClaimRows(claims);
        } catch (error) {
            if (requestId !== this.refreshRequestId) return;
            this.error('Failed to refresh claimables:', error);
            this.setFeedback('Failed to load claimable balances.', 'error');
            this.renderEmptyState();
        }
    }

    async onContainerClick(event) {
        const claimButton = event.target?.closest?.('.claim-action-button');
        if (!claimButton) return;

        const token = claimButton.dataset.token;
        if (!token) return;

        await this.claimToken(token);
    }

    async claimToken(tokenAddress) {
        let normalizedToken;
        try {
            normalizedToken = ethers.utils.getAddress(tokenAddress);
        } catch (_) {
            this.showError('Invalid token address for claim.');
            return;
        }

        const tokenLower = normalizedToken.toLowerCase();
        if (this.pendingClaims.has(tokenLower)) return;

        const wallet = this.ctx.getWallet();
        if (!wallet?.isWalletConnected?.()) {
            this.showWarning('Connect wallet to claim tokens.');
            return;
        }

        if (!this.contract || typeof this.contract.withdraw !== 'function') {
            this.showError('Withdraw function is unavailable for this contract.');
            return;
        }

        this.pendingClaims.add(tokenLower);
        this.renderClaimRows(this.claims);

        try {
            const signer = await wallet.getSigner();
            if (!signer) {
                throw new Error('No signer available');
            }

            const beneficiary = await signer.getAddress();
            const latestAmount = toBigNumber(
                await this.contract.claimable(beneficiary, normalizedToken)
            );

            if (latestAmount.isZero()) {
                this.showInfo('Nothing to claim for this token.');
                return;
            }

            const claimItem = this.claims.find((item) => item.tokenLower === tokenLower);
            const decimals = claimItem?.decimals ?? 18;
            const symbol = claimItem?.symbol || `${normalizedToken.slice(0, 6)}...${normalizedToken.slice(-4)}`;
            const formatted = this.formatDisplayAmount(
                ethers.utils.formatUnits(latestAmount, decimals)
            );

            const tx = await this.contract.connect(signer).withdraw(normalizedToken, latestAmount);
            await tx.wait();

            this.showSuccess(`Claimed ${formatted} ${symbol}.`);

            if (this.webSocket?.notifySubscribers) {
                this.webSocket.notifySubscribers('claimsUpdated', {
                    beneficiary,
                    token: normalizedToken,
                    amount: latestAmount.toString(),
                    source: 'claim-tx'
                });
            }
        } catch (error) {
            if (isUserRejection(error)) {
                this.showWarning('User cancelled');
            } else {
                handleTransactionError(error, this, 'claim');
            }
        } finally {
            this.pendingClaims.delete(tokenLower);
            await this.refreshClaimables();
        }
    }

    setupSubscriptions() {
        this.cleanupSubscriptions();

        const scheduleRefresh = () => {
            if (this.refreshDebounceTimer) {
                clearTimeout(this.refreshDebounceTimer);
            }

            this.refreshDebounceTimer = setTimeout(() => {
                this.refreshDebounceTimer = null;
                this.refreshClaimables().catch((error) => {
                    this.debug('debounced claim refresh failed:', error);
                });
            }, 120);
        };

        if (this.webSocket?.subscribe) {
            this.claimsUpdatedHandler = (eventData) => {
                const beneficiary = eventData?.beneficiary;
                if (beneficiary) {
                    const account = this.ctx.getWallet()?.getAccount?.();
                    if (!account) {
                        return;
                    }

                    try {
                        if (beneficiary.toLowerCase() !== account.toLowerCase()) {
                            return;
                        }
                    } catch (_) {
                        return;
                    }
                }

                scheduleRefresh();
            };
            this.webSocket.subscribe('claimsUpdated', this.claimsUpdatedHandler);
        }

        const wallet = this.ctx.getWallet();
        if (wallet?.addListener) {
            this.walletListener = (event) => {
                if (
                    event === 'connect'
                    || event === 'disconnect'
                    || event === 'accountsChanged'
                    || event === 'chainChanged'
                ) {
                    scheduleRefresh();
                }
            };
            wallet.addListener(this.walletListener);
        }
    }

    cleanupSubscriptions() {
        if (this.webSocket?.unsubscribe && this.claimsUpdatedHandler) {
            this.webSocket.unsubscribe('claimsUpdated', this.claimsUpdatedHandler);
        }
        this.claimsUpdatedHandler = null;

        const wallet = this.ctx.getWallet();
        if (wallet?.removeListener && this.walletListener) {
            wallet.removeListener(this.walletListener);
        }
        this.walletListener = null;

        if (this.refreshDebounceTimer) {
            clearTimeout(this.refreshDebounceTimer);
            this.refreshDebounceTimer = null;
        }
    }

    cleanup() {
        this.container.removeEventListener('click', this.handleContainerClick);
        this.cleanupSubscriptions();

        this.claims = [];
        this.pendingClaims.clear();
        this.contract = null;
        this.webSocket = null;
        this.isInitialized = false;
        this.isInitializing = false;
        this.currentMode = null;
    }
}
