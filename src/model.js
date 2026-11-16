// Online-learning brain: logistic regression trained one sample at a time (SGD).
// A global model shared by all coins + a small per-coin correction that is pulled toward zero,
// so a coin only deviates from the global behaviour when its own history justifies it.

const EDGES = [0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65];

export class Brain {
  constructor(nf) {
    this.nf = nf;
    this.g = new Float64Array(nf);
    this.coins = new Map();
    this.n = 0;
    this.buckets = Array.from({ length: EDGES.length + 1 }, () => ({ n: 0, y: 0 }));
    this.base = { n: 0, y: 0 };
    this.decay = 0.99998; // scoreboard memory, set by the engine to ~30 days of bars
  }

  predict(sym, x) {
    const w = this.coins.get(sym);
    let z = 0;
    for (let k = 0; k < this.nf; k++) z += (this.g[k] + (w ? w[k] : 0)) * x[k];
    return 1 / (1 + Math.exp(-z));
  }

  // `scored` is the prediction that was made when the bar closed (before its future existed);
  // only that one goes on the scoreboard.
  learn(sym, x, y, scored = null) {
    const p = this.predict(sym, x);
    if (scored != null) {
      let b = 0;
      while (b < EDGES.length && scored >= EDGES[b]) b++;
      for (const s of this.buckets) { s.n *= this.decay; s.y *= this.decay; }
      this.base.n = this.base.n * this.decay + 1; this.base.y = this.base.y * this.decay + y;
      this.buckets[b].n += 1; this.buckets[b].y += y;
    }

    let w = this.coins.get(sym);
    if (!w) { w = new Float64Array(this.nf); this.coins.set(sym, w); }
    const err = p - y;
    const lrG = Math.max(+process.env.LR_FLOOR || 0.00003, (+process.env.LR0 || 0.005) / Math.sqrt(1 + this.n / 2000));
    const lrC = +process.env.LRC || 0.0003, l2 = 0.01;
    for (let k = 0; k < this.nf; k++) {
      this.g[k] -= lrG * err * x[k];
      w[k] -= lrC * (err * x[k] + l2 * w[k]);
    }
    this.n++;
    return p;
  }

  // What predictions of this confidence level were actually worth in the past (graded honestly).
  track(p) {
    let b = 0;
    while (b < EDGES.length && p >= EDGES[b]) b++;
    const s = this.buckets[b];
    return { n: s.n, avg: s.n > 1 ? s.y / s.n : null };
  }

  stats() {
    const lo = [0, ...EDGES], hi = [...EDGES, 1];
    return {
      samples: this.n,
      baseRate: this.base.n ? this.base.y / this.base.n : null,
      buckets: this.buckets.map((s, i) => ({ lo: lo[i], hi: hi[i], n: Math.round(s.n), avg: s.n > 1 ? s.y / s.n : null })),
    };
  }

  toJSON() {
    return { nf: this.nf, n: this.n, g: [...this.g], coins: Object.fromEntries([...this.coins].map(([s, w]) => [s, [...w]])), buckets: this.buckets, base: this.base };
  }

  static fromJSON(j, nf) {
    const b = new Brain(nf);
    if (!j || j.nf !== nf) return b;
    b.n = j.n; b.g = Float64Array.from(j.g);
    for (const [s, w] of Object.entries(j.coins || {})) b.coins.set(s, Float64Array.from(w));
    if (j.buckets?.length === b.buckets.length) b.buckets = j.buckets;
    if (j.base) b.base = j.base;
    return b;
  }
}
