// The engine: pulls candles for every Bybit USDT perpetual, teaches the brain from every
// finished bar, and turns fresh indicator triggers + model confidence into enter/exit alerts.
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { computeIndicators, features, btcContext, label, outcome, crossKinds, evR, FEATURE_NAMES, NF, HORIZON, WARMUP, SL_ATR, TP_ATR, FEE_ROUNDTRIP } from './indicators.js';
import { Brain } from './model.js';
import { getSymbols, getKlines, getTickers, pool, INTERVAL_MS } from './bybit.js';

const MAXC = 1500;
const CROSS_HE = {
  ut: ['UT Bot התהפך לקנייה', 'UT Bot התהפך למכירה'],
  vwap: ['חצה את ה-VWAP למעלה', 'חצה את ה-VWAP למטה'],
  ssl: ['SSL התהפך לירוק', 'SSL התהפך לאדום'],
  bs: ['Buy Sell Signal נתן קנייה', 'Buy Sell Signal נתן מכירה'],
  bv: ['Buy Sell Volume: הקונים עקפו את המוכרים', 'Buy Sell Volume: המוכרים עקפו את הקונים'],
};
const SHRINK = 30; // a coin's own record counts fully only after ~30 crossovers; before that it leans on the market-wide rate
const tick = () => new Promise((r) => setImmediate(r));

function lowerBound(c, t) {
  let lo = 0, hi = c.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (c[m].t < t) lo = m + 1; else hi = m; }
  return lo;
}

export class Engine extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.cfg = {
      tf: String(cfg.tf || '60'),
      minProb: +cfg.minProb || 0.5,
      minEv: cfg.minEv != null ? +cfg.minEv : 0.03,   // required proven net edge (in R) for that confidence level
      minTrack: 5000,
      minStatR: 0.05,                                  // crossover type must have averaged at least this net R historically                                  // graded predictions needed before trusting a level
      minTurnover: cfg.minTurnover != null ? +cfg.minTurnover : 2e6,
      maxOpen: +cfg.maxOpen || 8,
      maxCoins: +cfg.maxCoins || 0,
      stateFile: cfg.stateFile || path.resolve('data/state.json'),
    };
    this.tfMs = INTERVAL_MS[this.cfg.tf];
    if (!this.tfMs) throw new Error(`Unsupported timeframe ${this.cfg.tf}`);
    this.coins = new Map();
    this.btcCtx = new Map();
    this.btcLast = null;
    this.brain = new Brain(NF);
    this.open = [];
    this.history = [];
    this.trig = {};       // market-wide record per crossover type: what happened after it
    this.trigReady = false;
    this.feed = [];       // crossovers on the last closed bar, with odds and a verdict
    this.liveFeed = [];   // the same, for the bar that is still forming (preview only, never opens a signal)
    this.liveT = null;
    this.status = { phase: 'starting', done: 0, total: 0, lastScan: null, nextScan: null, error: null };
    this.scanning = false;
  }

  // ---------- persistence ----------
  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.cfg.stateFile, 'utf8'));
      if (j.tf !== this.cfg.tf) return;
      this.brain = Brain.fromJSON(j.brain, NF);
      // a brain with a different feature set is discarded, so every coin must be relearned from the start of history
      this.saved = j.brain?.nf === NF ? j.coins || {} : {};
      this.open = j.open || [];
      this.history = j.history || [];
    } catch { /* first run */ }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.cfg.stateFile), { recursive: true });
      const coins = {};
      for (const c of this.coins.values()) coins[c.sym] = c.nextTrainT;
      const tmp = this.cfg.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ tf: this.cfg.tf, brain: this.brain, coins, open: this.open, history: this.history }));
      fs.renameSync(tmp, this.cfg.stateFile);
    } catch (e) { console.error('save failed:', e.message); }
  }

  // ---------- startup ----------
  async start() {
    try {
      this.load();
      let syms = await getSymbols();
      const tickers = await getTickers();
      syms.sort((a, b) => (tickers.get(b)?.turnover || 0) - (tickers.get(a)?.turnover || 0));
      if (this.cfg.maxCoins) syms = syms.slice(0, this.cfg.maxCoins);
      if (!syms.includes('BTCUSDT')) syms.unshift('BTCUSDT');
      for (const sym of syms) {
        const t = tickers.get(sym) || {};
        this.coins.set(sym, { sym, candles: [], nextTrainT: this.saved?.[sym] || 0, predT: this.saved?.[sym] ? Date.now() : -1, sum: null, price: t.price, chg: t.chg, turnover: t.turnover || 0 });
      }

      // the scoreboard remembers roughly the last 30 days of graded predictions
      this.brain.decay = 1 - 1 / (syms.length * 2 * Math.max(200, (30 * 864e5) / this.tfMs));

      // 1) history
      this.status = { ...this.status, phase: 'history', done: 0, total: syms.length };
      const now = Date.now();
      await pool(syms, 6, async (sym) => {
        const coin = this.coins.get(sym);
        try {
          let c = await getKlines(sym, this.cfg.tf, 1000);
          if (c.length === 1000) c = (await getKlines(sym, this.cfg.tf, MAXC - 1000, c[0].t - 1)).concat(c);
          coin.candles = c.filter((k) => k.t + this.tfMs <= now);
        } catch (e) { console.error(`history ${sym}: ${e.message}`); }
        this.status.done++;
        if (this.status.done % 20 === 0) this.emit('status');
      });

      // 2) learn from history, in true time order across all coins
      this.status = { ...this.status, phase: 'learning', done: 0, total: 1 };
      this.emit('status');
      const btc = this.coins.get('BTCUSDT');
      this.buildBtcCtx(btc);
      const inds = new Map();
      for (const coin of this.coins.values()) { inds.set(coin.sym, computeIndicators(coin.candles)); }
      const times = btc.candles.map((k) => k.t);
      this.status.total = times.length;
      for (let ti = 0; ti < times.length; ti++) {
        for (const coin of this.coins.values()) this.trainCoin(coin, inds.get(coin.sym), times[ti]);
        this.status.done = ti + 1;
        if (ti % 25 === 0) { await tick(); if (ti % 200 === 0) this.emit('status'); }
      }
      // 3) record what happened after every past crossover (TP / SL / neither), per coin and market-wide
      this.trig = {};
      for (const coin of this.coins.values()) {
        coin.trig = {};
        const ind = inds.get(coin.sym);
        for (let i = WARMUP; i + HORIZON <= coin.candles.length - 1; i++) this.recordCross(coin, ind, i);
      }
      this.trigReady = true;
      for (const coin of this.coins.values()) this.summarize(coin, inds.get(coin.sym));
      inds.clear();
      this.feed = this.buildFeed();
      this.save();

      this.status = { ...this.status, phase: 'live', error: null };
      this.emit('status');
      console.log(`live: ${this.coins.size} coins, ${this.brain.n} samples learned`);
      this.schedule();
      this.tickerLoop();
      this.liveLoop();
    } catch (e) {
      console.error('start failed:', e);
      this.status = { ...this.status, phase: 'error', error: e.message };
      this.emit('status');
      setTimeout(() => this.start(), 30000);
    }
  }

  buildBtcCtx(btc) {
    const ind = computeIndicators(btc.candles);
    this.btcCtx.clear();
    for (let i = 0; i < btc.candles.length; i++) this.btcCtx.set(btc.candles[i].t, btcContext(ind, btc.candles, i));
    if (btc.candles.length) this.btcLast = this.btcCtx.get(btc.candles.at(-1).t);
  }

  // ---------- learning ----------
  // Feed every bar whose full outcome window is now known (up to tMax) into the brain.
  trainCoin(coin, ind, tMax = Infinity) {
    const c = coin.candles, n = c.length;
    if (!n) return;
    const e = tMax === Infinity ? n - 1 : lowerBound(c, tMax + 1) - 1; // last bar that exists at tMax
    if (e < 0) return;
    // 1) Predict every new bar NOW, before any of its future is known. These stored predictions
    //    are what the scoreboard grades later - so the scoreboard cannot peek at the future.
    const pend = (coin.pend ||= new Map());
    for (let j = lowerBound(c, (coin.predT ?? -1) + 1); j <= e; j++) {
      if (j < WARMUP) continue;
      const btc = this.btcCtx.get(c[j].t);
      pend.set(c[j].t, [this.brain.predict(coin.sym, features(ind, c, j, 1, btc)), this.brain.predict(coin.sym, features(ind, c, j, -1, btc))]);
    }
    coin.predT = Math.max(coin.predT ?? -1, c[e].t);
    // 2) Learn from bars whose full outcome window has now played out.
    let i = lowerBound(c, coin.nextTrainT);
    for (; i + HORIZON <= e; i++) {
      if (i < WARMUP) continue;
      const btc = this.btcCtx.get(c[i].t), pr = pend.get(c[i].t);
      pend.delete(c[i].t);
      if (this.trigReady) this.recordCross(coin, ind, i);
      for (const side of [1, -1]) {
        const y = label(c, i, side, ind.atr[i]);
        if (y != null) this.brain.learn(coin.sym, features(ind, c, i, side, btc), y, pr ? pr[side > 0 ? 0 : 1] : null);
      }
    }
    coin.nextTrainT = c[i].t;
  }

  // ---------- crossover track record ----------
  recordCross(coin, ind, i) {
    for (const side of [1, -1]) {
      const kinds = crossKinds(ind, i, side);
      if (!kinds.length) continue;
      const o = outcome(coin.candles, i, side, ind.atr[i]);
      if (!o) continue;
      const keys = kinds.map((k) => `${k}:${side}`);
      if (kinds.length > 1) keys.push(`multi:${side}`);
      for (const key of keys) for (const store of [this.trig, (coin.trig ||= {})]) {
        const s = (store[key] ||= { n: 0, tp: 0, sl: 0, r: 0 });
        s.n++; s.r += o.r;
        if (o.res === 'tp') s.tp++; else if (o.res === 'sl') s.sl++;
      }
    }
  }

  // Odds for this crossover type on this coin: its own history, pulled toward the market-wide rate when it is thin.
  odds(coin, key) {
    const g = this.trig[key], s = coin.trig?.[key];
    const gTp = g?.n ? g.tp / g.n : 0.38, gR = g?.n ? g.r / g.n : -0.05, n = s?.n || 0;
    return {
      n, coinTp: n ? s.tp / n : null, mktTp: gTp, mktN: g?.n || 0,
      tp: ((s?.tp || 0) + SHRINK * gTp) / (n + SHRINK),
      r: ((s?.r || 0) + SHRINK * gR) / (n + SHRINK),
    };
  }

  // Every crossover on the last closed bar, with its odds and a verdict: 2 = enter, 1 = borderline, 0 = skip.
  buildFeed(src = 'sum') {
    const feed = [], now = Date.now();
    for (const coin of this.coins.values()) {
      const s = coin[src];
      if (!s || s.t + 2 * this.tfMs < now || coin.turnover < this.cfg.minTurnover) continue;
      for (const [side, p, kinds] of [[1, s.pL, s.kL], [-1, s.pS, s.kS]]) {
        if (!kinds.length) continue;
        const o = this.odds(coin, `${kinds.length > 1 ? 'multi' : kinds[0]}:${side}`);
        const tr = this.brain.track(p);
        const modelOk = p >= this.cfg.minProb && tr.n >= this.cfg.minTrack && evR(tr.avg) >= this.cfg.minEv;
        // history must show both a positive average result and a TP hit rate above break-even (~44%)
        const statOk = o.r >= this.cfg.minStatR && o.tp >= 1.1 / (1 + TP_ATR / SL_ATR);
        feed.push({
          sym: coin.sym, side, kinds, reasons: kinds.map((k) => CROSS_HE[k][side > 0 ? 0 : 1]),
          entry: s.close, sl: s.close - side * SL_ATR * s.atr, tp: s.close + side * TP_ATR * s.atr, barT: s.t,
          tpProb: o.tp, expR: o.r, n: o.n, coinTp: o.coinTp, mktTp: o.mktTp, p, modelOk, statOk,
          verdict: modelOk && statOk ? 2 : modelOk || statOk ? 1 : 0,
        });
      }
    }
    return feed.sort((a, b) => b.verdict - a.verdict || b.tpProb - a.tpProb);
  }

  summarize(coin, ind) {
    const c = coin.candles, i = c.length - 1;
    coin.sum = i < WARMUP ? null : this.snapshot(coin, ind, c, i, this.btcCtx.get(c[i].t) || this.btcLast);
  }

  // Indicator states, model confidence and fresh crossovers for bar i of candle list c.
  snapshot(coin, ind, c, i, btc) {
    const kL = crossKinds(ind, i, 1), kS = crossKinds(ind, i, -1);
    return {
      t: c[i].t, close: c[i].c, atr: ind.atr[i],
      pL: this.brain.predict(coin.sym, features(ind, c, i, 1, btc)),
      pS: this.brain.predict(coin.sym, features(ind, c, i, -1, btc)),
      ut: ind.utDir[i], utAge: ind.utAge[i], vw: ind.vwapSide[i], ssl: ind.sslDir[i], bs: ind.bsDir[i], bv: ind.bvDir[i], rsi: ind.rsi[i],
      kL, kS, trigL: kL.map((k) => CROSS_HE[k][0]), trigS: kS.map((k) => CROSS_HE[k][1]), hi: c[i].h, lo: c[i].l,
    };
  }

  // ---------- live preview ----------
  // Between the scheduled scans, keep re-reading the bar that is still forming for every coin that can
  // alert, so the dashboard shows crossovers as they take shape. This is a preview only: a forming bar
  // can still change, so nothing is learned from it and no signal is opened before the bar closes.
  async liveLoop() {
    try { if (this.status.phase === 'live' && !this.scanning) await this.liveScan(); } catch (e) { console.error('live scan:', e.message); }
    setTimeout(() => this.liveLoop(), 15000);
  }

  async liveCalc(coin) {
    const last = coin.candles.at(-1);
    if (!last || coin.candles.length <= WARMUP) return null;
    const k = (await getKlines(coin.sym, this.cfg.tf, 2)).at(-1);
    if (!k || k.t !== last.t + this.tfMs) return null;   // not the bar right after our last closed one: leave it to the scan
    const c = coin.candles.concat(k);
    return { c, ind: computeIndicators(c), i: c.length - 1 };
  }

  async liveScan() {
    const btc = this.coins.get('BTCUSDT');
    const b = await this.liveCalc(btc);
    const btcNow = b ? btcContext(b.ind, b.c, b.i) : this.btcLast;
    const list = [...this.coins.values()].filter((c) => c === btc || c.turnover >= this.cfg.minTurnover || this.open.some((o) => o.sym === c.sym));
    await pool(list, 6, async (coin) => {
      if (this.scanning) return;
      try {
        const r = coin === btc ? b : await this.liveCalc(coin);
        if (!this.scanning) coin.live = r ? this.snapshot(coin, r.ind, r.c, r.i, btcNow) : null;
      } catch { /* transient: keep the previous preview */ }
    });
    if (this.scanning) return;
    this.liveFeed = this.buildFeed('live').map((f) => ({ ...f, live: true }));
    this.liveT = Date.now();
    this.emit('live');
  }

  // ---------- live loop ----------
  schedule() {
    const next = Math.ceil((Date.now() + 1000) / this.tfMs) * this.tfMs + 4000;
    this.status.nextScan = next;
    setTimeout(() => this.scan().finally(() => this.schedule()), next - Date.now());
  }

  async refresh(coin) {
    const now = Date.now(), c = coin.candles;
    const last = c.length ? c.at(-1).t : 0;
    const limit = Math.min(1000, Math.max(3, Math.ceil((now - last) / this.tfMs) + 2));
    const fresh = await getKlines(coin.sym, this.cfg.tf, limit);
    for (const k of fresh) {
      if (k.t + this.tfMs > now) continue;
      if (k.t > last) c.push(k);
      else if (k.t === last) c[c.length - 1] = k;
    }
    if (c.length > MAXC) c.splice(0, c.length - MAXC);
  }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const btc = this.coins.get('BTCUSDT');
      await this.refresh(btc);
      this.buildBtcCtx(btc);
      await pool([...this.coins.values()], 6, async (coin) => {
        try {
          if (coin !== btc) await this.refresh(coin);
          const ind = computeIndicators(coin.candles);
          this.trainCoin(coin, ind);
          this.summarize(coin, ind);
          this.checkExitOnClose(coin);
        } catch (e) { console.error(`scan ${coin.sym}: ${e.message}`); }
      });
      this.feed = this.buildFeed();
      for (const coin of this.coins.values()) coin.live = null;   // the bar they described has just closed
      this.liveFeed = [];
      for (const f of this.feed) {
        if (f.verdict < 2 || this.open.length >= this.cfg.maxOpen) break;
        if (!this.open.some((o) => o.sym === f.sym)) this.openSignal(f);
      }
      this.status.lastScan = Date.now();
      this.save();
      this.emit('scan');
    } finally { this.scanning = false; }
  }

  openSignal(f) {
    const { sym, side, p } = f;
    const sig = { id: `${sym}-${f.barT}`, sym, side, entry: f.entry, sl: f.sl, tp: f.tp, p, tpProb: f.tpProb, expR: f.expR, n: f.n, reasons: f.reasons, t: Date.now(), barT: f.barT };
    this.open.push(sig);
    this.emit('signal', sig);
    console.log(`ENTER ${side > 0 ? 'LONG' : 'SHORT'} ${sig.sym} @${sig.entry} p=${p.toFixed(3)}`);
  }

  closeSignal(sig, price, reason) {
    const i = this.open.indexOf(sig);
    if (i < 0) return;
    this.open.splice(i, 1);
    const risk = Math.abs(sig.entry - sig.sl);
    const done = { ...sig, exit: price, exitT: Date.now(), reason, r: (sig.side * (price - sig.entry)) / risk - (FEE_ROUNDTRIP * sig.entry) / risk };
    this.history.unshift(done);
    if (this.history.length > 300) this.history.length = 300;
    this.emit('exit', done);
    console.log(`EXIT ${sig.sym} @${price} ${reason} r=${done.r.toFixed(2)}`);
  }

  checkExitOnClose(coin) {
    const sig = this.open.find((o) => o.sym === coin.sym), s = coin.sum;
    if (!sig || !s || s.t <= sig.barT) return;
    const p = sig.side > 0 ? s.pL : s.pS;
    if (sig.side > 0 ? s.lo <= sig.sl : s.hi >= sig.sl) return this.closeSignal(sig, sig.sl, 'נגע בסטופ');
    if (sig.side > 0 ? s.hi >= sig.tp : s.lo <= sig.tp) return this.closeSignal(sig, sig.tp, 'הגיע ליעד');
    if (s.ut === -sig.side && s.utAge === 0) return this.closeSignal(sig, s.close, 'UT Bot התהפך נגד העסקה');
    if (p < 0.3) return this.closeSignal(sig, s.close, 'המודל איבד ביטחון בעסקה');
    if ((s.t - sig.barT) / this.tfMs >= HORIZON) return this.closeSignal(sig, s.close, 'עבר הזמן המוקצב לעסקה');
  }

  async tickerLoop() {
    try {
      const tickers = await getTickers();
      for (const coin of this.coins.values()) {
        const t = tickers.get(coin.sym);
        if (t) { coin.price = t.price; coin.chg = t.chg; coin.turnover = t.turnover; }
      }
      for (const sig of [...this.open]) {
        const price = this.coins.get(sig.sym)?.price;
        if (!price) continue;
        if (sig.side > 0 ? price <= sig.sl : price >= sig.sl) this.closeSignal(sig, sig.sl, 'נגע בסטופ');
        else if (sig.side > 0 ? price >= sig.tp : price <= sig.tp) this.closeSignal(sig, sig.tp, 'הגיע ליעד');
      }
    } catch (e) { /* transient */ }
    setTimeout(() => this.tickerLoop(), 10000);
  }

  // ---------- API ----------
  getState() {
    const coins = [];
    for (const c of this.coins.values()) {
      const s = c.live || c.sum;   // indicator states follow the forming bar when a live preview exists
      coins.push({
        s: c.sym, price: c.price, chg: c.chg, to: c.turnover,
        ...(s ? { pL: s.pL, pS: s.pS, ut: s.ut, vw: s.vw, ssl: s.ssl, bs: s.bs, bv: s.bv, rsi: s.rsi, tL: c.sum?.trigL, tS: c.sum?.trigS, lv: c.live ? 1 : 0 } : {}),
      });
    }
    const h = this.history, wins = h.filter((x) => x.r > 0).length;
    const weights = FEATURE_NAMES.map((name, i) => ({ name, w: this.brain.g[i] })).slice(1).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
    return {
      status: this.status,
      cfg: { tf: this.cfg.tf, minProb: this.cfg.minProb, minEv: this.cfg.minEv, minTrack: this.cfg.minTrack, minTurnover: this.cfg.minTurnover, maxOpen: this.cfg.maxOpen, slAtr: SL_ATR, tpAtr: TP_ATR, horizon: HORIZON },
      brain: { ...this.brain.stats(), weights },
      // moves: net price move of every closed signal in percent (after fees), so the dashboard can grade them at any leverage
      perf: { n: h.length, wins, sumR: h.reduce((a, x) => a + x.r, 0), moves: h.map((x) => +(((x.side * (x.exit - x.entry)) / x.entry - FEE_ROUNDTRIP) * 100).toFixed(3)) },
      open: this.open.map((o) => ({ ...o, price: this.coins.get(o.sym)?.price })),
      history: h.slice(0, 60),
      feed: this.feed.slice(0, 80), feedTotal: this.feed.length,
      live: { t: this.liveT, feed: this.liveFeed.slice(0, 80), total: this.liveFeed.length },
      trig: Object.fromEntries(Object.entries(this.trig).map(([k, v]) => [k, { n: v.n, tp: v.tp / v.n, sl: v.sl / v.n, r: v.r / v.n }])),
      coins,
    };
  }

  // Short-term read (1 and 5 minute candles) for a trade the user is in. Used only by the trade tracker.
  async track(sym) {
    if (!this.coins.has(sym)) throw new Error('unknown symbol');
    const hit = (this.trackCache ||= new Map()).get(sym);
    if (hit && Date.now() - hit.t < 2500) return hit.v;
    const read = async (iv) => {
      const c = await getKlines(sym, iv, 300), ind = computeIndicators(c), i = c.length - 1;
      return { close: c[i].c, ut: ind.utDir[i], utAge: ind.utAge[i], bs: ind.bsDir[i], bsAge: ind.bsAge[i], bv: ind.bvDelta[i], vw: ind.vwapSide[i], rsi: ind.rsi[i], atr: ind.atr[i] };
    };
    const [m1, m5] = await Promise.all([read('1'), read('5')]);
    const v = { sym, t: Date.now(), price: m1.close, m1, m5 };
    this.trackCache.set(sym, { t: Date.now(), v });
    return v;
  }

  async chart(sym, interval) {
    if (!this.coins.has(sym) || !INTERVAL_MS[interval]) throw new Error('unknown symbol or interval');
    const c = await getKlines(sym, interval, 1000);
    const ind = computeIndicators(c);
    const from = Math.max(0, c.length - 700);
    const withProb = interval === this.cfg.tf;
    const out = { sym, interval, candles: [], vwap: [], ut: [], utDir: [], flips: [], pL: [], pS: [], bsFast: [], bsSlow: [], bsFlips: [], bv: [] };
    for (let i = from; i < c.length; i++) {
      const k = c[i];
      out.candles.push([k.t, k.o, k.h, k.l, k.c, k.v]);
      out.vwap.push(ind.vwap[i]); out.ut.push(ind.utTrail[i]); out.utDir.push(ind.utDir[i]);
      if (i > from && ind.utAge[i] === 0) out.flips.push([k.t, ind.utDir[i]]);
      out.bsFast.push(ind.bsFast[i]); out.bsSlow.push(ind.bsSlow[i]); out.bv.push(ind.bvDelta[i]);
      if (i > from && ind.bsAge[i] === 0) out.bsFlips.push([k.t, ind.bsDir[i]]);
      if (withProb && i >= WARMUP) {
        const btc = this.btcCtx.get(k.t) || this.btcLast;
        out.pL.push(this.brain.predict(sym, features(ind, c, i, 1, btc)));
        out.pS.push(this.brain.predict(sym, features(ind, c, i, -1, btc)));
      } else { out.pL.push(null); out.pS.push(null); }
    }
    const coin = this.coins.get(sym);
    out.odds = withProb ? Object.fromEntries(['ut', 'vwap', 'ssl', 'bs', 'bv'].flatMap((k) => [1, -1].map((sd) => [`${k}:${sd}`, this.odds(coin, `${k}:${sd}`)]))) : null;
    out.signals = [...this.open, ...this.history].filter((s) => s.sym === sym);
    return out;
  }
}
