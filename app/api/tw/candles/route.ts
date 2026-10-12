import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/better-auth/auth';
import { parseTwSymbol } from '@/lib/tw/symbols';
import { connectToDatabase } from '@/database/mongoose';
import { DailyBar } from '@/database/models/daily-bar.model';

// Daily OHLCV candles for TW symbols, sourced from free TWSE/TPEx endpoints:
//   TWSE: https://www.twse.com.tw/exchangeReport/STOCK_DAY (one calendar month per call)
//   TPEX: https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php (one day per call)
//
// GET /api/tw/candles?symbol=TWSE:2330&range=6m   (range: 3m | 6m | 1y)

const UA = { 'User-Agent': 'openstock-tw/0.1 (candles; polite pacing)' };
const TIMEOUT = 15000;

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number };

const num = (v: unknown): number | undefined => {
    if (v === null || v === undefined) return undefined;
    const s = String(v).replace(/,/g, '').trim();
    if (!s || s === '-' || s === '--' || s === '---' || s === 'X' || s === 'null') return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
};

const rocToIso = (roc: string): string | null => {
    const m = roc.trim().match(/^(\d+)\/(\d+)\/(\d+)$/);
    if (!m) return null;
    return `${Number(m[1]) + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
};

const toRoc = (d: Date) => `${d.getFullYear() - 1911}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;

async function getJSON(url: string) {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(TIMEOUT), cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/** TWSE: walk calendar months covering [start, end], STOCK_DAY per month. */
async function twseCandles(code: string, start: Date, end: Date): Promise<Candle[]> {
    const out: Candle[] = [];
    const y = start.getFullYear();
    const m = start.getMonth();
    let cy = y;
    let cm = m;
    while (cy < end.getFullYear() || (cy === end.getFullYear() && cm <= end.getMonth())) {
        const dateParam = `${cy}${String(cm + 1).padStart(2, '0')}01`;
        const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateParam}&stockNo=${code}`;
        try {
            const payload = await getJSON(url);
            if (payload?.stat === 'OK' && Array.isArray(payload.data)) {
                for (const row of payload.data) {
                    // [date(ROC), volume(shares), amount, open, high, low, close, change, trades]
                    const time = rocToIso(String(row[0]));
                    const open = num(row[3]);
                    const high = num(row[4]);
                    const low = num(row[5]);
                    const close = num(row[6]);
                    const volume = num(row[1]);
                    if (time && open !== undefined && high !== undefined && low !== undefined && close !== undefined) {
                        out.push({ time, open, high, low, close, volume: volume ?? 0 });
                    }
                }
            }
        } catch (e) {
            console.error('TWSE candles month failed', code, dateParam, e);
        }
        cm += 1;
        if (cm > 11) {
            cm = 0;
            cy += 1;
        }
    }
    const seen = new Set<string>();
    return out
        .filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)))
        .sort((a, b) => (a.time < b.time ? -1 : 1));
}

/**
 * TPEx: no monthly per-ticker endpoint; backfill day-by-day via st43.
 * Best-effort: TPEx web endpoints sometimes block datacenter IPs; on failure
 * the route returns 502 and the UI falls back to the TradingView widget.
 */
async function tpexCandles(code: string, tradingDays: number): Promise<Candle[]> {
    const out: Candle[] = [];
    const dates: string[] = [];
    const d = new Date();
    // Collect up to tradingDays*1.6 calendar days back (skips weekends), enough for holidays.
    let guard = 0;
    while (dates.length < Math.ceil(tradingDays * 1.6) && guard++ < 600) {
        d.setDate(d.getDate() - 1);
        const day = d.getDay();
        if (day === 0 || day === 6) continue;
        dates.push(toRoc(d));
    }
    const BATCH = 6;
    for (let i = 0; i < dates.length && out.length < tradingDays; i += BATCH) {
        const batch = dates.slice(i, i + BATCH);
        const results = await Promise.all(
            batch.map(async (roc) => {
                // st43_result.php aaData row: [code, name, close, +/-, open, high, low, avg, volume, amount, trades, ...]
                const url = `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=${roc}&stkno=${code}`;
                try {
                    const payload = await getJSON(url);
                    const row = (payload?.aaData ?? []).find((r: string[]) => String(r[0]).trim() === code);
                    if (!row) return null;
                    const time = rocToIso(roc)!;
                    const close = num(row[2]);
                    const open = num(row[4]);
                    const high = num(row[5]);
                    const low = num(row[6]);
                    const volume = num(row[8]);
                    if (close === undefined || open === undefined || high === undefined || low === undefined) return null;
                    return { time, open, high, low, close, volume: volume ?? 0 } as Candle;
                } catch {
                    return null;
                }
            })
        );
        for (const c of results) if (c) out.push(c);
    }
    if (!out.length) throw new Error('TPEx daily history unavailable (endpoint blocked or no data)');
    const seen = new Set<string>();
    return out
        .filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)))
        .sort((a, b) => (a.time < b.time ? -1 : 1))
        .slice(-tradingDays);
}

const RANGE_DAYS: Record<string, number> = { '3m': 63, '6m': 126, '1y': 252 };

export async function GET(req: NextRequest) {
    const session = await getSession();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const symbol = (req.nextUrl.searchParams.get('symbol') ?? '').toUpperCase();
    const range = req.nextUrl.searchParams.get('range') ?? '6m';
    const parsed = parseTwSymbol(symbol);
    if (!parsed || parsed.code === 't00') {
        return NextResponse.json({ error: 'Only TWSE/TPEX stock symbols supported' }, { status: 400 });
    }
    const tradingDays = RANGE_DAYS[range] ?? RANGE_DAYS['6m'];

    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - Math.ceil(tradingDays * 1.6));
    const isoDay = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    // Prefer local MongoDB history (scripts/backfill-tw-history.mjs); fall back
    // to live TWSE/TPEx endpoints when local coverage is thin or stale.
    try {
        await connectToDatabase();
        const bars = await DailyBar.find({
            symbol: parsed.tvSymbol,
            date: { $gte: isoDay(start), $lte: isoDay(end) },
        })
            .sort({ date: 1 })
            .lean();
        const latest = bars.length ? String(bars[bars.length - 1].date) : '';
        const daysStale = latest
            ? Math.round((Date.parse(isoDay(end)) - Date.parse(latest)) / 86400000)
            : 999;
        if (bars.length >= Math.min(tradingDays, 60) * 0.5 && daysStale <= 4) {
            return NextResponse.json(
                {
                    symbol: parsed.tvSymbol,
                    range,
                    source: 'db',
                    candles: bars.map((b) => ({
                        time: b.date,
                        open: b.open,
                        high: b.high,
                        low: b.low,
                        close: b.close,
                        volume: b.volume,
                    })),
                },
                { headers: { 'Cache-Control': 'private, max-age=300' } }
            );
        }
    } catch (e) {
        console.error('candles db lookup failed, falling back to live', symbol, e);
    }

    try {
        const candles =
            parsed.market === 'tse'
                ? await twseCandles(parsed.code, start, end)
                : await tpexCandles(parsed.code, tradingDays);
        if (!candles.length) return NextResponse.json({ error: 'No candle data' }, { status: 502 });
        return NextResponse.json(
            { symbol: parsed.tvSymbol, range, source: 'live', candles },
            { headers: { 'Cache-Control': 'private, max-age=300' } }
        );
    } catch (e) {
        console.error('candles failed', symbol, e);
        return NextResponse.json({ error: 'Candle data unavailable' }, { status: 502 });
    }
}
