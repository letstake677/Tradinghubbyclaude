import fs from 'fs';

let code = fs.readFileSync('server.ts', 'utf8');

// Replace fetchKlines
code = code.replace(
  'async function fetchKlines(symbol: string, limit = 30) {',
  'async function fetchKlines(symbol: string, granularity: string, limit = 30) {'
);
code = code.replace(
  'productType=USDT-FUTURES&granularity=15m&limit=${limit}',
  'productType=USDT-FUTURES&granularity=${granularity}&limit=${limit}'
);

// Update calls to fetchKlines
code = code.replace(
  'const klines = await fetchKlines(sym, 30);',
  'const granularity = settings.timeframe || "15m";\n    const klines = await fetchKlines(sym, granularity, 30);'
);

// Update stratDesc
code = code.replace(
  /15m Range Pos/g,
  '${granularity} Range Pos'
);
code = code.replace(
  /15m RSI/g,
  '${granularity} RSI'
);

fs.writeFileSync('server.ts', code, 'utf8');
console.log('Fixed timeframe');
