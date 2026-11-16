// Bybit v5 public market data (USDT linear perpetuals). No API key needed.
const BASE = process.env.BYBIT_BASE || 'https://api.bybit.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const INTERVAL_MS = { 1: 6e4, 3: 18e4, 5: 3e5, 15: 9e5, 30: 18e5, 60: 36e5, 120: 72e5, 240: 144e5, D: 864e5 };

async function get(path, params, tries = 4) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  let lastErr;
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      const j = await res.json();
      if (j.retCode === 10006) throw new Error('rate limited');
      if (j.retCode !== 0) throw Object.assign(new Error(j.retMsg || `retCode ${j.retCode}`), { fatal: true });
      return j.result;
    } catch (e) {
      lastErr = e;
      if (e.fatal) break;
      await sleep(600 * (a + 1));
    }
  }
  throw lastErr;
}

export async function getSymbols() {
  const out = [];
  let cursor = '';
  do {
    const r = await get('/v5/market/instruments-info', { category: 'linear', limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const s of r.list) {
      // crypto only: Bybit also lists tokenized stocks / ETFs / forex / commodities as USDT perps
      const crypto = !s.symbolType || s.symbolType === 'innovation';
      if (crypto && !s.isPreListing && s.quoteCoin === 'USDT' && s.status === 'Trading' && s.contractType === 'LinearPerpetual') out.push(s.symbol);
    }
    cursor = r.nextPageCursor || '';
  } while (cursor);
  return out;
}

export async function getKlines(symbol, interval, limit = 1000, end) {
  const r = await get('/v5/market/kline', { category: 'linear', symbol, interval, limit, ...(end ? { end } : {}) });
  return r.list.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
}

export async function getTickers() {
  const r = await get('/v5/market/tickers', { category: 'linear' });
  const m = new Map();
  for (const t of r.list) m.set(t.symbol, { price: +t.lastPrice, chg: +t.price24hPcnt * 100, turnover: +t.turnover24h });
  return m;
}

// Run async fn over items with limited concurrency.
export async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}
