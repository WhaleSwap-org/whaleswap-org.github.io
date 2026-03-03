import { createLogger } from '../services/LogService.js';
import { getTransactionExplorerUrl } from '../utils/orderUtils.js';

const TOAST_TYPES = ['error', 'success', 'warning', 'info'];

function shortenHash(hash) {
    if (!hash || hash.length < 12) return hash || '';
    return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

function clearToastClasses(element) {
    TOAST_TYPES.forEach(type => {
        element.classList.remove(`toast-${type}`);
    });
}

export class Toast {
    constructor() {
        const logger = createLogger('TOAST');
        this.debug = logger.debug.bind(logger);
        this.error = logger.error.bind(logger);
        this.warn = logger.warn.bind(logger);

        this.toastQueue = [];
        this.isProcessing = false;
        this.maxToasts = 3;
        this.container = null;

        this.debug('Toast component initialized');
        this.initialize();
    }

    initialize() {
        this.createToastContainer();
        this.debug('Toast container ready');
    }

    createToastContainer() {
        const toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        toastContainer.className = 'toast-container';
        document.body.appendChild(toastContainer);
        this.container = toastContainer;

        this.debug('Toast container created with debug styling');
    }

    showToast(message, type = 'info', duration = 5000, persistent = false) {
        this.debug(`Showing toast: ${type} - ${message}, persistent: ${persistent}`);

        const toast = this.createToastElement(message, type);
        const actualDuration = persistent ? 0 : duration;
        this.addToastToQueue(toast, actualDuration);

        return toast;
    }

    createToastElement(message, type) {
        const refs = this.createToastStructure(type, this.getTypeTitle(type));
        const messageElement = document.createElement('div');
        messageElement.className = 'toast-message';
        messageElement.textContent = message;
        refs.body.appendChild(messageElement);

        this.debug('Toast element created with debug styling');
        return refs.toast;
    }

    createToastStructure(type, titleText) {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        const header = document.createElement('div');
        header.className = 'toast-header';

        const headerContent = document.createElement('div');
        headerContent.className = 'toast-header-content';

        const icon = this.createIcon(type);
        headerContent.appendChild(icon);

        const title = document.createElement('span');
        title.className = 'toast-title';
        title.textContent = titleText;
        headerContent.appendChild(title);

        header.appendChild(headerContent);

        const closeButton = this.createCloseButton();
        header.appendChild(closeButton);

        toast.appendChild(header);

        const body = document.createElement('div');
        body.className = 'toast-body';
        toast.appendChild(body);

        closeButton.addEventListener('click', () => {
            this.removeToast(toast);
        });

        return {
            toast,
            body,
            icon,
            title,
        };
    }

    createIcon(type) {
        const icon = document.createElement('span');
        icon.className = 'toast-icon';
        icon.textContent = this.getTypeIcon(type);
        return icon;
    }

    getTypeIcon(type) {
        switch (type) {
            case 'error':
                return '\u26A0';
            case 'success':
                return '\u2714';
            case 'warning':
                return '\u26A0';
            case 'info':
            default:
                return '\u2139';
        }
    }

    getTypeTitle(type) {
        switch (type) {
            case 'error':
                return 'Error';
            case 'success':
                return 'Success';
            case 'warning':
                return 'Warning';
            case 'info':
            default:
                return 'Information';
        }
    }

    createCloseButton() {
        const closeButton = document.createElement('button');
        closeButton.className = 'toast-close';
        closeButton.innerHTML = '&times;';
        closeButton.setAttribute('aria-label', 'Close notification');
        closeButton.type = 'button';

        return closeButton;
    }

    createTransactionProgress(options) {
        const refs = this.createTransactionToastElement(options);
        refs.toast.dataset.toastProtected = 'true';
        this.addToastToQueue(refs.toast, 0);

        return this.createTransactionProgressController(refs, options);
    }

    createTransactionToastElement(options) {
        const refs = this.createToastStructure('info', options.title);
        refs.toast.classList.add('toast-transaction');

        const summary = document.createElement('p');
        summary.className = 'toast-summary';
        summary.textContent = options.summary || '';
        summary.hidden = !options.summary;
        refs.body.appendChild(summary);

        const checklist = document.createElement('ul');
        checklist.className = 'toast-checklist';
        refs.body.appendChild(checklist);

        const stepRefs = new Map();
        options.steps.forEach(step => {
            const stepRef = this.createTransactionStep(step);
            checklist.appendChild(stepRef.item);
            stepRefs.set(step.id, stepRef);
        });

        const meta = document.createElement('div');
        meta.className = 'toast-transaction-meta';
        meta.hidden = true;

        const hashElement = document.createElement('code');
        hashElement.className = 'toast-transaction-hash';

        const link = document.createElement('a');
        link.className = 'toast-transaction-link';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.appendChild(document.createTextNode('View on explorer'));
        link.appendChild(this.createExternalLinkIcon());
        link.hidden = true;

        meta.appendChild(hashElement);
        meta.appendChild(link);
        refs.body.appendChild(meta);

        const terminalMessage = document.createElement('p');
        terminalMessage.className = 'toast-terminal-message';
        terminalMessage.hidden = true;
        refs.body.appendChild(terminalMessage);

        return {
            ...refs,
            summary,
            checklist,
            stepRefs,
            meta,
            hashElement,
            link,
            terminalMessage,
        };
    }

    createTransactionStep(step) {
        const item = document.createElement('li');
        item.className = 'toast-checklist-item';
        item.dataset.stepId = step.id;

        const icon = document.createElement('span');
        icon.className = 'toast-checklist-icon';
        item.appendChild(icon);

        const content = document.createElement('div');
        content.className = 'toast-checklist-content';

        const label = document.createElement('div');
        label.className = 'toast-checklist-label';
        label.textContent = step.label;
        content.appendChild(label);

        const detail = document.createElement('div');
        detail.className = 'toast-checklist-detail';
        content.appendChild(detail);

        item.appendChild(content);
        this.setTransactionStepState({ item, icon, detail }, step.status || 'pending', step.detail);

        return { item, icon, detail, label };
    }

    createExternalLinkIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'toast-transaction-link-icon');
        svg.setAttribute('viewBox', '0 0 24 24');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('fill', 'currentColor');
        path.setAttribute(
            'd',
            'M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z'
        );
        svg.appendChild(path);

        return svg;
    }

    createTransactionProgressController(refs, options) {
        const closeCallbacks = new Set();
        const setSummary = (message) => {
            refs.summary.textContent = message || '';
            refs.summary.hidden = !message;
        };

        const setTerminalMessage = (message) => {
            refs.terminalMessage.textContent = message || '';
            refs.terminalMessage.hidden = !message;
        };

        const setTypeAndTitle = (type, titleText) => {
            clearToastClasses(refs.toast);
            refs.toast.classList.add(`toast-${type}`);
            refs.icon.textContent = this.getTypeIcon(type);
            refs.title.textContent = titleText;
        };

        const finish = ({ type, title, summary, terminalMessage }) => {
            setTypeAndTitle(type, title);
            setSummary(summary);
            setTerminalMessage(terminalMessage);
        };

        refs.toast._onClose = () => {
            closeCallbacks.forEach(callback => {
                try {
                    callback();
                } catch (error) {
                    this.warn('Toast close callback failed', error);
                }
            });
        };

        return {
            updateStep: (stepId, update) => {
                const stepRef = refs.stepRefs.get(stepId);
                if (!stepRef) {
                    this.warn(`Transaction toast step not found: ${stepId}`);
                    return;
                }
                this.setTransactionStepState(
                    stepRef,
                    update.status || stepRef.item.dataset.stepStatus || 'pending',
                    update.detail
                );
            },
            setSummary,
            setTransaction: ({ hash, chainId }) => {
                if (!hash) {
                    refs.meta.hidden = true;
                    return;
                }

                refs.meta.hidden = false;
                refs.hashElement.textContent = shortenHash(hash);
                refs.hashElement.title = hash;

                const explorerUrl = getTransactionExplorerUrl(hash, chainId);
                if (explorerUrl !== '#') {
                    refs.link.href = explorerUrl;
                    refs.link.hidden = false;
                } else {
                    refs.link.hidden = true;
                    refs.link.removeAttribute('href');
                }
            },
            finishSuccess: (message) => {
                finish({
                    type: 'success',
                    title: options.successTitle,
                    summary: message || options.summary || '',
                    terminalMessage: '',
                });
            },
            finishFailure: (message) => {
                finish({
                    type: 'error',
                    title: options.failureTitle,
                    summary: '',
                    terminalMessage: message || 'Transaction failed.',
                });
            },
            finishCancelled: (message) => {
                finish({
                    type: 'warning',
                    title: options.cancelledTitle,
                    summary: '',
                    terminalMessage: message || 'Transaction cancelled.',
                });
            },
            onClose: (callback) => {
                if (typeof callback !== 'function') {
                    return () => {};
                }
                closeCallbacks.add(callback);
                return () => closeCallbacks.delete(callback);
            },
            close: () => {
                this.removeToast(refs.toast);
            }
        };
    }

    setTransactionStepState(stepRef, status, detail) {
        const normalizedStatus = status || 'pending';
        stepRef.item.dataset.stepStatus = normalizedStatus;

        stepRef.item.classList.remove(
            'is-pending',
            'is-active',
            'is-completed',
            'is-failed',
            'is-cancelled'
        );
        stepRef.item.classList.add(`is-${normalizedStatus}`);
        stepRef.icon.textContent = this.getStepStatusIcon(normalizedStatus);
        stepRef.detail.textContent = detail || '';
        stepRef.detail.hidden = !detail;
    }

    getStepStatusIcon(status) {
        switch (status) {
            case 'active':
                return '\u25CF';
            case 'completed':
                return '\u2714';
            case 'failed':
                return '\u2716';
            case 'cancelled':
                return '\u2212';
            case 'pending':
            default:
                return '\u25CB';
        }
    }

    addToastToQueue(toast, duration) {
        this.toastQueue.push({ toast, duration });

        if (!this.isProcessing) {
            this.processQueue();
        }
    }

    processQueue() {
        if (this.toastQueue.length === 0) {
            this.isProcessing = false;
            return;
        }

        this.isProcessing = true;

        while (this.container.children.length >= this.maxToasts) {
            const removableToast = this.findOldestRemovableToast();
            if (!removableToast) break;
            this.forceRemoveToast(removableToast);
        }

        const { toast, duration } = this.toastQueue.shift();
        this.showToastElement(toast, duration);
    }

    findOldestRemovableToast() {
        return Array.from(this.container.children).find(
            toast => toast.dataset.toastProtected !== 'true'
        ) || null;
    }

    showToastElement(toast, duration) {
        this.container.appendChild(toast);

        requestAnimationFrame(() => {
            toast.classList.add('toast-show');
        });

        if (duration > 0) {
            const timeoutId = setTimeout(() => {
                this.removeToast(toast);
            }, duration);
            toast.dataset.timeoutId = timeoutId;
        }

        setTimeout(() => {
            this.processQueue();
        }, 100);
    }

    removeToast(toast) {
        if (toast.dataset.timeoutId) {
            clearTimeout(parseInt(toast.dataset.timeoutId, 10));
            delete toast.dataset.timeoutId;
        }

        if (!toast._closeHandled) {
            toast._closeHandled = true;
            toast._onClose?.();
        }

        toast.classList.add('toast-hide');

        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }

    forceRemoveToast(toast) {
        if (!toast) return;
        if (toast.dataset?.timeoutId) {
            clearTimeout(parseInt(toast.dataset.timeoutId, 10));
            delete toast.dataset.timeoutId;
        }
        if (!toast._closeHandled) {
            toast._closeHandled = true;
            toast._onClose?.();
        }
        if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
    }

    clearAll() {
        this.debug('Clearing all toasts');
        this.toastQueue = [];

        while (this.container.firstChild) {
            this.container.removeChild(this.container.firstChild);
        }

        this.isProcessing = false;
    }

    showError(message, duration = 5000) {
        return this.showToast(message, 'error', duration);
    }

    showSuccess(message, duration = 5000) {
        return this.showToast(message, 'success', duration);
    }

    showWarning(message, duration = 5000) {
        return this.showToast(message, 'warning', duration);
    }

    showInfo(message, duration = 5000) {
        return this.showToast(message, 'info', duration);
    }
}

let globalToast = null;

export function getToast() {
    if (!globalToast) {
        globalToast = new Toast();
    }
    return globalToast;
}

export function showToast(message, type = 'info', duration = 5000, persistent = false) {
    const toast = getToast();
    return toast.showToast(message, type, duration, persistent);
}

export function createTransactionProgress(options) {
    const toast = getToast();
    return toast.createTransactionProgress(options);
}

export function showError(message, duration = 0, persistent = true) {
    return showToast(message, 'error', duration, persistent);
}

export function showSuccess(message, duration = 5000, persistent = false) {
    return showToast(message, 'success', duration, persistent);
}

export function showWarning(message, duration = 5000, persistent = false) {
    return showToast(message, 'warning', duration, persistent);
}

export function showInfo(message, duration = 5000, persistent = false) {
    return showToast(message, 'info', duration, persistent);
}
