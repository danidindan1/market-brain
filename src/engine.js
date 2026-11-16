// The engine: pulls candles for every Bybit USDT perpetual, teaches the brain from every
// finished bar, and turns fresh indicator triggers + model confidence into enter/exit alerts.
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { computeIndicators, features, btcContext, label, evR, FEATURE_NAMES, NF, HORIZON, WARMUP, SL_ATR, TP_ATR, FEE_ROUNDTRIP } from './indicators.js';
import { Brain } from './model.js';
import { getSymbols, getKlines, getTickers, pool, INTERVAL_MS } from './bybit.js';

const MAXC = 1500;
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
      minTrack: 5000,                                  // graded predictions needed before trusting a level
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
    this.status = { phase: 'starting', done: 0, total: 0, lastScan: null, nextScan: null, error: null };
    this.scanning = false;
  }

  // ---------- persistence ----------
  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.cfg.stateFile, 'utf8'));
      if (j.tf !== this.cfg.tf) return;
      this.brain = Brain.fromJSON(j.brain, NF);
      this.saved = j.coins || {};
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
      for (const coin of this.coins.values()) this.summarize(coin, inds.get(coin.sym));
      inds.clear();
      this.save();

      this.status = { ...this.status, phase: 'live', error: null };
      this.emit('status');
      console.log(`live: ${this.coins.size} coins, ${this.brain.n} samples learned`);
      this.schedule();
      this.tickerLoop();
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
      for (const side of [1, -1]) {
        const y = label(c, i, side, ind.atr[i]);
        if (y != null) this.brain.learn(coin.sym, features(ind, c, i, side, btc), y, pr ? pr[side > 0 ? 0 : 1] : null);
      }
    }
    coin.nextTrainT = c[i].t;
  }

  summarize(coin, ind) {
    const c = coin.candles, i = c.length - 1;
    if (i < WARMUP) { coin.sum = null; return; }
    const btc = this.btcCtx.get(c[i].t) || this.btcLast;
    const trig = (side) => {
      const r = [];
      if (ind.utAge[i] === 0 && ind.utDir[i] === side) r.push(side > 0 ? 'UT Bot התהפך לקנייה' : 'UT Bot התהפך למכירה');
      if (ind.vwapAge[i] === 0 && ind.vwapSide[i] === side) r.push(side > 0 ? 'חצה את ה-VWAP למעלה' : 'חצה את ה-VWAP למטה');
      if (ind.sslAge[i] === 0 && ind.sslDir[i] === side) r.push(side > 0 ? 'SSL התהפך לירוק' : 'SSL התהפך לאדום');
      return r;
    };
    coin.sum = {
      t: c[i].t, close: c[i].c, atr: ind.atr[i],
      pL: this.brain.predict(coin.sym, features(ind, c, i, 1, btc)),
      pS: this.brain.predict(coin.sym, features(ind, c, i, -1, btc)),
      ut: ind.utDir[i], utAge: ind.utAge[i], vw: ind.vwapSide[i], ssl: ind.sslDir[i], rsi: ind.rsi[i],
      trigL: trig(1), trigS: trig(-1), hi: c[i].h, lo: c[i].l,
    };
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
      const candidates = [];
      await pool([...this.coins.values()], 6, async (coin) => {
        try {
          if (coin !== btc) await this.refresh(coin);
          const ind = computeIndicators(coin.candles);
          this.trainCoin(coin, ind);
          this.summarize(coin, ind);
          this.checkExitOnClose(coin);
          const s = coin.sum;
          if (!s || s.t + 2 * this.tfMs < Date.now() || coin.turnover < this.cfg.minTurnover) return;
          for (const [side, p, reasons] of [[1, s.pL, s.trigL], [-1, s.pS, s.trigS]]) {
            if (!reasons.length || p < this.cfg.minProb) continue;
            const tr = this.brain.track(p);   // only alert where past predictions at this level really paid
            if (tr.n < this.cfg.minTrack || evR(tr.avg) < this.cfg.minEv) continue;
            candidates.push({ coin, side, p, reasons, ev: evR(tr.avg) });
          }
        } catch (e) { console.error(`scan ${coin.sym}: ${e.message}`); }
      });
      candidates.sort((a, b) => b.p - a.p);
      for (const cand of candidates) {
        if (this.open.length >= this.cfg.maxOpen) break;
        if (this.open.some((o) => o.sym === cand.coin.sym)) continue;
        this.openSignal(cand);
      }
      this.status.lastScan = Date.now();
      this.save();
      this.emit('scan');
    } finally { this.scanning = false; }
  }

  openSignal({ coin, side, p, reasons, ev }) {
    const s = coin.sum;
    const sig = {
      id: `${coin.sym}-${s.t}`, sym: coin.sym, side, entry: s.close,
      sl: s.close - side * SL_ATR * s.atr, tp: s.close + side * TP_ATR * s.atr,
      p, ev, reasons, t: Date.now(), barT: s.t,
    };
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
      const s = c.sum;
      coins.push({
        s: c.sym, price: c.price, chg: c.chg, to: c.turnover,
        ...(s ? { pL: s.pL, pS: s.pS, ut: s.ut, vw: s.vw, ssl: s.ssl, rsi: s.rsi, tL: s.trigL, tS: s.trigS } : {}),
      });
    }
    const h = this.history, wins = h.filter((x) => x.r > 0).length;
    const weights = FEATURE_NAMES.map((name, i) => ({ name, w: this.brain.g[i] })).slice(1).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
    return {
      status: this.status,
      cfg: { tf: this.cfg.tf, minProb: this.cfg.minProb, minEv: this.cfg.minEv, minTrack: this.cfg.minTrack, minTurnover: this.cfg.minTurnover, maxOpen: this.cfg.maxOpen, slAtr: SL_ATR, tpAtr: TP_ATR, horizon: HORIZON },
      brain: { ...this.brain.stats(), weights },
      perf: { n: h.length, wins, sumR: h.reduce((a, x) => a + x.r, 0) },
      open: this.open.map((o) => ({ ...o, price: this.coins.get(o.sym)?.price })),
      history: h.slice(0, 60),
      coins,
    };
  }

  async chart(sym, interval) {
    if (!this.coins.has(sym) || !INTERVAL_MS[interval]) throw new Error('unknown symbol or interval');
    const c = await getKlines(sym, interval, 1000);
    const ind = computeIndicators(c);
    const from = Math.max(0, c.length - 700);
    const withProb = interval === this.cfg.tf;
    const out = { sym, interval, candles: [], vwap: [], ut: [], utDir: [], flips: [], pL: [], pS: [] };
    for (let i = from; i < c.length; i++) {
      const k = c[i];
      out.candles.push([k.t, k.o, k.h, k.l, k.c, k.v]);
      out.vwap.push(ind.vwap[i]); out.ut.push(ind.utTrail[i]); out.utDir.push(ind.utDir[i]);
      if (i > from && ind.utAge[i] === 0) out.flips.push([k.t, ind.utDir[i]]);
      if (withProb && i >= WARMUP) {
        const btc = this.btcCtx.get(k.t) || this.btcLast;
        out.pL.push(this.brain.predict(sym, features(ind, c, i, 1, btc)));
        out.pS.push(this.brain.predict(sym, features(ind, c, i, -1, btc)));
      } else { out.pL.push(null); out.pS.push(null); }
    }
    out.signals = [...this.open, ...this.history].filter((s) => s.sym === sym);
    return out;
  }
}
