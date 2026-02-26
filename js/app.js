import { BaseComponent } from './components/BaseComponent.js';
import { CreateOrder } from './components/CreateOrder.js';
import { APP_BRAND, APP_LOGO } from './config/index.js';
import { DEBUG_CONFIG } from './config/debug.js';
import { getNetworkConfig, getAllNetworks, getNetworkById, getNetworkBySlug, getDefaultNetwork, setActiveNetwork } from './config/networks.js';
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

class App {
	constructor() {
		this.isInitializing = false;
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
		this.claimVisibilityRefreshTimer = null;
		this.claimVisibilityRetryTimer = null;
		this.claimVisibilityRetryBaseDelayMs = 500;
		this.claimVisibilityRetryDelayMs = this.claimVisibilityRetryBaseDelayMs;
		this.claimVisibilityRetryMaxDelayMs = 5000;
		this.claimVisibilityCacheTtlMs = 1500;
		this.claimVisibilityCheckedAtMs = 0;
		this.claimVisibilityCacheKey = null;

		// Replace debug initialization with LogService
		const logger = createLogger('APP');
		this.debug = logger.debug.bind(logger);
		this.error = logger.error.bind(logger);
		this.warn = logger.warn.bind(logger);

		this.debug('App constructor called');
	}

	isOrdersTab(tabId = this.currentTab) {
		return tabId === 'view-orders'
			|| tabId === 'my-orders'
			|| tabId === 'taker-orders'
			|| tabId === 'cleanup-orders';
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

				if (!isConnected || !userAddress || !this.isWalletOnSelectedNetwork()) {
					if (isCurrentRequest()) {
						this.clearClaimVisibilityRetryTimer();
						this.resetClaimVisibilityRetryBackoff();
					}
					await applyVisibility(false);
					return resolveVisibilityResult(false);
				}

			const ws = this.ctx?.getWebSocket?.();
			await ws?.waitForInitialization?.();
			const contract = ws?.contract;
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
			this.tabRailResizeHandler = () => {
				this.scrollActiveTabIntoView({ behavior: 'auto' });
				this.updateTabRailOverflowState();
			};
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

	getVisibleActiveTabButton() {
		if (!this.tabRail) return null;
		const candidates = Array.from(this.tabRail.querySelectorAll('.tab-button.active'));
		for (const button of candidates) {
			const style = window.getComputedStyle(button);
			if (style.display !== 'none' && style.visibility !== 'hidden') {
				return button;
			}
		}
		return null;
	}

	scrollActiveTabIntoView({ behavior = 'smooth' } = {}) {
		if (!this.tabRail) {
			this.initializeTabRail();
		}
		if (!window.matchMedia('(max-width: 768px)').matches) {
			this.updateTabRailOverflowState();
			return;
		}

		const activeButton = this.getVisibleActiveTabButton();
		if (!activeButton) {
			this.updateTabRailOverflowState();
			return;
		}

		activeButton.scrollIntoView({
			block: 'nearest',
			inline: 'center',
			behavior
		});

		window.setTimeout(() => this.updateTabRailOverflowState(), 140);
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
			<div class="loading-text">${message}</div>
		`;
	}

	showGlobalLoader(message = 'Loading WhaleSwap...') {
		if (window.__bootstrapLoaderTimeout) {
			clearTimeout(window.__bootstrapLoaderTimeout);
			window.__bootstrapLoaderTimeout = null;
		}

		if (this.globalLoader?.parentElement) {
			this.globalLoader.classList.remove('is-slow');
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
			const hint = this.globalLoader.querySelector('[data-loader-hint]');
			const retry = this.globalLoader.querySelector('[data-loader-retry]');
			if (hint) hint.hidden = true;
			if (retry) retry.hidden = true;
			this.updateGlobalLoaderText(message);
			return this.globalLoader;
		}

		const loader = document.createElement('div');
		loader.className = 'loading-overlay loading-overlay--global';
		loader.innerHTML = this.getSkeletonLoaderMarkup(message, 'app');
		document.body.appendChild(loader);
		this.globalLoader = loader;
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
	}

	getSelectedNetwork() {
		const selectedSlug = this.ctx?.getSelectedChainSlug?.();
		return getNetworkBySlug(selectedSlug) || getDefaultNetwork();
	}

	isWalletOnSelectedNetwork(chainId = null) {
		const walletChainId = chainId ?? this.ctx?.getWalletChainId?.() ?? walletManager.chainId ?? null;
		const walletNetwork = getNetworkById(walletChainId);
		const selectedNetwork = this.getSelectedNetwork();
		return !!(walletNetwork && selectedNetwork && walletNetwork.slug === selectedNetwork.slug);
	}

	handleNetworkSwitchFailure(error, targetNetwork) {
		this.warn('Wallet network switch rejected/failed:', error);
		if (isNetworkAddRequiredError(error)) {
			this.showWarning(`Wallet does not have ${targetNetwork.displayName || targetNetwork.name} added. Add Network.`);
			return;
		}
		if (isWalletUserRejectedError(error)) {
			this.showWarning('Wallet request was cancelled.');
			return;
		}
		this.showWarning(`Could not switch wallet to ${targetNetwork.displayName || targetNetwork.name}.`);
	}

	async switchWalletToNetworkWithReload(targetNetwork) {
		setNetworkSwitchInProgress(true);
		try {
			await walletManager.switchToNetwork(targetNetwork);
			triggerPageReloadWithSwitchFallback();
			return true;
		} catch (error) {
			this.handleNetworkSwitchFailure(error, targetNetwork);
			setNetworkSwitchInProgress(false);
			return false;
		}
	}

	async handleNetworkSelectionCommit(network) {
		if (!network) return;

		try {
			setActiveNetwork(network);
		} catch (error) {
			this.error('Failed to set active network from selection:', error);
			setNetworkSwitchInProgress(false);
			return;
		}

		const wallet = this.ctx?.getWallet?.();
		const isConnected = !!wallet?.isWalletConnected?.() && !!wallet?.getSigner?.();
		if (!isConnected) {
			window.location.reload();
			return;
		}

		const walletNetwork = getNetworkById(this.ctx.getWalletChainId() || walletManager.chainId || null);
		if (walletNetwork?.slug === network.slug) {
			triggerPageReloadWithSwitchFallback();
			return;
		}

		await this.switchWalletToNetworkWithReload(network);
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
			this.updateGlobalLoaderText('Initializing pricing...');
			await this.initializePricingService();
			this.updateGlobalLoaderText('Connecting to order feed...');
			await this.initializeWebSocket();

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

			this.handleConnectWallet = async (e) => {
				e && e.preventDefault();
				await this.connectWallet();
			};

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

			// Treat presence of signer as connected for initial render to avoid flicker,
			// but only enable connected UX when wallet chain matches selected chain.
			const wallet = this.ctx.getWallet();
			const isInitiallyConnected = !!wallet?.getSigner?.();
			const isInitialNetworkMatch = this.isWalletOnSelectedNetwork(
				this.ctx.getWalletChainId() || walletManager.chainId || null
			);
			const hasInitialConnectedContext = isInitiallyConnected && isInitialNetworkMatch;
			this.currentTab = hasInitialConnectedContext ? 'create-order' : 'view-orders';

			// Add wallet connect button handler
			const walletConnectBtn = document.getElementById('walletConnect');
			if (walletConnectBtn) {
				walletConnectBtn.addEventListener('click', this.handleConnectWallet);
			}

				// Add wallet connection state handler
				walletManager.addListener(async (event, data) => {
					switch (event) {
						case 'connect': {
							const walletChainId = data?.chainId || walletManager.chainId || null;
							const selectedNetwork = this.getSelectedNetwork();
							const walletNetwork = getNetworkById(walletChainId);
							const shouldAttemptSwitch = !walletNetwork || walletNetwork.slug !== selectedNetwork.slug;
							if (shouldAttemptSwitch) {
								setNetworkSwitchInProgress(true);
							}
							this.ctx.setWalletChainId(walletChainId);
							syncNetworkBadgeFromState();
								if (shouldAttemptSwitch) {
									this.updateTabVisibility(false);
									await this.refreshAdminTabVisibility();
									await this.refreshClaimTabVisibility();
									await this.switchWalletToNetworkWithReload(selectedNetwork);
									break;
								}

							this.debug('Wallet connected on selected chain, reinitializing components...');
							this.updateTabVisibility(true);
							await this.refreshAdminTabVisibility();
						await this.refreshClaimTabVisibility();
						// Preserve WebSocket order cache to avoid clearing orders on connect
						await this.reinitializeComponents(true);
						break;
					}
					case 'disconnect': {
						this.ctx.setWalletChainId(null);
						syncNetworkBadgeFromState();
						this.debug('Wallet disconnected, updating tab visibility...');
						this.updateTabVisibility(false);
						await this.refreshAdminTabVisibility();
						await this.refreshClaimTabVisibility();
						// Clear CreateOrder state only; no need to initialize since tab is hidden
						try {
							const createOrderComponent = this.components['create-order'];
							if (createOrderComponent?.resetState) {
								createOrderComponent.resetState({ clearSelections: true });
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

								if (!this.isWalletOnSelectedNetwork()) {
									this.updateTabVisibility(false);
									await this.refreshAdminTabVisibility();
									await this.refreshClaimTabVisibility();
									break;
								}

								this.debug('Account changed, reinitializing components...');
								this.updateTabVisibility(true);
								await this.refreshAdminTabVisibility();
							await this.refreshClaimTabVisibility();
							await this.reinitializeComponents(true);
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
							this.debug('Chain changed event received:', data?.chainId);
							const walletChainId = data?.chainId || null;
							this.ctx.setWalletChainId(walletChainId);
							syncNetworkBadgeFromState();

								const selectedNetwork = this.getSelectedNetwork();
								const walletNetwork = getNetworkById(walletChainId);
								if (walletNetwork && walletNetwork.slug === selectedNetwork.slug) {
									setActiveNetwork(walletNetwork);
									window.location.reload();
								} else {
								this.updateTabVisibility(false);
								await this.refreshAdminTabVisibility();
								await this.refreshClaimTabVisibility();
							}
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
			if (ws) {
				ws.subscribe('OrderCreated', () => {
					this.debug('Order created, refreshing components...');
					this.refreshActiveComponent();
				});

				ws.subscribe('OrderFilled', () => {
					this.debug('Order filled, refreshing components...');
					this.refreshActiveComponent();
				});

				ws.subscribe('OrderCanceled', () => {
					this.debug('Order canceled, refreshing components...');
					this.refreshActiveComponent();
				});

				ws.subscribe('claimsUpdated', (eventData) => {
					this.scheduleClaimTabVisibilityRefresh(eventData);
				});
			}

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
					const ws = this.ctx.getWebSocket();
					await ws?.waitForInitialization();
					const contract = ws?.contract;
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
				const tabButtons = document.querySelectorAll('.tab-button');
				tabButtons.forEach(button => {
					// Always show intro, create-order, view-orders, cleanup-orders, contract-params
					if (
						button.dataset.tab === 'intro' ||
						button.dataset.tab === 'create-order' ||
						button.dataset.tab === 'view-orders' ||
						button.dataset.tab === 'cleanup-orders' ||
						button.dataset.tab === 'contract-params'
					) {
						button.style.display = 'block';
					} else if (button.dataset.tab === 'claim') {
						// Claim visibility is handled asynchronously after claimable checks.
						// Keep current state while connected to avoid flicker and fail-closed behavior.
						if (!isConnected) {
							button.style.display = 'none';
							this.claimTabVisibilityKnown = true;
							this.claimTabLastVisible = false;
							this.clearClaimVisibilityRetryTimer();
							this.resetClaimVisibilityRetryBackoff();
						}
					} else {
						button.style.display = isConnected ? 'block' : 'none';
					}
				});

				// If disconnected, only switch to view-orders if current tab is not visible
				if (!isConnected) {
					const visibleWhenDisconnected = new Set(['intro', 'create-order', 'view-orders', 'cleanup-orders', 'contract-params']);
					if (!visibleWhenDisconnected.has(this.currentTab)) {
						this.showTab('view-orders');
					}
				}

				this.scrollActiveTabIntoView({ behavior: 'auto' });

				this.scheduleClaimTabVisibilityRefresh();
			};

			// Update initial tab visibility based on connection + selected-chain match
			this.updateTabVisibility(hasInitialConnectedContext);
			// Do not block first paint on owner check/network calls.
			Promise.resolve()
				.then(() => this.refreshAdminTabVisibility())
				.catch((error) => this.debug('Deferred admin visibility check failed:', error));
			Promise.resolve()
				.then(() => this.refreshClaimTabVisibility())
				.catch((error) => this.debug('Deferred claim visibility check failed:', error));

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

		// Prefer signer presence + selected-chain match for initial render
		const initialReadOnlyMode = !hasInitialConnectedContext;
		this.updateGlobalLoaderText('Preparing interface...');
		await this.initializeComponents(initialReadOnlyMode);

		// Show the initial tab based on connection state (force read-only if needed for first paint)
		await this.showTab(this.currentTab, initialReadOnlyMode, { skipInitialize: true });

		// Remove loading overlay after initialization
		this.hideGlobalLoader();

		// Start initial order sync in the background so first render is not blocked.
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

	async initializeWebSocket() {
		try {
			this.debug('Initializing WebSocket...');
			// Initialize WebSocket with injected pricingService
			const pricingService = this.ctx.getPricing();
			const webSocketService = new WebSocketService({
				pricingService: pricingService
			});

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

			const wsInitialized = await webSocketService.initialize();
			if (!wsInitialized) {
				this.debug('WebSocket initialization failed, falling back to HTTP');
			}

			// Add to context and update pricing service with webSocket reference
			this.ctx.ws = webSocketService;

			// Update PricingService with WebSocket reference for deal updates
			if (pricingService) {
				pricingService.webSocket = webSocketService;
			}

			// Update ContractService with WebSocket reference
			try {
				contractService.initialize({ webSocket: webSocketService });
				this.ctx.contractService = contractService;
			} catch (e) {
				this.debug('ContractService initialize skipped/failed:', e);
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

			// In read-only mode, initialize the tabs that should always be visible
			if (readOnlyMode) {
				const readOnlyTabs = ['intro', 'create-order', 'view-orders', 'cleanup-orders', 'contract-params'];
				for (const tabId of readOnlyTabs) {
					const component = this.components[tabId];
					if (component && typeof component.initialize === 'function') {
						this.debug(`Initializing read-only component: ${tabId}`);
						try {
							await component.initialize(readOnlyMode);
							this.tabReady.add(tabId);
						} catch (error) {
							console.error(`[App] Error initializing ${tabId}:`, error);
						}
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

	async connectWallet() {
		const loader = this.showLoader();
		try {
			await walletManager.connect();
		} catch (error) {
			// Don't show toast here - WalletUI component handles the error display
			this.error('Wallet connection failed:', error);
		} finally {
			if (loader && loader.parentElement) {
				loader.parentElement.removeChild(loader);
			}
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

	handleAccountChange(account) {

	}

	handleChainChange(chainId) {

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
			this.scrollActiveTabIntoView();

			// Show and initialize selected tab
			if (tabContent) {
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
	async reinitializeComponents(preserveOrders = false) {
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
			if (!preserveOrders && ws?.cleanup) {
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
				createOrderComponent.resetState();
				await createOrderComponent.initialize(false);
			}

			// Reinitialize all components in connected mode
			await this.initializeComponents(false);

			// Ensure WebSocket is initialized and synced when preserving orders
			if (preserveOrders && ws) {
				try {
					await ws.waitForInitialization();
					if (ws.orderCache.size === 0) {
						await ws.syncAllOrders();
					}
				} catch (e) {
					this.debug('WebSocket not ready during reinit (preserveOrders)', e);
				}
			}

			// Re-show the current tab
			const wallet = this.ctx.getWallet();
			await this.showTab(this.currentTab, !wallet?.isWalletConnected());

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

		// Add global error handler for WebSocket issues
		window.addEventListener('error', (event) => {
			if (event.error && event.error.message && event.error.message.includes('callback')) {
				console.warn('WebSocket callback error detected, attempting to reconnect...');
				// Access via window.app.ctx since app is now initialized
				if (window.app?.ctx) {
					const ws = window.app.ctx.getWebSocket();
					if (ws && ws.reconnect) {
						ws.reconnect();
					}
				}
			}
		});

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
let networkSwitchInProgress = false;

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function getNetworkLogoPath(network) {
	return typeof network?.logo === 'string' ? network.logo : '';
}

function renderNetworkBadge(network) {
	if (!networkBadge || !network) return;

	const networkLabel = network.displayName || network.name;
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
	const networkLabel = network.displayName || network.name;
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
	const params = new URLSearchParams(window.location.search);
	const slug = params.get('chain');
	return slug ? slug.toLowerCase() : null;
}

function getInitialSelectedNetwork() {
	const requestedSlug = getChainSlugFromUrl();
	const fromUrl = requestedSlug ? getNetworkBySlug(requestedSlug) : null;
	return fromUrl || getDefaultNetwork();
}

function updateChainInUrl(slug) {
	const url = new URL(window.location.href);
	url.searchParams.set('chain', slug);
	window.history.replaceState({}, '', url);
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

function setNetworkSwitchInProgress(isInProgress) {
	networkSwitchInProgress = Boolean(isInProgress);
	syncAddNetworkButtonVisibility();
}

function triggerPageReloadWithSwitchFallback() {
	try {
		window.location.reload();
	} catch (error) {
		console.warn('[App] Reload failed after network switch:', error);
		setNetworkSwitchInProgress(false);
		return;
	}

	// In test/mocked environments reload can be a no-op, so always unlock after a delay.
	const unlockSwitchState = () => {
		if (networkSwitchInProgress) {
			setNetworkSwitchInProgress(false);
		}
	};

	window.setTimeout(unlockSwitchState, 1500);

	// Also unlock as soon as the document becomes visible again.
	if (document.visibilityState !== 'visible') {
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') {
				unlockSwitchState();
			}
		}, { once: true });
	}
}

function syncAddNetworkButtonVisibility() {
	if (!addNetworkButton) return;

	const selectedSlug = selectedNetworkSlug || window.app?.ctx?.getSelectedChainSlug?.() || getDefaultNetwork().slug;
	const walletChainId = window.app?.ctx?.getWalletChainId?.();
	const walletNetwork = walletChainId ? getNetworkById(walletChainId) : null;
	const shouldShow = Boolean(
		walletManager.hasInjectedProvider()
		&& walletChainId
		&& !networkSwitchInProgress
		&& (!walletNetwork || walletNetwork.slug !== selectedSlug)
	);
	addNetworkButton.classList.toggle('hidden', !shouldShow);
}

function syncNetworkBadgeFromState() {
	if (!networkBadge) return;

	const selectedSlug = selectedNetworkSlug || window.app?.ctx?.getSelectedChainSlug?.() || getDefaultNetwork().slug;
	const selectedNetwork = getNetworkBySlug(selectedSlug) || getDefaultNetwork();
	renderNetworkBadge(selectedNetwork);
	networkBadge.classList.remove('connected', 'wrong-network', 'disconnected');
	if (networkButton) {
		networkButton.dataset.networkStatus = 'default';
	}
	if (networkDropdown) {
		networkDropdown.dataset.networkStatus = 'default';
	}

	const walletChainId = window.app?.ctx?.getWalletChainId?.();
	if (!walletChainId) {
		networkBadge.classList.add('disconnected');
		if (networkButton) {
			networkButton.dataset.networkStatus = 'disconnected';
		}
		if (networkDropdown) {
			networkDropdown.dataset.networkStatus = 'disconnected';
		}
		syncAddNetworkButtonVisibility();
		return;
	}

	const walletNetwork = getNetworkById(walletChainId);
	if (walletNetwork && walletNetwork.slug === selectedNetwork.slug) {
		networkBadge.classList.add('connected');
		if (networkButton) {
			networkButton.dataset.networkStatus = 'connected';
		}
		if (networkDropdown) {
			networkDropdown.dataset.networkStatus = 'connected';
		}
	} else {
		networkBadge.classList.add('wrong-network');
		if (networkButton) {
			networkButton.dataset.networkStatus = 'wrong-network';
		}
		if (networkDropdown) {
			networkDropdown.dataset.networkStatus = 'wrong-network';
		}
	}

	syncAddNetworkButtonVisibility();
}

function applySelectedNetwork(network, { updateUrl = true } = {}) {
	if (!network) return;

	const hasChanged = selectedNetworkSlug !== network.slug;
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
			const network = getNetworkBySlug(option.dataset.slug);
			if (!network) return;
			const previousSlug = selectedNetworkSlug || window.app?.ctx?.getSelectedChainSlug?.() || getDefaultNetwork().slug;
			const hasWalletContext = Boolean(window.app?.ctx?.getWalletChainId?.());
			const shouldSuppressAddButton = hasWalletContext && previousSlug !== network.slug;
			if (shouldSuppressAddButton) {
				setNetworkSwitchInProgress(true);
			}

			const hasChanged = applySelectedNetwork(network, { updateUrl: true });
			toggleNetworkDropdown(false);
			if (hasChanged && typeof window.app?.handleNetworkSelectionCommit === 'function') {
				await window.app.handleNetworkSelectionCommit(network);
				return;
			}

			setNetworkSwitchInProgress(false);
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
				window.app?.showWarning?.('MetaMask is required. Phantom is not supported.');
				return;
			}

			if (!window.app?.ctx?.getWalletChainId?.()) {
				window.app?.showWarning?.('Connect your wallet first.');
				return;
			}

			const originalText = addNetworkButton.textContent;
			addNetworkButton.disabled = true;
			addNetworkButton.textContent = 'Switching...';

			try {
				await window.app?.switchWalletToNetworkWithReload?.(selectedNetwork);
			} finally {
				addNetworkButton.disabled = false;
				addNetworkButton.textContent = originalText;
			}
		});
	}

	if (networkButton) {
		networkButton.setAttribute('aria-haspopup', 'listbox');
		networkButton.setAttribute('aria-expanded', 'false');
		networkButton.addEventListener('click', (event) => {
			event.preventDefault();
			if (networkButton.classList.contains('single-network')) return;
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
