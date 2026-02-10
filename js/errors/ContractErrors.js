export class ContractError extends Error {
    constructor(message, code, details = {}) {
        super(message);
        this.name = 'ContractError';
        this.code = code;
        this.details = details;
    }
}

export const CONTRACT_ERRORS = {
    INVALID_ORDER: {
        code: 'INVALID_ORDER',
        message: 'This order no longer exists'
    },
    INSUFFICIENT_ALLOWANCE: {
        code: 'INSUFFICIENT_ALLOWANCE',
        message: 'Please approve tokens before proceeding'
    },
    UNAUTHORIZED: {
        code: 'UNAUTHORIZED',
        message: 'You are not authorized to perform this action'
    },
    EXPIRED_ORDER: {
        code: 'EXPIRED_ORDER',
        message: 'This order has expired'
    }
}; 