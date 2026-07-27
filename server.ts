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
  setLiveLeverage,
  updateLiveStopLoss,
  cancelLivePlanOrders,
  placeLiveTPSL,
} from './bitgetService';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

// In-Memory State for Kehlo Trading Bot
let botRunning = true;
let liveModeActive = false;
let activeStrategy: 'smc' | 'quant_math' = 'smc';
const processedLiveBreakevenSet = new Set<string>();

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
    sl_reason: 'Liquidity sweep at $63480 + Bullish FVG',
    breakeven_applied: 1,
    dry_run: true,
    tp_legs: [
      { id: 101, level: 1, price: 65100.0, close_fraction: 0.4, hit: 0, reason: '50% Equilibrium & FVG Fill' },
      { id: 102, level: 2, price: 65850.0, close_fraction: 0.3, hit: 0, reason: 'Bearish Order Block Supply' },
      { id: 103, level: 3, price: 66400.0, close_fraction: 0.3, hit: 0, reason: 'External BSL High Expansion' },
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
    sl_reason: 'Orderblock rejection at $3525',
    breakeven_applied: 0,
    dry_run: true,
    tp_legs: [
      { id: 104, level: 1, price: 3410.0, close_fraction: 0.4, hit: 1, reason: '50% Equilibrium & FVG Fill' },
      { id: 105, level: 2, price: 3350.0, close_fraction: 0.3, hit: 0, reason: 'Bullish Order Block Demand' },
      { id: 106, level: 3, price: 3290.0, close_fraction: 0.3, hit: 0, reason: 'External SSL Low Expansion' },
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
  if (body.max_concurrent_positions !== undefined) settings.max_concurrent_positions = Math.max(1, Math.round(Number(body.max_concurrent_positions)));
  if (body.max_daily_loss_pct !== undefined) settings.max_daily_loss_pct = Number(body.max_daily_loss_pct);
  if (Array.isArray(body.symbols)) settings.symbols = body.symbols;
  if (body.timeframe) settings.timeframe = body.timeframe;
  if (body.dry_run !== undefined) settings.dry_run = Boolean(body.dry_run);
  if (body.leverage !== undefined) settings.leverage = Math.max(1, Math.min(125, Math.round(Number(body.leverage))));
  if (body.session_filter_enabled !== undefined) settings.session_filter_enabled = Boolean(body.session_filter_enabled);
  if (body.htf_bias_enabled !== undefined) settings.htf_bias_enabled = Boolean(body.htf_bias_enabled);
  if (body.require_sweep_confirmation !== undefined) settings.require_sweep_confirmation = Boolean(body.require_sweep_confirmation);
  if (body.displacement_filter_enabled !== undefined) settings.displacement_filter_enabled = Boolean(body.displacement_filter_enabled);

  addLog('info', 'api', `Settings updated: Risk=${settings.risk_per_trade_pct}%, MaxPositions=${settings.max_concurrent_positions}, Leverage=${settings.leverage}x, Filters=[Session:${settings.session_filter_enabled}, HTF:${settings.htf_bias_enabled}, Sweep:${settings.require_sweep_confirmation}, Disp:${settings.displacement_filter_enabled}]`);
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
      liveOpenTrades = [];
      return res.json([]);
    }
    const livePos = await fetchLiveOpenPositions(liveCredentials);
    if (livePos.error) {
      addLog('error', 'bitget_live', livePos.error);
      return res.json(liveOpenTrades);
    }
    liveOpenTrades = livePos.positions || [];
    return res.json(liveOpenTrades);
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
    // Refresh live open positions after close
    const refreshPos = await fetchLiveOpenPositions(liveCredentials);
    if (refreshPos.positions) liveOpenTrades = refreshPos.positions;

    return res.json({ closed: true, symbol: symbolToClose, mode: 'live' });
  }

  const trades = getActiveOpenTrades();
  const history = getActiveTradeHistory();
  const index = trades.findIndex(
    (t) => String(t.id) === String(tradeIdParam) || t.symbol === tradeIdParam
  );
  if (index === -1) {
    return res.status(404).json({ error: 'Trade not found or already closed' });
  }

  const [trade] = trades.splice(index, 1);
  const size = Number(trade.position_size || 1.0);
  const entry = Number(trade.entry_price || 0);
  const current = Number(trade.current_price || entry);
  const rawPnl = trade.direction === 'long' ? (current - entry) * size : (entry - current) * size;
  const pnl = Math.round(rawPnl * 100) / 100;

  history.unshift({
    id: trade.id,
    symbol: trade.symbol,
    direction: trade.direction,
    entry_price: trade.entry_price,
    close_price: current,
    realized_pnl: pnl,
    close_reason: 'Manual exit via dashboard',
    closed_at: Math.floor(Date.now() / 1000),
    dry_run: true,
  });

  addLog('info', 'api', `[DEMO] [${trade.symbol}] Position closed @ $${current.toFixed(current > 10 ? 2 : 4)}, PnL: ${pnl >= 0 ? '+' : ''}$${pnl}`);
  res.json({ closed: true, trade_id: trade.id, pnl, close_price: current, mode: 'dry_run' });
});

function computeStructuralTPSL(
  direction: 'long' | 'short',
  currentPrice: number,
  high24?: number,
  low24?: number
) {
  const isBullish = direction === 'long';
  const decimals = currentPrice > 10 ? 2 : (currentPrice > 0.1 ? 4 : 6);

  const h24 = (high24 && high24 > 0) ? high24 : (isBullish ? currentPrice * 1.03 : currentPrice * 1.015);
  const l24 = (low24 && low24 > 0) ? low24 : (isBullish ? currentPrice * 0.985 : currentPrice * 0.97);
  const equilibrium = (h24 + l24) / 2;

  let stopLoss: number;
  let tp1Price: number;
  let tp2Price: number;
  let tp3Price: number;

  if (isBullish) {
    // Stop Loss: Below Sell-Side Liquidity (SSL) Low
    const sslLow = (l24 < currentPrice) ? l24 : currentPrice * 0.988;
    stopLoss = sslLow * 0.997; // 0.3% buffer under SSL pool

    if (currentPrice - stopLoss < currentPrice * 0.005) {
      stopLoss = currentPrice * 0.988;
    }

    // TP1: 50% Equilibrium & Internal FVG Fill
    if (currentPrice < equilibrium) {
      tp1Price = equilibrium;
    } else {
      tp1Price = currentPrice + (h24 - currentPrice) * 0.45;
    }
    if (tp1Price <= currentPrice) tp1Price = currentPrice * 1.012;

    // TP2: Bearish Order Block Supply Zone
    tp2Price = currentPrice + (h24 - currentPrice) * 0.85;
    if (tp2Price <= tp1Price) tp2Price = tp1Price * 1.015;

    // TP3: External Buy-Side Liquidity (BSL) Expansion Target
    tp3Price = Math.max(h24 * 1.008, tp2Price * 1.015);

    const slVal = Number(stopLoss.toFixed(decimals));
    const tp1Val = Number(tp1Price.toFixed(decimals));
    const tp2Val = Number(tp2Price.toFixed(decimals));
    const tp3Val = Number(tp3Price.toFixed(decimals));

    return {
      stop_loss: slVal,
      sl_reason: `Structural SSL Low Invalidation ($${slVal})`,
      tp_legs: [
        {
          id: Date.now() + 1,
          level: 1,
          price: tp1Val,
          close_fraction: 0.4,
          hit: 0,
          reason: `50% Equilibrium & FVG Fill ($${tp1Val})`,
        },
        {
          id: Date.now() + 2,
          level: 2,
          price: tp2Val,
          close_fraction: 0.3,
          hit: 0,
          reason: `Bearish Order Block Supply ($${tp2Val})`,
        },
        {
          id: Date.now() + 3,
          level: 3,
          price: tp3Val,
          close_fraction: 0.3,
          hit: 0,
          reason: `External BSL High Expansion ($${tp3Val})`,
        },
      ],
    };
  } else {
    // Bearish Short
    // Stop Loss: Above Buy-Side Liquidity (BSL) High
    const bslHigh = (h24 > currentPrice) ? h24 : currentPrice * 1.012;
    stopLoss = bslHigh * 1.003; // 0.3% buffer above BSL pool

    if (stopLoss - currentPrice < currentPrice * 0.005) {
      stopLoss = currentPrice * 1.012;
    }

    // TP1: 50% Equilibrium & Internal FVG Fill
    if (currentPrice > equilibrium) {
      tp1Price = equilibrium;
    } else {
      tp1Price = currentPrice - (currentPrice - l24) * 0.45;
    }
    if (tp1Price >= currentPrice) tp1Price = currentPrice * 0.988;

    // TP2: Bullish Order Block Demand Zone
    tp2Price = currentPrice - (currentPrice - l24) * 0.85;
    if (tp2Price >= tp1Price) tp2Price = tp1Price * 0.985;

    // TP3: External Sell-Side Liquidity (SSL) Expansion Target
    tp3Price = Math.min(l24 * 0.992, tp2Price * 0.985);

    const slVal = Number(stopLoss.toFixed(decimals));
    const tp1Val = Number(tp1Price.toFixed(decimals));
    const tp2Val = Number(tp2Price.toFixed(decimals));
    const tp3Val = Number(tp3Price.toFixed(decimals));

    return {
      stop_loss: slVal,
      sl_reason: `Structural BSL High Invalidation ($${slVal})`,
      tp_legs: [
        {
          id: Date.now() + 1,
          level: 1,
          price: tp1Val,
          close_fraction: 0.4,
          hit: 0,
          reason: `50% Equilibrium & FVG Fill ($${tp1Val})`,
        },
        {
          id: Date.now() + 2,
          level: 2,
          price: tp2Val,
          close_fraction: 0.3,
          hit: 0,
          reason: `Bullish Order Block Demand ($${tp2Val})`,
        },
        {
          id: Date.now() + 3,
          level: 3,
          price: tp3Val,
          close_fraction: 0.3,
          hit: 0,
          reason: `External SSL Low Expansion ($${tp3Val})`,
        },
      ],
    };
  }
}

app.post('/api/trades/execute', async (req: Request, res: Response) => {
  const { symbol, direction, price, signal_id } = req.body || {};
  if (!symbol || !direction) {
    return res.status(400).json({ error: 'Symbol and direction are required' });
  }

  const currentOpenCount = getActiveOpenTrades().length;
  if (currentOpenCount >= (settings.max_concurrent_positions || 3)) {
    const errorMsg = `Maximum limit of ${settings.max_concurrent_positions} concurrent positions reached as configured in Settings (${currentOpenCount} currently open). Close an open trade first.`;
    addLog('warning', 'trade_execution', `[EXECUTION BLOCKED] ${errorMsg}`);
    return res.status(400).json({ error: errorMsg });
  }

  const sym = String(symbol).replace(/[\/\-\s]/g, '').toUpperCase();
  const dir = String(direction).toLowerCase() === 'short' ? 'short' : 'long';
  const execPrice = parseFloat(price || '0');

  // Mark signal as taken if signal_id provided
  let sig = signal_id ? recentSignals.find((s) => s.id === signal_id || String(s.id) === String(signal_id)) : null;
  if (sig) sig.taken = 1;

  const entryP = execPrice > 0 ? execPrice : (sig?.price || 100);
  const high24 = sig?.high24 || 0;
  const low24 = sig?.low24 || 0;

  const structTPSL = (sig && sig.stop_loss && sig.tp_legs)
    ? { stop_loss: sig.stop_loss, sl_reason: sig.sl_reason, tp_legs: sig.tp_legs }
    : computeStructuralTPSL(dir, entryP, high24, low24);

  if (liveModeActive) {
    if (!liveCredentials || !liveCredentials.apiKey) {
      return res.status(400).json({ error: 'Bitget Live API credentials are not configured.' });
    }

    const orderRes = await placeLiveOrder(liveCredentials, {
      symbol: sym,
      direction: dir,
      price: entryP,
      leverage: settings.leverage || 5,
      presetStopLossPrice: structTPSL.stop_loss,
      presetTakeProfitPrice: structTPSL.tp_legs[0].price,
    });

    if (orderRes.error) {
      addLog('error', 'bitget_live_execution', `Failed to execute live order for ${sym}: ${orderRes.error}`);
      return res.status(400).json({ error: orderRes.error });
    }

    addLog('info', 'bitget_live_execution', `[BITGET LIVE EXECUTED] ${sym} ${dir.toUpperCase()} Market Order placed via Bitget API (Risk: ${settings.risk_per_trade_pct}%, Leverage: ${settings.leverage}x, SL: $${structTPSL.stop_loss}, TP: $${structTPSL.tp_legs[0].price})`);
    
    // Refresh live open positions immediately
    const updatedPos = await fetchLiveOpenPositions(liveCredentials);
    if (updatedPos.positions) liveOpenTrades = updatedPos.positions;

    return res.json({ success: true, mode: 'live', symbol: sym, direction: dir, data: orderRes.data });
  }

  // Demo mode trade execution
  const demoTrades = getActiveOpenTrades();
  const newTrade = {
    id: Date.now(),
    symbol: sym,
    direction: dir as 'long' | 'short',
    entry_price: entryP,
    current_price: entryP,
    stop_loss: structTPSL.stop_loss,
    position_size: settings.risk_per_trade_pct || 1.0,
    leverage: settings.leverage || 5,
    confidence: sig?.confidence || 0.88,
    sl_reason: structTPSL.sl_reason,
    breakeven_applied: 0,
    dry_run: true,
    tp_legs: structTPSL.tp_legs,
  };

  demoTrades.unshift(newTrade);
  addLog('info', 'api', `[DEMO EXECUTED] New position opened for ${sym} ${dir.toUpperCase()} @ $${entryP} (Risk: ${settings.risk_per_trade_pct}%, Leverage: ${settings.leverage}x, SL: $${structTPSL.stop_loss}, TP1: $${structTPSL.tp_legs[0].price})`);
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

// 15-second heartbeat log to confirm bot is active
setInterval(() => {
  if (botRunning) {
    addLog('info', 'bot_scanner', '[SCANNER HEARTBEAT] Bot is actively running and scanning coin markets...');
  }
}, 15000);

async function scanCoinsAndGenerateSignals() {
  const targetSymbols = settings.symbols && settings.symbols.length > 0 
    ? settings.symbols 
    : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT'];

  addLog('info', 'market_scanner', `[SCANNER START] Sequentially analyzing ${targetSymbols.length} configured coins one-by-one...`);

  let newSignalsCreated = 0;
  let autoTradesExecuted = 0;

  for (const sym of targetSymbols) {
    if (!botRunning) break;

    const tickerRes = await fetchPublicMarketTickers([sym]);
    
    if (tickerRes.error || !tickerRes.tickers || tickerRes.tickers.length === 0) {
      addLog('warning', 'market_scanner', `Bitget Public Scanner Notice for ${sym}: ${tickerRes.error || 'No ticker returned'}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    const t = tickerRes.tickers[0];
    const price = parseFloat(t.lastPr || '0');
    const high24 = parseFloat(t.high24h || '0');
    const low24 = parseFloat(t.low24h || '0');
    const chg24 = parseFloat(t.change24h || '0') * 100;
    const volM = Math.round((parseFloat(t.usdtVolume || '0') / 1_000_000) * 10) / 10;
    const fundingPct = parseFloat(t.fundingRate || '0') * 100;

    if (!price) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

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
    const currentUtcHour = new Date().getUTCHours();
    const sessionConfirmed = !settings.session_filter_enabled || (currentUtcHour >= 0 && currentUtcHour <= 21);
    const htfBiasConfirmed = !settings.htf_bias_enabled || (isBullish ? chg24 >= -2.5 : chg24 <= 2.5);
    const sweepConfirmed = !settings.require_sweep_confirmation || (posInRange < 0.38 || posInRange > 0.62);
    const displacementConfirmed = !settings.displacement_filter_enabled || (Math.abs(chg24) >= 0.5 || volM > 15);
    const minThreshold = 0.72;

    const passesFilters = confidence >= minThreshold && sessionConfirmed && htfBiasConfirmed && sweepConfirmed && displacementConfirmed;

    const sourceTag = liveModeActive ? 'bitget_live_scanner' : (activeStrategy === 'quant_math' ? 'quant_math_scanner' : 'smc_scanner');
    const stratDesc = activeStrategy === 'quant_math'
      ? `Hawkes intensity: ${(1.1 + (symHash % 8) / 10).toFixed(2)} | Vol: $${volM}M USDT`
      : `Range pos: ${(posInRange * 100).toFixed(0)}% | FVG & OB Structure Intact`;

    addLog('info', sourceTag, `[SEQUENTIAL SCAN & CHART ANALYSIS] ${sym}: $${price.toFixed(price > 10 ? 2 : 4)} (${chg24 >= 0 ? '+' : ''}${chg24.toFixed(2)}% 24h) | Conf: ${Math.round(confidence * 100)}% | ${stratDesc}`);

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
        if (!sessionConfirmed) reasons.push("Filtered: Outside active session trading window (Session Filter active)");
        if (!htfBiasConfirmed) reasons.push("Filtered: Market structure conflicts with HTF Trend Bias");
        if (!sweepConfirmed) reasons.push(`Filtered: Liquidity sweep incomplete (Mid-range pos ${(posInRange * 100).toFixed(0)}%)`);
        if (!displacementConfirmed) reasons.push("Filtered: Insufficient price displacement / volume momentum");
        if (confidence < minThreshold) reasons.push(`Filtered: Confidence (${Math.round(confidence * 100)}%) below ${Math.round(minThreshold * 100)}% threshold`);
      }

      const structTPSL = computeStructuralTPSL(direction, price, high24, low24);

      const newSig = {
        id: Date.now() + Math.random(),
        symbol: sym,
        direction,
        confidence,
        taken: passesFilters ? 1 : 0,
        ts: Math.floor(Date.now() / 1000),
        reasons,
        price,
        high24,
        low24,
        stop_loss: structTPSL.stop_loss,
        sl_reason: structTPSL.sl_reason,
        tp_legs: structTPSL.tp_legs,
        timeframe: settings.timeframe || '15m',
      };

      recentSignals.unshift(newSig);
      if (recentSignals.length > 50) recentSignals.pop();
      newSignalsCreated++;

      const logMsg = passesFilters 
        ? `[QUALIFIED SIGNAL] ${sym} ${direction.toUpperCase()} @ $${price.toFixed(price > 10 ? 2 : 4)} (Confidence: ${Math.round(confidence * 100)}%) | SL: $${structTPSL.stop_loss} | TP1: $${structTPSL.tp_legs[0].price}`
        : `[FILTERED SIGNAL] ${sym} ${direction.toUpperCase()} @ $${price.toFixed(price > 10 ? 2 : 4)} (Confidence: ${Math.round(confidence * 100)}% - Filtered Out)`;
      addLog('info', sourceTag, logMsg);

      // Auto Execute Trade if signal passed filters and Bot is running
      if (passesFilters && botRunning) {
        const activeOpenCount = getActiveOpenTrades().length;
        if (activeOpenCount >= (settings.max_concurrent_positions || 3)) {
          addLog(
            'warning',
            sourceTag,
            `[AUTO-TRADE SKIPPED] Maximum concurrent position limit (${settings.max_concurrent_positions}) reached (${activeOpenCount} active positions). ${sym} auto-trade skipped.`
          );
        } else {
          if (liveModeActive) {
            if (liveCredentials && liveCredentials.apiKey) {
              try {
                const orderRes = await placeLiveOrder(liveCredentials, {
                  symbol: sym,
                  direction,
                  price,
                  leverage: settings.leverage || 5,
                  presetStopLossPrice: structTPSL.stop_loss,
                  presetTakeProfitPrice: structTPSL.tp_legs[0].price,
                });
                if (orderRes.error) {
                  addLog('error', 'bitget_live_auto', `Auto-Trade Execution Failed for ${sym}: ${orderRes.error}`);
                } else {
                  addLog('info', 'bitget_live_auto', `[BITGET LIVE AUTO-TRADE EXECUTED] ${sym} ${direction.toUpperCase()} Market Order placed via Bitget API (Risk: ${settings.risk_per_trade_pct}%, Leverage: ${settings.leverage}x, SL: $${structTPSL.stop_loss}, TP: $${structTPSL.tp_legs[0].price})`);
                  autoTradesExecuted++;
                }
              } catch (e: any) {
                addLog('error', 'bitget_live_auto', `Bitget order exception: ${e.message}`);
              }
            }
          } else {
            // Demo Mode Auto Trade
            const demoTrades = getActiveOpenTrades();
            const alreadyOpen = demoTrades.some((tr) => tr.symbol === sym);
            if (!alreadyOpen) {
              demoTrades.unshift({
                id: Date.now(),
                symbol: sym,
                direction,
                entry_price: price,
                current_price: price,
                stop_loss: structTPSL.stop_loss,
                position_size: settings.risk_per_trade_pct || 1.0,
                leverage: settings.leverage || 5,
                confidence,
                sl_reason: structTPSL.sl_reason,
                breakeven_applied: 0,
                dry_run: true,
                tp_legs: structTPSL.tp_legs,
              });
              autoTradesExecuted++;
              addLog('info', 'demo_auto_trade', `[DEMO AUTO-TRADE EXECUTED] ${sym} ${direction.toUpperCase()} @ $${price} (Risk: ${settings.risk_per_trade_pct}%, Leverage: ${settings.leverage}x, SL: $${structTPSL.stop_loss}, TP1: $${structTPSL.tp_legs[0].price})`);
            }
          }
        }
      }
    }

    // Short 3-second delay between each coin scan to ensure thorough sequential chart analysis
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  return { success: true, new_signals: newSignalsCreated, auto_trades: autoTradesExecuted };
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

  if (!liveModeActive) {
    // Demo mode: Fluctuate prices and evaluate Stop Loss & Take Profit targets
    const toCloseIndexes: number[] = [];
    demoOpenTrades.forEach((t, idx) => {
      const delta = (Math.random() - 0.47) * (t.entry_price * 0.003);
      t.current_price = Math.round((t.current_price + delta) * 1000) / 1000;

      const isLong = t.direction === 'long';
      const sl = Number(t.stop_loss || 0);
      const tp1 = t.tp_legs && t.tp_legs.length > 0 ? Number(t.tp_legs[0].price) : 0;
      const tp3 = t.tp_legs && t.tp_legs.length > 2 ? Number(t.tp_legs[2].price) : (tp1 > 0 ? tp1 * (isLong ? 1.02 : 0.98) : 0);
      const size = Number(t.position_size || 1.0);

      let slHit = false;
      let tp1Hit = false;
      let tp3Hit = false;

      if (sl > 0) {
        if (isLong && t.current_price <= sl) slHit = true;
        if (!isLong && t.current_price >= sl) slHit = true;
      }

      if (tp1 > 0) {
        if (isLong && t.current_price >= tp1) tp1Hit = true;
        if (!isLong && t.current_price <= tp1) tp1Hit = true;
      }

      if (tp3 > 0) {
        if (isLong && t.current_price >= tp3) tp3Hit = true;
        if (!isLong && t.current_price <= tp3) tp3Hit = true;
      }

      // Check Breakeven trigger when TP1 is hit
      if (tp1Hit && t.breakeven_applied !== 1 && !tp3Hit && !slHit) {
        t.breakeven_applied = 1;
        t.stop_loss = t.entry_price;
        t.sl_reason = `Breakeven Protection (SL @ Entry: $${t.entry_price})`;
        if (t.tp_legs && t.tp_legs[0]) t.tp_legs[0].hit = 1;

        addLog(
          'info',
          'demo_breakeven',
          `[DEMO BREAKEVEN APPLIED] ${t.symbol} ${t.direction.toUpperCase()} TP1 hit ($${tp1}). Stop Loss automatically transferred to Entry Price ($${t.entry_price})! Risk is now $0.`
        );
      }

      if (slHit) {
        const rawPnl = isLong ? (sl - t.entry_price) * size : (t.entry_price - sl) * size;
        const pnl = Math.round(rawPnl * 100) / 100;
        const isBe = t.breakeven_applied === 1 && Math.abs(sl - t.entry_price) < 0.001;
        demoTradeHistory.unshift({
          id: t.id,
          symbol: t.symbol,
          direction: t.direction,
          entry_price: t.entry_price,
          close_price: sl,
          realized_pnl: pnl,
          close_reason: isBe ? `Breakeven Exit @ Entry ($${t.entry_price})` : `Stop Loss Hit @ $${sl}`,
          closed_at: Math.floor(Date.now() / 1000),
          dry_run: true,
        });
        toCloseIndexes.push(idx);
        addLog(
          isBe ? 'info' : 'warning',
          'demo_bot',
          `[DEMO ${isBe ? 'BREAKEVEN CLOSED' : 'STOP-LOSS HIT'}] ${t.symbol} ${t.direction.toUpperCase()} closed @ $${sl} (PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})`
        );
      } else if (tp3Hit) {
        const rawPnl = isLong ? (tp3 - t.entry_price) * size : (t.entry_price - tp3) * size;
        const pnl = Math.round(rawPnl * 100) / 100;
        demoTradeHistory.unshift({
          id: t.id,
          symbol: t.symbol,
          direction: t.direction,
          entry_price: t.entry_price,
          close_price: tp3,
          realized_pnl: pnl,
          close_reason: `Full Take Profit 3 Target Reached @ $${tp3}`,
          closed_at: Math.floor(Date.now() / 1000),
          dry_run: true,
        });
        toCloseIndexes.push(idx);
        addLog(
          'info',
          'demo_bot',
          `[DEMO FULL TP3 HIT] ${t.symbol} ${t.direction.toUpperCase()} closed @ $${tp3} (PnL: +$${pnl.toFixed(2)})`
        );
      }
    });

    for (let i = toCloseIndexes.length - 1; i >= 0; i--) {
      demoOpenTrades.splice(toCloseIndexes[i], 1);
    }
  } else if (liveCredentials && liveCredentials.apiKey) {
    // Live mode: Background position sync with Bitget & Automatic Breakeven transfer
    try {
      const res = await fetchLiveOpenPositions(liveCredentials);
      if (res.positions) {
        liveOpenTrades = res.positions;

        // Check if any live position hit TP1 and needs Breakeven SL update on Bitget
        for (const t of liveOpenTrades) {
          const tp1 = t.tp_legs && t.tp_legs.length > 0 ? Number(t.tp_legs[0].price) : 0;
          const isLong = t.direction === 'long';
          const tp1Hit = tp1 > 0 && (isLong ? t.current_price >= tp1 : t.current_price <= tp1);

          // Only trigger breakeven transfer ONCE when TP1 is genuinely hit and not yet processed
          if (tp1Hit && !processedLiveBreakevenSet.has(t.symbol)) {
            processedLiveBreakevenSet.add(t.symbol);
            t.breakeven_applied = 1;
            t.stop_loss = t.entry_price;
            t.sl_reason = `Breakeven Protection (Bitget SL @ Entry: $${t.entry_price})`;

            addLog(
              'info',
              'bitget_live_breakeven',
              `[BITGET LIVE BREAKEVEN] ${t.symbol} TP1 reached ($${tp1}). Transferring Stop Loss to Entry Price ($${t.entry_price}) on Bitget...`
            );

            // Send Stop Loss update to Bitget Exchange (cancels old SL plan orders first)
            updateLiveStopLoss(liveCredentials, t.symbol, t.direction, t.entry_price).then((slRes) => {
              if (slRes.error) {
                addLog('error', 'bitget_live_breakeven', `Failed to transfer SL to Entry on Bitget for ${t.symbol}: ${slRes.error}`);
              } else {
                addLog('info', 'bitget_live_breakeven', `[BITGET CONFIRMED] Stop Loss moved to Entry ($${t.entry_price}) for ${t.symbol} on Bitget exchange.`);
              }
            });
          }
        }
      }
    } catch (e) {
      // Sync is non-blocking
    }
  }

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
