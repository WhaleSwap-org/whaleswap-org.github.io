import { BaseComponent } from './components/BaseComponent.js';
import { CreateOrder } from './components/CreateOrder.js';
import { APP_BRAND, APP_LOGO, WALLET_COMPATIBILITY_NOTICE } from './config/index.js';
import { DEBUG_CONFIG } from './config/debug.js';
import {
	getNetworkConfig,
	getAllNetworks,
	getNetworkById,
	getNetworkBySlug,
	getDefaultNetwork,
	getRequestedNetworkSlugFromUrl,
	setActiveNetwork
} from './config/networks.js';
import { walletManager } from './services/WalletManager.js';
import { WalletUI } from './components/WalletUI.js';
import { WebSocketService } from './services/WebSocket.js';
import { ViewOrders } from './components/ViewOrders.js';
import { MyOrders } from './components/MyOrders.js';
import { Claim } from './components/Claim.js';
import { TakerOrders } from './components/TakerOrders.js';
import { Cleanup } from './components/Cleanup.js';
import { ContractParams } from './components/ContractParams.js';
import { PricingService } from './services/PricingService.js';
import { contractService } from './services/ContractService.js';
import { createLogger } from './services/LogService.js';
import { DebugPanel } from './components/DebugPanel.js';
import { getToast, showError, showSuccess, showWarning, showInfo } from './components/Toast.js';
import { Footer } from './components/Footer.js';
import { Intro } from './components/Intro.js';
import { Admin } from './components/Admin.js';
import { versionService } from './services/VersionService.js';
import { createAppContext, setGlobalContext } from './services/AppContext.js';
import { hasAnyClaimables } from './utils/claims.js';
import { isUserRejection } from './utils/ui.js';
import { escapeHtml } from './utils/html.js';
import { clearBalanceCache } from './utils/contractTokens.js';

const BOOTSTRAP_LOADER_STATE_KEY = 'whaleswapBootstrapLoader';
const ACTIVE_TAB_STATE_KEY = 'whaleswapActiveTab';
class App {
	constructor() {
		this.isInitializing = false;
		this.isReinitializing = false;
		this.globalLoader = null;
		this.tabRail = null;
		this.tabRailShell = null;
		this.tabRailLeftArrow = null;
		this.tabRailRightArrow = null;
		this.tabRailResizeHandler = null;
		this.tabRailScrollHandler = null;
		this.tabRailLeftArrowHandler = null;
		this.tabRailRightArrowHandler = null;
		this.initialOrderSyncPromise = null;
		this.tabReady = new Set();
		this.activeTabRequestId = 0;
		this.claimTabVisibilityRequestId = 0;
		this.claimTabVisibilityKnown = false;
		this.claimTabLastVisible = false;
		this.orderTabVisibilityRequestId = 0;
		this.orderTabVisibilityRefreshTimer = null;
		this.claimVisibilityRefreshTimer = null;
		this.claimVisibilityRetryTimer = null;
		this.claimVisibilityRetryBaseDelayMs = 500;
		this.claimVisibilityRetryDelayMs = this.claimVisibilityRetryBaseDelayMs;
		this.claimVisibilityRetryMaxDelayMs = 5000;
		this.claimVisibilityCacheTtlMs = 1500;
		this.claimVisibilityCheckedAtMs = 0;
		this.claimVisibilityCacheKey = null;
		this.activeNetworkTransitionPromise = null;
		this.activeNetworkTransitionSlug = null;
		this.pendingWalletSwitchRequest = null;

		// Replace debug initialization with LogService
		const logger = createLogger('APP');
		this.debug = logger.debug.bind(logger);
		this.error = logger.error.bind(logger);
		this.warn = logger.warn.bind(logger);

		this.debug('App constructor called');
	}

	async handleWalletConnectEvent(data = {}) {
		const walletChainId = data?.chainId || walletManager.chainId || null;
		const isMetaMaskWallet = typeof data?.isMetaMaskWallet === 'boolean'
			? data.isMetaMaskWallet
			: walletManager.isConnectedWalletMetaMask();
		const shouldShowCompatibilityNotice = data?.userInitiated === true && !isMetaMaskWallet;

		clearNetworkSetupRequired();
		this.ctx.setWalletChainId(walletChainId);
		syncNetworkBadgeFromState();

		if (shouldShowCompatibilityNotice) {
			this.showWarning(WALLET_COMPATIBILITY_NOTICE);
		}

		this.debug('Wallet connected, reinitializing components...');
		this.updateTabVisibility(true);
		await this.refreshAdminTabVisibility();
		await this.refreshClaimTabVisibility();
		await this.refreshOrderTabVisibility();
		// Preserve WebSocket order cache to avoid clearing orders on connect
		await this.reinitializeComponents(true);
	}

	isOrdersTab(tabId = this.currentTab) {
		return tabId === 'view-orders'
			|| tabId === 'my-orders'
			|| tabId === 'taker-orders'
			|| tabId === 'cleanup-orders';
	}

	isWalletConnectedForUi() {
		const wallet = this.ctx?.getWallet?.() || walletManager;
		return Boolean(
			wallet?.isWalletConnected?.()
			|| wallet?.getAccount?.()
			|| wallet?.getSigner?.()
		);
	}

	getTabButton(tabId) {
		return document.querySelector(`.tab-button[data-tab="${tabId}"]`);
	}

	setTabVisible(tabId, isVisible) {
		const button = this.getTabButton(tabId);
		if (!button) return null;
		button.style.display = isVisible ? 'block' : 'none';
		return button;
	}

	isTabVisible(tabId) {
		const button = this.getTabButton(tabId);
		return !!button && button.style.display !== 'none';
	}

	getNoOrderTabsVisibility() {
		return {
			showMyOrders: false,
			showInvitedOrders: false
		};
	}

	buildOrderTabVisibilityFromOrders(orders = [], account = '') {
		const normalizedAccount = String(account || '').toLowerCase();
		if (!normalizedAccount) return this.getNoOrderTabsVisibility();

		return {
			showMyOrders: orders.some((order) => String(order?.maker || '').toLowerCase() === normalizedAccount),
			showInvitedOrders: orders.some((order) => String(order?.taker || '').toLowerCase() === normalizedAccount)
		};
	}

	isClaimEventForCurrentAccount(eventData = null) {
		if (!eventData?.beneficiary) {
			return true;
		}

		const wallet = this.ctx?.getWallet?.();
		const account = wallet?.getAccount?.();
		if (!account) return false;

		try {
			return eventData.beneficiary.toLowerCase() === account.toLowerCase();
		} catch (_) {
			return false;
		}
	}

	getClaimVisibilityCacheKey() {
		const wallet = this.ctx?.getWallet?.();
		const isConnected = !!wallet?.isWalletConnected?.();
		const account = String(wallet?.getAccount?.() || '').toLowerCase();
		const selectedSlug = String(this.ctx?.getSelectedChainSlug?.() || '').toLowerCase();
		const walletChainId = String(
			this.ctx?.getWalletChainId?.() ?? walletManager.chainId ?? ''
		).toLowerCase();

		return `${isConnected ? '1' : '0'}|${account}|${selectedSlug}|${walletChainId}`;
	}

	scheduleClaimTabVisibilityRefresh(eventData = null, { force = true } = {}) {
		if (eventData && !this.isClaimEventForCurrentAccount(eventData)) {
			return;
		}

		this.clearClaimVisibilityRetryTimer();
		if (this.claimVisibilityRefreshTimer) {
			clearTimeout(this.claimVisibilityRefreshTimer);
		}

		this.claimVisibilityRefreshTimer = setTimeout(() => {
			this.claimVisibilityRefreshTimer = null;
			this.refreshClaimTabVisibility({ force }).catch((error) => {
				this.debug('Scheduled claim visibility refresh failed:', error);
			});
		}, 120);
	}

	clearOrderTabVisibilityRefreshTimer() {
		if (this.orderTabVisibilityRefreshTimer) {
			clearTimeout(this.orderTabVisibilityRefreshTimer);
			this.orderTabVisibilityRefreshTimer = null;
		}
	}

	scheduleOrderTabVisibilityRefresh({ force = true } = {}) {
		this.clearOrderTabVisibilityRefreshTimer();
		this.orderTabVisibilityRefreshTimer = setTimeout(() => {
			this.orderTabVisibilityRefreshTimer = null;
			this.refreshOrderTabVisibility({ force }).catch((error) => {
				this.debug('Scheduled order-tab visibility refresh failed:', error);
			});
		}, 120);
	}

	async refreshOrderTabVisibility(options = {}) {
		const { force = false } = options;
		const myOrdersButton = this.getTabButton('my-orders');
		const invitedOrdersButton = this.getTabButton('taker-orders');
		const noOrderTabsVisibility = this.getNoOrderTabsVisibility();
		if (!myOrdersButton && !invitedOrdersButton) {
			return noOrderTabsVisibility;
		}

		const requestId = ++this.orderTabVisibilityRequestId;
		const isCurrentRequest = () => requestId === this.orderTabVisibilityRequestId;
		const fallback = {
			showMyOrders: this.isTabVisible('my-orders'),
			showInvitedOrders: this.isTabVisible('taker-orders')
		};

		const applyVisibility = async (
			visibility,
			{ allowRedirect = true } = {}
		) => {
			if (!isCurrentRequest()) return visibility;

			this.setTabVisible('my-orders', visibility.showMyOrders);
			this.setTabVisible('taker-orders', visibility.showInvitedOrders);

			if (allowRedirect) {
				if (!visibility.showMyOrders && this.currentTab === 'my-orders') {
					await this.showTab('view-orders');
				}
				if (!visibility.showInvitedOrders && this.currentTab === 'taker-orders') {
					await this.showTab('view-orders');
				}
			}

			this.updateTabRailOverflowState();
			return visibility;
		};

		try {
			const wallet = this.ctx?.getWallet?.();
			const isConnected = !!wallet?.isWalletConnected?.();
			const account = wallet?.getAccount?.();

			if (!isConnected || !account) {
				return await applyVisibility(noOrderTabsVisibility);
			}

			const ws = this.ctx?.getWebSocket?.();
			if (!ws) {
				return await applyVisibility(noOrderTabsVisibility);
			}

			// Never block UI on WebSocket readiness / order sync. If the cache
			// isn't ready yet, keep tabs hidden and re-check shortly.
			if (force || !ws.hasCompletedOrderSync) {
				void ws.waitForInitialization?.()
					.then(() => ws.waitForOrderSync?.({ triggerIfNeeded: true }))
					.then(() => this.scheduleOrderTabVisibilityRefresh({ force: false }))
					.catch((error) => this.debug('Deferred order-tab visibility refresh failed:', error));
				return await applyVisibility(noOrderTabsVisibility, { allowRedirect: false });
			}

			const orders = Array.from(ws.orderCache?.values?.() || []);
			const visibility = this.buildOrderTabVisibilityFromOrders(orders, account);
			return await applyVisibility(visibility);
		} catch (error) {
			this.debug('Order tab visibility check failed:', error);
			return await applyVisibility(fallback, {
				allowRedirect: false
			});
		}
	}

	clearClaimVisibilityRetryTimer() {
		if (this.claimVisibilityRetryTimer) {
			clearTimeout(this.claimVisibilityRetryTimer);
			this.claimVisibilityRetryTimer = null;
		}
	}

	resetClaimVisibilityRetryBackoff() {
		this.claimVisibilityRetryDelayMs = this.claimVisibilityRetryBaseDelayMs;
	}

	scheduleClaimVisibilityRetry() {
		if (this.claimVisibilityRetryTimer) {
			return;
		}

		const delay = Math.min(
			Math.max(this.claimVisibilityRetryDelayMs, this.claimVisibilityRetryBaseDelayMs),
			this.claimVisibilityRetryMaxDelayMs
		);

		this.claimVisibilityRetryTimer = setTimeout(() => {
			this.claimVisibilityRetryTimer = null;
			this.refreshClaimTabVisibility({ force: true }).catch((error) => {
				this.debug('Claim visibility retry failed:', error);
				this.scheduleClaimVisibilityRetry();
			});
		}, delay);

		this.claimVisibilityRetryDelayMs = Math.min(
			delay * 2,
			this.claimVisibilityRetryMaxDelayMs
		);
	}

	async refreshClaimTabVisibility(options = {}) {
		const { force = false } = options;
		const claimButton = document.querySelector('.tab-button[data-tab="claim"]');
		if (!claimButton) return false;

		const cacheKey = this.getClaimVisibilityCacheKey();
		const cacheAge = Date.now() - this.claimVisibilityCheckedAtMs;
		const canUseCache = !force
			&& this.claimTabVisibilityKnown
			&& this.claimVisibilityCacheKey === cacheKey
			&& cacheAge >= 0
			&& cacheAge <= this.claimVisibilityCacheTtlMs
			&& !this.claimVisibilityRetryTimer;
		if (canUseCache) {
			claimButton.style.display = this.claimTabLastVisible ? 'block' : 'none';
			return this.claimTabLastVisible;
		}

		const requestId = ++this.claimTabVisibilityRequestId;
		const isCurrentRequest = () => requestId === this.claimTabVisibilityRequestId;
		const fallbackVisible = this.claimTabVisibilityKnown
			? this.claimTabLastVisible
			: claimButton.style.display !== 'none';
		const resolveVisibilityResult = (valueWhenCurrent) => (
			isCurrentRequest()
				? valueWhenCurrent
				: (this.claimTabVisibilityKnown ? this.claimTabLastVisible : fallbackVisible)
		);
		const applyVisibility = async (
			visible,
			{ authoritative = true, allowRedirect = true } = {}
		) => {
			if (requestId !== this.claimTabVisibilityRequestId) return false;
			claimButton.style.display = visible ? 'block' : 'none';

			if (authoritative) {
				this.claimTabVisibilityKnown = true;
				this.claimTabLastVisible = visible;
				if (isCurrentRequest()) {
					this.claimVisibilityCheckedAtMs = Date.now();
					this.claimVisibilityCacheKey = cacheKey;
				}
			}

			if (allowRedirect && !visible && this.currentTab === 'claim') {
				await this.showTab('view-orders');
			}

			this.updateTabRailOverflowState();
			return visible;
		};

		try {
			const wallet = this.ctx?.getWallet?.();
			const isConnected = !!wallet?.isWalletConnected?.();
			const userAddress = wallet?.getAccount?.();

				if (!isConnected || !userAddress) {
					if (isCurrentRequest()) {
						this.clearClaimVisibilityRetryTimer();
						this.resetClaimVisibilityRetryBackoff();
					}
					await applyVisibility(false);
					return resolveVisibilityResult(false);
				}

			const ws = this.ctx?.getWebSocket?.();
			// Do not block UI on WS readiness. Use HTTP contract reads for
			// visibility checks to avoid stalls during rapid chain toggles.
			const contract = await contractService.readViaHttpRpc(({ contract: httpContract }) => httpContract);
				if (!contract) {
					await applyVisibility(fallbackVisible, {
						authoritative: false,
						allowRedirect: false
					});
					if (isCurrentRequest()) {
						this.scheduleClaimVisibilityRetry();
					}
					return resolveVisibilityResult(fallbackVisible);
				}

			const hasClaims = await hasAnyClaimables({
				contract,
				userAddress
			});

				if (isCurrentRequest()) {
					this.clearClaimVisibilityRetryTimer();
					this.resetClaimVisibilityRetryBackoff();
				}
				await applyVisibility(hasClaims);
				return resolveVisibilityResult(hasClaims);
			} catch (error) {
				this.debug('Claim tab visibility check failed:', error);
				await applyVisibility(fallbackVisible, {
					authoritative: false,
					allowRedirect: false
				});
				if (isCurrentRequest()) {
					this.scheduleClaimVisibilityRetry();
				}
				return resolveVisibilityResult(fallbackVisible);
			}
		}

	async refreshActiveOrdersTab() {
		if (!this.isOrdersTab()) return;
		const activeComponent = this.components?.[this.currentTab];
		if (!activeComponent) return;

		try {
			if (typeof activeComponent.refreshOrdersView === 'function') {
				await activeComponent.refreshOrdersView();
				return;
			}

			if (typeof activeComponent.checkCleanupOpportunities === 'function') {
				await activeComponent.checkCleanupOpportunities();
				return;
			}

			if (typeof activeComponent.initialize === 'function') {
				const wallet = this.ctx?.getWallet?.();
				const readOnlyMode = !wallet?.isWalletConnected?.();
				await activeComponent.initialize(readOnlyMode);
			}
		} catch (error) {
			this.debug('Failed to refresh active orders tab after sync:', error);
		}
	}

	startInitialOrderSync(ws = this.ctx?.getWebSocket?.()) {
		if (!ws || this.initialOrderSyncPromise) return;

		this.initialOrderSyncPromise = (async () => {
			this.debug('Starting background initial order sync...');
			await ws.waitForOrderSync({ triggerIfNeeded: true });
			this.debug('Background initial order sync complete');
		})()
			.catch((error) => {
				this.debug('Background initial order sync failed:', error);
			})
			.finally(() => {
				this.initialOrderSyncPromise = null;
			});
	}

	initializeTabRail() {
		this.tabRail = document.querySelector('[data-mobile-tab-rail="true"]');
		this.tabRailShell = document.querySelector('[data-tab-rail-shell]');
		this.tabRailLeftArrow = document.querySelector('[data-tab-rail-arrow="left"]');
		this.tabRailRightArrow = document.querySelector('[data-tab-rail-arrow="right"]');
		if (!this.tabRail) return;

		if (!this.tabRailScrollHandler) {
			this.tabRailScrollHandler = () => this.updateTabRailOverflowState();
			this.tabRail.addEventListener('scroll', this.tabRailScrollHandler, { passive: true });
		}

		if (this.tabRailLeftArrow && !this.tabRailLeftArrowHandler) {
			this.tabRailLeftArrowHandler = () => this.scrollTabRailBy(-1);
			this.tabRailLeftArrow.addEventListener('click', this.tabRailLeftArrowHandler);
		}

		if (this.tabRailRightArrow && !this.tabRailRightArrowHandler) {
			this.tabRailRightArrowHandler = () => this.scrollTabRailBy(1);
			this.tabRailRightArrow.addEventListener('click', this.tabRailRightArrowHandler);
		}

		if (!this.tabRailResizeHandler) {
			this.tabRailResizeHandler = () => this.updateTabRailOverflowState();
			window.addEventListener('resize', this.tabRailResizeHandler);
		}

		this.updateTabRailOverflowState();
	}

	scrollTabRailBy(direction = 1) {
		if (!this.tabRail) return;
		const distance = Math.max(Math.floor(this.tabRail.clientWidth * 0.7), 140);
		this.tabRail.scrollBy({
			left: distance * direction,
			behavior: 'smooth'
		});
	}

	updateTabRailOverflowState() {
		if (!this.tabRail || !this.tabRailShell) return;

		const isSmallScreen = window.matchMedia('(max-width: 768px)').matches;
		const hasOverflow = this.tabRail.scrollWidth - this.tabRail.clientWidth > 6;
		const shouldShowArrows = isSmallScreen && hasOverflow;
		const wasShowingArrows = this.tabRailShell.classList.contains('is-overflowing');
		const canScrollLeft = this.tabRail.scrollLeft > 4;
		const canScrollRight = this.tabRail.scrollLeft + this.tabRail.clientWidth < this.tabRail.scrollWidth - 4;

		this.tabRailShell.classList.toggle('is-overflowing', shouldShowArrows);

		if (wasShowingArrows !== shouldShowArrows) {
			window.requestAnimationFrame(() => this.updateTabRailOverflowState());
			return;
		}

		if (this.tabRailLeftArrow) {
			this.tabRailLeftArrow.disabled = !(shouldShowArrows && canScrollLeft);
		}
		if (this.tabRailRightArrow) {
			this.tabRailRightArrow.disabled = !(shouldShowArrows && canScrollRight);
		}
	}

	getTabSkeletonVariant(tabId) {
		if (tabId === 'view-orders' || tabId === 'my-orders' || tabId === 'taker-orders') {
			return 'orders';
		}
		if (tabId === 'create-order') {
			return 'form';
		}
		return 'stats';
	}

	getSkeletonMarkupByVariant(variant = 'form') {
		if (variant === 'app') {
			return `
				<div class="loading-skeleton loading-skeleton--app" aria-hidden="true">
					<div class="skeleton-app-header">
						<div class="skeleton-app-brand">
							<div class="skeleton-block skeleton-app-logo"></div>
							<div class="skeleton-app-brand-lines">
								<div class="skeleton-block skeleton-app-title"></div>
								<div class="skeleton-block skeleton-app-version"></div>
							</div>
						</div>
						<div class="skeleton-app-wallet">
							<div class="skeleton-block skeleton-app-pill skeleton-app-pill--network"></div>
							<div class="skeleton-block skeleton-app-pill skeleton-app-pill--account"></div>
						</div>
					</div>
					<div class="skeleton-app-shell">
						<div class="skeleton-app-tabs-row">
							<div class="skeleton-block skeleton-app-tab skeleton-app-tab--sm"></div>
							<div class="skeleton-block skeleton-app-tab skeleton-app-tab--md"></div>
							<div class="skeleton-block skeleton-app-tab skeleton-app-tab--md"></div>
							<div class="skeleton-block skeleton-app-tab skeleton-app-tab--md"></div>
							<div class="skeleton-block skeleton-app-tab skeleton-app-tab--md"></div>
							<div class="skeleton-block skeleton-app-tab skeleton-app-tab--sm"></div>
							<div class="skeleton-block skeleton-app-tab skeleton-app-tab--sm"></div>
						</div>
						<div class="skeleton-block skeleton-app-divider"></div>
						<div class="skeleton-app-main">
							<div class="skeleton-app-form">
								<div class="skeleton-block skeleton-app-token"></div>
								<div class="skeleton-block skeleton-app-arrow"></div>
								<div class="skeleton-block skeleton-app-token"></div>
								<div class="skeleton-block skeleton-app-line"></div>
								<div class="skeleton-block skeleton-app-line skeleton-app-line--short"></div>
								<div class="skeleton-block skeleton-app-button"></div>
							</div>
						</div>
						<div class="skeleton-block skeleton-app-footer"></div>
					</div>
				</div>
			`;
		}

		if (variant === 'orders') {
			return `
				<div class="loading-skeleton loading-skeleton--orders loading-skeleton--compact" aria-hidden="true">
					<div class="skeleton-block skeleton-block--orders-filter"></div>
					<div class="skeleton-block skeleton-block--orders-head"></div>
					<div class="skeleton-orders-row">
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
					</div>
					<div class="skeleton-orders-row">
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
					</div>
					<div class="skeleton-orders-row">
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
						<span class="skeleton-block skeleton-orders-cell"></span>
					</div>
				</div>
			`;
		}

		if (variant === 'stats') {
			return `
				<div class="loading-skeleton loading-skeleton--stats loading-skeleton--compact" aria-hidden="true">
					<div class="skeleton-block skeleton-block--stats-title"></div>
					<div class="skeleton-stats-grid">
						<div class="skeleton-block skeleton-block--stats-card"></div>
						<div class="skeleton-block skeleton-block--stats-card"></div>
						<div class="skeleton-block skeleton-block--stats-card"></div>
					</div>
					<div class="skeleton-block skeleton-block--stats-row"></div>
				</div>
			`;
		}

		return `
			<div class="loading-skeleton loading-skeleton--form loading-skeleton--compact" aria-hidden="true">
				<div class="skeleton-block skeleton-block--form-title"></div>
				<div class="skeleton-block skeleton-block--form-group"></div>
				<div class="skeleton-block skeleton-block--form-group"></div>
				<div class="skeleton-block skeleton-block--form-group"></div>
				<div class="skeleton-block skeleton-block--form-button"></div>
			</div>
		`;
	}

	getSkeletonLoaderMarkup(message = 'Loading...', variant = 'form') {
		return `
			${this.getSkeletonMarkupByVariant(variant)}
			<div class="loading-text">${escapeHtml(message)}</div>
		`;
	}

	getGlobalLoaderMarkup(message = 'Loading WhaleSwap...', variant = 'app') {
		return `
			<div class="loading-indicator loading-indicator--spinner" aria-hidden="true">
				<div class="loading-spinner"></div>
			</div>
			${this.getSkeletonMarkupByVariant(variant)}
			<div class="loading-text">${escapeHtml(message)}</div>
		`;
	}

	resolveGlobalLoaderMode(mode = null) {
		if (mode === 'spinner' || mode === 'skeleton') {
			return mode;
		}
		if (this.globalLoader?.dataset?.loaderMode === 'spinner') {
			return 'spinner';
		}
		return document.documentElement?.dataset?.bootstrapLoaderMode === 'spinner'
			? 'spinner'
			: 'skeleton';
	}

	ensureGlobalLoaderMarkup(loader, message = 'Loading WhaleSwap...') {
		if (!loader) return;
		if (loader.querySelector('.loading-indicator--spinner') && loader.querySelector('.loading-skeleton')) {
			return;
		}
		loader.innerHTML = this.getGlobalLoaderMarkup(message, 'app');
	}

	setGlobalLoaderMode(mode = null) {
		if (!this.globalLoader) return;
		const resolvedMode = this.resolveGlobalLoaderMode(mode);
		this.globalLoader.dataset.loaderMode = resolvedMode;
		this.globalLoader.classList.toggle('loading-overlay--spinner', resolvedMode === 'spinner');
		if (document.documentElement?.dataset) {
			document.documentElement.dataset.bootstrapLoaderMode = resolvedMode;
		}
	}

	persistBootstrapLoaderState({ mode = 'spinner', message = 'Loading WhaleSwap...' } = {}) {
		try {
			const historyState = window.history?.state || {};
			window.history?.replaceState?.(
				{
					...historyState,
					[BOOTSTRAP_LOADER_STATE_KEY]: {
						mode: mode === 'spinner' ? 'spinner' : 'skeleton',
						message: String(message || '')
					},
					[ACTIVE_TAB_STATE_KEY]: this.currentTab || 'view-orders'
				},
				'',
				window.location.href
			);
		} catch (error) {
			this.debug('Failed to persist bootstrap loader state:', error);
		}
	}

	persistActiveTabState(tabId = this.currentTab || 'view-orders') {
		try {
			const nextTabId = String(tabId || '').trim();
			if (!nextTabId) {
				return;
			}

			const historyState = window.history?.state || {};
			window.history?.replaceState?.(
				{
					...historyState,
					[ACTIVE_TAB_STATE_KEY]: nextTabId
				},
				'',
				window.location.href
			);
		} catch (error) {
			this.debug('Failed to persist active tab state:', error);
		}
	}

	getDefaultInitialTab(hasInitialConnectedContext = false) {
		return hasInitialConnectedContext ? 'create-order' : 'view-orders';
	}

	resolveInitialTab(restoredTab, hasInitialConnectedContext = false) {
		const fallbackTab = this.getDefaultInitialTab(hasInitialConnectedContext);
		const normalizedRestoredTab = String(restoredTab || '').trim();
		return normalizedRestoredTab && this.isTabVisible(normalizedRestoredTab)
			? normalizedRestoredTab
			: fallbackTab;
	}

	showGlobalLoader(message = 'Loading WhaleSwap...', options = {}) {
		const { mode = null } = options;
		if (window.__bootstrapLoaderTimeout) {
			clearTimeout(window.__bootstrapLoaderTimeout);
			window.__bootstrapLoaderTimeout = null;
		}

		if (this.globalLoader?.parentElement) {
			this.globalLoader.classList.remove('is-slow');
			this.ensureGlobalLoaderMarkup(this.globalLoader, message);
			this.setGlobalLoaderMode(mode);
			const hint = this.globalLoader.querySelector('[data-loader-hint]');
			const retry = this.globalLoader.querySelector('[data-loader-retry]');
			if (hint) hint.hidden = true;
			if (retry) retry.hidden = true;
			this.updateGlobalLoaderText(message);
			return this.globalLoader;
		}

		const existingLoader = document.getElementById('app-bootstrap-loader')
			|| document.querySelector('.loading-overlay--global');
		if (existingLoader) {
			this.globalLoader = existingLoader;
			this.globalLoader.classList.remove('is-slow');
			this.ensureGlobalLoaderMarkup(this.globalLoader, message);
			this.setGlobalLoaderMode(mode);
			const hint = this.globalLoader.querySelector('[data-loader-hint]');
			const retry = this.globalLoader.querySelector('[data-loader-retry]');
			if (hint) hint.hidden = true;
			if (retry) retry.hidden = true;
			this.updateGlobalLoaderText(message);
			return this.globalLoader;
		}

		const loader = document.createElement('div');
		loader.className = 'loading-overlay loading-overlay--global';
		loader.innerHTML = this.getGlobalLoaderMarkup(message, 'app');
		document.body.appendChild(loader);
		this.globalLoader = loader;
		this.setGlobalLoaderMode(mode);
		return loader;
	}

	updateGlobalLoaderText(message) {
		if (!this.globalLoader) return;
		const textEl = this.globalLoader.querySelector('.loading-text');
		if (textEl) {
			textEl.textContent = message;
		}
	}

	hideGlobalLoader() {
		if (window.__bootstrapLoaderTimeout) {
			clearTimeout(window.__bootstrapLoaderTimeout);
			window.__bootstrapLoaderTimeout = null;
		}
		if (this.globalLoader?.parentElement) {
			this.globalLoader.remove();
		}
		this.globalLoader = null;
		if (document.documentElement?.dataset) {
			document.documentElement.dataset.bootstrapLoaderMode = 'skeleton';
		}
	}

	getSelectedNetwork() {
		const selectedSlug = this.ctx?.getSelectedChainSlug?.();
		return getNetworkBySlug(selectedSlug) || getDefaultNetwork();
	}

	alignSelectedNetworkToRestoredWallet() {
		const requestedSlug = getChainSlugFromUrl();
		if (requestedSlug) {
			return false;
		}

		const walletChainId = this.ctx?.getWalletChainId?.() ?? walletManager.chainId ?? null;
		if (!walletChainId) {
			return false;
		}

		const walletNetwork = getNetworkById(walletChainId);
		const selectedNetwork = this.getSelectedNetwork();
		if (!walletNetwork || walletNetwork.slug === selectedNetwork.slug) {
			return false;
		}

		this.debug(
			'No chain requested in URL; aligning selected network to restored wallet chain:',
			walletNetwork.slug
		);
		applySelectedNetwork(walletNetwork, { updateUrl: true });
		return true;
	}

	isWalletOnSelectedNetwork(chainId = null) {
		const walletChainId = chainId ?? this.ctx?.getWalletChainId?.() ?? walletManager.chainId ?? null;
		const walletNetwork = getNetworkById(walletChainId);
		const selectedNetwork = this.getSelectedNetwork();
		return !!(walletNetwork && selectedNetwork && walletNetwork.slug === selectedNetwork.slug);
	}

	getWalletRuntimeNetwork() {
		const walletChainId = this.ctx?.getWalletChainId?.() ?? walletManager.chainId ?? null;
		return getNetworkById(walletChainId);
	}

	restoreSelectedNetwork(networkRef) {
		const network = getNetworkBySlug(networkRef?.slug || networkRef)
			|| getNetworkById(networkRef?.chainId || networkRef);
		if (!network) {
			return null;
		}

		clearNetworkSetupRequired();
		applySelectedNetwork(network, { updateUrl: true });
		return network;
	}

	getNetworkSwitchFailureWarning(error, targetNetwork, restoredNetwork = null) {
		const targetLabel = getNetworkLabel(targetNetwork);
		const restoredLabel = restoredNetwork ? getNetworkLabel(restoredNetwork) : null;
		const keptSelection = restoredNetwork && restoredNetwork.slug === targetNetwork?.slug;
		if (isNetworkAddRequiredError(error)) {
			if (restoredNetwork) {
				if (keptSelection) {
					return `Could not switch wallet to ${targetLabel} because it is not added in your wallet. Kept selection on ${restoredLabel}.`;
				}
				return `Could not switch wallet to ${targetLabel} because it is not added in your wallet. Restored selection to ${restoredLabel}.`;
			}
			return `Wallet still needs ${targetLabel} added.`;
		}

		if (isWalletUserRejectedError(error)) {
			if (restoredNetwork) {
				if (keptSelection) {
					return `Wallet request was cancelled. Kept selection on ${restoredLabel}.`;
				}
				return `Wallet request was cancelled. Restored selection to ${restoredLabel}.`;
			}
			return 'Wallet request was cancelled.';
		}

		if (restoredNetwork) {
			if (keptSelection) {
				return `Could not switch wallet to ${targetLabel}. Kept selection on ${restoredLabel}.`;
			}
			return `Could not switch wallet to ${targetLabel}. Restored selection to ${restoredLabel}.`;
		}

		return `Could not switch wallet to ${targetLabel}.`;
	}

	handleNetworkSwitchFailure(error, targetNetwork, options = {}) {
		const { restoreSelectionNetwork = null } = options;
		this.warn('Wallet network switch rejected/failed:', error);
		const missingNetwork = isNetworkAddRequiredError(error);
		const restoredNetwork = this.restoreSelectedNetwork(restoreSelectionNetwork);
		if (missingNetwork && restoredNetwork?.slug === targetNetwork?.slug) {
			setNetworkSetupRequired(targetNetwork.slug);
			syncNetworkBadgeFromState();
			syncAddNetworkButtonVisibility();
		}
		if (restoredNetwork) {
			this.showWarning(this.getNetworkSwitchFailureWarning(error, targetNetwork, restoredNetwork));
			return;
		}

		if (missingNetwork) {
			setNetworkSetupRequired(targetNetwork.slug);
			syncNetworkBadgeFromState();
			syncAddNetworkButtonVisibility();
			this.showWarning(this.getNetworkSwitchFailureWarning(error, targetNetwork));
			return;
		}
		clearNetworkSetupRequired();
		syncNetworkBadgeFromState();
		syncAddNetworkButtonVisibility();
		this.showWarning(this.getNetworkSwitchFailureWarning(error, targetNetwork));
	}

	getPendingWalletSwitchRequest(targetNetworkRef) {
		if (!this.pendingWalletSwitchRequest?.targetSlug) {
			return null;
		}

		const targetNetwork = getNetworkBySlug(targetNetworkRef?.slug || targetNetworkRef)
			|| getNetworkById(targetNetworkRef?.chainId || targetNetworkRef);
		if (!targetNetwork || targetNetwork.slug !== this.pendingWalletSwitchRequest.targetSlug) {
			return null;
		}

		return this.pendingWalletSwitchRequest;
	}

	async handleWalletChainChangedEvent(walletChainId) {
		const previousWalletChainId = this.ctx?.getWalletChainId?.() ?? null;
		this.debug('Chain changed event received:', walletChainId);
		this.ctx.setWalletChainId(walletChainId);
		syncNetworkBadgeFromState();

		const selectedNetwork = this.getSelectedNetwork();
		const walletNetwork = getNetworkById(walletChainId);
		if (walletNetwork && walletNetwork.slug === selectedNetwork.slug) {
			if (String(previousWalletChainId ?? '').toLowerCase() === String(walletChainId ?? '').toLowerCase()) {
				return;
			}

			const pendingSwitchRequest = this.getPendingWalletSwitchRequest(walletNetwork);
			if (pendingSwitchRequest?.selectedChainChanged === false) {
				await this.handleSuccessfulConnectedNetworkTransition(walletNetwork, {
					source: pendingSwitchRequest.source || 'wallet:chainChanged',
					selectedChainChanged: false,
					walletChainId,
				});
				return;
			}

			// Wallet now matches the selected chain: do a full reload
			// to adopt the new chain state from scratch (see
			// handleNetworkSelectionCommit for rationale). The active
			// tab is preserved via history.state.
			triggerPageReloadWithSwitchFallback({
				loaderMode: 'spinner',
				loaderMessage: `Switching to ${getNetworkLabel(walletNetwork)}...`
			});
			return;
		}

		this.updateTabVisibility(true);
		await this.refreshAdminTabVisibility();
		await this.refreshClaimTabVisibility();
		await this.refreshOrderTabVisibility();
	}

	subscribeToAppWebSocketEvents(ws = this.ctx?.getWebSocket?.()) {
		if (!ws?.subscribe) {
			return;
		}

		if (!this.boundOrderMutationHandler) {
			this.boundOrderMutationHandler = () => {
				this.debug('Order changed, refreshing components...');
				this.refreshActiveComponent();
				this.scheduleOrderTabVisibilityRefresh();
			};
		}

		if (!this.boundOrderSyncCompleteHandler) {
			this.boundOrderSyncCompleteHandler = () => {
				this.scheduleOrderTabVisibilityRefresh({ force: false });
			};
		}

		if (!this.boundClaimsUpdatedHandler) {
			this.boundClaimsUpdatedHandler = (eventData) => {
				this.scheduleClaimTabVisibilityRefresh(eventData);
			};
		}

		ws.subscribe('OrderCreated', this.boundOrderMutationHandler);
		ws.subscribe('OrderFilled', this.boundOrderMutationHandler);
		ws.subscribe('OrderCanceled', this.boundOrderMutationHandler);
		ws.subscribe('OrderCleanedUp', this.boundOrderMutationHandler);
		ws.subscribe('orderSyncComplete', this.boundOrderSyncCompleteHandler);
		ws.subscribe('claimsUpdated', this.boundClaimsUpdatedHandler);
	}

	async recreateNetworkServices() {
		// Clear balance cache on network switch (issue #174)
		// Note: Token metadata is stable and persists for TTL duration
		clearBalanceCache();
		
		const ws = this.ctx?.getWebSocket?.();
		if (ws?.cleanup) {
			try {
				ws.cleanup();
			} catch (error) {
				this.warn('Error cleaning up WebSocket service during network transition:', error);
			}
		}

		this.initialOrderSyncPromise = null;
		this.wsInitialized = false;
		this.loadingOverlay = this.globalLoader;

		await this.initializePricingService();
		await this.initializeWebSocket();
		this.subscribeToAppWebSocketEvents(this.ctx?.getWebSocket?.());
	}

	async handleWalletAlignedToSelectedNetwork(targetNetworkRef, options = {}) {
		const targetNetwork = getNetworkBySlug(targetNetworkRef?.slug || targetNetworkRef)
			|| getNetworkById(targetNetworkRef?.chainId || targetNetworkRef);
		if (!targetNetwork) {
			return false;
		}

		const {
			walletChainId = null,
		} = options;

		this.debug('Handling wallet alignment on already-selected network:', {
			targetNetwork: targetNetwork.slug,
		});

		this.ctx?.setWalletChainId?.(walletChainId ?? walletManager.chainId ?? targetNetwork.chainId);
		clearNetworkSetupRequired();
		setActiveNetwork(targetNetwork);
		syncNetworkBadgeFromState();

		return true;
	}

	async handleSuccessfulConnectedNetworkTransition(targetNetworkRef, options = {}) {
		const targetNetwork = getNetworkBySlug(targetNetworkRef?.slug || targetNetworkRef)
			|| getNetworkById(targetNetworkRef?.chainId || targetNetworkRef);
		if (!targetNetwork) {
			this.warn('Skipping connected network transition for unsupported network:', targetNetworkRef);
			return false;
		}

		if (
			this.activeNetworkTransitionPromise
			&& this.activeNetworkTransitionSlug === targetNetwork.slug
		) {
			return this.activeNetworkTransitionPromise;
		}

		const transitionPromise = (async () => {
			const {
				source = 'unknown',
				selectedChainChanged = false,
				walletChainId = null,
			} = options;
			const activeNetworkBeforeTransition = getNetworkConfig();
			const requiresNetworkDataRefresh = selectedChainChanged
				|| activeNetworkBeforeTransition?.slug !== targetNetwork.slug;
			const preferredTab = this.currentTab;
			const wallet = this.ctx?.getWallet?.();
			this.debug('Handling successful connected network transition:', {
				source,
				targetNetwork: targetNetwork.slug,
				selectedChainChanged,
				requiresNetworkDataRefresh,
			});

			if (!requiresNetworkDataRefresh) {
				try {
					return await this.handleWalletAlignedToSelectedNetwork(targetNetwork, {
						source,
						walletChainId,
					});
				} finally {
					if (this.pendingWalletSwitchRequest?.targetSlug === targetNetwork.slug) {
						this.pendingWalletSwitchRequest = null;
					}
				}
			}

			this.showGlobalLoader(`Switching to ${getNetworkLabel(targetNetwork)}...`, { mode: 'spinner' });
			this.loadingOverlay = this.globalLoader;

			try {
				this.ctx?.setWalletChainId?.(walletChainId ?? walletManager.chainId ?? targetNetwork.chainId);
				clearNetworkSetupRequired();
				setActiveNetwork(targetNetwork);
				syncNetworkBadgeFromState();

				await this.recreateNetworkServices();

				await this.reinitializeComponents({
					preserveOrders: false,
					createOrderResetOptions: {
						clearSelections: selectedChainChanged,
					},
					skipServiceCleanup: true,
					skipShowTab: true,
				});

				this.updateTabVisibility(true);
				await this.refreshAdminTabVisibility();
				await this.refreshClaimTabVisibility({ force: true });
				await this.refreshOrderTabVisibility({ force: true });

				const nextTab = this.isTabVisible(preferredTab) ? preferredTab : 'create-order';
				await this.showTab(nextTab, !wallet?.isWalletConnected?.(), {
					skipInitialize: this.tabReady.has(nextTab),
				});

				const refreshedWs = this.ctx?.getWebSocket?.();
				if (refreshedWs) {
					this.startInitialOrderSync(refreshedWs);
				}

				return true;
			} finally {
				if (this.pendingWalletSwitchRequest?.targetSlug === targetNetwork.slug) {
					this.pendingWalletSwitchRequest = null;
				}
				this.hideGlobalLoader();
				this.loadingOverlay = null;
			}
		})();

		this.activeNetworkTransitionSlug = targetNetwork.slug;
		this.activeNetworkTransitionPromise = transitionPromise.finally(() => {
			if (this.activeNetworkTransitionSlug === targetNetwork.slug) {
				this.activeNetworkTransitionSlug = null;
				this.activeNetworkTransitionPromise = null;
			}
		});

		return this.activeNetworkTransitionPromise;
	}

	async switchWalletToNetwork(targetNetwork, options = {}) {
		const resolvedTargetNetwork = getNetworkBySlug(targetNetwork?.slug || targetNetwork)
			|| getNetworkById(targetNetwork?.chainId || targetNetwork);
		if (!resolvedTargetNetwork) {
			this.warn('Wallet switch requested for unsupported network:', targetNetwork);
			return false;
		}

		const {
			source = 'unknown',
			selectedChainChanged = false,
			previousSelectedNetwork = null,
		} = options;
		const resolvedPreviousSelectedNetwork = getNetworkBySlug(previousSelectedNetwork?.slug || previousSelectedNetwork)
			|| getNetworkById(previousSelectedNetwork?.chainId || previousSelectedNetwork)
			|| this.getSelectedNetwork();

		this.pendingWalletSwitchRequest = {
			source,
			selectedChainChanged,
			previousSelectedSlug: resolvedPreviousSelectedNetwork?.slug || null,
			targetSlug: resolvedTargetNetwork.slug,
		};

		try {
			await walletManager.switchToNetwork(resolvedTargetNetwork);
		} catch (error) {
			const pendingSwitchRequest = this.pendingWalletSwitchRequest;
			if (this.pendingWalletSwitchRequest?.targetSlug === resolvedTargetNetwork.slug) {
				this.pendingWalletSwitchRequest = null;
			}
			this.handleNetworkSwitchFailure(error, resolvedTargetNetwork, {
				restoreSelectionNetwork: pendingSwitchRequest?.previousSelectedSlug || resolvedPreviousSelectedNetwork,
			});
			return false;
		}

		if (selectedChainChanged === false) {
			const walletChainId = getNetworkById(walletManager.chainId)?.slug === resolvedTargetNetwork.slug
				? walletManager.chainId
				: resolvedTargetNetwork.chainId;
			await this.handleSuccessfulConnectedNetworkTransition(resolvedTargetNetwork, {
				source,
				selectedChainChanged: false,
				walletChainId,
			});
			return true;
		}

		// The wallet's chainChanged event (see handler above) will fire
		// and trigger the full-reload path. Trigger it here as a safety
		// net in case the wallet does not emit chainChanged (some
		// providers skip the event when the chain is already correct).
		triggerPageReloadWithSwitchFallback({
			loaderMode: 'spinner',
			loaderMessage: `Switching to ${getNetworkLabel(resolvedTargetNetwork)}...`
		});
		return true;
	}

	async handleNetworkSelectionCommit(network, options = {}) {
		if (!network) return;
		if (isNetworkSelectorLockedByWalletAction()) {
			this.showWarning(NETWORK_SELECTOR_LOCK_WARNING);
			return false;
		}

		const {
			selectedChainChanged = true,
			previousSelectedNetwork = null,
		} = options;

		setActiveNetwork(network);

		const wallet = this.ctx?.getWallet?.();
		if (!wallet?.isWalletConnected?.()) {
			if (!selectedChainChanged) {
				return;
			}

			// Network switches always do a full page reload. In-page transitions
			// were a source of subtle bugs (stale WS subscriptions, orphaned
			// promises, half-torn-down contracts). A reload gives a guaranteed
			// clean slate, and the active tab is already preserved via
			// ACTIVE_TAB_STATE_KEY in history.state (see persistBootstrapLoaderState).
			triggerPageReloadWithSwitchFallback({
				loaderMode: 'spinner',
				loaderMessage: `Switching to ${getNetworkLabel(network)}...`
			});
			return;
		}

		if (!selectedChainChanged && this.isWalletOnSelectedNetwork()) {
			return;
		}

		return await this.switchWalletToNetwork(network, {
			source: 'header:network-selection',
			selectedChainChanged,
			previousSelectedNetwork,
		});
	}

	async load () {
		this.debug('Loading app components...');
		this.showGlobalLoader('Initializing app...');

		try {
			// Create application context for dependency injection
			this.ctx = createAppContext();
			setGlobalContext(this.ctx);
			const initialSelectedNetwork = getInitialSelectedNetwork();
			this.ctx.setSelectedChainSlug(initialSelectedNetwork.slug);
			setActiveNetwork(initialSelectedNetwork);
			this.debug('AppContext created');

			// Initialize toast component
			this.toast = getToast();
			this.debug('Toast component initialized');

				// Populate context with toast functions
				this.ctx.toast.showError = showError;
				this.ctx.toast.showSuccess = showSuccess;
				this.ctx.toast.showWarning = showWarning;
				this.ctx.toast.showInfo = showInfo;
				this.ctx.toast.createTransactionProgress = this.toast.createTransactionProgress.bind(this.toast);

			// Set brand in document title, header, and favicon from constants
			try {
				if (typeof APP_BRAND === 'string' && APP_BRAND.length > 0) {
					document.title = APP_BRAND;
					const headerTitle = document.querySelector('.header-left h1');
					if (headerTitle) {
						headerTitle.textContent = APP_BRAND;
					}
				}

				// Set favicon dynamically
				if (typeof APP_LOGO === 'string' && APP_LOGO.length > 0) {
					const favicon = document.querySelector('link[rel="icon"]');
					const shortcutIcon = document.querySelector('link[rel="shortcut icon"]');

					if (favicon) {
						favicon.href = APP_LOGO;
					}
					if (shortcutIcon) {
						shortcutIcon.href = APP_LOGO;
					}
				}
			} catch (e) {
				this.warn('Failed to set brand name in DOM', e);
			}

			this.updateGlobalLoaderText('Initializing wallet...');
			await this.initializeWalletManager();
			this.alignSelectedNetworkToRestoredWallet();
			const hasInitialConnectedContext = this.isWalletConnectedForUi();
			this.updateGlobalLoaderText('Initializing pricing...');
			await this.initializePricingService();
			this.updateGlobalLoaderText('Connecting to order feed...');
			// Never block initial paint (or reload-on-network-switch) on WS readiness.
			// Public WS endpoints can be intermittently slow/rate-limited; any waits here
			// can strand the global loader during rapid chain toggles.
			await this.initializeWebSocket({ awaitReady: false });

			// Initialize CreateOrder first
			this.components = {
				'create-order': new CreateOrder()
			};

			// Then initialize other components that might depend on CreateOrder's DOM elements
			this.components = {
				...this.components,  // Keep CreateOrder
				'view-orders': new ViewOrders(),
				'my-orders': new MyOrders(),
				'claim': new Claim(),
				'taker-orders': new TakerOrders(),
				'cleanup-orders': new Cleanup(),
				'contract-params': new ContractParams(),
				'admin': new Admin(),
				'intro': new Intro()
			};

			// Pass context to all components
			Object.values(this.components).forEach(component => {
				if (component && typeof component.setContext === 'function') {
					component.setContext(this.ctx);
				}
			});
			this.debug('Context passed to all components');

			// Initialize wallet UI and store reference
			this.walletUI = new WalletUI();
			this.walletUI.setContext(this.ctx);
			this.components['wallet-info'] = this.walletUI;

			// Initialize wallet UI early (it's always visible, not a tab)
			try {
				await this.walletUI.initialize();
			} catch (e) {
				this.warn('WalletUI failed to initialize', e);
			}

			// Initialize footer (persists across tabs)
			try {
				this.footer = new Footer('app-footer');
				this.footer.setContext(this.ctx);
				this.footer.initialize();
			} catch (e) {
				this.warn('Footer failed to initialize', e);
			}

			// Fallback for rendering components that are not CreateOrder, ViewOrders, TakerOrders, WalletUI, or Cleanup
			Object.entries(this.components).forEach(([id, component]) => {
				if (component instanceof BaseComponent &&
					!(component instanceof CreateOrder) &&
					!(component instanceof ViewOrders) &&
					!(component instanceof TakerOrders) &&
					!(component instanceof WalletUI) &&
					!(component instanceof Cleanup) &&
					!(component instanceof Claim) &&
					!(component instanceof Admin) &&
					!(component instanceof Intro)) {
					component.render = function() {
						if (!this.initialized) {
							this.container.innerHTML = `
								<div class="tab-content-wrapper">
									<h2>${this.container.id.split('-').map(word =>
										word.charAt(0).toUpperCase() + word.slice(1)
									).join(' ')}</h2>
									<p>Coming soon...</p>
								</div>
							`;
							this.initialized = true;
						}
					};
				}
			});

			// Restore active tab from history state if available (PR #178 review).
			// Resolve it only after initial tab visibility has been applied; some
			// tabs (for example cleanup-orders) start hidden in the HTML and are
			// made visible by updateTabVisibility().
			const historyState = window.history?.state || {};
			const restoredTab = historyState[ACTIVE_TAB_STATE_KEY];
			this.currentTab = this.getDefaultInitialTab(hasInitialConnectedContext);

				// Add wallet connection state handler
				walletManager.addListener(async (event, data) => {
					switch (event) {
						case 'connect': {
							await this.handleWalletConnectEvent(data);
							break;
						}
					case 'disconnect': {
						clearNetworkSetupRequired();
						this.ctx.setWalletChainId(null);
						syncNetworkBadgeFromState();
						this.debug('Wallet disconnected, updating tab visibility...');
						this.updateTabVisibility(false);
						await this.refreshAdminTabVisibility();
						await this.refreshClaimTabVisibility();
						await this.refreshOrderTabVisibility();
						// Clear CreateOrder state only; no need to initialize since tab is hidden
						try {
							const createOrderComponent = this.components['create-order'];
							if (createOrderComponent?.resetState) {
								createOrderComponent.resetState({
									clearSelections: true,
									preserveAllowedTokens: true,
								});
							}
						} catch (error) {
							console.warn('[App] Error resetting CreateOrder on disconnect:', error);
						}
						break;
					}
					case 'accountsChanged': {
						try {
							this.ctx.setWalletChainId(walletManager.chainId || null);
							syncNetworkBadgeFromState();

								this.debug('Account changed, reinitializing components...');
								this.updateTabVisibility(true);
								await this.refreshAdminTabVisibility();
								await this.refreshClaimTabVisibility();
								await this.refreshOrderTabVisibility();
								await this.reinitializeComponents({ preserveOrders: true });
								if (data?.account) {
									const short = `${data.account.slice(0,6)}...${data.account.slice(-4)}`;
									this.showInfo(`Switched account to ${short}`);
								} else {
									this.showInfo('Account changed');
								}
						} catch (error) {
							console.error('[App] Error handling accountsChanged:', error);
						}
						break;
					}
					case 'chainChanged': {
						try {
							await this.handleWalletChainChangedEvent(data?.chainId || null);
						} catch (error) {
							console.error('[App] Error handling chainChanged:', error);
						}
						break;
					}
				}
			});

			// Add tab switching event listeners
			this.initializeEventListeners();

			// Add WebSocket event handlers for order updates
			const ws = this.ctx.getWebSocket();
			this.subscribeToAppWebSocketEvents(ws);

			// Initialize debug panel
			const debugPanel = new DebugPanel();

			this.refreshAdminTabVisibility = async () => {
				const adminButton = document.querySelector('.tab-button[data-tab="admin"]');
				if (!adminButton) return false;

				const wallet = this.ctx.getWallet();
				if (!wallet?.isWalletConnected?.()) {
					adminButton.style.display = 'none';
					if (this.currentTab === 'admin') this.showTab('view-orders');
					return false;
				}

				if (DEBUG_CONFIG.ADMIN_BYPASS_OWNER_CHECK) {
					adminButton.style.display = 'block';
					return true;
				}

				try {
					// Keep hidden until owner check confirms visibility to avoid startup flicker.
					adminButton.style.display = 'none';
					const signer = await wallet.getSigner();
					const contract = await contractService.readViaHttpRpc(({ contract: httpContract }) => httpContract);
					if (!signer || !contract) throw new Error('Signer/contract unavailable');

					const [owner, account] = await Promise.all([
						contract.owner(),
						signer.getAddress()
					]);

					const isOwner = owner.toLowerCase() === account.toLowerCase();
					adminButton.style.display = isOwner ? 'block' : 'none';
					if (!isOwner && this.currentTab === 'admin') this.showTab('view-orders');
					return isOwner;
				} catch (error) {
					this.debug('Admin visibility check failed:', error);
					adminButton.style.display = 'none';
					if (this.currentTab === 'admin') this.showTab('view-orders');
					return false;
				}
			};

			// Add new method to update tab visibility
			this.updateTabVisibility = (isConnected) => {
				// Always visible tabs.
				this.setTabVisible('intro', true);
				this.setTabVisible('create-order', true);
				this.setTabVisible('view-orders', true);
				this.setTabVisible('cleanup-orders', true);
				this.setTabVisible('contract-params', true);

				// Visibility computed asynchronously from order cache.
				this.setTabVisible('my-orders', false);
				this.setTabVisible('taker-orders', false);

				// Connection-dependent tabs.
				this.setTabVisible('admin', isConnected);

				// Claim visibility is handled asynchronously after claimable checks.
				// Keep current state while connected to avoid flicker and fail-closed behavior.
				if (!isConnected) {
					this.setTabVisible('claim', false);
					this.claimTabVisibilityKnown = true;
					this.claimTabLastVisible = false;
					this.clearClaimVisibilityRetryTimer();
					this.resetClaimVisibilityRetryBackoff();
				}

				// If disconnected, only switch to view-orders if current tab is not visible
				if (!isConnected) {
					const visibleWhenDisconnected = new Set(['intro', 'create-order', 'view-orders', 'cleanup-orders', 'contract-params']);
					if (!visibleWhenDisconnected.has(this.currentTab)) {
						this.showTab('view-orders');
					}
				}

				this.scheduleOrderTabVisibilityRefresh();
				this.scheduleClaimTabVisibilityRefresh();
			};

			// Update initial tab visibility based on wallet connection only.
			this.updateTabVisibility(hasInitialConnectedContext);
			this.currentTab = this.resolveInitialTab(restoredTab, hasInitialConnectedContext);
			// Do not block first paint on owner check/network calls.
			Promise.resolve()
				.then(() => this.refreshAdminTabVisibility())
				.catch((error) => this.debug('Deferred admin visibility check failed:', error));
			Promise.resolve()
				.then(() => this.refreshClaimTabVisibility())
				.catch((error) => this.debug('Deferred claim visibility check failed:', error));
			Promise.resolve()
				.then(() => this.refreshOrderTabVisibility())
				.catch((error) => this.debug('Deferred order-tab visibility check failed:', error));

		// Add new property to track WebSocket readiness
		this.wsInitialized = false;

		// Alias for legacy references in WebSocket init callbacks
		this.loadingOverlay = this.globalLoader;

		// Add loading overlay to main content
		const mainContent = document.querySelector('.main-content');

		// Show main content after initialization
		if (mainContent) {
			mainContent.style.display = 'block';
		}

		// Initialize theme handling
		this.initializeTheme();

		// Treat connected wallets as connected UI even if the wallet chain differs.
		const initialReadOnlyMode = !hasInitialConnectedContext;
		this.updateGlobalLoaderText('Preparing interface...');
		await this.initializeComponents(initialReadOnlyMode);

		// Show the initial tab based on connection state (force read-only if needed for first paint)
		await this.showTab(this.currentTab, initialReadOnlyMode, { skipInitialize: true });

		// Remove loading overlay after initialization
		this.hideGlobalLoader();

		// Start initial order sync in the background so first render is not blocked.
		// Reuse ws variable from earlier in load() method
		if (ws) {
			this.startInitialOrderSync(ws);
		}

		this.lastDisconnectNotification = 0;
		} finally {
			this.hideGlobalLoader();
			this.loadingOverlay = null;
		}
	}

	initializeEventListeners() {
		// Add click handlers for tab buttons
		document.querySelectorAll('.tab-button').forEach(button => {
			button.addEventListener('click', (e) => {
				const tabId = e.target.dataset.tab;
				if (tabId) {
					this.showTab(tabId);
				}
			});
		});

		this.initializeTabRail();
	}

	async initializeWalletManager() {
		try {
			this.debug('Initializing wallet manager...');
			await walletManager.init(true);

			// Add to context
			this.ctx.wallet = walletManager;
			this.ctx.setWalletChainId(walletManager.chainId || null);

			this.debug('Wallet manager initialized');
		} catch (error) {
			this.debug('Wallet manager initialization error:', error);
		}
	}

	async initializePricingService() {
		try {
			this.debug('Initializing pricing service...');
			// Initialize PricingService first (before WebSocket since WS needs it)
			const pricingService = new PricingService();

			// Defer initial price refresh until WebSocket/contract provides allowed tokens.
			// WebSocket initialization triggers allowed token + price fetch afterward.
			await pricingService.initialize({ deferInitialRefresh: true });

			// Add to context
			this.ctx.pricing = pricingService;

			this.debug('Pricing service initialized');
		} catch (error) {
			this.debug('Pricing service initialization error:', error);
		}
	}

	async initializeWebSocket(options = {}) {
		const { awaitReady = true } = options;
		try {
			this.debug('Initializing WebSocket...');
			// Initialize WebSocket with injected pricingService
			const pricingService = this.ctx.getPricing();
			const webSocketService = new WebSocketService({
				pricingService: pricingService
			});

			// Wire shared services before WebSocket initialization kicks off any pricing reads.
			this.ctx.ws = webSocketService;
			if (pricingService) {
				pricingService.webSocket = webSocketService;
			}
			try {
				contractService.initialize({ webSocket: webSocketService });
				this.ctx.contractService = contractService;
			} catch (e) {
				this.debug('ContractService initialize skipped/failed:', e);
			}

			// Subscribe to orderSyncComplete event before initialization
			webSocketService.subscribe('orderSyncComplete', () => {
				this.wsInitialized = true;
				this.debug('WebSocket order sync complete, showing content');
				this.refreshActiveOrdersTab();
			});

			// Subscribe to order sync progress updates for UX
			webSocketService.subscribe('orderSyncProgress', ({ fetched, total, batch, totalBatches }) => {
				try {
					const textEl = this.loadingOverlay?.querySelector?.('.loading-text');
					if (textEl && typeof fetched === 'number' && typeof total === 'number') {
						textEl.textContent = `Loading orders ${Math.min(fetched, total)}/${total} (batch ${batch}/${totalBatches})`;
					}
				} catch (_) {}
			});

			const initializationPromise = webSocketService.initialize();
			if (awaitReady) {
				await initializationPromise;
				// Order sync will be triggered by startInitialOrderSync() after components are ready
			} else {
				this.debug('Starting WebSocket initialization in background');
				void initializationPromise.catch((error) => {
					this.debug('Background WebSocket initialization error:', error);
				});
			}

			this.debug('WebSocket initialized');
		} catch (error) {
			this.debug('WebSocket initialization error:', error);
		}
	}

	async initializeComponents(readOnlyMode) {
		try {
			this.debug('Initializing components in ' +
				(readOnlyMode ? 'read-only' : 'connected') + ' mode');

			// In read-only mode, initialize only the active tab.
			// Off-screen tabs initialize lazily when the user opens them.
			if (readOnlyMode) {
				const currentComponent = this.components[this.currentTab];
				if (currentComponent && typeof currentComponent.initialize === 'function') {
					this.debug(`Initializing read-only component: ${this.currentTab}`);
					try {
						await currentComponent.initialize(readOnlyMode);
						this.tabReady.add(this.currentTab);
					} catch (error) {
						console.error(`[App] Error initializing ${this.currentTab}:`, error);
					}
				}
			} else {
				// In connected mode, initialize the current tab's component
				const currentComponent = this.components[this.currentTab];
				if (currentComponent && typeof currentComponent.initialize === 'function') {
					this.debug(`Initializing current component: ${this.currentTab}`);
					try {
						await currentComponent.initialize(readOnlyMode);
						this.tabReady.add(this.currentTab);
					} catch (error) {
						console.error(`[App] Error initializing ${this.currentTab}:`, error);
					}
				}
			}

			this.debug('Components initialized');
		} catch (error) {
			console.error('[App] Error initializing components:', error);
			this.showError("Component failed to initialize. Limited functionality available.");
		}
	}

	handleWalletConnect = async (account) => {
		console.log('[App] Wallet connected:', account);
		try {
			await this.reinitializeComponents();
			// Force render create-order after connect
			await this.showTab('create-order');
		} catch (error) {
			console.error('[App] Error handling wallet connection:', error);
		}
	}

	handleWalletDisconnect() {
		// Debounce notifications by checking last notification time
		const now = Date.now();
		if (now - this.lastDisconnectNotification < 1000) { // 1 second debounce
			return;
		}
		this.lastDisconnectNotification = now;

		// Clear balance cache on wallet disconnect (issue #174)
		// Note: Token metadata is stable and persists for TTL duration
		clearBalanceCache();

		const walletConnectBtn = document.getElementById('walletConnect');
		const walletInfo = document.getElementById('walletInfo');
		const accountAddress = document.getElementById('accountAddress');

		if (walletConnectBtn) {
			walletConnectBtn.style.display = 'flex';
		}

		if (walletInfo) {
			walletInfo.classList.add('hidden');
		}

		if (accountAddress) {
			accountAddress.textContent = '';
		}

		this.showSuccess(
			"Wallet disconnected from site."
		);
	}

	prepareForNetworkReload(options = {}) {
		const {
			loaderMode = 'spinner',
			loaderMessage = 'Switching network...'
		} = options;

		this.persistBootstrapLoaderState({
			mode: loaderMode,
			message: loaderMessage
		});
		this.showGlobalLoader(loaderMessage, { mode: loaderMode });

		try {
			if (this.currentTab !== 'create-order') {
				return;
			}

			const createOrderComponent = this.components?.['create-order'];
			if (typeof createOrderComponent?.persistFormStateForReload === 'function') {
				createOrderComponent.persistFormStateForReload();
			}
		} catch (error) {
			this.debug('Failed to preserve create order form state before reload:', error);
		}
	}
	showLoader(container = document.body) {
		const loader = document.createElement('div');
		loader.className = 'loading-overlay';
		loader.innerHTML = this.getSkeletonLoaderMarkup('Loading...', 'form');

		if (container !== document.body) {
			container.style.position = 'relative';
		}
		container.appendChild(loader);
		return loader;
	}

	hideLoader(loader) {
		if (loader && loader.parentElement) {
			loader.parentElement.removeChild(loader);
		}
	}

	showError(message, duration = 0) {
		this.debug('Showing error toast:', message);
		return showError(message, duration);
	}

	showSuccess(message, duration = 5000) {
		this.debug('Showing success toast:', message);
		return showSuccess(message, duration);
	}

	showWarning(message, duration = 5000) {
		this.debug('Showing warning toast:', message);
		return showWarning(message, duration);
	}

	showInfo(message, duration = 5000) {
		this.debug('Showing info toast:', message);
		return showInfo(message, duration);
	}

	showToast(message, type = 'info', duration = 5000) {
		this.debug(`Showing ${type} toast:`, message);
		return this.toast.showToast(message, type, duration);
	}

	async showTab(tabId, readOnlyOverride = null, options = {}) {
		let loadingOverlay = null;
		const requestId = ++this.activeTabRequestId;
		try {
			this.debug('Switching to tab:', tabId);
			const { skipInitialize = false } = options;

				if (tabId === 'admin') {
					const isOwner = await this.refreshAdminTabVisibility();
					if (!isOwner) {
						this.showWarning('Admin tab is only available to the contract owner.');
						return;
					}
				}

				if (tabId === 'claim') {
					const hasClaims = await this.refreshClaimTabVisibility();
					if (!hasClaims) {
						if (this.claimTabVisibilityKnown) {
							this.showWarning('No claimable balances for connected wallet.');
						} else {
							this.showWarning('Unable to verify claimable balances right now. Please try again.');
						}
						return;
					}
				}

				if (tabId === 'my-orders' || tabId === 'taker-orders') {
					const { showMyOrders, showInvitedOrders } = await this.refreshOrderTabVisibility();
					const isVisible = tabId === 'my-orders' ? showMyOrders : showInvitedOrders;
					if (!isVisible) {
						const label = tabId === 'my-orders' ? 'my orders' : 'invited orders';
						this.showWarning(`No ${label} available for connected wallet.`);
						return;
					}
				}

			const tabContent = document.getElementById(tabId);

			// Hide all tab content
			document.querySelectorAll('.tab-content').forEach(tab => {
				tab.classList.remove('active');
			});

			// Update tab buttons
			document.querySelectorAll('.tab-button').forEach(button => {
				button.classList.remove('active');
				if (button.dataset.tab === tabId) {
					button.classList.add('active');
				}
			});
			this.currentTab = tabId;

			// Show and initialize selected tab
			if (tabContent) {
				this.persistActiveTabState(tabId);
				tabContent.classList.add('active');

				// Initialize component for this tab
				const component = this.components[tabId];
				if (!skipInitialize && component?.initialize) {
					const wallet = this.ctx.getWallet();
					const computedReadOnly = readOnlyOverride !== null
						? !!readOnlyOverride
						: !wallet?.isWalletConnected();

					// First visit: block with inline loader. Revisit: refresh in background.
					if (!this.tabReady.has(tabId)) {
						loadingOverlay = document.createElement('div');
						loadingOverlay.className = 'loading-overlay';
						const skeletonVariant = this.getTabSkeletonVariant(tabId);
						loadingOverlay.innerHTML = this.getSkeletonLoaderMarkup('Loading...', skeletonVariant);
						tabContent.style.position = 'relative';
						tabContent.appendChild(loadingOverlay);

						await component.initialize(computedReadOnly);
						this.tabReady.add(tabId);
					} else {
						Promise.resolve()
							.then(() => component.initialize(computedReadOnly))
							.then(() => this.tabReady.add(tabId))
							.catch(error => {
								console.error(`[App] Background initialize failed for ${tabId}:`, error);
							});
					}
				}

				// Remove loading overlay after initialization
				if (loadingOverlay?.parentElement) {
					loadingOverlay.remove();
				}
			}

			if (requestId !== this.activeTabRequestId) return;
			this.debug('Tab switch complete:', tabId);
		} catch (error) {
			console.error('[App] Error showing tab:', error);
			// Ensure loading overlay is removed even if there's an error
			if (loadingOverlay?.parentElement) {
				loadingOverlay.remove();
			}
		}
	}

	// Add new method to reinitialize components
	async reinitializeComponents(options = {}) {
		const normalizedOptions = typeof options === 'boolean'
			? { preserveOrders: options }
			: (options || {});
		const {
			preserveOrders = false,
			createOrderResetOptions = {},
			skipShowTab = false,
			skipServiceCleanup = false,
		} = normalizedOptions;

		if (this.isReinitializing) {
			this.debug('Already reinitializing, skipping...');
			return;
		}
		this.isReinitializing = true;

		try {
			this.debug('Reinitializing components with wallet...');

			// Clean up tab components first.
			// Keep WalletUI mounted so its static header listeners (wallet chip popup) remain active.
			Object.entries(this.components).forEach(([id, component]) => {
				if (id === 'wallet-info') return;
				if (component?.cleanup && component.initialized) {
					try {
						component.cleanup();
					} catch (error) {
						console.warn(`Error cleaning up component:`, error);
					}
				}
			});
			this.tabReady.clear();

			// Optionally clean up WebSocket service (clears order cache). Preserve on account/chain change.
			const ws = this.ctx.getWebSocket();
			if (!preserveOrders && !skipServiceCleanup && ws?.cleanup) {
				try {
					ws.cleanup();
				} catch (error) {
					console.warn(`Error cleaning up WebSocket service:`, error);
				}
			}

			// Reinitialize existing CreateOrder component when wallet is connected
			const createOrderComponent = this.components['create-order'];
			if (createOrderComponent) {
				// Reset component state to force fresh token loading
				createOrderComponent.resetState(createOrderResetOptions);
				await createOrderComponent.initialize(false);
			}

			// Reinitialize all components in connected mode
			await this.initializeComponents(false);

			// Ensure WebSocket is initialized and synced when preserving orders
			if (preserveOrders && ws) {
				try {
					// Never block connected-wallet reinit on WS readiness.
					// If WS comes up later and the cache is empty, sync in background.
					void ws.waitForInitialization()
						.then(() => {
							if (ws.orderCache.size === 0) {
								return ws.syncAllOrders();
							}
							return null;
						})
						.catch((e) => this.debug('Deferred WS sync skipped/failed (preserveOrders)', e));
				} catch (e) {
					this.debug('WebSocket not ready during reinit (preserveOrders)', e);
				}
			}

			// Re-show the current tab
			if (!skipShowTab) {
				const wallet = this.ctx.getWallet();
				await this.showTab(this.currentTab, !wallet?.isWalletConnected());
			}

			this.debug('Components reinitialized');
		} catch (error) {
			console.error('[App] Error reinitializing components:', error);
		} finally {
			this.isReinitializing = false;
		}
	}

	// Add method to refresh active component
	async refreshActiveComponent() {
		const activeComponent = this.components[this.currentTab];
		if (activeComponent?.initialize) {
			this.debug('Refreshing active component:', this.currentTab);
			// Reset CreateOrder component state to ensure fresh token loading
			// if (this.currentTab === 'create-order' && activeComponent?.resetState) {
			// 	activeComponent.resetState();  // Commented out - not resetting form
			// }
			// TODO: maybe add to active depending on event
			const wallet = this.ctx?.getWallet?.();
			const readOnlyMode = !wallet?.isWalletConnected?.();
			await activeComponent.initialize(readOnlyMode);
		}
	}

	initializeTheme() {
		document.documentElement.setAttribute('data-theme', 'light');
		try {
			localStorage.setItem('theme', 'light');
		} catch (e) {}
	}
}

window.app = new App();

// Toast functions are now accessed via AppContext (this.ctx.showError, etc.)
// Removed window.* assignments - all components use ctx or BaseComponent methods
window.getToast = getToast; // Keep for external/debug access if needed

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
	window.app.showGlobalLoader('Checking for updates...');
	try {
		// Check version first, before anything else happens
		await versionService.initialize();

		await window.app.load();

		// Add network config button event listener here (element doesn't exist in HTML, so commented out)
		// const networkConfigButton = document.querySelector('.network-config-button');
		// if (networkConfigButton) {
		// 	networkConfigButton.addEventListener('click', showAppParametersPopup);
		// }

		window.app.debug('Initialization complete');
	} catch (error) {
		console.error('[App] App initialization error:', error);
	} finally {
		window.app.hideGlobalLoader();
	}
});

// Network selector functionality
let addNetworkButton, networkButton, networkDropdown, networkBadge;
let networkSelectorElement;
let selectedNetworkSlug = null;
let networkSetupRequiredSlug = null;
const NETWORK_SELECTOR_LOCK_WARNING = 'Finish or cancel the current wallet action before switching networks.';

function getNetworkLogoPath(network) {
	return typeof network?.logo === 'string' ? network.logo : '';
}

function getNetworkLabel(network) {
	return network?.displayName || network?.name || 'Unknown network';
}

function renderNetworkBadge(network) {
	if (!networkBadge || !network) return;

	const networkLabel = getNetworkLabel(network);
	const logoPath = getNetworkLogoPath(network);
	networkBadge.replaceChildren();
	networkBadge.classList.toggle('has-logo', Boolean(logoPath));

	if (logoPath) {
		const logo = document.createElement('img');
		logo.className = 'network-badge-logo';
		logo.src = logoPath;
		logo.alt = `${networkLabel} logo`;
		logo.loading = 'lazy';
		logo.decoding = 'async';
		networkBadge.appendChild(logo);
	}

	const label = document.createElement('span');
	label.className = 'network-badge-label';
	label.textContent = networkLabel;
	networkBadge.appendChild(label);
}

function buildNetworkOptionMarkup(network) {
	const networkLabel = getNetworkLabel(network);
	const logoPath = getNetworkLogoPath(network);
	const escapedLabel = escapeHtml(networkLabel);
	const logoMarkup = logoPath
		? `<img class="network-option-logo" src="${escapeHtml(logoPath)}" alt="${escapedLabel} logo" loading="lazy" decoding="async">`
		: '';

	return `
		<div class="network-option" role="option" tabindex="0" data-network="${escapeHtml(network.name.toLowerCase())}" data-chain-id="${escapeHtml(network.chainId)}" data-slug="${escapeHtml(network.slug)}">
			${logoMarkup}
			<span class="network-option-label">${escapedLabel}</span>
		</div>
	`;
}

function getChainSlugFromUrl() {
	return getRequestedNetworkSlugFromUrl();
}

function getInitialSelectedNetwork() {
	const requestedSlug = getChainSlugFromUrl();
	const fromUrl = requestedSlug ? getNetworkBySlug(requestedSlug) : null;
	return fromUrl || getDefaultNetwork();
}

function updateChainInUrl(slug) {
	const url = new URL(window.location.href);
	url.searchParams.set('chain', slug);
	// Preserve existing history state (e.g., ACTIVE_TAB_STATE_KEY) when updating URL (PR #178 review)
	const existingState = window.history?.state || {};
	window.history.replaceState(existingState, '', url);
}

function markSelectedNetworkOption(slug) {
	document.querySelectorAll('.network-option').forEach(option => {
		const isActive = option.dataset.slug === slug;
		option.classList.toggle('active', isActive);
		option.setAttribute('aria-selected', String(isActive));
	});
}

function isNetworkAddRequiredError(error) {
	if (!error) return false;
	if (error.requiresWalletNetworkAddition === true) return true;
	if (error.code === 4902 || error?.originalSwitchError?.code === 4902) return true;

	const message = String(error.message || '').toLowerCase();
	return message.includes('unrecognized chain') || message.includes('unknown chain');
}

function isWalletUserRejectedError(error) {
	if (!error) return false;
	if (isUserRejection(error)) return true;
	return Boolean(error?.originalSwitchError) && isUserRejection(error.originalSwitchError);
}

function clearNetworkSetupRequired() {
	networkSetupRequiredSlug = null;
}

function setNetworkSetupRequired(slug) {
	networkSetupRequiredSlug = slug ? String(slug).toLowerCase() : null;
}

function syncAddNetworkButtonVisibility() {
	if (!addNetworkButton) return;

	const selectedSlug = selectedNetworkSlug || window.app?.ctx?.getSelectedChainSlug?.() || getDefaultNetwork().slug;
	const selectedNetwork = getNetworkBySlug(selectedSlug) || getDefaultNetwork();
	const walletChainId = window.app?.ctx?.getWalletChainId?.();
	const shouldShow = Boolean(
		networkSetupRequiredSlug
		&& networkSetupRequiredSlug === selectedSlug
		&& walletManager.hasInjectedProvider()
		&& walletChainId
	);

	addNetworkButton.classList.toggle('hidden', !shouldShow);
	addNetworkButton.textContent = shouldShow
		? `Add ${selectedNetwork.displayName || selectedNetwork.name}`
		: 'Add Network';
}

function isNetworkSelectorLockedByWalletAction() {
	return Boolean(window.app?.ctx?.isWalletActionInFlight?.());
}

function syncNetworkSelectorWalletActionState() {
	const isLocked = isNetworkSelectorLockedByWalletAction();

	if (networkButton) {
		networkButton.disabled = isLocked;
		networkButton.setAttribute('aria-disabled', String(isLocked));
		networkButton.classList.toggle('wallet-action-pending', isLocked);
	}

	if (networkDropdown) {
		networkDropdown.dataset.walletActionPending = String(isLocked);
		networkDropdown.classList.toggle('wallet-action-pending', isLocked);
	}

	if (isLocked) {
		toggleNetworkDropdown(false);
	}
}

function triggerPageReloadWithSwitchFallback(options = {}) {
	try {
		window.app?.prepareForNetworkReload?.(options);
	} catch (error) {
		console.warn('[App] Failed to preserve state before reload:', error);
	}

	try {
		window.location.reload();
	} catch (error) {
		console.warn('[App] Reload failed after network switch:', error);
	}
}

/**
 * Sync network badge from app state (issue #153)
 * The network badge shows the selected app network only.
 * Wallet connection status is handled by the wallet button, not the network selector.
 */
function syncNetworkBadgeFromState() {
	if (!networkBadge) return;

	const selectedSlug = selectedNetworkSlug || window.app?.ctx?.getSelectedChainSlug?.() || getDefaultNetwork().slug;
	const selectedNetwork = getNetworkBySlug(selectedSlug) || getDefaultNetwork();
	renderNetworkBadge(selectedNetwork);

	// Network badge only shows selected network, not wallet connection status
	networkBadge.classList.remove('connected', 'setup-needed', 'wrong-network', 'disconnected');
	if (networkButton) {
		networkButton.dataset.networkStatus = 'default';
	}
	if (networkDropdown) {
		networkDropdown.dataset.networkStatus = 'default';
	}
	syncNetworkSelectorWalletActionState();

	// Let syncAddNetworkButtonVisibility() decide visibility based on networkSetupRequiredSlug (PR #178 review)
	// This preserves the "Add <Network>" retry affordance when setup is required
	syncAddNetworkButtonVisibility();
}

function applySelectedNetwork(network, { updateUrl = true } = {}) {
	if (!network) return;

	const hasChanged = selectedNetworkSlug !== network.slug;
	if (hasChanged) {
		clearNetworkSetupRequired();
	}
	selectedNetworkSlug = network.slug;
	if (window.app?.ctx?.setSelectedChainSlug) {
		window.app.ctx.setSelectedChainSlug(network.slug);
	}
	setActiveNetwork(network);

	markSelectedNetworkOption(network.slug);
	if (updateUrl) {
		updateChainInUrl(network.slug);
	}
	syncNetworkBadgeFromState();
	return hasChanged;
}

function toggleNetworkDropdown(forceOpen = null) {
	if (!networkDropdown) return;

	const shouldOpen = forceOpen === null
		? networkDropdown.classList.contains('hidden')
		: !!forceOpen;

	networkDropdown.classList.toggle('hidden', !shouldOpen);
	if (networkButton) {
		networkButton.setAttribute('aria-expanded', String(shouldOpen));
	}
}

// Dynamically populate network options
const populateNetworkOptions = () => {
	const networks = getAllNetworks();

	// Check if network elements exist
	if (!networkButton || !networkDropdown || !networkBadge) {
		console.warn('Network selector elements not found');
		return;
	}

	// If only one network, hide dropdown functionality
	if (networks.length <= 1) {
		networkButton.classList.add('single-network');
		applySelectedNetwork(networks[0], { updateUrl: true });
		return;
	}

	networkDropdown.innerHTML = networks.map(network => buildNetworkOptionMarkup(network)).join('');

	// Re-attach click handlers only if multiple networks.
		document.querySelectorAll('.network-option').forEach(option => {
			const commitSelection = async () => {
				if (isNetworkSelectorLockedByWalletAction()) {
					window.app?.showWarning?.(NETWORK_SELECTOR_LOCK_WARNING);
					return;
				}

				const network = getNetworkBySlug(option.dataset.slug);
				if (!network) return;
				const previousSelectedNetwork = getNetworkBySlug(
					selectedNetworkSlug || window.app?.ctx?.getSelectedChainSlug?.() || getDefaultNetwork().slug
				) || getDefaultNetwork();
				const hasChanged = applySelectedNetwork(network, { updateUrl: true });
				const walletChainId = window.app?.ctx?.getWalletChainId?.();
				const shouldRetryCurrentSelection = Boolean(
					!hasChanged
					&& walletChainId
					&& typeof window.app?.isWalletOnSelectedNetwork === 'function'
					&& !window.app.isWalletOnSelectedNetwork()
				);
				toggleNetworkDropdown(false);
				if ((hasChanged || shouldRetryCurrentSelection) && typeof window.app?.handleNetworkSelectionCommit === 'function') {
					await window.app.handleNetworkSelectionCommit(network, {
						selectedChainChanged: hasChanged,
						previousSelectedNetwork,
					});
				}
			};

		option.addEventListener('click', commitSelection);
		option.addEventListener('keydown', async (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				await commitSelection();
			}
		});
	});

	applySelectedNetwork(getInitialSelectedNetwork(), { updateUrl: true });
	syncNetworkSelectorWalletActionState();
};

// Initialize network dropdown when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
	addNetworkButton = document.getElementById('addNetworkButton');
	networkButton = document.querySelector('.network-button');
	networkDropdown = document.querySelector('.network-dropdown');
	networkBadge = document.querySelector('.network-badge');
	networkSelectorElement = document.querySelector('.network-selector');

	if (addNetworkButton) {
		addNetworkButton.addEventListener('click', async (event) => {
			event.preventDefault();

			const selectedSlug = selectedNetworkSlug || window.app?.ctx?.getSelectedChainSlug?.() || getDefaultNetwork().slug;
			const selectedNetwork = getNetworkBySlug(selectedSlug) || getDefaultNetwork();

			if (!walletManager.hasInjectedProvider()) {
				window.app?.showWarning?.('No injected wallet detected.');
				return;
			}

			if (!window.app?.ctx?.getWalletChainId?.()) {
				window.app?.showWarning?.('Connect your wallet first.');
				return;
			}

			addNetworkButton.disabled = true;
			addNetworkButton.textContent = 'Retrying...';

			try {
				await window.app?.switchWalletToNetwork?.(selectedNetwork, {
					source: 'add-network-button',
					selectedChainChanged: false,
				});
			} finally {
				addNetworkButton.disabled = false;
				syncAddNetworkButtonVisibility();
			}
		});
	}

	if (networkButton) {
		networkButton.setAttribute('aria-haspopup', 'listbox');
		networkButton.setAttribute('aria-expanded', 'false');
		networkButton.addEventListener('click', (event) => {
			event.preventDefault();
			if (networkButton.classList.contains('single-network')) return;
			if (isNetworkSelectorLockedByWalletAction()) {
				window.app?.showWarning?.(NETWORK_SELECTOR_LOCK_WARNING);
				return;
			}
			toggleNetworkDropdown();
		});
	}

	if (networkDropdown) {
		networkDropdown.setAttribute('role', 'listbox');
	}

	document.addEventListener('click', (event) => {
		if (!networkSelectorElement) return;
		if (!networkSelectorElement.contains(event.target)) {
			toggleNetworkDropdown(false);
		}
	});

	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') {
			toggleNetworkDropdown(false);
		}
	});

	window.addEventListener('popstate', () => {
		applySelectedNetwork(getInitialSelectedNetwork(), { updateUrl: false });
	});
	window.addEventListener('wallet-action-lock-changed', () => {
		syncNetworkSelectorWalletActionState();
	});

	window.syncNetworkBadgeFromState = syncNetworkBadgeFromState;
	populateNetworkOptions();
});

// Function to show application parameters in a popup
function showAppParametersPopup() {
	const networkConfigs = getNetworkConfig();
	const contractAddress = networkConfigs.contractAddress || 'N/A';
	const currentChainId = networkConfigs.chainId || 'N/A';

	const popup = document.createElement('div');
	popup.className = 'network-config-popup';
	popup.innerHTML = `
		<div class="popup-content">
			<h2>App Parameters</h2>
			<div class="config-item">
				<label for="contractAddress"><strong>Contract Address:</strong></label>
				<input type="text" id="contractAddress" class="config-input" value="${contractAddress}" readonly />
			</div>
			<div class="config-item">
				<label for="chainId"><strong>Current Chain ID:</strong></label>
				<input type="text" id="chainId" class="config-input" value="${currentChainId}" readonly />
			</div>
			<button class="close-popup">Close</button>
		</div>
	`;

	// Add event listener before adding to DOM
	const closeButton = popup.querySelector('.close-popup');
	closeButton.addEventListener('click', () => popup.remove());

	document.body.appendChild(popup);
}
