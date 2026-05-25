'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import {
  fetchWallet, fmtUsd, fmtNum, fmtPct, fmtTime, shortAddr, resolveCoins,
  type HLWalletData, type HLRole, type HLPortfolioSeries,
} from '@/lib/hyperliquid'

// ── Helpers ───────────────────────────────────────────────────────────────────

const HISTORY_KEY = 'hl-trader-history'
const MAX_HISTORY = 8

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') } catch { return [] }
}
function saveHistory(addr: string) {
  const h = loadHistory().filter(a => a !== addr)
  h.unshift(addr)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, MAX_HISTORY)))
}

function pnlColor(v: string | number): string {
  const n = parseFloat(String(v))
  if (n > 0) return '#22c55e'
  if (n < 0) return '#ef4444'
  return '#6b7280'
}

// deterministic color from coin ticker for avatar
function avatarColor(coin: string): string {
  const colors = ['#3b82f6','#8b5cf6','#ec4899','#f59e0b','#10b981','#06b6d4','#f97316','#84cc16']
  let h = 0
  for (let i = 0; i < coin.length; i++) h = (h * 31 + coin.charCodeAt(i)) & 0xffffffff
  return colors[Math.abs(h) % colors.length]
}

function CoinAvatar({ coin, size = 28 }: { coin: string; size?: number }) {
  const letters = coin.replace(/[^A-Z]/g, '').slice(0, 2)
  return (
    <span style={{
      width: size, height: size, borderRadius: 4,
      background: avatarColor(coin),
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.36, fontWeight: 700, color: '#fff', flexShrink: 0,
      fontFamily: 'var(--mono)',
    }}>
      {letters}
    </span>
  )
}

type ChartRange = '24h' | '7d' | '30d' | 'All'
type Tab = 'positions' | 'spot' | 'orders' | 'trades' | 'transactions' | 'subaccounts'

const ROLE_META: Record<HLRole, { label: string; color: string }> = {
  user:       { label: 'Main Wallet', color: '#10b981' },
  agent:      { label: 'API Wallet',  color: '#3b82f6' },
  subAccount: { label: 'Sub-Account', color: '#8b5cf6' },
  vault:      { label: 'Vault',       color: '#f59e0b' },
  missing:    { label: 'Unknown',     color: '#6b7280' },
}

// ── Mini area chart ───────────────────────────────────────────────────────────

function MiniChart({ series, color, title }: { series: HLPortfolioSeries | undefined; color: string; title: string }) {
  const [mode, setMode] = useState<'value' | 'pnl'>('pnl')
  if (!series) return null
  const raw = mode === 'value' ? series.accountValueHistory : series.pnlHistory
  const data = raw.map(([ts, v]) => ({ ts, value: parseFloat(v) }))
  const last = data[data.length - 1]?.value ?? 0
  const first = data[0]?.value ?? 0
  const delta = last - first
  const gradId = `mg-${title.replace(/\s/g, '')}`
  const min = Math.min(...data.map(d => d.value))
  const max = Math.max(...data.map(d => d.value))

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 10, color: '#4b5563', letterSpacing: '0.1em', textTransform: 'uppercase' }}>{title}</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {(['value','pnl'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)} style={{
              background: mode === m ? 'rgba(255,255,255,0.08)' : 'transparent',
              border: 'none', borderRadius: 3,
              color: mode === m ? '#e5e7eb' : '#4b5563',
              cursor: 'pointer', fontSize: 9, fontWeight: 600, padding: '2px 5px', textTransform: 'capitalize',
            }}>{m}</button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: '#e5e7eb' }}>{fmtUsd(last)}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: pnlColor(delta), fontWeight: 600 }}>
          {delta >= 0 ? '+' : ''}{fmtUsd(delta)}
        </span>
      </div>
      {data.length > 1 && (
        <ResponsiveContainer width="100%" height={52}>
          <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="ts" hide />
            <YAxis domain={[min * 0.999, max * 1.001]} hide />
            {mode === 'pnl' && <ReferenceLine y={0} stroke="rgba(255,255,255,0.1)" strokeDasharray="2 2" />}
            <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} fill={`url(#${gradId})`} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

// ── Positions table ───────────────────────────────────────────────────────────

function PositionsTable({ data }: { data: HLWalletData }) {
  const positions = data.perps.assetPositions.map(ap => ap.position)

  if (positions.length === 0) {
    return <div style={{ padding: '48px 24px', textAlign: 'center', color: '#374151', fontSize: 13 }}>No open positions</div>
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            {['Asset', 'Side', 'Size', 'Value', 'Entry', 'Mark', 'PnL', 'Liq.', 'Margin', 'Funding'].map(h => (
              <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Asset' ? 'left' : 'right', fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#4b5563', whiteSpace: 'nowrap' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {positions.map((p, i) => {
            const size = parseFloat(p.szi)
            const isLong = size >= 0
            const pnl = parseFloat(p.unrealizedPnl)
            const funding = parseFloat(p.cumFunding?.sinceOpen ?? '0')
            const roe = parseFloat(p.returnOnEquity)

            return (
              <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', transition: 'background 120ms' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.025)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {/* Asset */}
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <CoinAvatar coin={p.coin} />
                    <div>
                      <div style={{ fontWeight: 700, color: '#e5e7eb', fontSize: 13 }}>{p.coin}</div>
                      <div style={{ fontSize: 10, color: '#6b7280', marginTop: 1 }}>
                        <span style={{
                          background: 'rgba(255,255,255,0.07)', borderRadius: 3,
                          padding: '1px 5px', fontFamily: 'var(--mono)',
                        }}>
                          {p.leverage.value}×
                        </span>
                        {' '}
                        <span style={{ color: '#4b5563' }}>{p.leverage.type}</span>
                      </div>
                    </div>
                  </div>
                </td>

                {/* Side */}
                <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                  <span style={{
                    background: isLong ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                    color: isLong ? '#22c55e' : '#ef4444',
                    borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 700,
                  }}>
                    {isLong ? 'Long' : 'Short'}
                  </span>
                </td>

                {/* Size */}
                <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: '#e5e7eb' }}>
                  {fmtNum(Math.abs(size))}
                  <div style={{ fontSize: 10, color: '#4b5563' }}>{p.coin}</div>
                </td>

                {/* Value */}
                <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: '#e5e7eb' }}>
                  {fmtUsd(p.positionValue)}
                </td>

                {/* Entry */}
                <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: '#9ca3af' }}>
                  {fmtUsd(p.entryPx)}
                </td>

                {/* Mark */}
                <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: '#e5e7eb' }}>
                  {fmtUsd(p.positionValue && p.szi ? String(parseFloat(p.positionValue) / Math.abs(size)) : null)}
                </td>

                {/* PnL */}
                <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)' }}>
                  <div style={{ color: pnlColor(pnl), fontWeight: 600 }}>{fmtUsd(pnl)}</div>
                  <div style={{ fontSize: 10, color: pnlColor(roe) }}>{fmtPct(roe)}</div>
                </td>

                {/* Liquidation */}
                <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: '#ef4444', fontSize: 11 }}>
                  {p.liquidationPx ? fmtUsd(p.liquidationPx) : '—'}
                </td>

                {/* Margin */}
                <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: '#9ca3af' }}>
                  {fmtUsd(p.marginUsed)}
                </td>

                {/* Funding */}
                <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)' }}>
                  <span style={{ color: pnlColor(funding) }}>{fmtUsd(funding)}</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Simple table ──────────────────────────────────────────────────────────────

function SimpleTable({ headers, rows, empty }: {
  headers: string[]
  rows: (string | React.ReactNode)[][]
  empty: string
}) {
  if (rows.length === 0) {
    return <div style={{ padding: '48px 24px', textAlign: 'center', color: '#374151', fontSize: 13 }}>{empty}</div>
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            {headers.map(h => (
              <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#4b5563' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: '9px 12px', fontFamily: 'var(--mono)', color: '#9ca3af', fontSize: 12 }}>
                  {cell}
                </td>
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
  const router = useRouter()
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
  const currentAddr = useRef<string>('')

  useEffect(() => { setHistory(loadHistory()) }, [])

  useEffect(() => {
    if (address) document.title = `Snooping ${shortAddr(address)} | Paragrine`
    else document.title = 'HL Trader Explorer | Paragrine'
    return () => { document.title = 'Paragrine Research' }
  }, [address])

  const lookup = useCallback(async (addr: string, silent = false) => {
    const a = addr.trim().toLowerCase()
    if (!a.startsWith('0x') || a.length < 10) {
      setError('Enter a valid 0x Hyperliquid address.')
      return
    }
    currentAddr.current = a
    if (!silent) {
      setAddress(a)
      setInput(a)
      setLoading(true)
      setError(null)
      setData(null)
      router.replace(`/hl-traders?snoop=${a}`, { scroll: false })
    } else {
      setRefreshing(true)
    }
    try {
      const result = await fetchWallet(a)
      if (currentAddr.current !== a) return
      setData(result)
      setLastRefresh(new Date())
      if (!silent) { saveHistory(a); setHistory(loadHistory()) }
    } catch (e: unknown) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to fetch wallet data.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [router])

  // auto-refresh every 15s
  useEffect(() => {
    if (!address) return
    const id = setInterval(() => {
      if (currentAddr.current) lookup(currentAddr.current, true)
    }, 15000)
    return () => clearInterval(id)
  }, [address, lookup])

  useEffect(() => {
    if (urlAddr && urlAddr !== address) lookup(urlAddr)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlAddr])

  // ── Derived ─────────────────────────────────────────────────────────────

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
  const totalUnrealizedPnl = positions.reduce((s, p) => s + parseFloat(p.unrealizedPnl || '0'), 0)
  const spotEquity = spotBalances.reduce((s, b) => s + parseFloat(b.entryNtl || '0'), 0)
  const totalPortfolio = perpEquity + spotEquity

  const role = (data?.role.role ?? 'user') as HLRole
  const masterAddr = data?.role.user
  const roleMeta = ROLE_META[role]

  const periodKey = range === '24h' ? 'day' : range === '7d' ? 'week' : range === '30d' ? 'month' : 'allTime'
  const perpPeriodKey = range === '24h' ? 'perpDay' : range === '7d' ? 'perpWeek' : range === '30d' ? 'perpMonth' : 'perpAllTime'

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: 'positions',    label: 'Positions',    count: positions.length },
    { id: 'spot',         label: 'Spot',         count: spotBalances.length },
    { id: 'orders',       label: 'Orders',       count: orders.length },
    { id: 'trades',       label: 'History',      count: fills.length },
    { id: 'transactions', label: 'Transactions', count: ledger.length },
    { id: 'subaccounts',  label: 'Sub-Accounts', count: subs.length },
  ]

  function stopSnoop() {
    setData(null)
    setAddress('')
    setInput('')
    setError(null)
    currentAddr.current = ''
    router.replace('/hl-traders', { scroll: false })
  }

  // ── Normal site layout (no active snoop) ─────────────────────────────────

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
            Enter any Hyperliquid address to open the live trading terminal — positions, spot, orders, trade history, and account relationships.
          </p>
        </div>

        {/* Search */}
        <div style={{ display: 'flex', gap: 8, maxWidth: 600, marginBottom: 16 }}>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && lookup(input)}
            placeholder="0x... paste any Hyperliquid address"
            style={{
              flex: 1, background: 'var(--card)', border: '1px solid var(--rule)',
              borderRadius: 6, color: 'var(--ink)', fontFamily: 'var(--mono)',
              fontSize: 14, padding: '10px 14px', outline: 'none',
            }}
          />
          <button onClick={() => lookup(input)} disabled={loading} className="btn primary" style={{ padding: '10px 24px', fontSize: 12, letterSpacing: '0.08em' }}>
            Snoop →
          </button>
        </div>

        {/* History chips */}
        {history.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 32 }}>
            {history.map(a => (
              <button key={a} onClick={() => lookup(a)} style={{
                background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 20,
                color: 'var(--ink-soft)', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, padding: '4px 12px',
              }}>
                {shortAddr(a)}
              </button>
            ))}
            <button onClick={() => { localStorage.removeItem(HISTORY_KEY); setHistory([]) }} style={{ background: 'transparent', border: 'none', color: 'var(--ink-mute)', cursor: 'pointer', fontSize: 11, padding: '4px 6px' }}>
              clear
            </button>
          </div>
        )}

        {error && (
          <div style={{ background: 'rgba(192,57,43,0.08)', border: '1px solid rgba(192,57,43,0.25)', borderRadius: 8, color: 'var(--red)', fontSize: 14, padding: '12px 16px', maxWidth: 600 }}>
            {error}
          </div>
        )}

        <style>{`input:focus { border-color: var(--blue) !important; }`}</style>
      </>
    )
  }

  // ── Terminal overlay (active snoop) ──────────────────────────────────────

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#08080e', color: '#e5e7eb', fontFamily: 'var(--sans)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Top bar ── */}
      <div style={{ borderBottom: '1px solid rgba(255,255,255,0.07)', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 0 }}>
        {/* Live dot */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ position: 'relative', display: 'inline-flex', width: 8, height: 8 }}>
            <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: '#9333ea', opacity: 0.5, animation: 'ping 1.4s ease-in-out infinite' }} />
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#9333ea', display: 'block' }} />
          </span>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#9333ea', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Snooping</span>
        </div>

        {/* Address input */}
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && lookup(input)}
          placeholder="0x..."
          style={{
            flex: 1, minWidth: 180, maxWidth: 480,
            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6, color: '#e5e7eb', fontFamily: 'var(--mono)',
            fontSize: 13, padding: '6px 12px', outline: 'none',
          }}
        />
        <button onClick={() => lookup(input)} disabled={loading} style={{ background: '#7c3aed', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '6px 14px', opacity: loading ? 0.5 : 1 }}>
          {loading ? '...' : 'Go →'}
        </button>
        <button onClick={() => navigator.clipboard.writeText(`${window.location.origin}/hl-traders?snoop=${address}`)} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#6b7280', cursor: 'pointer', fontSize: 11, padding: '6px 12px' }}>
          Share
        </button>
        <button onClick={() => lookup(address, true)} disabled={refreshing} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: '#4b5563', cursor: 'pointer', fontSize: 11, padding: '6px 10px' }}>
          {refreshing ? '...' : '↻'}
        </button>

        {/* History */}
        {history.length > 0 && (
          <div style={{ display: 'flex', gap: 4 }}>
            {history.slice(0, 4).map(a => (
              <button key={a} onClick={() => lookup(a)} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 20, color: '#4b5563', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, padding: '3px 9px' }}>
                {shortAddr(a)}
              </button>
            ))}
          </div>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {lastRefresh && (
            <span style={{ fontSize: 10, color: '#374151', fontFamily: 'var(--mono)' }}>
              {lastRefresh.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
            </span>
          )}
          <button onClick={stopSnoop} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: '#4b5563', cursor: 'pointer', fontSize: 11, padding: '6px 12px' }}>
            ✕ Exit
          </button>
        </div>
      </div>

      {/* ── Error ── */}
      {error && (
        <div style={{ margin: '12px 16px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6, color: '#f87171', fontSize: 13, padding: '9px 14px' }}>
          {error}
        </div>
      )}

      {/* ── Loading ── */}
      {loading && (
        <div style={{ padding: 20 }}>
          {[300, 220, 180, 260].map((w, i) => (
            <div key={i} style={{ height: 14, width: w, borderRadius: 4, background: 'rgba(255,255,255,0.05)', marginBottom: 10, animation: 'pulse 1.4s ease-in-out infinite', animationDelay: `${i * 0.1}s` }} />
          ))}
        </div>
      )}

      {/* ── Main layout ── */}
      {data && !loading && (
        <div style={{ display: 'flex', flex: 1, minHeight: 0, alignItems: 'flex-start', overflow: 'hidden' }}>

          {/* ── LEFT SIDEBAR ── */}
          <div style={{
            width: 240, flexShrink: 0, borderRight: '1px solid rgba(255,255,255,0.07)',
            padding: '20px 16px',
            height: '100%', overflowY: 'auto',
          }}>

            {/* Address + role */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ background: `${roleMeta.color}22`, color: roleMeta.color, borderRadius: 4, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', padding: '2px 6px', textTransform: 'uppercase' }}>
                  {roleMeta.label}
                </span>
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#4b5563', wordBreak: 'break-all', lineHeight: 1.5 }}>
                {address}
              </div>
              {masterAddr && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#4b5563' }}>
                  {role === 'agent' ? 'Master:' : 'Parent:'}
                  {' '}
                  <button onClick={() => lookup(masterAddr)} style={{ background: 'none', border: 'none', color: '#7c3aed', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, padding: 0, textDecoration: 'underline' }}>
                    {shortAddr(masterAddr)}
                  </button>
                </div>
              )}
            </div>

            <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', marginBottom: 20 }} />

            {/* Overview metrics */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 9, color: '#374151', letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 700, marginBottom: 12 }}>Overview</div>

              {[
                { label: 'Portfolio Value', value: fmtUsd(totalPortfolio), color: '#e5e7eb' },
                { label: 'Unrealized PnL',  value: fmtUsd(totalUnrealizedPnl), color: pnlColor(totalUnrealizedPnl) },
                { label: 'Perp Equity',     value: fmtUsd(perpEquity), color: '#e5e7eb' },
                { label: 'Spot Value',      value: fmtUsd(spotEquity || null), color: '#e5e7eb' },
                { label: 'Margin Used',     value: fmtUsd(totalMarginUsed), color: '#e5e7eb' },
                { label: 'Margin Ratio',    value: marginRatio > 0 ? `${marginRatio.toFixed(2)}%` : '—', color: marginRatio > 80 ? '#ef4444' : marginRatio > 50 ? '#f59e0b' : '#22c55e' },
                { label: 'Maintenance',     value: fmtUsd(maintenanceMargin || null), color: '#9ca3af' },
                { label: 'Cross Leverage',  value: leverage > 0 ? `${leverage.toFixed(2)}×` : '—', color: '#e5e7eb' },
                { label: 'Withdrawable',    value: fmtUsd(data.perps.withdrawable), color: '#22c55e' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: '#4b5563' }}>{label}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color }}>{value}</span>
                </div>
              ))}
            </div>

            <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', marginBottom: 16 }} />

            {/* Range toggle */}
            <div style={{ display: 'flex', gap: 3, marginBottom: 16 }}>
              {(['24h','7d','30d','All'] as ChartRange[]).map(r => (
                <button key={r} onClick={() => setRange(r)} style={{
                  flex: 1, background: range === r ? 'rgba(124,58,237,0.25)' : 'transparent',
                  border: `1px solid ${range === r ? 'rgba(124,58,237,0.5)' : 'rgba(255,255,255,0.07)'}`,
                  borderRadius: 4, color: range === r ? '#a78bfa' : '#4b5563',
                  cursor: 'pointer', fontSize: 9, fontWeight: 700, padding: '4px 0',
                }}>{r}</button>
              ))}
            </div>

            {/* Charts */}
            <MiniChart series={data.portfolio[periodKey]} color="#3b82f6" title="Perp + Spot" />
            <MiniChart series={data.portfolio[perpPeriodKey]} color="#8b5cf6" title="Perps Only" />
          </div>

          {/* ── MAIN PANEL ── */}
          <div style={{ flex: 1, minWidth: 0, height: '100%', overflowY: 'auto' }}>

            {/* Tabs */}
            <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.07)', padding: '0 16px' }}>
              {TABS.map(t => (
                <button key={t.id} onClick={() => setTab(t.id)} style={{
                  background: 'none', border: 'none', borderBottom: tab === t.id ? '2px solid #7c3aed' : '2px solid transparent',
                  color: tab === t.id ? '#e5e7eb' : '#4b5563', cursor: 'pointer',
                  fontFamily: 'var(--sans)', fontSize: 12, fontWeight: tab === t.id ? 600 : 400,
                  padding: '12px 14px', marginBottom: -1, transition: 'color 120ms',
                  display: 'flex', alignItems: 'center', gap: 5,
                }}>
                  {t.label}
                  {t.count !== undefined && t.count > 0 && (
                    <span style={{ background: 'rgba(124,58,237,0.2)', color: '#a78bfa', borderRadius: 8, fontSize: 9, fontWeight: 700, padding: '1px 5px' }}>
                      {t.count}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div style={{ padding: 0 }}>
              {tab === 'positions' && <PositionsTable data={data} />}

              {tab === 'spot' && (
                <SimpleTable
                  headers={['Token', 'Balance', 'Hold', 'Entry Value']}
                  empty="No spot holdings"
                  rows={spotBalances.map(b => [
                    <span key="c" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <CoinAvatar coin={b.coin} size={22} />
                      <span style={{ color: '#e5e7eb', fontWeight: 600 }}>{b.coin}</span>
                    </span>,
                    fmtNum(b.total, 6),
                    fmtNum(b.hold, 6),
                    fmtUsd(b.entryNtl),
                  ])}
                />
              )}

              {tab === 'orders' && (
                <SimpleTable
                  headers={['Asset', 'Side', 'Size', 'Filled', 'Limit Price', 'Time']}
                  empty="No open orders"
                  rows={orders.map(o => {
                    const filled = parseFloat(o.origSz) - parseFloat(o.sz)
                    return [
                      <span key="c" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <CoinAvatar coin={resolveCoins(o.coin, data.spotTokenMap)} size={22} />
                        <span style={{ color: '#e5e7eb', fontWeight: 600 }}>{resolveCoins(o.coin, data.spotTokenMap)}</span>
                      </span>,
                      <span key="s" style={{ color: o.side === 'B' ? '#22c55e' : '#ef4444', fontWeight: 700 }}>{o.side === 'B' ? 'Buy' : 'Sell'}</span>,
                      fmtNum(o.sz),
                      filled > 0 ? fmtNum(filled) : '—',
                      fmtUsd(o.limitPx),
                      fmtTime(o.timestamp),
                    ]
                  })}
                />
              )}

              {tab === 'trades' && (
                <SimpleTable
                  headers={['Asset', 'Side', 'Size', 'Price', 'Direction', 'Closed PnL', 'Fee', 'Time']}
                  empty="No trade history"
                  rows={fills.slice(0, 200).map(f => [
                    <span key="c" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <CoinAvatar coin={resolveCoins(f.coin, data.spotTokenMap)} size={22} />
                      <span style={{ color: '#e5e7eb', fontWeight: 600 }}>{resolveCoins(f.coin, data.spotTokenMap)}</span>
                    </span>,
                    <span key="s" style={{ color: f.side === 'B' ? '#22c55e' : '#ef4444', fontWeight: 700 }}>{f.side === 'B' ? 'Buy' : 'Sell'}</span>,
                    fmtNum(f.sz),
                    fmtUsd(f.px),
                    <span key="d" style={{ color: '#4b5563' }}>{f.dir}</span>,
                    <span key="p" style={{ color: pnlColor(f.closedPnl), fontWeight: 600 }}>{fmtUsd(f.closedPnl)}</span>,
                    <span key="f" style={{ color: '#374151' }}>{fmtUsd(f.fee)}</span>,
                    fmtTime(f.time),
                  ])}
                />
              )}

              {tab === 'transactions' && (
                <SimpleTable
                  headers={['Type', 'Amount', 'Time', 'Tx Hash']}
                  empty="No transactions in last 90 days"
                  rows={ledger.map(l => [
                    <span key="t" style={{ color: '#e5e7eb', fontWeight: 600, textTransform: 'capitalize' }}>{l.delta.type.replace(/_/g, ' ')}</span>,
                    l.delta.usdc
                      ? <span key="a" style={{ color: parseFloat(l.delta.usdc) >= 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>{fmtUsd(l.delta.usdc)}</span>
                      : l.delta.amount ? `${fmtNum(l.delta.amount)} ${l.delta.coin ?? ''}` : '—',
                    fmtTime(l.time),
                    <a key="h" href={`https://app.hyperliquid.xyz/explorer/tx/${l.hash}`} target="_blank" rel="noopener noreferrer" style={{ color: '#7c3aed', fontSize: 11 }}>
                      {shortAddr(l.hash)}
                    </a>,
                  ])}
                />
              )}

              {tab === 'subaccounts' && (
                <SimpleTable
                  headers={['Name', 'Address', 'Perp Equity', 'Positions']}
                  empty="No sub-accounts"
                  rows={subs.map(s => {
                    const equity = s.clearinghouseState?.marginSummary?.accountValue
                    const posCount = s.clearinghouseState?.assetPositions?.length ?? 0
                    return [
                      <span key="n" style={{ color: '#e5e7eb', fontWeight: 600 }}>{s.name || '—'}</span>,
                      <button key="a" onClick={() => lookup(s.subAccountUser)} style={{ background: 'none', border: 'none', color: '#7c3aed', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 12, padding: 0, textDecoration: 'underline' }}>
                        {shortAddr(s.subAccountUser)}
                      </button>,
                      fmtUsd(equity ?? null),
                      posCount > 0 ? String(posCount) : '—',
                    ]
                  })}
                />
              )}
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:0.4} 50%{opacity:1} }
        @keyframes ping { 0%{transform:scale(1);opacity:0.5} 75%,100%{transform:scale(2.4);opacity:0} }
        input::placeholder { color: #374151; }
        input:focus { border-color: rgba(124,58,237,0.6) !important; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
      `}</style>
    </div>
  )
}

export default function Page() {
  return (
    <Suspense>
      <HLTraderDashboard />
    </Suspense>
  )
}
