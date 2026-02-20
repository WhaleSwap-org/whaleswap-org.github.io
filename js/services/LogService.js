import { isDebugEnabled } from '../config/debug.js';

export class LogService {
    constructor(component) {
        this.component = component;
        this.prefix = `[${component}]`;
    }

    debug(message, ...args) {
        if (isDebugEnabled(this.component)) {
            console.log(this.prefix, message, ...args);
        }
    }

    error(message, ...args) {
        console.error(this.prefix, message, ...args);
    }

    warn(message, ...args) {
        console.warn(this.prefix, message, ...args);
    }
}

// Create a factory function for easier instantiation
export const createLogger = (component) => new LogService(component); 
