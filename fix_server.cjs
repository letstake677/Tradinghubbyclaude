const fs = require('fs');

const missingCode = `
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
        t.sl_reason = \`Breakeven Protection (SL @ Entry: $\${t.entry_price})\`;
        if (t.tp_legs && t.tp_legs[0]) t.tp_legs[0].hit = 1;
        
        addLog(
          'info',
          'demo_breakeven',
          \`[DEMO BREAKEVEN APPLIED] \${t.symbol} \${t.direction.toUpperCase()} TP1 hit ($\${tp1}). Stop Loss automatically transferred to Entry Price ($\${t.entry_price})! Risk is now $0.\`
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
          close_reason: isBe ? \`Breakeven Exit @ Entry ($\${t.entry_price})\` : \`Stop Loss Hit @ $\${sl}\`,
          closed_at: Math.floor(Date.now() / 1000),
          dry_run: true,
        });
        toCloseIndexes.push(idx);
        addLog(
          isBe ? 'info' : 'warning',
          'demo_bot',
          \`[DEMO \${isBe ? 'BREAKEVEN CLOSED' : 'STOP-LOSS HIT'}] \${t.symbol} \${t.direction.toUpperCase()} closed @ $\${sl} (PnL: \${pnl >= 0 ? '+' : ''}$\${pnl.toFixed(2)})\`
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
          close_reason: \`Full Take Profit 3 Target Reached @ $\${tp3}\`,
          closed_at: Math.floor(Date.now() / 1000),
          dry_run: true,
        });
        toCloseIndexes.push(idx);
        addLog(
          'info',
          'demo_bot',
          \`[DEMO FULL TP3 HIT] \${t.symbol} \${t.direction.toUpperCase()} closed @ $\${tp3} (PnL: +$\${pnl.toFixed(2)})\`
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
          if (tp1Hit && !processedLiveBreakevenSet.has(t.symbol) && t.breakeven_applied !== 1) {
            processedLiveBreakevenSet.add(t.symbol);
            t.breakeven_applied = 1;
            t.stop_loss = t.entry_price;
            t.sl_reason = \`Breakeven Protection (Bitget SL @ Entry: $\${t.entry_price})\`;

            addLog(
              'info',
              'bitget_live_breakeven',
              \`[BITGET LIVE BREAKEVEN] \${t.symbol} TP1 reached ($\${tp1}). Transferring Stop Loss to Entry Price ($\${t.entry_price}) on Bitget...\`
            );

            // Send Stop Loss update to Bitget Exchange (cancels old SL plan orders first)
            updateLiveStopLoss(liveCredentials, t.symbol, t.direction, t.entry_price).then((slRes) => {
              if (slRes.error) {
                addLog('error', 'bitget_live_breakeven', \`Failed to transfer SL to Entry on Bitget for \${t.symbol}: \${slRes.error}\`);
              } else {
                addLog('info', 'bitget_live_breakeven', \`[BITGET CONFIRMED] Stop Loss moved to Entry ($\${t.entry_price}) for \${t.symbol} on Bitget exchange.\`);
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
    addLog('error', 'bot_scanner', \`Error scanning coins: \${err.message || String(err)}\`);
  }
}, 10000);
`;

let code = fs.readFileSync('server.ts', 'utf8');

// The file currently has "}, 10000);" which is stray.
// Let's replace the stray "}, 10000);" with the actual missingCode.
code = code.replace('}, 10000);', missingCode);

fs.writeFileSync('server.ts', code, 'utf8');
console.log('Fixed');
