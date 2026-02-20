import { createLogger } from './LogService.js';

/**
 * VersionService handles version checking, cache busting, and update notifications
 * Follows the existing service pattern in the codebase
 */
export class VersionService {
	constructor() {
		this.logger = createLogger('VersionService');
		this.debug = this.logger.debug.bind(this.logger);
		this.error = this.logger.error.bind(this.logger);
		this.warn = this.logger.warn.bind(this.logger);
		
		this.currentVersion = null;
		this.isOnline = navigator.onLine;
		this.updateInProgress = false;
		
		// Listen for online/offline events
		window.addEventListener('online', () => {
			this.isOnline = true;
			this.debug('Network connection restored');
		});
		
		window.addEventListener('offline', () => {
			this.isOnline = false;
			this.warn('Network connection lost');
		});
	}

	/**
	 * Initialize the version service
	 */
	async initialize() {
		this.debug('Initializing version service...');
		
		try {
			await this.checkVersion();
		} catch (error) {
			this.error('Version service initialization failed:', error);
			// Don't throw - allow app to continue with cached version
		}
	}

	/**
	 * Check for version updates and handle cache busting
	 */
	async checkVersion() {
		const storedVersionRaw = localStorage.getItem('app_version');
		const hasStoredVersion = typeof storedVersionRaw === 'string' && storedVersionRaw.trim().length > 0;
		const storedVersion = hasStoredVersion ? storedVersionRaw.trim() : null;
		let newVersion;
		
		this.debug('Checking version. Stored version:', storedVersion);
		
		try {
			const response = await fetch('version.html', {
				cache: 'reload',
				headers: {
					'Cache-Control': 'no-cache',
					'Pragma': 'no-cache',
				}
			});
			
			if (!response.ok) {
				throw new Error(`Version check failed: ${response.status} ${response.statusText}`);
			}
			
			newVersion = (await response.text()).trim();
			this.debug('Server version:', newVersion);
			
		} catch (error) {
			this.error('Version check failed:', error);
			
			// Handle offline scenario
			if (!this.isOnline || error instanceof TypeError) {
				this.warn('Version check failed due to network issues. Continuing with cached version.');
				return false;
			}
			
			// For other errors, show a warning but continue
			this.warn('Version check failed, continuing with cached version');
			return false;
		}

		// First visit (or cleared storage): initialize local version without forcing update/reload.
		if (!hasStoredVersion) {
			localStorage.setItem('app_version', newVersion);
			this.debug('No stored version found. Bootstrapping app_version without update.');
			return false;
		}

		// Compare versions (extract numeric parts for comparison) - like the original
		const storedNumeric = parseInt(storedVersion.replace(/\D/g, ''));
		const newNumeric = parseInt(newVersion.replace(/\D/g, ''));
		
		this.debug('Version comparison:', { storedNumeric, newNumeric });
		
		if (storedNumeric !== newNumeric) {
			this.debug('Version update detected, performing cache bust...');
			await this.performUpdate(newVersion);
			return true;
		}
		
		this.debug('No version update needed');
		return false;
	}



	/**
	 * Perform the update process
	 */
	async performUpdate(newVersion) {
		if (this.updateInProgress) {
			this.debug('Update already in progress, skipping...');
			return;
		}
		
		this.updateInProgress = true;
		
		try {
			// Show update notification
			alert('Updating to new version: ' + newVersion);
			
			// Update stored version
			localStorage.setItem('app_version', newVersion);
			
			// Force reload critical files like the original
			await this.forceReloadCriticalFiles();
			
			// Reload the page
			this.debug('Update complete, reloading page...');
			window.location.replace(window.location.href.split('?')[0]);
			
		} catch (error) {
			this.error('Update failed:', error);
			this.updateInProgress = false;
		}
	}

		/**
	 * Force reload critical files to bust cache
	 */
	async forceReloadCriticalFiles() {
		const criticalFiles = [
			window.location.href.split('?')[0],
			'index.html',
			'js/app.js',
			'js/config/index.js',
			'js/config/networks.js',
			'js/config/debug.js',
			'css/styles.css',
			// Core services
			'js/services/ContractService.js',
			'js/services/WebSocket.js',
			'js/services/PricingService.js',
			'js/services/LogService.js',
			'js/services/OrderManager.js',
			'js/services/EventSync.js',
			'js/services/TokenIconService.js',
			// Components
			'js/components/BaseComponent.js',
			'js/components/CreateOrder.js',
			'js/components/ViewOrders.js',
			'js/components/MyOrders.js',
			'js/components/TakerOrders.js',
			'js/components/Cleanup.js',
			'js/components/ContractParams.js',
			'js/components/DebugPanel.js',
			'js/components/Toast.js',
			'js/components/Footer.js',
			'js/components/Intro.js',
			'js/components/WalletUI.js',
			// Utilities
			'js/utils/balanceValidation.js',
			'js/utils/contractTokens.js',
			'js/utils/ethereum.js',
			'js/utils/tokenIcons.js',
			'js/utils/ui.js',
			// CSS files
			'css/components/cleanup.css',
			'css/components/contract-params.css',
			'css/components/debug.css',
			'css/components/footer.css',
			'css/components/forms.css',
			'css/components/orders.css',
			'css/components/tabs.css',
			'css/components/toast.css',
			'css/components/wallet.css',
		];
		
		this.debug('Force reloading critical files...');
		
		try {
			const fetchPromises = criticalFiles.map(url =>
				fetch(url, {
					cache: 'reload',
					headers: {
						'Cache-Control': 'no-cache',
						'Pragma': 'no-cache',
					}
				})
			);
			
			await Promise.all(fetchPromises);
			this.debug('Critical files reloaded successfully');
			
		} catch (error) {
			this.error('Failed to reload critical files:', error);
			// Don't throw - the page reload will handle cache busting
		}
	}






}

// Create singleton instance
export const versionService = new VersionService();
