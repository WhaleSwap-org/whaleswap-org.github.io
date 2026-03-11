function cloneStep(step) {
    return {
        id: step.id,
        label: step.label,
        status: step.status || 'pending',
        detail: step.detail || '',
    };
}

function cloneSteps(steps) {
    return steps.map(cloneStep);
}

function applyTerminalState(controller, terminalState) {
    if (!terminalState) return;

    switch (terminalState.type) {
        case 'success':
            controller.finishSuccess(terminalState.message);
            break;
        case 'failure':
            controller.finishFailure(terminalState.message);
            break;
        case 'cancelled':
            controller.finishCancelled(terminalState.message);
            break;
        default:
            break;
    }
}

export function createTransactionProgressSession(toastApi, options) {
    const visibilityListeners = new Set();
    const state = {
        baseOptions: {
            title: options.title,
            successTitle: options.successTitle,
            failureTitle: options.failureTitle,
            cancelledTitle: options.cancelledTitle,
        },
        summary: options.summary || '',
        steps: cloneSteps(options.steps || []),
        transaction: null,
        terminalState: null,
        controller: null,
        hidden: false,
    };

    const notifyVisibility = () => {
        visibilityListeners.forEach(listener => {
            try {
                listener({
                    hidden: state.hidden,
                    active: !state.terminalState,
                });
            } catch (error) {
                console.warn('[transactionProgress] Visibility listener failed', error);
            }
        });
    };

    const createController = () => {
        const controller = toastApi.createTransactionProgress({
            ...state.baseOptions,
            summary: state.summary,
            steps: cloneSteps(state.steps),
        });

        controller.onClose(() => {
            state.hidden = true;
            state.controller = null;
            notifyVisibility();
        });

        state.controller = controller;
        state.hidden = false;

        if (state.transaction) {
            controller.setTransaction(state.transaction);
        }

        applyTerminalState(controller, state.terminalState);
        notifyVisibility();
        return controller;
    };

    const getController = () => state.controller || createController();

    createController();

    return {
        updateStep(stepId, update) {
            const step = state.steps.find(item => item.id === stepId);
            if (!step) return;
            if (update.status) {
                step.status = update.status;
            }
            if (Object.prototype.hasOwnProperty.call(update, 'detail')) {
                step.detail = update.detail || '';
            }
            if (state.controller) {
                state.controller.updateStep(stepId, update);
            }
        },
        setSummary(message) {
            state.summary = message || '';
            if (state.controller) {
                state.controller.setSummary(state.summary);
            }
        },
        setTransaction(transaction) {
            state.transaction = transaction || null;
            if (state.controller && transaction) {
                state.controller.setTransaction(transaction);
            }
        },
        finishSuccess(message) {
            state.terminalState = { type: 'success', message };
            getController().finishSuccess(message);
        },
        finishFailure(message) {
            state.terminalState = { type: 'failure', message };
            getController().finishFailure(message);
        },
        finishCancelled(message) {
            state.terminalState = { type: 'cancelled', message };
            getController().finishCancelled(message);
        },
        reopen() {
            getController();
        },
        isHidden() {
            return state.hidden;
        },
        isVisible() {
            return !state.hidden;
        },
        isActive() {
            return !state.terminalState;
        },
        onVisibilityChange(listener) {
            if (typeof listener !== 'function') {
                return () => {};
            }
            visibilityListeners.add(listener);
            return () => visibilityListeners.delete(listener);
        }
    };
}
