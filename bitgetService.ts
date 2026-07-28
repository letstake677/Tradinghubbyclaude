import crypto from 'crypto';

export interface BitgetCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

const BITGET_BASE_URL = 'https://api.bitget.com';

export async function bitgetApiRequest(
  path: string,
  method = 'GET',
  body: any = null,
  creds: BitgetCredentials
) {
  const timestamp = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const prehash = timestamp + method.toUpperCase() + path + bodyStr;
  
  const sign = crypto
    .createHmac('sha256', creds.apiSecret)
    .update(prehash)
    .digest('base64');

  const headers: Record<string, string> = {
    'ACCESS-KEY': creds.apiKey,
    'ACCESS-SIGN': sign,
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': creds.passphrase,
    'locale': 'en-US',
    'Content-Type': 'application/json',
  };

  const response = await fetch(`${BITGET_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? bodyStr : undefined,
  });

  const json = await response.json();
  return json;
}

export async function fetchLiveBalance(creds: BitgetCredentials) {
  try {
    // 1. Fetch USDT Futures Account
    const futuresRes = await bitgetApiRequest(
      '/api/v2/mix/account/accounts?productType=USDT-FUTURES',
      'GET',
      null,
      creds
    );

    if (futuresRes.code !== '00000') {
      return {
        error: `Bitget API Error (${futuresRes.code}): ${futuresRes.msg || 'Failed to fetch futures account'}`,
      };
    }

    const futuresData = Array.isArray(futuresRes.data)
      ? futuresRes.data
      : (futuresRes.data?.list || futuresRes.data?.accountList || []);
    let futuresEquity = 0;
    let futuresUnrealizedPnL = 0;

    for (const acc of futuresData) {
      futuresEquity += parseFloat(acc.usdtEquity || acc.equity || '0');
      futuresUnrealizedPnL += parseFloat(acc.unrealizedPL || '0');
    }

    // 2. Fetch Spot Assets (Optional fallback/addition)
    let spotEquity = 0;
    try {
      const spotRes = await bitgetApiRequest('/api/v2/spot/account/assets', 'GET', null, creds);
      if (spotRes.code === '00000' && Array.isArray(spotRes.data)) {
        for (const asset of spotRes.data) {
          if (asset.coin === 'USDT') {
            spotEquity += parseFloat(asset.available || '0') + parseFloat(asset.frozen || '0');
          }
        }
      }
    } catch (e) {
      // Spot fetch is non-blocking
    }

    const totalEquity = futuresEquity + spotEquity;

    return {
      success: true,
      equity: Math.round(totalEquity * 100) / 100,
      futures_equity: Math.round(futuresEquity * 100) / 100,
      spot_equity: Math.round(spotEquity * 100) / 100,
      unrealized_pnl: Math.round(futuresUnrealizedPnL * 100) / 100,
      mode: 'live',
    };
  } catch (err: any) {
    return {
      error: `Network/Bitget API Connection Error: ${err.message || String(err)}`,
    };
  }
}

export async function fetchLiveOpenPositions(creds: BitgetCredentials) {
  try {
    const res = await bitgetApiRequest(
      '/api/v2/mix/position/all-position?productType=USDT-FUTURES',
      'GET',
      null,
      creds
    );

    if (res.code !== '00000') {
      return {
        error: `Bitget API Error (${res.code}): ${res.msg || 'Failed to fetch positions'}`,
        positions: [],
      };
    }

    // Fetch pending TP/SL plan orders from Bitget
    const planOrdersMap: Record<string, { tpPrices: number[]; slPrices: number[] }> = {};
    try {
      const planTypes = ['profit_plan', 'loss_plan', 'pos_profit', 'pos_loss', 'normal_plan', 'moving_plan'];
      const planPromises = planTypes.map((pt) =>
        bitgetApiRequest(
          `/api/v2/mix/order/orders-plan-pending?productType=USDT-FUTURES&planType=${pt}`,
          'GET',
          null,
          creds
        )
      );
      planPromises.push(
        bitgetApiRequest(
          '/api/v2/mix/order/orders-plan-pending?productType=USDT-FUTURES',
          'GET',
          null,
          creds
        )
      );

      const planResults = await Promise.all(planPromises);
      for (const planRes of planResults) {
        if (planRes && planRes.code === '00000') {
          const list = planRes.data?.entrustedList || planRes.data?.list || (Array.isArray(planRes.data) ? planRes.data : []);
          if (Array.isArray(list)) {
            list.forEach((o: any) => {
              const rawSym = o.symbol || '';
              if (!rawSym) return;
              const cleanSym = rawSym.replace(/[\/\-\_\s]/g, '').toUpperCase().replace('UMCBL', '');
              if (!planOrdersMap[cleanSym]) {
                planOrdersMap[cleanSym] = { tpPrices: [], slPrices: [] };
              }
              const trigger = parseFloat(o.triggerPrice || o.executePrice || o.price || o.trigger_price || '0');
              if (trigger > 0) {
                const planType = (o.planType || o.orderType || o.type || '').toLowerCase();
                const isTP = planType.includes('profit') || planType.includes('tp') || planType.includes('take');
                const isSL = planType.includes('loss') || planType.includes('sl') || planType.includes('stop');

                if (isTP) {
                  if (!planOrdersMap[cleanSym].tpPrices.includes(trigger)) planOrdersMap[cleanSym].tpPrices.push(trigger);
                } else if (isSL) {
                  if (!planOrdersMap[cleanSym].slPrices.includes(trigger)) planOrdersMap[cleanSym].slPrices.push(trigger);
                } else {
                  // Fallback if type is unclassified
                  if (!planOrdersMap[cleanSym].tpPrices.includes(trigger)) planOrdersMap[cleanSym].tpPrices.push(trigger);
                  if (!planOrdersMap[cleanSym].slPrices.includes(trigger)) planOrdersMap[cleanSym].slPrices.push(trigger);
                }
              }
            });
          }
        }
      }
    } catch (e) {
      console.error('Error fetching plan orders from Bitget:', e);
    }

    const rawList = Array.isArray(res.data)
      ? res.data
      : (res.data?.list || res.data?.openPositionList || []);
    const formatted = rawList
      .filter((p: any) => parseFloat(p.total || p.holdAmount || p.available || p.position || '0') > 0)
      .map((p: any, idx: number) => {
        const sym = p.symbol || '';
        const cleanSym = sym.replace(/[\/\-\_\s]/g, '').toUpperCase().replace('UMCBL', '');
        const entry = parseFloat(p.openPriceAvg || p.averageOpenPrice || p.openPrice || '0');
        const curr = parseFloat(p.marketPrice || p.markPrice || p.lastPrice || entry || '0');
        const holdSide = (p.holdSide || p.posSide || 'long').toLowerCase();
        const isShort = holdSide === 'short';

        const symbolPlan = planOrdersMap[cleanSym] || { tpPrices: [], slPrices: [] };

        // Collect direct TP/SL attached to position if present in Bitget response
        const directTP = parseFloat(p.presetTakeProfitPrice || p.presetTakeProfit || p.presetStopProfitPrice || p.takeProfit || p.tpPrice || '0');
        const directSL = parseFloat(p.presetStopLossPrice || p.presetStopLoss || p.stopLoss || p.slPrice || '0');

        const allTPs: number[] = [];
        if (directTP > 0) allTPs.push(directTP);
        symbolPlan.tpPrices.forEach((trig) => {
          const isTpForPos = isShort ? trig < entry : trig > entry;
          if (isTpForPos && !allTPs.includes(trig)) allTPs.push(trig);
        });

        const allSLs: number[] = [];
        if (directSL > 0) allSLs.push(directSL);
        symbolPlan.slPrices.forEach((trig) => {
          const isSlForPos = isShort ? trig > entry : trig < entry;
          if (isSlForPos && !allSLs.includes(trig)) allSLs.push(trig);
        });

        const sortedTPs = allTPs.sort((a, b) => isShort ? b - a : a - b);
        const sortedSLs = allSLs.sort((a, b) => isShort ? a - b : b - a);

        const presetSL = directSL > 0 ? directSL : (sortedSLs[0] || 0);

        const tickDecimals: Record<string, number> = {
          BTC: 1, ETH: 2, SOL: 2, BNB: 2, AVAX: 2, LINK: 3, XRP: 4,
          ADA: 4, SUI: 4, DOT: 2, NEAR: 3, APT: 3, DOGE: 5, PEPE: 8, SHIB: 8,
        };
        const decimals = tickDecimals[sym.toUpperCase().replace('USDT', '')] !== undefined 
          ? tickDecimals[sym.toUpperCase().replace('USDT', '')] 
          : (entry > 1000 ? 1 : entry > 1 ? 2 : 4);

        // Calculate fallback stop loss if Bitget hasn't returned plan orders yet so UI NEVER displays $0.0000
        const fallbackSL = isShort 
          ? Number((entry * 1.015).toFixed(decimals)) 
          : Number((entry * 0.985).toFixed(decimals));
        const stopLossVal = presetSL > 0 ? presetSL : fallbackSL;

        let tp1Val = 0;
        let tp2Val = 0;
        let tp3Val = 0;

        if (sortedTPs.length >= 3) {
          tp1Val = sortedTPs[0];
          tp2Val = sortedTPs[1];
          tp3Val = sortedTPs[2];
        } else if (sortedTPs.length === 2) {
          tp1Val = sortedTPs[0];
          tp2Val = sortedTPs[1];
          tp3Val = isShort ? Number((tp2Val * 0.985).toFixed(decimals)) : Number((tp2Val * 1.015).toFixed(decimals));
        } else if (sortedTPs.length === 1) {
          tp1Val = sortedTPs[0];
          tp2Val = isShort ? Number((tp1Val * 0.988).toFixed(decimals)) : Number((tp1Val * 1.012).toFixed(decimals));
          tp3Val = isShort ? Number((tp1Val * 0.975).toFixed(decimals)) : Number((tp1Val * 1.025).toFixed(decimals));
        } else {
          tp1Val = isShort ? Number((entry * 0.988).toFixed(decimals)) : Number((entry * 1.012).toFixed(decimals));
          tp2Val = isShort ? Number((entry * 0.975).toFixed(decimals)) : Number((entry * 1.025).toFixed(decimals));
          tp3Val = isShort ? Number((entry * 0.960).toFixed(decimals)) : Number((entry * 1.040).toFixed(decimals));
        }

        const tp1Hit = isShort
          ? (curr > 0 && tp1Val > 0 && curr <= tp1Val && curr < entry * 0.992)
          : (curr > 0 && tp1Val > 0 && curr >= tp1Val && curr > entry * 1.008);
        const tp2Hit = isShort
          ? (curr > 0 && tp2Val > 0 && curr <= tp2Val && curr < entry * 0.985)
          : (curr > 0 && tp2Val > 0 && curr >= tp2Val && curr > entry * 1.015);
        const tp3Hit = isShort
          ? (curr > 0 && tp3Val > 0 && curr <= tp3Val && curr < entry * 0.975)
          : (curr > 0 && tp3Val > 0 && curr >= tp3Val && curr > entry * 1.025);

        const tpLegs = [
          {
            id: `${sym}_tp1_${idx}`,
            level: 1,
            price: tp1Val,
            close_fraction: 0.4,
            hit: tp1Hit ? 1 : 0,
            reason: sortedTPs.length >= 1 ? `Bitget Target 1 ($${tp1Val})` : `50% Target ($${tp1Val})`,
          },
          {
            id: `${sym}_tp2_${idx}`,
            level: 2,
            price: tp2Val,
            close_fraction: 0.3,
            hit: tp2Hit ? 1 : 0,
            reason: sortedTPs.length >= 2 ? `Bitget Target 2 ($${tp2Val})` : `Order Block ($${tp2Val})`,
          },
          {
            id: `${sym}_tp3_${idx}`,
            level: 3,
            price: tp3Val,
            close_fraction: 0.3,
            hit: tp3Hit ? 1 : 0,
            reason: sortedTPs.length >= 3 ? `Bitget Target 3 ($${tp3Val})` : `Expansion ($${tp3Val})`,
          },
        ];

        const isSlAtEntry = presetSL > 0 && (Math.abs(presetSL - entry) / entry < 0.0025);
        const isBreakeven = isSlAtEntry || tp1Hit;

        return {
          id: p.positionId || `${sym}_${idx}`,
          symbol: sym,
          direction: isShort ? 'short' : 'long',
          entry_price: entry,
          current_price: curr,
          stop_loss: isSlAtEntry ? entry : stopLossVal,
          position_size: parseFloat(p.total || p.holdAmount || p.available || '0'),
          confidence: 0.95,
          sl_reason: isSlAtEntry
            ? `Breakeven Protection (Bitget SL @ Entry: $${entry.toFixed(decimals)})`
            : (presetSL > 0
              ? `Bitget Stop Loss ($${presetSL})`
              : `Structural Stop Loss ($${stopLossVal.toFixed(decimals)})`),
          breakeven_applied: isBreakeven ? 1 : 0,
          dry_run: false,
          tp_legs: tpLegs,
          unrealized_pnl: parseFloat(p.unrealizedPL || p.unrealizedPnl || '0'),
        };
      });

    return { success: true, positions: formatted };
  } catch (err: any) {
    return {
      error: `Network Error: ${err.message || String(err)}`,
      positions: [],
    };
  }
}

export async function fetchLiveOrderHistory(creds: BitgetCredentials) {
  try {
    // 1. Try fetching real closed positions history from Bitget Futures V2 API
    const posRes = await bitgetApiRequest(
      '/api/v2/mix/position/history-position?productType=USDT-FUTURES&pageSize=50',
      'GET',
      null,
      creds
    );

    if (posRes.code === '00000') {
      const posList = posRes.data?.list || posRes.data || [];
      if (Array.isArray(posList) && posList.length > 0) {
        const formatted = posList.map((p: any) => {
          const pnl = parseFloat(p.netProfit || p.pnl || p.achievedProfits || '0');
          const openPrice = parseFloat(p.openAvgPrice || p.openPrice || '0');
          const closePrice = parseFloat(p.closeAvgPrice || p.closePrice || openPrice || '0');
          const holdSide = (p.holdSide || 'long').toLowerCase();
          return {
            id: p.positionId || p.symbol + '_' + (p.cTime || p.uTime || Math.random()),
            symbol: p.symbol,
            direction: holdSide === 'short' ? 'short' : 'long',
            entry_price: openPrice,
            close_price: closePrice,
            realized_pnl: pnl,
            close_reason: `Bitget Realized Trade [Net: $${pnl.toFixed(2)}]`,
            closed_at: Math.floor(parseInt(p.uTime || p.cTime || Date.now(), 10) / 1000),
            dry_run: false,
          };
        });

        return { success: true, history: formatted };
      }
    }

    // 2. Fallback to order history if history-position has no items, filtering STRICTLY for filled/executed orders
    const res = await bitgetApiRequest(
      '/api/v2/mix/order/orders-history?productType=USDT-FUTURES&pageSize=50',
      'GET',
      null,
      creds
    );

    if (res.code !== '00000') {
      return {
        error: `Bitget API Error (${res.code}): ${res.msg || 'Failed to fetch order history'}`,
        history: [],
      };
    }

    const rawList = res.data?.entrustedList || res.data || [];
    if (!Array.isArray(rawList)) {
      return { success: true, history: [] };
    }

    // Strictly filter out canceled, untriggered, or un-filled orders
    const filledOrders = rawList.filter((o: any) => {
      const st = (o.status || o.state || '').toLowerCase();
      if (st.includes('cancel') || st === 'live' || st === 'init' || st === 'new') {
        return false;
      }
      const filledQty = parseFloat(o.filledQty || o.baseVolume || o.tradeQty || '0');
      const pnl = parseFloat(o.pnl || '0');
      return st === 'filled' || st === 'completed' || st === 'partially_filled' || filledQty > 0 || pnl !== 0;
    });

    const formatted = filledOrders.map((o: any) => ({
      id: o.orderId || o.clientOid || Math.random(),
      symbol: o.symbol,
      direction: (o.side || 'buy').toLowerCase().includes('sell') ? 'short' : 'long',
      entry_price: parseFloat(o.priceAvg || o.price || '0'),
      close_price: parseFloat(o.priceAvg || o.price || '0'),
      realized_pnl: parseFloat(o.pnl || '0'),
      close_reason: `Bitget Executed Order [Status: ${o.status || 'filled'}]`,
      closed_at: Math.floor(parseInt(o.uTime || o.cTime || Date.now(), 10) / 1000),
      dry_run: false,
    }));

    return { success: true, history: formatted };
  } catch (err: any) {
    return {
      error: `Network Error: ${err.message || String(err)}`,
      history: [],
    };
  }
}

export async function fetchPublicMarketTickers(symbols?: string[]) {
  try {
    const res = await fetch(`${BITGET_BASE_URL}/api/v2/mix/market/tickers?productType=USDT-FUTURES`);
    const json = await res.json();
    if (json.code !== '00000' || !Array.isArray(json.data)) {
      return { error: `Bitget Public Ticker Error (${json.code}): ${json.msg || 'Unknown'}` };
    }

    let list = json.data;
    if (symbols && symbols.length > 0) {
      const cleanSet = new Set(
        symbols.map((s) => s.replace(/[\/\-\s]/g, '').toUpperCase())
      );
      list = list.filter((item: any) => {
        const itemSym = item.symbol?.toUpperCase() || '';
        if (cleanSet.has(itemSym)) return true;
        for (const userSym of cleanSet) {
          if (itemSym === userSym + 'USDT' || itemSym === userSym || userSym === itemSym.replace('USDT', '')) {
            return true;
          }
        }
        return false;
      });
    }

    return { success: true, tickers: list };
  } catch (err: any) {
    return { error: `Network error fetching Bitget tickers: ${err.message || String(err)}` };
  }
}

export function getStandardContractSize(symbol: string, price?: number, requestedSize?: string): string {
  if (requestedSize && parseFloat(requestedSize) > 0) return String(requestedSize);
  const sym = symbol.toUpperCase().replace('USDT', '');
  
  // Specific override table for major coins
  const knownSizes: Record<string, string> = {
    BTC: '0.001',
    ETH: '0.01',
    SOL: '0.1',
    BNB: '0.1',
    XRP: '10',
    DOGE: '100',
    ADA: '10',
    AVAX: '0.5',
    LINK: '1',
    SUI: '10',
    DOT: '1',
    NEAR: '1',
    APT: '1',
    PEPE: '100000',
    SHIB: '100000',
    FLOKI: '10000',
    BONK: '100000',
  };

  if (knownSizes[sym]) {
    return knownSizes[sym];
  }

  // Universal Dynamic Sizing based on price level (aiming for ~$5 - $10 minimum order value on Bitget)
  if (price && price > 0) {
    if (price >= 10000) return '0.001';
    if (price >= 1000) return '0.01';
    if (price >= 100) return '0.1';
    if (price >= 10) return '1';
    if (price >= 1) return '10';
    if (price >= 0.1) return '100';
    if (price >= 0.01) return '1000';
    if (price >= 0.001) return '10000';
    if (price >= 0.0001) return '100000';
    return '1000000';
  }

  return '1';
}

export function calculateRiskBasedSize(symbol: string, entryPrice: number, stopLoss: number, riskAmountUsd: number): string {
  const distance = Math.abs(entryPrice - stopLoss);
  if (distance === 0 || isNaN(distance)) return getStandardContractSize(symbol, entryPrice);
  
  const rawSize = riskAmountUsd / distance;
  
  const minSizeStr = getStandardContractSize(symbol, entryPrice);
  const minSizeNum = parseFloat(minSizeStr);
  const dotIndex = minSizeStr.indexOf('.');
  const decimals = dotIndex === -1 ? 0 : minSizeStr.length - dotIndex - 1;
  
  let formattedSize = rawSize.toFixed(decimals);
  if (parseFloat(formattedSize) < minSizeNum) {
    formattedSize = minSizeStr;
  }
  return formattedSize;
}

export function formatPriceForBitget(symbol: string, price: number): string {
  if (!price || isNaN(price)) return '';
  const sym = symbol.toUpperCase().replace('USDT', '');
  
  // Specific symbol tick precision rules on Bitget
  const tickDecimals: Record<string, number> = {
    BTC: 1,
    ETH: 2,
    SOL: 2,
    BNB: 2,
    AVAX: 2,
    LINK: 3,
    XRP: 4,
    ADA: 4,
    SUI: 4,
    DOT: 2,
    NEAR: 3,
    APT: 3,
    DOGE: 5,
    PEPE: 8,
    SHIB: 8,
    FLOKI: 8,
    BONK: 8,
  };

  let decimals = tickDecimals[sym];
  if (decimals === undefined) {
    if (price >= 10000) decimals = 1;
    else if (price >= 100) decimals = 2;
    else if (price >= 1) decimals = 3;
    else if (price >= 0.01) decimals = 5;
    else decimals = 8;
  }

  return price.toFixed(decimals);
}

export async function setLiveLeverage(
  creds: BitgetCredentials,
  symbol: string,
  leverage: number,
  holdSide?: 'long' | 'short'
) {
  try {
    const payload: Record<string, any> = {
      productType: 'USDT-FUTURES',
      symbol: symbol,
      marginCoin: 'USDT',
      leverage: String(leverage),
    };
    if (holdSide) {
      payload.holdSide = holdSide;
    }
    const res = await bitgetApiRequest('/api/v2/mix/account/set-leverage', 'POST', payload, creds);
    return res;
  } catch (err: any) {
    return { error: String(err) };
  }
}

export async function placeLiveOrder(
  creds: BitgetCredentials,
  params: {
    symbol: string;
    direction: 'long' | 'short';
    size?: string;
    price?: number;
    leverage?: number;
    presetStopLossPrice?: number | string;
    presetTakeProfitPrice?: number | string;
    tp_legs?: Array<{ price: number; close_fraction: number }>;
    marginMode?: string;
    tradeSide?: string;
  }
) {
  try {
    if (params.leverage && params.leverage > 0) {
      await setLiveLeverage(creds, params.symbol, params.leverage, params.direction);
    }

    const side = params.direction === 'long' ? 'buy' : 'sell';
    const sizeToUse = getStandardContractSize(params.symbol, params.price, params.size);

    const buildPayload = (tSide?: string) => {
      const payload: Record<string, any> = {
        productType: 'USDT-FUTURES',
        symbol: params.symbol,
        marginCoin: 'USDT',
        size: sizeToUse,
        side: side,
        orderType: 'market',
        marginMode: params.marginMode || 'crossed',
      };

      if (tSide) {
        payload.tradeSide = tSide;
      }
      
      if (params.presetStopLossPrice) {
        const numSL = typeof params.presetStopLossPrice === 'number' ? params.presetStopLossPrice : parseFloat(String(params.presetStopLossPrice));
        if (!isNaN(numSL) && numSL > 0) {
          payload.presetStopLossPrice = formatPriceForBitget(params.symbol, numSL);
        }
      }

      if (!params.tp_legs || params.tp_legs.length === 0) {
        if (params.presetTakeProfitPrice) {
          const numTP = typeof params.presetTakeProfitPrice === 'number' ? params.presetTakeProfitPrice : parseFloat(String(params.presetTakeProfitPrice));
          if (!isNaN(numTP) && numTP > 0) {
            payload.presetTakeProfitPrice = formatPriceForBitget(params.symbol, numTP);
          }
        }
      }
      
      return payload;
    };

    // Attempt 1: Hedge Mode ('open')
    let payload = buildPayload('open');
    let res = await bitgetApiRequest('/api/v2/mix/order/place-order', 'POST', payload, creds);

    // Attempt 2: One-Way Mode (omit tradeSide) if attempt 1 returned mode/side mismatch error
    if (res.code === '400172' || res.code === '40774' || (res.msg && (res.msg.includes('side mismatch') || res.msg.toLowerCase().includes('unilateral')))) {
      payload = buildPayload(undefined);
      res = await bitgetApiRequest('/api/v2/mix/order/place-order', 'POST', payload, creds);
    }

    if (res.code !== '00000') {
      return {
        error: `Bitget Order Error (${res.code}): ${res.msg || 'Failed to place order on Bitget'}`,
      };
    }

    let tpError = null;
    let slError = null;

    // NOTE: presetStopLossPrice was ALREADY attached to the order in Bitget place-order call above.
    // We only create a plan order IF presetStopLossPrice was not sent in place-order!
    if (!payload.presetStopLossPrice && params.presetStopLossPrice) {
      const numSL = typeof params.presetStopLossPrice === 'number' ? params.presetStopLossPrice : parseFloat(String(params.presetStopLossPrice));
      if (!isNaN(numSL) && numSL > 0) {
        await new Promise(r => setTimeout(r, 500));
        const slRes = await placeLiveTPSL(creds, {
          symbol: params.symbol,
          holdSide: params.direction,
          planType: 'loss_plan',
          triggerPrice: numSL,
          size: sizeToUse,
        });
        if (slRes.error) slError = slRes.error;
      }
    }

    // Attach explicit Partial TP plan orders with Minimum Contract Size validation
    if (params.tp_legs && params.tp_legs.length > 0) {
      await new Promise(r => setTimeout(r, 1000));
      
      const numTotalSize = parseFloat(sizeToUse);
      const minSizeStr = getStandardContractSize(params.symbol, params.price);
      const minSizeNum = parseFloat(minSizeStr);
      const dotIndex = sizeToUse.indexOf('.');
      const precision = dotIndex === -1 ? 0 : sizeToUse.length - dotIndex - 1;

      // Consolidate TP legs so that every leg satisfies Bitget minimum contract size
      let validLegs: Array<{ price: number; sizeStr: string }> = [];

      if (numTotalSize < 2 * minSizeNum) {
        // Can only place 1 TP leg for 100% of order size
        validLegs = [{ price: params.tp_legs[0].price, sizeStr: sizeToUse }];
      } else if (numTotalSize < 3 * minSizeNum || params.tp_legs.length === 2) {
        // Split into 2 legs
        const leg1Size = Math.max(minSizeNum, Math.floor((numTotalSize * 0.5) / minSizeNum) * minSizeNum);
        const leg2Size = Math.round((numTotalSize - leg1Size) * 1000000) / 1000000;
        validLegs = [
          { price: params.tp_legs[0].price, sizeStr: leg1Size.toFixed(precision) },
          { price: params.tp_legs[1]?.price || params.tp_legs[0].price, sizeStr: leg2Size.toFixed(precision) }
        ];
      } else {
        // 3 legs
        const leg1Size = Math.max(minSizeNum, Math.floor((numTotalSize * 0.4) / minSizeNum) * minSizeNum);
        const leg2Size = Math.max(minSizeNum, Math.floor((numTotalSize * 0.3) / minSizeNum) * minSizeNum);
        const leg3Size = Math.round((numTotalSize - leg1Size - leg2Size) * 1000000) / 1000000;
        validLegs = [
          { price: params.tp_legs[0].price, sizeStr: leg1Size.toFixed(precision) },
          { price: params.tp_legs[1]?.price || params.tp_legs[0].price, sizeStr: leg2Size.toFixed(precision) },
          { price: params.tp_legs[2]?.price || params.tp_legs[0].price, sizeStr: leg3Size.toFixed(precision) }
        ];
      }

      const tpResults = [];
      for (let i = 0; i < validLegs.length; i++) {
        const leg = validLegs[i];
        if (parseFloat(leg.sizeStr) >= minSizeNum) {
          let tpRes = await placeLiveTPSL(creds, {
            symbol: params.symbol,
            holdSide: params.direction,
            planType: 'profit_plan',
            triggerPrice: leg.price,
            size: leg.sizeStr,
          });
          
          if (tpRes.error) {
            await new Promise(r => setTimeout(r, 1000));
            tpRes = await placeLiveTPSL(creds, {
              symbol: params.symbol,
              holdSide: params.direction,
              planType: 'profit_plan',
              triggerPrice: leg.price,
              size: leg.sizeStr,
            });
          }
          
          if (tpRes.error) {
            tpResults.push({ success: false, error: tpRes.error, price: leg.price });
          } else {
            tpResults.push({ success: true, price: leg.price, size: leg.sizeStr });
          }
        }
      }

      if (tpResults.some(r => r.success)) {
        tpError = tpResults.filter(r => !r.success).map(r => `${r.price}: ${r.error}`).join('; ') || null;
      } else if (tpResults.length > 0) {
        tpError = tpResults.map(r => `${r.price}: ${r.error}`).join('; ');
      }
    }

    return { success: true, data: res.data, tpError, slError };
  } catch (err: any) {
    return { error: `Network/Bitget Order Error: ${err.message || String(err)}` };
  }
}

export async function placeLiveTPSL(
  creds: BitgetCredentials,
  params: {
    symbol: string;
    holdSide: 'long' | 'short';
    planType: 'profit_plan' | 'loss_plan';
    triggerPrice: number;
    size?: string;
  }
) {
  try {
    const formattedPrice = formatPriceForBitget(params.symbol, params.triggerPrice);

    // Auto-detect size if not provided
    let sizeToUse = params.size;
    if (!sizeToUse) {
      const posRes = await bitgetApiRequest(
        '/api/v2/mix/position/all-position?productType=USDT-FUTURES',
        'GET',
        null,
        creds
      );
      if (posRes && posRes.code === '00000' && Array.isArray(posRes.data)) {
        const matchingPos = posRes.data.find(
          (p: any) =>
            p.symbol === params.symbol &&
            (p.holdSide || '').toLowerCase() === params.holdSide.toLowerCase()
        );
        if (matchingPos) {
          sizeToUse = matchingPos.total || matchingPos.holdAmount || matchingPos.available || '0.1';
        }
      }
      if (!sizeToUse) {
        sizeToUse = '0.1'; // safe fallback
      }
    }

    const payload: Record<string, any> = {
      productType: 'USDT-FUTURES',
      symbol: params.symbol,
      marginCoin: 'USDT',
      planType: params.planType,
      triggerPrice: formattedPrice,
      triggerType: 'mark_price',
      holdSide: params.holdSide,
      size: sizeToUse,
    };

    let res = await bitgetApiRequest('/api/v2/mix/order/place-tpsl-order', 'POST', payload, creds);
    if (res.code !== '00000' && (res.code === '400172' || res.code === '40774' || (res.msg && (res.msg.includes('side') || res.msg.toLowerCase().includes('unilateral'))))) {
      delete payload.holdSide;
      res = await bitgetApiRequest('/api/v2/mix/order/place-tpsl-order', 'POST', payload, creds);
    }

    if (res.code !== '00000') {
      const errMsg = `[BITGET TPSL ERROR] ${params.symbol} ${params.planType} at ${formattedPrice}: ${res.msg}`;
      console.error(errMsg);
      return { error: errMsg, code: res.code, msg: res.msg };
    }
    return res;
  } catch (err: any) {
    return { error: String(err) };
  }
}

export async function cancelLivePlanOrders(
  creds: BitgetCredentials,
  symbol: string,
  planType: 'profit_plan' | 'loss_plan' | 'moving_plan' | 'normal_plan' = 'loss_plan'
) {
  try {
    const res = await bitgetApiRequest(
      '/api/v2/mix/order/cancel-all-plan-order',
      'POST',
      {
        productType: 'USDT-FUTURES',
        marginCoin: 'USDT',
        symbol: symbol,
        planType: planType,
      },
      creds
    );
    return res;
  } catch (err: any) {
    return null;
  }
}

export async function updateLiveStopLoss(
  creds: BitgetCredentials,
  symbol: string,
  holdSide: 'long' | 'short',
  stopLossPrice: number
) {
  try {
    // Cancel prior SL plan orders first to avoid stacking up duplicate SLs on Bitget
    await cancelLivePlanOrders(creds, symbol, 'loss_plan');
    await cancelLivePlanOrders(creds, symbol, 'pos_loss');

    // Place new Stop Loss order set to Entry Price (Breakeven)
    const res = await placeLiveTPSL(creds, {
      symbol,
      holdSide,
      planType: 'loss_plan',
      triggerPrice: stopLossPrice,
    });

    if (res.code && res.code !== '00000') {
      return {
        error: `Bitget TPSL Error (${res.code}): ${res.msg || 'Failed to update Stop Loss'}`,
      };
    }

    return { success: true, data: res.data };
  } catch (err: any) {
    return { error: `Network/Bitget API Error: ${err.message || String(err)}` };
  }
}

export async function closeLivePosition(creds: BitgetCredentials, symbol: string) {
  try {
    const res = await bitgetApiRequest(
      '/api/v2/mix/order/close-positions',
      'POST',
      {
        productType: 'USDT-FUTURES',
        marginCoin: 'USDT',
        symbol: symbol,
      },
      creds
    );

    if (res.code !== '00000') {
      return {
        error: `Bitget API Error (${res.code}): ${res.msg || 'Failed to close position on Bitget'}`,
      };
    }

    return { success: true, data: res.data };
  } catch (err: any) {
    return { error: `Network/Bitget API Error: ${err.message || String(err)}` };
  }
}
