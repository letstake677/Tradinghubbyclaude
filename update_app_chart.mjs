import fs from 'fs';

let appCode = fs.readFileSync('src/App.tsx', 'utf8');

// 1. Expand recharts imports
appCode = appCode.replace(
  "import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis, Tooltip } from 'recharts';",
  "import { AreaChart, Area, ComposedChart, Bar, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts';"
);

// 2. Define LiveChart component before App()
const liveChartComponent = `
function LiveChart({ apiBase, currentTimeframe, onTimeframeChange, onExecuteTrade }: { 
  apiBase: string; 
  currentTimeframe: string; 
  onTimeframeChange: (tf: string) => void;
  onExecuteTrade: (sig: any) => void;
}) {
  const [selectedSymbol, setSelectedSymbol] = useState('BTCUSDT');
  const [tf, setTf] = useState(currentTimeframe || '15m');
  const [klinesData, setKlinesData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);

  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT'];
  const timeframes = ['1m', '5m', '15m', '30m', '1H', '4H', '1D'];

  const loadKlines = useCallback(async (sym: string, timeframe: string) => {
    setLoading(true);
    try {
      const res = await fetch(\`\${apiBase}/api/klines?symbol=\${sym}&timeframe=\${timeframe}&limit=50\`);
      const json = await res.json();
      if (json.klines && Array.isArray(json.klines)) {
        // Compute RSI for klines
        const closes = json.klines.map((k: any) => k.close);
        const rsiVals: number[] = [];
        for (let i = 0; i < closes.length; i++) {
          if (i < 14) {
            rsiVals.push(50);
          } else {
            let gains = 0, losses = 0;
            for (let j = i - 13; j <= i; j++) {
              const diff = closes[j] - closes[j - 1];
              if (diff > 0) gains += diff;
              else losses -= diff;
            }
            const rs = (gains / 14) / ((losses / 14) || 1);
            rsiVals.push(Math.round(100 - (100 / (1 + rs))));
          }
        }

        const formatted = json.klines.map((k: any, idx: number) => {
          const d = new Date(k.timestamp);
          const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          return {
            time: timeStr,
            open: k.open,
            high: k.high,
            low: k.low,
            close: k.close,
            vol: k.vol,
            rsi: rsiVals[idx] || 50,
            isGreen: k.close >= k.open
          };
        });
        setKlinesData(formatted);
      }
    } catch(e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    setTf(currentTimeframe || '15m');
  }, [currentTimeframe]);

  useEffect(() => {
    loadKlines(selectedSymbol, tf);
    const interval = setInterval(() => loadKlines(selectedSymbol, tf), 12000);
    return () => clearInterval(interval);
  }, [selectedSymbol, tf, loadKlines]);

  const handleTfChange = (newTf: string) => {
    setTf(newTf);
    onTimeframeChange(newTf);
  };

  const latest = klinesData[klinesData.length - 1] || { close: 0, rsi: 50, high: 0, low: 0 };
  const first = klinesData[0] || { close: 0 };
  const priceChange = latest.close && first.close ? ((latest.close - first.close) / first.close) * 100 : 0;

  const highest = Math.max(...klinesData.map(k => k.high || 0), latest.close || 1);
  const lowest = Math.min(...klinesData.map(k => k.low || Infinity), latest.close || 1);
  const range = highest - lowest;
  const posInRange = range > 0 ? (latest.close - lowest) / range : 0.5;

  const isBullish = latest.rsi < 45 && posInRange < 0.3;
  const isBearish = latest.rsi > 55 && posInRange > 0.7;
  const dir = isBullish ? 'long' : (isBearish ? 'short' : (priceChange >= 0 ? 'long' : 'short'));

  const stopLoss = dir === 'long' ? Math.round(lowest * 0.992 * 100) / 100 : Math.round(highest * 1.008 * 100) / 100;
  const tp1 = dir === 'long' ? Math.round((latest.close + (latest.close - stopLoss) * 1.5) * 100) / 100 : Math.round((latest.close - (stopLoss - latest.close) * 1.5) * 100) / 100;

  const handleQuickTrade = async () => {
    setExecuting(true);
    await onExecuteTrade({
      symbol: selectedSymbol,
      direction: dir,
      price: latest.close,
      confidence: 0.82,
      stop_loss: stopLoss,
      tp_legs: [{ level: 1, price: tp1, close_fraction: 0.5 }]
    });
    setExecuting(false);
  };

  return (
    <div className="max-w-5xl space-y-4">
      {/* Chart Header Controls */}
      <div style={{ background: C.panel, border: \`1px solid \${C.hairline}\` }} className="rounded-lg p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold uppercase tracking-wider text-amber-500 mr-2 flex items-center gap-1">
            <Activity size={14} /> Coin:
          </span>
          {symbols.map(s => (
            <button key={s} onClick={() => setSelectedSymbol(s)}
              className="px-3 py-1 rounded text-xs font-display font-bold transition-all cursor-pointer"
              style={{
                background: selectedSymbol === s ? C.amber : C.panelAlt,
                color: selectedSymbol === s ? C.bg : C.paper,
                border: \`1px solid \${selectedSymbol === s ? C.amber : C.hairline}\`
              }}>
              {s}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-bold uppercase tracking-wider text-gray-400 mr-1">
            Timeframe:
          </span>
          {timeframes.map(t => (
            <button key={t} onClick={() => handleTfChange(t)}
              className="px-2.5 py-1 rounded text-xs font-mono-data font-semibold transition-all cursor-pointer"
              style={{
                background: tf === t ? '#3b82f6' : C.bg,
                color: tf === t ? '#ffffff' : C.muted,
                border: \`1px solid \${tf === t ? '#3b82f6' : C.hairline}\`
              }}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Chart Metrics Overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div style={{ background: C.panel, border: \`1px solid \${C.hairline}\` }} className="p-3.5 rounded-lg">
          <div className="text-[10px] uppercase font-mono-data" style={{ color: C.muted }}>Live {selectedSymbol} Price</div>
          <div className="text-lg font-mono-data font-bold mt-0.5" style={{ color: priceChange >= 0 ? C.long : C.short }}>
            $\${latest.close ? Number(latest.close).toFixed(latest.close > 10 ? 2 : 4) : '···'}
          </div>
          <div className="text-[11px] font-mono-data" style={{ color: priceChange >= 0 ? C.long : C.short }}>
            \${priceChange >= 0 ? '+' : ''}\${priceChange.toFixed(2)}% (\${tf})
          </div>
        </div>

        <div style={{ background: C.panel, border: \`1px solid \${C.hairline}\` }} className="p-3.5 rounded-lg">
          <div className="text-[10px] uppercase font-mono-data" style={{ color: C.muted }}>RSI(14) Indicator</div>
          <div className="text-lg font-mono-data font-bold mt-0.5" style={{ color: latest.rsi < 35 ? C.long : (latest.rsi > 65 ? C.short : C.amber) }}>
            \${latest.rsi || 50} \${latest.rsi < 35 ? '(Oversold)' : (latest.rsi > 65 ? '(Overbought)' : '(Neutral)')}
          </div>
          <div className="text-[11px] font-mono-data" style={{ color: C.muted }}>
            Timeframe: \${tf}
          </div>
        </div>

        <div style={{ background: C.panel, border: \`1px solid \${C.hairline}\` }} className="p-3.5 rounded-lg">
          <div className="text-[10px] uppercase font-mono-data" style={{ color: C.muted }}>\${tf} High / Low Range</div>
          <div className="text-xs font-mono-data mt-1" style={{ color: C.paper }}>
            H: $\${highest > 10 ? highest.toFixed(2) : highest.toFixed(4)}
          </div>
          <div className="text-xs font-mono-data" style={{ color: C.muted }}>
            L: $\${lowest > 10 ? lowest.toFixed(2) : lowest.toFixed(4)}
          </div>
        </div>

        <div style={{ background: C.panel, border: \`1px solid \${C.hairline}\` }} className="p-3.5 rounded-lg flex flex-col justify-between">
          <div className="text-[10px] uppercase font-mono-data" style={{ color: C.muted }}>SMC Bias (\${tf})</div>
          <div className="flex items-center gap-2 mt-1">
            <span className="px-2 py-0.5 rounded text-xs font-bold font-mono-data uppercase"
              style={{
                background: dir === 'long' ? \`\${C.long}22\` : \`\${C.short}22\`,
                color: dir === 'long' ? C.long : C.short,
                border: \`1px solid \${dir === 'long' ? C.long : C.short}\`
              }}>
              \${dir.toUpperCase()}
            </span>
            <button onClick={handleQuickTrade} disabled={executing}
              className="px-2.5 py-1 rounded text-xs font-bold transition-all disabled:opacity-50 ml-auto"
              style={{ background: dir === 'long' ? C.long : C.short, color: '#000' }}>
              {executing ? 'Executing…' : 'Auto Trade'}
            </button>
          </div>
        </div>
      </div>

      {/* Main K-Line Price Chart */}
      <div style={{ background: C.panel, border: \`1px solid \${C.hairline}\` }} className="rounded-lg p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider flex items-center gap-2" style={{ color: C.paper }}>
            <TrendingUp size={14} className="text-blue-400" />
            Real Bitget Market K-Lines (\${selectedSymbol} - \${tf})
          </h3>
          <span className="text-[10px] font-mono-data px-2 py-0.5 rounded" style={{ background: C.panelAlt, color: C.amber }}>
            Live Bitget Futures Feed
          </span>
        </div>

        {loading ? (
          <div className="h-64 flex items-center justify-center text-xs font-mono-data" style={{ color: C.muted }}>
            Fetching \${selectedSymbol} \${tf} candles from Bitget…
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={240}>
              <ComposedChart data={klinesData}>
                <defs>
                  <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="time" stroke={C.muted} fontSize={10} tickLine={false} />
                <YAxis domain={['dataMin', 'dataMax']} stroke={C.muted} fontSize={10} orientation="right"
                  tickFormatter={(v) => \`$\${v > 10 ? v.toFixed(1) : v.toFixed(3)}\`} />
                <Tooltip
                  contentStyle={{ background: C.panelAlt, border: \`1px solid \${C.hairline}\`, borderRadius: 6, fontSize: 11 }}
                  formatter={(val: any, name: string) => [\`$\${Number(val).toFixed(val > 10 ? 2 : 4)}\`, name === 'close' ? 'Close Price' : name]}
                />
                <ReferenceLine y={highest} stroke={C.short} strokeDasharray="3 3" label={{ value: 'High', fill: C.short, fontSize: 10 }} />
                <ReferenceLine y={lowest} stroke={C.long} strokeDasharray="3 3" label={{ value: 'Low', fill: C.long, fontSize: 10 }} />
                <Area type="monotone" dataKey="close" stroke="#3b82f6" strokeWidth={2} fill="url(#priceGrad)" />
              </ComposedChart>
            </ResponsiveContainer>

            {/* RSI Subchart */}
            <div className="pt-2 border-t" style={{ borderColor: C.hairline }}>
              <div className="text-[10px] font-mono-data mb-1 font-semibold flex justify-between" style={{ color: C.muted }}>
                <span>RSI(14) Momentum Indicator</span>
                <span>Value: \${latest.rsi || 50}</span>
              </div>
              <ResponsiveContainer width="100%" height={80}>
                <ComposedChart data={klinesData}>
                  <XAxis dataKey="time" hide />
                  <YAxis domain={[0, 100]} ticks={[30, 50, 70]} stroke={C.muted} fontSize={9} orientation="right" />
                  <ReferenceLine y={70} stroke={C.short} strokeDasharray="2 2" />
                  <ReferenceLine y={30} stroke={C.long} strokeDasharray="2 2" />
                  <Line type="monotone" dataKey="rsi" stroke={C.amber} strokeWidth={1.5} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
`;

// Insert LiveChart component before App definition
appCode = appCode.replace("export default function App() {", liveChartComponent + "\nexport default function App() {");

// Update TABS array to include 'chart' tab
const newTabsCode = `
  const TABS = activeStrat === 'quant_math' ? [
    { id: 'chart', label: '📈 K-Line Chart', count: null },
    { id: 'quant_hunter', label: '🧮 Quant Tape Hunter', count: null },
    { id: 'positions', label: 'Positions', count: openTrades.data?.length },
    { id: 'signals', label: 'Signals', count: null },
    { id: 'history', label: 'History', count: null },
    { id: 'logs', label: 'Logs', count: null, alert: hasErrorLogs },
    { id: 'connect', label: 'Connect', count: null, alert: false },
    { id: 'settings', label: 'Settings', count: null },
  ] : [
    { id: 'chart', label: '📈 K-Line Chart', count: null },
    { id: 'positions', label: 'Positions', count: openTrades.data?.length },
    { id: 'signals', label: 'Signals', count: null },
    { id: 'history', label: 'History', count: null },
    { id: 'logs', label: 'Logs', count: null, alert: hasErrorLogs },
    { id: 'connect', label: 'Connect', count: null, alert: false },
    { id: 'settings', label: 'Settings', count: null },
  ];
`;

const tabStart = appCode.indexOf("const TABS = activeStrat === 'quant_math'");
const tabEnd = appCode.indexOf("return (", tabStart);

if (tabStart !== -1 && tabEnd !== -1) {
  appCode = appCode.substring(0, tabStart) + newTabsCode + "\n  " + appCode.substring(tabEnd);
}

// Add handleTimeframeChange function inside App
const tfHandlerCode = `
  const handleTimeframeChange = async (newTf: string) => {
    setTimeframe(newTf);
    try {
      await apiPost(apiBase, '/api/settings', { timeframe: newTf });
      status.refetch().catch(() => {});
      signalsQ.refetch().catch(() => {});
    } catch (e) {
      console.error(e);
    }
  };
`;

appCode = appCode.replace("const [timeframe, setTimeframe] = useState('15m');", "const [timeframe, setTimeframe] = useState('15m');\n" + tfHandlerCode);

// Add tab render view for 'chart'
const chartTabRender = `
        {activeTab === 'chart' && (
          <LiveChart
            apiBase={apiBase}
            currentTimeframe={timeframe}
            onTimeframeChange={handleTimeframeChange}
            onExecuteTrade={handleExecuteTrade}
          />
        )}
`;

appCode = appCode.replace("{activeTab === 'quant_hunter' && (", chartTabRender + "\n        {activeTab === 'quant_hunter' && (");

// Update Settings dropdown to use handleTimeframeChange
appCode = appCode.replace(
  "onChange={(e) => setTimeframe(e.target.value)}",
  "onChange={(e) => handleTimeframeChange(e.target.value)}"
);

fs.writeFileSync('src/App.tsx', appCode, 'utf8');
console.log('Successfully added LiveChart component and synced timeframe');
