// Pure TW symbol helpers (no 'use server': safe to import from client components,
// API routes and server actions alike).

export type TwMarket = 'tse' | 'otc';

/** Parse `TWSE:2330`, `TPEX:5483`, `TWSE:TAIEX` (index) or bare `2330` (assumed TWSE). Null = not a TW symbol. */
export function parseTwSymbol(symbol: string): { market: TwMarket; code: string; tvSymbol: string } | null {
    const upper = (symbol || '').trim().toUpperCase();
    const m = upper.match(/^(TWSE|TPEX):(\d{4}[A-Z]?|TAIEX)$/);
    if (m) {
        // TAIEX (the capitalization-weighted index) is served by MIS as code t00.
        const code = m[2] === 'TAIEX' ? 't00' : m[2];
        return { market: m[1] === 'TWSE' ? 'tse' : 'otc', code, tvSymbol: upper };
    }
    const bare = upper.match(/^(\d{4}[A-Z]?)$/);
    if (bare) return { market: 'tse', code: bare[1], tvSymbol: `TWSE:${bare[1]}` };
    return null;
}
