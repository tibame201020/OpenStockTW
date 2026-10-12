'use server';

// Taiwan market data layer (TWSE + TPEx), replacing Finnhub.
//
// All data comes from free, no-key public endpoints:
//   Intraday (delayed ~20 min): https://mis.twse.com.tw/stock/api/getStockInfo.jsp
//   Daily bars (TWSE):          https://www.twse.com.tw/exchangeReport/STOCK_DAY
//   Daily bars (TPEx):          https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php
//   Stock list:                 local snapshot lib/tw/tw-stocks.json (scripts/seed-tw-stocks.mjs)
//   News:                       Yahoo TW stock RSS (best-effort)
//
// Symbol convention: `TWSE:2330` (listed), `TPEX:5483` (OTC). Bare `2330` is
// treated as TWSE. Exported function signatures and return shapes intentionally
// mirror the old Finnhub actions (quote fields c/d/dp/h/l/o/pc/t) so callers
// don't change.

import { cache } from 'react';
import { QUOTE_TTL_SECONDS } from '@/lib/market-data';
import { hasNativeQuotes } from '@/lib/markets';
import { POPULAR_STOCKS } from '@/lib/constants';
import { validateArticle, formatArticle } from '@/lib/utils';
import TW_STOCK_LIST_1 from '@/lib/tw/tw-stocks-1.json';
import TW_STOCK_LIST_2 from '@/lib/tw/tw-stocks-2.json';
import TW_STOCK_LIST_3 from '@/lib/tw/tw-stocks-3.json';

type TwStockEntry = {
    code: string;
    name: string;
    exchange: 'TWSE' | 'TPEX';
    symbol: string;
    type: string;
};

const TW_STOCKS: TwStockEntry[] = [
    ...(TW_STOCK_LIST_1 as { stocks: TwStockEntry[] }).stocks,
    ...(TW_STOCK_LIST_2 as { stocks: TwStockEntry[] }).stocks,
    ...(TW_STOCK_LIST_3 as { stocks: TwStockEntry[] }).stocks,
];
const STOCK_BY_SYMBOL = new Map(TW_STOCKS.map((s) => [s.symbol, s]));
const STOCK_BY_CODE = new Map<string, TwStockEntry[]>();
for (const s of TW_STOCKS) {
    const arr = STOCK_BY_CODE.get(s.code) ?? [];
    arr.push(s);
    STOCK_BY_CODE.set(s.code, arr);
}

// ---------------------------------------------------------------------------
// Symbol handling
// ---------------------------------------------------------------------------

import { parseTwSymbol, type TwMarket } from '@/lib/tw/symbols';

/** MIS ex_ch token for one symbol, e.g. `tse_2330.tw` / `otc_5483.tw`. */
const exChToken = (parsed: { market: TwMarket; code: string }) =>
    `${parsed.market === 'tse' ? 'tse' : 'otc'}_${parsed.code}.tw`;

// ---------------------------------------------------------------------------
// Caching: same stale-while-revalidate design as the old Finnhub layer.
// TW endpoints are free and keyless, so no key pool / rate limiter.
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 8000;
const MAX_CACHE_ENTRIES = 1000;
const FAILURE_TTL_MS = 60_000;
const LIVE_QUOTE_TTL = QUOTE_TTL_SECONDS;
const SHARED_CACHE_MIN_TTL = 60;
const UA = { 'User-Agent': 'openstock-tw/0.1 (market data; polite pacing)' };

class RecentFailure extends Error {}
const logFailure = (what: string, symbol: string, e: unknown) => {
    if (!(e instanceof RecentFailure)) console.error(`Error fetching ${what} for`, symbol, e);
};

const inFlight = new Map<string, Promise<unknown>>();
const responseCache = new Map<string, { value: unknown; freshUntil: number; failed?: boolean }>();

async function request<T>(url: string, ttl = 0): Promise<T> {
    let pending = inFlight.get(url) as Promise<T> | undefined;
    if (!pending) {
        pending = (async () => {
            const res = await fetch(url, {
                headers: UA,
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                ...(ttl >= SHARED_CACHE_MIN_TTL ? { next: { revalidate: ttl } } : { cache: 'no-store' as const }),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`Fetch failed ${res.status}: ${text.slice(0, 200)}`);
            }
            return (await res.json()) as T;
        })().finally(() => inFlight.delete(url));
        inFlight.set(url, pending);
    }
    return pending;
}

async function fetchJSON<T>(url: string, revalidateSeconds = 0): Promise<T> {
    if (!revalidateSeconds) return request<T>(url);

    const store = (entry: { value: unknown; freshUntil: number; failed?: boolean }) => {
        if (responseCache.size >= MAX_CACHE_ENTRIES) responseCache.delete(responseCache.keys().next().value!);
        responseCache.set(url, entry);
    };
    const refresh = () =>
        request<T>(url, revalidateSeconds).then(
            (value) => {
                store({ value, freshUntil: Date.now() + revalidateSeconds * 1000 });
                return value;
            },
            (error) => {
                const existing = responseCache.get(url);
                store(
                    existing && !existing.failed
                        ? { value: existing.value, freshUntil: Date.now() + FAILURE_TTL_MS }
                        : { value: null, freshUntil: Date.now() + FAILURE_TTL_MS, failed: true }
                );
                throw error;
            }
        );

    const hit = responseCache.get(url);
    if (!hit || (hit.failed && hit.freshUntil < Date.now())) return refresh();
    if (hit.failed) throw new RecentFailure(`TW request failed recently: ${url.split('?')[0]}`);
    if (hit.freshUntil < Date.now()) refresh().catch(() => {});
    return hit.value as T;
}

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url, {
        headers: UA,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
    return res.text();
}

// ---------------------------------------------------------------------------
// Quotes (MIS intraday snapshot, delayed ~20 min per TWSE policy)
// ---------------------------------------------------------------------------

export type TwQuote = {
    c?: number; // current
    d?: number; // change
    dp?: number; // change %
    h?: number; // day high
    l?: number; // day low
    o?: number; // open
    pc?: number; // previous close
    t?: number; // unix time of the snapshot
};

type MisRow = {
    c?: string; // code
    n?: string; // name
    o?: string; h?: string; l?: string; y?: string; // open/high/low/prev close
    z?: string; pz?: string; // last price fields (use whichever parses)
    a?: string; b?: string; // best-5 ask / bid, '_' separated, first entry = best
    tlong?: string; // epoch ms
};

const num = (v: unknown): number | undefined => {
    if (v === null || v === undefined) return undefined;
    const s = String(v).replace(/,/g, '').trim();
    if (!s || s === '-' || s === '--' || s === '---' || s === 'X') return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
};

function misRowToQuote(row: MisRow): TwQuote | null {
    // MIS sometimes blanks z/pz (e.g. 2330 showed '-' mid-session on 2026-10-12
    // while bid/ask were live). For a mock broker, fall back to bid/ask mid,
    // then prev close — rejecting the order is worse than a slightly stale fill.
    const best = (s: string | undefined): number | undefined =>
        s ? num(s.split('_')[0]) : undefined;
    const ask = best(row.a);
    const bid = best(row.b);
    const mid = ask !== undefined && bid !== undefined ? (ask + bid) / 2 : (ask ?? bid);
    const last = num(row.z) ?? num(row.pz) ?? mid ?? num(row.y);
    if (last === undefined) return null;
    const pc = num(row.y);
    const d = pc !== undefined ? last - pc : undefined;
    const dp = pc !== undefined && pc !== 0 && d !== undefined ? (d / pc) * 100 : undefined;
    const t = row.tlong ? Math.floor(Number(row.tlong) / 1000) : Math.floor(Date.now() / 1000);
    return {
        c: last,
        d,
        dp,
        h: num(row.h),
        l: num(row.l),
        o: num(row.o),
        pc,
        t: Number.isFinite(t) ? t : Math.floor(Date.now() / 1000),
    };
}

type MisResponse = { msgArray?: MisRow[]; rtcode?: string };

function misUrl(exCh: string) {
    return `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0&_=${Date.now()}`;
}

export async function getQuote(symbol: string, revalidateSeconds = 0): Promise<TwQuote | null> {
    try {
        const parsed = parseTwSymbol(symbol);
        if (!parsed) return null;
        const url = misUrl(exChToken(parsed));
        const data = await fetchJSON<MisResponse>(url, revalidateSeconds);
        const row = (data.msgArray ?? []).find((r) => r.c === parsed.code);
        if (!row) return null;
        return misRowToQuote(row);
    } catch (e) {
        logFailure('quote', symbol, e);
        return null;
    }
}

/** Shared, short-lived quotes for anything shown live on screen (pages and /api/quotes). */
export async function getLiveQuotes(symbols: string[]) {
    const parsed = symbols.map((s) => ({ s, p: parseTwSymbol(s) }));
    const quotable = parsed.filter((x) => x.p && hasNativeQuotes(x.s));
    // MIS accepts pipe-separated ex_ch for batching; chunk to stay well under limits.
    const CHUNK = 40;
    const byToken = new Map<string, TwQuote>();
    for (let i = 0; i < quotable.length; i += CHUNK) {
        const chunk = quotable.slice(i, i + CHUNK);
        const exCh = chunk.map((x) => exChToken(x.p!)).join('|');
        try {
            const data = await fetchJSON<MisResponse>(misUrl(exCh), LIVE_QUOTE_TTL);
            for (const row of data.msgArray ?? []) {
                const q = misRowToQuote(row);
                if (q && row.c) byToken.set(row.c, q);
            }
        } catch (e) {
            logFailure('live quotes', `${chunk.length} symbols`, e);
        }
    }
    return Object.fromEntries(
        symbols.map((s) => {
            const p = parseTwSymbol(s);
            const q = p ? byToken.get(p.code) : undefined;
            return [s, q?.c ? q : null];
        })
    );
}

// ---------------------------------------------------------------------------
// Company profile (from local list; never fabricated)
// ---------------------------------------------------------------------------

export type TwCompanyProfile = {
    currency?: string;
    exchange?: string;
    logo?: string;
    marketCapitalization?: number;
    name?: string;
    ticker?: string;
};

export async function getCompanyProfile(symbol: string): Promise<TwCompanyProfile | null> {
    const parsed = parseTwSymbol(symbol);
    if (!parsed || !hasNativeQuotes(symbol)) return null;
    if (parsed.tvSymbol === 'TWSE:TAIEX') {
        return { currency: 'TWD', exchange: 'TWSE', name: '加權指數', ticker: 'TAIEX' };
    }
    const entry = STOCK_BY_SYMBOL.get(parsed.tvSymbol) ?? STOCK_BY_CODE.get(parsed.code)?.[0];
    if (!entry) return null;
    return {
        currency: 'TWD',
        exchange: entry.exchange,
        name: entry.name,
        ticker: entry.code,
        // marketCapitalization intentionally omitted: no free source; never fabricate.
    };
}

// ---------------------------------------------------------------------------
// Watchlist rows
// ---------------------------------------------------------------------------

export async function getWatchlistData(symbols: string[]) {
    if (!symbols || symbols.length === 0) return [];

    const promises = symbols.map(async (sym) => {
        const covered = hasNativeQuotes(sym);
        const [quote, profile] = covered
            ? await Promise.all([getQuote(sym, LIVE_QUOTE_TTL), getCompanyProfile(sym)])
            : [null, null];

        return {
            symbol: sym,
            price: quote?.c || 0,
            change: quote?.d || 0,
            changePercent: quote?.dp || 0,
            currency: profile?.currency || 'TWD',
            name: profile?.name || sym,
            logo: profile?.logo,
            marketCap: profile?.marketCapitalization,
            peRatio: 0, // No free real-time PE source for TW; left as 0 like before.
        };
    });

    return await Promise.all(promises);
}

// ---------------------------------------------------------------------------
// News: Yahoo TW stock RSS, best-effort. Never throws; [] on any failure.
// ---------------------------------------------------------------------------

const NEWS_RSS_URLS = [
    'https://tw.stock.yahoo.com/rss', // Yahoo 台股新聞
    'https://feeds.feedburner.com/cnyes', // Anue 鉅亨
];

const stripCdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
const stripTags = (s: string) =>
    stripCdata(s)
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();

async function fetchRssArticles(url: string): Promise<RawNewsArticle[]> {
    const xml = await fetchText(url);
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
    const out: RawNewsArticle[] = [];
    for (const item of items.slice(0, 30)) {
        const pick = (tag: string) => {
            const m = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`));
            return m ? stripTags(m[1]) : '';
        };
        const headline = pick('title');
        const link = pick('link') || pick('guid');
        const pubDate = pick('pubDate');
        if (!headline || !link) continue;
        const datetime = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : Math.floor(Date.now() / 1000);
        if (!Number.isFinite(datetime)) continue;
        out.push({
            id: out.length,
            headline,
            summary: pick('description').slice(0, 300),
            url: link,
            datetime,
            source: new URL(url).hostname.replace(/^www\./, ''),
            image: '',
            category: 'general',
        });
    }
    return out;
}

export async function getNews(symbols?: string[]): Promise<MarketNewsArticle[]> {
    try {
        const cleanSymbols = (symbols || [])
            .map((s) => parseTwSymbol(s)?.code)
            .filter((s): s is string => Boolean(s));
        const entryByCode = (code: string) => STOCK_BY_CODE.get(code)?.[0]?.name ?? '';

        let articles: RawNewsArticle[] = [];
        for (const url of NEWS_RSS_URLS) {
            try {
                articles = await fetchRssArticles(url);
                if (articles.length) break;
            } catch (e) {
                console.error('RSS fetch failed:', url, e);
            }
        }
        articles = articles.filter(validateArticle);
        if (!articles.length) return [];

        // Prefer items mentioning one of the requested symbols (code or company name).
        const maxArticles = 6;
        let picked = articles;
        if (cleanSymbols.length) {
            const matched = articles.filter((a) => {
                const h = a.headline ?? '';
                return cleanSymbols.some((code) => h.includes(code) || h.includes(entryByCode(code)));
            });
            if (matched.length) picked = matched;
        }
        picked = [...picked].sort((a, b) => (b.datetime || 0) - (a.datetime || 0)).slice(0, maxArticles);
        return picked.map((a, idx) => formatArticle(a, false, undefined, idx));
    } catch (err) {
        console.error('getNews error:', err);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Search: local TW stock list (fuzzy on code / name). No query -> popular TW.
// ---------------------------------------------------------------------------

function scoreStock(entry: TwStockEntry, q: string): number {
    const code = entry.code;
    const name = entry.name;
    if (code === q) return 100;
    if (code.startsWith(q)) return 80;
    if (name === q) return 70;
    if (name.startsWith(q)) return 60;
    if (code.includes(q)) return 40;
    if (name.includes(q)) return 30;
    return 0;
}

export const searchStocks = cache(async (query?: string): Promise<StockWithWatchlistStatus[]> => {
    try {
        const trimmed = typeof query === 'string' ? query.trim().toUpperCase() : '';
        // Strip an exchange prefix if the user typed one (TWSE:2330 / TPEX:5483).
        const q = trimmed.replace(/^(TWSE|TPEX):/, '');

        let results: TwStockEntry[];
        if (!q) {
            results = POPULAR_STOCKS.map(
                ({ symbol, name, exchange }) => STOCK_BY_SYMBOL.get(symbol) ?? { code: symbol.replace(/^(TWSE|TPEX):/, ''), name, exchange: (exchange === 'TPEX' ? 'TPEX' : 'TWSE') as 'TWSE' | 'TPEX', symbol, type: 'Common Stock' }
            );
        } else {
            results = TW_STOCKS.map((s) => ({ s, score: scoreStock(s, q) }))
                .filter((x) => x.score > 0)
                .sort((a, b) => b.score - a.score || a.s.code.localeCompare(b.s.code))
                .slice(0, 15)
                .map((x) => x.s);
        }

        return results.map((r) => ({
            symbol: r.symbol,
            name: r.name,
            exchange: r.exchange,
            type: r.type,
            isInWatchlist: false,
        }));
    } catch (err) {
        console.error('Error in stock search:', err);
        return [];
    }
});
