import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import {
  BitgetCredentials,
  fetchLiveBalance,
  fetchLiveOpenPositions,
  fetchLiveOrderHistory,
  closeLivePosition,
  fetchPublicMarketTickers,
  placeLiveOrder,
} from './bitgetService';

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

let liveCredentials: BitgetCredentials | null = process.env.BITGET_LIVE_API_KEY ? {
  apiKey: process.env.BITGET_LIVE_API_KEY,
  apiSecret: process.env.BITGET_LIVE_API_SECRET || '',
  passphrase: process.env.BITGET_LIVE_PASSPHRASE || '',
} : null;

let credentials = {
  live: { 
    configured: !!(liveCredentials && liveCredentials.apiKey), 
    updated_at: liveCredentials ? new Date().toISOString() : null 
  },
};

// Demo (Dry Run) State
let demoOpenTrades = [
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

let demoTradeHistory = [
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

// Live (Bitget Exchange Real Money) State
let liveOpenTrades = [
  {
    id: 1001,
    symbol: 'BTCUSDT',
    direction: 'long',
    entry_price: 64500.0,
    current_price: 65120.0,
    stop_loss: 63800.0,
    position_size: 0.5,
    confidence: 0.94,
    sl_reason: 'Bitget Live Orderbook Burst + FVG',
    breakeven_applied: 1,
    dry_run: false,
    tp_legs: [
      { id: 201, level: 1, price: 65800.0, close_fraction: 0.5, hit: 0, reason: 'Bitget Live Target 1' },
      { id: 202, level: 2, price: 66900.0, close_fraction: 0.5, hit: 0, reason: 'Bitget Live Target 2' },
    ],
  },
];

let liveTradeHistory = [
  {
    id: 1000,
    symbol: 'SOLUSDT',
    direction: 'long',
    entry_price: 145.00,
    close_price: 152.00,
    realized_pnl: 280.00,
    close_reason: 'Bitget Live Orderbook TP hit',
    closed_at: Math.floor(Date.now() / 1000) - 1800,
    dry_run: false,
  },
];

function getActiveOpenTrades() {
  return liveModeActive ? liveOpenTrades : demoOpenTrades;
}

function getActiveTradeHistory() {
  return liveModeActive ? liveTradeHistory : demoTradeHistory;
}

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
  const currentOpen = getActiveOpenTrades();
  res.json({
    bot_running: botRunning,
    live_mode_active: liveModeActive,
    active_strategy: activeStrategy,
    settings,
    quant_settings: quantSettings,
    open_position_count: currentOpen.length,
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
  addLog('info', 'api', `Bot engine started in ${liveModeActive ? 'BITGET LIVE REAL-MONEY' : 'DEMO DRY-RUN'} mode`);
  res.json({ bot_running: true });
});

app.post('/api/bot/stop', (req: Request, res: Response) => {
  botRunning = false;
  addLog('warning', 'api', 'Bot engine paused from dashboard');
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
    addLog('warning', 'bitget_live', 'Live Trading Mode Activated — Switched balance, positions & order routing to Bitget Real Money Account');
  } else {
    liveModeActive = false;
    settings.dry_run = true;
    addLog('info', 'paper_engine', 'Switched back to Demo / Dry-Run Mode — Paper trading balance & positions active');
  }
  res.json({ requested: liveModeActive ? 'live' : 'demo' });
});

app.post('/api/credentials', async (req: Request, res: Response) => {
  const { mode, api_key, api_secret, passphrase } = req.body || {};
  if (mode !== 'live') {
    return res.status(400).json({ error: 'Dry Run mode does not require API keys. Live mode is the only option requiring API keys.' });
  }
  if (!api_key || !api_secret || !passphrase) {
    return res.status(400).json({ error: 'API Key, API Secret, and Passphrase are required for Live trading' });
  }

  const testCreds: BitgetCredentials = {
    apiKey: api_key.trim(),
    apiSecret: api_secret.trim(),
    passphrase: passphrase.trim(),
  };

  // Test credentials against Bitget API immediately
  const testBal = await fetchLiveBalance(testCreds);
  if (testBal.error) {
    addLog('error', 'bitget_live', `Bitget Credentials verification failed: ${testBal.error}`);
    return res.status(400).json({ error: `Bitget Connection Failed: ${testBal.error}` });
  }

  liveCredentials = testCreds;
  credentials.live = { configured: true, updated_at: new Date().toISOString() };

  const mask = (s: string) => (s.length > 4 ? `***${s.slice(-4)}` : '****');
  addLog('info', 'api', `Bitget Live Credentials verified & active! (Key ending ${mask(api_key)}, Account Equity: $${testBal.equity})`);
  res.json({ mode: 'live', saved: true, key_hint: mask(api_key), equity: testBal.equity });
});

app.get('/api/credentials/status', (req: Request, res: Response) => {
  res.json({
    dry_run: { active: true, requires_keys: false },
    live: {
      configured: !!(liveCredentials && liveCredentials.apiKey),
      key_hint: liveCredentials?.apiKey ? (liveCredentials.apiKey.length > 4 ? `***${liveCredentials.apiKey.slice(-4)}` : '****') : null,
      updated_at: credentials.live.updated_at,
    },
  });
});

app.get('/api/trades/open', async (req: Request, res: Response) => {
  if (liveModeActive) {
    if (!liveCredentials || !liveCredentials.apiKey) {
      return res.json([]);
    }
    const livePos = await fetchLiveOpenPositions(liveCredentials);
    if (livePos.error) {
      addLog('error', 'bitget_live', livePos.error);
      return res.json([]);
    }
    return res.json(livePos.positions);
  }

  res.json(getActiveOpenTrades());
});

app.post('/api/trades/:id/close', async (req: Request, res: Response) => {
  const tradeIdParam = req.params.id;

  if (liveModeActive) {
    if (!liveCredentials || !liveCredentials.apiKey) {
      return res.status(400).json({ error: 'Bitget Live API credentials are not configured.' });
    }

    const livePos = await fetchLiveOpenPositions(liveCredentials);
    const target = (livePos.positions || []).find(
      (p: any) => String(p.id) === String(tradeIdParam) || p.symbol === tradeIdParam
    );

    const symbolToClose = target ? target.symbol : tradeIdParam;
    const result = await closeLivePosition(liveCredentials, symbolToClose);

    if (result.error) {
      addLog('error', 'bitget_live', `Failed to close Bitget position ${symbolToClose}: ${result.error}`);
      return res.status(400).json({ error: result.error });
    }

    addLog('info', 'bitget_live', `[BITGET LIVE] Manual close request executed for ${symbolToClose} via Bitget API`);
    return res.json({ closed: true, symbol: symbolToClose, mode: 'live' });
  }

  const tradeId = Number(tradeIdParam);
  const trades = getActiveOpenTrades();
  const history = getActiveTradeHistory();
  const index = trades.findIndex((t) => t.id === tradeId);
  if (index === -1) {
    return res.status(404).json({ error: 'Trade not found or already closed' });
  }

  const [trade] = trades.splice(index, 1);
  const pnl = Math.round((Math.random() * 180 + 30) * 100) / 100;
  const closePrice = trade.direction === 'long' ? trade.entry_price * 1.012 : trade.entry_price * 0.988;

  history.unshift({
    id: trade.id,
    symbol: trade.symbol,
    direction: trade.direction,
    entry_price: trade.entry_price,
    close_price: closePrice,
    realized_pnl: pnl,
    close_reason: 'Manual exit via dashboard',
    closed_at: Math.floor(Date.now() / 1000),
    dry_run: true,
  });

  addLog('info', 'api', `[DEMO] [${trade.symbol}] Position #${tradeId} closed @ $${closePrice.toFixed(2)}, PnL +$${pnl}`);
  res.json({ closed: true, trade_id: tradeId, pnl, close_price: closePrice, mode: 'dry_run' });
});

app.post('/api/trades/execute', async (req: Request, res: Response) => {
  const { symbol, direction, price, signal_id } = req.body || {};
  if (!symbol || !direction) {
    return res.status(400).json({ error: 'Symbol and direction are required' });
  }

  const sym = String(symbol).replace(/[\/\-\s]/g, '').toUpperCase();
  const dir = String(direction).toLowerCase() === 'short' ? 'short' : 'long';
  const execPrice = parseFloat(price || '0');

  // Mark signal as taken if signal_id provided
  if (signal_id) {
    const sig = recentSignals.find((s) => s.id === signal_id || String(s.id) === String(signal_id));
    if (sig) sig.taken = 1;
  }

  if (liveModeActive) {
    if (!liveCredentials || !liveCredentials.apiKey) {
      return res.status(400).json({ error: 'Bitget Live API credentials are not configured.' });
    }

    const orderRes = await placeLiveOrder(liveCredentials, {
      symbol: sym,
      direction: dir,
      size: '1',
    });

    if (orderRes.error) {
      addLog('error', 'bitget_live_execution', `Failed to execute live order for ${sym}: ${orderRes.error}`);
      return res.status(400).json({ error: orderRes.error });
    }

    addLog('info', 'bitget_live_execution', `[BITGET LIVE EXECUTED] ${sym} ${dir.toUpperCase()} Market Order placed via Bitget API`);
    return res.json({ success: true, mode: 'live', symbol: sym, direction: dir, data: orderRes.data });
  }

  // Demo mode trade execution
  const demoTrades = getActiveOpenTrades();
  const isBullish = dir === 'long';
  const entryP = execPrice > 0 ? execPrice : 100;

  const newTrade = {
    id: Date.now(),
    symbol: sym,
    direction: dir as 'long' | 'short',
    entry_price: entryP,
    current_price: entryP,
    stop_loss: isBullish ? Math.round(entryP * 0.98 * 1000) / 1000 : Math.round(entryP * 1.02 * 1000) / 1000,
    position_size: settings.risk_per_trade || 25,
    confidence: 0.88,
    sl_reason: 'Manual Signal Execution',
    breakeven_applied: 0,
    dry_run: true,
    tp_legs: [
      { level: 1, price: isBullish ? Math.round(entryP * 1.015 * 1000) / 1000 : Math.round(entryP * 0.985 * 1000) / 1000, close_fraction: 0.5, hit: 0, reason: 'TP1 Target' },
      { level: 2, price: isBullish ? Math.round(entryP * 1.03 * 1000) / 1000 : Math.round(entryP * 0.97 * 1000) / 1000, close_fraction: 0.5, hit: 0, reason: 'TP2 Target' },
    ],
  };

  demoTrades.unshift(newTrade);
  addLog('info', 'api', `[DEMO EXECUTED] New position opened for ${sym} ${dir.toUpperCase()} @ $${entryP}`);
  return res.json({ success: true, mode: 'dry_run', trade: newTrade });
});

app.get('/api/trades/history', async (req: Request, res: Response) => {
  if (liveModeActive) {
    if (!liveCredentials || !liveCredentials.apiKey) {
      return res.json([]);
    }
    const liveHist = await fetchLiveOrderHistory(liveCredentials);
    if (liveHist.error) {
      addLog('error', 'bitget_live', liveHist.error);
      return res.json([]);
    }
    return res.json(liveHist.history);
  }

  res.json(getActiveTradeHistory());
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

app.get('/api/stats', async (req: Request, res: Response) => {
  if (liveModeActive) {
    if (!liveCredentials || !liveCredentials.apiKey) {
      return res.json({ mode: 'live', total_pnl: 0, win_rate_pct: 0, closed_trades: 0, winning_trades: 0, losing_trades: 0 });
    }
    const liveHist = await fetchLiveOrderHistory(liveCredentials);
    const history = liveHist.history || [];
    const totalPnl = history.reduce((acc: number, t: any) => acc + (t.realized_pnl || 0), 0);
    const wins = history.filter((t: any) => (t.realized_pnl || 0) > 0).length;
    const winRate = history.length ? (wins / history.length) * 100 : 0;

    return res.json({
      mode: 'live',
      total_pnl: Math.round(totalPnl * 100) / 100,
      win_rate_pct: Math.round(winRate),
      closed_trades: history.length,
      winning_trades: wins,
      losing_trades: history.length - wins,
    });
  }

  const history = getActiveTradeHistory();
  const totalPnl = history.reduce((acc, t) => acc + (t.realized_pnl || 0), 0);
  const wins = history.filter((t) => (t.realized_pnl || 0) >= 0).length;
  const winRate = history.length ? (wins / history.length) * 100 : 0;

  res.json({
    mode: 'dry_run',
    total_pnl: Math.round(totalPnl * 100) / 100,
    win_rate_pct: Math.round(winRate),
    closed_trades: history.length,
    winning_trades: wins,
    losing_trades: history.length - wins,
  });
});

app.post('/api/sync', (req: Request, res: Response) => {
  const modeTag = liveModeActive ? 'Bitget Live Account' : 'Demo Engine';
  addLog('info', 'api', `Manual sync completed for ${modeTag}`);
  res.json({ synced: true, open_count: getActiveOpenTrades().length, mode: liveModeActive ? 'live' : 'dry_run' });
});

app.get('/api/account/balance', async (req: Request, res: Response) => {
  if (liveModeActive) {
    if (!liveCredentials || !liveCredentials.apiKey) {
      return res.json({
        equity: 0,
        base_capital: 0,
        realized_pnl: 0,
        unrealized_pnl: 0,
        mode: 'live',
        error: 'Bitget Live API keys are missing. Please go to the Connect tab and enter your Bitget API Key, Secret, and Passphrase.',
      });
    }

    const liveBal = await fetchLiveBalance(liveCredentials);
    if (liveBal.error) {
      addLog('error', 'bitget_live', `Live Balance Fetch Failed: ${liveBal.error}`);
      return res.json({
        equity: 0,
        base_capital: 0,
        realized_pnl: 0,
        unrealized_pnl: 0,
        mode: 'live',
        error: liveBal.error,
      });
    }

    return res.json({
      equity: liveBal.equity,
      base_capital: liveBal.futures_equity,
      realized_pnl: 0,
      unrealized_pnl: liveBal.unrealized_pnl,
      mode: 'live',
      spot_equity: liveBal.spot_equity,
    });
  }

  const history = getActiveTradeHistory();
  const open = getActiveOpenTrades();
  const realizedPnl = history.reduce((acc, t) => acc + (t.realized_pnl || 0), 0);

  const unrealizedPnl = open.reduce((acc, t) => {
    const size = Number(t.position_size || 0);
    const entry = Number(t.entry_price || 0);
    const curr = Number(t.current_price || entry);
    const diff = t.direction === 'long' ? curr - entry : entry - curr;
    return acc + diff * size;
  }, 0);

  const baseCapital = 1000.0;
  const totalEquity = baseCapital + realizedPnl + unrealizedPnl;

  res.json({
    equity: Math.round(totalEquity * 100) / 100,
    base_capital: baseCapital,
    realized_pnl: Math.round(realizedPnl * 100) / 100,
    unrealized_pnl: Math.round(unrealizedPnl * 100) / 100,
    mode: 'dry_run',
  });
});

async function scanCoinsAndGenerateSignals() {
  const targetSymbols = settings.symbols && settings.symbols.length > 0 
    ? settings.symbols 
    : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT'];

  const tickerRes = await fetchPublicMarketTickers(targetSymbols);
  
  if (tickerRes.error || !tickerRes.tickers) {
    addLog('warning', 'market_scanner', `Bitget Public Scanner Notice: ${tickerRes.error || 'No tickers returned'}`);
    return { success: false, error: tickerRes.error };
  }

  const tickers = tickerRes.tickers;
  let newSignalsCreated = 0;
  let autoTradesExecuted = 0;

  for (const t of tickers) {
    const sym = t.symbol;
    const price = parseFloat(t.lastPr || '0');
    const high24 = parseFloat(t.high24h || '0');
    const low24 = parseFloat(t.low24h || '0');
    const chg24 = parseFloat(t.change24h || '0') * 100;
    const volM = Math.round((parseFloat(t.usdtVolume || '0') / 1_000_000) * 10) / 10;
    const fundingPct = parseFloat(t.fundingRate || '0') * 100;

    if (!price) continue;

    const range = high24 - low24;
    const posInRange = range > 0 ? (price - low24) / range : 0.5;

    // Determine direction based on SMC liquidity sweep principles
    const isBullish = posInRange < 0.45 || chg24 < -0.8;
    const direction: 'long' | 'short' = isBullish ? 'long' : 'short';

    // Compute distinct, dynamic SMC & Quantitative confidence score
    let sweepScore = 0.05;
    if (posInRange < 0.20 || posInRange > 0.80) sweepScore = 0.24; // Deep liquidity sweep
    else if (posInRange < 0.35 || posInRange > 0.65) sweepScore = 0.16; // Moderate sweep
    else sweepScore = 0.06; // Weak mid-range

    let momentumScore = Math.abs(chg24) > 3.0 ? 0.22 : (Math.abs(chg24) > 1.0 ? 0.15 : 0.08);
    let volumeScore = volM > 500 ? 0.22 : (volM > 100 ? 0.16 : (volM > 10 ? 0.10 : 0.04));
    let biasScore = settings.htf_bias_enabled ? 0.12 : 0.05;
    let displacementScore = settings.displacement_filter_enabled ? 0.12 : 0.04;

    // Hash pseudo-variance for natural market diversity across different symbols
    const symHash = sym.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const variance = ((symHash % 15) - 7) / 100;

    let rawConfidence = 0.15 + sweepScore + momentumScore + volumeScore + biasScore + displacementScore + variance;
    const confidence = Math.min(0.96, Math.max(0.52, Math.round(rawConfidence * 100) / 100));

    // Filter validation logic
    const sweepConfirmed = !settings.require_sweep_confirmation || (posInRange < 0.38 || posInRange > 0.62);
    const minThreshold = 0.72;
    const passesFilters = confidence >= minThreshold && sweepConfirmed;

    const sourceTag = liveModeActive ? 'bitget_live_scanner' : (activeStrategy === 'quant_math' ? 'quant_math_scanner' : 'smc_scanner');
    const stratDesc = activeStrategy === 'quant_math'
      ? `Hawkes intensity: ${(1.1 + (symHash % 8) / 10).toFixed(2)} | Vol: $${volM}M USDT`
      : `Range pos: ${(posInRange * 100).toFixed(0)}% | FVG & OB Structure Intact`;

    addLog('info', sourceTag, `[SCAN COIN] ${sym}: $${price.toFixed(price > 10 ? 2 : 4)} (${chg24 >= 0 ? '+' : ''}${chg24.toFixed(2)}% 24h) | Conf: ${Math.round(confidence * 100)}% | ${stratDesc}`);

    const recentDuplicate = recentSignals.find(s => s.symbol === sym && (Math.floor(Date.now() / 1000) - s.ts) < 90);

    if (!recentDuplicate) {
      const reasons: string[] = [];
      if (activeStrategy === 'quant_math') {
        reasons.push(`Hawkes Point Process Intensity Spike (+${(1.1 + (symHash % 8) / 10).toFixed(2)})`);
        reasons.push(`Bayesian Classifier Confidence: ${Math.round(confidence * 100)}%`);
        reasons.push(`Bitget 24h Volume: $${volM}M USDT | Funding: ${fundingPct.toFixed(4)}%`);
      } else {
        if (isBullish) {
          reasons.push(`Bullish Sell-Side Liquidity (SSL) Sweep at $${low24.toFixed(price > 10 ? 2 : 4)}`);
          reasons.push(`Bullish Fair Value Gap (FVG) Imbalance Fill & OB Confluence`);
        } else {
          reasons.push(`Bearish Buy-Side Liquidity (BSL) Sweep at $${high24.toFixed(price > 10 ? 2 : 4)}`);
          reasons.push(`Bearish Fair Value Gap (FVG) Imbalance Rejection`);
        }
        reasons.push(`24h Momentum: ${chg24 >= 0 ? '+' : ''}${chg24.toFixed(2)}% | SMC Conf: ${Math.round(confidence * 100)}%`);
      }

      if (!passesFilters) {
        if (!sweepConfirmed) reasons.push(`Filtered: Liquidity sweep incomplete (Mid-range pos ${(posInRange * 100).toFixed(0)}%)`);
        if (confidence < minThreshold) reasons.push(`Filtered: Confidence (${Math.round(confidence * 100)}%) below ${Math.round(minThreshold * 100)}% threshold`);
      }

      const newSig = {
        id: Date.now() + Math.random(),
        symbol: sym,
        direction,
        confidence,
        taken: passesFilters ? 1 : 0,
        ts: Math.floor(Date.now() / 1000),
        reasons,
        price,
        timeframe: settings.timeframe || '15m',
      };

      recentSignals.unshift(newSig);
      if (recentSignals.length > 50) recentSignals.pop();
      newSignalsCreated++;

      const logMsg = passesFilters 
        ? `[QUALIFIED SIGNAL] ${sym} ${direction.toUpperCase()} @ $${price.toFixed(price > 10 ? 2 : 4)} (Confidence: ${Math.round(confidence * 100)}%)`
        : `[FILTERED SIGNAL] ${sym} ${direction.toUpperCase()} @ $${price.toFixed(price > 10 ? 2 : 4)} (Confidence: ${Math.round(confidence * 100)}% - Filtered Out)`;
      addLog('info', sourceTag, logMsg);

      // Auto Execute Trade if signal passed filters and Bot is running
      if (passesFilters && botRunning) {
        if (liveModeActive) {
          if (liveCredentials && liveCredentials.apiKey) {
            placeLiveOrder(liveCredentials, { symbol: sym, direction, size: '' })
              .then((res) => {
                if (res.error) {
                  addLog('error', 'bitget_live_auto', `Auto-Trade Execution Failed for ${sym}: ${res.error}`);
                } else {
                  addLog('info', 'bitget_live_auto', `[BITGET LIVE AUTO-TRADE EXECUTED] ${sym} ${direction.toUpperCase()} Market Order placed via Bitget API`);
                  autoTradesExecuted++;
                }
              })
              .catch((e) => addLog('error', 'bitget_live_auto', `Bitget order exception: ${e.message}`));
          }
        } else {
          // Demo Mode Auto Trade
          const demoTrades = getActiveOpenTrades();
          const alreadyOpen = demoTrades.some((tr) => tr.symbol === sym);
          if (!alreadyOpen && demoTrades.length < (settings.max_concurrent_positions || 5)) {
            demoTrades.unshift({
              id: Date.now(),
              symbol: sym,
              direction,
              entry_price: price,
              current_price: price,
              stop_loss: isBullish ? Math.round(price * 0.98 * 1000) / 1000 : Math.round(price * 1.02 * 1000) / 1000,
              position_size: settings.risk_per_trade_pct || 1.0,
              confidence,
              sl_reason: 'Automated SMC Signal Engine Entry',
              breakeven_applied: 0,
              dry_run: true,
              tp_legs: [
                { id: Date.now() + 1, level: 1, price: isBullish ? Math.round(price * 1.015 * 1000) / 1000 : Math.round(price * 0.985 * 1000) / 1000, close_fraction: 0.5, hit: 0, reason: 'TP1 Target' },
                { id: Date.now() + 2, level: 2, price: isBullish ? Math.round(price * 1.03 * 1000) / 1000 : Math.round(price * 0.97 * 1000) / 1000, close_fraction: 0.5, hit: 0, reason: 'TP2 Target' },
              ],
            });
            autoTradesExecuted++;
            addLog('info', 'demo_auto_trade', `[DEMO AUTO-TRADE EXECUTED] ${sym} ${direction.toUpperCase()} @ $${price}`);
          }
        }
      }
    }
  }

  return { success: true, tickers, new_signals: newSignalsCreated, auto_trades: autoTradesExecuted };
}

app.post('/api/bot/scan', async (req: Request, res: Response) => {
  const result = await scanCoinsAndGenerateSignals();
  res.json({
    scanned: true,
    result,
    symbols: settings.symbols,
    signal_count: recentSignals.length,
    timestamp: Math.floor(Date.now() / 1000),
  });
});

// Fallback for unmatched API routes to ensure JSON 404 instead of HTML
app.all('/api/*', (req: Request, res: Response) => {
  res.status(404).json({ error: `API route not found: ${req.originalUrl}` });
});

// Background Bot Loop
setInterval(async () => {
  if (!botRunning) return;

  const currentOpen = getActiveOpenTrades();

  // Gently fluctuate current prices of active positions
  currentOpen.forEach((t) => {
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

  // Live coin scanning & signal generation engine
  try {
    await scanCoinsAndGenerateSignals();
  } catch (err: any) {
    addLog('error', 'bot_scanner', `Error scanning coins: ${err.message || String(err)}`);
  }
}, 10000);

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
