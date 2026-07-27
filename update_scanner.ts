import fs from 'fs';

const code = fs.readFileSync('server.ts', 'utf8');

const newScanner = `
async function fetchKlines(symbol: string, limit = 20) {
  try {
    const res = await fetch(\`https://api.bitget.com/api/v2/mix/market/candles?symbol=\${symbol}&productType=USDT-FUTURES&granularity=15m&limit=\${limit}\`);
    const json = await res.json();
    if (json.code === '00000' && Array.isArray(json.data)) {
      // Bitget format: [timestamp, open, high, low, close, baseVol, quoteVol]
      // Returned from newest to oldest or oldest to newest? 
      // The API returns newest to oldest usually, let's reverse to oldest->newest
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

// Inside scanCoinsAndGenerateSignals we replace the ticker part
`;

console.log('done');
