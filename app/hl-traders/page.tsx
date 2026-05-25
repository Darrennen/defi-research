'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import {
  fetchWallet, fmtUsd, fmtNum, fmtPct, fmtTime, shortAddr, resolveCoins,
  type HLWalletData, type HLRole, type HLPortfolioSeries,
} from '@/lib/hyperliquid'

// ── Helpers ───────────────────────────────────────────────────────────────────

const HISTORY_KEY = 'hl-trader-history'
function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') } catch { return [] }
}
function saveHistory(addr: string) {
  const h = loadHistory().filter(a => a !== addr)
  h.unshift(addr)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 8)))
}

function pnlColor(v: string | number) {
  const n = parseFloat(String(v))
  if (n > 0) return '#22c55e'
  if (n < 0) return '#f43f5e'
  return '#6b7280'
}

function avatarColor(coin: string) {
  const palette = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#0ea5e9','#f97316','#84cc16']
  let h = 0
  for (let i = 0; i < coin.length; i++) h = (h * 31 + coin.charCodeAt(i)) & 0xffffffff
  return palette[Math.abs(h) % palette.length]
}

function CoinAvatar({ coin, size = 32 }: { coin: string; size?: number }) {
  const letters = coin.replace(/[^A-Z0-9]/g, '').slice(0, 2)
  return (
    <span style={{
      width: size, height: size, borderRadius: 6,
      background: avatarColor(coin),
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.35, fontWeight: 800, color: '#fff', flexShrink: 0,
      letterSpacing: '-0.02em',
    }}>
      {letters}
    </span>
  )
}

type Tab = 'positions' | 'spot' | 'orders' | 'trades' | 'transactions' | 'subaccounts' | 'charts'
type ChartRange = '24h' | '7d' | '30d' | 'All'

const ROLE_COLORS: Record<HLRole, string> = {
  user: '#10b981', agent: '#3b82f6', subAccount: '#8b5cf6', vault: '#f59e0b', missing: '#6b7280',
}
const ROLE_LABELS: Record<HLRole, string> = {
  user: 'Main Wallet', agent: 'API Wallet', subAccount: 'Sub-Account', vault: 'Vault', missing: 'Unknown',
}

// ── Chart component ───────────────────────────────────────────────────────────

function PortfolioChart({ series, color, title, height = 120 }: {
  series: HLPortfolioSeries | undefined; color: string; title: string; height?: number
}) {
  const [mode, setMode] = useState<'value' | 'pnl'>('pnl')
  if (!series) return <div style={{ color: '#374151', fontSize: 13, padding: 24 }}>No data</div>

  const raw = mode === 'value' ? series.accountValueHistory : series.pnlHistory
  const data = raw.map(([ts, v]) => ({ ts, value: parseFloat(v) }))
  const last = data[data.length - 1]?.value ?? 0
  const first = data[0]?.value ?? 0
  const delta = last - first
  const min = Math.min(...data.map(d => d.value))
  const max = Math.max(...data.map(d => d.value))
  const gid = `gc-${title.replace(/\s/g, '')}`

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{title}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 700, color: '#f1f5f9' }}>{fmtUsd(last)}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: pnlColor(delta), fontWeight: 600 }}>
              {delta >= 0 ? '+' : ''}{fmtUsd(delta)}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['value', 'pnl'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)} style={{
              background: mode === m ? 'rgba(255,255,255,0.1)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4,
              color: mode === m ? '#e2e8f0' : '#4b5563', cursor: 'pointer',
              fontSize: 11, fontWeight: 600, padding: '3px 8px', textTransform: 'capitalize',
            }}>{m}</button>
          ))}
        </div>
      </div>
      {data.length > 1 ? (
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="ts" hide />
            <YAxis domain={[min * 0.999, max * 1.001]} tick={{ fontSize: 10, fill: '#4b5563', fontFamily: 'monospace' }} axisLine={false} tickLine={false} width={55} tickFormatter={v => fmtUsd(v, 0)} />
            {mode === 'pnl' && <ReferenceLine y={0} stroke="rgba(255,255,255,0.1)" strokeDasharray="3 3" />}
            <Tooltip
              contentStyle={{ background: '#0f0f17', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: 12, fontFamily: 'monospace' }}
              formatter={(v: number) => [fmtUsd(v), mode === 'value' ? 'Value' : 'PnL']}
              labelFormatter={() => ''}
            />
            <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#${gid})`} dot={false} activeDot={{ r: 3, fill: color }} />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151', fontSize: 13 }}>Not enough data</div>
      )}
    </div>
  )
}

// ── Positions table ───────────────────────────────────────────────────────────

function PositionsTable({ data }: { data: HLWalletData }) {
  const positions = data.perps.assetPositions.map(ap => ap.position)
  if (!positions.length) return (
    <div style={{ padding: '60px 0', textAlign: 'center', color: '#374151', fontSize: 14 }}>No open positions</div>
  )

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            {['Asset', 'Side', 'Size', 'Value', 'Entry', 'Mark', 'PnL', 'Liq. Price', 'Margin', 'Funding'].map((h, i) => (
              <th key={h} style={{
                padding: '10px 16px', fontSize: 11, fontWeight: 600,
                letterSpacing: '0.08em', textTransform: 'uppercase', color: '#374151',
                textAlign: i === 0 ? 'left' : 'right', whiteSpace: 'nowrap',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {positions.map((p, i) => {
            const sz = parseFloat(p.szi)
            const isLong = sz >= 0
            const pnl = parseFloat(p.unrealizedPnl)
            const roe = parseFloat(p.returnOnEquity)
            const funding = parseFloat(p.cumFunding?.sinceOpen ?? '0')
            const markPx = parseFloat(p.positionValue) / Math.abs(sz)
            return (
              <tr key={i}
                style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: 'default' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {/* Asset */}
                <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <CoinAvatar coin={p.coin} size={34} />
                    <div>
                      <div style={{ fontWeight: 700, color: '#f1f5f9', fontSize: 14, letterSpacing: '-0.01em' }}>{p.coin}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                        <span style={{ background: 'rgba(255,255,255,0.08)', color: '#94a3b8', borderRadius: 3, fontSize: 10, fontWeight: 700, padding: '1px 5px', fontFamily: 'monospace' }}>
                          {p.leverage.value}×
                        </span>
                        <span style={{ color: '#374151', fontSize: 10 }}>{p.leverage.type}</span>
                      </div>
                    </div>
                  </div>
                </td>
                {/* Side */}
                <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                  <span style={{
                    background: isLong ? 'rgba(34,197,94,0.1)' : 'rgba(244,63,94,0.1)',
                    color: isLong ? '#22c55e' : '#f43f5e',
                    border: `1px solid ${isLong ? 'rgba(34,197,94,0.2)' : 'rgba(244,63,94,0.2)'}`,
                    borderRadius: 4, padding: '3px 10px', fontSize: 11, fontWeight: 700,
                  }}>
                    {isLong ? 'Long' : 'Short'}
                  </span>
                </td>
                {/* Size */}
                <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                  <div style={{ fontFamily: 'monospace', color: '#cbd5e1', fontSize: 13 }}>{fmtNum(Math.abs(sz), 4)}</div>
                  <div style={{ fontFamily: 'monospace', color: '#374151', fontSize: 11, marginTop: 2 }}>{p.coin}</div>
                </td>
                {/* Value */}
                <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: 'monospace', color: '#cbd5e1', fontSize: 13 }}>{fmtUsd(p.positionValue)}</td>
                {/* Entry */}
                <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: 'monospace', color: '#64748b', fontSize: 13 }}>{fmtUsd(p.entryPx)}</td>
                {/* Mark */}
                <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: 'monospace', color: '#cbd5e1', fontSize: 13 }}>{fmtUsd(isFinite(markPx) ? markPx : null)}</td>
                {/* PnL */}
                <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                  <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 13, color: pnlColor(pnl) }}>{fmtUsd(pnl)}</div>
                  <div style={{ fontFamily: 'monospace', fontSize: 11, color: pnlColor(roe), marginTop: 2 }}>{fmtPct(roe)}</div>
                </td>
                {/* Liq */}
                <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: '#ef4444' }}>{p.liquidationPx ? fmtUsd(p.liquidationPx) : '—'}</td>
                {/* Margin */}
                <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: 'monospace', color: '#64748b', fontSize: 13 }}>{fmtUsd(p.marginUsed)}</td>
                {/* Funding */}
                <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: 'monospace', fontSize: 13, color: pnlColor(funding) }}>{fmtUsd(funding)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Generic table ─────────────────────────────────────────────────────────────

function DataTable({ headers, rows, empty }: { headers: string[]; rows: (string | React.ReactNode)[][]; empty: string }) {
  if (!rows.length) return <div style={{ padding: '60px 0', textAlign: 'center', color: '#374151', fontSize: 14 }}>{empty}</div>
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            {headers.map(h => (
              <th key={h} style={{ padding: '10px 16px', fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#374151', textAlign: 'left', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {row.map((cell, j) => (
                <td key={j} style={{ padding: '11px 16px', fontFamily: 'monospace', color: '#64748b', fontSize: 13 }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Main dashboard ────────────────────────────────────────────────────────────

function HLTraderDashboard() {
  const params = useSearchParams()
  const urlAddr = params.get('snoop') ?? params.get('a') ?? ''

  const [input, setInput] = useState(urlAddr)
  const [address, setAddress] = useState(urlAddr)
  const [data, setData] = useState<HLWalletData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('positions')
  const [range, setRange] = useState<ChartRange>('7d')
  const [history, setHistory] = useState<string[]>([])
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const currentAddr = useRef('')

  useEffect(() => { setHistory(loadHistory()) }, [])

  useEffect(() => {
    document.title = address ? `Snooping ${shortAddr(address)} | Paragrine` : 'HL Trader Explorer | Paragrine'
    return () => { document.title = 'Paragrine Research' }
  }, [address])

  const lookup = useCallback(async (addr: string, silent = false) => {
    const a = addr.trim().toLowerCase()
    if (!a.startsWith('0x') || a.length < 10) { setError('Enter a valid 0x address.'); return }
    currentAddr.current = a
    if (!silent) {
      setAddress(a); setInput(a); setLoading(true); setError(null); setData(null)
    } else {
      setRefreshing(true)
    }
    try {
      const result = await fetchWallet(a)
      if (currentAddr.current !== a) return
      setData(result); setLastRefresh(new Date())
      if (!silent) { saveHistory(a); setHistory(loadHistory()) }
    } catch (e: unknown) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to fetch.')
    } finally {
      setLoading(false); setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    if (!address) return
    const id = setInterval(() => { if (currentAddr.current) lookup(currentAddr.current, true) }, 15000)
    return () => clearInterval(id)
  }, [address, lookup])

  useEffect(() => {
    if (urlAddr && urlAddr !== address) lookup(urlAddr)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlAddr])

  function stopSnoop() {
    setData(null); setAddress(''); setInput(''); setError(null); currentAddr.current = ''
  }

  // ── Derived ──────────────────────────────────────────────────────────────

  const positions = data?.perps.assetPositions.map(ap => ap.position) ?? []
  const spotBalances = (data?.spot.balances ?? []).filter(b => parseFloat(b.total) > 0)
  const orders = data?.orders ?? []
  const fills = data?.fills ?? []
  const ledger = data?.ledger ?? []
  const subs = data?.subAccounts ?? []

  const perpEquity = parseFloat(data?.perps.marginSummary.accountValue ?? '0')
  const totalMarginUsed = parseFloat(data?.perps.marginSummary.totalMarginUsed ?? '0')
  const maintenanceMargin = parseFloat(data?.perps.crossMaintenanceMarginUsed ?? '0')
  const totalNtl = parseFloat(data?.perps.marginSummary.totalNtlPos ?? '0')
  const leverage = totalMarginUsed > 0 ? totalNtl / totalMarginUsed : 0
  const marginRatio = perpEquity > 0 ? (totalMarginUsed / perpEquity) * 100 : 0
  const unrealizedPnl = positions.reduce((s, p) => s + parseFloat(p.unrealizedPnl || '0'), 0)
  const spotEquity = spotBalances.reduce((s, b) => s + parseFloat(b.entryNtl || '0'), 0)
  const totalPortfolio = perpEquity + spotEquity

  const role = (data?.role.role ?? 'user') as HLRole
  const masterAddr = data?.role.user
  const periodKey = range === '24h' ? 'day' : range === '7d' ? 'week' : range === '30d' ? 'month' : 'allTime'
  const perpPeriodKey = `perp${periodKey.charAt(0).toUpperCase()}${periodKey.slice(1)}` as never

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: 'positions',    label: 'Positions',    count: positions.length },
    { id: 'spot',         label: 'Spot',         count: spotBalances.length },
    { id: 'orders',       label: 'Orders',       count: orders.length },
    { id: 'trades',       label: 'History',      count: fills.length },
    { id: 'transactions', label: 'Transactions', count: ledger.length },
    { id: 'subaccounts',  label: 'Sub-Accounts', count: subs.length },
    { id: 'charts',       label: 'Charts' },
  ]

  // ── Normal page (no snoop active) ────────────────────────────────────────

  if (!data && !loading) {
    return (
      <>
        <div className="page-header" style={{ borderBottom: '3px solid var(--ink)', padding: '40px 0 32px', marginBottom: 40 }}>
          <div className="kicker" style={{ fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--blue)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
            Hyperliquid Intelligence
            <span style={{ flex: 1, height: 1, background: 'var(--rule)' }} />
          </div>
          <h1 style={{ fontFamily: 'var(--serif)', fontWeight: 500, fontSize: 'clamp(32px,4vw,56px)', lineHeight: 1, marginBottom: 12 }}>
            Trader <em>Explorer</em>
          </h1>
          <p style={{ fontSize: 15, color: 'var(--ink-soft)', maxWidth: '52ch', lineHeight: 1.6 }}>
            Enter any Hyperliquid address to open the live trading terminal — positions, spot holdings, orders, trade history, and account relationships.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, maxWidth: 600, marginBottom: 16 }}>
          <input
            type="text" value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && lookup(input)}
            placeholder="0x... paste any Hyperliquid address"
            style={{ flex: 1, background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 6, color: 'var(--ink)', fontFamily: 'var(--mono)', fontSize: 14, padding: '10px 14px', outline: 'none' }}
          />
          <button onClick={() => lookup(input)} disabled={loading} className="btn primary" style={{ padding: '10px 24px', fontSize: 12, letterSpacing: '0.08em' }}>
            Snoop →
          </button>
        </div>

        {history.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 32 }}>
            {history.map(a => (
              <button key={a} onClick={() => lookup(a)} style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 20, color: 'var(--ink-soft)', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, padding: '4px 12px' }}>
                {shortAddr(a)}
              </button>
            ))}
            <button onClick={() => { localStorage.removeItem(HISTORY_KEY); setHistory([]) }} style={{ background: 'transparent', border: 'none', color: 'var(--ink-mute)', cursor: 'pointer', fontSize: 11, padding: '4px 6px' }}>clear</button>
          </div>
        )}

        {error && <div style={{ background: 'rgba(192,57,43,0.08)', border: '1px solid rgba(192,57,43,0.2)', borderRadius: 8, color: 'var(--red)', fontSize: 14, padding: '12px 16px', maxWidth: 600 }}>{error}</div>}
        <style>{`input:focus { border-color: var(--blue) !important; }`}</style>
      </>
    )
  }

  // ── Terminal overlay ─────────────────────────────────────────────────────

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#080810', color: '#e2e8f0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px', height: 52, borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        {/* Live dot + label */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
          <span style={{ position: 'relative', display: 'inline-flex', width: 8, height: 8 }}>
            <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: '#a855f7', animation: 'ping 1.5s ease-in-out infinite' }} />
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#a855f7', display: 'block' }} />
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#a855f7', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Snoop</span>
        </div>

        <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.08)' }} />

        {/* Input */}
        <input
          type="text" value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && lookup(input)}
          placeholder="0x..."
          style={{ width: 420, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 6, color: '#e2e8f0', fontFamily: 'monospace', fontSize: 13, padding: '6px 12px', outline: 'none' }}
        />
        <button onClick={() => lookup(input)} disabled={loading} style={{ background: '#7c3aed', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, padding: '6px 16px', opacity: loading ? 0.5 : 1, flexShrink: 0 }}>
          {loading ? '...' : 'Go →'}
        </button>

        {/* History chips */}
        {history.slice(0, 3).map(a => (
          <button key={a} onClick={() => lookup(a)} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 20, color: '#475569', cursor: 'pointer', fontFamily: 'monospace', fontSize: 11, padding: '4px 10px', flexShrink: 0 }}>
            {shortAddr(a)}
          </button>
        ))}

        {/* Right side */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {lastRefresh && (
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#1e293b' }}>
              {refreshing ? 'Refreshing…' : lastRefresh.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
            </span>
          )}
          <button onClick={() => lookup(address, true)} disabled={refreshing} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: '#475569', cursor: 'pointer', fontSize: 12, padding: '5px 10px' }}>↻</button>
          <button onClick={() => navigator.clipboard.writeText(`${window.location.origin}/hl-traders?snoop=${address}`)} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: '#475569', cursor: 'pointer', fontSize: 12, padding: '5px 12px' }}>Share</button>
          <button onClick={stopSnoop} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: '#475569', cursor: 'pointer', fontSize: 12, padding: '5px 12px' }}>✕ Exit</button>
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* ── Sidebar ── */}
        <div style={{ width: 260, flexShrink: 0, borderRight: '1px solid rgba(255,255,255,0.07)', overflowY: 'auto', padding: '20px 18px', display: 'flex', flexDirection: 'column', gap: 0 }}>

          {/* Address + role */}
          <div style={{ marginBottom: 24 }}>
            <span style={{
              display: 'inline-block', background: `${ROLE_COLORS[role]}18`,
              color: ROLE_COLORS[role], borderRadius: 4, fontSize: 10, fontWeight: 700,
              letterSpacing: '0.1em', padding: '3px 8px', textTransform: 'uppercase', marginBottom: 8,
            }}>
              {ROLE_LABELS[role]}
            </span>
            <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#334155', lineHeight: 1.6, wordBreak: 'break-all' }}>{address}</div>
            {masterAddr && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#475569' }}>
                {role === 'agent' ? 'Master' : 'Parent'}:{' '}
                <button onClick={() => lookup(masterAddr)} style={{ background: 'none', border: 'none', color: '#7c3aed', cursor: 'pointer', fontFamily: 'monospace', fontSize: 12, padding: 0, textDecoration: 'underline' }}>
                  {shortAddr(masterAddr)}
                </button>
              </div>
            )}
          </div>

          <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', marginBottom: 20 }} />

          {/* Metrics */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#1e293b', marginBottom: 14 }}>Overview</div>
            {[
              { label: 'Portfolio Value', value: fmtUsd(totalPortfolio), color: '#f1f5f9', big: true },
              { label: 'Unrealized PnL',  value: fmtUsd(unrealizedPnl), color: pnlColor(unrealizedPnl), big: true },
              null,
              { label: 'Perp Equity',    value: fmtUsd(perpEquity),      color: '#94a3b8' },
              { label: 'Spot Value',      value: fmtUsd(spotEquity || null), color: '#94a3b8' },
              null,
              { label: 'Margin Used',    value: fmtUsd(totalMarginUsed), color: '#94a3b8' },
              { label: 'Margin Ratio',   value: marginRatio > 0 ? `${marginRatio.toFixed(2)}%` : '—', color: marginRatio > 80 ? '#f43f5e' : marginRatio > 50 ? '#f59e0b' : '#22c55e' },
              { label: 'Maintenance',    value: fmtUsd(maintenanceMargin || null), color: '#64748b' },
              { label: 'Leverage',       value: leverage > 0 ? `${leverage.toFixed(2)}×` : '—', color: '#94a3b8' },
              { label: 'Withdrawable',   value: fmtUsd(data?.perps.withdrawable ?? null), color: '#22c55e' },
            ].map((item, i) =>
              item === null
                ? <div key={i} style={{ height: 1, background: 'rgba(255,255,255,0.04)', margin: '10px 0' }} />
                : (
                  <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: item.big ? 10 : 8 }}>
                    <span style={{ fontSize: item.big ? 12 : 11, color: '#334155' }}>{item.label}</span>
                    <span style={{ fontFamily: 'monospace', fontSize: item.big ? 15 : 12, fontWeight: item.big ? 700 : 500, color: item.color }}>{item.value}</span>
                  </div>
                )
            )}
          </div>

          <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', marginBottom: 20 }} />

          {/* Range toggle */}
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#1e293b', marginBottom: 10 }}>Performance</div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
            {(['24h','7d','30d','All'] as ChartRange[]).map(r => (
              <button key={r} onClick={() => setRange(r)} style={{
                flex: 1, background: range === r ? 'rgba(124,58,237,0.2)' : 'transparent',
                border: `1px solid ${range === r ? 'rgba(124,58,237,0.4)' : 'rgba(255,255,255,0.07)'}`,
                borderRadius: 4, color: range === r ? '#a78bfa' : '#334155',
                cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: '5px 0',
              }}>{r}</button>
            ))}
          </div>

          {/* Mini sparklines */}
          {data && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {[
                { series: data.portfolio[periodKey], color: '#3b82f6', title: 'Perp + Spot' },
                { series: data.portfolio[perpPeriodKey], color: '#8b5cf6', title: 'Perps Only' },
              ].map(({ series, color, title }) => {
                if (!series) return null
                const raw = series.pnlHistory
                const pts = raw.map(([ts, v]) => ({ ts, value: parseFloat(v) }))
                const last = pts[pts.length - 1]?.value ?? 0
                const first = pts[0]?.value ?? 0
                const delta = last - first
                const min = Math.min(...pts.map(d => d.value))
                const max = Math.max(...pts.map(d => d.value))
                const gid = `sp-${title.replace(/\s/g, '')}`
                return (
                  <div key={title}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: '#334155' }}>{title}</span>
                      <span style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 700, color: pnlColor(delta) }}>
                        {delta >= 0 ? '+' : ''}{fmtUsd(delta)}
                      </span>
                    </div>
                    <ResponsiveContainer width="100%" height={44}>
                      <AreaChart data={pts} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
                        <defs>
                          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={color} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <XAxis dataKey="ts" hide />
                        <YAxis domain={[min * 0.999, max * 1.001]} hide />
                        <ReferenceLine y={0} stroke="rgba(255,255,255,0.07)" strokeDasharray="2 2" />
                        <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} fill={`url(#${gid})`} dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ── Main panel ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.07)', paddingLeft: 8, flexShrink: 0 }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                background: 'none', border: 'none',
                borderBottom: tab === t.id ? '2px solid #7c3aed' : '2px solid transparent',
                color: tab === t.id ? '#e2e8f0' : '#334155',
                cursor: 'pointer', fontSize: 13, fontWeight: tab === t.id ? 600 : 400,
                padding: '14px 16px', marginBottom: -1,
                display: 'flex', alignItems: 'center', gap: 6, transition: 'color 100ms',
              }}>
                {t.label}
                {t.count !== undefined && t.count > 0 && (
                  <span style={{ background: tab === t.id ? 'rgba(124,58,237,0.2)' : 'rgba(255,255,255,0.05)', color: tab === t.id ? '#a78bfa' : '#334155', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 6px' }}>
                    {t.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading && (
              <div style={{ padding: 24 }}>
                {[260, 200, 160].map((w, i) => (
                  <div key={i} style={{ height: 14, width: w, borderRadius: 4, background: 'rgba(255,255,255,0.05)', marginBottom: 12, animation: 'pulse 1.4s ease-in-out infinite', animationDelay: `${i*0.12}s` }} />
                ))}
              </div>
            )}

            {!loading && tab === 'positions' && data && <PositionsTable data={data} />}

            {!loading && tab === 'spot' && data && (
              <DataTable
                headers={['Token', 'Balance', 'Hold', 'Entry Value']}
                empty="No spot holdings"
                rows={spotBalances.map(b => [
                  <span key="c" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <CoinAvatar coin={b.coin} size={28} />
                    <span style={{ color: '#f1f5f9', fontWeight: 700 }}>{b.coin}</span>
                  </span>,
                  fmtNum(b.total, 6), fmtNum(b.hold, 6), fmtUsd(b.entryNtl),
                ])}
              />
            )}

            {!loading && tab === 'orders' && data && (
              <DataTable
                headers={['Asset', 'Side', 'Size', 'Filled', 'Limit Price', 'Time']}
                empty="No open orders"
                rows={orders.map(o => {
                  const filled = parseFloat(o.origSz) - parseFloat(o.sz)
                  const coin = resolveCoins(o.coin, data.spotTokenMap)
                  return [
                    <span key="c" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><CoinAvatar coin={coin} size={28} /><span style={{ color: '#f1f5f9', fontWeight: 700 }}>{coin}</span></span>,
                    <span key="s" style={{ color: o.side === 'B' ? '#22c55e' : '#f43f5e', fontWeight: 700 }}>{o.side === 'B' ? 'Buy' : 'Sell'}</span>,
                    fmtNum(o.sz), filled > 0 ? fmtNum(filled) : '—', fmtUsd(o.limitPx), fmtTime(o.timestamp),
                  ]
                })}
              />
            )}

            {!loading && tab === 'trades' && data && (
              <DataTable
                headers={['Asset', 'Side', 'Size', 'Price', 'Direction', 'Closed PnL', 'Fee', 'Time']}
                empty="No trade history"
                rows={fills.slice(0, 300).map(f => {
                  const coin = resolveCoins(f.coin, data.spotTokenMap)
                  return [
                    <span key="c" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><CoinAvatar coin={coin} size={28} /><span style={{ color: '#f1f5f9', fontWeight: 700 }}>{coin}</span></span>,
                    <span key="s" style={{ color: f.side === 'B' ? '#22c55e' : '#f43f5e', fontWeight: 700 }}>{f.side === 'B' ? 'Buy' : 'Sell'}</span>,
                    fmtNum(f.sz), fmtUsd(f.px),
                    <span key="d" style={{ color: '#475569' }}>{f.dir}</span>,
                    <span key="p" style={{ color: pnlColor(f.closedPnl), fontWeight: 600 }}>{fmtUsd(f.closedPnl)}</span>,
                    <span key="f" style={{ color: '#334155' }}>{fmtUsd(f.fee)}</span>,
                    fmtTime(f.time),
                  ]
                })}
              />
            )}

            {!loading && tab === 'transactions' && data && (
              <DataTable
                headers={['Type', 'Amount', 'Time', 'Tx Hash']}
                empty="No transactions in last 90 days"
                rows={ledger.map(l => [
                  <span key="t" style={{ color: '#f1f5f9', fontWeight: 600, textTransform: 'capitalize' }}>{l.delta.type.replace(/_/g, ' ')}</span>,
                  l.delta.usdc
                    ? <span key="a" style={{ color: parseFloat(l.delta.usdc) >= 0 ? '#22c55e' : '#f43f5e', fontWeight: 600 }}>{fmtUsd(l.delta.usdc)}</span>
                    : l.delta.amount ? `${fmtNum(l.delta.amount)} ${l.delta.coin ?? ''}` : '—',
                  fmtTime(l.time),
                  <a key="h" href={`https://app.hyperliquid.xyz/explorer/tx/${l.hash}`} target="_blank" rel="noopener noreferrer" style={{ color: '#7c3aed' }}>
                    {shortAddr(l.hash)}
                  </a>,
                ])}
              />
            )}

            {!loading && tab === 'subaccounts' && data && (
              <DataTable
                headers={['Name', 'Address', 'Perp Equity', 'Positions']}
                empty="No sub-accounts"
                rows={subs.map(s => [
                  <span key="n" style={{ color: '#f1f5f9', fontWeight: 600 }}>{s.name || '—'}</span>,
                  <button key="a" onClick={() => lookup(s.subAccountUser)} style={{ background: 'none', border: 'none', color: '#7c3aed', cursor: 'pointer', fontFamily: 'monospace', fontSize: 13, padding: 0, textDecoration: 'underline' }}>
                    {shortAddr(s.subAccountUser)}
                  </button>,
                  fmtUsd(s.clearinghouseState?.marginSummary?.accountValue ?? null),
                  String(s.clearinghouseState?.assetPositions?.length ?? 0),
                ])}
              />
            )}

            {!loading && tab === 'charts' && data && (
              <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 40 }}>
                <PortfolioChart series={data.portfolio[periodKey]} color="#3b82f6" title="Perp + Spot" height={200} />
                <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />
                <PortfolioChart series={data.portfolio[perpPeriodKey]} color="#8b5cf6" title="Perps Only" height={200} />
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:0.3} 50%{opacity:0.8} }
        @keyframes ping { 0%{transform:scale(1);opacity:0.6} 75%,100%{transform:scale(2.5);opacity:0} }
        input::placeholder { color: #1e293b !important; }
        input:focus { border-color: rgba(124,58,237,0.5) !important; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }
      `}</style>
    </div>
  )
}

export default function Page() {
  return <Suspense><HLTraderDashboard /></Suspense>
}
