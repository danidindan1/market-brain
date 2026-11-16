// Indicators (UT Bot, VWAP, SSL Channel, Buy Sell Signal, Buy Sell Volume, RSI, EMA200, volume) + feature vector + outcome label.
// Candles: [{t, o, h, l, c, v}] ascending by time.

export const SL_ATR = 1.5;    // stop distance in ATRs
export const TP_ATR = 2.25;   // target distance in ATRs (reward:risk 1.5)
export const RR = TP_ATR / SL_ATR;
export const HORIZON = 24;    // bars a trade idea is allowed to live
export const WARMUP = 210;    // bars needed before indicators are trustworthy
export const FEE_ROUNDTRIP = 0.0011; // 0.055% taker x2, charged against every label

const UT_KEY = 1, UT_ATR = 10, ATR_LEN = 14, SSL_LEN = 10, RSI_LEN = 14, EMA_LEN = 200, VOL_LEN = 20;
const BS_FAST = 9, BS_SLOW = 21; // Buy Sell Signal: fast EMA crossing slow EMA
const BSV_LEN = 14;              // Buy Sell Volume: smoothing of buyers' / sellers' volume

export function computeIndicators(c) {
  const n = c.length;
  const F = () => new Float64Array(n);
  const atr = F(), atrUt = F(), utTrail = F(), vwap = F(), sslUp = F(), sslDown = F(), rsi = F(), ema = F(), volZ = F();
  const utDir = new Int8Array(n), vwapSide = new Int8Array(n), sslDir = new Int8Array(n);
  const utAge = new Int32Array(n), vwapAge = new Int32Array(n), sslAge = new Int32Array(n);
  const bsDir = new Int8Array(n), bvDir = new Int8Array(n), bsAge = new Int32Array(n), bvAge = new Int32Array(n), bvDelta = F();
  if (!n) return { atr, utTrail, utDir, utAge, vwap, vwapSide, vwapAge, sslUp, sslDown, sslDir, sslAge, rsi, ema, volZ, bsDir, bsAge, bvDir, bvAge, bvDelta };

  let cumPV = 0, cumV = 0, day = -1;
  let avgGain = 0, avgLoss = 0;
  let sumH = 0, sumL = 0;
  const kEma = 2 / (EMA_LEN + 1);
  const kF = 2 / (BS_FAST + 1), kS = 2 / (BS_SLOW + 1), kV = 2 / (BSV_LEN + 1);
  let emaF = 0, emaS = 0, buyE = 0, sellE = 0;
  const lv = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const k = c[i], p = i ? c[i - 1] : null;
    // ATR (Wilder)
    const tr = p ? Math.max(k.h - k.l, Math.abs(k.h - p.c), Math.abs(k.l - p.c)) : k.h - k.l;
    atr[i] = p ? (atr[i - 1] * (ATR_LEN - 1) + tr) / ATR_LEN : tr;
    atrUt[i] = p ? (atrUt[i - 1] * (UT_ATR - 1) + tr) / UT_ATR : tr;

    // UT Bot trailing stop
    const nLoss = UT_KEY * atrUt[i];
    if (!p) utTrail[i] = k.c - nLoss;
    else {
      const prev = utTrail[i - 1];
      if (k.c > prev && p.c > prev) utTrail[i] = Math.max(prev, k.c - nLoss);
      else if (k.c < prev && p.c < prev) utTrail[i] = Math.min(prev, k.c + nLoss);
      else utTrail[i] = k.c > prev ? k.c - nLoss : k.c + nLoss;
    }
    utDir[i] = k.c > utTrail[i] ? 1 : k.c < utTrail[i] ? -1 : (p ? utDir[i - 1] : 1);
    utAge[i] = p && utDir[i] === utDir[i - 1] ? utAge[i - 1] + 1 : (p ? 0 : 99);

    // VWAP, resets every UTC day
    const d = Math.floor(k.t / 864e5);
    const reset = d !== day;
    if (reset) { day = d; cumPV = 0; cumV = 0; }
    cumPV += ((k.h + k.l + k.c) / 3) * k.v; cumV += k.v;
    vwap[i] = cumV > 0 ? cumPV / cumV : k.c;
    vwapSide[i] = k.c > vwap[i] ? 1 : k.c < vwap[i] ? -1 : (p ? vwapSide[i - 1] : 1);
    vwapAge[i] = !p ? 99 : (vwapSide[i] === vwapSide[i - 1] || reset) ? vwapAge[i - 1] + 1 : 0;

    // SSL Channel
    sumH += k.h; sumL += k.l;
    if (i >= SSL_LEN) { sumH -= c[i - SSL_LEN].h; sumL -= c[i - SSL_LEN].l; }
    const m = Math.min(i + 1, SSL_LEN), smaH = sumH / m, smaL = sumL / m;
    sslDir[i] = k.c > smaH ? 1 : k.c < smaL ? -1 : (p ? sslDir[i - 1] : 1);
    sslUp[i] = sslDir[i] < 0 ? smaL : smaH;
    sslDown[i] = sslDir[i] < 0 ? smaH : smaL;
    sslAge[i] = p && sslDir[i] === sslDir[i - 1] ? sslAge[i - 1] + 1 : (p ? 0 : 99);

    // RSI (Wilder)
    if (p) {
      const ch = k.c - p.c, g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
      const len = Math.min(i, RSI_LEN);
      avgGain = (avgGain * (len - 1) + g) / len; avgLoss = (avgLoss * (len - 1) + l) / len;
      rsi[i] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
    } else rsi[i] = 50;

    // EMA 200
    ema[i] = p ? ema[i - 1] + kEma * (k.c - ema[i - 1]) : k.c;

    // Buy Sell Signal: fast EMA above slow EMA = buy, below = sell; the flip is the signal
    emaF = p ? emaF + kF * (k.c - emaF) : k.c;
    emaS = p ? emaS + kS * (k.c - emaS) : k.c;
    bsDir[i] = emaF > emaS ? 1 : emaF < emaS ? -1 : (p ? bsDir[i - 1] : 1);
    bsAge[i] = p && bsDir[i] === bsDir[i - 1] ? bsAge[i - 1] + 1 : (p ? 0 : 99);

    // Buy Sell Volume: each bar's volume is split by where it closed inside its range
    // (close at the high = all buyers, at the low = all sellers), then both sides are smoothed.
    const rng = k.h - k.l, buy = rng > 0 ? (k.v * (k.c - k.l)) / rng : k.v / 2, sell = k.v - buy;
    buyE = p ? buyE + kV * (buy - buyE) : buy;
    sellE = p ? sellE + kV * (sell - sellE) : sell;
    bvDelta[i] = buyE + sellE > 0 ? (buyE - sellE) / (buyE + sellE) : 0;
    bvDir[i] = buyE > sellE ? 1 : buyE < sellE ? -1 : (p ? bvDir[i - 1] : 1);
    bvAge[i] = p && bvDir[i] === bvDir[i - 1] ? bvAge[i - 1] + 1 : (p ? 0 : 99);

    // Volume z-score (log volume vs previous 20 bars)
    lv[i] = Math.log(1 + k.v);
    if (i >= VOL_LEN) {
      let s = 0, s2 = 0;
      for (let j = i - VOL_LEN; j < i; j++) { s += lv[j]; s2 += lv[j] * lv[j]; }
      const mean = s / VOL_LEN, sd = Math.sqrt(Math.max(1e-9, s2 / VOL_LEN - mean * mean));
      volZ[i] = (lv[i] - mean) / (sd + 0.05);
    }
  }
  return { atr, utTrail, utDir, utAge, vwap, vwapSide, vwapAge, sslUp, sslDown, sslDir, sslAge, rsi, ema, volZ, bsDir, bsAge, bvDir, bvAge, bvDelta };
}

export const FEATURE_NAMES = [
  'בסיס (נטייה כללית)',
  'UT Bot – כיוון',
  'UT Bot – היפוך טרי',
  'מרחק מקו ה-UT',
  'מרחק מ-VWAP',
  'חציית VWAP טרייה',
  'SSL – כיוון',
  'SSL – היפוך טרי',
  'RSI – רמה',
  'RSI – שינוי',
  'מרחק מ-EMA200 (טרנד)',
  'שיפוע EMA200',
  'נפח חריג',
  'נפח חריג בכיוון הנר',
  'תנודתיות (ATR%)',
  'מומנטום 3 נרות',
  'מומנטום 12 נרות',
  'שעה ביום (sin)',
  'שעה ביום (cos)',
  'טרנד של BTC',
  'מומנטום של BTC',
  'הסכמה בין האינדיקטורים',
  'שלושתם מסכימים',
  'Buy Sell Signal – כיוון',
  'Buy Sell Signal – היפוך טרי',
  'Buy Sell Volume – מאזן קונים מול מוכרים',
  'Buy Sell Volume – היפוך טרי',
];
export const NF = FEATURE_NAMES.length;

const clip = (x, a) => (x > a ? a : x < -a ? -a : x);

// Feature vector for taking `side` (+1 long / -1 short) at the close of bar i.
// Directional features are multiplied by side so one model learns both directions.
export function features(ind, c, i, side, btc) {
  const k = c[i], a = ind.atr[i] || 1e-12, cl = k.c;
  const ut = ind.utDir[i], vw = ind.vwapSide[i], ssl = ind.sslDir[i];
  const hr = ((k.t % 864e5) / 864e5) * 2 * Math.PI;
  const agree = ut + vw + ssl;
  const x = new Float64Array(NF);
  x[0] = 1;
  x[1] = side * ut;
  x[2] = side * ut * Math.exp(-ind.utAge[i] / 4);
  x[3] = clip((side * (cl - ind.utTrail[i])) / a, 5) / 2;
  x[4] = clip((side * (cl - ind.vwap[i])) / a, 6) / 3;
  x[5] = side * vw * Math.exp(-ind.vwapAge[i] / 4);
  x[6] = side * ssl;
  x[7] = side * ssl * Math.exp(-ind.sslAge[i] / 4);
  x[8] = (side * (ind.rsi[i] - 50)) / 20;
  x[9] = clip(side * (ind.rsi[i] - ind.rsi[Math.max(0, i - 3)]), 30) / 15;
  x[10] = clip((side * (cl - ind.ema[i])) / a, 20) / 10;
  x[11] = clip((side * (ind.ema[i] - ind.ema[Math.max(0, i - 10)])) / a, 3);
  x[12] = clip(ind.volZ[i], 3) / 1.5;
  x[13] = (clip(ind.volZ[i], 3) / 1.5) * side * Math.sign(cl - k.o);
  x[14] = clip((a / cl) * 100, 5) / 2 - 0.5;
  x[15] = clip((side * (cl - c[Math.max(0, i - 3)].c)) / a, 6) / 3;
  x[16] = clip((side * (cl - c[Math.max(0, i - 12)].c)) / a, 10) / 5;
  x[17] = Math.sin(hr);
  x[18] = Math.cos(hr);
  x[19] = btc ? side * btc[0] : 0;
  x[20] = btc ? side * btc[1] : 0;
  x[21] = (side * agree) / 3;
  x[22] = side * agree === 3 ? 1 : 0;
  x[23] = side * ind.bsDir[i];
  x[24] = side * ind.bsDir[i] * Math.exp(-ind.bsAge[i] / 4);
  x[25] = clip(side * ind.bvDelta[i] * 5, 2);
  x[26] = side * ind.bvDir[i] * Math.exp(-ind.bvAge[i] / 4);
  return x;
}

// BTC market-regime context for bar i: [trend, momentum]
export function btcContext(ind, c, i) {
  const a = ind.atr[i] || 1e-12;
  return [clip((c[i].c - ind.ema[i]) / a, 20) / 10, clip((c[i].c - c[Math.max(0, i - 12)].c) / a, 10) / 5];
}

// What actually happened after entering `side` at the close of bar i with SL/TP in ATRs.
// res: 'tp' (target hit) / 'sl' (stop hit) / 'to' (neither within HORIZON bars); r = net result in R after fees.
// Needs i+HORIZON <= n-1.
export function outcome(c, i, side, atr) {
  const entry = c[i].c, slD = SL_ATR * atr, tpD = TP_ATR * atr;
  if (!(slD > 0)) return null;
  let r = null, res = 'to';
  for (let j = i + 1; j <= i + HORIZON; j++) {
    const k = c[j];
    const hitSl = side > 0 ? k.l <= entry - slD : k.h >= entry + slD;
    const hitTp = side > 0 ? k.h >= entry + tpD : k.l <= entry - tpD;
    if (hitSl) { r = -1; res = 'sl'; break; }   // both in one bar counts as a loss (conservative)
    if (hitTp) { r = RR; res = 'tp'; break; }
  }
  if (r === null) r = (side * (c[i + HORIZON].c - entry)) / slD;
  return { res, r: r - (FEE_ROUNDTRIP * entry) / slD };
}

// Training label in [0,1] where expected net R = (1+RR)*label - 1.
export function label(c, i, side, atr) {
  const o = outcome(c, i, side, atr);
  if (!o) return null;
  const y = (o.r + 1) / (1 + RR);
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

// Which indicators crossed in favour of `side` exactly on bar i.
export function crossKinds(ind, i, side) {
  const k = [];
  if (i < 1) return k;
  if (ind.utAge[i] === 0 && ind.utDir[i] === side) k.push('ut');
  if (ind.vwapAge[i] === 0 && ind.vwapSide[i] === side) k.push('vwap');
  if (ind.sslAge[i] === 0 && ind.sslDir[i] === side) k.push('ssl');
  if (ind.bsAge[i] === 0 && ind.bsDir[i] === side) k.push('bs');
  if (ind.bvAge[i] === 0 && ind.bvDir[i] === side) k.push('bv');
  return k;
}

export const evR = (p) => (1 + RR) * p - 1; // expected net R for a predicted label p
