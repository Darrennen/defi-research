'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import {
  fetchWallet, fmtUsd, fmtNum, fmtPct, fmtTime, shortAddr, resolveCoins,
  fmtFundingRate, annualizedFunding, fundingDirection,
  type HLWalletData, type HLRole, type HLPortfolioSeries, type HLPredictedFundings, type HLFill,
} from '@/lib/hyperliquid'
import { fetchEvmWallet, fmtEvmAmount, HEVM_EXPLORER, groupByProtocol, type EvmWalletData } from '@/lib/hyperevm'

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

function fmtPct24h(mark: string | undefined, prev: string | undefined): string {
  if (!mark || !prev) return '—'
  const m = parseFloat(mark), p = parseFloat(prev)
  if (!p) return '—'
  const chg = (m - p) / p * 100
  return `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`
}

const VENUE_LABELS: Record<string, string> = {
  HlPerp: 'HL', BinPerp: 'Binance', BybPerp: 'Bybit', OkxPerp: 'OKX',
}
const VENUE_ORDER = ['HlPerp', 'BinPerp', 'BybPerp', 'OkxPerp']

const ROLE_META: Record<HLRole, { label: string; color: string; bg: string }> = {
  user:       { label: 'Main Wallet', color: '#0d9488', bg: 'rgba(13,148,136,0.10)' },
  agent:      { label: 'API Wallet',  color: 'var(--blue)', bg: 'var(--blue-soft)' },
  subAccount: { label: 'Sub-Account', color: '#9333ea', bg: 'rgba(147,51,234,0.10)' },
  vault:      { label: 'Vault',       color: 'var(--amber)', bg: 'rgba(178,116,13,0.10)' },
  missing:    { label: 'Unknown',     color: 'var(--ink-soft)', bg: 'var(--rule-soft)' },
}

type Tab = 'overview' | 'positions' | 'spot' | 'orders' | 'trades' | 'funding' | 'transactions' | 'subaccounts' | 'evm' | 'hypeflow'

// ── Sub-components ────────────────────────────────────────────────────────────

const COIN_COLORS = ['#0d9488', '#3b82f6', '#9333ea', '#f59e0b', '#ef4444', '#10b981', '#f97316', '#06b6d4']

// Module-level icon registry — fetched once per session from our cached API route
const _icons: Record<string, string> = {}
let _iconsFetched = false
let _iconsFetch: Promise<void> | null = null

function prefetchIcons(): Promise<void> {
  if (_iconsFetched) return Promise.resolve()
  if (_iconsFetch) return _iconsFetch
  _iconsFetch = fetch('/api/coin-icons')
    .then(r => r.json())
    .then((m: Record<string, string>) => { Object.assign(_icons, m); _iconsFetched = true })
    .catch(() => { _iconsFetched = true })
  return _iconsFetch
}

function CoinIcon({ symbol, size = 26 }: { symbol: string; size?: number }) {
  // Strip HL-specific prefixes to find the base coin (k = 1000x meme coins)
  const key = symbol.replace(/^k/, '').toUpperCase()
  const color = COIN_COLORS[symbol.charCodeAt(0) % COIN_COLORS.length]
  const [imgUrl, setImgUrl] = useState<string | null>(_icons[key] ?? null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    prefetchIcons().then(() => { if (_icons[key]) setImgUrl(_icons[key]) })
  }, [key])

  if (imgUrl && !err) {
    return (
      <img
        src={imgUrl}
        alt={symbol}
        width={size}
        height={size}
        style={{ borderRadius: '50%', flexShrink: 0, display: 'block' }}
        onError={() => setErr(true)}
      />
    )
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', background: color,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.round(size * 0.42), fontWeight: 800, color: '#fff',
      flexShrink: 0, userSelect: 'none', letterSpacing: '-0.02em',
    }}>
      {symbol[0]}
    </div>
  )
}

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

function SectionHead({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-soft)' }}>
        {title}
      </div>
      {right}
    </div>
  )
}

function Table({ headers, rows, empty, alignRight }: {
  headers: string[]
  rows: (string | React.ReactNode)[][]
  empty: string
  alignRight?: number[]
}) {
  if (rows.length === 0) {
    return <div style={{ textAlign: 'center', color: 'var(--ink-mute)', padding: '40px 0', fontSize: 14 }}>{empty}</div>
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={h} style={{
                textAlign: alignRight?.includes(i) ? 'right' : 'left',
                padding: '8px 12px',
                fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                color: 'var(--ink-soft)', borderBottom: '1px solid var(--rule)',
                whiteSpace: 'nowrap',
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
                <td key={j} style={{
                  padding: '10px 12px', fontFamily: 'var(--mono)', color: 'var(--ink)',
                  verticalAlign: 'middle', textAlign: alignRight?.includes(j) ? 'right' : 'left',
                }}>
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

function PortfolioChart({ title, series, color, range }: {
  title: string; series: HLPortfolioSeries | undefined; color: string; range: ChartRange
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
            <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} fill={`url(#${gradId})`} dot={false} activeDot={{ r: 3, fill: color }} />
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

// ── Funding Tab ───────────────────────────────────────────────────────────────

function FundingTab({ data }: { data: HLWalletData }) {
  const [showAll, setShowAll] = useState(false)

  const positions = data.perps.assetPositions.map(ap => ap.position)
  const positionCoins = new Set(positions.map(p => p.coin))

  // Summarise payment history
  const payments = data.userFunding
  const totalReceived = payments.reduce((s, p) => {
    const v = parseFloat(p.delta.usdc)
    return s + (v > 0 ? v : 0)
  }, 0)
  const totalPaid = payments.reduce((s, p) => {
    const v = parseFloat(p.delta.usdc)
    return s + (v < 0 ? Math.abs(v) : 0)
  }, 0)
  const netFunding = totalReceived - totalPaid

  // Compute current hourly funding cost from open positions
  const hourlyFunding = positions.reduce((s, p) => {
    const ctx = data.assetCtxMap.get(p.coin)
    if (!ctx) return s
    const rate = parseFloat(ctx.funding)
    const sz = parseFloat(p.szi)
    const markPx = parseFloat(ctx.markPx)
    const notional = Math.abs(sz) * markPx
    const dir = fundingDirection(p.szi, ctx.funding)
    const hourlyRate = rate / 8
    return s + (dir === 'paying' ? -notional * hourlyRate : notional * hourlyRate)
  }, 0)

  // Build predicted funding table
  const fundingData = data.predictedFundings
  const filteredFunding = showAll
    ? fundingData
    : fundingData.filter(([coin]) => positionCoins.has(coin))

  const presentVenues = new Set<string>()
  for (const [, venues] of fundingData.slice(0, 50)) {
    for (const [v] of venues) presentVenues.add(v)
  }
  const venueOrder = VENUE_ORDER.filter(v => presentVenues.has(v))

  return (
    <div>
      {/* Summary */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
        <MetricCard
          label="Net Funding (90d)"
          value={fmtUsd(netFunding)}
          valueColor={pnlColor(netFunding)}
          sub={`${payments.length} payments`}
        />
        <MetricCard
          label="Total Received"
          value={fmtUsd(totalReceived)}
          valueColor="var(--green)"
          sub="90 days"
        />
        <MetricCard
          label="Total Paid"
          value={fmtUsd(totalPaid)}
          valueColor="var(--red)"
          sub="90 days"
        />
        <MetricCard
          label="Current Hourly"
          value={fmtUsd(hourlyFunding)}
          valueColor={pnlColor(hourlyFunding)}
          sub="Based on open positions"
        />
      </div>

      {/* Cross-exchange predicted fundings */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden', marginBottom: 24 }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Predicted Next Funding — Cross Exchange</div>
          <button
            onClick={() => setShowAll(v => !v)}
            style={{ background: 'var(--blue-soft)', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--blue)', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '4px 10px' }}
          >
            {showAll ? 'Your Positions Only' : 'All Markets'}
          </button>
        </div>
        {filteredFunding.length === 0 ? (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--ink-mute)', fontSize: 13 }}>
            {showAll ? 'No predicted funding data' : 'No open positions — click "All Markets" to see all coins'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '8px 16px', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-soft)', borderBottom: '1px solid var(--rule)' }}>Coin</th>
                  {venueOrder.map(v => (
                    <th key={v} style={{ textAlign: 'right', padding: '8px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: v === 'HlPerp' ? 'var(--blue)' : 'var(--ink-soft)', borderBottom: '1px solid var(--rule)', whiteSpace: 'nowrap' }}>
                      {VENUE_LABELS[v] ?? v}
                    </th>
                  ))}
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-soft)', borderBottom: '1px solid var(--rule)' }}>HL Ann.</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-soft)', borderBottom: '1px solid var(--rule)' }}>Direction</th>
                </tr>
              </thead>
              <tbody>
                {filteredFunding.map(([coin, venues]) => {
                  const venueMap = Object.fromEntries(venues)
                  const hlRate = parseFloat(venueMap['HlPerp']?.fundingRate ?? '0')
                  const hlAnn = annualizedFunding(hlRate) * 100
                  const pos = positions.find(p => p.coin === coin)
                  const dir = pos ? fundingDirection(pos.szi, String(hlRate)) : null
                  return (
                    <tr key={coin} style={{ borderBottom: '1px solid var(--rule-soft)', background: positionCoins.has(coin) ? 'rgba(var(--blue-rgb, 59,130,246),0.03)' : 'transparent' }}>
                      <td style={{ padding: '10px 16px', fontWeight: 600, fontFamily: 'var(--mono)' }}>
                        {coin}
                        {positionCoins.has(coin) && <span style={{ marginLeft: 6, fontSize: 10, background: 'var(--blue-soft)', color: 'var(--blue)', borderRadius: 3, padding: '1px 5px' }}>open</span>}
                      </td>
                      {venueOrder.map(v => {
                        const entry = venueMap[v]
                        const rate = entry ? parseFloat(entry.fundingRate) * 100 : null
                        return (
                          <td key={v} style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: rate == null ? 'var(--ink-mute)' : rate > 0 ? 'var(--red)' : rate < 0 ? 'var(--green)' : 'var(--ink)' }}>
                            {rate == null ? '—' : `${rate >= 0 ? '+' : ''}${rate.toFixed(4)}%`}
                          </td>
                        )
                      })}
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: hlAnn > 0 ? 'var(--red)' : hlAnn < 0 ? 'var(--green)' : 'var(--ink)' }}>
                        {hlAnn >= 0 ? '+' : ''}{hlAnn.toFixed(2)}%
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                        {dir ? (
                          <span style={{ fontSize: 11, fontWeight: 600, color: dir === 'receiving' ? 'var(--green)' : 'var(--red)', background: dir === 'receiving' ? 'rgba(34,197,94,0.08)' : 'rgba(244,63,94,0.08)', borderRadius: 4, padding: '2px 7px' }}>
                            {dir === 'receiving' ? '↑ Receiving' : '↓ Paying'}
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Funding payment history */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>
          Payment History (90 days) — {payments.length} events
        </div>
        <Table
          headers={['Time', 'Coin', 'Position Size', 'Rate (8h)', 'Paid / Received']}
          alignRight={[2, 3, 4]}
          empty="No funding payments in last 90 days"
          rows={payments.slice().reverse().map(p => [
            fmtTime(p.time),
            <span key="coin" style={{ fontWeight: 600 }}>{p.delta.coin}</span>,
            fmtNum(p.delta.szi, 4),
            <span key="rate" style={{ color: parseFloat(p.delta.fundingRate) > 0 ? 'var(--red)' : 'var(--green)' }}>
              {(parseFloat(p.delta.fundingRate) * 100).toFixed(4)}%
            </span>,
            <span key="usdc" style={{ color: pnlColor(p.delta.usdc), fontWeight: 600 }}>
              {parseFloat(p.delta.usdc) >= 0 ? '+' : ''}{fmtUsd(p.delta.usdc)}
            </span>,
          ])}
        />
      </div>
    </div>
  )
}

// ── HYPE Flow tab (per-wallet) ───────────────────────────────────────────────

function encodeHypePhases(fills: HLFill[]) {
  type Ph = { side: 'B' | 'A'; count: number; usd: number; size: number; avgPx: number | null }
  const finish = (c: Omit<Ph, 'avgPx'>): Ph => ({ ...c, avgPx: c.size > 0 ? c.usd / c.size : null })
  if (!fills.length) return []
  const sorted = [...fills].sort((a, b) => a.time - b.time)
  const phases: Ph[] = []
  let cur = { side: sorted[0].side as 'B' | 'A', count: 1, usd: parseFloat(sorted[0].px) * parseFloat(sorted[0].sz), size: parseFloat(sorted[0].sz) }
  for (let i = 1; i < sorted.length; i++) {
    const f = sorted[i]
    const usd = parseFloat(f.px) * parseFloat(f.sz)
    if (f.side === cur.side) { cur.count++; cur.usd += usd; cur.size += parseFloat(f.sz) }
    else { phases.push(finish(cur)); cur = { side: f.side as 'B' | 'A', count: 1, usd, size: parseFloat(f.sz) } }
  }
  phases.push(finish(cur))
  return phases
}

function buildHypeFlowSvg(fills: HLFill[]): string {
  if (fills.length < 2) return ''
  const sorted = [...fills].sort((a, b) => a.time - b.time)
  let cum = 0
  const series = sorted.map(f => {
    const usd = parseFloat(f.px) * parseFloat(f.sz)
    cum += f.side === 'B' ? -usd : usd
    return { t: f.time, v: cum }
  })
  const W = 600, H = 100, P = 4
  const minT = series[0].t, maxT = series[series.length - 1].t
  const vals = series.map(p => p.v)
  const minV = Math.min(...vals, 0), maxV = Math.max(...vals, 0)
  const rangeT = (maxT - minT) || 1, rangeV = (maxV - minV) || 1
  const toX = (t: number) => P + (t - minT) / rangeT * (W - P * 2)
  const toY = (v: number) => H - P - (v - minV) / rangeV * (H - P * 2)
  const z = toY(0), firstX = toX(series[0].t), lastX = toX(series[series.length - 1].t)
  const pts = series.map(p => `${toX(p.t).toFixed(1)},${toY(p.v).toFixed(1)}`).join(' ')
  const lastVal = vals[vals.length - 1]
  const col = lastVal >= 0 ? 'var(--green)' : 'var(--red)'
  const fillPts = `${firstX.toFixed(1)},${z.toFixed(1)} ${pts} ${lastX.toFixed(1)},${z.toFixed(1)}`
  return (
    `<line x1="0" y1="${z.toFixed(1)}" x2="${W}" y2="${z.toFixed(1)}" stroke="var(--rule)" stroke-width="1"/>` +
    `<polygon points="${fillPts}" fill="${lastVal >= 0 ? 'rgba(34,197,94,0.08)' : 'rgba(244,63,94,0.08)'}"/>` +
    `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round"/>`
  )
}

function HypeFlowTab({ data }: { data: HLWalletData }) {
  // Spot HYPE fills: coin is '@{index}' where spotTokenMap maps index → 'HYPE'
  const hypeSpotKey = [...data.spotTokenMap.entries()].find(([, name]) => name === 'HYPE')?.[0]
  const allHypeFills = (data.fills ?? []).filter(f => hypeSpotKey ? f.coin === hypeSpotKey : false)
  const hypeMarkPx   = parseFloat(data.spotAssetCtxMap.get('HYPE')?.markPx ?? data.assetCtxMap.get('HYPE')?.markPx ?? '0')
  const hypeSpotBal  = data.spot.balances?.find(b => b.coin === 'HYPE')
  const netOpenSize  = hypeSpotBal ? parseFloat(hypeSpotBal.total) : 0

  const WINDOWS = [
    { key: '24h',  ms: 86_400_000 },
    { key: '7d',   ms: 604_800_000 },
    { key: '30d',  ms: 2_592_000_000 },
    { key: 'All',  ms: Infinity },
  ] as const

  const computeWindow = (maxMs: number) => {
    const cutoff = maxMs === Infinity ? 0 : Date.now() - maxMs
    const wFills = allHypeFills.filter(f => f.time >= cutoff)
    const buys  = wFills.filter(f => f.side === 'B')
    const sells = wFills.filter(f => f.side === 'A')
    const buyUsd  = buys.reduce((s, f)  => s + parseFloat(f.px) * parseFloat(f.sz), 0)
    const sellUsd = sells.reduce((s, f) => s + parseFloat(f.px) * parseFloat(f.sz), 0)
    const buySize  = buys.reduce((s, f)  => s + parseFloat(f.sz), 0)
    const sellSize = sells.reduce((s, f) => s + parseFloat(f.sz), 0)
    const realizedPnl = wFills.reduce((s, f) => s + parseFloat(f.closedPnl || '0'), 0)
    const phases = encodeHypePhases(wFills)
    const sequence = [...wFills].sort((a, b) => a.time - b.time)
    return {
      fills: wFills, buys: buys.length, sells: sells.length,
      buyUsd, sellUsd, buySize, sellSize, realizedPnl, phases, sequence,
      avgBuyPx:  buySize  > 0 ? buyUsd  / buySize  : null,
      avgSellPx: sellSize > 0 ? sellUsd / sellSize : null,
    }
  }

  if (allHypeFills.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--ink-mute)', fontSize: 14 }}>
        No spot HYPE trades found for this wallet
      </div>
    )
  }

  const sfmt = (n: number) => {
    const abs = Math.abs(n), s = n < 0 ? '-' : ''
    if (abs >= 1e6) return s + '$' + (abs / 1e6).toFixed(2) + 'M'
    if (abs >= 1e3) return s + '$' + (abs / 1e3).toFixed(1) + 'K'
    return s + '$' + abs.toFixed(2)
  }

  return (
    <div>
      {/* spot holding banner */}
      {(netOpenSize > 0 || hypeMarkPx > 0) && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, padding: '14px 20px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--ink-mute)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 3 }}>Spot HYPE Balance</div>
            <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 20 }}>
              {netOpenSize > 0 ? netOpenSize.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '0'} HYPE
            </div>
          </div>
          {hypeMarkPx > 0 && netOpenSize > 0 && (
            <div style={{ borderLeft: '1px solid var(--rule)', paddingLeft: 20 }}>
              <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginBottom: 3 }}>Value</div>
              <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 16 }}>{sfmt(netOpenSize * hypeMarkPx)}</div>
            </div>
          )}
          {hypeMarkPx > 0 && (
            <div style={{ borderLeft: '1px solid var(--rule)', paddingLeft: 20 }}>
              <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginBottom: 3 }}>Spot Price</div>
              <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 16 }}>${hypeMarkPx.toFixed(3)}</div>
            </div>
          )}
          <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-mute)' }}>
            {allHypeFills.length} spot fills in history
          </div>
        </div>
      )}

      {/* 3-window grid (24h / 7d / 30d) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
        {WINDOWS.slice(0, 3).map(({ key, ms }) => {
          const w = computeWindow(ms)
          const hasTrades = w.buys + w.sells > 0
          const total = w.buyUsd + w.sellUsd || 1
          const pctBuy = w.buyUsd / total * 100
          const borderCol = !hasTrades ? 'var(--rule)' : w.realizedPnl >= 0 ? 'var(--green)' : 'var(--red)'
          return (
            <div key={key} style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderTop: `2px solid ${borderCol}`, borderRadius: 10, padding: '18px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--ink-soft)' }}>{key}</span>
                {hasTrades && (
                  <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 3, letterSpacing: '0.1em', background: w.realizedPnl >= 0 ? 'rgba(34,197,94,0.15)' : 'rgba(244,63,94,0.15)', color: w.realizedPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {w.realizedPnl >= 0 ? 'PROFIT' : 'LOSS'}
                  </span>
                )}
              </div>

              {hasTrades ? (
                <>
                  {/* Realized PnL hero */}
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginBottom: 4 }}>Realized PnL</div>
                    <div style={{ fontFamily: 'var(--mono)', fontWeight: 800, fontSize: 26, lineHeight: 1, color: pnlColor(w.realizedPnl) }}>
                      {w.realizedPnl >= 0 ? '+' : ''}{sfmt(w.realizedPnl)}
                    </div>
                  </div>

                  {/* Phase narrative */}
                  {w.phases.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                        <span style={{ fontSize: 9, color: 'var(--ink-mute)', letterSpacing: '0.1em', textTransform: 'uppercase', marginRight: 2 }}>flow</span>
                        {w.phases.map((ph, i) => (
                          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {i > 0 && <span style={{ fontSize: 11, color: 'var(--ink-mute)' }}>→</span>}
                            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                              <span style={{ fontSize: 12, fontWeight: 700, color: ph.side === 'B' ? 'var(--green)' : 'var(--red)' }}>
                                {ph.side === 'B' ? '▲ Buy' : '▼ Sell'}
                              </span>
                              {ph.avgPx !== null && (
                                <span style={{ fontSize: 9, color: 'var(--ink-mute)', fontFamily: 'var(--mono)' }}>
                                  ${ph.avgPx.toFixed(3)}
                                </span>
                              )}
                            </span>
                          </span>
                        ))}
                      </div>
                      {/* Trade sequence dots */}
                      <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                        {w.sequence.slice(0, 80).map((f, i) => (
                          <div key={i} title={`${f.side === 'B' ? 'BUY' : 'SELL'} ${parseFloat(f.sz).toFixed(2)} HYPE @ $${parseFloat(f.px).toFixed(3)}\n${new Date(f.time).toLocaleString()}`}
                            style={{ width: 7, height: 16, borderRadius: 2, background: f.side === 'B' ? 'var(--green)' : 'var(--red)', opacity: 0.8 }} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Buy/Sell stats */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginBottom: 2 }}>Bought</div>
                      <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--green)', fontSize: 15 }}>{sfmt(w.buyUsd)}</div>
                      <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 1 }}>{w.buys} trades</div>
                      {w.avgBuyPx !== null && <div style={{ fontSize: 10, color: 'var(--ink-mute)', fontFamily: 'var(--mono)' }}>avg ${w.avgBuyPx.toFixed(3)}</div>}
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginBottom: 2 }}>Sold</div>
                      <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--red)', fontSize: 15 }}>{sfmt(w.sellUsd)}</div>
                      <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 1 }}>{w.sells} trades</div>
                      {w.avgSellPx !== null && <div style={{ fontSize: 10, color: 'var(--ink-mute)', fontFamily: 'var(--mono)' }}>avg ${w.avgSellPx.toFixed(3)}</div>}
                    </div>
                  </div>

                  {/* Buy/sell bar */}
                  <div style={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', background: 'var(--rule)' }}>
                    <div style={{ width: pctBuy.toFixed(1) + '%', background: 'var(--green)', transition: 'width .4s' }} />
                    <div style={{ flex: 1, background: 'var(--red)' }} />
                  </div>
                </>
              ) : (
                <div style={{ color: 'var(--ink-mute)', fontSize: 13 }}>No HYPE trades in this window</div>
              )}
            </div>
          )
        })}
      </div>

      {/* Cumulative flow chart (all fills) */}
      {allHypeFills.length >= 2 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>Cumulative Flow · All Time</div>
          <svg viewBox="0 0 600 100" preserveAspectRatio="none" style={{ width: '100%', height: 100, display: 'block' }}
            dangerouslySetInnerHTML={{ __html: buildHypeFlowSvg(allHypeFills) }} />
          <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 6 }}>
            {allHypeFills.length} fills — green = net bought, red = net sold
          </div>
        </div>
      )}

      {/* Fill history table */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>
          Spot HYPE Trade History ({allHypeFills.length})
        </div>
        <Table
          headers={['Time', 'Side', 'Price', 'Size', 'USD', 'Direction', 'Closed PnL']}
          alignRight={[2, 3, 4, 6]}
          empty="No fills"
          rows={[...allHypeFills].sort((a, b) => b.time - a.time).slice(0, 200).map(f => {
            const usd = parseFloat(f.px) * parseFloat(f.sz)
            const cpnl = parseFloat(f.closedPnl || '0')
            return [
              fmtTime(f.time),
              <span key="side" style={{ fontWeight: 700, color: f.side === 'B' ? 'var(--green)' : 'var(--red)' }}>{f.side === 'B' ? 'Buy' : 'Sell'}</span>,
              `$${parseFloat(f.px).toFixed(3)}`,
              parseFloat(f.sz).toLocaleString('en-US', { maximumFractionDigits: 2 }),
              sfmt(usd),
              <span key="dir" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{f.dir}</span>,
              <span key="pnl" style={{ color: cpnl !== 0 ? pnlColor(cpnl) : 'var(--ink-mute)', fontWeight: cpnl !== 0 ? 600 : 400 }}>
                {cpnl !== 0 ? (cpnl >= 0 ? '+' : '') + sfmt(cpnl) : '—'}
              </span>,
            ]
          })}
        />
      </div>
    </div>
  )
}

// ── Overview panel (DeBank-style) ─────────────────────────────────────────────

function ChainBadge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color, background: `${color}18`, border: `1px solid ${color}40`, borderRadius: 4, padding: '2px 7px', fontFamily: 'var(--mono)' }}>
      {label}
    </span>
  )
}

function SectionDivider({ label, sub }: { label: string; sub: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, marginTop: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-soft)' }}>{label}</span>
      <ChainBadge label={sub} color="var(--blue)" />
      <div style={{ flex: 1, height: 1, background: 'var(--rule)' }} />
    </div>
  )
}

// ── Liquidation risk ──────────────────────────────────────────────────────────

type LiqRisk = 'critical' | 'high' | 'medium' | 'safe' | 'none'

function liqRisk(markPx: string | undefined, liqPx: string | undefined, isLong: boolean): LiqRisk {
  if (!markPx || !liqPx) return 'none'
  const mark = parseFloat(markPx)
  const liq  = parseFloat(liqPx)
  if (!mark || !liq || liq <= 0) return 'none'
  const dist = isLong
    ? (mark - liq) / mark * 100   // long liquidates below
    : (liq - mark) / mark * 100   // short liquidates above
  if (dist < 5)  return 'critical'
  if (dist < 10) return 'high'
  if (dist < 20) return 'medium'
  return 'safe'
}

const LIQ_RISK_META: Record<LiqRisk, { label: string; color: string; bg: string } | null> = {
  critical: { label: '⚠ DANGER',  color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
  high:     { label: '▲ HIGH',    color: '#f97316', bg: 'rgba(249,115,22,0.10)' },
  medium:   { label: '~ WATCH',   color: '#eab308', bg: 'rgba(234,179,8,0.10)'  },
  safe:     { label: '✓ SAFE',    color: 'var(--green)', bg: 'rgba(34,197,94,0.08)' },
  none:     null,
}

function LiqBadge({ risk }: { risk: LiqRisk }) {
  const m = LIQ_RISK_META[risk]
  if (!m) return <span style={{ color: 'var(--ink-mute)' }}>—</span>
  return (
    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', color: m.color, background: m.bg, borderRadius: 4, padding: '2px 7px', whiteSpace: 'nowrap' }}>
      {m.label}
    </span>
  )
}

function ViewAllFooter({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{ padding: '10px 16px', borderTop: '1px solid var(--rule-soft)', cursor: 'pointer', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4, color: 'var(--blue)', fontSize: 12, fontWeight: 600 }}
    >
      {label} →
    </div>
  )
}

function OverviewPanel({
  data, evmData, evmLoading, evmError, setTab,
}: {
  data: HLWalletData
  evmData: EvmWalletData | null
  evmLoading: boolean
  evmError: string | null
  setTab: (t: Tab) => void
}) {
  const positions = data.perps.assetPositions.map(ap => ap.position)
  const spotBalances = (data.spot.balances ?? []).filter(b => parseFloat(b.total) > 0)
  const orders = data.orders ?? []
  const fundingPayments = data.userFunding ?? []
  const totalPnl = positions.reduce((s, p) => s + parseFloat(p.unrealizedPnl || '0'), 0)
  const totalFunding = positions.reduce((s, p) => s + parseFloat(p.cumFunding?.sinceOpen || '0'), 0)
  const netFunding90d = fundingPayments.reduce((s, p) => s + parseFloat(p.delta.usdc), 0)

  // ── Net worth calculation ──────────────────────────────
  const hypePrice = parseFloat(data.assetCtxMap.get('HYPE')?.markPx ?? '0')
  const btcPrice  = parseFloat(data.assetCtxMap.get('BTC')?.markPx  ?? '0')
  const ethPrice  = parseFloat(data.assetCtxMap.get('ETH')?.markPx  ?? '0')

  const STABLES   = new Set(['USDC','USDT0','USDT','FEUSD','USH','USDHL','USDE','SUSDE','USR','USDH','USDH'])
  const HYPE_LIKE = new Set(['WHYPE','KHYPE','STHYPE','WSTHYPE','LSTHYPE','BEHYPE','HBHYPE','FLOWHYPE','HIHYPE','KMHYPE'])

  function tokenUsd(symbol: string, amount: number): number | null {
    const s = symbol.split(/[\s→]/)[0].toUpperCase()
    if (STABLES.has(s))   return amount
    if (s === 'HYPE' || HYPE_LIKE.has(s)) return amount * hypePrice
    if (s === 'UBTC')     return amount * btcPrice
    if (s === 'UETH' || s === 'CMETH') return amount * ethPrice
    const ctx = data.assetCtxMap.get(s) ?? data.spotAssetCtxMap.get(s)
    if (ctx) return amount * parseFloat(ctx.markPx)
    return null
  }

  // HyperCore: perp equity (includes unrealized PnL) + spot current value
  const perpEquity = parseFloat(data.perps.marginSummary.accountValue ?? '0')
  const spotValue  = spotBalances.reduce((s, b) => {
    const amount = parseFloat(b.total)
    // tokenUsd handles stables (USDC = $1) and HYPE — spotAssetCtxMap misses USDC (quote currency)
    const v = tokenUsd(b.coin, amount)
    if (v !== null) return s + v
    const ctx = data.spotAssetCtxMap.get(b.coin)
    return s + (ctx ? amount * parseFloat(ctx.markPx) : 0)
  }, 0)
  const hyperCoreValue = perpEquity + spotValue

  // HyperEVM: native HYPE + wallet tokens + protocol positions (supply − borrow)
  let hyperEvmValue = 0
  let evmApprox = false
  if (evmData) {
    hyperEvmValue += evmData.nativeFormatted * hypePrice
    for (const t of evmData.tokens) {
      const v = tokenUsd(t.symbol, t.formatted)
      if (v !== null) hyperEvmValue += v
      else evmApprox = true
    }
    for (const p of evmData.protocolPositions) {
      const sign = p.type === 'borrow' ? -1 : 1
      const v = tokenUsd(p.asset, p.amount)
      if (v !== null) hyperEvmValue += sign * v
      else evmApprox = true
    }
  }

  const totalNetWorth = hyperCoreValue + hyperEvmValue
  const showEvmTotal  = evmData && !evmLoading

  // ── Derived account stats ──────────────────────────────
  const marginUsed   = parseFloat(data.perps.marginSummary.totalMarginUsed ?? '0')
  const marginUsedPct = perpEquity > 0 ? marginUsed / perpEquity * 100 : 0
  const freeMargin   = perpEquity - marginUsed
  const longNtl      = positions.filter(p => parseFloat(p.szi) > 0).reduce((s, p) => s + parseFloat(p.positionValue), 0)
  const shortNtl     = positions.filter(p => parseFloat(p.szi) < 0).reduce((s, p) => s + parseFloat(p.positionValue), 0)
  const totalNtl     = longNtl + shortNtl
  const acctLeverage = perpEquity > 0 ? totalNtl / perpEquity : 0

  // All-time PnL from portfolio series
  const allTimeSeries = data.portfolio?.allTime?.pnlHistory ?? []
  const allTimePnl = allTimeSeries.length > 0 ? parseFloat(allTimeSeries[allTimeSeries.length - 1][1]) : null

  // Portfolio-level liquidation distance (worst position)
  const liqDistances = positions
    .filter(p => p.liquidationPx)
    .map(p => {
      const ctx = data.assetCtxMap.get(p.coin)
      if (!ctx) return null
      const mark = parseFloat(ctx.markPx), liq = parseFloat(p.liquidationPx!)
      const isLong = parseFloat(p.szi) > 0
      return isLong ? (mark - liq) / mark * 100 : (liq - mark) / mark * 100
    })
    .filter((v): v is number => v !== null)
  const minLiqDist = liqDistances.length > 0 ? Math.min(...liqDistances) : null

  // EVM staked value
  const stakedValue = evmData
    ? evmData.protocolPositions.filter(p => p.type !== 'borrow').reduce((s, p) => {
        const v = tokenUsd(p.asset, p.amount)
        return s + (v ?? 0)
      }, 0) +
      evmData.tokens.filter(t => ['StakedHYPE','Kinetiq','Hyperbeat'].includes(t.protocol)).reduce((s, t) => {
        const v = tokenUsd(t.symbol, t.formatted)
        return s + (v ?? 0)
      }, 0)
    : null

  // ── Analysis from fills ────────────────────────────────
  const fills = data.fills ?? []
  const totalVolume = fills.reduce((s, f) => s + parseFloat(f.px) * parseFloat(f.sz), 0)
  const closingFills = fills.filter(f => parseFloat(f.closedPnl ?? '0') !== 0)
  const winCount = closingFills.filter(f => parseFloat(f.closedPnl) > 0).length
  const winRate  = closingFills.length > 0 ? winCount / closingFills.length * 100 : null

  // Longest win streak
  let maxStreak = 0, streak = 0
  for (const f of [...closingFills].reverse()) {
    if (parseFloat(f.closedPnl) > 0) { streak++; maxStreak = Math.max(maxStreak, streak) }
    else streak = 0
  }

  // Trading style from fills frequency
  const tradingStyle = (() => {
    if (fills.length < 3) return 'Unknown'
    const times = fills.map(f => f.time).sort((a, b) => a - b)
    const spanDays = (times[times.length - 1] - times[0]) / 86400000
    const fillsPerDay = fills.length / Math.max(spanDays, 1)
    if (fillsPerDay > 50)  return 'HFT'
    if (fillsPerDay > 10)  return 'Scalper'
    if (fillsPerDay > 1)   return 'Day Trader'
    if (fillsPerDay > 0.2) return 'Swing Trader'
    return 'Position Trader'
  })()

  // PnL cohort
  const pnlCohort = (() => {
    const p = allTimePnl ?? 0
    if (p >= 1_000_000) return 'Extremely Profitable'
    if (p >= 100_000)   return 'Very Profitable'
    if (p >= 10_000)    return 'Profitable'
    if (p >= 0)         return 'Break Even'
    return 'Unprofitable'
  })()

  // Size cohort
  const sizeCohort = (() => {
    if (perpEquity >= 10_000_000) return 'Apex'
    if (perpEquity >= 1_000_000)  return 'Institutional'
    if (perpEquity >= 100_000)    return 'Pro'
    if (perpEquity >= 10_000)     return 'Intermediate'
    return 'Retail'
  })()

  function StatRow({ label, value, color }: { label: string; value: string; color?: string }) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--rule-soft)' }}>
        <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: color ?? 'var(--ink)' }}>{value}</span>
      </div>
    )
  }

  return (
    <div>
      {/* ── Net Worth Banner ──────────────────────────────── */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 12, padding: '22px 24px', marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700, marginBottom: 6 }}>
          Total Net Worth
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontWeight: 800, fontSize: 34, color: 'var(--ink)', lineHeight: 1, marginBottom: 16 }}>
          {showEvmTotal ? (evmApprox ? '~' : '') : ''}{fmtUsd(showEvmTotal ? totalNetWorth : hyperCoreValue)}
        </div>
        {/* Chain breakdown */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 0, marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--rule-soft)' }}>
          <div style={{ paddingRight: 24, borderRight: '1px solid var(--rule)' }}>
            <div style={{ fontSize: 11, color: 'var(--ink-mute)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--blue)', display: 'inline-block' }} />
              HyperCore L1
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 20 }}>{fmtUsd(hyperCoreValue)}</div>
            <div style={{ marginTop: 6, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--ink-mute)', fontFamily: 'var(--mono)' }}>Perps <span style={{ color: 'var(--ink-soft)' }}>{fmtUsd(perpEquity)}</span></span>
              <span style={{ fontSize: 11, color: 'var(--ink-mute)', fontFamily: 'var(--mono)' }}>Spot <span style={{ color: 'var(--ink-soft)' }}>{fmtUsd(spotValue)}</span></span>
            </div>
          </div>
          <div style={{ paddingLeft: 24 }}>
            <div style={{ fontSize: 11, color: 'var(--ink-mute)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#9333ea', display: 'inline-block' }} />
              HyperEVM Chain 999
              {evmApprox && <span style={{ color: 'var(--ink-mute)', fontSize: 10 }}>· approx.</span>}
            </div>
            {evmLoading ? (
              <div style={{ fontSize: 13, color: 'var(--ink-mute)', fontFamily: 'var(--mono)', paddingTop: 4 }}>Loading…</div>
            ) : showEvmTotal ? (
              <>
                <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 20 }}>{evmApprox ? '~' : ''}{fmtUsd(hyperEvmValue)}</div>
                <div style={{ marginTop: 6, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {stakedValue !== null && stakedValue > 0 && <span style={{ fontSize: 11, color: 'var(--ink-mute)', fontFamily: 'var(--mono)' }}>Staked <span style={{ color: 'var(--ink-soft)' }}>{fmtUsd(stakedValue)}</span></span>}
                  <span style={{ fontSize: 11, color: 'var(--ink-mute)', fontFamily: 'var(--mono)' }}>Tokens <span style={{ color: 'var(--ink-soft)' }}>{evmData!.tokens.length}</span></span>
                  {evmData!.protocolPositions.length > 0 && <span style={{ fontSize: 11, color: 'var(--ink-mute)', fontFamily: 'var(--mono)' }}>DeFi <span style={{ color: 'var(--ink-soft)' }}>{evmData!.protocolPositions.length} pos.</span></span>}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--ink-mute)', fontFamily: 'var(--mono)', paddingTop: 4 }}>—</div>
            )}
          </div>
        </div>
        {/* Account stats grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '8px 24px' }}>
          {[
            { label: 'Account Leverage', value: `${acctLeverage.toFixed(2)}×` },
            { label: 'Margin Usage', value: `${marginUsedPct.toFixed(2)}%`, color: marginUsedPct > 80 ? 'var(--red)' : marginUsedPct > 60 ? 'var(--amber)' : undefined },
            { label: 'Free Margin', value: fmtUsd(freeMargin) },
            { label: 'All Time PnL', value: allTimePnl !== null ? (allTimePnl >= 0 ? '+' : '') + fmtUsd(allTimePnl) : '—', color: allTimePnl !== null ? pnlColor(allTimePnl) : undefined },
            { label: 'Long Exposure', value: fmtUsd(longNtl) },
            { label: 'Short Exposure', value: fmtUsd(shortNtl) },
            { label: 'Closest to Liq.', value: minLiqDist !== null ? `${minLiqDist.toFixed(1)}% away` : '—', color: minLiqDist !== null && minLiqDist < 10 ? 'var(--red)' : undefined },
            { label: 'Volume (fills)', value: fmtUsd(totalVolume) },
          ].map(({ label, value, color }) => (
            <div key={label}>
              <div style={{ fontSize: 10, color: 'var(--ink-mute)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 2 }}>{label}</div>
              <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, color: color ?? 'var(--ink)' }}>{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Analysis ──────────────────────────────────────── */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, padding: '14px 20px', marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-soft)', marginBottom: 10 }}>Analysis</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 32px' }}>
          <div>
            <StatRow label="Trading Style"      value={tradingStyle} />
            <StatRow label="PnL Cohort"         value={pnlCohort} color={allTimePnl !== null && allTimePnl > 0 ? 'var(--green)' : 'var(--red)'} />
            <StatRow label="Size Cohort"        value={sizeCohort} />
          </div>
          <div>
            <StatRow label="Longest Win Streak" value={maxStreak > 0 ? `${maxStreak} trades` : '—'} />
            <StatRow label="Win Rate"           value={winRate !== null ? `${winRate.toFixed(1)}%` : '—'} color={winRate !== null ? (winRate >= 50 ? 'var(--green)' : 'var(--red)') : undefined} />
            <StatRow label="Closing Trades"     value={closingFills.length.toLocaleString()} />
          </div>
        </div>
      </div>

      {/* ── HyperCore ──────────────────────────────────── */}
      <SectionDivider label="HyperCore" sub="HL L1" />

      {/* Perpetuals */}
      {positions.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden', marginBottom: 12 }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>Perpetuals</span>
              <span style={{ background: 'var(--blue-soft)', color: 'var(--blue)', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 7px' }}>{positions.length}</span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 14, color: pnlColor(totalPnl) }}>
                {totalPnl >= 0 ? '+' : ''}{fmtUsd(totalPnl)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--ink-mute)', marginTop: 2 }}>Unrealized PnL</div>
            </div>
          </div>
          {positions.slice(0, 6).map((p, i) => {
            const isLong = parseFloat(p.szi) >= 0
            const ctx = data.assetCtxMap.get(p.coin)
            const risk = liqRisk(ctx?.markPx, p.liquidationPx ?? undefined, isLong)
            return (
              <div key={p.coin} style={{ padding: '10px 16px', borderBottom: i < Math.min(positions.length, 6) - 1 ? '1px solid var(--rule-soft)' : 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
                <CoinIcon symbol={p.coin} size={24} />
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, minWidth: 56 }}>{p.coin}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: isLong ? 'var(--green)' : 'var(--red)', background: isLong ? 'rgba(34,197,94,0.08)' : 'rgba(244,63,94,0.08)', borderRadius: 4, padding: '1px 7px' }}>
                  {isLong ? 'Long' : 'Short'}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-soft)' }}>{fmtUsd(p.positionValue)}</span>
                {ctx && (
                  <span style={{ fontSize: 11, color: 'var(--ink-mute)', fontFamily: 'var(--mono)' }}>
                    {p.leverage.value}×
                  </span>
                )}
                {(risk === 'critical' || risk === 'high') && <LiqBadge risk={risk} />}
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 13, color: pnlColor(p.unrealizedPnl), fontWeight: 600 }}>
                  {parseFloat(p.unrealizedPnl) >= 0 ? '+' : ''}{fmtUsd(p.unrealizedPnl)}
                </span>
              </div>
            )
          })}
          {positions.length > 6 && (
            <div style={{ padding: '8px 16px', color: 'var(--ink-mute)', fontSize: 12, textAlign: 'center', borderTop: '1px solid var(--rule-soft)' }}>
              +{positions.length - 6} more
            </div>
          )}
          <ViewAllFooter label="View all positions" onClick={() => setTab('positions')} />
        </div>
      )}

      {/* Spot */}
      {spotBalances.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden', marginBottom: 12 }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>Spot Holdings</span>
              <span style={{ background: 'var(--blue-soft)', color: 'var(--blue)', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 7px' }}>{spotBalances.length}</span>
            </div>
          </div>
          {spotBalances.slice(0, 5).map((b, i) => (
            <div key={b.coin} style={{ padding: '10px 16px', borderBottom: i < Math.min(spotBalances.length, 5) - 1 ? '1px solid var(--rule-soft)' : 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
              <CoinIcon symbol={b.coin} size={24} />
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, minWidth: 56 }}>{b.coin}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-soft)' }}>{fmtNum(b.total, 4)}</span>
              {parseFloat(b.entryNtl) > 0 && (
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600 }}>{fmtUsd(b.entryNtl)}</span>
              )}
            </div>
          ))}
          {spotBalances.length > 5 && (
            <div style={{ padding: '8px 16px', color: 'var(--ink-mute)', fontSize: 12, textAlign: 'center', borderTop: '1px solid var(--rule-soft)' }}>
              +{spotBalances.length - 5} more
            </div>
          )}
          <ViewAllFooter label="View spot holdings" onClick={() => setTab('spot')} />
        </div>
      )}

      {/* Quick stats row: Orders · Funding */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        {orders.length > 0 && (
          <div
            onClick={() => setTab('orders')}
            style={{ flex: 1, background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <div>
              <div style={{ fontSize: 11, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700, marginBottom: 4 }}>Open Orders</div>
              <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 18 }}>{orders.length}</div>
            </div>
            <span style={{ color: 'var(--blue)', fontSize: 18 }}>→</span>
          </div>
        )}
        <div
          onClick={() => setTab('funding')}
          style={{ flex: 1, background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <div>
            <div style={{ fontSize: 11, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700, marginBottom: 4 }}>Net Funding (90d)</div>
            <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 18, color: pnlColor(netFunding90d) }}>
              {netFunding90d >= 0 ? '+' : ''}{fmtUsd(netFunding90d)}
            </div>
          </div>
          <span style={{ color: 'var(--blue)', fontSize: 18 }}>→</span>
        </div>
        <div
          onClick={() => setTab('trades')}
          style={{ flex: 1, background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <div>
            <div style={{ fontSize: 11, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700, marginBottom: 4 }}>Cum. Funding</div>
            <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 18, color: pnlColor(totalFunding) }}>
              {totalFunding >= 0 ? '+' : ''}{fmtUsd(totalFunding)}
            </div>
          </div>
          <span style={{ color: 'var(--blue)', fontSize: 18 }}>→</span>
        </div>
      </div>

      {/* ── HyperEVM ──────────────────────────────────── */}
      <SectionDivider label="HyperEVM" sub="Chain 999" />

      {evmLoading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {[300, 240, 180].map((w, i) => (
            <div key={i} style={{ height: 16, width: w, borderRadius: 4, background: 'var(--rule)', animation: 'pulse 1.4s ease-in-out infinite', animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
      )}

      {evmError && (
        <div style={{ background: 'rgba(192,57,43,0.08)', border: '1px solid rgba(192,57,43,0.25)', borderRadius: 8, color: 'var(--red)', fontSize: 13, padding: '10px 14px', marginBottom: 12 }}>
          EVM: {evmError}
        </div>
      )}

      {evmData && !evmLoading && (
        <>
          {/* Native HYPE + tx count quick row */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1, background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, padding: '12px 16px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700, marginBottom: 4 }}>Native HYPE</div>
              <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 16 }}>{fmtEvmAmount(evmData.nativeFormatted, 4)}</div>
            </div>
            <div style={{ flex: 1, background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, padding: '12px 16px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700, marginBottom: 4 }}>EVM Txns</div>
              <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 16 }}>{evmData.txCount.toLocaleString()}</div>
            </div>
          </div>

          {/* Protocol positions grouped by protocol */}
          {Array.from(groupByProtocol(evmData.protocolPositions).entries()).map(([protocol, pos]) => (
            <div key={protocol} style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden', marginBottom: 12 }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{protocol}</span>
                <span style={{ background: 'rgba(147,51,234,0.08)', color: '#9333ea', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 7px' }}>{pos.length} position{pos.length !== 1 ? 's' : ''}</span>
              </div>
              {pos.map((p, i) => (
                <div key={i} style={{ padding: '10px 16px', borderBottom: i < pos.length - 1 ? '1px solid var(--rule-soft)' : 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: p.type === 'borrow' ? 'var(--red)' : p.type === 'supply' ? 'var(--blue)' : 'var(--green)', background: p.type === 'borrow' ? 'rgba(244,63,94,0.08)' : p.type === 'supply' ? 'var(--blue-soft)' : 'rgba(34,197,94,0.08)', borderRadius: 4, padding: '2px 7px', textTransform: 'capitalize', minWidth: 52, textAlign: 'center' }}>
                    {p.type}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{p.asset}</span>
                  <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13 }}>
                    {fmtEvmAmount(p.amount, p.decimals > 6 ? 4 : 2)}
                  </span>
                </div>
              ))}
              <ViewAllFooter label="View on HyperEVM" onClick={() => setTab('evm')} />
            </div>
          ))}

          {/* ERC-20 tokens */}
          {evmData.tokens.length > 0 && (
            <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden', marginBottom: 12 }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>Token Holdings</span>
                <span style={{ background: 'var(--blue-soft)', color: 'var(--blue)', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 7px' }}>{evmData.tokens.length}</span>
              </div>
              {evmData.tokens.slice(0, 6).map((t, i) => (
                <div key={t.address} style={{ padding: '10px 16px', borderBottom: i < Math.min(evmData.tokens.length, 6) - 1 ? '1px solid var(--rule-soft)' : 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <CoinIcon symbol={t.symbol} size={22} />
                  <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, minWidth: 64 }}>{t.symbol}</span>
                  <span style={{ fontSize: 11, color: 'var(--ink-mute)' }}>{t.protocol}</span>
                  <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 13 }}>
                    {fmtEvmAmount(t.formatted, t.decimals > 6 ? 4 : 2)}
                  </span>
                </div>
              ))}
              {evmData.tokens.length > 6 && (
                <div style={{ padding: '8px 16px', color: 'var(--ink-mute)', fontSize: 12, textAlign: 'center', borderTop: '1px solid var(--rule-soft)' }}>
                  +{evmData.tokens.length - 6} more
                </div>
              )}
              <ViewAllFooter label="View all tokens" onClick={() => setTab('evm')} />
            </div>
          )}

          {evmData.protocolPositions.length === 0 && evmData.tokens.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--ink-mute)', padding: '32px 0', fontSize: 13 }}>
              No EVM activity detected
            </div>
          )}
        </>
      )}
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
  const [tab, setTab] = useState<Tab>('overview')
  const [range, setRange] = useState<ChartRange>('7d')
  const [history, setHistory] = useState<string[]>([])
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [evmData, setEvmData] = useState<EvmWalletData | null>(null)
  const [evmLoading, setEvmLoading] = useState(false)
  const [evmError, setEvmError] = useState<string | null>(null)
  const [tradeFilter, setTradeFilter] = useState<'perps' | 'spot'>('perps')
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
      setAddress(a); setInput(a); setLoading(true); setError(null); setData(null)
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
      setLoading(false); setRefreshing(false)
    }
  }, [])

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

  // Load EVM data as soon as a wallet is snooped (powers the overview panel)
  useEffect(() => {
    // evmError guard prevents infinite retry: a failed fetch sets evmError, stopping the loop
    if (!address || evmData || evmLoading || evmError) return
    setEvmLoading(true)
    fetchEvmWallet(address)
      .then(d => setEvmData(d))
      .catch(e => setEvmError(e instanceof Error ? e.message : 'Failed to fetch EVM data'))
      .finally(() => setEvmLoading(false))
  }, [address, evmData, evmLoading, evmError])

  function stopSnoop() {
    setData(null); setAddress(''); setInput(''); setError(null); currentAddr.current = ''
    setEvmData(null); setEvmError(null); setEvmLoading(false); setTab('overview')
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const positions = data?.perps.assetPositions.map(ap => ap.position) ?? []
  const spotBalances = (data?.spot.balances ?? []).filter(b => parseFloat(b.total) > 0)
  const orders = data?.orders ?? []
  const fills = data?.fills ?? []
  const ledger = data?.ledger ?? []
  const subs = data?.subAccounts ?? []
  const fundingPayments = data?.userFunding ?? []
  const historicalOrders = data?.historicalOrders ?? []

  const perpEquity = parseFloat(data?.perps.marginSummary.accountValue ?? '0')
  const spotEquity = spotBalances.reduce((s, b) => {
    const n = parseFloat(b.entryNtl)
    return s + (isNaN(n) ? 0 : n)
  }, 0)
  const totalPnl = positions.reduce((s, p) => s + parseFloat(p.unrealizedPnl || '0'), 0)
  const totalFunding = positions.reduce((s, p) => s + parseFloat(p.cumFunding?.sinceOpen || '0'), 0)

  const role = (data?.role.role ?? 'user') as HLRole
  const masterAddr = data?.role.user

  const netFunding90d = fundingPayments.reduce((s, p) => s + parseFloat(p.delta.usdc), 0)

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: 'overview',     label: 'Overview' },
    { id: 'positions',    label: 'Positions',    count: positions.length },
    { id: 'spot',         label: 'Spot',         count: spotBalances.length },
    { id: 'orders',       label: 'Orders',       count: orders.length },
    { id: 'trades',       label: 'Trades',       count: fills.length },
    { id: 'funding',      label: 'Funding',      count: fundingPayments.length },
    { id: 'transactions', label: 'Transactions', count: ledger.length },
    { id: 'subaccounts',  label: 'Sub-Accounts', count: subs.length },
    { id: 'evm',          label: '⬡ HyperEVM' },
    { id: 'hypeflow',    label: '⚡ HYPE Flow' },
  ]

  // ── Normal page (no data loaded) ─────────────────────────────────────────

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
          View any Hyperliquid wallet — positions, spot holdings, orders, trades, funding analysis, and cross-exchange comparison.
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
        <button onClick={() => lookup(input)} disabled={loading} className="btn primary" style={{ padding: '10px 24px', fontSize: 12, letterSpacing: '0.08em' }}>
          {loading ? 'Loading…' : 'Snoop →'}
        </button>
        {address && (
          <button
            onClick={() => navigator.clipboard.writeText(`${window.location.origin}/hl-traders?snoop=${address}`)}
            className="btn ghost"
            style={{ padding: '10px 16px', fontSize: 12, letterSpacing: '0.08em' }}
          >
            Share
          </button>
        )}
      </div>

      {/* History chips */}
      {history.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 32 }}>
          {history.map(a => (
            <button key={a} onClick={() => lookup(a)} style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 20, color: 'var(--ink-soft)', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, padding: '4px 12px' }}>
              {shortAddr(a)}
            </button>
          ))}
          <button onClick={() => { localStorage.removeItem(HISTORY_KEY); setHistory([]) }} style={{ background: 'transparent', border: 'none', color: 'var(--ink-mute)', cursor: 'pointer', fontSize: 11, padding: '4px 6px' }}>
            clear
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ background: 'rgba(192,57,43,0.08)', border: '1px solid rgba(192,57,43,0.25)', borderRadius: 8, color: 'var(--red)', fontSize: 14, padding: '12px 16px', marginBottom: 24 }}>
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 32 }}>
          {[200, 160, 140].map((w, i) => (
            <div key={i} style={{ height: 20, width: w, borderRadius: 4, background: 'var(--rule)', animation: 'pulse 1.4s ease-in-out infinite', animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
      )}

      {/* Results */}
      {data && !loading && (
        <>
          {/* Snoop banner */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(147,51,234,0.08)', border: '1px solid rgba(147,51,234,0.25)', borderRadius: 8, padding: '10px 16px', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ position: 'relative', display: 'inline-flex', width: 10, height: 10 }}>
                <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: '#9333ea', opacity: 0.4, animation: 'ping 1.4s ease-in-out infinite' }} />
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#9333ea', display: 'block' }} />
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: '#9333ea', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Snooping</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-soft)' }}>{address}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {lastRefresh && (
                <span style={{ fontSize: 11, color: 'var(--ink-mute)', fontFamily: 'var(--mono)' }}>
                  {refreshing ? 'Refreshing…' : `Updated ${lastRefresh.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`}
                </span>
              )}
              <button onClick={() => lookup(address, true)} disabled={refreshing} style={{ background: 'transparent', border: '1px solid rgba(147,51,234,0.3)', borderRadius: 4, color: '#9333ea', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '4px 10px' }}>
                ↻ Refresh
              </button>
              <button onClick={stopSnoop} style={{ background: 'transparent', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--ink-soft)', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '4px 10px' }}>
                Stop ✕
              </button>
            </div>
          </div>

          {/* Account header */}
          <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, padding: '18px 20px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <RoleBadge role={role} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--ink)', wordBreak: 'break-all' }}>{address}</span>
            {data.fees && (
              <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-soft)', background: 'var(--rule-soft)', border: '1px solid var(--rule)', borderRadius: 4, padding: '2px 8px' }}>
                Taker {(parseFloat(data.fees.userCrossRate) * 100).toFixed(3)}% · Maker {(parseFloat(data.fees.userAddRate) * 100).toFixed(3)}%
              </span>
            )}
            <button onClick={() => navigator.clipboard.writeText(address)} style={{ background: 'var(--rule-soft)', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--ink-soft)', cursor: 'pointer', fontSize: 11, padding: '3px 8px', marginLeft: 'auto' }}>
              copy
            </button>
            {masterAddr && (
              <div style={{ width: '100%', borderTop: '1px solid var(--rule-soft)', paddingTop: 10, marginTop: 4, fontSize: 13, color: 'var(--ink-soft)' }}>
                {role === 'agent' ? 'API wallet for' : 'Sub-account of'}{' '}
                <button onClick={() => lookup(masterAddr)} style={{ background: 'none', border: 'none', color: 'var(--blue)', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 13, padding: 0, textDecoration: 'underline' }}>
                  {shortAddr(masterAddr)}
                </button>
              </div>
            )}
          </div>

          {/* Metrics */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
            <MetricCard label="Perp Equity" value={fmtUsd(perpEquity)} sub={`Margin used: ${fmtUsd(data.perps.marginSummary.totalMarginUsed)}`} />
            <MetricCard label="Spot Holdings" value={fmtUsd(spotEquity || null)} sub={`${spotBalances.length} token${spotBalances.length !== 1 ? 's' : ''}`} />
            <MetricCard label="Unrealized PnL" value={fmtUsd(totalPnl)} valueColor={pnlColor(totalPnl)} sub={`${positions.length} position${positions.length !== 1 ? 's' : ''}`} />
            <MetricCard label="Funding (open)" value={fmtUsd(totalFunding)} valueColor={pnlColor(totalFunding)} sub={`Net 90d: ${fmtUsd(netFunding90d)}`} />
          </div>

          {/* Charts */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--ink-soft)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 700 }}>Performance</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['24h', '7d', '30d', 'All'] as ChartRange[]).map(r => (
                  <button key={r} onClick={() => setRange(r)} style={{ background: range === r ? 'var(--blue-soft)' : 'transparent', border: '1px solid var(--rule)', borderRadius: 4, color: range === r ? 'var(--blue)' : 'var(--ink-soft)', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, padding: '3px 10px' }}>{r}</button>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <PortfolioChart title="Perp + Spot" series={data.portfolio[range === '24h' ? 'day' : range === '7d' ? 'week' : range === '30d' ? 'month' : 'allTime']} color="var(--blue)" range={range} />
              <PortfolioChart title="Perps Only" series={data.portfolio[range === '24h' ? 'perpDay' : range === '7d' ? 'perpWeek' : range === '30d' ? 'perpMonth' : 'perpAllTime']} color="#9333ea" range={range} />
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--rule)', marginBottom: 24, overflowX: 'auto' }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{ background: 'none', border: 'none', borderBottom: tab === t.id ? '2px solid var(--blue)' : '2px solid transparent', color: tab === t.id ? 'var(--ink)' : 'var(--ink-soft)', cursor: 'pointer', fontFamily: 'var(--sans)', fontSize: 13, fontWeight: tab === t.id ? 600 : 400, padding: '10px 16px', marginBottom: -1, transition: 'color 120ms', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                {t.label}
                {t.count !== undefined && t.count > 0 && (
                  <span style={{ background: 'var(--blue-soft)', color: 'var(--blue)', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 6px' }}>{t.count}</span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}

          {/* Overview */}
          {tab === 'overview' && (
            <OverviewPanel
              data={data}
              evmData={evmData}
              evmLoading={evmLoading}
              evmError={evmError}
              setTab={setTab}
            />
          )}

          {/* Positions */}
          {tab === 'positions' && (() => {
            const atRisk = positions.filter(p => {
              const ctx = data.assetCtxMap.get(p.coin)
              const r = liqRisk(ctx?.markPx, p.liquidationPx ?? undefined, parseFloat(p.szi) >= 0)
              return r === 'critical' || r === 'high'
            })
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {atRisk.length > 0 && (
                  <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 16 }}>⚠</span>
                    <span style={{ fontWeight: 700, color: '#ef4444', fontSize: 13 }}>{atRisk.length} position{atRisk.length > 1 ? 's' : ''} near liquidation:</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-soft)' }}>{atRisk.map(p => p.coin).join(' · ')}</span>
                  </div>
                )}
                <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
                  <Table
                    headers={['Symbol', 'Side', 'Size', 'Entry', 'Mark Value', 'Unr. PnL / ROE', 'Leverage', 'Liq. Price', 'Risk', 'Fund Rate / Cum.', 'OI', '24h Vol']}
                    alignRight={[2, 3, 4, 5, 7, 9, 10, 11]}
                    empty="No open positions"
                    rows={positions.map(p => {
                      const size = parseFloat(p.szi)
                      const isLong = size >= 0
                      const ctx = data.assetCtxMap.get(p.coin)
                      const fundingRate = ctx?.funding ?? '0'
                      const dir = ctx ? fundingDirection(p.szi, fundingRate) : 'neutral'
                      const rateNum = parseFloat(fundingRate) * 100
                      const annNum = parseFloat(fundingRate) * 3 * 365 * 100
                      const pxChange = ctx ? fmtPct24h(ctx.markPx, ctx.prevDayPx) : '—'
                      const pxChgNum = ctx ? (parseFloat(ctx.markPx) - parseFloat(ctx.prevDayPx)) / parseFloat(ctx.prevDayPx) * 100 : 0
                      const risk = liqRisk(ctx?.markPx, p.liquidationPx ?? undefined, isLong)
                      const liqDistPct = ctx && p.liquidationPx
                        ? Math.abs(parseFloat(ctx.markPx) - parseFloat(p.liquidationPx)) / parseFloat(ctx.markPx) * 100
                        : null
                      return [
                        <div key="sym" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <CoinIcon symbol={p.coin} />
                          <div>
                            <div style={{ fontWeight: 700, fontFamily: 'var(--mono)' }}>{p.coin}</div>
                            <div style={{ fontSize: 11, color: pxChgNum >= 0 ? 'var(--green)' : 'var(--red)', marginTop: 2 }}>{pxChange}</div>
                          </div>
                        </div>,
                        <span key="side" style={{ color: isLong ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{isLong ? 'Long' : 'Short'}</span>,
                        fmtNum(Math.abs(size)),
                        fmtUsd(p.entryPx),
                        fmtUsd(p.positionValue),
                        <div key="pnl" style={{ textAlign: 'right' }}>
                          <div style={{ color: pnlColor(p.unrealizedPnl) }}>{fmtUsd(p.unrealizedPnl)}</div>
                          <div style={{ fontSize: 11, color: pnlColor(p.returnOnEquity), marginTop: 2 }}>{fmtPct(p.returnOnEquity)}</div>
                        </div>,
                        `${p.leverage.value}× ${p.leverage.type}`,
                        <div key="liq" style={{ textAlign: 'right' }}>
                          <div>{p.liquidationPx ? fmtUsd(p.liquidationPx) : '—'}</div>
                          {liqDistPct !== null && <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 2 }}>{liqDistPct.toFixed(1)}% away</div>}
                        </div>,
                        <LiqBadge key="risk" risk={risk} />,
                        <div key="fund" style={{ textAlign: 'right' }}>
                          <div style={{ color: dir === 'receiving' ? 'var(--green)' : dir === 'paying' ? 'var(--red)' : 'var(--ink)', fontSize: 12 }}>
                            {rateNum >= 0 ? '+' : ''}{rateNum.toFixed(4)}% <span style={{ color: 'var(--ink-mute)', fontSize: 10 }}>({annNum >= 0 ? '+' : ''}{annNum.toFixed(1)}%yr)</span>
                          </div>
                          <div style={{ fontSize: 11, color: pnlColor(p.cumFunding.sinceOpen), marginTop: 2 }}>{fmtUsd(p.cumFunding.sinceOpen)}</div>
                        </div>,
                        ctx ? fmtUsd(parseFloat(ctx.openInterest) * parseFloat(ctx.markPx)) : '—',
                        ctx ? fmtUsd(ctx.dayNtlVlm) : '—',
                      ]
                    })}
                  />
                </div>
              </div>
            )
          })()}

          {/* Spot */}
          {tab === 'spot' && (
            <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
              <Table
                headers={['Token', 'Balance', 'Hold', 'Entry Value', 'Mark Price', '24h Change', '24h Volume']}
                alignRight={[1, 2, 3, 4, 5, 6]}
                empty="No spot holdings"
                rows={spotBalances.map(b => {
                  const ctx = data.spotAssetCtxMap.get(b.coin)
                  const pxChange = ctx ? fmtPct24h(ctx.markPx, ctx.prevDayPx) : '—'
                  const pxChgNum = ctx ? (parseFloat(ctx.markPx) - parseFloat(ctx.prevDayPx)) / parseFloat(ctx.prevDayPx) * 100 : 0
                  return [
                    <div key="coin" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <CoinIcon symbol={b.coin} size={24} />
                      <span style={{ fontWeight: 700, fontFamily: 'var(--mono)' }}>{b.coin}</span>
                    </div>,
                    fmtNum(b.total, 6),
                    fmtNum(b.hold, 6),
                    fmtUsd(b.entryNtl),
                    ctx ? fmtUsd(ctx.markPx) : '—',
                    <span key="chg" style={{ color: pxChgNum >= 0 ? 'var(--green)' : 'var(--red)' }}>{pxChange}</span>,
                    ctx ? fmtUsd(ctx.dayNtlVlm) : '—',
                  ]
                })}
              />
            </div>
          )}

          {/* Orders */}
          {tab === 'orders' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>Open Orders ({orders.length})</div>
                <Table
                  headers={['Symbol', 'Side', 'Size', 'Filled', 'Limit Price', 'Time']}
                  alignRight={[2, 3, 4]}
                  empty="No open orders"
                  rows={orders.map(o => {
                    const filled = parseFloat(o.origSz) - parseFloat(o.sz)
                    return [
                      <span key="coin" style={{ fontWeight: 600 }}>{resolveCoins(o.coin, data.spotTokenMap)}</span>,
                      <span key="side" style={{ color: o.side === 'B' ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{o.side === 'B' ? 'Buy' : 'Sell'}</span>,
                      fmtNum(o.sz),
                      filled > 0 ? fmtNum(filled) : '—',
                      fmtUsd(o.limitPx),
                      fmtTime(o.timestamp),
                    ]
                  })}
                />
              </div>
              {historicalOrders.length > 0 && (
                <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>Order History ({historicalOrders.length})</div>
                  <Table
                    headers={['Symbol', 'Side', 'Size', 'Limit Price', 'Status', 'Time']}
                    alignRight={[2, 3]}
                    empty="No historical orders"
                    rows={historicalOrders.slice(0, 200).map(o => [
                      <span key="coin" style={{ fontWeight: 600 }}>{resolveCoins(o.coin, data.spotTokenMap)}</span>,
                      <span key="side" style={{ color: o.side === 'B' ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{o.side === 'B' ? 'Buy' : 'Sell'}</span>,
                      fmtNum(o.origSz),
                      fmtUsd(o.limitPx),
                      <span key="status" style={{ fontSize: 11, fontWeight: 600, color: o.status === 'filled' ? 'var(--green)' : o.status === 'cancelled' ? 'var(--ink-mute)' : 'var(--ink-soft)', background: o.status === 'filled' ? 'rgba(34,197,94,0.08)' : 'var(--rule-soft)', borderRadius: 4, padding: '2px 7px', textTransform: 'capitalize' }}>
                        {o.status}
                      </span>,
                      fmtTime(o.timestamp),
                    ])}
                  />
                </div>
              )}
            </div>
          )}

          {/* Trades */}
          {tab === 'trades' && (() => {
            const perpFills = fills.filter(f => !f.coin.startsWith('@'))
            const spotFills = fills.filter(f => f.coin.startsWith('@'))
            const shown = tradeFilter === 'perps' ? perpFills : spotFills

            return (
              <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {(['perps', 'spot'] as const).map(f => (
                    <button key={f} onClick={() => setTradeFilter(f)} style={{
                      background: tradeFilter === f ? 'var(--blue-soft)' : 'transparent',
                      border: '1px solid var(--rule)', borderRadius: 6,
                      color: tradeFilter === f ? 'var(--blue)' : 'var(--ink-soft)',
                      cursor: 'pointer', fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 600,
                      padding: '4px 14px',
                    }}>
                      {f === 'perps' ? 'Perpetuals' : 'Spot'}
                      <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.7 }}>
                        {f === 'perps' ? perpFills.length : spotFills.length}
                      </span>
                    </button>
                  ))}
                  {shown.length > 200 && (
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ink-mute)' }}>Showing 200 of {shown.length}</span>
                  )}
                </div>

                {tradeFilter === 'perps' ? (
                  <Table
                    headers={['Symbol', 'Side', 'Size', 'Price', 'Direction', 'Closed PnL', 'Fee', 'Time']}
                    alignRight={[2, 3, 5, 6]}
                    empty="No perpetual trades"
                    rows={shown.slice(0, 200).map(f => [
                      <span key="coin" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <CoinIcon symbol={f.coin} size={18} />
                        <span style={{ fontWeight: 600 }}>{f.coin}</span>
                      </span>,
                      <span key="side" style={{ color: f.side === 'B' ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>{f.side === 'B' ? 'Buy' : 'Sell'}</span>,
                      fmtNum(f.sz),
                      fmtUsd(f.px),
                      <span key="dir" style={{ color: 'var(--ink-soft)', fontSize: 12 }}>{f.dir}</span>,
                      <span key="pnl" style={{ color: pnlColor(f.closedPnl), fontWeight: 600 }}>{parseFloat(f.closedPnl || '0') !== 0 ? (parseFloat(f.closedPnl) >= 0 ? '+' : '') + fmtUsd(f.closedPnl) : '—'}</span>,
                      <span key="fee" style={{ color: 'var(--ink-mute)' }}>{fmtUsd(f.fee)}</span>,
                      fmtTime(f.time),
                    ])}
                  />
                ) : (
                  <Table
                    headers={['Token', 'Side', 'Amount', 'Price', 'Total', 'Fee', 'Time']}
                    alignRight={[2, 3, 4, 5]}
                    empty="No spot trades"
                    rows={shown.slice(0, 200).map(f => {
                      const name = resolveCoins(f.coin, data.spotTokenMap)
                      const total = parseFloat(f.sz) * parseFloat(f.px)
                      return [
                        <span key="coin" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <CoinIcon symbol={name} size={18} />
                          <span style={{ fontWeight: 600 }}>{name}</span>
                        </span>,
                        <span key="side" style={{ color: f.side === 'B' ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>{f.side === 'B' ? 'Buy' : 'Sell'}</span>,
                        fmtNum(f.sz, 4),
                        fmtUsd(f.px),
                        fmtUsd(total),
                        <span key="fee" style={{ color: 'var(--ink-mute)' }}>{fmtUsd(f.fee)}</span>,
                        fmtTime(f.time),
                      ]
                    })}
                  />
                )}
              </div>
            )
          })()}

          {/* Funding */}
          {tab === 'funding' && <FundingTab data={data} />}

          {/* Transactions */}
          {tab === 'transactions' && (
            <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
              <Table
                headers={['Type', 'Amount', 'Time', 'Hash']}
                alignRight={[1]}
                empty="No transactions in last 90 days"
                rows={ledger.map(l => [
                  <span key="type" style={{ fontWeight: 600, textTransform: 'capitalize' }}>{l.delta.type.replace(/_/g, ' ')}</span>,
                  l.delta.usdc
                    ? <span key="amt" style={{ color: parseFloat(l.delta.usdc) >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmtUsd(l.delta.usdc)}</span>
                    : l.delta.amount ? `${fmtNum(l.delta.amount)} ${l.delta.coin ?? ''}` : '—',
                  fmtTime(l.time),
                  <a key="hash" href={`https://app.hyperliquid.xyz/explorer/tx/${l.hash}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--blue)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                    {shortAddr(l.hash)}
                  </a>,
                ])}
              />
            </div>
          )}

          {/* Sub-accounts */}
          {tab === 'subaccounts' && (
            <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
              <Table
                headers={['Name', 'Address', 'Perp Equity', 'Spot Balances', 'Open Pos.']}
                alignRight={[2, 3, 4]}
                empty="No sub-accounts linked to this address"
                rows={subs.map(s => {
                  const equity = s.clearinghouseState?.marginSummary?.accountValue
                  const spotCount = s.spotState?.balances?.filter(b => parseFloat(b.total) > 0).length ?? 0
                  const posCount = s.clearinghouseState?.assetPositions?.length ?? 0
                  return [
                    <span key="name" style={{ fontWeight: 600 }}>{s.name || '—'}</span>,
                    <button key="addr" onClick={() => lookup(s.subAccountUser)} style={{ background: 'none', border: 'none', color: 'var(--blue)', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 13, padding: 0, textDecoration: 'underline' }}>
                      {shortAddr(s.subAccountUser)}
                    </button>,
                    fmtUsd(equity ?? null),
                    spotCount > 0 ? `${spotCount} token${spotCount !== 1 ? 's' : ''}` : '—',
                    posCount > 0 ? String(posCount) : '—',
                  ]
                })}
              />
            </div>
          )}

          {/* HyperEVM */}
          {tab === 'evm' && (
            <div>
              {/* EVM header */}
              <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, padding: '14px 20px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>⬡ HyperEVM</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-soft)', background: 'var(--rule-soft)', border: '1px solid var(--rule)', borderRadius: 4, padding: '2px 8px' }}>Chain ID: 999</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-soft)', background: 'var(--rule-soft)', border: '1px solid var(--rule)', borderRadius: 4, padding: '2px 8px' }}>rpc.hyperliquid.xyz/evm</span>
                {evmData && (
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>Block #{evmData.blockNumber.toLocaleString()}</span>
                )}
                {evmData && (
                  <button
                    onClick={() => { setEvmData(null); setEvmError(null) }}
                    style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--ink-soft)', cursor: 'pointer', fontSize: 11, padding: '3px 10px' }}
                  >
                    ↻ Refresh
                  </button>
                )}
              </div>

              {evmLoading && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {[240, 180, 140].map((w, i) => (
                    <div key={i} style={{ height: 18, width: w, borderRadius: 4, background: 'var(--rule)', animation: 'pulse 1.4s ease-in-out infinite', animationDelay: `${i * 0.15}s` }} />
                  ))}
                </div>
              )}

              {evmError && (
                <div style={{ background: 'rgba(192,57,43,0.08)', border: '1px solid rgba(192,57,43,0.25)', borderRadius: 8, color: 'var(--red)', fontSize: 14, padding: '12px 16px' }}>
                  {evmError}
                </div>
              )}

              {evmData && !evmLoading && (
                <>
                  {/* EVM stats */}
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
                    <MetricCard
                      label="Native HYPE"
                      value={fmtEvmAmount(evmData.nativeFormatted, 4)}
                      sub="EVM gas balance"
                    />
                    <MetricCard
                      label="EVM Transactions"
                      value={evmData.txCount.toLocaleString()}
                      sub="Total sent from this address"
                    />
                    <MetricCard
                      label="ERC-20 Tokens"
                      value={String(evmData.tokens.length)}
                      sub="Non-zero balances found"
                    />
                    <MetricCard
                      label="Protocol Positions"
                      value={String(evmData.protocolPositions.length)}
                      sub="HyperLend · Staking · Vaults"
                    />
                  </div>

                  {/* DeFi Protocol Positions */}
                  <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>
                      DeFi Protocol Positions ({evmData.protocolPositions.length})
                    </div>
                    <Table
                      headers={['Protocol', 'Type', 'Asset', 'Amount']}
                      alignRight={[3]}
                      empty="No protocol positions detected — try HyperLend, Kinetiq staking, or wstHYPE vault"
                      rows={evmData.protocolPositions.map((p, i) => [
                        <span key="proto" style={{ fontWeight: 600 }}>{p.protocol}</span>,
                        <span key="type" style={{
                          fontSize: 11, fontWeight: 700,
                          color: p.type === 'borrow' ? 'var(--red)' : p.type === 'supply' ? 'var(--blue)' : 'var(--green)',
                          background: p.type === 'borrow' ? 'rgba(244,63,94,0.08)' : p.type === 'supply' ? 'var(--blue-soft)' : 'rgba(34,197,94,0.08)',
                          borderRadius: 4, padding: '2px 7px', textTransform: 'capitalize',
                        }}>
                          {p.type}
                        </span>,
                        <span key="asset" style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{p.asset}</span>,
                        <span key="amt" style={{ fontFamily: 'var(--mono)' }}>
                          {fmtEvmAmount(p.amount, p.decimals > 6 ? 4 : 2)}
                        </span>,
                      ])}
                    />
                  </div>

                  {/* ERC-20 holdings */}
                  <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>
                      ERC-20 Holdings ({evmData.tokens.length})
                    </div>
                    <Table
                      headers={['Token', 'Protocol', 'Balance', 'Contract']}
                      alignRight={[2]}
                      empty="No ERC-20 token balances found"
                      rows={evmData.tokens.map(t => [
                        <span key="sym" style={{ fontWeight: 600 }}>{t.symbol}</span>,
                        <span key="proto" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{t.protocol}</span>,
                        fmtEvmAmount(t.formatted, t.decimals > 6 ? 4 : 2),
                        <a key="addr" href={`${HEVM_EXPLORER}/address/${t.address}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--blue)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                          {shortAddr(t.address)}
                        </a>,
                      ])}
                    />
                  </div>

                  {/* ERC-20 transfer history */}
                  <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>
                      ERC-20 Transfer History ({evmData.transfers.length})
                    </div>
                    <Table
                      headers={['Dir', 'Token', 'Amount', 'From / To', 'Block', 'TX']}
                      alignRight={[2, 4]}
                      empty="No ERC-20 transfers found in recent blocks"
                      rows={evmData.transfers.map(t => [
                        <span key="dir" style={{ fontSize: 11, fontWeight: 700, color: t.direction === 'in' ? 'var(--green)' : 'var(--red)', background: t.direction === 'in' ? 'rgba(34,197,94,0.08)' : 'rgba(244,63,94,0.08)', borderRadius: 4, padding: '2px 8px' }}>
                          {t.direction === 'in' ? '↓ IN' : '↑ OUT'}
                        </span>,
                        <span key="sym" style={{ fontWeight: 600 }}>{t.tokenSymbol}</span>,
                        fmtEvmAmount(t.formatted, t.decimals > 6 ? 4 : 2),
                        <span key="peer" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-soft)' }}>
                          {t.direction === 'in' ? shortAddr(t.from) : shortAddr(t.to)}
                        </span>,
                        t.blockNumber.toLocaleString(),
                        <a key="tx" href={`${HEVM_EXPLORER}/tx/${t.txHash}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--blue)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                          {t.txHash.slice(0, 10)}…
                        </a>,
                      ])}
                    />
                  </div>
                </>
              )}
            </div>
          )}

          {/* HYPE Flow */}
          {tab === 'hypeflow' && (
            <div>
              <HypeFlowTab data={data} />
            </div>
          )}
        </>
      )}

      {/* Empty state */}
      {!data && !loading && !error && (
        <div style={{ border: '1px dashed var(--rule)', borderRadius: 10, padding: '64px 32px', textAlign: 'center', color: 'var(--ink-mute)' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
          <div style={{ fontSize: 15, marginBottom: 8 }}>Enter any Hyperliquid address to explore their wallet</div>
          <div style={{ fontSize: 13 }}>Positions · Spot · Orders · Trades · Funding · Transactions · Sub-accounts</div>
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
        @keyframes ping { 0% { transform: scale(1); opacity: 0.4; } 75%, 100% { transform: scale(2.2); opacity: 0; } }
        input:focus { border-color: var(--blue) !important; }
      `}</style>
    </div>
  )
}

// ── Export ────────────────────────────────────────────────────────────────────

export default function Page() {
  return (
    <Suspense>
      <HLTraderDashboard />
    </Suspense>
  )
}
