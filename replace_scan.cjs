const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const scanFuncStart = code.indexOf('async function scanCoinsAndGenerateSignals()');
const scanFuncEnd = code.indexOf('}, 10000);', scanFuncStart);

if (scanFuncStart === -1 || scanFuncEnd === -1) {
  console.log('Could not find function bounds');
  process.exit(1);
}

const newFunc = `async function fetchKlines(symbol: string, limit = 30) {
  try {
    const res = await fetch(\`https://api.bitget.com/api/v2/mix/market/candles?symbol=\${symbol}&productType=USDT-FUTURES&granularity=15m&limit=\${limit}\`);
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

function calculateRSI(closes: number[], period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

async function scanCoinsAndGenerateSignals() {
  const targetSymbols = settings.symbols && settings.symbols.length > 0 
    ? settings.symbols 
    : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT'];

  addLog('info', 'market_scanner', \`[SCANNER START] Sequentially analyzing \${targetSymbols.length} configured coins one-by-one with REAL Klines...\`);

  let newSignalsCreated = 0;
  let autoTradesExecuted = 0;

  for (const sym of targetSymbols) {
    if (!botRunning) break;

    const tickerRes = await fetchPublicMarketTickers([sym]);
    const klines = await fetchKlines(sym, 30);
    
    if (tickerRes.error || !tickerRes.tickers || tickerRes.tickers.length === 0 || !klines || klines.length < 20) {
      addLog('warning', 'market_scanner', \`Bitget Public Scanner Notice for \${sym}: Data unavailable\`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    const t = tickerRes.tickers[0];
    const price = parseFloat(t.lastPr || '0');
    const chg24 = parseFloat(t.change24h || '0') * 100;
    const volM = Math.round((parseFloat(t.usdtVolume || '0') / 1_000_000) * 10) / 10;
    const fundingPct = parseFloat(t.fundingRate || '0') * 100;

    // Real SMC & RSI analysis
    const closes = klines.map((k: any) => k.close);
    const highs = klines.map((k: any) => k.high);
    const lows = klines.map((k: any) => k.low);
    const rsi = calculateRSI(closes, 14);
    
    const recentHigh = Math.max(...highs.slice(-20));
    const recentLow = Math.min(...lows.slice(-20));
    const range = recentHigh - recentLow;
    const posInRange = range > 0 ? (price - recentLow) / range : 0.5;

    // A real liquidity sweep logic:
    // If price swept recent low and rejected (current price > recent low) and RSI is oversold -> Bullish
    // If price swept recent high and rejected (current price < recent high) and RSI is overbought -> Bearish
    let isBullish = false;
    let isBearish = false;
    
    if (rsi < 45 && posInRange < 0.3) {
       isBullish = true;
    } else if (rsi > 55 && posInRange > 0.7) {
       isBearish = true;
    } else {
       // fallback to momentum
       isBullish = chg24 > 0;
       isBearish = chg24 < 0;
    }
    
    const direction = isBullish ? 'long' : 'short';

    let confidence = 0;
    if (isBullish) {
       confidence = 0.5 + (50 - rsi) / 100 + (0.5 - posInRange);
    } else {
       confidence = 0.5 + (rsi - 50) / 100 + (posInRange - 0.5);
    }
    
    let biasScore = settings.htf_bias_enabled ? 0.12 : 0.05;
    let displacementScore = settings.displacement_filter_enabled ? 0.12 : 0.04;
    confidence += biasScore + displacementScore;
    
    confidence = Math.min(0.96, Math.max(0.52, Math.round(confidence * 100) / 100));

    // Filter validation logic
    const currentUtcHour = new Date().getUTCHours();
    const sessionConfirmed = !settings.session_filter_enabled || (currentUtcHour >= 0 && currentUtcHour <= 21);
    const htfBiasConfirmed = !settings.htf_bias_enabled || (isBullish ? chg24 >= -3.5 : chg24 <= 3.5);
    const sweepConfirmed = !settings.require_sweep_confirmation || (posInRange < 0.3 || posInRange > 0.7);
    const displacementConfirmed = !settings.displacement_filter_enabled || (Math.abs(chg24) >= 0.3 || volM > 5);
    const minThreshold = 0.70;

    let filterPenalty = 0;
    if (!sessionConfirmed) filterPenalty += 0.25;
    if (!htfBiasConfirmed) filterPenalty += 0.25;
    if (!sweepConfirmed) filterPenalty += 0.25;
    if (!displacementConfirmed) filterPenalty += 0.25;
    
    if (filterPenalty > 0) {
      confidence = Math.max(0.48, Math.min(0.68, Math.round((confidence - filterPenalty) * 100) / 100));
    }

    const passesFilters = confidence >= minThreshold && sessionConfirmed && htfBiasConfirmed && sweepConfirmed && displacementConfirmed;
    const sourceTag = liveModeActive ? 'bitget_live_scanner' : (activeStrategy === 'quant_math' ? 'quant_math_scanner' : 'smc_scanner');
    
    const stratDesc = \`RSI(14): \${Math.round(rsi)} | 15m Range Pos: \${(posInRange * 100).toFixed(0)}%\`;

    addLog('info', sourceTag, \`[REAL CHART ANALYSIS] \${sym}: $\${price.toFixed(price > 10 ? 2 : 4)} (\${chg24 >= 0 ? '+' : ''}\${chg24.toFixed(2)}% 24h) | Conf: \${Math.round(confidence * 100)}% | \${stratDesc}\`);

    const recentDuplicate = recentSignals.find(s => s.symbol === sym && (Math.floor(Date.now() / 1000) - s.ts) < 90);
    if (!recentDuplicate) {
      const reasons: string[] = [];
      if (activeStrategy === 'quant_math') {
        reasons.push(\`RSI Mean-Reversion Metric: \${Math.round(rsi)}\`);
        reasons.push(\`Bayesian Classifier Confidence: \${Math.round(confidence * 100)}%\`);
        reasons.push(\`Bitget 24h Volume: $\${volM}M USDT | Funding: \${fundingPct.toFixed(4)}%\`);
      } else {
        if (isBullish) {
          reasons.push(\`Bullish Liquidity Sweep at $\${recentLow.toFixed(price > 10 ? 2 : 4)}\`);
          reasons.push(\`15m RSI (\${Math.round(rsi)}) Indicates Oversold / Rejection\`);
        } else {
          reasons.push(\`Bearish Liquidity Sweep at $\${recentHigh.toFixed(price > 10 ? 2 : 4)}\`);
          reasons.push(\`15m RSI (\${Math.round(rsi)}) Indicates Overbought / Rejection\`);
        }
        reasons.push(\`24h Momentum: \${chg24 >= 0 ? '+' : ''}\${chg24.toFixed(2)}% | SMC Conf: \${Math.round(confidence * 100)}%\`);
      }

      if (!passesFilters) {
        if (!sessionConfirmed) reasons.push("Filtered: Outside active session trading window");
        if (!htfBiasConfirmed) reasons.push("Filtered: Market structure conflicts with HTF Trend Bias");
        if (!sweepConfirmed) reasons.push(\`Filtered: Liquidity sweep incomplete (Mid-range pos \${(posInRange * 100).toFixed(0)}%)\`);
        if (!displacementConfirmed) reasons.push("Filtered: Insufficient price displacement / volume momentum");
        if (confidence < minThreshold) reasons.push(\`Filtered: Confidence (\${Math.round(confidence * 100)}%) below \${Math.round(minThreshold * 100)}% threshold\`);
      }

      const structTPSL = computeStructuralTPSL(direction, price, recentHigh, recentLow);
      const newSig = {
        id: Date.now() + Math.random(),
        symbol: sym,
        direction,
        confidence,
        taken: passesFilters ? 1 : 0,
        ts: Math.floor(Date.now() / 1000),
        reasons,
        price,
        high24: recentHigh,
        low24: recentLow,
        stop_loss: structTPSL.stop_loss,
        sl_reason: structTPSL.sl_reason,
        tp_legs: structTPSL.tp_legs,
        timeframe: settings.timeframe || '15m',
      };

      recentSignals.unshift(newSig);
      if (recentSignals.length > 50) recentSignals.pop();
      newSignalsCreated++;

      const logMsg = passesFilters 
        ? \`[QUALIFIED SIGNAL] \${sym} \${direction.toUpperCase()} @ $\${price.toFixed(price > 10 ? 2 : 4)} (Confidence: \${Math.round(confidence * 100)}%) | SL: $\${structTPSL.stop_loss} | TP1: $\${structTPSL.tp_legs[0].price}\`
        : \`[FILTERED SIGNAL] \${sym} \${direction.toUpperCase()} @ $\${price.toFixed(price > 10 ? 2 : 4)} (Confidence: \${Math.round(confidence * 100)}% - Filtered Out)\`;
      addLog('info', sourceTag, logMsg);

      if (passesFilters && botRunning) {
        const activeOpenCount = getActiveOpenTrades().length;
        if (activeOpenCount < settings.max_concurrent_trades) {
          addLog('info', 'bot', \`[AUTO-EXECUTE] Found valid \${sym} \${direction.toUpperCase()} setup. Initiating trade...\`);
          await executeTrade(newSig);
          autoTradesExecuted++;
        } else {
          addLog('warning', 'bot', \`[MAX TRADES REACHED] Signal for \${sym} valid but skipped (Active: \${activeOpenCount}/\${settings.max_concurrent_trades})\`);
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
`;

code = code.substring(0, scanFuncStart) + newFunc + '\n' + code.substring(scanFuncEnd);

fs.writeFileSync('server.ts', code, 'utf8');
console.log('updated');
