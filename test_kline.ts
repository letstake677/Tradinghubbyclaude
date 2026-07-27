async function getKlines() {
    const res = await fetch('https://api.bitget.com/api/v2/mix/market/candles?symbol=BTCUSDT&productType=USDT-FUTURES&granularity=15m&limit=10');
    const json = await res.json();
    console.log(json);
}
getKlines();
