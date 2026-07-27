const { bitgetApiRequest } = require('./dist/server.cjs');
fetch('https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1H&limit=2')
  .then(res => res.json())
  .then(console.log);
fetch('https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1h&limit=2')
  .then(res => res.json())
  .then(console.log);
fetch('https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=1d&limit=2')
  .then(res => res.json())
  .then(console.log);
