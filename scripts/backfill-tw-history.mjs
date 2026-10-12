// Backfill TW daily OHLCV bars into MongoDB (collection: dailybars).
// Strategy: per TRADING DAY (not per ticker) — one TWSE + one TPEx request covers
// the whole market for that day.
//
// Usage:
//   node scripts/backfill-tw-history.mjs --years=2        # last ~2 years (default)
//   node scripts/backfill-tw-history.mjs --days=5         # last 5 calendar days (test)
//   node scripts/backfill-tw-history.mjs --years=2 --mongo="mongodb://..."
//
// Idempotent: skips days already backfilled (per-source doc counts), safe to
// re-run / resume. Polite pacing: ~2.5s between requests, 3 retries per day.
//
// Sources (free, no key):
//   TWSE: https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=YYYYMMDD&type=ALL
//   TPEx: https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&d=YYY/MM/DD&s=0,asc,0
import 'dotenv/config';
import mongoose from 'mongoose';
import dns from 'dns';

try { dns.setServers(['8.8.8.8']); } catch { /* localhost needs no DNS */ }

const UA = { 'User-Agent': 'openstock-tw/0.1 (history backfill; polite pacing)' };
const REQ_TIMEOUT = 30000;
const PACING_MS = 2500;
const MAX_RETRIES = 3;
const BATCH = 1000;
// Coverage thresholds: below these doc counts a day is (re)fetched.
const COVERAGE = { twse: 800, tpex: 600 };
const CODE_RE = /^\d{4}[A-Z]?$/;

const argv = process.argv.slice(2);
const arg = (name, def) => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return def;
    const eq = hit.indexOf('=');
    return eq === -1 ? true : hit.slice(eq + 1);
};

const MONGO_URI = arg('mongo', process.env.MONGODB_URI);
if (!MONGO_URI) {
    console.error('ERROR: set MONGODB_URI in .env or pass --mongo="mongodb://..."');
    process.exit(1);
}

const daysOpt = arg('days', null);
const yearsOpt = parseFloat(arg('years', '2'));
const SKIP_TPEX = arg('skip-tpex', false); // TPEx history comes from Yahoo now; skip the broken per-day endpoint
const today = new Date();
const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
let startDate;
if (daysOpt) {
    startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - (parseInt(daysOpt, 10) - 1));
} else {
    startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - Math.round(yearsOpt * 365));
}

const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const twseParam = (d) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const tpexParam = (d) =>
    `${d.getFullYear() - 1911}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const num = (v) => {
    if (v === null || v === undefined) return undefined;
    const s = String(v).replace(/,/g, '').trim();
    if (!s || ['-', '--', '---', 'X', 'null', ''].includes(s)) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
};

async function getJSON(url) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(REQ_TIMEOUT) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            lastErr = e;
            if (attempt < MAX_RETRIES) await sleep(2000 * attempt);
        }
    }
    throw lastErr;
}

/** Parse one TWSE MI_INDEX day -> docs. Returns null when not a trading day. */
function parseTwse(payload, dateIso, expectYmd) {
    if (!payload || payload.stat !== 'OK' || !Array.isArray(payload.tables)) return null;
    if (String(payload.date || '') !== expectYmd) return null; // holiday: TWSE answers with an error stat, but double-check
    const table = payload.tables.find((t) => (t.title || '').includes('每日收盤行情'));
    if (!table || !Array.isArray(table.data) || table.data.length === 0) return null;
    const docs = [];
    for (const r of table.data) {
        const code = String(r[0] ?? '').trim();
        if (!CODE_RE.test(code)) continue;
        const open = num(r[5]), high = num(r[6]), low = num(r[7]), close = num(r[8]);
        if (open === undefined || high === undefined || low === undefined || close === undefined) continue;
        docs.push({
            symbol: `TWSE:${code}`, date: dateIso,
            open, high, low, close,
            volume: num(r[2]) ?? 0, source: 'twse',
        });
    }
    return docs;
}

/** Parse one TPEx daily_close_quotes day -> docs. Returns null when not a trading day.
 *  NOTE: on holidays TPEx returns the PREVIOUS trading day's table with stat 'ok',
 *  so the response date must match the requested date. */
function parseTpex(payload, dateIso, expectYmd) {
    if (!payload || String(payload.stat || '').toLowerCase() !== 'ok' || !Array.isArray(payload.tables)) return null;
    if (String(payload.date || '') !== expectYmd) return null;
    const table = payload.tables.find((t) => (t.title || '').includes('上櫃股票行情')) ?? payload.tables[0];
    if (!table || !Array.isArray(table.data) || table.data.length === 0) return null;
    const docs = [];
    for (const r of table.data) {
        const code = String(r[0] ?? '').trim();
        if (!CODE_RE.test(code)) continue;
        const close = num(r[2]), open = num(r[4]), high = num(r[5]), low = num(r[6]);
        if (open === undefined || high === undefined || low === undefined || close === undefined) continue;
        docs.push({
            symbol: `TPEX:${code}`, date: dateIso,
            open, high, low, close,
            volume: num(r[8]) ?? 0, source: 'tpex',
        });
    }
    return docs;
}

// Inline schema mirroring database/models/daily-bar.model.ts (plain node can't import TS).
const DailyBarSchema = new mongoose.Schema(
    {
        symbol: { type: String, required: true, uppercase: true, trim: true },
        date: { type: String, required: true },
        open: { type: Number, required: true },
        high: { type: Number, required: true },
        low: { type: Number, required: true },
        close: { type: Number, required: true },
        volume: { type: Number, required: true, default: 0 },
        source: { type: String, enum: ['twse', 'tpex'], required: true },
    },
    { timestamps: true, collection: 'dailybars' }
);
DailyBarSchema.index({ symbol: 1, date: 1 }, { unique: true });
DailyBarSchema.index({ date: 1, source: 1 });

async function main() {
    console.log(`Backfill ${iso(startDate)} .. ${iso(endDate)} -> ${MONGO_URI.replace(/\/\/.*@/, '//***@')}`);
    await mongoose.connect(MONGO_URI, { family: 4 });
    const DailyBar = mongoose.models.DailyBar || mongoose.model('DailyBar', DailyBarSchema);
    await DailyBar.syncIndexes().catch(() => {});

    const stats = { daysOk: 0, daysSkipped: 0, daysNoData: 0, daysFailed: 0, docs: 0, failedDays: [] };
    const dates = [];
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const day = d.getDay();
        if (day === 0 || day === 6) continue; // weekends: no TW trading
        dates.push(new Date(d));
    }
    console.log(`${dates.length} weekdays to process`);

    let n = 0;
    for (const d of dates) {
        n++;
        const dateIso = iso(d);
        try {
            let fetched = 0, noData = 0;
            for (const src of (SKIP_TPEX ? ['twse'] : ['twse', 'tpex'])) {
                const have = await DailyBar.countDocuments({ date: dateIso, source: src });
                if (have >= COVERAGE[src]) continue; // already backfilled
                const url =
                    src === 'twse'
                        ? `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${twseParam(d)}&type=ALL`
                        : `https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&d=${tpexParam(d)}&s=0,asc,0`;
                const payload = await getJSON(url);
                await sleep(PACING_MS);
                const docs = src === 'twse'
                    ? parseTwse(payload, dateIso, twseParam(d))
                    : parseTpex(payload, dateIso, twseParam(d));
                if (!docs || docs.length === 0) { noData++; continue; } // holiday / no data
                const ops = docs.map((doc) => ({
                    updateOne: {
                        filter: { symbol: doc.symbol, date: doc.date },
                        update: { $set: doc },
                        upsert: true,
                    },
                }));
                for (let i = 0; i < ops.length; i += BATCH) {
                    await DailyBar.bulkWrite(ops.slice(i, i + BATCH), { ordered: false });
                }
                stats.docs += docs.length;
                fetched++;
            }
            if (fetched > 0) stats.daysOk++;
            else if (noData > 0) stats.daysNoData++;
            else stats.daysSkipped++;
        } catch (e) {
            stats.daysFailed++;
            stats.failedDays.push(`${dateIso}: ${e.message}`);
            console.error(`[FAIL] ${dateIso}: ${e.message}`);
        }
        if (n % 20 === 0) {
            console.log(`progress ${n}/${dates.length} ok=${stats.daysOk} skip=${stats.daysSkipped} nodata~ fail=${stats.daysFailed} docs=${stats.docs}`);
        }
    }

    console.log('--- done ---');
    console.log(`days ok=${stats.daysOk} skipped=${stats.daysSkipped} nodata(holiday)=${stats.daysNoData} failed=${stats.daysFailed} docs_upserted=${stats.docs}`);
    if (stats.failedDays.length) {
        console.log('failed days:');
        for (const f of stats.failedDays.slice(0, 50)) console.log('  ' + f);
    }
    await mongoose.disconnect();
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
