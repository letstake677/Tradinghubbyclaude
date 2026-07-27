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

    const futuresData = futuresRes.data || [];
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

    const rawList = res.data || [];
    const formatted = rawList
      .filter((p: any) => parseFloat(p.total || p.holdAmount || '0') > 0)
      .map((p: any, idx: number) => {
        const entry = parseFloat(p.openPriceAvg || p.averageOpenPrice || '0');
        const curr = parseFloat(p.marketPrice || p.markPrice || entry || '0');
        const holdSide = (p.holdSide || 'long').toLowerCase();

        return {
          id: p.positionId || p.symbol + '_' + idx,
          symbol: p.symbol,
          direction: holdSide === 'short' ? 'short' : 'long',
          entry_price: entry,
          current_price: curr,
          stop_loss: parseFloat(p.liquidationPrice || '0'),
          position_size: parseFloat(p.total || p.holdAmount || '0'),
          confidence: 0.95,
          sl_reason: 'Bitget Exchange Real Position',
          breakeven_applied: 0,
          dry_run: false,
          tp_legs: [],
          unrealized_pnl: parseFloat(p.unrealizedPL || '0'),
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

export async function placeLiveOrder(
  creds: BitgetCredentials,
  params: {
    symbol: string;
    direction: 'long' | 'short';
    size?: string;
    price?: number;
    presetStopLossPrice?: number | string;
    presetTakeProfitPrice?: number | string;
    marginMode?: string;
  }
) {
  try {
    const side = params.direction === 'long' ? 'buy' : 'sell';
    const sizeToUse = getStandardContractSize(params.symbol, params.price, params.size);
    const payload: Record<string, any> = {
      productType: 'USDT-FUTURES',
      symbol: params.symbol,
      marginCoin: 'USDT',
      size: sizeToUse,
      side: side,
      orderType: 'market',
      marginMode: params.marginMode || 'crossed',
    };

    if (params.presetStopLossPrice) {
      payload.presetStopLossPrice = String(params.presetStopLossPrice);
    }
    if (params.presetTakeProfitPrice) {
      payload.presetTakeProfitPrice = String(params.presetTakeProfitPrice);
    }

    const res = await bitgetApiRequest(
      '/api/v2/mix/order/place-order',
      'POST',
      payload,
      creds
    );

    if (res.code !== '00000') {
      return {
        error: `Bitget Order Error (${res.code}): ${res.msg || 'Failed to place order on Bitget'}`,
      };
    }

    return { success: true, data: res.data };
  } catch (err: any) {
    return { error: `Network/Bitget Order Error: ${err.message || String(err)}` };
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
