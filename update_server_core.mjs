import fs from 'fs';

let code = fs.readFileSync('server.ts', 'utf8');

// 1. Add normalizeGranularity helper
const normalizeFunc = `
function normalizeGranularity(tf: string): string {
  if (!tf) return '15m';
  const u = tf.trim().toUpperCase();
  if (u === '1M' || u === '1MIN') return '1m';
  if (u === '5M' || u === '5MIN') return '5m';
  if (u === '15M' || u === '15MIN') return '15m';
  if (u === '30M' || u === '30MIN') return '30m';
  if (u === '1H' || u === '1HOUR' || u === '60M') return '1H';
  if (u === '4H' || u === '4HOUR') return '4H';
  if (u === '1D' || u === '1DAY' || u === '24H') return '1D';
  if (u === '1W' || u === '1WEEK') return '1W';
  return tf;
}
`;

if (!code.includes('function normalizeGranularity')) {
  code = code.replace("let settings = {", normalizeFunc + "\nlet settings = {");
}

// 2. Add /api/klines endpoint
const klinesEndpoint = `
app.get('/api/klines', async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase();
  const tf = String(req.query.timeframe || settings.timeframe || '15m');
  const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit || '50'))));
  const gran = normalizeGranularity(tf);

  const klines = await fetchKlines(symbol, gran, limit);
  if (!klines) {
    return res.status(500).json({ error: 'Failed to fetch K-lines from Bitget' });
  }

  res.json({ symbol, timeframe: gran, klines });
});
`;

if (!code.includes("app.get('/api/klines'")) {
  code = code.replace("app.post('/api/settings'", klinesEndpoint + "\napp.post('/api/settings'");
}

// 3. Define executeTrade function and replace /api/trades/execute
const executeTradeFullCode = `
async function executeTrade(sig: any) {
  const currentOpenCount = getActiveOpenTrades().length;
  const maxPositions = settings.max_concurrent_positions || 3;
  if (currentOpenCount >= maxPositions) {
    const errorMsg = \`Maximum limit of \${maxPositions} concurrent positions reached (\${currentOpenCount} currently open). Close an open trade first.\`;
    addLog('warning', 'trade_execution', \`[EXECUTION BLOCKED] \${errorMsg}\`);
    return { error: errorMsg };
  }

  const sym = String(sig.symbol || 'BTCUSDT').replace(/[\\/\\-\\s]/g, '').toUpperCase();
  const dir = String(sig.direction || 'long').toLowerCase() === 'short' ? 'short' : 'long';
  const execPrice = parseFloat(sig.price || '0');
  const entryP = execPrice > 0 ? execPrice : 100;

  const high24 = sig.high24 || 0;
  const low24 = sig.low24 || 0;

  const structTPSL = (sig && sig.stop_loss && sig.tp_legs)
    ? { stop_loss: sig.stop_loss, sl_reason: sig.sl_reason, tp_legs: sig.tp_legs }
    : computeStructuralTPSL(dir, entryP, high24, low24);

  sig.taken = 1;

  if (liveModeActive) {
    if (!liveCredentials || !liveCredentials.apiKey) {
      addLog('error', 'bitget_live_execution', 'Bitget Live API credentials are not configured.');
      return { error: 'Bitget Live API credentials are not configured.' };
    }

    let calculatedSizeStr: string | undefined = undefined;
    try {
      const liveBal = await fetchLiveBalance(liveCredentials);
      const eq = liveBal.success && liveBal.equity ? liveBal.equity : 1000;
      const riskAmountUsd = eq * ((settings.risk_per_trade_pct || 1.0) / 100);
      calculatedSizeStr = calculateRiskBasedSize(sym, entryP, structTPSL.stop_loss, riskAmountUsd);
    } catch (e) {
      console.log('Error calculating manual risk size', e);
    }

    const orderRes = await placeLiveOrder(liveCredentials, {
      symbol: sym,
      direction: dir,
      price: entryP,
      size: calculatedSizeStr,
      leverage: settings.leverage || 5,
      presetStopLossPrice: structTPSL.stop_loss,
      tp_legs: structTPSL.tp_legs,
    });

    if (orderRes.error) {
      addLog('error', 'bitget_live_execution', \`Failed to execute live order for \${sym}: \${orderRes.error}\`);
      return { error: orderRes.error };
    }

    let logSuffix = '';
    if (orderRes.tpError) {
      addLog('warning', 'bitget_live_execution', \`[TP SET FAILED] \${sym}: \${orderRes.tpError}\`);
      logSuffix += ' (TP FAILED)';
    }
    if (orderRes.slError) {
      addLog('warning', 'bitget_live_execution', \`[SL SET FAILED] \${sym}: \${orderRes.slError}\`);
      logSuffix += ' (SL FAILED)';
    }

    addLog('info', 'bitget_live_execution', \`[BITGET LIVE EXECUTED] \${sym} \${dir.toUpperCase()} Market Order placed via Bitget API (Risk: \${settings.risk_per_trade_pct}%, Leverage: \${settings.leverage}x, SL: $\${structTPSL.stop_loss}, TP: $\${structTPSL.tp_legs[0].price})\${logSuffix}\`);
    
    const updatedPos = await fetchLiveOpenPositions(liveCredentials);
    if (updatedPos.positions) liveOpenTrades = updatedPos.positions;

    return { success: true, mode: 'live', symbol: sym, direction: dir, data: orderRes.data };
  }

  // Demo / Dry Run mode
  const demoTrades = getActiveOpenTrades();
  const newTrade = {
    id: Date.now() + Math.random(),
    symbol: sym,
    direction: dir as 'long' | 'short',
    entry_price: entryP,
    current_price: entryP,
    stop_loss: structTPSL.stop_loss,
    position_size: settings.risk_per_trade_pct || 1.0,
    leverage: settings.leverage || 5,
    confidence: sig.confidence || 0.88,
    sl_reason: structTPSL.sl_reason,
    breakeven_applied: 0,
    dry_run: true,
    tp_legs: structTPSL.tp_legs,
  };

  demoTrades.unshift(newTrade);
  addLog('info', 'bot', \`[AUTO-EXECUTED DEMO TRADE] New position opened for \${sym} \${dir.toUpperCase()} @ $\${entryP} (Risk: \${settings.risk_per_trade_pct}%, Leverage: \${settings.leverage}x, SL: $\${structTPSL.stop_loss}, TP1: $\${structTPSL.tp_legs[0].price})\`);
  return { success: true, mode: 'dry_run', trade: newTrade };
}

app.post('/api/trades/execute', async (req: Request, res: Response) => {
  const { symbol, direction, price, signal_id } = req.body || {};
  if (!symbol || !direction) {
    return res.status(400).json({ error: 'Symbol and direction are required' });
  }

  let sig = signal_id ? recentSignals.find((s) => s.id === signal_id || String(s.id) === String(signal_id)) : null;
  if (!sig) {
    sig = { symbol, direction, price, id: signal_id };
  }

  const result = await executeTrade(sig);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  res.json(result);
});
`;

// Replace app.post('/api/trades/execute'...) up to return res.json({ success: true, mode: 'dry_run', trade: newTrade }); });
const execStart = code.indexOf("app.post('/api/trades/execute'");
const execEnd = code.indexOf("app.get('/api/trades/history'", execStart);

if (execStart !== -1 && execEnd !== -1) {
  code = code.substring(0, execStart) + executeTradeFullCode + "\n\n" + code.substring(execEnd);
}

// 4. Update fetchKlines implementation to use normalizeGranularity
const fetchKlinesCode = `
async function fetchKlines(symbol: string, granularity: string, limit = 30) {
  try {
    const gran = normalizeGranularity(granularity);
    const res = await fetch(\`https://api.bitget.com/api/v2/mix/market/candles?symbol=\${symbol}&productType=USDT-FUTURES&granularity=\${gran}&limit=\${limit}\`);
    const json = await res.json();
    if (json.code === '00000' && Array.isArray(json.data)) {
      const sorted = json.data.map((c: string[]) => ({
        timestamp: parseInt(c[0]),
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        vol: parseFloat(c[6])
      })).sort((a, b) => a.timestamp - b.timestamp);
      return sorted;
    }
    return null;
  } catch(e) {
    return null;
  }
}
`;

const fkStart = code.indexOf("async function fetchKlines");
const fkEnd = code.indexOf("function calculateRSI", fkStart);
if (fkStart !== -1 && fkEnd !== -1) {
  code = code.substring(0, fkStart) + fetchKlinesCode + "\n" + code.substring(fkEnd);
}

fs.writeFileSync('server.ts', code, 'utf8');
console.log('Updated server.ts with executeTrade and klines endpoint');
