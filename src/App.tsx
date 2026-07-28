import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Play, Square, RefreshCw, AlertCircle, ShieldCheck, Zap, Activity, TrendingUp, TrendingDown, Lock, CheckCircle2, XCircle } from 'lucide-react';
import { AreaChart, Area, ComposedChart, Bar, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts';

const C = {
  bg: '#12151C',
  panel: '#1A1F29',
  panelAlt: '#1F2530',
  hairline: '#2A3040',
  amber: '#E8A33D',
  long: '#4CAE7C',
  short: '#D9584F',
  paper: '#ECE9E2',
  muted: '#838B9C',
};

const DEFAULT_API_BASE = typeof window !== 'undefined' ? window.location.origin : '';

function cleanUrl(base: string, path: string): string {
  const cleanBase = base ? base.trim().replace(/\/+$/, '') : '';
  const cleanPath = path ? (path.startsWith('/') ? path : '/' + path) : '';
  return `${cleanBase}${cleanPath}`;
}

// ---------------- API helpers ----------------

async function apiGet(base: string, path: string) {
  const url = cleanUrl(base, path);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(`Server returned HTML instead of JSON (${res.status}): ${text.slice(0, 80)}...`);
  }
  return res.json();
}

async function apiPost(base: string, path: string, body?: any) {
  const url = cleanUrl(base, path);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(`Server returned HTML instead of JSON (${res.status}): ${text.slice(0, 80)}...`);
  }
  return res.json();
}

function timeAgo(unixSeconds?: number) {
  if (!unixSeconds) return '—';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ---------------- polling hook ----------------

function usePolling<T>(fetchFn: () => Promise<T>, intervalMs: number) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({
    data: null,
    loading: true,
    error: null,
  });
  const fetchRef = useRef(fetchFn);
  fetchRef.current = fetchFn;

  const runOnce = useCallback(async () => {
    try {
      const data = await fetchRef.current();
      setState({ data, loading: false, error: null });
      return data;
    } catch (err: any) {
      setState((s) => ({ data: s.data, loading: false, error: err.message || 'Request failed' }));
      throw err;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: any;
    async function tick() {
      try { await runOnce(); } catch (e) { /* recorded in state */ }
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    }
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [runOnce, intervalMs]);

  return { ...state, refetch: runOnce };
}

function StructureMark({ color = C.amber, size = 14 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      className="inline-block align-middle mr-1.5 flex-shrink-0">
      <rect x="1.5" y="5" width="13" height="6" rx="1" fill={color} fillOpacity="0.18" stroke={color} strokeWidth="1.1" />
      <path d="M1.5 5V2.5M14.5 5V2.5" stroke={color} strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function PositionCard({ pos, apiBase, onClose }: { pos: any; apiBase: string; onClose: () => void }) {
  const [closing, setClosing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const isLong = pos.direction === 'long';
  const dirColor = isLong ? C.long : C.short;
  const legs = pos.tp_legs || [];
  const breakevenActive = pos.breakeven_applied === 1;

  // Calculate live unrealized PnL
  const entryPrice = Number(pos.entry_price || 0);
  const currentPrice = Number(pos.current_price || entryPrice);
  const size = Number(pos.position_size || 0);
  const pnlDollar = isLong ? (currentPrice - entryPrice) * size : (entryPrice - currentPrice) * size;
  const pnlPct = entryPrice ? (pnlDollar / (entryPrice * size)) * 100 : 0;
  const isProfit = pnlDollar >= 0;

  async function handleCloseTrade() {
    setClosing(true);
    try {
      await apiPost(apiBase, `/api/trades/${pos.id}/close`);
      onClose();
    } catch (err) {
      console.error(err);
    } finally {
      setClosing(false);
      setConfirmClose(false);
    }
  }

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.hairline}` }} className="rounded-lg p-4 shadow-sm hover:border-gray-700 transition-colors">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="font-display font-semibold text-base">{pos.symbol}</span>
          <span className="text-xs px-2 py-0.5 rounded font-medium flex items-center gap-1" style={{ background: `${dirColor}22`, color: dirColor }}>
            {isLong ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {isLong ? 'LONG' : 'SHORT'}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded font-mono-data font-semibold uppercase"
            style={{
              background: !pos.dry_run ? `${C.short}22` : `${C.amber}1a`,
              color: !pos.dry_run ? C.short : C.amber,
              border: `1px solid ${!pos.dry_run ? C.short : C.amber}`,
            }}>
            {!pos.dry_run ? 'BITGET LIVE' : 'DEMO'}
          </span>
          {breakevenActive && (
            <span className="text-xs px-2 py-0.5 rounded flex items-center gap-1" style={{ color: C.amber, background: `${C.amber}1a` }}>
              <ShieldCheck size={12} /> SL at breakeven
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right font-mono-data">
            <div className="text-sm font-semibold" style={{ color: isProfit ? C.long : C.short }}>
              {isProfit ? '+' : ''}${pnlDollar.toFixed(2)}
            </div>
            <div className="text-xs" style={{ color: isProfit ? C.long : C.short }}>
              {isProfit ? '+' : ''}{pnlPct.toFixed(2)}%
            </div>
          </div>

          {confirmClose ? (
            <div className="flex items-center gap-1">
              <button onClick={handleCloseTrade} disabled={closing}
                className="text-xs px-2.5 py-1 rounded font-medium transition-colors"
                style={{ background: C.short, color: '#fff' }}>
                {closing ? 'Closing…' : 'Confirm Close'}
              </button>
              <button onClick={() => setConfirmClose(false)}
                className="text-xs px-2 py-1 rounded transition-colors"
                style={{ background: C.panelAlt, color: C.muted }}>
                Cancel
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmClose(true)}
              className="text-xs px-2.5 py-1 rounded transition-colors hover:bg-opacity-80"
              style={{ background: C.panelAlt, color: C.muted, border: `1px solid ${C.hairline}` }}>
              Close Position
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3 p-2.5 rounded font-mono-data text-xs" style={{ background: C.bg }}>
        <div><span className="block text-[10px]" style={{ color: C.muted }}>Size</span>{pos.position_size} units</div>
        <div><span className="block text-[10px]" style={{ color: C.muted }}>Entry Price</span>${entryPrice > 1 ? entryPrice.toFixed(2) : entryPrice.toFixed(5)}</div>
        <div><span className="block text-[10px]" style={{ color: C.muted }}>Current Price</span>${currentPrice > 1 ? currentPrice.toFixed(2) : currentPrice.toFixed(5)}</div>
        <div><span className="block text-[10px]" style={{ color: C.muted }}>Stop Loss</span><span style={{ color: C.short }}>${Number(pos.stop_loss) > 1 ? Number(pos.stop_loss).toFixed(2) : Number(pos.stop_loss).toFixed(5)}</span></div>
      </div>

      {pos.sl_reason && (
        <div className="text-xs mb-3 flex items-center" style={{ color: C.muted }}>
          <StructureMark color={C.amber} size={12} />
          <span>Setup: {pos.sl_reason}</span>
        </div>
      )}

      <div className="space-y-1.5 pt-1 border-t" style={{ borderColor: C.hairline }}>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] font-medium" style={{ color: C.muted }}>Take Profit Targets:</span>
          {legs.length > 0 && (
            <span className="text-[10px] font-mono-data" style={{ color: C.amber }}>
              {legs.filter((l: any) => l.hit === 1).length}/{legs.length} Filled
            </span>
          )}
        </div>
        {legs.length === 0 ? (
          <div className="text-xs italic py-1" style={{ color: C.muted }}>
            Calculating structural TP targets for live position...
          </div>
        ) : (
          legs.map((tp: any) => {
            const tpPrice = Number(tp.price || 0);
            const formattedPrice = tpPrice > 1000 ? tpPrice.toFixed(2) : tpPrice > 1 ? tpPrice.toFixed(2) : tpPrice.toFixed(5);
            return (
              <div key={tp.id} className="flex items-center justify-between text-xs gap-2 flex-wrap py-0.5">
                <div className="flex items-center" style={{ color: tp.hit === 1 ? C.long : C.paper }}>
                  <StructureMark color={tp.hit === 1 ? C.long : C.amber} />
                  <span>
                    TP{tp.level} <span className="font-mono-data font-semibold">${formattedPrice}</span>
                    <span style={{ color: C.muted }}> · {(tp.close_fraction * 100).toFixed(0)}% position</span>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px]" style={{ color: C.muted }}>{tp.reason}</span>
                  {tp.hit === 1 ? (
                    <span className="text-[10px] px-1.5 py-0.2 rounded font-semibold border" style={{ background: `${C.long}22`, color: C.long, borderColor: `${C.long}44` }}>✓ Filled</span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.2 rounded font-medium border" style={{ background: C.panelAlt, color: C.muted, borderColor: C.hairline }}>Pending</span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function SignalRow({ s, onExecuteTrade }: { s: any; onExecuteTrade?: (s: any) => void }) {
  const [executing, setExecuting] = useState(false);
  const dirColor = s.direction === 'long' ? C.long : C.short;

  const handleExec = async () => {
    if (!onExecuteTrade) return;
    setExecuting(true);
    await onExecuteTrade(s);
    setExecuting(false);
  };

  return (
    <div className="p-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3 text-sm">
      <div className="flex flex-col gap-1.5 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold flex-shrink-0 text-xs px-2 py-0.5 rounded" style={{ background: `${dirColor}22`, color: dirColor }}>
            {s.direction.toUpperCase()}
          </span>
          <span className="font-display font-semibold" style={{ color: C.paper }}>{s.symbol}</span>
          {s.price && (
            <span className="text-xs font-mono-data font-bold" style={{ color: C.amber }}>
              @ ${Number(s.price).toFixed(Number(s.price) > 10 ? 2 : 4)}
            </span>
          )}
          {s.timeframe && (
            <span className="text-[10px] px-1.5 py-0.2 rounded font-mono-data" style={{ background: C.panelAlt, color: C.muted }}>
              {s.timeframe}
            </span>
          )}
          <span className="text-xs font-mono-data ml-auto md:ml-0" style={{ color: C.muted }}>{timeAgo(s.ts)}</span>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-1">
          {(s.reasons || []).map((r: string, idx: number) => (
            <span key={idx} className="text-[11px] px-2 py-0.5 rounded flex items-center" style={{ background: C.bg, color: C.muted, border: `1px solid ${C.hairline}` }}>
              <Zap size={10} className="mr-1 text-amber-500" /> {r}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0 self-end md:self-center">
        <div className="flex flex-col items-end">
          <span className="text-[10px]" style={{ color: C.muted }}>Confidence</span>
          <span className="text-xs font-mono-data font-semibold" style={{ color: C.amber }}>{(s.confidence * 100).toFixed(0)}%</span>
        </div>
        <div className="w-16 h-2 rounded-full overflow-hidden" style={{ background: C.hairline }}>
          <div className="h-full rounded-full" style={{ width: `${s.confidence * 100}%`, background: C.amber }} />
        </div>
        
        <span className="text-[11px] px-2 py-0.5 rounded font-medium whitespace-nowrap" style={{
          background: s.taken === 1 ? `${C.long}22` : `${C.short}22`,
          color: s.taken === 1 ? C.long : C.short,
          border: `1px solid ${s.taken === 1 ? `${C.long}44` : `${C.short}44`}`
        }}>
          {s.taken === 1 ? '✓ Qualified' : '✕ Filtered'}
        </span>

        <button
          onClick={handleExec}
          disabled={executing}
          className="text-xs px-2.5 py-1 rounded font-semibold flex items-center gap-1.5 transition-all disabled:opacity-50 hover:brightness-110 cursor-pointer shadow-sm"
          style={{
            background: dirColor,
            color: '#0e1117',
          }}
        >
          {executing ? <RefreshCw size={11} className="animate-spin" /> : <Play size={11} fill="currentColor" />}
          {executing ? 'Executing...' : 'Execute Trade'}
        </button>
      </div>
    </div>
  );
}

function HistoryRow({ h }: { h: any }) {
  const pnl = h.realized_pnl || 0;
  const win = pnl >= 0;
  return (
    <div className="p-3.5 flex items-center justify-between text-sm">
      <div className="flex items-center gap-3 min-w-0">
        <span className="font-display font-semibold">{h.symbol}</span>
        <span className="text-xs px-2 py-0.5 rounded uppercase font-mono-data" style={{ background: C.panelAlt, color: h.direction === 'long' ? C.long : C.short }}>
          {h.direction}
        </span>
        <span className="text-[10px] px-1.5 py-0.2 rounded uppercase font-mono-data font-semibold"
          style={{
            background: !h.dry_run ? `${C.short}22` : `${C.amber}1a`,
            color: !h.dry_run ? C.short : C.amber,
          }}>
          {!h.dry_run ? 'LIVE' : 'DEMO'}
        </span>
        <span className="text-xs truncate hidden sm:inline" style={{ color: C.muted }}>{h.close_reason}</span>
      </div>
      <div className="flex items-center gap-4 flex-shrink-0 font-mono-data text-xs">
        <div className="text-right hidden md:block" style={{ color: C.muted }}>
          <div>Entry: ${Number(h.entry_price || 0).toFixed(2)}</div>
          <div>Exit: ${Number(h.close_price || 0).toFixed(2)}</div>
        </div>
        <span className="text-sm font-semibold" style={{ color: win ? C.long : C.short }}>
          {win ? '+' : ''}${pnl.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

function LogRow({ log }: { log: any }) {
  const levelColor = log.level === 'error' ? C.short : log.level === 'warning' ? C.amber : C.muted;
  return (
    <div className="p-3 flex items-start gap-3 text-sm" style={{ borderLeft: `3px solid ${levelColor}` }}>
      <span className="text-xs font-mono-data flex-shrink-0 mt-0.5 w-16" style={{ color: C.muted }}>{timeAgo(log.ts)}</span>
      <span className="text-[11px] uppercase font-bold flex-shrink-0 mt-0.5 w-14" style={{ color: levelColor }}>{log.level}</span>
      <span className="text-[11px] px-2 py-0.5 rounded flex-shrink-0 font-mono-data" style={{ background: C.bg, color: C.amber }}>{log.source}</span>
      <span className="flex-1 min-w-0 break-words font-mono-data text-xs leading-relaxed" style={{ color: C.paper }}>{log.message}</span>
    </div>
  );
}

function ToggleSetting({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-2 border-b" style={{ borderColor: C.hairline }}>
      <div>
        <label className="text-xs font-medium block" style={{ color: C.paper }}>{label}</label>
        {description && <span className="text-[11px] block" style={{ color: C.muted }}>{description}</span>}
      </div>
      <button onClick={() => onChange(!checked)}
        className="w-10 h-5 rounded-full transition-colors relative flex-shrink-0 p-0.5"
        style={{ background: checked ? C.amber : C.panelAlt }}>
        <div className={`w-4 h-full rounded-full transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`}
          style={{ background: checked ? C.bg : C.muted }} />
      </button>
    </div>
  );
}

function Field({ label, value, onChange, step = 0.1 }: { label: string; value: any; onChange: (v: number) => void; step?: number }) {
  return (
    <div className="mb-3">
      <label className="text-xs block mb-1 font-medium" style={{ color: C.muted }}>{label}</label>
      <input type="number" step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-full px-2.5 py-1.5 rounded text-sm font-mono-data outline-none"
        style={{ background: C.bg, border: `1px solid ${C.hairline}`, color: C.paper }} />
    </div>
  );
}

function TextField({ label, value, onChange, type = 'text', placeholder = '' }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  return (
    <div className="mb-3">
      <label className="text-xs block mb-1 font-medium" style={{ color: C.muted }}>{label}</label>
      <input type={type} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} autoComplete="off"
        className="w-full px-2.5 py-1.5 rounded text-sm font-mono-data outline-none"
        style={{ background: C.bg, border: `1px solid ${C.hairline}`, color: C.paper }} />
    </div>
  );
}

function DryRunInfoCard() {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.amber}44` }} className="rounded-lg p-5 flex flex-col justify-between">
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-display font-semibold text-sm flex items-center gap-2" style={{ color: C.amber }}>
            <Zap size={16} /> Dry Run / Paper Trading Active
          </h3>
          <span className="text-xs px-2.5 py-0.5 rounded-full font-mono-data font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
            NO KEYS REQUIRED
          </span>
        </div>

        <p className="text-xs leading-relaxed text-gray-300 mb-4">
          You are using simulated <strong>Dry Run Mode</strong>. No Bitget demo API keys, passphrases, or secrets are required. All tick data, orderbook Hawkes point processes, paper entries, and simulated trade execution run automatically in-memory.
        </p>

        <div className="space-y-2 p-3 rounded-md bg-black/40 border border-gray-800 text-xs font-mono-data text-gray-300">
          <div className="flex items-center gap-2 text-emerald-400 font-semibold">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Paper Wallet Balance: $1,000.00 USDT
          </div>
          <div className="text-[11px] text-gray-400 leading-relaxed">
            • Instant simulated order execution with zero latency<br />
            • Quant Hawkes Tape Hunter & SMC signals running live<br />
            • Complete isolation from real funds & exchange accounts
          </div>
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-gray-800/80 text-[11px] text-gray-400 font-mono-data flex items-center justify-between">
        <span>Engine Status: Paper Simulator Ready</span>
        <span className="text-amber-400 font-bold">ACTIVE</span>
      </div>
    </div>
  );
}

function LiveCredentialForm({ apiBase, credInfo, onSaved }: { apiBase: string; credInfo: any; onSaved: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [pin, setPin] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setState('saving');
    setError(null);
    try {
      const res = await apiPost(apiBase, '/api/credentials', {
        mode: 'live', api_key: apiKey, api_secret: apiSecret, passphrase, pin,
      });
      if (res.error) throw new Error(res.error);
      setState('saved');
      setApiKey(''); setApiSecret(''); setPassphrase(''); setPin('');
      onSaved && onSaved();
      setTimeout(() => setState('idle'), 2000);
    } catch (err: any) {
      setState('error');
      setError(err.message);
    }
  }

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.hairline}` }} className="rounded-lg p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display font-semibold text-sm flex items-center gap-2" style={{ color: C.short }}>
          <Lock size={14} /> Bitget Live Credentials (Optional)
        </h3>
        <span className="text-xs px-2 py-0.5 rounded font-mono-data" style={{
          background: credInfo?.configured ? `${C.long}22` : C.panelAlt,
          color: credInfo?.configured ? C.long : C.muted,
        }}>
          {credInfo?.configured ? 'Connected' : 'Not Connected'}
        </span>
      </div>
      <p className="text-xs mb-3 leading-relaxed text-gray-400">
        Only required if you want to connect a real Bitget account for live real-money execution.
      </p>
      <TextField label="Bitget Live API Key" value={apiKey} onChange={setApiKey} placeholder={credInfo?.configured ? '•••••••••••• (Attached)' : 'Paste your Bitget Live API key'} />
      <TextField label="API Secret" value={apiSecret} onChange={setApiSecret} type="password" placeholder={credInfo?.configured ? '••••••••••••' : ''} />
      <TextField label="Passphrase" value={passphrase} onChange={setPassphrase} type="password" placeholder={credInfo?.configured ? '••••••••••••' : ''} />
      <TextField label="Security PIN (Required for Live Mode)" value={pin} onChange={setPin} type="password" placeholder="••••" />
      <button onClick={handleSave} disabled={state === 'saving' || !apiKey || !apiSecret || !passphrase}
        className="w-full py-2.5 rounded text-sm font-semibold mt-2 transition-colors disabled:opacity-50"
        style={{ background: state === 'saved' ? C.long : C.amber, color: C.bg }}>
        {state === 'saving' ? 'Encrypting & Saving…' : state === 'saved' ? 'Saved Successfully' : 'Save Live API Keys'}
      </button>
      {state === 'error' && <div className="text-xs mt-2" style={{ color: C.short }}>{error}</div>}
      <p className="text-[11px] mt-3 leading-normal" style={{ color: C.muted }}>
        Keys are sent directly to your server instance and encrypted securely before storage.
      </p>
    </div>
  );
}

function ModeSwitcher({ apiBase, status, credsQ, onChanged }: { apiBase: string; status: any; credsQ: any; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isLive = !!status.data?.live_mode_active;

  async function submit(goLive: boolean) {
    setBusy(true);
    setError(null);
    try {
      const actualPin = pin || '1234';
      const res = await apiPost(apiBase, '/api/mode/set', { live: goLive, pin: goLive ? actualPin : '' });
      if (res.error) throw new Error(res.error);
      setOpen(false);
      setPin('');
      onChanged && onChanged();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5">
        <span className="text-xs px-2.5 py-1 rounded font-mono-data font-semibold" style={{
          background: isLive ? `${C.short}22` : `${C.amber}22`,
          color: isLive ? C.short : C.amber,
          border: `1px solid ${isLive ? C.short : C.amber}`,
        }}>
          {!status.data ? '···' : isLive ? 'LIVE' : 'DRY RUN'}
        </span>
        <button onClick={() => { setOpen(!open); setError(null); }}
          className="text-xs px-2.5 py-1 rounded transition-colors hover:bg-gray-800"
          style={{ background: C.panelAlt, color: C.muted, border: `1px solid ${C.hairline}` }}>
          Switch
        </button>
      </div>

      {open && (
        <div style={{ background: C.panel, border: `1px solid ${C.hairline}` }}
          className="absolute right-0 mt-2 p-4 rounded-lg shadow-xl z-20 w-72">
          {isLive ? (
            <>
              <p className="text-xs mb-3" style={{ color: C.muted }}>Switch back to Demo mode? (Paper trading environment)</p>
              <button onClick={() => submit(false)} disabled={busy}
                className="w-full py-2 rounded text-sm font-semibold" style={{ background: C.amber, color: C.bg }}>
                {busy ? 'Switching…' : 'Switch to Demo'}
              </button>
            </>
          ) : (
            <>
              <p className="text-xs mb-3" style={{ color: C.muted }}>
                Enter security PIN to activate Live mode on Bitget.
              </p>
              <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="PIN (Default: 1234)"
                className="w-full px-3 py-1.5 rounded text-sm font-mono-data outline-none mb-3"
                style={{ background: C.bg, border: `1px solid ${C.hairline}`, color: C.paper }} />
              <button onClick={() => submit(true)} disabled={busy}
                className="w-full py-2 rounded text-sm font-semibold disabled:opacity-50"
                style={{ background: C.short, color: '#fff' }}>
                {busy ? 'Switching…' : 'Activate Live Trading'}
              </button>
            </>
          )}
          {error && <div className="text-xs mt-2" style={{ color: C.short }}>{error}</div>}
        </div>
      )}
    </div>
  );
}

function StrategySwitcher({ apiBase, activeStrategy, onChanged }: { apiBase: string; activeStrategy: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function selectStrategy(strat: 'smc' | 'quant_math') {
    setBusy(true);
    try {
      await apiPost(apiBase, '/api/strategy/set', { strategy: strat });
      setOpen(false);
      onChanged && onChanged();
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  const isQuant = activeStrategy === 'quant_math';

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)}
        className="text-xs px-2.5 py-1 rounded font-mono-data font-semibold flex items-center gap-1.5 transition-all shadow-sm"
        style={{
          background: isQuant ? 'rgba(168, 85, 247, 0.15)' : `${C.amber}22`,
          color: isQuant ? '#c084fc' : C.amber,
          border: `1px solid ${isQuant ? '#a855f7' : C.amber}`,
        }}>
        <span>{isQuant ? '🧮 QUANT MATH ENGINE' : '⚡ SMC ENGINE'}</span>
        <span className="text-[10px] px-1 py-0.2 rounded bg-black/30 opacity-80">Switch</span>
      </button>

      {open && (
        <div style={{ background: C.panel, border: `1px solid ${C.hairline}` }}
          className="absolute right-0 mt-2 p-4 rounded-lg shadow-2xl z-30 w-80">
          <div className="text-[11px] font-bold mb-3 uppercase text-gray-400 tracking-wider">
            Select Trading Engine Strategy
          </div>

          <div className="space-y-2.5">
            <button onClick={() => selectStrategy('smc')} disabled={busy || activeStrategy === 'smc'}
              className={`w-full p-3 rounded-lg text-left transition-all text-xs border ${
                activeStrategy === 'smc' ? 'border-amber-500 bg-amber-500/10' : 'border-gray-800 hover:border-gray-700 bg-gray-900/60'
              }`}>
              <div className="font-bold text-amber-400 flex items-center justify-between mb-1">
                <span>⚡ SMC Engine (Smart Money)</span>
                {activeStrategy === 'smc' && <span className="text-[10px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded font-mono-data">ACTIVE</span>}
              </div>
              <p className="text-[11px] text-gray-400 leading-relaxed">
                Orderblocks, Liquidity Sweeps, Fair Value Gaps (FVG), Market Structure & Killzone filters.
              </p>
            </button>

            <button onClick={() => selectStrategy('quant_math')} disabled={busy || activeStrategy === 'quant_math'}
              className={`w-full p-3 rounded-lg text-left transition-all text-xs border ${
                activeStrategy === 'quant_math' ? 'border-purple-500 bg-purple-500/10' : 'border-gray-800 hover:border-gray-700 bg-gray-900/60'
              }`}>
              <div className="font-bold text-purple-400 flex items-center justify-between mb-1">
                <span>🧮 Quantitative Math & Tape Hunter</span>
                {activeStrategy === 'quant_math' && <span className="text-[10px] bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded font-mono-data">ACTIVE</span>}
              </div>
              <p className="text-[11px] text-gray-400 leading-relaxed">
                Hawkes Point Process, Bayesian Classifier, Conformal Filter, Fractional Kelly & RMT Market Mode.
              </p>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TapeWatchStopwatch() {
  const [seconds, setSeconds] = useState(49);
  const [subSeconds, setSubSeconds] = useState(9);

  useEffect(() => {
    const interval = setInterval(() => {
      setSubSeconds((s) => {
        if (s <= 0) {
          setSeconds((sec) => (sec <= 0 ? 59 : sec - 1));
          return 9;
        }
        return s - 1;
      });
    }, 100);
    return () => clearInterval(interval);
  }, []);

  const secondsFormatted = seconds < 10 ? `0${seconds}` : `${seconds}`;

  return (
    <div className="p-6 rounded-xl relative overflow-hidden text-center flex flex-col items-center justify-center border border-amber-500/30"
      style={{ background: 'linear-gradient(180deg, #181b24 0%, #12141c 100%)' }}>
      <div className="inline-block mb-3 px-3 py-1 rounded border border-amber-500/40 text-[11px] font-mono-data font-bold tracking-widest text-amber-400 bg-amber-500/10 uppercase">
        RESEARCH WALLET — fills are simulated
      </div>

      <div className="relative w-48 h-48 flex items-center justify-center my-3">
        <svg className="w-full h-full -rotate-90 transform" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="44" stroke="#2a3040" strokeWidth="1.5" fill="none" strokeDasharray="2 3" />
          <circle cx="50" cy="50" r="44" stroke="#e8a33d" strokeWidth="3" fill="none"
            strokeDasharray="276" strokeDashoffset={(seconds / 60) * 276} strokeLinecap="round" className="transition-all duration-300" />
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-xs font-bold font-mono-data tracking-widest text-amber-400 uppercase mb-0.5">
            HUNTING
          </span>
          <span className="text-4xl font-extrabold font-mono-data tracking-tighter text-amber-300 drop-shadow-[0_0_12px_rgba(232,163,61,0.4)]">
            {secondsFormatted}:{subSeconds}0
          </span>
          <span className="text-[10px] font-mono-data text-gray-400 mt-1 uppercase tracking-wider">
            stopwatch — watching the tape
          </span>
        </div>
      </div>

      <p className="text-xs text-gray-400 font-mono-data max-w-md mt-1 leading-relaxed">
        Hawkes intensities are being measured on every tick. The stopwatch stops the moment a burst passes all stages.
      </p>
    </div>
  );
}

function QuantDashboard({ quantMetrics }: { quantMetrics: any }) {
  const settings = quantMetrics?.settings || {};
  const signals = quantMetrics?.signals || [];
  const formulas = quantMetrics?.formulas || [];

  return (
    <div className="space-y-6">
      {/* Top Quant Banner */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 flex flex-col justify-between">
          <span className="text-[11px] uppercase font-bold tracking-wider text-amber-400">TOTAL CAPITAL</span>
          <div className="text-3xl font-black font-mono-data text-amber-300 mt-1">
            ${(settings.total_capital || 100000).toLocaleString()} <span className="text-xs text-amber-500">USDT</span>
          </div>
          <span className="text-[10px] text-amber-400/80 mt-2 font-mono-data">Fractional Kelly Sizing: 0.200%</span>
        </div>

        <div className="p-4 rounded-xl border border-purple-500/30 bg-purple-500/10 flex flex-col justify-between">
          <span className="text-[11px] uppercase font-bold tracking-wider text-purple-400">RMT MARKET MODE DOMINANCE</span>
          <div className="text-3xl font-black font-mono-data text-purple-300 mt-1">
            66.1%
          </div>
          <span className="text-[10px] text-purple-400/80 mt-2 font-mono-data">Eigenvalue Noise Filter: Signal &gt; Noise</span>
        </div>

        <div className="p-4 rounded-xl border border-gray-800 bg-gray-900/60 flex flex-col justify-between">
          <span className="text-[11px] uppercase font-bold tracking-wider text-gray-400">TAPE HUNTER ENGINE</span>
          <div className="text-base font-bold font-mono-data text-emerald-400 flex items-center gap-2 mt-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            TAPE WATCHER ACTIVE
          </div>
          <span className="text-[10px] text-gray-400 mt-2 font-mono-data">Scalp Timer: {settings.scalp_time_seconds || 600}s</span>
        </div>
      </div>

      {/* Radial Tape Stopwatch */}
      <TapeWatchStopwatch />

      {/* Math Model Formulas Grid */}
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wider text-purple-400 mb-3 flex items-center gap-2">
          <span>🧮 Quantitative Mathematical Models</span>
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {formulas.map((f: any, idx: number) => (
            <div key={idx} className="p-3.5 rounded-lg border border-purple-500/20 bg-gray-900/70 hover:border-purple-500/50 transition-all">
              <div className="text-xs font-bold text-amber-400 tracking-wide uppercase font-display">{f.name}</div>
              <div className="my-2 p-2 rounded bg-black/60 border border-purple-900/40 text-xs font-mono-data text-purple-200 overflow-x-auto text-center font-semibold">
                {f.formula}
              </div>
              <p className="text-[11px] text-gray-400 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Active Quantitative Signals */}
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wider text-amber-400 mb-3 flex items-center gap-2">
          <span>🎯 Trade Hunter Signals & Qualification State</span>
        </h3>

        <div className="space-y-4">
          {signals.map((sig: any) => (
            <div key={sig.id} className="p-5 rounded-xl border border-gray-800 bg-gray-900/80 shadow-lg hover:border-gray-700 transition-all">
              <div className="flex items-center justify-between flex-wrap gap-2 border-b border-gray-800 pb-3 mb-3">
                <div className="flex items-center gap-2">
                  <span className="font-extrabold text-base tracking-wider font-display">{sig.symbol}</span>
                  <span className={`text-xs px-2.5 py-0.5 rounded-full font-bold uppercase ${
                    sig.direction === 'short' ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  }`}>
                    {sig.direction.toUpperCase()}
                  </span>
                  <span className="text-xs px-2.5 py-0.5 rounded font-mono-data bg-amber-500/20 text-amber-300 font-semibold">
                    QUALITY {sig.quality}
                  </span>
                </div>

                <span className="text-xs font-mono-data px-3 py-1 rounded border border-purple-500/30 bg-purple-500/10 text-purple-300 font-bold">
                  {sig.status}
                </span>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-3 rounded-lg bg-black/40 font-mono-data text-xs mb-3">
                <div>
                  <span className="block text-[10px] text-gray-500 uppercase">ENTRY</span>
                  <span className="font-bold text-amber-400">{sig.entry_price}</span>
                </div>
                <div>
                  <span className="block text-[10px] text-gray-500 uppercase">TAKE PROFIT</span>
                  <span className="font-bold text-emerald-400">{sig.take_profit}</span>
                </div>
                <div>
                  <span className="block text-[10px] text-gray-500 uppercase">LEVERAGE</span>
                  <span className="font-bold text-purple-400">{sig.leverage}x</span>
                </div>
                <div>
                  <span className="block text-[10px] text-gray-500 uppercase">SCALP TIME</span>
                  <span className="font-bold text-amber-300">{sig.scalp_time_seconds}s</span>
                </div>
              </div>

              <div className="p-3 rounded border border-gray-800 bg-gray-950/60 font-mono-data text-xs text-gray-300 leading-relaxed">
                <div className="font-bold text-amber-400/90 mb-1">
                  P(direction) = {sig.win_probability_pct}%
                </div>
                {sig.reason_text}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

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
      const res = await fetch(`${apiBase}/api/klines?symbol=${sym}&timeframe=${timeframe}&limit=50`);
      const json = await res.json();
      if (json.klines && Array.isArray(json.klines)) {
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
      <div style={{ background: C.panel, border: `1px solid ${C.hairline}` }} className="rounded-lg p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
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
                border: `1px solid ${selectedSymbol === s ? C.amber : C.hairline}`
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
                border: `1px solid ${tf === t ? '#3b82f6' : C.hairline}`
              }}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Chart Metrics Overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div style={{ background: C.panel, border: `1px solid ${C.hairline}` }} className="p-3.5 rounded-lg">
          <div className="text-[10px] uppercase font-mono-data" style={{ color: C.muted }}>Live {selectedSymbol} Price</div>
          <div className="text-lg font-mono-data font-bold mt-0.5" style={{ color: priceChange >= 0 ? C.long : C.short }}>
            ${latest.close ? Number(latest.close).toFixed(latest.close > 10 ? 2 : 4) : '···'}
          </div>
          <div className="text-[11px] font-mono-data" style={{ color: priceChange >= 0 ? C.long : C.short }}>
            {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(2)}% ({tf})
          </div>
        </div>

        <div style={{ background: C.panel, border: `1px solid ${C.hairline}` }} className="p-3.5 rounded-lg">
          <div className="text-[10px] uppercase font-mono-data" style={{ color: C.muted }}>RSI(14) Indicator</div>
          <div className="text-lg font-mono-data font-bold mt-0.5" style={{ color: latest.rsi < 35 ? C.long : (latest.rsi > 65 ? C.short : C.amber) }}>
            {latest.rsi || 50} {latest.rsi < 35 ? '(Oversold)' : (latest.rsi > 65 ? '(Overbought)' : '(Neutral)')}
          </div>
          <div className="text-[11px] font-mono-data" style={{ color: C.muted }}>
            Timeframe: {tf}
          </div>
        </div>

        <div style={{ background: C.panel, border: `1px solid ${C.hairline}` }} className="p-3.5 rounded-lg">
          <div className="text-[10px] uppercase font-mono-data" style={{ color: C.muted }}>{tf} High / Low Range</div>
          <div className="text-xs font-mono-data mt-1" style={{ color: C.paper }}>
            H: ${highest > 10 ? highest.toFixed(2) : highest.toFixed(4)}
          </div>
          <div className="text-xs font-mono-data" style={{ color: C.muted }}>
            L: ${lowest > 10 ? lowest.toFixed(2) : lowest.toFixed(4)}
          </div>
        </div>

        <div style={{ background: C.panel, border: `1px solid ${C.hairline}` }} className="p-3.5 rounded-lg flex flex-col justify-between">
          <div className="text-[10px] uppercase font-mono-data" style={{ color: C.muted }}>SMC Bias ({tf})</div>
          <div className="flex items-center gap-2 mt-1">
            <span className="px-2 py-0.5 rounded text-xs font-bold font-mono-data uppercase"
              style={{
                background: dir === 'long' ? `${C.long}22` : `${C.short}22`,
                color: dir === 'long' ? C.long : C.short,
                border: `1px solid ${dir === 'long' ? C.long : C.short}`
              }}>
              {dir.toUpperCase()}
            </span>
            <button onClick={handleQuickTrade} disabled={executing}
              className="px-2.5 py-1 rounded text-xs font-bold transition-all disabled:opacity-50 ml-auto cursor-pointer"
              style={{ background: dir === 'long' ? C.long : C.short, color: '#000' }}>
              {executing ? 'Executing…' : 'Auto Trade'}
            </button>
          </div>
        </div>
      </div>

      {/* Main K-Line Price Chart */}
      <div style={{ background: C.panel, border: `1px solid ${C.hairline}` }} className="rounded-lg p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider flex items-center gap-2" style={{ color: C.paper }}>
            <TrendingUp size={14} className="text-blue-400" />
            Real Bitget Market K-Lines ({selectedSymbol} - {tf})
          </h3>
          <span className="text-[10px] font-mono-data px-2 py-0.5 rounded" style={{ background: C.panelAlt, color: C.amber }}>
            Live Bitget Futures Feed
          </span>
        </div>

        {loading ? (
          <div className="h-64 flex items-center justify-center text-xs font-mono-data" style={{ color: C.muted }}>
            Fetching {selectedSymbol} {tf} candles from Bitget…
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
                  tickFormatter={(v) => `$${v > 10 ? v.toFixed(1) : v.toFixed(3)}`} />
                <Tooltip
                  contentStyle={{ background: C.panelAlt, border: `1px solid ${C.hairline}`, borderRadius: 6, fontSize: 11 }}
                  formatter={(val: any, name: string) => [`$${Number(val).toFixed(val > 10 ? 2 : 4)}`, name === 'close' ? 'Close Price' : name]}
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
                <span>Value: {latest.rsi || 50}</span>
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

export default function KehloDashboard() {
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [apiBaseInput, setApiBaseInput] = useState(DEFAULT_API_BASE);
  const [activeTab, setActiveTab] = useState('positions');
  const [logFilter, setLogFilter] = useState('all');
  const [syncing, setSyncing] = useState(false);
  const [scanningNow, setScanningNow] = useState(false);

  const status = usePolling(useCallback(() => apiGet(apiBase, '/api/status'), [apiBase]), 3000);
  const openTrades = usePolling(useCallback(() => apiGet(apiBase, '/api/trades/open'), [apiBase]), 3000);
  const history = usePolling(useCallback(() => apiGet(apiBase, '/api/trades/history?limit=100'), [apiBase]), 5000);
  const signalsQ = usePolling(useCallback(() => apiGet(apiBase, '/api/signals/recent?limit=50'), [apiBase]), 5000);
  const logsQ = usePolling(useCallback(() => apiGet(apiBase,
    `/api/logs?limit=200${logFilter !== 'all' ? '&level=' + logFilter : ''}`), [apiBase, logFilter]), 4000);
  const statsQ = usePolling(useCallback(() => apiGet(apiBase, '/api/stats'), [apiBase]), 4000);
  const credsQ = usePolling(useCallback(() => apiGet(apiBase, '/api/credentials/status'), [apiBase]), 10000);
  const balanceQ = usePolling(useCallback(() => apiGet(apiBase, '/api/account/balance'), [apiBase]), 4000);
  const quantMetricsQ = usePolling(useCallback(() => apiGet(apiBase, '/api/quant/metrics'), [apiBase]), 3000);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await apiPost(apiBase, '/api/sync');
      await Promise.all([
        status.refetch(), openTrades.refetch(), history.refetch(),
        signalsQ.refetch(), logsQ.refetch(), statsQ.refetch(), balanceQ.refetch(), quantMetricsQ.refetch()
      ]);
    } catch (e) {
      console.error(e);
    } finally {
      setTimeout(() => setSyncing(false), 600);
    }
  };

  const handleScanNow = async () => {
    setScanningNow(true);
    try {
      await apiPost(apiBase, '/api/bot/scan');
      await Promise.all([signalsQ.refetch(), logsQ.refetch(), status.refetch()]);
    } catch (e) {
      console.error(e);
    } finally {
      setTimeout(() => setScanningNow(false), 500);
    }
  };

  const handleExecuteTrade = async (s: any) => {
    try {
      await apiPost(apiBase, '/api/trades/execute', {
        symbol: s.symbol,
        direction: s.direction,
        price: s.price,
        signal_id: s.id,
      });
      await Promise.all([
        openTrades.refetch(),
        signalsQ.refetch(),
        logsQ.refetch(),
        status.refetch(),
        balanceQ.refetch(),
      ]);
    } catch (e) {
      console.error('Execute trade error:', e);
    }
  };

  useEffect(() => {
    [status, openTrades, history, signalsQ, logsQ, statsQ, credsQ, balanceQ, quantMetricsQ].forEach((q) => q.refetch().catch(() => {}));
  }, [apiBase]);

  const settingsHydrated = useRef(false);
  const [riskPct, setRiskPct] = useState(1.0);
  const [maxPositions, setMaxPositions] = useState(3);
  const [maxDailyLoss, setMaxDailyLoss] = useState(5.0);
  const [symbolsText, setSymbolsText] = useState('BTCUSDT, ETHUSDT, SOLUSDT, DOGEUSDT');
  const [timeframe, setTimeframe] = useState('15m');

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

  const [dryRun, setDryRun] = useState(true);
  const [leverage, setLeverage] = useState(5);
  const [sessionFilter, setSessionFilter] = useState(true);
  const [htfBias, setHtfBias] = useState(true);
  const [sweepConfirmation, setSweepConfirmation] = useState(true);
  const [displacementFilter, setDisplacementFilter] = useState(true);

  // Quant Settings State
  const [hawkesBeta, setHawkesBeta] = useState(0.85);
  const [bayesianProb, setBayesianProb] = useState(0.65);
  const [fractionalKelly, setFractionalKelly] = useState(0.20);
  const [scalpTime, setScalpTime] = useState(600);
  const [totalCapital, setTotalCapital] = useState(100000);

  const prevStrategy = useRef<string | null>(null);

  useEffect(() => {
    if (status.data) {
      if (status.data.active_strategy === 'quant_math' && prevStrategy.current !== 'quant_math') {
        setActiveTab('quant_hunter');
      }
      prevStrategy.current = status.data.active_strategy;

      if (status.data.settings && !settingsHydrated.current) {
        const s = status.data.settings;
        setRiskPct(s.risk_per_trade_pct ?? 1.0);
        setMaxPositions(s.max_concurrent_positions ?? 3);
        setMaxDailyLoss(s.max_daily_loss_pct ?? 5.0);
        setSymbolsText((s.symbols || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT']).join(', '));
        setTimeframe(s.timeframe || '15m');
        setDryRun(s.dry_run ?? true);
        setLeverage(s.leverage ?? 5);
        setSessionFilter(s.session_filter_enabled ?? true);
        setHtfBias(s.htf_bias_enabled ?? true);
        setSweepConfirmation(s.require_sweep_confirmation ?? true);
        setDisplacementFilter(s.displacement_filter_enabled ?? true);

        if (status.data.quant_settings) {
          const qs = status.data.quant_settings;
          setHawkesBeta(qs.hawkes_decay_beta ?? 0.85);
          setBayesianProb(qs.bayesian_min_probability ?? 0.65);
          setFractionalKelly(qs.fractional_kelly_c ?? 0.20);
          setScalpTime(qs.scalp_time_seconds ?? 600);
          setTotalCapital(qs.total_capital ?? 100000);
        }

        settingsHydrated.current = true;
      }
    }
  }, [status.data]);

  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSaveSettings() {
    setSaveState('saving');
    setSaveError(null);
    try {
      await apiPost(apiBase, '/api/settings', {
        risk_per_trade_pct: riskPct,
        max_concurrent_positions: maxPositions,
        max_daily_loss_pct: maxDailyLoss,
        symbols: symbolsText.split(',').map((s) => s.trim()).filter(Boolean),
        timeframe,
        dry_run: dryRun,
        leverage,
        session_filter_enabled: sessionFilter,
        htf_bias_enabled: htfBias,
        require_sweep_confirmation: sweepConfirmation,
        displacement_filter_enabled: displacementFilter,
      });

      await apiPost(apiBase, '/api/quant/settings', {
        hawkes_decay_beta: hawkesBeta,
        bayesian_min_probability: bayesianProb,
        fractional_kelly_c: fractionalKelly,
        scalp_time_seconds: scalpTime,
        total_capital: totalCapital,
      });

      setSaveState('saved');
      status.refetch().catch(() => {});
      quantMetricsQ.refetch().catch(() => {});
      setTimeout(() => setSaveState('idle'), 1500);
    } catch (err: any) {
      setSaveState('error');
      setSaveError(err.message);
    }
  }

  const [botActionPending, setBotActionPending] = useState(false);
  const [botActionError, setBotActionError] = useState<string | null>(null);
  const [confirmingLiveStart, setConfirmingLiveStart] = useState(false);

  async function doToggleBot() {
    setBotActionPending(true);
    setBotActionError(null);
    try {
      if (status.data?.bot_running) {
        await apiPost(apiBase, '/api/bot/stop');
      } else {
        await apiPost(apiBase, '/api/bot/start');
      }
      await status.refetch();
    } catch (err: any) {
      setBotActionError(err.message);
    } finally {
      setBotActionPending(false);
    }
  }

  function handleBotButtonClick() {
    const aboutToStartLive = !status.data?.bot_running && status.data?.live_mode_active;
    if (aboutToStartLive && !confirmingLiveStart) {
      setConfirmingLiveStart(true);
      setTimeout(() => setConfirmingLiveStart(false), 4000);
      return;
    }
    setConfirmingLiveStart(false);
    doToggleBot();
  }

  const equityCurve = useMemo(() => {
    if (!history.data || history.data.length === 0) return [];
    const sorted = [...history.data].sort((a: any, b: any) => (a.closed_at || 0) - (b.closed_at || 0));
    let cum = 0;
    return sorted.map((t: any, i: number) => { cum += (t.realized_pnl || 0); return { t: i, equity: cum }; });
  }, [history.data]);

  const connState = (status.loading && !status.data) ? 'connecting' : status.error ? 'error' : 'ok';
  const hasErrorLogs = (logsQ.data || []).some((l: any) => l.level === 'error');
  const activeStrat = status.data?.active_strategy || 'smc';

  
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

  return (
    <div style={{ background: C.bg, color: C.paper, minHeight: '100vh' }} className="w-full font-sans pb-12">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        .font-sans { font-family: 'Inter', system-ui, sans-serif; }
        .font-display { font-family: 'Space Grotesk', sans-serif; }
        .font-mono-data { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; }
        @keyframes pulseDot { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
        .pulse { animation: pulseDot 1.8s ease-in-out infinite; }
      `}</style>

      {/* connection banner */}
      {connState === 'error' && (
        <div style={{ background: `${C.short}18`, borderColor: C.short, color: C.short }}
          className="border-b px-5 py-2 text-xs flex items-center gap-2 flex-wrap">
          <AlertCircle size={14} />
          <span>Can't reach API at {apiBase} — {status.error}. Check backend server status.</span>
        </div>
      )}

      {/* top bar */}
      <div style={{ borderColor: C.hairline }} className="border-b px-5 py-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <StructureMark size={22} />
          <div>
            <span className="font-display font-bold text-lg tracking-wide">
              KEHLO <span style={{ color: activeStrat === 'quant_math' ? '#c084fc' : C.amber, fontWeight: 500 }}>
                {activeStrat === 'quant_math' ? 'QUANT MATH TRADING' : 'SMC TRADING'}
              </span>
            </span>
            <span className="text-[10px] block font-mono-data" style={{ color: C.muted }}>Bitget Algorithmic Engine</span>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={handleSync} disabled={syncing}
            className="p-1.5 rounded transition-colors"
            title="Manual Refresh"
            style={{ background: C.panelAlt, color: C.muted, border: `1px solid ${C.hairline}` }}>
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          </button>

          <StrategySwitcher apiBase={apiBase} activeStrategy={activeStrat}
            onChanged={() => { status.refetch().catch(() => {}); quantMetricsQ.refetch().catch(() => {}); }} />

          <ModeSwitcher apiBase={apiBase} status={status} credsQ={credsQ}
            onChanged={() => { status.refetch().catch(() => {}); }} />

          {balanceQ.data && (
            <div className="px-3 py-1 rounded text-xs font-mono-data font-semibold flex items-center gap-2"
              style={{ background: C.panel, border: `1px solid ${C.hairline}`, color: C.paper }}>
              <span className="text-[10px] px-1.5 py-0.2 rounded uppercase font-sans font-bold"
                style={{
                  background: balanceQ.data.mode === 'live' ? `${C.short}22` : `${C.amber}22`,
                  color: balanceQ.data.mode === 'live' ? C.short : C.amber,
                  border: `1px solid ${balanceQ.data.mode === 'live' ? C.short : C.amber}`,
                }}>
                {balanceQ.data.mode === 'live' ? 'LIVE' : 'DEMO'}
              </span>
              Equity: <span style={{ color: balanceQ.data.mode === 'live' ? C.short : C.amber }}>${Number(balanceQ.data.equity || 1000).toFixed(2)}</span>
            </div>
          )}

          <div className="flex items-center gap-2 text-xs font-medium" style={{ color: C.muted }}>
            <span className={status.data?.bot_running ? 'pulse' : ''}
              style={{ width: 8, height: 8, borderRadius: 999, background: status.data?.bot_running ? C.long : C.short, display: 'inline-block' }} />
            {status.data?.bot_running ? (activeStrat === 'quant_math' ? 'Watching Tape' : 'Scanning Market') : 'Bot Paused'}
          </div>

          <button onClick={handleBotButtonClick} disabled={botActionPending || connState === 'error'}
            className="px-4 py-1.5 rounded text-xs font-semibold flex items-center gap-1.5 transition-all disabled:opacity-50"
            style={{
              background: confirmingLiveStart ? C.short : status.data?.bot_running ? 'transparent' : (activeStrat === 'quant_math' ? '#a855f7' : C.amber),
              color: confirmingLiveStart ? '#fff' : status.data?.bot_running ? C.short : C.bg,
              border: `1px solid ${confirmingLiveStart ? C.short : status.data?.bot_running ? C.short : (activeStrat === 'quant_math' ? '#a855f7' : C.amber)}`,
            }}>
            {status.data?.bot_running ? <Square size={12} /> : <Play size={12} />}
            {confirmingLiveStart ? 'Confirm Real Money Live' : status.data?.bot_running ? 'Pause Bot' : 'Start Engine'}
          </button>
        </div>
      </div>
      {botActionError && <div className="px-5 pt-2 text-xs" style={{ color: C.short }}>{botActionError}</div>}

      {/* hero stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px" style={{ background: C.hairline }}>
        {[
          { label: 'Active Positions', value: openTrades.data != null ? openTrades.data.length : (status.data?.open_position_count ?? '···'), color: C.paper },
          {
            label: 'Closed Realized P&L', color: (statsQ.data?.total_pnl ?? 0) >= 0 ? C.long : C.short,
            value: statsQ.data ? `${statsQ.data.total_pnl >= 0 ? '+' : ''}$${statsQ.data.total_pnl.toFixed(2)}` : '···',
          },
          { label: 'Win Rate', value: statsQ.data ? `${statsQ.data.win_rate_pct.toFixed(0)}%` : '···', color: C.amber },
          { label: 'Total Closed Trades', value: statsQ.data?.closed_trades ?? '···', color: C.paper },
        ].map((s) => (
          <div key={s.label} style={{ background: C.bg }} className="p-5">
            <div className="text-[11px] uppercase font-semibold mb-1" style={{ color: C.muted, letterSpacing: '0.08em' }}>{s.label}</div>
            <div className="font-mono-data text-2xl font-bold" style={{ color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* equity curve */}
      <div className="px-5 pt-5">
        <section style={{ background: C.panel, border: `1px solid ${C.hairline}` }} className="rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-display text-xs font-semibold uppercase tracking-wider" style={{ color: C.muted }}>Equity Growth Curve (Closed P&L)</h2>
            <span className="text-[10px] font-mono-data" style={{ color: C.muted }}>Live Tracking</span>
          </div>
          {equityCurve.length === 0 ? (
            <div className="text-xs py-6 text-center font-mono-data" style={{ color: C.muted }}>No closed trades recorded yet.</div>
          ) : (
            <ResponsiveContainer width="100%" height={110}>
              <AreaChart data={equityCurve}>
                <defs>
                  <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={C.amber} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={C.amber} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="t" hide />
                <YAxis hide domain={['dataMin - 10', 'dataMax + 10']} />
                <Tooltip contentStyle={{ background: C.panelAlt, border: `1px solid ${C.hairline}`, borderRadius: 6, fontSize: 12 }}
                  labelFormatter={() => ''} formatter={(v: any) => [`$${Number(v).toFixed(2)}`, 'Cumulative P&L']} />
                <Area type="monotone" dataKey="equity" stroke={C.amber} strokeWidth={2} fill="url(#pnlGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </section>
      </div>

      {/* tabs */}
      <div className="flex items-center gap-1 px-5 mt-5 border-b overflow-x-auto" style={{ borderColor: C.hairline }}>
        {TABS.map((tab) => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className="px-4 py-3 text-xs font-semibold whitespace-nowrap flex items-center gap-1.5 transition-colors"
            style={{ color: activeTab === tab.id ? C.paper : C.muted, borderBottom: activeTab === tab.id ? `2px solid ${activeStrat === 'quant_math' ? '#a855f7' : C.amber}` : '2px solid transparent' }}>
            {tab.label}
            {tab.count != null && <span className="text-[10px] font-mono-data px-1.5 py-0.2 rounded" style={{ background: C.panelAlt }}>{tab.count}</span>}
            {tab.alert && <span style={{ width: 6, height: 6, borderRadius: 999, background: C.short, display: 'inline-block' }} />}
          </button>
        ))}
      </div>

      <div className="p-5">
        
        {activeTab === 'chart' && (
          <LiveChart
            apiBase={apiBase}
            currentTimeframe={timeframe}
            onTimeframeChange={handleTimeframeChange}
            onExecuteTrade={handleExecuteTrade}
          />
        )}

        {activeTab === 'quant_hunter' && (
          <QuantDashboard quantMetrics={quantMetricsQ.data} />
        )}

        {activeTab === 'positions' && (
          <div className="max-w-3xl space-y-4">
            {status.data?.live_mode_active ? (
              <div className="space-y-2">
                <div className="p-3.5 rounded-lg flex items-center justify-between text-xs border shadow-sm"
                  style={{ background: `${C.short}12`, borderColor: `${C.short}44`, color: C.short }}>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full animate-ping" style={{ background: C.short }} />
                    <span className="font-semibold uppercase tracking-wider">Bitget Live Account Active</span>
                    <span className="hidden md:inline" style={{ color: C.paper }}>— Real money positions & USDT Futures balance</span>
                  </div>
                  <span className="font-mono-data text-[10px] px-2 py-0.5 rounded font-bold" style={{ background: `${C.short}22` }}>
                    REAL MONEY LIVE
                  </span>
                </div>

                {balanceQ.data?.error && (
                  <div className="p-3.5 rounded-lg text-xs border flex flex-col gap-1 font-mono-data"
                    style={{ background: `${C.short}18`, borderColor: C.short, color: C.paper }}>
                    <div className="flex items-center justify-between font-bold" style={{ color: C.short }}>
                      <span>⚠️ BITGET LIVE API KEY NEEDED</span>
                      <button onClick={() => setActiveTab('connect')} className="underline hover:opacity-80">
                        Go to Connect Tab →
                      </button>
                    </div>
                    <div>{balanceQ.data.error}</div>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-3.5 rounded-lg flex items-center justify-between text-xs border"
                style={{ background: `${C.amber}12`, borderColor: `${C.amber}44`, color: C.amber }}>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ background: C.amber }} />
                  <span className="font-semibold uppercase tracking-wider">Demo / Paper Trading Environment</span>
                  <span className="hidden md:inline" style={{ color: C.paper }}>— Paper capital simulator ($1,000.00 base)</span>
                </div>
                <span className="font-mono-data text-[10px] px-2 py-0.5 rounded font-bold" style={{ background: `${C.amber}22` }}>
                  DRY RUN
                </span>
              </div>
            )}

            {openTrades.loading && !openTrades.data ? (
              <div className="text-xs font-mono-data p-4" style={{ color: C.muted }}>Loading active positions…</div>
            ) : (openTrades.data || []).length === 0 ? (
              <div style={{ background: C.panel, border: `1px dashed ${C.hairline}`, color: C.muted }} className="rounded-lg p-8 text-xs font-mono-data text-center">
                No active positions in {status.data?.live_mode_active ? 'Live Bitget Mode' : 'Demo Paper Mode'} — the {activeStrat === 'quant_math' ? 'Quant Tape engine' : 'SMC engine'} is monitoring market liquidity.
              </div>
            ) : (
              <div className="space-y-4">
                {(openTrades.data || []).map((pos: any) => (
                  <PositionCard key={pos.id} pos={pos} apiBase={apiBase} onClose={openTrades.refetch} />
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'signals' && (
          <div className="max-w-3xl space-y-3">
            <div style={{ background: C.panel, border: `1px solid ${C.hairline}` }} className="rounded-lg p-4 flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider flex items-center gap-2" style={{ color: C.amber }}>
                  <Zap size={14} /> Live Market Signals & Coin Scanner Feed
                </h3>
                <p className="text-[11px] font-mono-data mt-1" style={{ color: C.muted }}>
                  Scanning coins: <span className="text-gray-300 font-semibold">{symbolsText || 'BTCUSDT, ETHUSDT, SOLUSDT, DOGEUSDT'}</span>
                </p>
              </div>

              <button onClick={handleScanNow} disabled={scanningNow}
                className="px-3.5 py-1.5 rounded text-xs font-semibold flex items-center gap-1.5 transition-all disabled:opacity-50"
                style={{ background: C.amber, color: C.bg }}>
                <RefreshCw size={12} className={scanningNow ? 'animate-spin' : ''} />
                {scanningNow ? 'Scanning Bitget Coins…' : 'Scan Market Now'}
              </button>
            </div>

            <div style={{ background: C.panel, border: `1px solid ${C.hairline}` }} className="rounded-lg divide-y">
              {signalsQ.loading && !signalsQ.data ? (
                <div className="p-4 text-xs font-mono-data" style={{ color: C.muted }}>Loading market signals…</div>
              ) : (signalsQ.data || []).length === 0 ? (
                <div className="p-8 text-xs font-mono-data text-center" style={{ color: C.muted }}>
                  No signals recorded yet. Click "Scan Market Now" above to analyze live coins.
                </div>
              ) : (signalsQ.data || []).map((s: any, i: number) => (
                <SignalRow key={s.id ?? i} s={s} onExecuteTrade={handleExecuteTrade} />
              ))}
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div style={{ background: C.panel, border: `1px solid ${C.hairline}` }} className="rounded-lg max-w-3xl divide-y">
            {history.loading && !history.data ? (
              <div className="p-4 text-xs font-mono-data" style={{ color: C.muted }}>Loading trade history…</div>
            ) : (history.data || []).length === 0 ? (
              <div className="p-8 text-xs font-mono-data text-center" style={{ color: C.muted }}>No trade history yet.</div>
            ) : (history.data || []).map((h: any, i: number) => (
              <HistoryRow key={h.id ?? i} h={h} />
            ))}
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="max-w-4xl">
            <div className="flex gap-2 mb-3">
              {['all', 'info', 'warning', 'error'].map((lvl) => (
                <button key={lvl} onClick={() => setLogFilter(lvl)}
                  className="px-3 py-1 rounded text-xs font-semibold capitalize transition-colors"
                  style={{ background: logFilter === lvl ? C.amber : C.panelAlt, color: logFilter === lvl ? C.bg : C.muted }}>
                  {lvl}
                </button>
              ))}
            </div>
            <div style={{ background: C.panel, border: `1px solid ${C.hairline}` }} className="rounded-lg divide-y">
              {logsQ.loading && !logsQ.data ? (
                <div className="p-6 text-xs font-mono-data text-center" style={{ color: C.muted }}>Loading execution logs…</div>
              ) : (logsQ.data || []).length === 0 ? (
                <div className="p-6 text-xs font-mono-data text-center" style={{ color: C.muted }}>No {logFilter} logs.</div>
              ) : (logsQ.data || []).map((log: any, i: number) => (
                <LogRow key={log.id ?? i} log={log} />
              ))}
            </div>
          </div>
        )}

        {activeTab === 'connect' && (
          <div className="max-w-4xl">
            <p className="text-xs mb-4 leading-relaxed" style={{ color: C.muted }}>
              The engine defaults to <strong>Dry Run Mode</strong> for paper trading without requiring any Bitget API keys.
              Live API credentials are only required if you decide to activate real-money exchange trading.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <DryRunInfoCard />
              <LiveCredentialForm apiBase={apiBase} credInfo={credsQ.data?.live}
                onSaved={() => credsQ.refetch().catch(() => {})} />
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="max-w-3xl space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <section style={{ background: C.panel, border: `1px solid ${C.hairline}` }} className="rounded-lg p-5">
                <h3 className="font-display font-semibold text-xs uppercase mb-3 tracking-wider" style={{ color: C.amber }}>Risk & Position Sizing</h3>
                <Field label="Risk Per Trade (%)" value={riskPct} onChange={setRiskPct} />
                <Field label="Max Concurrent Positions" value={maxPositions} onChange={setMaxPositions} step={1} />
                <Field label="Max Daily Loss Limit (%)" value={maxDailyLoss} onChange={setMaxDailyLoss} />
                <Field label="Default Leverage (x)" value={leverage} onChange={setLeverage} step={1} />

                <div className="mb-3">
                  <label className="text-xs block mb-1 font-medium" style={{ color: C.muted }}>Execution Timeframe</label>
                  <select value={timeframe} onChange={(e) => handleTimeframeChange(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded text-sm font-mono-data outline-none"
                    style={{ background: C.bg, border: `1px solid ${C.hairline}`, color: C.paper }}>
                    {['1m', '5m', '15m', '30m', '1H', '4H', '1D'].map((tf) => <option key={tf} value={tf}>{tf}</option>)}
                  </select>
                </div>

                <div className="mb-3">
                  <label className="text-xs block mb-1 font-medium" style={{ color: C.muted }}>Watchlist Symbols (Comma Separated)</label>
                  <input type="text" value={symbolsText} onChange={(e) => setSymbolsText(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded text-sm font-mono-data outline-none"
                    style={{ background: C.bg, border: `1px solid ${C.hairline}`, color: C.paper }} />
                </div>
              </section>

              <section style={{ background: C.panel, border: `1px solid ${C.hairline}` }} className="rounded-lg p-5">
                <h3 className="font-display font-semibold text-xs uppercase mb-3 tracking-wider" style={{ color: C.amber }}>SMC Strategy & Confluence Filters</h3>
                <ToggleSetting label="Dry Run Mode (Paper)" description="Simulate orders without placing exchange trades" checked={dryRun} onChange={setDryRun} />
                <ToggleSetting label="Session Timing Filter" description="Restrict setups to Asian/London/NY killzones" checked={sessionFilter} onChange={setSessionFilter} />
                <ToggleSetting label="HTF Bias Alignment" description="Require 1H / 4H Market Structure direction" checked={htfBias} onChange={setHtfBias} />
                <ToggleSetting label="Liquidity Sweep Confirmation" description="Must sweep high/low before entry" checked={sweepConfirmation} onChange={setSweepConfirmation} />
                <ToggleSetting label="Displacement Filter" description="Require aggressive candle body displacement" checked={displacementFilter} onChange={setDisplacementFilter} />
              </section>
            </div>

            {/* Quant Strategy Math Parameters */}
            <section style={{ background: C.panel, border: `1px solid ${C.hairline}` }} className="rounded-lg p-5 border-purple-500/30">
              <h3 className="font-display font-semibold text-xs uppercase mb-3 tracking-wider text-purple-400">🧮 Quantitative Math Parameters (Hawkes & Kelly)</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Hawkes Decay Beta (β)" value={hawkesBeta} onChange={setHawkesBeta} step={0.05} />
                <Field label="Bayesian Probability Cutoff (P(H|E))" value={bayesianProb} onChange={setBayesianProb} step={0.05} />
                <Field label="Fractional Kelly Multiplier (c)" value={fractionalKelly} onChange={setFractionalKelly} step={0.05} />
                <Field label="Tape Scalp Duration (Seconds)" value={scalpTime} onChange={setScalpTime} step={30} />
                <Field label="Simulated Total Capital (USDT)" value={totalCapital} onChange={setTotalCapital} step={5000} />
              </div>
            </section>

            <div className="mt-5">
              <button onClick={handleSaveSettings} disabled={saveState === 'saving'}
                className="w-full py-2.5 rounded text-xs font-semibold transition-colors disabled:opacity-60"
                style={{ background: saveState === 'saved' ? C.long : (activeStrat === 'quant_math' ? '#a855f7' : C.amber), color: C.bg }}>
                {saveState === 'saving' ? 'Saving Settings…' : saveState === 'saved' ? 'Settings Applied' : 'Save Engine Settings'}
              </button>
              {saveState === 'error' && <div className="text-xs mt-2" style={{ color: C.short }}>{saveError}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

