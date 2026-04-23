import { BaseComponent } from './BaseComponent.js';
import { escapeHtmlText } from '../utils/html.js';

export class Footer extends BaseComponent {
    constructor(containerId = 'app-footer') {
        super(containerId);
        this.initialized = false;
    }

    initialize() {
        if (this.initialized) return;
        this.render();
        this.initialized = true;
    }

    render() {
        if (!this.container) return;
        this.container.innerHTML = `
            <div class="footer-wrapper">
                <a href="https://github.com/WhaleSwap-org" target="_blank" rel="noopener noreferrer" class="footer-link">Built</a>
                <span class="footer-text">by</span>
                <a href="https://liberdus.com" target="_blank" rel="noopener noreferrer" class="footer-link">Liberdus</a>
            </div>
            <div class="legal-help-inline" id="legal-help-inline" aria-label="Legal links">
                <button
                    type="button"
                    class="legal-help-inline-item"
                    data-legal-target="tos"
                >
                    Terms
                </button>
                <button
                    type="button"
                    class="legal-help-inline-item"
                    data-legal-target="privacy"
                >
                    Privacy
                </button>
            </div>
            <div class="legal-modal-overlay" id="legal-modal-overlay" hidden>
                <div class="legal-modal" role="dialog" aria-modal="true" aria-labelledby="legal-modal-title">
                    <div class="legal-modal-header">
                        <h2 class="legal-modal-title" id="legal-modal-title"></h2>
                        <button
                            type="button"
                            class="legal-modal-close"
                            id="legal-modal-close"
                            aria-label="Close"
                        >
                            ×
                        </button>
                    </div>
                    <div class="legal-modal-body" id="legal-modal-body"></div>
                </div>
            </div>
        `;

        const overlay = document.getElementById('legal-modal-overlay');
        if (overlay && overlay.parentElement !== document.body) {
            document.body.appendChild(overlay);
        }

        this.bindEvents();
    }

    bindEvents() {
        const inlineActions = document.getElementById('legal-help-inline');
        const overlay = document.getElementById('legal-modal-overlay');
        const closeButton = document.getElementById('legal-modal-close');
        const modalTitle = document.getElementById('legal-modal-title');
        const modalBody = document.getElementById('legal-modal-body');

        if (!inlineActions || !overlay || !closeButton || !modalTitle || !modalBody) {
            return;
        }

        let tosCache = null;
        let privacyCache = null;

        const formatInlineMarkdown = (value) => {
            let text = escapeHtmlText(value);
            text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            text = text.replace(/_(.+?)_/g, '<em>$1</em>');
            return text;
        };

        const renderMarkdown = (markdown) => {
            if (!markdown) {
                return '';
            }

            const lines = markdown.split(/\r?\n/);
            const html = [];
            let inList = false;

            const flushList = () => {
                if (inList) {
                    html.push('</ul>');
                    inList = false;
                }
            };

            for (const rawLine of lines) {
                const line = rawLine.trimEnd();

                if (!line.trim()) {
                    flushList();
                    continue;
                }

                const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
                if (headingMatch) {
                    flushList();
                    const level = headingMatch[1].length;
                    const content = headingMatch[2].trim();
                    html.push(`<h${level}>${formatInlineMarkdown(content)}</h${level}>`);
                    continue;
                }

                const listMatch = line.match(/^[-*]\s+(.*)$/);
                if (listMatch) {
                    if (!inList) {
                        html.push('<ul>');
                        inList = true;
                    }
                    const itemText = listMatch[1].trim();
                    html.push(`<li>${formatInlineMarkdown(itemText)}</li>`);
                    continue;
                }

                flushList();
                html.push(`<p>${formatInlineMarkdown(line)}</p>`);
            }

            flushList();
            return html.join('');
        };

        const loadMarkdown = async (path) => {
            try {
                const response = await fetch(path, { cache: 'no-store' });
                if (!response.ok) {
                    throw new Error('Failed to load document');
                }
                return await response.text();
            } catch (e) {
                return 'Unable to load document.';
            }
        };

        const openModal = async (type) => {
            if (type === 'tos') {
                modalTitle.textContent = 'Terms of Service';
                modalBody.textContent = 'Loading...';
                if (!tosCache) {
                    tosCache = await loadMarkdown('TOS.md');
                }
                modalBody.innerHTML = renderMarkdown(tosCache);
            } else if (type === 'privacy') {
                modalTitle.textContent = 'Privacy Policy';
                modalBody.textContent = 'Loading...';
                if (!privacyCache) {
                    privacyCache = await loadMarkdown('PRIVACY.md');
                }
                modalBody.innerHTML = renderMarkdown(privacyCache);
            } else {
                return;
            }
            overlay.removeAttribute('hidden');
        };

        const closeModal = () => {
            if (!overlay.hasAttribute('hidden')) {
                overlay.setAttribute('hidden', '');
            }
        };

        inlineActions.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const type = target.getAttribute('data-legal-target');
            if (!type) return;
            openModal(type);
        });

        closeButton.addEventListener('click', () => {
            closeModal();
        });

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                closeModal();
            }
        });
    }
}
