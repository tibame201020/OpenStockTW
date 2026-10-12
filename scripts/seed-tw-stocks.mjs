// Seed script: builds lib/tw/tw-stocks-{1,2,3}.json from TWSE/TPEx public JSON endpoints.
// (Split into three files so each stays small for git hosting limits.)
// Sources (free, no key, verified working):
//   TWSE listed : https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL  (Code, Name)
//   TPEx OTC    : https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes   (SecuritiesCompanyCode, CompanyName)
// Run: node scripts/seed-tw-stocks.mjs
// Re-run occasionally to pick up new listings.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const OUT = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : 'lib/tw/tw-stocks.json';

const UA = { 'User-Agent': 'openstock-tw/0.1 (stock list seed; polite)' };

async function getJSON(url) {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
}

function classify(code, name) {
    if (/^0\d{3}$/.test(code) || /ETF|ETN/i.test(name)) return 'ETF';
    return 'Common Stock';
}

const out = [];

// TWSE listed
{
    const rows = await getJSON('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
    console.log(`TWSE: ${rows.length} rows`);
    for (const r of rows) {
        const code = String(r.Code || '').trim();
        const name = String(r.Name || '').trim();
        if (!/^\d{4}[A-Z]?$/.test(code) || !name) continue;
        out.push({ code, name, exchange: 'TWSE', symbol: `TWSE:${code}`, type: classify(code, name) });
    }
}

// TPEx OTC
{
    const rows = await getJSON('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes');
    console.log(`TPEX: ${rows.length} rows`);
    for (const r of rows) {
        const code = String(r.SecuritiesCompanyCode || '').trim();
        const name = String(r.CompanyName || '').trim();
        if (!/^\d{4}[A-Z]?$/.test(code) || !name) continue;
        out.push({ code, name, exchange: 'TPEX', symbol: `TPEX:${code}`, type: classify(code, name) });
    }
}

// De-dupe by symbol (keep TWSE first on the rare overlap)
const seen = new Set();
const deduped = out.filter((s) => (seen.has(s.symbol) ? false : (seen.add(s.symbol), true)));
deduped.sort((a, b) => (a.exchange === b.exchange ? a.code.localeCompare(b.code) : a.exchange === 'TWSE' ? -1 : 1));

const baseDir = dirname(resolve(process.cwd(), OUT));
mkdirSync(baseDir, { recursive: true });
// Split into three parts so each file stays small for git hosting limits.
const THIRD = Math.ceil(deduped.length / 3);
[deduped.slice(0, THIRD), deduped.slice(THIRD, THIRD * 2), deduped.slice(THIRD * 2)].forEach((stocks, i) => {
    const p = resolve(baseDir, `tw-stocks-${i + 1}.json`);
    writeFileSync(p, JSON.stringify({ updatedAt: new Date().toISOString(), count: deduped.length, stocks }));
    console.log(`Wrote ${stocks.length} stocks -> ${p}`);
});
