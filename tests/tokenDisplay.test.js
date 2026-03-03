import { describe, expect, it } from 'vitest';
import {
    buildTokenDisplaySymbolMap,
    getDisplaySymbol,
    resolveDisplayChainId
} from '../js/utils/tokenDisplay.js';

const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN_C = '0xcccccccccccccccccccccccccccccccccccccccc';
const TEST_SUFFIXES = {
    137: {
        [TOKEN_A]: 'issuer'
    }
};

describe('tokenDisplay utilities', () => {
    it('parses numeric and hex chain IDs', () => {
        expect(resolveDisplayChainId(137)).toBe(137);
        expect(resolveDisplayChainId('137')).toBe(137);
        expect(resolveDisplayChainId('0x89')).toBe(137);
    });

    it('keeps unique symbols unchanged', () => {
        const tokens = [
            { address: TOKEN_A, symbol: 'USDC' },
            { address: TOKEN_B, symbol: 'WETH' }
        ];

        const map = buildTokenDisplaySymbolMap(tokens, 137);
        expect(map.get(TOKEN_A)).toBe('USDC');
        expect(map.get(TOKEN_B)).toBe('WETH');
    });

    it('applies suffix mapping even when symbol is unique', () => {
        const tokens = [
            { address: TOKEN_A, symbol: 'AAA' },
            { address: TOKEN_C, symbol: 'USDC' }
        ];

        const map = buildTokenDisplaySymbolMap(tokens, 137, TEST_SUFFIXES);
        expect(map.get(TOKEN_A)).toBe('AAA.issuer');
        expect(map.get(TOKEN_C)).toBe('USDC');
    });

    it('applies issuer postfix from provided mapping for symbol collisions', () => {
        const tokens = [
            { address: TOKEN_A, symbol: 'AAA' },
            { address: TOKEN_B, symbol: 'AAA' }
        ];

        const map = buildTokenDisplaySymbolMap(tokens, '0x89', TEST_SUFFIXES);
        expect(map.get(TOKEN_A)).toBe('AAA.issuer');
        expect(map.get(TOKEN_B)).toBe('AAA');
    });

    it('does not append address suffix for unmapped collisions', () => {
        const tokens = [
            { address: TOKEN_B, symbol: 'ABC' },
            { address: TOKEN_C, symbol: 'ABC' }
        ];

        const map = buildTokenDisplaySymbolMap(tokens, 137, TEST_SUFFIXES);
        expect(map.get(TOKEN_B)).toBe('ABC');
        expect(map.get(TOKEN_C)).toBe('ABC');
    });

    it('prefers map value, then token displaySymbol, then symbol', () => {
        const map = new Map([
            ['0xabc0000000000000000000000000000000000000', 'ABC.pol']
        ]);

        expect(
            getDisplaySymbol(
                { address: '0xAbC0000000000000000000000000000000000000', symbol: 'ABC' },
                map
            )
        ).toBe('ABC.pol');
        expect(getDisplaySymbol({ symbol: 'ABC', displaySymbol: 'ABC.issuer' }, null)).toBe('ABC.issuer');
        expect(getDisplaySymbol({ symbol: 'ABC' }, null)).toBe('ABC');
    });
});
