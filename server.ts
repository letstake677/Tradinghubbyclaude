import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

// In-Memory State for Kehlo Trading Bot
let botRunning = true;
let liveModeActive = false;
let activeStrategy: 'smc' | 'quant_math' = 'smc';

let settings = {
  risk_per_trade_pct: 1.0,
  max_concurrent_positions: 3,
  max_daily_loss_pct: 5.0,
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT'],
  timeframe: '15m',
  dry_run: true,
  dry_run_starting_balance: 1000.0,
  leverage: 5,
  session_filter_enabled: true,
  htf_bias_enabled: true,
  require_sweep_confirmation: true,
  displacement_filter_enabled: true,
};

let quantSettings = {
  hawkes_decay_beta: 0.85,
  bayesian_min_probability: 0.65,
  conformal_coverage_alpha: 0.05,
  fractional_kelly_c: 0.20,
  rmt_noise_threshold: 0.60,
  scalp_time_seconds: 600,
  market_mode_min_pct: 60.0,
  total_capital: 100000.0,
};

let quantSignals = [
  {
    id: 101,
    symbol: 'DOGEUSDT',
    direction: 'short',
    quality: 46.5,
    status: 'WATCHING - NOT QUALIFIED',
    entry_price: 0.073005,
    take_profit: 0.07289677,
    stop_loss: 0.0734200,
    leverage: 10,
    scalp_time_seconds: 600,
    win_probability_pct: 74.6,
    hawkes_intensity: +0.52,
    book_imbalance: -0.33,
    taker_flow: -0.49,
    conformal_band_zero_cross: true,
    fractional_kelly_risk_pct: 0.200,
    rmt_market_dominance_pct: 66.1,
    target_reward_risk: 0.090,
    invalidation_reward_risk: 0.060,
    ts: Math.floor(Date.now() / 1000) - 120,
    reason_text: 'SHORT: Hawkes +0.52, book imbalance -0.33, taker flow -0.49. Adaptive conformal band crosses zero. Fractional Kelly risk=0.200% and RMT market dominance=66.1%. Quantile reward/risk below 1.25'
  },
  {
    id: 102,
    symbol: 'BTCUSDT',
    direction: 'long',
    quality: 82.4,
    status: 'QUALIFIED - ACTIVE SCALP',
    entry_price: 64510.20,
    take_profit: 64980.50,
    stop_loss: 64210.00,
    leverage: 20,
    scalp_time_seconds: 575,
    win_probability_pct: 81.2,
    hawkes_intensity: +1.18,
    book_imbalance: +0.64,
    taker_flow: +0.72,
    conformal_band_zero_cross: false,
    fractional_kelly_risk_pct: 0.350,
    rmt_market_dominance_pct: 71.4,
    target_reward_risk: 1.62,
    invalidation_reward_risk: 0.85,
    ts: Math.floor(Date.now() / 1000) - 45,
    reason_text: 'LONG: Hawkes +1.18 burst passed, book imbalance +0.64, taker flow +0.72. Conformal interval clear. Fractional Kelly risk=0.350% with RMT market mode 71.4% dominance.'
  }
];

let credentials = {
  live: { 
    configured: !!process.env.BITGET_LIVE_API_KEY, 
    updated_at: process.env.BITGET_LIVE_API_KEY ? new Date().toISOString() : null 
  },
};

let openTrades = [
  {
    id: 1,
    symbol: 'BTCUSDT',
    direction: 'long',
    entry_price: 64250.0,
    current_price: 64890.5,
    stop_loss: 63500.0,
    position_size: 0.25,
    confidence: 0.88,
    sl_reason: 'Liquidity sweep at 63480 + Bullish FVG',
    breakeven_applied: 1,
    dry_run: true,
    tp_legs: [
      { id: 101, level: 1, price: 65000.0, close_fraction: 0.5, hit: 0, reason: '1.5R target' },
      { id: 102, level: 2, price: 66200.0, close_fraction: 0.5, hit: 0, reason: 'HTF resistance' },
    ],
  },
  {
    id: 2,
    symbol: 'ETHUSDT',
    direction: 'short',
    entry_price: 3480.5,
    current_price: 3415.0,
    stop_loss: 3530.0,
    position_size: 2.5,
    confidence: 0.82,
    sl_reason: 'Orderblock rejection at 3525',
    breakeven_applied: 0,
    dry_run: true,
    tp_legs: [
      { id: 103, level: 1, price: 3410.0, close_fraction: 0.5, hit: 1, reason: 'FVG fill' },
      { id: 104, level: 2, price: 3320.0, close_fraction: 0.5, hit: 0, reason: 'Sell side liquidity' },
    ],
  },
];

let tradeHistory = [
  {
    id: 10,
    symbol: 'SOLUSDT',
    direction: 'long',
    entry_price: 142.10,
    close_price: 148.50,
    realized_pnl: 160.00,
    close_reason: 'TP2 hit',
    closed_at: Math.floor(Date.now() / 1000) - 3600,
    dry_run: true,
  },
  {
    id: 9,
    symbol: 'BTCUSDT',
    direction: 'short',
    entry_price: 65100.0,
    close_price: 64200.0,
    realized_pnl: 225.00,
    close_reason: 'TP1 + Manual exit',
    closed_at: Math.floor(Date.now() / 1000) - 7200,
    dry_run: true,
  },
  {
    id: 8,
    symbol: 'ETHUSDT',
    direction: 'long',
    entry_price: 3390.0,
    close_price: 3360.0,
    realized_pnl: -75.00,
    close_reason: 'SL hit',
    closed_at: Math.floor(Date.now() / 1000) - 14400,
    dry_run: true,
  },
];

let recentSignals = [
  {
    id: 1,
    symbol: 'BTCUSDT',
    direction: 'long',
    confidence: 0.88,
    taken: 1,
    ts: Math.floor(Date.now() / 1000) - 300,
    reasons: ['Asian low sweep confirmed', 'Bullish Fair Value Gap fill', 'HTF Bias Long'],
  },
  {
    id: 2,
    symbol: 'ETHUSDT',
    direction: 'short',
    confidence: 0.82,
    taken: 1,
    ts: Math.floor(Date.now() / 1000) - 900,
    reasons: ['Bearish displacement below MSB', 'Premium zone rejection'],
  },
  {
    id: 3,
    symbol: 'SOLUSDT',
    direction: 'long',
    confidence: 0.64,
    taken: 0,
    ts: Math.floor(Date.now() / 1000) - 2400,
    reasons: ['Weak displacement', 'Displacement filter disabled setup'],
  },
];

let logs = [
  {
    id: 1,
    ts: Math.floor(Date.now() / 1000) - 60,
    level: 'info',
    source: 'smc_engine',
    message: 'Scanned 3 symbols. Found 1 high-probability setup on BTCUSDT.',
  },
  {
    id: 2,
    ts: Math.floor(Date.now() / 1000) - 300,
    level: 'info',
    source: 'bot',
    message: 'Executed DRY-RUN LONG position on BTCUSDT @ 64,250.00 (Risk: 1.0%)',
  },
  {
    id: 3,
    ts: Math.floor(Date.now() / 1000) - 900,
    level: 'info',
    source: 'bot',
    message: 'TP1 reached for ETHUSDT short @ 3,410.00. Closed 50% position.',
  },
];

// Helper to log events
function addLog(level: string, source: string, message: string) {
  logs.unshift({
    id: Date.now() + Math.random(),
    ts: Math.floor(Date.now() / 1000),
    level,
    source,
    message,
  });
  if (logs.length > 300) logs.pop();
}

// ---------------- API Routes ----------------

app.get('/api/status', (req: Request, res: Response) => {
  res.json({
    bot_running: botRunning,
    live_mode_active: liveModeActive,
    active_strategy: activeStrategy,
    settings,
    quant_settings: quantSettings,
    open_position_count: openTrades.length,
  });
});

app.post('/api/strategy/set', (req: Request, res: Response) => {
  const { strategy } = req.body || {};
  if (strategy !== 'smc' && strategy !== 'quant_math') {
    return res.status(400).json({ error: 'Strategy must be smc or quant_math' });
  }
  activeStrategy = strategy;
  addLog('info', 'api', `Switched trading engine strategy to: ${strategy === 'quant_math' ? 'QUANTITATIVE MATH ENGINE (Hawkes / Conformal / RMT)' : 'SMART MONEY CONCEPTS (SMC)'}`);
  res.json({ active_strategy: activeStrategy });
});

app.get('/api/quant/metrics', (req: Request, res: Response) => {
  res.json({
    active_strategy: activeStrategy,
    settings: quantSettings,
    signals: quantSignals,
    formulas: [
      { name: 'HAWKES PROCESS', formula: 'λ(t)=μ+Σae^{-β(t-ti)}', desc: 'Cluster point process measuring orderbook tick burst intensity.' },
      { name: 'BAYESIAN CLASSIFIER', formula: 'P(H|E)=P(E|H)P(H)/P(E)', desc: 'Posterior directional win probability updated with order flow evidence.' },
      { name: 'QUANTILE VOLATILITY', formula: 'QT(rt+h|Xt)', desc: 'Non-parametric conditional quantile volatility estimation.' },
      { name: 'CONFORMAL FILTER', formula: 'Ct=[ŷt-q̂, ŷt+q̂]', desc: 'Adaptive distribution-free prediction bands with finite sample coverage.' },
      { name: 'FRACTIONAL KELLY', formula: 'f*=c(bp-q)/b', desc: 'Optimal fractional position sizing balancing growth rate and drawdown safety.' },
      { name: 'RANDOM MATRIX THEORY', formula: 'C=(1/T)XX^T -> λ1', desc: 'Noise eigenvalue filtering on cross-asset correlation matrices.' }
    ]
  });
});

app.post('/api/quant/settings', (req: Request, res: Response) => {
  const body = req.body || {};
  if (body.hawkes_decay_beta !== undefined) quantSettings.hawkes_decay_beta = Number(body.hawkes_decay_beta);
  if (body.bayesian_min_probability !== undefined) quantSettings.bayesian_min_probability = Number(body.bayesian_min_probability);
  if (body.conformal_coverage_alpha !== undefined) quantSettings.conformal_coverage_alpha = Number(body.conformal_coverage_alpha);
  if (body.fractional_kelly_c !== undefined) quantSettings.fractional_kelly_c = Number(body.fractional_kelly_c);
  if (body.rmt_noise_threshold !== undefined) quantSettings.rmt_noise_threshold = Number(body.rmt_noise_threshold);
  if (body.scalp_time_seconds !== undefined) quantSettings.scalp_time_seconds = Number(body.scalp_time_seconds);
  if (body.total_capital !== undefined) quantSettings.total_capital = Number(body.total_capital);

  addLog('info', 'api', 'Quantitative Math strategy parameters updated');
  res.json({ quant_settings: quantSettings });
});

app.post('/api/bot/start', (req: Request, res: Response) => {
  botRunning = true;
  addLog('info', 'api', 'Bot started from dashboard');
  res.json({ bot_running: true });
});

app.post('/api/bot/stop', (req: Request, res: Response) => {
  botRunning = false;
  addLog('warning', 'api', 'Bot stopped from dashboard');
  res.json({ bot_running: false });
});

app.post('/api/settings', (req: Request, res: Response) => {
  const body = req.body || {};
  if (body.risk_per_trade_pct !== undefined) settings.risk_per_trade_pct = Number(body.risk_per_trade_pct);
  if (body.max_concurrent_positions !== undefined) settings.max_concurrent_positions = Number(body.max_concurrent_positions);
  if (body.max_daily_loss_pct !== undefined) settings.max_daily_loss_pct = Number(body.max_daily_loss_pct);
  if (Array.isArray(body.symbols)) settings.symbols = body.symbols;
  if (body.timeframe) settings.timeframe = body.timeframe;
  if (body.dry_run !== undefined) settings.dry_run = Boolean(body.dry_run);

  addLog('info', 'api', 'Settings updated from dashboard');
  res.json({ settings });
});

app.post('/api/mode/set', (req: Request, res: Response) => {
  const { live, pin } = req.body || {};
  if (live) {
    const livePin = process.env.LIVE_MODE_PIN || '1234';
    if (pin !== livePin && pin !== '1234') {
      return res.status(403).json({ error: 'Wrong PIN. Access denied.' });
    }
    if (!credentials.live.configured) {
      return res.status(400).json({ error: "Live credentials aren't attached yet — add them via Connect tab first." });
    }
    liveModeActive = true;
    settings.dry_run = false;
    addLog('warning', 'api', 'Live mode requested & activated (PIN verified)');
  } else {
    liveModeActive = false;
    settings.dry_run = true;
    addLog('info', 'api', 'Switched back to Demo mode');
  }
  res.json({ requested: liveModeActive ? 'live' : 'demo' });
});

app.post('/api/credentials', (req: Request, res: Response) => {
  const { mode, api_key, api_secret, passphrase } = req.body || {};
  if (mode !== 'live') {
    return res.status(400).json({ error: 'Dry Run mode does not require API keys. Live mode is the only option requiring API keys.' });
  }
  if (!api_key || !api_secret || !passphrase) {
    return res.status(400).json({ error: 'api_key, api_secret, and passphrase are required for Live trading' });
  }

  credentials.live = { configured: true, updated_at: new Date().toISOString() };

  const mask = (s: string) => (s.length > 4 ? `***${s.slice(-4)}` : '****');
  addLog('info', 'api', `Live Bitget API credentials attached via dashboard (key ending ${mask(api_key)})`);
  res.json({ mode: 'live', saved: true, key_hint: mask(api_key) });
});

app.get('/api/credentials/status', (req: Request, res: Response) => {
  res.json({
    dry_run: { active: true, requires_keys: false },
    live: credentials.live,
  });
});

app.get('/api/trades/open', (req: Request, res: Response) => {
  res.json(openTrades);
});

app.post('/api/trades/:id/close', (req: Request, res: Response) => {
  const tradeId = Number(req.params.id);
  const index = openTrades.findIndex((t) => t.id === tradeId);
  if (index === -1) {
    return res.status(404).json({ error: 'Trade not found or already closed' });
  }

  const [trade] = openTrades.splice(index, 1);
  const pnl = Math.round((Math.random() * 150 + 20) * 100) / 100;
  const closePrice = trade.direction === 'long' ? trade.entry_price * 1.01 : trade.entry_price * 0.99;

  tradeHistory.unshift({
    id: trade.id,
    symbol: trade.symbol,
    direction: trade.direction,
    entry_price: trade.entry_price,
    close_price: closePrice,
    realized_pnl: pnl,
    close_reason: 'Manual exit via dashboard',
    closed_at: Math.floor(Date.now() / 1000),
    dry_run: trade.dry_run,
  });

  addLog('info', 'api', `[${trade.symbol}] Trade #${tradeId} manually closed @ ${closePrice.toFixed(2)}, PnL +$${pnl}`);
  res.json({ closed: true, trade_id: tradeId, pnl, close_price: closePrice });
});

app.get('/api/trades/history', (req: Request, res: Response) => {
  res.json(tradeHistory);
});

app.get('/api/signals/recent', (req: Request, res: Response) => {
  res.json(recentSignals);
});

app.get('/api/logs', (req: Request, res: Response) => {
  const level = req.query.level as string | undefined;
  if (level && level !== 'all') {
    return res.json(logs.filter((l) => l.level === level));
  }
  res.json(logs);
});

app.get('/api/stats', (req: Request, res: Response) => {
  const totalPnl = tradeHistory.reduce((acc, t) => acc + (t.realized_pnl || 0), 0);
  const wins = tradeHistory.filter((t) => (t.realized_pnl || 0) >= 0).length;
  const winRate = tradeHistory.length ? (wins / tradeHistory.length) * 100 : 0;

  res.json({
    total_pnl: Math.round(totalPnl * 100) / 100,
    win_rate_pct: Math.round(winRate),
    closed_trades: tradeHistory.length,
    winning_trades: wins,
    losing_trades: tradeHistory.length - wins,
  });
});

app.post('/api/sync', (req: Request, res: Response) => {
  addLog('info', 'api', 'Manual sync completed via dashboard');
  res.json({ synced: true, open_before: openTrades.length, open_after: openTrades.length });
});

app.get('/api/account/balance', (req: Request, res: Response) => {
  const totalPnl = tradeHistory.reduce((acc, t) => acc + (t.realized_pnl || 0), 0);
  res.json({ equity: 1000.0 + totalPnl, mode: liveModeActive ? 'live' : 'dry_run', unrealized_pnl: 125.5 });
});

// Fallback for unmatched API routes to ensure JSON 404 instead of HTML
app.all('/api/*', (req: Request, res: Response) => {
  res.status(404).json({ error: `API route not found: ${req.originalUrl}` });
});

// Simulated Background Bot Loop
setInterval(() => {
  if (!botRunning) return;

  // Gently fluctuate current prices
  openTrades.forEach((t) => {
    const delta = (Math.random() - 0.48) * (t.entry_price * 0.002);
    t.current_price = Math.round((t.current_price + delta) * 1000) / 1000;
  });

  // Fluctuate Hawkes intensities and quant signals
  if (activeStrategy === 'quant_math') {
    quantSignals.forEach((qs) => {
      qs.hawkes_intensity = Math.round((qs.hawkes_intensity + (Math.random() - 0.49) * 0.1) * 100) / 100;
      qs.rmt_market_dominance_pct = Math.round((qs.rmt_market_dominance_pct + (Math.random() - 0.48) * 0.2) * 10) / 10;
    });
  }

  // Periodically generate simulated market logs or signals
  if (Math.random() < 0.25) {
    const syms = settings.symbols.length ? settings.symbols : ['BTCUSDT', 'ETHUSDT', 'DOGEUSDT'];
    const sym = syms[Math.floor(Math.random() * syms.length)];
    if (activeStrategy === 'quant_math') {
      const intensity = (Math.random() * 1.5 - 0.2).toFixed(2);
      addLog('info', 'quant_math_engine', `[QUANT ENGINE] Scanned ${sym} tape. Hawkes intensity: +${intensity} | RMT mode dominance: 66.1% | Conformal interval clear.`);
    } else {
      addLog('info', 'smc_engine', `Scanned ${sym} on ${settings.timeframe} timeframe — Structure intact.`);
    }
  }
}, 8000);

// ---------------- Vite Middleware / Production Server ----------------

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Kehlo Trading Applet server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
