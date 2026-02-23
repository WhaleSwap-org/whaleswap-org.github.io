import { isDebugEnabled } from '../config/debug.js';

export class LogService {
    constructor(component) {
        this.component = component;
        this.prefix = `[${component}]`;
        this.debug = isDebugEnabled(component)
            ? console.log.bind(console, this.prefix)
            : () => {};
        this.error = console.error.bind(console, this.prefix);
        this.warn = console.warn.bind(console, this.prefix);
    }
}

// Create a factory function for easier instantiation
export const createLogger = (component) => new LogService(component); 
