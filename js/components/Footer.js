import { BaseComponent } from './BaseComponent.js';

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
                <span class="footer-text">Powered by</span>
                <a href="https://github.com/dnlbui/WhaleSwap-UI" target="_blank" rel="noopener noreferrer" class="footer-link">WhaleSwap</a>
            </div>
        `;
    }
}


