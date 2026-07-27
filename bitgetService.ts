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

    // Try fetching pending TP/SL plan orders from Bitget to match exact trigger prices
    const planOrdersMap: Record<string, { tpPrice?: number; slPrice?: number }> = {};
    try {
      const planRes = await bitgetApiRequest(
        '/api/v2/mix/order/orders-plan-pending?productType=USDT-FUTURES',
        'GET',
        null,
        creds
      );
      if (planRes.code === '00000') {
        const list = planRes.data?.entrustedList || planRes.data?.list || (Array.isArray(planRes.data) ? planRes.data : []);
        if (Array.isArray(list)) {
          list.forEach((o: any) => {
            const sym = o.symbol;
            if (!sym) return;
            if (!planOrdersMap[sym]) planOrdersMap[sym] = {};
            const trigger = parseFloat(o.triggerPrice || o.executePrice || o.price || '0');
            const planType = (o.planType || o.orderType || '').toLowerCase();
            if (planType.includes('profit') || planType.includes('tp') || planType.includes('take')) {
              planOrdersMap[sym].tpPrice = trigger;
            } else if (planType.includes('loss') || planType.includes('sl') || planType.includes('stop')) {
              planOrdersMap[sym].slPrice = trigger;
            }
          });
        }
      }
    } catch (e) {
      // Non-blocking fallback
    }

    const rawList = Array.isArray(res.data)
      ? res.data
      : (res.data?.list || res.data?.openPositionList || []);
    const formatted = rawList
      .filter((p: any) => parseFloat(p.total || p.holdAmount || p.available || p.position || '0') > 0)
      .map((p: any, idx: number) => {
        const sym = p.symbol;
        const entry = parseFloat(p.openPriceAvg || p.averageOpenPrice || p.openPrice || '0');
        const curr = parseFloat(p.marketPrice || p.markPrice || p.lastPrice || entry || '0');
        const holdSide = (p.holdSide || p.posSide || 'long').toLowerCase();
        const isShort = holdSide === 'short';

        const presetSL = parseFloat(
          p.presetStopLossPrice || p.stopLoss || p.slPrice || planOrdersMap[sym]?.slPrice || '0'
        );
        const presetTP = parseFloat(
          p.presetTakeProfitPrice || p.presetStopProfitPrice || p.takeProfit || p.tpPrice || planOrdersMap[sym]?.tpPrice || '0'
        );

        const liqPrice = parseFloat(p.liquidationPrice || p.breakEvenPrice || '0');
        const stopLossVal = presetSL > 0 ? presetSL : 0;

        const decimals = entry > 1000 ? 2 : entry > 1 ? 2 : 4;

        let tp1Val = 0;
        let tp2Val = 0;
        let tp3Val = 0;

        if (presetTP > 0) {
          tp1Val = presetTP;
          if (isShort) {
            tp2Val = Number((presetTP * 0.988).toFixed(decimals));
            tp3Val = Number((presetTP * 0.975).toFixed(decimals));
          } else {
            tp2Val = Number((presetTP * 1.012).toFixed(decimals));
            tp3Val = Number((presetTP * 1.025).toFixed(decimals));
          }
        } else {
          if (isShort) {
            tp1Val = Number((entry * 0.988).toFixed(decimals));
            tp2Val = Number((entry * 0.975).toFixed(decimals));
            tp3Val = Number((entry * 0.960).toFixed(decimals));
          } else {
            tp1Val = Number((entry * 1.012).toFixed(decimals));
            tp2Val = Number((entry * 1.025).toFixed(decimals));
            tp3Val = Number((entry * 1.040).toFixed(decimals));
          }
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
            reason: presetTP > 0
              ? `Bitget Exchange Target 1 ($${tp1Val})`
              : `50% Structural Target ($${tp1Val})`,
          },
          {
            id: `${sym}_tp2_${idx}`,
            level: 2,
            price: tp2Val,
            close_fraction: 0.3,
            hit: tp2Hit ? 1 : 0,
            reason: `Order Block Target ($${tp2Val})`,
          },
          {
            id: `${sym}_tp3_${idx}`,
            level: 3,
            price: tp3Val,
            close_fraction: 0.3,
            hit: tp3Hit ? 1 : 0,
            reason: `Liquidity Expansion Target ($${tp3Val})`,
          },
        ];

        // Breakeven is ONLY true if SL is explicitly placed near Entry price on Bitget OR if TP1 was actually reached
        const isSlAtEntry = presetSL > 0 && (Math.abs(presetSL - entry) / entry < 0.002);
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
              ? `Bitget Preset Stop Loss ($${presetSL})`
              : `Bitget Exchange Real Position (Liq: $${liqPrice.toFixed(decimals)})`),
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

    const buildPayload = (tSide?: string, includeTPSL = true) => {
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

      if (includeTPSL) {
        if (params.presetStopLossPrice) {
          const numSL = typeof params.presetStopLossPrice === 'number' ? params.presetStopLossPrice : parseFloat(String(params.presetStopLossPrice));
          if (!isNaN(numSL) && numSL > 0) {
            payload.presetStopLossPrice = formatPriceForBitget(params.symbol, numSL);
          }
        }
        if (params.presetTakeProfitPrice) {
          const numTP = typeof params.presetTakeProfitPrice === 'number' ? params.presetTakeProfitPrice : parseFloat(String(params.presetTakeProfitPrice));
          if (!isNaN(numTP) && numTP > 0) {
            payload.presetTakeProfitPrice = formatPriceForBitget(params.symbol, numTP);
          }
        }
      }
      return payload;
    };

    // Attempt 1: Hedge Mode ('open') + TP/SL
    let payload = buildPayload('open', true);
    let res = await bitgetApiRequest('/api/v2/mix/order/place-order', 'POST', payload, creds);

    // Attempt 2: One-Way Mode (omit tradeSide) + TP/SL if attempt 1 returned mode/side mismatch error
    if (res.code === '400172' || res.code === '40774' || (res.msg && (res.msg.includes('side mismatch') || res.msg.toLowerCase().includes('unilateral')))) {
      payload = buildPayload(undefined, true);
      res = await bitgetApiRequest('/api/v2/mix/order/place-order', 'POST', payload, creds);
    }

    // Attempt 3: If tick size / price precision error (e.g. 45115), retry without preset TP/SL as fallback
    if (res.code === '45115' || (res.msg && (res.msg.includes('multiple') || res.msg.includes('preset')))) {
      payload = buildPayload('open', false);
      res = await bitgetApiRequest('/api/v2/mix/order/place-order', 'POST', payload, creds);

      if (res.code !== '00000') {
        payload = buildPayload(undefined, false);
        res = await bitgetApiRequest('/api/v2/mix/order/place-order', 'POST', payload, creds);
      }
    }

    if (res.code !== '00000') {
      return {
        error: `Bitget Order Error (${res.code}): ${res.msg || 'Failed to place order on Bitget'}`,
      };
    }

    let tpError = null;
    let slError = null;
    
    // Attach explicit TP and SL plan orders to guarantee Bitget shows TP 1 / SL 1 on position
    if (params.presetTakeProfitPrice) {
      const numTP = typeof params.presetTakeProfitPrice === 'number' ? params.presetTakeProfitPrice : parseFloat(String(params.presetTakeProfitPrice));
      if (!isNaN(numTP) && numTP > 0) {
        const tpRes = await placeLiveTPSL(creds, {
          symbol: params.symbol,
          holdSide: params.direction,
          planType: 'profit_plan',
          triggerPrice: numTP,
        });
        if (tpRes.error) tpError = tpRes.error;
      }
    }
    if (params.presetStopLossPrice) {
      const numSL = typeof params.presetStopLossPrice === 'number' ? params.presetStopLossPrice : parseFloat(String(params.presetStopLossPrice));
      if (!isNaN(numSL) && numSL > 0) {
        const slRes = await placeLiveTPSL(creds, {
          symbol: params.symbol,
          holdSide: params.direction,
          planType: 'loss_plan',
          triggerPrice: numSL,
        });
        if (slRes.error) slError = slRes.error;
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
  }
) {
  try {
    const formattedPrice = formatPriceForBitget(params.symbol, params.triggerPrice);
    const res = await bitgetApiRequest(
      '/api/v2/mix/order/place-tpsl',
      'POST',
      {
        productType: 'USDT-FUTURES',
        symbol: params.symbol,
        marginCoin: 'USDT',
        planType: params.planType,
        triggerPrice: formattedPrice,
        triggerType: 'mark_price',
        holdSide: params.holdSide,
      },
      creds
    );
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
