import { BaseComponent } from './BaseComponent.js';

export class Intro extends BaseComponent {
	constructor() {
		super('intro');
		this.initialized = false;
	}

	async initialize(readOnly = true) {
		try {
			if (!this.initialized) {
				this.render();
				this.initialized = true;
				this.setupEventListeners();
			}
			return true;
		} catch (error) {
			this.error('[Intro] Initialization error:', error);
			return false;
		}
	}

	setupEventListeners() {
		const faqToggle = this.container.querySelector('.faq-toggle');
		const faqContent = this.container.querySelector('.faq-content');
		const faqText = this.container.querySelector('.faq-text');
		
		if (faqToggle && faqContent && faqText) {
			faqToggle.addEventListener('click', () => {
				const isExpanded = faqContent.classList.contains('expanded');
				faqContent.classList.toggle('expanded');
				faqToggle.classList.toggle('expanded');
				faqText.textContent = isExpanded ? 'Show Detailed FAQ' : 'Hide Detailed FAQ';
			});
		}
	}

	render() {
		if (!this.container) return;
		this.container.innerHTML = `
			<div class="tab-content-wrapper">
				<h2>Welcome to WhaleSwap</h2>
				<p class="intro-lead">Create orders by depositing tokens into escrow and setting the buy price, or fill existing orders to buy tokens at the set buy price set by the seller</p>
				
				<div class="intro-content">
					<h3 class="intro-subtitle">How to Use This Service</h3>
					
					<div class="intro-sections-grid">
						<div class="intro-section">
							<h4>
								<svg class="intro-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<path d="M3 7a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v2"></path>
									<path d="M3 9h17a1 1 0 0 1 1 1v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
									<path d="M16 13h5"></path>
								</svg>
								<span>1. Connect Wallet</span>
							</h4>
							<ul>
								<li>Click "Connect Wallet" in top right</li>
								<li>Pick allowed wallets</li>
								<li>Have native gas token (BNB/POL) for fees</li>
								<li>Have USDC for order creation fee</li>
							</ul>
						</div>

						<div class="intro-section">
							<h4>
								<svg class="intro-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<circle cx="11" cy="11" r="7"></circle>
									<path d="m21 21-4.35-4.35"></path>
								</svg>
								<span>2. Find Orders</span>
							</h4>
							<ul>
								<li>Browse "View Orders", all orders </li>
								<li>"My Orders", orders you created</li>
								<li>"Invited Orders", orders made to you</li>
								<li>Filter by token pairs and newest/best deal</li>
							</ul>
						</div>

						<div class="intro-section">
							<h4>
								<svg class="intro-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<path d="M13 2 4 14h7l-1 8 9-12h-7z"></path>
								</svg>
								<span>3. Fill Order</span>
							</h4>
							<ul>
								<li>Click order to fill</li>
								<li>Review details carefully</li>
								<li>Confirm in wallet</li>
								<li>Tokens swap automatically</li>
							</ul>
						</div>

						<div class="intro-section">
							<h4>
								<svg class="intro-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<path d="M17 3h4v4"></path>
									<path d="m21 3-7 7"></path>
									<path d="M7 21H3v-4"></path>
									<path d="m3 21 7-7"></path>
								</svg>
								<span>4. Create Order</span>
							</h4>
							<ul>
								<li>Go to "Create Order" tab</li>
								<li>Select tokens to swap</li>
								<li>Set exchange rate</li>
								<li>Order submission will deposit tokens to escrow</li>
							</ul>
						</div>

						<div class="intro-section">
							<h4>
								<svg class="intro-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<path d="M12 3 4 7v6c0 5 3.5 7.8 8 9 4.5-1.2 8-4 8-9V7z"></path>
									<path d="m9 12 2 2 4-4"></path>
								</svg>
								<span>Security Tips</span>
							</h4>
							<ul>
								<li>Verify token addresses</li>
								<li>Review order details</li>
								<li>Check exchange rates</li>
								<li>Confirm before filling</li>
							</ul>
						</div>

						<div class="intro-section">
							<h4>
								<svg class="intro-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<path d="M4 3h16v18l-3-2-3 2-2-2-2 2-3-2-3 2z"></path>
									<path d="M8 8h8"></path>
									<path d="M8 12h4"></path>
									<path d="m16 12 3 3"></path>
									<path d="m19 12-3 3"></path>
								</svg>
								<span>Fees & Cancellation</span>
							</h4>
							<ul>
								<li>$1 USDC non-refundable fee</li>
								<li>Orders expire after 7 days</li>
								<li>Cancel before expiration</li>
								<li>Cleanup after 14 days</li>
							</ul>
						</div>
					</div>

					<div class="faq-section">
						<button class="faq-toggle">
							<svg class="intro-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<rect x="9" y="3" width="6" height="4" rx="1"></rect>
								<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"></path>
								<path d="M9 12h6"></path>
								<path d="M9 16h6"></path>
							</svg>
							<span class="faq-text">Show Detailed FAQ</span>
							<svg class="chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="6,9 12,15 18,9"></polyline>
							</svg>
						</button>
						<div class="faq-content">
							<div class="faq-item">
								<h4>
									<svg class="intro-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<rect x="3" y="6" width="18" height="12" rx="2"></rect>
										<path d="M12 9v6"></path>
										<path d="M10.5 10.5h2a1 1 0 1 1 0 2h-1a1 1 0 1 0 0 2h2"></path>
									</svg>
									<span>Order Creation Fee</span>
								</h4>
								<p>There is a non-refundable order creation fee of $1 USDC that must be paid when creating any order. This fee is to insure quality of orders placed.</p>
							</div>
							
							<div class="faq-item">
								<h4>
									<svg class="intro-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<circle cx="12" cy="12" r="9"></circle>
										<path d="M12 7v5l3 2"></path>
									</svg>
									<span>Order Expiration</span>
								</h4>
								<p>All orders automatically expire after 7 days from creation. Once expired, orders can no longer be filled by other users.</p>
							</div>
							
							<div class="faq-item">
								<h4>
									<svg class="intro-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<circle cx="12" cy="12" r="9"></circle>
										<path d="m9 9 6 6"></path>
										<path d="m15 9-6 6"></path>
									</svg>
									<span>Cancelling Orders</span>
								</h4>
								<p>You can cancel your orders at any time before or after it expires. When you cancel an order, your deposited tokens are returned to your wallet, but the $1 USDC creation fee is not refunded. Cancelled orders cannot be filled.</p>
							</div>
							
							<div class="faq-item">
								<h4>
									<svg class="intro-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<path d="M4 7h16"></path>
										<path d="m6 7 1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>
										<path d="M9 7V4h6v3"></path>
									</svg>
									<span>Order Cleanup</span>
								</h4>
								<p>Unfilled or cancelled orders can be cleaned up after 14 days from their creation date to free up contract storage. Anyone can initiate cleanup for eligible orders. The protocol does not charge any fees; instead, the person who cleans up the order receives the $1 USDC creation fee but must pay the network transaction fee for the cleanup transaction. Only one order is cleaned up with each cleanup transaction. Any tokens escrowed in the orders are returned to the original creator.</p>
							</div>
							
							<div class="faq-item">
								<h4>
									<svg class="intro-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<path d="M3 12a9 9 0 0 1 15.5-6.36"></path>
										<path d="M19 3v5h-5"></path>
										<path d="M21 12a9 9 0 0 1-15.5 6.36"></path>
										<path d="M5 21v-5h5"></path>
									</svg>
									<span>Order Recycling</span>
								</h4>
								<p>If during order cleanup, the tokens could not be returned and the order has not been cancelled. The order is recycled and becomes fillable again.</p>
							</div>
							
							<div class="faq-item">
								<h4>
									<svg class="intro-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<path d="M5 20V10"></path>
										<path d="M12 20V4"></path>
										<path d="M19 20v-8"></path>
									</svg>
									<span>Order Status</span>
								</h4>
								<p>Orders can have different statuses: Active (can be filled), Cancelled (tokens returned, cannot be filled), and Expired (past 7 days, cannot be filled).</p>
							</div>
							
							<div class="faq-item">
								<h4>
									<svg class="intro-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<circle cx="12" cy="12" r="10"></circle>
										<line x1="12" y1="8" x2="12" y2="12"></line>
										<circle cx="12" cy="16" r="1"></circle>
									</svg>
									<span>Report Issues</span>
								</h4>
								<p>Send an email to info@whaleswap.org</p>
							</div>
						</div>
					</div>
				</div>
			</div>
		`;
	}
}
