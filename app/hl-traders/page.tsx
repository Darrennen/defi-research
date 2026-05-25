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
  if (n > 0) return 'var(--green)'
  if (n < 0) return 'var(--red)'
  return 'var(--ink-soft)'
}

const ROLE_META: Record<HLRole, { label: string; color: string; bg: string }> = {
  user:       { label: 'Main Wallet', color: '#0d9488', bg: 'rgba(13,148,136,0.10)' },
  agent:      { label: 'API Wallet',  color: 'var(--blue)', bg: 'var(--blue-soft)' },
  subAccount: { label: 'Sub-Account', color: '#9333ea', bg: 'rgba(147,51,234,0.10)' },
  vault:      { label: 'Vault',       color: 'var(--amber)', bg: 'rgba(178,116,13,0.10)' },
  missing:    { label: 'Unknown',     color: 'var(--ink-soft)', bg: 'var(--rule-soft)' },
}

type Tab = 'positions' | 'spot' | 'orders' | 'trades' | 'transactions' | 'subaccounts'

// ── Sub-components ────────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: HLRole }) {
  const m = ROLE_META[role] ?? ROLE_META.missing
  return (
    <span style={{
      background: m.bg, color: m.color,
      borderRadius: 4, padding: '3px 8px',
      fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
      fontFamily: 'var(--mono)',
    }}>
      {m.label}
    </span>
  )
}

function MetricCard({ label, value, sub, valueColor }: {
  label: string; value: string; sub?: string; valueColor?: string
}) {
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--rule)',
      borderRadius: 8, padding: '16px 20px', flex: 1, minWidth: 140,
    }}>
      <div style={{ fontSize: 11, color: 'var(--ink-soft)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--mono)', color: valueColor ?? 'var(--ink)', lineHeight: 1 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--ink-soft)', marginTop: 6 }}>{sub}</div>}
    </div>
  )
}

function Table({ headers, rows, empty }: {
  headers: string[]
  rows: (string | React.ReactNode)[][]
  empty: string
}) {
  if (rows.length === 0) {
    return <div style={{ textAlign: 'center', color: 'var(--ink-mute)', padding: '40px 0', fontSize: 14 }}>{empty}</div>
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {headers.map(h => (
              <th key={h} style={{
                textAlign: 'left', padding: '8px 12px',
                fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                color: 'var(--ink-soft)', borderBottom: '1px solid var(--rule)',
              }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--rule-soft)' }}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: '10px 12px', fontFamily: 'var(--mono)', color: 'var(--ink)', verticalAlign: 'middle' }}>
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

// ── Portfolio chart ───────────────────────────────────────────────────────────

type ChartRange = '24h' | '7d' | '30d' | 'All'

function buildChartData(series: HLPortfolioSeries, mode: 'value' | 'pnl') {
  const raw = mode === 'value' ? series.accountValueHistory : series.pnlHistory
  return raw.map(([ts, v]) => ({
    ts,
    value: parseFloat(v),
    label: new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
  }))
}

function PortfolioChart({
  title, series, color, range,
}: {
  title: string
  series: HLPortfolioSeries | undefined
  color: string
  range: ChartRange
}) {
  const [mode, setMode] = useState<'value' | 'pnl'>('value')

  if (!series) return null

  const chartData = buildChartData(series, mode)
  const values = chartData.map(d => d.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const first = values[0] ?? 0
  const last = values[values.length - 1] ?? 0
  const delta = last - first
  const isUp = delta >= 0

  const gradId = `grad-${title.replace(/\s/g, '')}`

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, padding: '18px 20px', flex: 1, minWidth: 280 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>{title}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 700, color: 'var(--ink)' }}>{fmtUsd(last)}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: isUp ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
              {isUp ? '+' : ''}{fmtUsd(delta)}
            </span>
          </div>
        </div>
        {/* Mode toggle */}
        <div style={{ display: 'flex', gap: 4 }}>
          {(['value', 'pnl'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)} style={{
              background: mode === m ? 'var(--blue-soft)' : 'transparent',
              border: '1px solid var(--rule)', borderRadius: 4,
              color: mode === m ? 'var(--blue)' : 'var(--ink-soft)',
              cursor: 'pointer', fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 600,
              padding: '3px 8px', textTransform: 'capitalize',
            }}>{m === 'value' ? 'Value' : 'PnL'}</button>
          ))}
        </div>
      </div>

      {/* Chart */}
      {chartData.length > 1 ? (
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={chartData} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.25} />
                <stop offset="95%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <XAxis dataKey="label" tick={false} axisLine={false} tickLine={false} />
            <YAxis
              domain={[min * 0.999, max * 1.001]}
              tick={{ fontSize: 10, fill: 'var(--ink-mute)', fontFamily: 'var(--mono)' }}
              axisLine={false} tickLine={false} width={60}
              tickFormatter={v => fmtUsd(v, 0)}
            />
            {mode === 'pnl' && <ReferenceLine y={0} stroke="var(--rule)" strokeDasharray="3 3" />}
            <Tooltip
              contentStyle={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 6, fontSize: 12, fontFamily: 'var(--mono)' }}
              labelStyle={{ color: 'var(--ink-soft)', fontSize: 11, marginBottom: 4 }}
              formatter={(v: number) => [fmtUsd(v), mode === 'value' ? 'Account Value' : 'PnL']}
            />
            <Area
              type="monotone" dataKey="value"
              stroke={color} strokeWidth={1.5}
              fill={`url(#${gradId})`}
              dot={false} activeDot={{ r: 3, fill: color }}
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-mute)', fontSize: 13 }}>
          Not enough data for this period
        </div>
      )}
    </div>
  )
}

// ── Main dashboard (needs useSearchParams, wrapped in Suspense) ───────────────

function HLTraderDashboard() {
  const router = useRouter()
  const params = useSearchParams()
  // support both ?a= and ?snoop= URL params
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
  const inputRef = useRef<HTMLInputElement>(null)
  const currentAddr = useRef<string>('')

  useEffect(() => { setHistory(loadHistory()) }, [])

  useEffect(() => {
    if (address) {
      document.title = `Snooping ${shortAddr(address)} | Paragrine`
    } else {
      document.title = 'HL Trader Explorer | Paragrine'
    }
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
    } else {
      setRefreshing(true)
    }
    try {
      const result = await fetchWallet(a)
      if (currentAddr.current !== a) return
      setData(result)
      setLastRefresh(new Date())
      if (!silent) {
        saveHistory(a)
        setHistory(loadHistory())
      }
    } catch (e: unknown) {
      if (!silent) setError(e instanceof Error ? e.message : 'Failed to fetch wallet data.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  // auto-refresh positions every 15s in snoop mode
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

  function stopSnoop() {
    setData(null); setAddress(''); setInput(''); setError(null); currentAddr.current = ''
  }

  // ── Derived data ─────────────────────────────────────────────────────────

  const positions = data?.perps.assetPositions.map(ap => ap.position) ?? []
  const spotBalances = (data?.spot.balances ?? []).filter(b => parseFloat(b.total) > 0)
  const orders = data?.orders ?? []
  const fills = data?.fills ?? []
  const ledger = data?.ledger ?? []
  const subs = data?.subAccounts ?? []

  const perpEquity = parseFloat(data?.perps.marginSummary.accountValue ?? '0')
  const spotEquity = spotBalances.reduce((s, b) => {
    const notional = parseFloat(b.entryNtl)
    return s + (isNaN(notional) ? 0 : notional)
  }, 0)
  const totalEquity = perpEquity + spotEquity

  const totalPnl = positions.reduce((s, p) => s + parseFloat(p.unrealizedPnl || '0'), 0)
  const totalFunding = positions.reduce((s, p) => s + parseFloat(p.cumFunding?.sinceOpen || '0'), 0)

  const role = (data?.role.role ?? 'user') as HLRole
  const masterAddr = data?.role.user

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: 'positions',    label: 'Positions',    count: positions.length },
    { id: 'spot',         label: 'Spot',         count: spotBalances.length },
    { id: 'orders',       label: 'Orders',       count: orders.length },
    { id: 'trades',       label: 'Trades',       count: fills.length },
    { id: 'transactions', label: 'Transactions', count: ledger.length },
    { id: 'subaccounts',  label: 'Sub-Accounts', count: subs.length },
  ]

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Page header */}
      <div className="page-header" style={{ borderBottom: '3px solid var(--ink)', padding: '40px 0 32px', marginBottom: 40 }}>
        <div className="kicker" style={{ fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--blue)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
          Hyperliquid Intelligence
          <span style={{ flex: 1, height: 1, background: 'var(--rule)' }} />
        </div>
        <h1 style={{ fontFamily: 'var(--serif)', fontWeight: 500, fontSize: 'clamp(32px, 4vw, 56px)', lineHeight: 1, marginBottom: 12 }}>
          Trader <em>Explorer</em>
        </h1>
        <p style={{ fontSize: 15, color: 'var(--ink-soft)', maxWidth: '56ch', lineHeight: 1.6 }}>
          View any Hyperliquid wallet — positions, spot holdings, open orders, trade history, and account relationships.
        </p>
      </div>

      {/* Search */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, maxWidth: 680 }}>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && lookup(input)}
          placeholder="Spoof any address — 0x..."
          style={{
            flex: 1, background: 'var(--card)', border: '1px solid var(--rule)',
            borderRadius: 6, color: 'var(--ink)', fontFamily: 'var(--mono)',
            fontSize: 14, padding: '10px 14px', outline: 'none',
          }}
        />
        <button
          onClick={() => lookup(input)}
          disabled={loading}
          className="btn primary"
          style={{ padding: '10px 24px', fontSize: 12, letterSpacing: '0.08em' }}
        >
          {loading ? 'Loading…' : 'Snoop →'}
        </button>
        {address && (
          <button
            onClick={() => navigator.clipboard.writeText(`${window.location.origin}/hl-traders?snoop=${address}`)}
            className="btn ghost"
            style={{ padding: '10px 16px', fontSize: 12, letterSpacing: '0.08em' }}
            title="Copy snoop link"
          >
            Share
          </button>
        )}
      </div>

      {/* History chips */}
      {history.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 32 }}>
          {history.map(a => (
            <button
              key={a}
              onClick={() => lookup(a)}
              style={{
                background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 20,
                color: 'var(--ink-soft)', cursor: 'pointer', fontFamily: 'var(--mono)',
                fontSize: 11, padding: '4px 12px',
              }}
            >
              {shortAddr(a)}
            </button>
          ))}
          <button
            onClick={() => { localStorage.removeItem(HISTORY_KEY); setHistory([]) }}
            style={{ background: 'transparent', border: 'none', color: 'var(--ink-mute)', cursor: 'pointer', fontSize: 11, padding: '4px 6px' }}
          >
            clear
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{
          background: 'rgba(192,57,43,0.08)', border: '1px solid rgba(192,57,43,0.25)',
          borderRadius: 8, color: 'var(--red)', fontSize: 14, padding: '12px 16px', marginBottom: 24,
        }}>
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 32 }}>
          {[200, 160, 140].map((w, i) => (
            <div key={i} style={{
              height: 20, width: w, borderRadius: 4,
              background: 'var(--rule)', animation: 'pulse 1.4s ease-in-out infinite',
              animationDelay: `${i * 0.15}s`,
            }} />
          ))}
        </div>
      )}

      {/* Results */}
      {data && !loading && (
        <>
          {/* Snoop mode banner */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: 'rgba(147,51,234,0.08)', border: '1px solid rgba(147,51,234,0.25)',
            borderRadius: 8, padding: '10px 16px', marginBottom: 16,
            flexWrap: 'wrap', gap: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ position: 'relative', display: 'inline-flex', width: 10, height: 10 }}>
                <span style={{
                  position: 'absolute', inset: 0, borderRadius: '50%',
                  background: '#9333ea', opacity: 0.4,
                  animation: 'ping 1.4s ease-in-out infinite',
                }} />
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#9333ea', display: 'block' }} />
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: '#9333ea', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Snooping
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-soft)' }}>
                {address}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {lastRefresh && (
                <span style={{ fontSize: 11, color: 'var(--ink-mute)', fontFamily: 'var(--mono)' }}>
                  {refreshing ? 'Refreshing…' : `Updated ${lastRefresh.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`}
                </span>
              )}
              <button
                onClick={() => lookup(address, true)}
                disabled={refreshing}
                style={{ background: 'transparent', border: '1px solid rgba(147,51,234,0.3)', borderRadius: 4, color: '#9333ea', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '4px 10px' }}
              >
                ↻ Refresh
              </button>
              <button
                onClick={stopSnoop}
                style={{ background: 'transparent', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--ink-soft)', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '4px 10px' }}
              >
                Stop Snooping ✕
              </button>
            </div>
          </div>

          {/* Account header */}
          <div style={{
            background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10,
            padding: '18px 20px', marginBottom: 20,
            display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
          }}>
            <RoleBadge role={role} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--ink)', wordBreak: 'break-all' }}>
              {address}
            </span>
            <button
              onClick={() => navigator.clipboard.writeText(address)}
              style={{ background: 'var(--rule-soft)', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--ink-soft)', cursor: 'pointer', fontSize: 11, padding: '3px 8px', marginLeft: 'auto' }}
            >
              copy
            </button>
            {masterAddr && (
              <div style={{ width: '100%', borderTop: '1px solid var(--rule-soft)', paddingTop: 10, marginTop: 4, fontSize: 13, color: 'var(--ink-soft)' }}>
                {role === 'agent' ? 'API wallet for' : 'Sub-account of'}
                {' '}
                <button
                  onClick={() => lookup(masterAddr)}
                  style={{ background: 'none', border: 'none', color: 'var(--blue)', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 13, padding: 0, textDecoration: 'underline' }}
                >
                  {shortAddr(masterAddr)}
                </button>
              </div>
            )}
          </div>

          {/* Metrics row */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
            <MetricCard
              label="Perp Equity"
              value={fmtUsd(perpEquity)}
              sub={`Margin used: ${fmtUsd(data.perps.marginSummary.totalMarginUsed)}`}
            />
            <MetricCard
              label="Spot Holdings"
              value={fmtUsd(spotEquity || null)}
              sub={`${spotBalances.length} token${spotBalances.length !== 1 ? 's' : ''}`}
            />
            <MetricCard
              label="Unrealized PnL"
              value={fmtUsd(totalPnl)}
              valueColor={pnlColor(totalPnl)}
              sub={`${positions.length} open position${positions.length !== 1 ? 's' : ''}`}
            />
            <MetricCard
              label="Funding (open)"
              value={fmtUsd(totalFunding)}
              valueColor={pnlColor(totalFunding)}
              sub={`Withdrawable: ${fmtUsd(data.perps.withdrawable)}`}
            />
          </div>

          {/* Charts */}
          <div style={{ marginBottom: 28 }}>
            {/* Range toggle */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--ink-soft)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 700 }}>
                Performance
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['24h', '7d', '30d', 'All'] as ChartRange[]).map(r => (
                  <button key={r} onClick={() => setRange(r)} style={{
                    background: range === r ? 'var(--blue-soft)' : 'transparent',
                    border: '1px solid var(--rule)', borderRadius: 4,
                    color: range === r ? 'var(--blue)' : 'var(--ink-soft)',
                    cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                    padding: '3px 10px',
                  }}>{r}</button>
                ))}
              </div>
            </div>

            {/* Two charts side by side */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <PortfolioChart
                title="Perp + Spot"
                series={data.portfolio[range === '24h' ? 'day' : range === '7d' ? 'week' : range === '30d' ? 'month' : 'allTime']}
                color="var(--blue)"
                range={range}
              />
              <PortfolioChart
                title="Perps Only"
                series={data.portfolio[range === '24h' ? 'perpDay' : range === '7d' ? 'perpWeek' : range === '30d' ? 'perpMonth' : 'perpAllTime']}
                color="#9333ea"
                range={range}
              />
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--rule)', marginBottom: 24 }}>
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  background: 'none', border: 'none', borderBottom: tab === t.id ? '2px solid var(--blue)' : '2px solid transparent',
                  color: tab === t.id ? 'var(--ink)' : 'var(--ink-soft)',
                  cursor: 'pointer', fontFamily: 'var(--sans)', fontSize: 13, fontWeight: tab === t.id ? 600 : 400,
                  padding: '10px 16px', marginBottom: -1, transition: 'color 120ms',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {t.label}
                {t.count !== undefined && t.count > 0 && (
                  <span style={{ background: 'var(--blue-soft)', color: 'var(--blue)', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 6px' }}>
                    {t.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>

            {/* Positions */}
            {tab === 'positions' && (
              <Table
                headers={['Symbol', 'Side', 'Size', 'Entry', 'Mark Value', 'Unr. PnL', 'ROE', 'Leverage', 'Liq. Price', 'Funding']}
                empty="No open positions"
                rows={positions.map(p => {
                  const size = parseFloat(p.szi)
                  const side = size >= 0 ? 'Long' : 'Short'
                  return [
                    <span key="coin" style={{ fontWeight: 600 }}>{p.coin}</span>,
                    <span key="side" style={{ color: size >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{side}</span>,
                    fmtNum(Math.abs(size)),
                    fmtUsd(p.entryPx),
                    fmtUsd(p.positionValue),
                    <span key="pnl" style={{ color: pnlColor(p.unrealizedPnl) }}>{fmtUsd(p.unrealizedPnl)}</span>,
                    <span key="roe" style={{ color: pnlColor(p.returnOnEquity) }}>{fmtPct(p.returnOnEquity)}</span>,
                    `${p.leverage.value}× ${p.leverage.type}`,
                    p.liquidationPx ? fmtUsd(p.liquidationPx) : '—',
                    <span key="fund" style={{ color: pnlColor(p.cumFunding.sinceOpen) }}>{fmtUsd(p.cumFunding.sinceOpen)}</span>,
                  ]
                })}
              />
            )}

            {/* Spot */}
            {tab === 'spot' && (
              <Table
                headers={['Token', 'Balance', 'Hold', 'Entry Value']}
                empty="No spot holdings"
                rows={spotBalances.map(b => [
                  <span key="coin" style={{ fontWeight: 600 }}>{b.coin}</span>,
                  fmtNum(b.total, 6),
                  fmtNum(b.hold, 6),
                  fmtUsd(b.entryNtl),
                ])}
              />
            )}

            {/* Orders */}
            {tab === 'orders' && (
              <Table
                headers={['Symbol', 'Side', 'Size', 'Filled', 'Limit Price', 'Time']}
                empty="No open orders"
                rows={orders.map(o => {
                  const filled = parseFloat(o.origSz) - parseFloat(o.sz)
                  return [
                    <span key="coin" style={{ fontWeight: 600 }}>{resolveCoins(o.coin, data.spotTokenMap)}</span>,
                    <span key="side" style={{ color: o.side === 'B' ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                      {o.side === 'B' ? 'Buy' : 'Sell'}
                    </span>,
                    fmtNum(o.sz),
                    filled > 0 ? fmtNum(filled) : '—',
                    fmtUsd(o.limitPx),
                    fmtTime(o.timestamp),
                  ]
                })}
              />
            )}

            {/* Trades */}
            {tab === 'trades' && (
              <>
                {fills.length > 200 && (
                  <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--ink-mute)', borderBottom: '1px solid var(--rule-soft)' }}>
                    Showing {fills.length} most recent fills
                  </div>
                )}
                <Table
                  headers={['Symbol', 'Side', 'Size', 'Price', 'Direction', 'Closed PnL', 'Fee', 'Time']}
                  empty="No trade history"
                  rows={fills.slice(0, 200).map(f => [
                    <span key="coin" style={{ fontWeight: 600 }}>{resolveCoins(f.coin, data.spotTokenMap)}</span>,
                    <span key="side" style={{ color: f.side === 'B' ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                      {f.side === 'B' ? 'Buy' : 'Sell'}
                    </span>,
                    fmtNum(f.sz),
                    fmtUsd(f.px),
                    <span key="dir" style={{ color: 'var(--ink-soft)', fontSize: 12 }}>{f.dir}</span>,
                    <span key="pnl" style={{ color: pnlColor(f.closedPnl) }}>{fmtUsd(f.closedPnl)}</span>,
                    <span key="fee" style={{ color: 'var(--ink-mute)' }}>{fmtUsd(f.fee)} {f.feeToken}</span>,
                    fmtTime(f.time),
                  ])}
                />
              </>
            )}

            {/* Transactions */}
            {tab === 'transactions' && (
              <Table
                headers={['Type', 'Amount', 'Time', 'Hash']}
                empty="No transactions in last 90 days"
                rows={ledger.map(l => [
                  <span key="type" style={{ fontWeight: 600, textTransform: 'capitalize' }}>{l.delta.type.replace(/_/g, ' ')}</span>,
                  l.delta.usdc
                    ? <span key="amt" style={{ color: parseFloat(l.delta.usdc) >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmtUsd(l.delta.usdc)}</span>
                    : l.delta.amount
                      ? `${fmtNum(l.delta.amount)} ${l.delta.coin ?? ''}`
                      : '—',
                  fmtTime(l.time),
                  <a key="hash" href={`https://app.hyperliquid.xyz/explorer/tx/${l.hash}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--blue)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                    {shortAddr(l.hash)}
                  </a>,
                ])}
              />
            )}

            {/* Sub-accounts */}
            {tab === 'subaccounts' && (
              <Table
                headers={['Name', 'Address', 'Perp Equity', 'Spot Balances', 'Open Pos.']}
                empty="No sub-accounts linked to this address"
                rows={subs.map(s => {
                  const equity = s.clearinghouseState?.marginSummary?.accountValue
                  const spotCount = s.spotState?.balances?.filter(b => parseFloat(b.total) > 0).length ?? 0
                  const posCount = s.clearinghouseState?.assetPositions?.length ?? 0
                  return [
                    <span key="name" style={{ fontWeight: 600 }}>{s.name || '—'}</span>,
                    <button
                      key="addr"
                      onClick={() => lookup(s.subAccountUser)}
                      style={{ background: 'none', border: 'none', color: 'var(--blue)', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 13, padding: 0, textDecoration: 'underline' }}
                    >
                      {shortAddr(s.subAccountUser)}
                    </button>,
                    fmtUsd(equity ?? null),
                    spotCount > 0 ? `${spotCount} token${spotCount !== 1 ? 's' : ''}` : '—',
                    posCount > 0 ? String(posCount) : '—',
                  ]
                })}
              />
            )}

          </div>
        </>
      )}

      {/* Empty state */}
      {!data && !loading && !error && (
        <div style={{
          border: '1px dashed var(--rule)', borderRadius: 10,
          padding: '64px 32px', textAlign: 'center', color: 'var(--ink-mute)',
        }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
          <div style={{ fontSize: 15, marginBottom: 8 }}>Enter any Hyperliquid address to explore their wallet</div>
          <div style={{ fontSize: 13 }}>Positions · Spot · Orders · Trades · Transactions · Sub-accounts</div>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
        @keyframes ping {
          0% { transform: scale(1); opacity: 0.4; }
          75%, 100% { transform: scale(2.2); opacity: 0; }
        }
        input:focus { border-color: var(--blue) !important; }
      `}</style>
    </div>
  )
}

// ── Export (wrapped in Suspense for useSearchParams) ──────────────────────────

export default function Page() {
  return (
    <Suspense>
      <HLTraderDashboard />
    </Suspense>
  )
}
