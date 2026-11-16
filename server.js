import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { Engine } from './src/engine.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const engine = new Engine({
  tf: process.env.TF,                     // candle size the brain trades on: 5 / 15 / 60 (default) / 240
  minProb: process.env.MIN_PROB,          // minimum model confidence for an entry alert
  minEv: process.env.MIN_EV,              // minimum proven edge (R) at that confidence level
  minTurnover: process.env.MIN_TURNOVER,  // skip alerts on coins with less 24h volume ($)
  maxOpen: process.env.MAX_OPEN,
  maxCoins: process.env.MAX_COINS,
  stateFile: process.env.STATE_FILE || path.join(dir, 'data/state.json'),
});

const app = express();
app.use(express.static(path.join(dir, 'public')));
app.get('/api/state', (req, res) => res.json(engine.getState()));
app.get('/api/chart', async (req, res) => {
  try { res.json(await engine.chart(String(req.query.symbol || ''), String(req.query.interval || engine.cfg.tf))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const broadcast = (msg) => {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
};
engine.on('signal', (signal) => broadcast({ type: 'signal', signal }));
engine.on('exit', (signal) => broadcast({ type: 'exit', signal }));
engine.on('scan', () => broadcast({ type: 'scan' }));
engine.on('status', () => broadcast({ type: 'status', status: engine.status }));

const port = process.env.PORT || 4600;
server.listen(port, () => {
  console.log(`Market Brain on http://localhost:${port}`);
  engine.start();
});
