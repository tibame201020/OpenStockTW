// Backfill TPEx historical daily bars via Yahoo Finance (.TWO tickers).
// DRAFT (2026-10-11 research): the TPEx stk_quote_result.php endpoint silently
// returns the LATEST day for out-of-range dates, so per-day backfill cannot get
// TPEx history older than the endpoint's retention window. Yahoo's chart API
// serves ~2y of daily bars per ticker for free (verified 2026-10-11: 6488.TWO
// -> 487 bars, 2024-10-08..2026-10-08).
//
// Usage:
//   node scripts/backfill-tpex-yahoo.mjs --symbols=6488,3105 --years=2   # test a few
//   node scripts/backfill-tpex-yahoo.mjs --years=2 --all                  # all OTC codes from TPEx openapi
//   node scripts/backfill-tpex-yahoo.mjs --years=2                        # all TPEX: symbols in DB
//   node scripts/backfill-tpex-yahoo.mjs --years=2 --mongo="mongodb://..."
//
// Idempotent: upserts on (symbol, date) unique index; skips tickers whose
// earliest bar is already <= start date. Polite pacing: 2s between tickers.
//
// Data notes: Yahoo `quote` OHLC is UNADJUSTED (matches exchange published
// prices); volume is in shares. `adjclose` is ignored. Timestamps are mapped
// to Asia/Taipei calendar dates.
import 'dotenv/config';
import mongoose from 'mongoose';

const UA = { 'User-Agent': 'Mozilla/5.0 (openstock-tw/0.1; tpex history backfill)' };
const PACING_MS = 2000;
const CODE_RE = /^\d{4}$/; // Yahoo .TWO mapping only verified for plain 4-digit codes

const argv = process.argv.slice(2);
const arg = (name, def) => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return def;
    const eq = hit.indexOf('=');
    return eq === -1 ? true : hit.slice(eq + 1);
};

const MONGO_URI = arg('mongo', process.env.MONGODB_URI);
if (!MONGO_URI) { console.error('ERROR: set MONGODB_URI'); process.exit(1); }
const yearsOpt = parseFloat(arg('years', '2'));
const symbolsOpt = arg('symbols', null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const endDate = new Date();
const startDate = new Date(endDate);
startDate.setDate(startDate.getDate() - Math.round(yearsOpt * 365));
const period1 = Math.floor(startDate.getTime() / 1000);
const period2 = Math.floor(endDate.getTime() / 1000);
const isoInTz = (ts) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(ts * 1000));

const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
};

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

async function fetchTicker(code) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.TWO?interval=1d&period1=${period1}&period2=${period2}`;
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${code}.TWO`);
    const j = await res.json();
    const result = j?.chart?.result?.[0];
    if (!result) throw new Error(`no result for ${code}.TWO (maybe delisted/renamed)`);
    const ts = result.timestamp ?? [];
    const q = result.indicators?.quote?.[0] ?? {};
    const docs = [];
    for (let i = 0; i < ts.length; i++) {
        const open = num(q.open?.[i]), high = num(q.high?.[i]), low = num(q.low?.[i]), close = num(q.close?.[i]);
        if (open === undefined || high === undefined || low === undefined || close === undefined) continue;
        docs.push({
            symbol: `TPEX:${code}`, date: isoInTz(ts[i]),
            open, high, low, close,
            volume: num(q.volume?.[i]) ?? 0, source: 'tpex',
        });
    }
    return docs;
}

async function main() {
    await mongoose.connect(MONGO_URI, { family: 4 });
    const DailyBar = mongoose.models.DailyBar || mongoose.model('DailyBar', DailyBarSchema);
    let codes;
    if (symbolsOpt) {
        codes = String(symbolsOpt).split(',').map((s) => s.trim());
    } else if (arg('all', false)) {
        // Full OTC list from TPEx openapi (latest-day quotes, all securities).
        const r = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
            { headers: UA, signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(`TPEx openapi HTTP ${r.status}`);
        const rows = await r.json();
        codes = [...new Set(rows.map((x) => String(x.SecuritiesCompanyCode || '').trim()).filter((c) => CODE_RE.test(c)))].sort();
        console.log(`--all: ${codes.length} 4-digit codes from TPEx openapi`);
    } else {
        const syms = await DailyBar.distinct('symbol', { symbol: /^TPEX:/ });
        codes = syms.map((s) => s.replace(/^TPEX:/, '')).filter((c) => CODE_RE.test(c)).sort();
    }
    console.log(`TPEx-Yahoo backfill: ${codes.length} tickers, period1=${isoInTz(period1)}`);
    let done = 0, skipped = 0, failed = [];
    for (const code of codes) {
        const symbol = `TPEX:${code}`;
        const earliest = await DailyBar.findOne({ symbol }).sort({ date: 1 }).select('date').lean();
        if (earliest && earliest.date <= isoInTz(period1)) { skipped++; continue; } // already covered
        try {
            const docs = await fetchTicker(code);
            if (docs.length) {
                const ops = docs.map((doc) => ({
                    updateOne: { filter: { symbol: doc.symbol, date: doc.date }, update: { $set: doc }, upsert: true },
                }));
                await DailyBar.bulkWrite(ops, { ordered: false });
            }
            done++;
            if (done % 50 === 0) console.log(`progress ${done + skipped}/${codes.length} tickers`);
        } catch (e) {
            failed.push(`${code}: ${e.message}`);
        }
        await sleep(PACING_MS);
    }
    console.log(`--- done --- tickers ok=${done} skipped=${skipped} failed=${failed.length}`);
    failed.slice(0, 20).forEach((f) => console.log('  ' + f));
    await mongoose.disconnect();
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
