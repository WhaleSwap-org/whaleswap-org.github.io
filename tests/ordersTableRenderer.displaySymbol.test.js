import { afterEach, describe, expect, it } from 'vitest';
import { OrdersTableRenderer } from '../js/services/OrdersTableRenderer.js';

const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN_C = '0xcccccccccccccccccccccccccccccccccccccccc';
const TEST_SUFFIXES = {
    137: {
        [TOKEN_A]: 'issuer'
    }
};

function createRenderer(tokens, chainId = '0x89', preferredSymbolSuffixes = null) {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const tokenEntries = tokens.map((token) => [token.address.toLowerCase(), token]);
    const component = {
        container,
        tokenDisplaySymbolMap: null,
        preferredSymbolSuffixes,
        createElement(tag, className = '') {
            const element = document.createElement(tag);
            if (className) {
                element.className = className;
            }
            return element;
        },
        ctx: {
            getWebSocket: () => ({
                tokenCache: new Map(tokenEntries)
            }),
            getWalletChainId: () => chainId
        }
    };

    return new OrdersTableRenderer(component, { showRefreshButton: false });
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('OrdersTableRenderer display symbols', () => {
    it('renders suffix labels for mapped symbol collisions', () => {
        const renderer = createRenderer([
            { address: TOKEN_A, symbol: 'AAA' },
            { address: TOKEN_B, symbol: 'AAA' },
            { address: TOKEN_C, symbol: 'USDC' }
        ], '0x89', TEST_SUFFIXES);

        const filterControls = renderer._createFilterControls(() => {});
        const sellOptions = Array.from(
            filterControls.querySelectorAll('#sell-token-filter option')
        ).map((option) => option.textContent.trim());

        expect(sellOptions).toEqual(['All Buy Tokens', 'AAA', 'AAA.issuer', 'USDC']);
        expect(renderer.component.tokenDisplaySymbolMap.get(TOKEN_A)).toBe('AAA.issuer');
    });

    it('does not apply mapping on non-configured chains', () => {
        const renderer = createRenderer([
            { address: TOKEN_A, symbol: 'AAA' },
            { address: TOKEN_B, symbol: 'AAA' },
            { address: TOKEN_C, symbol: 'USDC' }
        ], '0x1', TEST_SUFFIXES);

        const filterControls = renderer._createFilterControls(() => {});
        const sellOptions = Array.from(
            filterControls.querySelectorAll('#sell-token-filter option')
        ).map((option) => option.textContent.trim());

        expect(sellOptions.includes('AAA.issuer')).toBe(false);
        expect(sellOptions.filter((label) => label === 'AAA')).toHaveLength(2);
    });
});
