import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            ethers: path.resolve(__dirname, 'tests/mocks/ethers.js')
        }
    },
    test: {
        environment: 'jsdom',
        include: ['tests/**/*.test.js'],
        globals: true
    }
});
