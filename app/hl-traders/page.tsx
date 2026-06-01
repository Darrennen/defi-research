'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import HypeMarket from './HypeMarket'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import {
  fetchWallet, getDelegatorSummary, getSubAccounts, fmtUsd, fmtNum, fmtPct, fmtTime, shortAddr, resolveCoins,
  fmtFundingRate, annualizedFunding, fundingDirection,
  type HLWalletData, type HLRole, type HLPosition, type HLPortfolioSeries, type HLPredictedFundings, type HLFill,
  type HLTwapOrder, type HLTwapHistoryEntry, type HLDelegatorSummary,
} from '@/lib/hyperliquid'
import { fetchEvmWallet, fmtEvmAmount, HEVM_EXPLORER, groupByProtocol, type EvmWalletData } from '@/lib/hyperevm'

// ── Helpers ───────────────────────────────────────────────────────────────────

const HISTORY_KEY = 'hl-trader-history'
const WATCHLIST_KEY = 'hl-trader-watchlist'
const ENTITIES_KEY  = 'hl-trader-entities'
const MAX_HISTORY = 8

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') } catch { return [] }
}

function saveHistory(addr: string) {
  const h = loadHistory().filter(a => a !== addr)
  h.unshift(addr)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, MAX_HISTORY)))
}

type WatchEntry  = { addr: string; label: string; entityId?: string }
type WatchEntity = { id: string; name: string }

function loadWatchlist(): WatchEntry[] {
  try { return JSON.parse(localStorage.getItem(WATCHLIST_KEY) ?? '[]') } catch { return [] }
}
function saveWatchlist(list: WatchEntry[]) {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list))
}
function loadEntities(): WatchEntity[] {
  try { return JSON.parse(localStorage.getItem(ENTITIES_KEY) ?? '[]') } catch { return [] }
}
function saveEntities(list: WatchEntity[]) {
  localStorage.setItem(ENTITIES_KEY, JSON.stringify(list))
}

// On-chain account relationships visible from a single wallet: itself, its master
// (if it's an agent/sub-account), and any sub-accounts it owns. These are the same
// real-world entity, so we can offer to group them automatically.
type RelatedAccount = { addr: string; label: string; role: HLRole }
function relatedAccounts(data: HLWalletData, address: string): RelatedAccount[] {
  const seen = new Set<string>()
  const out: RelatedAccount[] = []
  const push = (addr: string | undefined | null, label: string, role: HLRole) => {
    if (!addr) return
    const a = addr.toLowerCase()
    if (seen.has(a)) return
    seen.add(a)
    out.push({ addr: a, label, role })
  }
  const selfLabel =
    data.role.role === 'subAccount' ? 'This Sub-account' :
    data.role.role === 'agent'      ? 'API Wallet' :
    data.role.role === 'vault'      ? 'Vault' : 'Main Wallet'
  push(address, selfLabel, data.role.role)
  push(data.role.user, 'Master', 'user')
  data.subAccounts.forEach((s, i) => push(s.subAccountUser, s.name || `Sub #${i + 1}`, 'subAccount'))
  return out
}

const ENTITY_COLORS = ['#0d9488','#3b82f6','#9333ea','#f59e0b','#ef4444','#10b981','#f97316','#06b6d4']
function entityColor(index: number) { return ENTITY_COLORS[index % ENTITY_COLORS.length] }

// ── Multi-dex helpers ───────────────────────────────────────────────────────
// Main-dex + builder-dex (HIP-3) perps are merged so positions, equity, leverage
// and margin reflect the whole account. Builder positions carry a `_dex` tag and
// dex-prefixed coin names (e.g. "xyz:MU"); main-dex positions have `_dex === ''`.

type TaggedPosition = HLPosition & { _dex: string }

function allPerpPositions(data: HLWalletData): TaggedPosition[] {
  const main = data.perps.assetPositions.map(ap => ({ ...ap.position, _dex: '' }))
  const builder = data.builderDexes.flatMap(bd =>
    bd.perps.assetPositions.map(ap => ({ ...ap.position, _dex: bd.name }))
  )
  return [...main, ...builder]
}

function combinedPerpEquity(data: HLWalletData): number {
  return parseFloat(data.perps.marginSummary.accountValue ?? '0') +
    data.builderDexes.reduce((s, bd) => s + parseFloat(bd.perps.marginSummary.accountValue ?? '0'), 0)
}

function combinedMarginUsed(data: HLWalletData): number {
  return parseFloat(data.perps.marginSummary.totalMarginUsed ?? '0') +
    data.builderDexes.reduce((s, bd) => s + parseFloat(bd.perps.marginSummary.totalMarginUsed ?? '0'), 0)
}

// Split a perp coin into its dex tag and bare symbol: "xyz:MU" → {dex:'xyz', sym:'MU'}.
function splitCoin(coin: string): { dex: string; sym: string } {
  const i = coin.indexOf(':')
  return i === -1 ? { dex: '', sym: coin } : { dex: coin.slice(0, i), sym: coin.slice(i + 1) }
}

function DexTag({ dex }: { dex: string }) {
  if (!dex) return null
  return (
    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#9333ea', background: 'rgba(147,51,234,0.10)', border: '1px solid rgba(147,51,234,0.25)', borderRadius: 3, padding: '1px 5px', fontFamily: 'var(--mono)' }}>
      {dex}
    </span>
  )
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

type Tab = 'overview' | 'positions' | 'spot' | 'orders' | 'trades' | 'funding' | 'staking' | 'transactions' | 'subaccounts' | 'evm' | 'hypeflow'

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

  const positions = allPerpPositions(data)
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

// ── Staking Tab ───────────────────────────────────────────────────────────────

function StakingTab({ data }: { data: HLWalletData }) {
  const summary = data.delegatorSummary
  const delegations = data.delegations
  const rewards = data.delegatorRewards
  const history = data.delegatorHistory
  const hypePrice = parseFloat(data.assetCtxMap.get('HYPE')?.markPx ?? '0')

  const delegated   = parseFloat(summary?.delegated ?? '0')
  const undelegated = parseFloat(summary?.undelegated ?? '0')
  const pending     = parseFloat(summary?.totalPendingWithdrawal ?? '0')
  const totalRewards = rewards.reduce((s, r) => s + parseFloat(r.totalAmount), 0)
  const usd = (h: number) => hypePrice > 0 ? fmtUsd(h * hypePrice) : '—'

  if (!summary && delegations.length === 0 && rewards.length === 0 && history.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--ink-mute)', fontSize: 14 }}>
        No HYPE staking activity for this wallet
      </div>
    )
  }

  const histLabel = (h: typeof history[number]): { action: string; amount: string; detail: string; color: string } => {
    const d = h.delta
    if (d.delegate) return {
      action: d.delegate.isUndelegate ? 'Undelegate' : 'Delegate',
      amount: `${fmtNum(d.delegate.amount, 4)} HYPE`,
      detail: shortAddr(d.delegate.validator),
      color: d.delegate.isUndelegate ? 'var(--red)' : 'var(--green)',
    }
    if (d.withdrawal) return { action: 'Withdrawal', amount: `${fmtNum(d.withdrawal.amount, 4)} HYPE`, detail: d.withdrawal.phase, color: 'var(--ink-soft)' }
    if (d.cDeposit)  return { action: 'Deposit to staking', amount: `${fmtNum(d.cDeposit.amount, 4)} HYPE`, detail: '', color: 'var(--blue)' }
    return { action: '—', amount: '—', detail: '', color: 'var(--ink)' }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
        <MetricCard label="Delegated" value={`${fmtNum(delegated, 2)} HYPE`} sub={usd(delegated)} />
        <MetricCard label="Rewards Earned" value={`${fmtNum(totalRewards, 4)} HYPE`} valueColor="var(--green)" sub={`${usd(totalRewards)} · ${rewards.length} payouts`} />
        <MetricCard label="Pending Withdrawal" value={`${fmtNum(pending, 2)} HYPE`} sub={`${summary?.nPendingWithdrawals ?? 0} pending · ${fmtNum(undelegated, 2)} undelegated`} />
        <MetricCard label="Validators" value={String(delegations.length)} sub="delegated to" />
      </div>

      <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>Delegations ({delegations.length})</div>
        <Table
          headers={['Validator', 'Amount', 'USD Value', 'Locked Until']}
          alignRight={[1, 2, 3]}
          empty="No active delegations"
          rows={[...delegations].sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount)).map(d => [
            <span key="v" style={{ fontFamily: 'var(--mono)' }}>{shortAddr(d.validator)}</span>,
            `${fmtNum(d.amount, 4)} HYPE`,
            usd(parseFloat(d.amount)),
            d.lockedUntilTimestamp ? fmtTime(d.lockedUntilTimestamp) : '—',
          ])}
        />
      </div>

      <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>Reward History ({rewards.length}) · {fmtNum(totalRewards, 4)} HYPE total</div>
        <Table
          headers={['Time', 'Source', 'Amount']}
          alignRight={[2]}
          empty="No staking rewards yet"
          rows={[...rewards].sort((a, b) => b.time - a.time).slice(0, 200).map(r => [
            fmtTime(r.time),
            <span key="s" style={{ textTransform: 'capitalize', color: 'var(--ink-soft)' }}>{r.source}</span>,
            <span key="a" style={{ color: 'var(--green)', fontWeight: 600 }}>+{fmtNum(r.totalAmount, 6)} HYPE</span>,
          ])}
        />
      </div>

      <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>Staking History ({history.length})</div>
        <Table
          headers={['Time', 'Action', 'Amount', 'Detail']}
          alignRight={[2]}
          empty="No staking transactions"
          rows={[...history].sort((a, b) => b.time - a.time).map(h => {
            const l = histLabel(h)
            return [
              fmtTime(h.time),
              <span key="act" style={{ fontWeight: 600, color: l.color }}>{l.action}</span>,
              l.amount,
              <span key="d" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>{l.detail}</span>,
            ]
          })}
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
  const hypeSpotKey = [...data.spotTokenMap.entries()].find(([, name]) => name === 'HYPE')?.[0]
  const allHypeFills = (data.fills ?? []).filter(f => hypeSpotKey ? f.coin === hypeSpotKey : false)
  const hypeMarkPx   = parseFloat(data.spotAssetCtxMap.get('HYPE')?.markPx ?? data.assetCtxMap.get('HYPE')?.markPx ?? '0')
  const hypeSpotBal  = data.spot.balances?.find(b => b.coin === 'HYPE')
  const netOpenSize  = hypeSpotBal ? parseFloat(hypeSpotBal.total) : 0

  const WINDOWS = [
    { key: '24h', ms: 86_400_000 },
    { key: '7d',  ms: 604_800_000 },
    { key: '30d', ms: 2_592_000_000 },
    { key: 'All', ms: Infinity },
  ] as const
  type WKey = typeof WINDOWS[number]['key']

  const [selectedRange, setSelectedRange] = useState<WKey>('7d')

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

  const activeWindow = WINDOWS.find(w => w.key === selectedRange)!
  const w = computeWindow(activeWindow.ms)
  const hasTrades = w.buys + w.sells > 0
  const total = w.buyUsd + w.sellUsd || 1
  const pctBuy = w.buyUsd / total * 100
  const borderCol = !hasTrades ? 'var(--rule)' : w.realizedPnl >= 0 ? 'var(--green)' : 'var(--red)'

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

      {/* Range selector */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {WINDOWS.map(({ key, ms }) => {
          const preview = computeWindow(ms)
          const hasAny = preview.buys + preview.sells > 0
          const isActive = selectedRange === key
          return (
            <button
              key={key}
              onClick={() => setSelectedRange(key)}
              style={{
                background: isActive ? 'var(--blue-soft)' : 'var(--card)',
                border: `1px solid ${isActive ? 'var(--blue)' : 'var(--rule)'}`,
                borderRadius: 6, cursor: 'pointer',
                color: isActive ? 'var(--blue)' : 'var(--ink-soft)',
                fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 700,
                padding: '6px 16px', letterSpacing: '0.04em',
              }}
            >
              {key}
              {hasAny && (
                <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.7 }}>
                  {preview.buys + preview.sells}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Selected window detail */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderTop: `2px solid ${borderCol}`, borderRadius: 10, padding: '20px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-soft)' }}>{selectedRange} window</span>
          {hasTrades && (
            <span style={{ fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 4, letterSpacing: '0.08em', background: w.realizedPnl >= 0 ? 'rgba(34,197,94,0.15)' : 'rgba(244,63,94,0.15)', color: w.realizedPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {w.realizedPnl >= 0 ? 'NET PROFIT' : 'NET LOSS'}
            </span>
          )}
        </div>

        {hasTrades ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginBottom: 4 }}>Realized PnL</div>
                <div style={{ fontFamily: 'var(--mono)', fontWeight: 800, fontSize: 28, lineHeight: 1, color: pnlColor(w.realizedPnl) }}>
                  {w.realizedPnl >= 0 ? '+' : ''}{sfmt(w.realizedPnl)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginBottom: 4 }}>Bought</div>
                <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--green)', fontSize: 18 }}>{sfmt(w.buyUsd)}</div>
                <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 2 }}>{w.buys} trades{w.avgBuyPx !== null ? ` · avg $${w.avgBuyPx.toFixed(3)}` : ''}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginBottom: 4 }}>Sold</div>
                <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--red)', fontSize: 18 }}>{sfmt(w.sellUsd)}</div>
                <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 2 }}>{w.sells} trades{w.avgSellPx !== null ? ` · avg $${w.avgSellPx.toFixed(3)}` : ''}</div>
              </div>
            </div>

            {/* Buy/sell bar */}
            <div style={{ display: 'flex', height: 5, borderRadius: 3, overflow: 'hidden', background: 'var(--rule)', marginBottom: 18 }}>
              <div style={{ width: pctBuy.toFixed(1) + '%', background: 'var(--green)', transition: 'width .3s' }} />
              <div style={{ flex: 1, background: 'var(--red)' }} />
            </div>

            {/* Phase narrative */}
            {w.phases.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 9, color: 'var(--ink-mute)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>Trade flow</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
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
                <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                  {w.sequence.slice(0, 120).map((f, i) => (
                    <div key={i} title={`${f.side === 'B' ? 'BUY' : 'SELL'} ${parseFloat(f.sz).toFixed(2)} HYPE @ $${parseFloat(f.px).toFixed(3)}\n${new Date(f.time).toLocaleString()}`}
                      style={{ width: 7, height: 16, borderRadius: 2, background: f.side === 'B' ? 'var(--green)' : 'var(--red)', opacity: 0.8 }} />
                  ))}
                </div>
              </div>
            )}

            {/* Cumulative flow chart for selected range */}
            {w.fills.length >= 2 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginBottom: 6 }}>Cumulative flow · {selectedRange}</div>
                <svg viewBox="0 0 600 100" preserveAspectRatio="none" style={{ width: '100%', height: 80, display: 'block' }}
                  dangerouslySetInnerHTML={{ __html: buildHypeFlowSvg(w.fills) }} />
              </div>
            )}
          </>
        ) : (
          <div style={{ color: 'var(--ink-mute)', fontSize: 13, padding: '20px 0' }}>No HYPE trades in this window</div>
        )}
      </div>

      {/* Fill history table */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>
          Spot HYPE Trades · {selectedRange} ({w.fills.length})
        </div>
        <Table
          headers={['Time', 'Side', 'Price', 'Size', 'USD', 'Direction', 'Closed PnL']}
          alignRight={[2, 3, 4, 6]}
          empty="No fills in this range"
          rows={[...w.fills].sort((a, b) => b.time - a.time).map(f => {
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

// ── Health Ring ───────────────────────────────────────────────────────────────

function HealthRing({ pct, label, sub, color }: { pct: number; label: string; sub: string; color: string }) {
  const r = 44, cx = 52, cy = 52
  const circ = 2 * Math.PI * r
  const offset = circ - (Math.min(Math.max(pct, 0), 100) / 100) * circ
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div style={{ position: 'relative', width: 104, height: 104 }}>
        <svg viewBox="0 0 104 104" style={{ width: 104, height: 104, display: 'block' }}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--rule)" strokeWidth={9} />
          <circle
            cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={9}
            strokeDasharray={`${circ}`} strokeDashoffset={`${offset}`}
            transform="rotate(-90 52 52)" strokeLinecap="round"
          />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ fontFamily: 'var(--mono)', fontWeight: 800, fontSize: 20, lineHeight: 1, color: 'var(--ink)' }}>{pct.toFixed(0)}%</div>
          <div style={{ fontSize: 9, color: 'var(--ink-mute)', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 2 }}>used</div>
        </div>
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--ink-soft)', marginTop: 1 }}>{sub}</div>
      </div>
    </div>
  )
}

// ── Concentration Bars ────────────────────────────────────────────────────────

function ConcentrationBars({ positions }: { positions: Array<{ coin: string; positionValue: string; szi: string }> }) {
  if (positions.length === 0) return (
    <div style={{ color: 'var(--ink-mute)', fontSize: 12, padding: '8px 0' }}>No open positions</div>
  )
  const total = positions.reduce((s, p) => s + Math.abs(parseFloat(p.positionValue)), 0) || 1
  const sorted = [...positions].sort((a, b) => Math.abs(parseFloat(b.positionValue)) - Math.abs(parseFloat(a.positionValue))).slice(0, 9)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, width: '100%' }}>
      {sorted.map(p => {
        const val = Math.abs(parseFloat(p.positionValue))
        const pct = val / total * 100
        const isLong = parseFloat(p.szi) > 0
        return (
          <div key={p.coin} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 42, fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, color: 'var(--ink)', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{splitCoin(p.coin).sym}</div>
            <div style={{ flex: 1, height: 5, background: 'var(--rule-soft)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: isLong ? 'var(--green)' : 'var(--red)', borderRadius: 3 }} />
            </div>
            <div style={{ width: 32, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-soft)', textAlign: 'right', flexShrink: 0 }}>{pct.toFixed(0)}%</div>
          </div>
        )
      })}
    </div>
  )
}

// ── Liq Gauge Mini ────────────────────────────────────────────────────────────

function LiqGaugeMini({ markPx, liqPx, isLong }: { markPx: string | undefined; liqPx: string | undefined; isLong: boolean }) {
  if (!markPx || !liqPx) return null
  const mark = parseFloat(markPx), liq = parseFloat(liqPx)
  if (!mark || !liq || liq <= 0) return null
  const dist = isLong ? (mark - liq) / mark * 100 : (liq - mark) / mark * 100
  const filled = Math.min(dist / 30, 1) * 100
  const color = dist < 5 ? '#ef4444' : dist < 10 ? '#f97316' : dist < 20 ? '#eab308' : 'var(--green)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 90 }}>
      <div style={{ width: 56, height: 3, background: 'var(--rule-soft)', borderRadius: 2, overflow: 'hidden', flexShrink: 0 }}>
        <div style={{ height: '100%', width: `${filled}%`, background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color, fontWeight: 600, whiteSpace: 'nowrap' }}>{dist.toFixed(1)}%</span>
    </div>
  )
}

// ── Activity Feed ─────────────────────────────────────────────────────────────

function ActivityFeed({ fills, spotTokenMap }: { fills: HLFill[]; spotTokenMap: Map<string, string> }) {
  const recent = [...fills].sort((a, b) => b.time - a.time).slice(0, 20)
  if (recent.length === 0) return (
    <div style={{ color: 'var(--ink-mute)', fontSize: 12, padding: '8px 0', textAlign: 'center' }}>No recent fills</div>
  )
  return (
    <div>
      {recent.map((f, i) => {
        const name = f.coin.startsWith('@') ? resolveCoins(f.coin, spotTokenMap) : f.coin
        const usd = parseFloat(f.px) * parseFloat(f.sz)
        const isBuy = f.side === 'B'
        const pnl = parseFloat(f.closedPnl || '0')
        const ts = new Date(f.time)
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 0', borderBottom: i < recent.length - 1 ? '1px solid var(--rule-soft)' : 'none' }}>
            <div style={{ width: 5, height: 5, borderRadius: '50%', background: isBuy ? 'var(--green)' : 'var(--red)', flexShrink: 0 }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: 'var(--ink)', minWidth: 42 }}>{name}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: isBuy ? 'var(--green)' : 'var(--red)' }}>{isBuy ? 'B' : 'S'}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-soft)', flex: 1 }}>{fmtUsd(usd)}</span>
            {pnl !== 0 && <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: pnlColor(pnl), fontWeight: 600 }}>{pnl >= 0 ? '+' : ''}{fmtUsd(pnl)}</span>}
            <span style={{ fontSize: 10, color: 'var(--ink-mute)', whiteSpace: 'nowrap' }}>
              {ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Overview panel (DeBank-style) ─────────────────────────────────────────────

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

// ── hl.eco-style hero widgets ──────────────────────────────────────────────────

function Sparkline({ values, color, id, height = 36 }: { values: number[]; color: string; id: string; height?: number }) {
  if (values.length < 2) return <div style={{ height }} />
  const min = Math.min(...values), max = Math.max(...values)
  const range = (max - min) || 1
  const W = 100
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${(height - 1) - ((v - min) / range) * (height - 2)}`).join(' ')
  const gid = `spk-${id}`
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}>
      <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.30} /><stop offset="100%" stopColor={color} stopOpacity={0} /></linearGradient></defs>
      <polygon points={`0,${height} ${pts} ${W},${height}`} fill={`url(#${gid})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function GaugeBar({ pct, color }: { pct: number; color: string }) {
  const c = Math.max(0, Math.min(100, pct))
  return (
    <div style={{ height: 7, borderRadius: 4, background: 'var(--rule)', overflow: 'hidden' }}>
      <div style={{ width: `${c}%`, height: '100%', background: color, borderRadius: 4 }} />
    </div>
  )
}

function CompositionBar({ parts }: { parts: Array<{ label: string; value: number; color: string }> }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0) || 1
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--rule)' }}>
        {parts.map(p => <div key={p.label} style={{ width: `${Math.max(0, p.value) / total * 100}%`, background: p.color }} />)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {parts.map(p => (
          <div key={p.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ink-soft)' }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: p.color, display: 'inline-block' }} />{p.label}
            </span>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--ink)' }}>{Math.round(p.value / total * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function HeroCard({ label, value, valueColor, children }: { label: string; value: React.ReactNode; valueColor?: string; children?: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={{ fontSize: 10, color: 'var(--ink-mute)', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700 }}>{label}</div>
      <div style={{ fontFamily: 'var(--mono)', fontWeight: 800, fontSize: 22, lineHeight: 1.05, color: valueColor ?? 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
      {children}
    </div>
  )
}

function OverviewPanel({
  data, evmData, evmLoading, evmError, setTab, range, setRange,
}: {
  data: HLWalletData
  evmData: EvmWalletData | null
  evmLoading: boolean
  evmError: string | null
  setTab: (t: Tab) => void
  range: ChartRange
  setRange: (r: ChartRange) => void
}) {
  const positions = allPerpPositions(data)
  const spotBalances = (data.spot.balances ?? []).filter(b => parseFloat(b.total) > 0)
  const orders = data.orders ?? []
  const fundingPayments = data.userFunding ?? []
  const totalPnl = positions.reduce((s, p) => s + parseFloat(p.unrealizedPnl || '0'), 0)
  const totalFunding = positions.reduce((s, p) => s + parseFloat(p.cumFunding?.sinceOpen || '0'), 0)
  const netFunding90d = fundingPayments.reduce((s, p) => s + parseFloat(p.delta.usdc), 0)
  const fills = data.fills ?? []

  const hypePrice = parseFloat(data.assetCtxMap.get('HYPE')?.markPx ?? '0')
  const btcPrice  = parseFloat(data.assetCtxMap.get('BTC')?.markPx  ?? '0')
  const ethPrice  = parseFloat(data.assetCtxMap.get('ETH')?.markPx  ?? '0')

  const STABLES   = new Set(['USDC','USDT0','USDT','FEUSD','USH','USDHL','USDE','SUSDE','USR','USDH','USDHL'])
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

  const perpEquity = combinedPerpEquity(data)
  const spotValue  = spotBalances.reduce((s, b) => {
    const amount = parseFloat(b.total)
    const v = tokenUsd(b.coin, amount)
    if (v !== null) return s + v
    const ctx = data.spotAssetCtxMap.get(b.coin)
    return s + (ctx ? amount * parseFloat(ctx.markPx) : 0)
  }, 0)
  const vaultEquityUsd   = (data.vaultEquities ?? []).reduce((s, v) => s + parseFloat(v.equity || '0'), 0)
  const stakedHypeValue  = parseFloat(data.delegatorSummary?.delegated ?? '0') * hypePrice
  const hyperCoreValue   = perpEquity + spotValue + vaultEquityUsd + stakedHypeValue

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

  const marginUsed    = combinedMarginUsed(data)
  const marginUsedPct = perpEquity > 0 ? marginUsed / perpEquity * 100 : 0
  const freeMargin    = perpEquity - marginUsed
  const longNtl       = positions.filter(p => parseFloat(p.szi) > 0).reduce((s, p) => s + parseFloat(p.positionValue), 0)
  const shortNtl      = positions.filter(p => parseFloat(p.szi) < 0).reduce((s, p) => s + Math.abs(parseFloat(p.positionValue)), 0)
  const totalNtl      = longNtl + shortNtl
  const acctLeverage  = perpEquity > 0 ? totalNtl / perpEquity : 0

  const allTimeSeries = data.portfolio?.allTime?.pnlHistory ?? []
  const allTimePnl = allTimeSeries.length > 0 ? parseFloat(allTimeSeries[allTimeSeries.length - 1][1]) : null

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

  const totalVolume = fills.reduce((s, f) => s + parseFloat(f.px) * parseFloat(f.sz), 0)
  const closingFills = fills.filter(f => parseFloat(f.closedPnl ?? '0') !== 0)
  const winCount = closingFills.filter(f => parseFloat(f.closedPnl) > 0).length
  const winRate  = closingFills.length > 0 ? winCount / closingFills.length * 100 : null

  let maxStreak = 0, worstLossStreak = 0, runW = 0, runL = 0
  for (const f of [...closingFills].sort((a, b) => a.time - b.time)) {
    if (parseFloat(f.closedPnl) > 0) { runW++; runL = 0; maxStreak = Math.max(maxStreak, runW) }
    else { runL++; runW = 0; worstLossStreak = Math.max(worstLossStreak, runL) }
  }
  let curStreakN = 0, curStreakWin = true
  for (const f of [...closingFills].sort((a, b) => b.time - a.time)) {
    const win = parseFloat(f.closedPnl) > 0
    if (curStreakN === 0) { curStreakWin = win; curStreakN = 1 }
    else if (win === curStreakWin) curStreakN++
    else break
  }
  const lossCount = closingFills.length - winCount
  const longCount = positions.filter(p => parseFloat(p.szi) > 0).length
  const shortCount = positions.filter(p => parseFloat(p.szi) < 0).length
  const longPnl = positions.filter(p => parseFloat(p.szi) > 0).reduce((s, p) => s + parseFloat(p.unrealizedPnl || '0'), 0)
  const shortPnl = positions.filter(p => parseFloat(p.szi) < 0).reduce((s, p) => s + parseFloat(p.unrealizedPnl || '0'), 0)
  const avSeries = (data.portfolio?.month?.accountValueHistory ?? data.portfolio?.week?.accountValueHistory ?? []).map(p => parseFloat(p[1]))
  const pnlSeries = allTimeSeries.map(p => parseFloat(p[1]))

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

  const pnlCohort = (() => {
    const p = allTimePnl ?? 0
    if (p >= 1_000_000) return 'Extremely Profitable'
    if (p >= 100_000)   return 'Very Profitable'
    if (p >= 10_000)    return 'Profitable'
    if (p >= 0)         return 'Break Even'
    return 'Unprofitable'
  })()

  const sizeCohort = (() => {
    if (perpEquity >= 10_000_000) return 'Apex'
    if (perpEquity >= 1_000_000)  return 'Institutional'
    if (perpEquity >= 100_000)    return 'Pro'
    if (perpEquity >= 10_000)     return 'Intermediate'
    return 'Retail'
  })()

  const healthColor = marginUsedPct > 80 ? 'var(--red)' : marginUsedPct > 60 ? '#f97316' : 'var(--blue)'

  const panel: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }
  const phead: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 14px 8px', flexShrink: 0 }
  const ptitle: React.CSSProperties = { fontSize: 10, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700 }
  const pbody: React.CSSProperties = { overflowY: 'auto', minHeight: 0, flex: 1 }
  const footerLink = (label: string, t: Tab) => (
    <div onClick={() => setTab(t)} style={{ flexShrink: 0, borderTop: '1px solid var(--rule-soft)', padding: '7px 14px', textAlign: 'center', fontSize: 11, fontWeight: 600, color: 'var(--blue)', cursor: 'pointer' }}>{label} →</div>
  )

  const netWorthSub = `L1 ${fmtUsd(hyperCoreValue)}${stakedHypeValue > 0 ? ` · Staked ${fmtUsd(stakedHypeValue)}` : ''}${vaultEquityUsd > 0 ? ` · Vaults ${fmtUsd(vaultEquityUsd)}` : ''}${showEvmTotal && hyperEvmValue > 0 ? ` · EVM ${fmtUsd(hyperEvmValue)}` : ''}`

  return (
    <div className="ov-root">
      {/* ── Hero metric grid (hl.eco style) ───────────────────────────── */}
      <div className="hlt-hero">
        <HeroCard label="Account Value" value={`${(showEvmTotal ? evmApprox : false) ? '~' : ''}${fmtUsd(showEvmTotal ? totalNetWorth : hyperCoreValue)}`}>
          <div style={{ fontSize: 10, color: 'var(--ink-mute)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={netWorthSub}>{netWorthSub}</div>
          {avSeries.length > 1 && <Sparkline values={avSeries} color="var(--blue)" id="av" />}
        </HeroCard>

        <HeroCard label="All-Time PnL" value={allTimePnl !== null ? `${allTimePnl >= 0 ? '+' : ''}${fmtUsd(allTimePnl)}` : '—'} valueColor={allTimePnl !== null ? pnlColor(allTimePnl) : undefined}>
          <div style={{ fontSize: 10, color: 'var(--ink-mute)' }}>{pnlCohort}</div>
          {pnlSeries.length > 1 && <Sparkline values={pnlSeries} color={allTimePnl !== null && allTimePnl < 0 ? 'var(--red)' : 'var(--green)'} id="pnl" />}
        </HeroCard>

        <HeroCard label="Win Rate" value={winRate !== null ? `${winRate.toFixed(0)}%` : '—'} valueColor={winRate !== null ? (winRate >= 50 ? 'var(--green)' : 'var(--red)') : undefined}>
          <div style={{ fontSize: 11, color: 'var(--ink-soft)', fontFamily: 'var(--mono)' }}>{winCount}W · {lossCount}L · {closingFills.length} trades</div>
          <GaugeBar pct={winRate ?? 0} color={winRate !== null && winRate >= 50 ? 'var(--green)' : 'var(--red)'} />
        </HeroCard>

        <HeroCard label="Current Streak" value={closingFills.length > 0 ? `${curStreakN}${curStreakWin ? 'W' : 'L'}` : '—'} valueColor={closingFills.length > 0 ? (curStreakWin ? 'var(--green)' : 'var(--red)') : undefined}>
          <div style={{ display: 'flex', gap: 12, fontSize: 11, fontFamily: 'var(--mono)' }}>
            <span style={{ color: 'var(--green)' }}>Best {maxStreak}W</span>
            <span style={{ color: 'var(--red)' }}>Worst {worstLossStreak}L</span>
          </div>
        </HeroCard>

        <HeroCard label="Total Volume" value={fmtUsd(totalVolume)}>
          <div style={{ fontSize: 10, color: 'var(--ink-mute)' }}>{fills.length} fills · {tradingStyle}</div>
        </HeroCard>

        <HeroCard label="Margin Usage" value={`${marginUsedPct.toFixed(1)}%`} valueColor={healthColor}>
          <div style={{ fontSize: 10, color: 'var(--ink-mute)', fontFamily: 'var(--mono)' }}>{fmtUsd(freeMargin)} withdrawable</div>
          <GaugeBar pct={marginUsedPct} color={healthColor} />
        </HeroCard>

        <HeroCard label="Long vs Short PnL" value={<span><span style={{ color: 'var(--green)' }}>{longCount}L</span> <span style={{ color: 'var(--ink-mute)' }}>/</span> <span style={{ color: 'var(--red)' }}>{shortCount}S</span></span>}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontFamily: 'var(--mono)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--ink-soft)' }}>Long · {longCount}</span><span style={{ color: pnlColor(longPnl) }}>{longPnl >= 0 ? '+' : ''}{fmtUsd(longPnl)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--ink-soft)' }}>Short · {shortCount}</span><span style={{ color: pnlColor(shortPnl) }}>{shortPnl >= 0 ? '+' : ''}{fmtUsd(shortPnl)}</span></div>
          </div>
        </HeroCard>

        <HeroCard label="Balances" value={fmtUsd(hyperCoreValue + (showEvmTotal ? hyperEvmValue : 0))}>
          <CompositionBar parts={[
            { label: 'Spot', value: spotValue, color: 'var(--blue)' },
            { label: 'Perps', value: perpEquity, color: '#f0b95c' },
            { label: 'Staked/Lending', value: stakedHypeValue, color: 'var(--green)' },
            { label: 'Vaults', value: vaultEquityUsd, color: '#9b87f5' },
            ...(showEvmTotal && hyperEvmValue > 0 ? [{ label: 'EVM', value: hyperEvmValue, color: '#5fd0c4' }] : []),
          ]} />
        </HeroCard>
      </div>

      {/* ── Margin Health ─────────────────────────────────────────────── */}
      <div style={{ ...panel, gridArea: 'health', padding: '14px 16px', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <div style={ptitle}>Margin Health</div>
        <HealthRing pct={marginUsedPct} label={fmtUsd(perpEquity)} sub={`Free: ${fmtUsd(freeMargin)}`} color={healthColor} />
        <div style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
            <span style={{ color: 'var(--ink-mute)' }}>Long</span>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--green)', fontWeight: 600 }}>{fmtUsd(longNtl)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
            <span style={{ color: 'var(--ink-mute)' }}>Short</span>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--red)', fontWeight: 600 }}>{fmtUsd(Math.abs(shortNtl))}</span>
          </div>
        </div>
      </div>

      {/* ── Portfolio Chart ───────────────────────────────────────────── */}
      <div style={{ gridArea: 'chart', display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <PortfolioChart
            title="Portfolio Value"
            series={data.portfolio[range === '24h' ? 'day' : range === '7d' ? 'week' : range === '30d' ? 'month' : 'allTime']}
            color="var(--blue)"
            range={range}
          />
        </div>
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          {(['24h', '7d', '30d', 'All'] as ChartRange[]).map(r => (
            <button key={r} onClick={() => setRange(r)} style={{
              background: range === r ? 'var(--blue-soft)' : 'transparent',
              border: '1px solid var(--rule)', borderRadius: 4,
              color: range === r ? 'var(--blue)' : 'var(--ink-soft)',
              cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, padding: '3px 10px',
            }}>{r}</button>
          ))}
        </div>
      </div>

      {/* ── Position Concentration ────────────────────────────────────── */}
      <div style={{ ...panel, gridArea: 'conc', padding: '14px 16px', gap: 12 }}>
        <div style={ptitle}>Position Concentration</div>
        <div style={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
          <ConcentrationBars positions={positions} />
        </div>
        {positions.length > 0 && (
          <div style={{ display: 'flex', gap: 10, fontSize: 10, color: 'var(--ink-mute)', flexShrink: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: 1, background: 'var(--green)', display: 'inline-block' }} /> Long
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: 1, background: 'var(--red)', display: 'inline-block' }} /> Short
            </span>
          </div>
        )}
      </div>

      {/* ── Perpetuals ────────────────────────────────────────────────── */}
      <div style={{ ...panel, gridArea: 'pos' }}>
        <div style={phead}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Perpetuals</span>
            <span style={{ background: 'var(--blue-soft)', color: 'var(--blue)', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 7px' }}>{positions.length}</span>
          </div>
          <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, color: pnlColor(totalPnl) }}>{totalPnl >= 0 ? '+' : ''}{fmtUsd(totalPnl)}</span>
        </div>
        <div style={pbody}>
          {positions.length === 0 && <div style={{ padding: '24px 14px', textAlign: 'center', color: 'var(--ink-mute)', fontSize: 12 }}>No open positions</div>}
          {positions.map((p, i) => {
            const isLong = parseFloat(p.szi) >= 0
            const ctx = data.assetCtxMap.get(p.coin)
            const risk = liqRisk(ctx?.markPx, p.liquidationPx ?? undefined, isLong)
            const { dex, sym } = splitCoin(p.coin)
            return (
              <div key={p.coin} style={{ padding: '8px 14px', borderBottom: i < positions.length - 1 ? '1px solid var(--rule-soft)' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <CoinIcon symbol={sym} size={22} />
                  <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, minWidth: 52, fontSize: 12 }}>{sym}</span>
                  <DexTag dex={dex} />
                  <span style={{ fontSize: 10, fontWeight: 700, color: isLong ? 'var(--green)' : 'var(--red)', background: isLong ? 'rgba(34,197,94,0.08)' : 'rgba(244,63,94,0.08)', borderRadius: 4, padding: '1px 6px' }}>
                    {isLong ? 'Long' : 'Short'} {p.leverage.value}×
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-soft)' }}>{fmtUsd(p.positionValue)}</span>
                  {(risk === 'critical' || risk === 'high') && <LiqBadge risk={risk} />}
                  <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 12, color: pnlColor(p.unrealizedPnl), fontWeight: 600 }}>
                    {parseFloat(p.unrealizedPnl) >= 0 ? '+' : ''}{fmtUsd(p.unrealizedPnl)}
                  </span>
                </div>
                {p.liquidationPx && ctx && (
                  <div style={{ marginTop: 4, paddingLeft: 30, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <LiqGaugeMini markPx={ctx.markPx} liqPx={p.liquidationPx} isLong={isLong} />
                    <span style={{ fontSize: 10, color: 'var(--ink-mute)', fontFamily: 'var(--mono)' }}>liq {fmtUsd(p.liquidationPx)}</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {positions.length > 0 && footerLink('View all positions', 'positions')}
      </div>

      {/* ── Recent Activity ───────────────────────────────────────────── */}
      <div style={{ ...panel, gridArea: 'act' }}>
        <div style={phead}>
          <span style={ptitle}>Recent Activity</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)' }}>{fills.length} fills</span>
        </div>
        <div style={{ ...pbody, padding: '0 14px 8px' }}>
          <ActivityFeed fills={fills} spotTokenMap={data.spotTokenMap} />
        </div>
        {footerLink('View all trades', 'trades')}
      </div>

      {/* ── Analysis ──────────────────────────────────────────────────── */}
      <div style={{ ...panel, gridArea: 'anly' }}>
        <div style={phead}><span style={ptitle}>Analysis</span></div>
        <div style={{ ...pbody, padding: '0 14px 10px' }}>
          {[
            { label: 'Trading Style', value: tradingStyle },
            { label: 'PnL Cohort', value: pnlCohort, color: allTimePnl !== null && allTimePnl > 0 ? 'var(--green)' : 'var(--red)' },
            { label: 'Size Cohort', value: sizeCohort },
            { label: 'Win Rate', value: winRate !== null ? `${winRate.toFixed(1)}%` : '—', color: winRate !== null ? (winRate >= 50 ? 'var(--green)' : 'var(--red)') : undefined },
            { label: 'Longest Win Streak', value: maxStreak > 0 ? `${maxStreak} trades` : '—' },
            { label: 'All Time PnL', value: allTimePnl !== null ? (allTimePnl >= 0 ? '+' : '') + fmtUsd(allTimePnl) : '—', color: allTimePnl !== null ? pnlColor(allTimePnl) : undefined },
            { label: 'Volume (fills)', value: fmtUsd(totalVolume) },
            { label: 'Account Leverage', value: `${acctLeverage.toFixed(2)}×` },
            { label: 'Net Funding (90d)', value: netFunding90d >= 0 ? '+' + fmtUsd(netFunding90d) : fmtUsd(netFunding90d), color: pnlColor(netFunding90d) },
            { label: 'Cum. Funding (open)', value: (totalFunding >= 0 ? '+' : '') + fmtUsd(totalFunding), color: pnlColor(totalFunding) },
            ...(orders.length > 0 ? [{ label: 'Open Orders', value: String(orders.length) }] : []),
            ...(parseFloat(data.delegatorSummary?.delegated ?? '0') > 0 ? [{ label: 'Staked HYPE', value: fmtNum(data.delegatorSummary?.delegated, 2) }] : []),
            ...(data.referral && parseFloat(data.referral.unclaimedRewards) > 0 ? [{ label: 'Unclaimed Referral', value: fmtUsd(data.referral.unclaimedRewards), color: 'var(--green)' }] : []),
          ].map(({ label, value, color }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--rule-soft)' }}>
              <span style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{label}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: color ?? 'var(--ink)' }}>{value}</span>
            </div>
          ))}
        </div>
        {footerLink('Funding detail', 'funding')}
      </div>

      {/* ── Spot · HyperCore ──────────────────────────────────────────── */}
      <div style={{ ...panel, gridArea: 'spot' }}>
        <div style={phead}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Spot</span>
            <span style={{ background: 'var(--blue-soft)', color: 'var(--blue)', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 7px' }}>{spotBalances.length}</span>
          </div>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)' }}>HyperCore · L1</span>
        </div>
        <div style={pbody}>
          {spotBalances.length === 0 && <div style={{ padding: '24px 14px', textAlign: 'center', color: 'var(--ink-mute)', fontSize: 12 }}>No spot holdings</div>}
          {spotBalances.map((b, i) => (
            <div key={b.coin} style={{ padding: '8px 14px', borderBottom: i < spotBalances.length - 1 ? '1px solid var(--rule-soft)' : 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
              <CoinIcon symbol={b.coin} size={22} />
              <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, minWidth: 52, fontSize: 12 }}>{b.coin}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-soft)' }}>{fmtNum(b.total, 4)}</span>
              {parseFloat(b.entryNtl) > 0 && (
                <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600 }}>{fmtUsd(b.entryNtl)}</span>
              )}
            </div>
          ))}
        </div>
        {spotBalances.length > 0 && footerLink('View spot holdings', 'spot')}
      </div>

      {/* ── HyperEVM · Chain 999 ──────────────────────────────────────── */}
      <div style={{ ...panel, gridArea: 'evm' }}>
        <div style={phead}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>HyperEVM</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)' }}>
            {evmData && !evmLoading
              ? `${fmtEvmAmount(evmData.nativeFormatted, 2)} HYPE · ${evmData.txCount.toLocaleString()} txns${showEvmTotal && hyperEvmValue > 0 ? ` · ${evmApprox ? '≈' : ''}${fmtUsd(hyperEvmValue)}` : ''}`
              : 'Chain 999'}
          </span>
        </div>
        <div style={pbody}>
          {evmLoading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px' }}>
              {[300, 240, 180].map((w, i) => (
                <div key={i} style={{ height: 16, width: w, maxWidth: '100%', borderRadius: 4, background: 'var(--rule)', animation: 'pulse 1.4s ease-in-out infinite', animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          )}
          {evmError && (
            <div style={{ margin: '10px 14px', background: 'rgba(192,57,43,0.08)', border: '1px solid rgba(192,57,43,0.25)', borderRadius: 8, color: 'var(--red)', fontSize: 12, padding: '10px 14px' }}>
              {evmError}
            </div>
          )}
          {evmData && !evmLoading && (
            <>
              {Array.from(groupByProtocol(evmData.protocolPositions).entries()).map(([protocol, pos]) => (
                <div key={protocol}>
                  <div style={{ padding: '8px 14px 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 12 }}>{protocol}</span>
                    <span style={{ background: 'rgba(147,51,234,0.08)', color: '#9333ea', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 7px' }}>{pos.length}</span>
                  </div>
                  {pos.map((p, i) => (
                    <div key={i} style={{ padding: '6px 14px', borderBottom: '1px solid var(--rule-soft)', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: p.type === 'borrow' ? 'var(--red)' : p.type === 'supply' ? 'var(--blue)' : 'var(--green)', background: p.type === 'borrow' ? 'rgba(244,63,94,0.08)' : p.type === 'supply' ? 'var(--blue-soft)' : 'rgba(34,197,94,0.08)', borderRadius: 4, padding: '1px 6px', textTransform: 'capitalize', minWidth: 48, textAlign: 'center' }}>
                        {p.type}
                      </span>
                      <span style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 12 }}>{p.asset}</span>
                      <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12 }}>
                        {fmtEvmAmount(p.amount, p.decimals > 6 ? 4 : 2)}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
              {evmData.tokens.length > 0 && (
                <>
                  <div style={{ padding: '8px 14px 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 12 }}>Token Holdings</span>
                    <span style={{ background: 'var(--blue-soft)', color: 'var(--blue)', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 7px' }}>{evmData.tokens.length}</span>
                  </div>
                  {evmData.tokens.map((t, i) => (
                    <div key={t.address} style={{ padding: '6px 14px', borderBottom: i < evmData.tokens.length - 1 ? '1px solid var(--rule-soft)' : 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <CoinIcon symbol={t.symbol} size={20} />
                      <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, minWidth: 60, fontSize: 12 }}>{t.symbol}</span>
                      <span style={{ fontSize: 10, color: 'var(--ink-mute)' }}>{t.protocol}</span>
                      <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 12 }}>
                        {fmtEvmAmount(t.formatted, t.decimals > 6 ? 4 : 2)}
                      </span>
                    </div>
                  ))}
                </>
              )}
              {evmData.protocolPositions.length === 0 && evmData.tokens.length === 0 && (
                <div style={{ textAlign: 'center', color: 'var(--ink-mute)', padding: '24px 14px', fontSize: 12 }}>No EVM activity detected</div>
              )}
            </>
          )}
        </div>
        {evmData && !evmLoading && footerLink('View on HyperEVM', 'evm')}
      </div>
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
  const [view, setView] = useState<'trader' | 'market'>('trader')
  const [range, setRange] = useState<ChartRange>('7d')
  const [history, setHistory] = useState<string[]>([])
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [evmData, setEvmData] = useState<EvmWalletData | null>(null)
  const [evmLoading, setEvmLoading] = useState(false)
  const [evmError, setEvmError] = useState<string | null>(null)
  const [tradeFilter, setTradeFilter] = useState<'perps' | 'spot'>('perps')
  const [showAllOrders, setShowAllOrders] = useState(false)
  const [watchlist, setWatchlist]         = useState<WatchEntry[]>([])
  const [entities, setEntities]           = useState<WatchEntity[]>([])
  const [expandedEntities, setExpandedEntities] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState<{ label: string; entityId: string; newEntityName: string } | null>(null)
  const [entityView, setEntityView] = useState<{
    entityId: string
    walletData: Record<string, HLWalletData | null>
    evmData: Record<string, EvmWalletData | null>
    stakingData: Record<string, HLDelegatorSummary | null>
    loading: Set<string>
    errors: Record<string, string>
  } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const currentAddr = useRef<string>('')
  const entityAccum = useRef<Record<string, HLWalletData | null>>({})
  const entityEvmAccum = useRef<Record<string, EvmWalletData | null>>({})
  const entityStakingAccum = useRef<Record<string, HLDelegatorSummary | null>>({})
  const entityErrAccum = useRef<Record<string, string>>({})

  useEffect(() => {
    setHistory(loadHistory())
    setWatchlist(loadWatchlist())
    setEntities(loadEntities())
  }, [])

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
    setAdding(null)
  }

  function addToWatchlist(addr: string, label: string, entityId: string, newEntityName: string) {
    let finalEntityId = entityId
    let finalEntities = entities
    if (entityId === '__new__' && newEntityName.trim()) {
      const newEnt: WatchEntity = { id: crypto.randomUUID(), name: newEntityName.trim() }
      finalEntities = [...entities, newEnt]
      saveEntities(finalEntities)
      setEntities(finalEntities)
      finalEntityId = newEnt.id
      setExpandedEntities(prev => new Set([...prev, newEnt.id]))
    }
    const entry: WatchEntry = {
      addr,
      label: label.trim() || shortAddr(addr),
      ...(finalEntityId && finalEntityId !== '__none__' ? { entityId: finalEntityId } : {}),
    }
    const next = [entry, ...watchlist.filter(e => e.addr !== addr)]
    saveWatchlist(next)
    setWatchlist(next)
    setAdding(null)
  }

  // Turn the snooped wallet's on-chain relationships into a watchlist entity in one click.
  // If the wallet has a master, we fetch the master's full sub-account list so sibling
  // sub-accounts aren't missed when snooping from a sub-account rather than the master.
  async function groupRelatedAsEntity() {
    if (!data) return
    const master = data.role.user
    const name = prompt('Name this entity:', `${shortAddr(master ?? address)} Group`)
    if (!name?.trim()) return

    const members = relatedAccounts(data, address)
    if (master) {
      try {
        const masterSubs = await getSubAccounts(master)
        const seen = new Set(members.map(m => m.addr))
        masterSubs.forEach((s, i) => {
          const a = s.subAccountUser?.toLowerCase()
          if (a && !seen.has(a)) { seen.add(a); members.push({ addr: a, label: s.name || `Sub #${i + 1}`, role: 'subAccount' }) }
        })
      } catch { /* fall back to the relationships already visible */ }
    }

    const newEnt: WatchEntity = { id: crypto.randomUUID(), name: name.trim() }
    const nextEntities = [...entities, newEnt]
    saveEntities(nextEntities)
    setEntities(nextEntities)

    const memberAddrs = new Set(members.map(m => m.addr))
    const have = new Set(watchlist.map(e => e.addr))
    const reassigned = watchlist.map(e => memberAddrs.has(e.addr) ? { ...e, entityId: newEnt.id } : e)
    const added = members.filter(m => !have.has(m.addr)).map(m => ({ addr: m.addr, label: m.label, entityId: newEnt.id }))
    const next = [...added, ...reassigned]
    saveWatchlist(next)
    setWatchlist(next)
    setExpandedEntities(prev => new Set([...prev, newEnt.id]))
  }

  function removeFromWatchlist(addr: string) {
    const next = watchlist.filter(e => e.addr !== addr)
    saveWatchlist(next)
    setWatchlist(next)
  }

  function deleteEntity(id: string) {
    const nextEntities = entities.filter(e => e.id !== id)
    const nextList = watchlist.map(e => e.entityId === id ? { ...e, entityId: undefined } : e)
    saveEntities(nextEntities)
    saveWatchlist(nextList)
    setEntities(nextEntities)
    setWatchlist(nextList)
  }

  function toggleEntity(id: string) {
    setExpandedEntities(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function openEntityView(entityId: string) {
    const members = watchlist.filter(e => e.entityId === entityId)
    if (!members.length) return
    stopSnoop()
    entityAccum.current = {}
    entityEvmAccum.current = {}
    entityStakingAccum.current = {}
    entityErrAccum.current = {}
    setEntityView({ entityId, walletData: {}, evmData: {}, stakingData: {}, loading: new Set(members.map(m => m.addr)), errors: {} })
    await Promise.all(members.map(async ({ addr }) => {
      const [hlResult, evmResult, stakingResult] = await Promise.allSettled([
        fetchWallet(addr),
        fetchEvmWallet(addr),
        getDelegatorSummary(addr),
      ])
      entityAccum.current[addr] = hlResult.status === 'fulfilled' ? hlResult.value : null
      entityEvmAccum.current[addr] = evmResult.status === 'fulfilled' ? evmResult.value : null
      entityStakingAccum.current[addr] = stakingResult.status === 'fulfilled' ? stakingResult.value : null
      if (hlResult.status === 'rejected') entityErrAccum.current[addr] = 'Failed'
      setEntityView(prev => {
        if (!prev || prev.entityId !== entityId) return prev
        return {
          ...prev,
          walletData: { ...entityAccum.current },
          evmData: { ...entityEvmAccum.current },
          stakingData: { ...entityStakingAccum.current },
          loading: new Set([...prev.loading].filter(a => a !== addr)),
          errors: { ...prev.errors, ...entityErrAccum.current },
        }
      })
    }))
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const positions = data ? allPerpPositions(data) : []
  const spotBalances = (data?.spot.balances ?? []).filter(b => parseFloat(b.total) > 0)
  const orders = data?.orders ?? []
  const fills = data?.fills ?? []
  const ledger = data?.ledger ?? []
  const subs = data?.subAccounts ?? []
  const fundingPayments = data?.userFunding ?? []
  const historicalOrders = data?.historicalOrders ?? []
  const twapOrders = data?.twapOrders ?? []
  const twapHistory = data?.twapHistory ?? []
  const frontendOrders = data?.frontendOrders ?? []
  const twapSliceFills = data?.twapSliceFills ?? []
  const delegations = data?.delegations ?? []

  const perpEquity = data ? combinedPerpEquity(data) : 0
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
    { id: 'orders',       label: 'Orders',       count: orders.length + twapOrders.length },
    { id: 'trades',       label: 'Trades',       count: fills.length },
    { id: 'funding',      label: 'Funding',      count: fundingPayments.length },
    { id: 'staking',      label: '◈ Staking',    count: delegations.length },
    { id: 'transactions', label: 'Transactions', count: ledger.length },
    { id: 'subaccounts',  label: 'Sub-Accounts', count: subs.length },
    { id: 'evm',          label: '⬡ HyperEVM' },
    { id: 'hypeflow',    label: '⚡ HYPE Flow' },
  ]

  // ── Normal page (no data loaded) ─────────────────────────────────────────

  return (
    <div className="hlt-wrap">
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

      {/* View toggle */}
      <div style={{ display: 'inline-flex', gap: 2, background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 8, padding: 3, marginBottom: 20 }}>
        {([['trader', '🐳 Trader Explorer'], ['market', '📊 HYPE Market']] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setView(id)}
            style={{
              background: view === id ? 'var(--blue-soft)' : 'transparent',
              border: 'none', borderRadius: 6, cursor: 'pointer',
              color: view === id ? 'var(--blue)' : 'var(--ink-soft)',
              fontFamily: 'var(--sans)', fontSize: 13, fontWeight: view === id ? 600 : 500,
              padding: '7px 16px',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'market' && <HypeMarket />}

      {/* Search */}
      {view === 'trader' && (
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
      )}

      {/* Watchlist */}
      {view === 'trader' && (watchlist.length > 0 || entities.length > 0) && (() => {
        const standalone = watchlist.filter(e => !e.entityId)
        const totalAddrs = watchlist.length
        return (
          <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, marginBottom: 20, overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-soft)' }}>Whale Watchlist</span>
              <span style={{ fontSize: 10, fontWeight: 700, background: 'var(--blue-soft)', color: 'var(--blue)', borderRadius: 10, padding: '1px 6px' }}>{totalAddrs}</span>
              <button
                onClick={() => {
                  const name = prompt('Entity name:')
                  if (!name?.trim()) return
                  const newEnt: WatchEntity = { id: crypto.randomUUID(), name: name.trim() }
                  const next = [...entities, newEnt]
                  saveEntities(next); setEntities(next)
                  setExpandedEntities(prev => new Set([...prev, newEnt.id]))
                }}
                style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--ink-soft)', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '3px 10px' }}
              >
                + Entity
              </button>
            </div>

            {/* Entity groups */}
            {entities.map((ent, ei) => {
              const members = watchlist.filter(e => e.entityId === ent.id)
              const col = entityColor(ei)
              const expanded = expandedEntities.has(ent.id)
              return (
                <div key={ent.id} style={{ borderBottom: '1px solid var(--rule-soft)' }}>
                  {/* Entity row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', background: `${col}08` }}>
                    <button onClick={() => toggleEntity(ent.id)} style={{ background: 'none', border: 'none', padding: '0 4px 0 0', cursor: 'pointer', color: col, fontSize: 10, flexShrink: 0 }}>
                      {expanded ? '▼' : '▶'}
                    </button>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: col, flexShrink: 0 }} />
                    <button onClick={() => openEntityView(ent.id)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, flex: 1, textAlign: 'left' }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)' }}>{ent.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--ink-mute)' }}>{members.length} wallet{members.length !== 1 ? 's' : ''}</span>
                      {members.length > 0 && <span style={{ fontSize: 10, color: col, fontWeight: 600, marginLeft: 2 }}>View all →</span>}
                    </button>
                    <button
                      onClick={() => deleteEntity(ent.id)}
                      title="Delete entity (addresses become standalone)"
                      style={{ background: 'transparent', border: 'none', color: 'var(--ink-mute)', cursor: 'pointer', fontSize: 11, padding: '2px 6px' }}
                    >
                      ✕
                    </button>
                  </div>
                  {/* Entity members */}
                  {expanded && members.map((e, mi) => (
                    <div key={e.addr} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px 8px 40px', borderTop: '1px solid var(--rule-soft)', background: `${col}04` }}>
                      <span style={{ width: 3, height: 3, borderRadius: '50%', background: col, flexShrink: 0 }} />
                      <button onClick={() => lookup(e.addr)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--ink)', minWidth: 100 }}>{e.label}</span>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>{e.addr}</span>
                      </button>
                      <button onClick={() => lookup(e.addr)} style={{ background: 'var(--blue-soft)', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--blue)', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '2px 8px', flexShrink: 0 }}>Load</button>
                      <button onClick={() => removeFromWatchlist(e.addr)} style={{ background: 'transparent', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--ink-mute)', cursor: 'pointer', fontSize: 11, padding: '2px 6px', flexShrink: 0 }}>✕</button>
                    </div>
                  ))}
                  {expanded && members.length === 0 && (
                    <div style={{ padding: '8px 40px', borderTop: '1px solid var(--rule-soft)', fontSize: 12, color: 'var(--ink-mute)', fontStyle: 'italic' }}>No wallets yet — use ☆ Watch on any address and assign to this entity</div>
                  )}
                </div>
              )
            })}

            {/* Standalone entries */}
            {standalone.map((e, i) => (
              <div key={e.addr} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: i < standalone.length - 1 ? '1px solid var(--rule-soft)' : 'none' }}>
                <button onClick={() => lookup(e.addr)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', flex: 1, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--ink)', minWidth: 120 }}>{e.label}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>{e.addr}</span>
                </button>
                <button onClick={() => lookup(e.addr)} style={{ background: 'var(--blue-soft)', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--blue)', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '3px 10px', flexShrink: 0 }}>Load</button>
                <button onClick={() => removeFromWatchlist(e.addr)} style={{ background: 'transparent', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--ink-mute)', cursor: 'pointer', fontSize: 11, padding: '3px 8px', flexShrink: 0 }}>✕</button>
              </div>
            ))}
          </div>
        )
      })()}

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

      {/* Entity overview */}
      {entityView && (() => {
        const ent = entities.find(e => e.id === entityView.entityId)
        if (!ent) return null
        const col = entityColor(entities.indexOf(ent))
        const members = watchlist.filter(e => e.entityId === entityView.entityId)
        const loaded = members.map(m => ({
          entry: m,
          wd: entityView.walletData[m.addr] ?? null,
          evm: entityView.evmData[m.addr] ?? null,
          staking: entityView.stakingData[m.addr] ?? null,
        }))
        const isLoading = entityView.loading.size > 0

        // Use prices from first loaded wallet
        const firstWd = loaded.find(l => l.wd)?.wd ?? null
        const hypePrice   = parseFloat(firstWd?.assetCtxMap.get('HYPE')?.markPx ?? '0')
        const btcPrice    = parseFloat(firstWd?.assetCtxMap.get('BTC')?.markPx  ?? '0')
        const ethPrice    = parseFloat(firstWd?.assetCtxMap.get('ETH')?.markPx  ?? '0')
        const STABLES     = new Set(['USDC','USDT0','USDT','FEUSD','USH','USDHL','USDE','SUSDE','USR','USDH'])
        const HYPE_LIKE   = new Set(['WHYPE','KHYPE','STHYPE','WSTHYPE','LSTHYPE','BEHYPE','HBHYPE','FLOWHYPE','HIHYPE','KMHYPE'])
        function tokenUsd(symbol: string, amount: number): number | null {
          const s = symbol.split(/[\s→]/)[0].toUpperCase()
          if (STABLES.has(s))   return amount
          if (s === 'HYPE' || HYPE_LIKE.has(s)) return amount * hypePrice
          if (s === 'UBTC')     return amount * btcPrice
          if (s === 'UETH' || s === 'CMETH') return amount * ethPrice
          const ctx = firstWd?.assetCtxMap.get(s) ?? firstWd?.spotAssetCtxMap.get(s)
          if (ctx) return amount * parseFloat(ctx.markPx)
          return null
        }

        // Per-wallet value breakdown
        const walletValues = loaded.map(({ entry, wd, evm, staking }) => {
          const perpEquity = wd ? combinedPerpEquity(wd) : 0
          const spotVal = (wd?.spot.balances ?? []).filter(b => parseFloat(b.total) > 0).reduce((s, b) => {
            const v = tokenUsd(b.coin, parseFloat(b.total))
            if (v !== null) return s + v
            const ctx = wd?.spotAssetCtxMap.get(b.coin)
            return s + (ctx ? parseFloat(b.total) * parseFloat(ctx.markPx) : 0)
          }, 0)
          let evmVal = 0
          if (evm) {
            evmVal += evm.nativeFormatted * hypePrice
            for (const t of evm.tokens) { const v = tokenUsd(t.symbol, t.formatted); if (v !== null) evmVal += v }
            for (const p of evm.protocolPositions) {
              const sign = p.type === 'borrow' ? -1 : 1
              const v = tokenUsd(p.asset, p.amount)
              if (v !== null) evmVal += sign * v
            }
          }
          const stakedHype = parseFloat(staking?.delegated ?? '0')
          const stakedVal = stakedHype * hypePrice
          return { entry, wd, evm, staking, perpEquity, spotVal, evmVal, stakedVal, total: perpEquity + spotVal + evmVal + stakedVal }
        })

        // Aggregates
        const totalNetWorth = walletValues.reduce((s, w) => s + w.total, 0)
        const totalEquity   = walletValues.reduce((s, w) => s + w.perpEquity, 0)
        const totalSpotVal  = walletValues.reduce((s, w) => s + w.spotVal, 0)
        const totalEvmVal   = walletValues.reduce((s, w) => s + w.evmVal, 0)
        const totalStakedVal = walletValues.reduce((s, w) => s + w.stakedVal, 0)
        const totalPnl      = loaded.reduce((s, { wd }) => s + (wd ? allPerpPositions(wd) : []).reduce((ss, p) => ss + parseFloat(p.unrealizedPnl || '0'), 0), 0)
        const allPositions  = loaded.flatMap(({ entry, wd }) =>
          (wd ? allPerpPositions(wd) : []).map(p => ({ ...p, _wallet: entry.label, _addr: entry.addr, _ctx: wd?.assetCtxMap.get(p.coin) }))
        ).filter(p => parseFloat(p.szi) !== 0)
        const allSpot = loaded.flatMap(({ entry, wd }) =>
          (wd?.spot.balances ?? []).filter(b => parseFloat(b.total) > 0).map(b => {
            const amount = parseFloat(b.total)
            const v = tokenUsd(b.coin, amount) ?? (wd?.spotAssetCtxMap.get(b.coin) ? amount * parseFloat(wd!.spotAssetCtxMap.get(b.coin)!.markPx) : null)
            return { ...b, _wallet: entry.label, _addr: entry.addr, _usdVal: v }
          })
        )
        const allEvmTokens = loaded.flatMap(({ entry, evm }) =>
          (evm?.tokens ?? []).map(t => ({ ...t, _wallet: entry.label }))
        )
        const allEvmPositions = loaded.flatMap(({ entry, evm }) =>
          (evm?.protocolPositions ?? []).map(p => ({ ...p, _wallet: entry.label }))
        )

        return (
          <div style={{ marginBottom: 32 }}>
            {/* Entity banner */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: `${col}10`, border: `1px solid ${col}40`, borderRadius: 8, padding: '10px 16px', marginBottom: 16, flexWrap: 'wrap' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: col, flexShrink: 0 }} />
              <span style={{ fontWeight: 700, fontSize: 14, color: col }}>{ent.name}</span>
              <span style={{ fontSize: 12, color: 'var(--ink-mute)' }}>{members.length} wallets</span>
              {isLoading
                ? <span style={{ fontSize: 11, color: 'var(--ink-mute)', fontStyle: 'italic' }}>Loading {entityView.loading.size} of {members.length}…</span>
                : <span style={{ fontSize: 11, color: 'var(--ink-mute)' }}>{Object.keys(entityView.walletData).filter(k => entityView.walletData[k]).length} loaded</span>
              }
              <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                <button
                  onClick={() => openEntityView(entityView.entityId)}
                  disabled={isLoading}
                  style={{ background: `${col}15`, border: `1px solid ${col}40`, borderRadius: 4, color: col, cursor: isLoading ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 600, padding: '4px 10px', opacity: isLoading ? 0.5 : 1 }}
                >
                  ↻ Refresh
                </button>
                <button
                  onClick={() => setEntityView(null)}
                  style={{ background: 'transparent', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--ink-soft)', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '4px 10px' }}
                >
                  ← Back
                </button>
              </div>
            </div>

            {/* Net worth banner */}
            <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 12, padding: '20px 24px', marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700, marginBottom: 6 }}>Entity Total Net Worth</div>
              <div style={{ fontFamily: 'var(--mono)', fontWeight: 800, fontSize: 32, color: 'var(--ink)', lineHeight: 1, marginBottom: 14 }}>
                {fmtUsd(totalNetWorth)}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--blue)', display: 'inline-block' }} /> Perp Equity
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 16 }}>{fmtUsd(totalEquity)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981', display: 'inline-block' }} /> Spot Holdings
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 16 }}>{fmtUsd(totalSpotVal)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#9333ea', display: 'inline-block' }} /> HyperEVM
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 16 }}>{fmtUsd(totalEvmVal)}</div>
                </div>
                {totalStakedVal > 0 && (
                  <div>
                    <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginBottom: 2, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} /> Staked HYPE
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 16 }}>{fmtUsd(totalStakedVal)}</div>
                  </div>
                )}
              </div>
            </div>

            {/* Aggregate metric cards */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
              <MetricCard label="Open Positions" value={String(allPositions.length)} sub="Across all wallets" />
              <MetricCard label="Unrealized PnL" value={fmtUsd(totalPnl)} valueColor={pnlColor(totalPnl)} sub="All wallets combined" />
              <MetricCard label="Spot Tokens" value={String(new Set(allSpot.map(b => b.coin)).size)} sub={`${allSpot.length} holdings`} />
              {allEvmTokens.length > 0 && <MetricCard label="EVM Tokens" value={String(allEvmTokens.length)} sub="HyperEVM chain" />}
              {allEvmPositions.length > 0 && <MetricCard label="DeFi Positions" value={String(allEvmPositions.length)} sub="HyperEVM protocols" />}
            </div>

            {/* Per-wallet breakdown table */}
            <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>Wallet Breakdown</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      {['Wallet', 'Address', 'Total', 'Perp Equity', 'Spot', 'EVM', 'Staked HYPE', 'Positions', 'Unr. PnL', ''].map((h, i) => (
                        <th key={i} style={{ textAlign: i >= 2 ? 'right' : 'left', padding: '8px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-soft)', borderBottom: '1px solid var(--rule)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {walletValues.map(({ entry, wd, perpEquity, spotVal, evmVal, stakedVal, staking, total }) => {
                      const isW    = entityView.loading.has(entry.addr)
                      const hasErr = entityView.errors[entry.addr]
                      const posCount = (wd ? allPerpPositions(wd) : []).filter(p => parseFloat(p.szi) !== 0).length
                      const upnl     = (wd ? allPerpPositions(wd) : []).reduce((s, p) => s + parseFloat(p.unrealizedPnl || '0'), 0)
                      const stakedHype = parseFloat(staking?.delegated ?? '0')
                      return (
                        <tr key={entry.addr} style={{ borderBottom: '1px solid var(--rule-soft)' }}>
                          <td style={{ padding: '10px 12px', fontWeight: 700, whiteSpace: 'nowrap' }}>{entry.label}</td>
                          <td style={{ padding: '10px 12px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>{shortAddr(entry.addr)}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 700 }}>
                            {isW ? <span style={{ color: 'var(--ink-mute)' }}>…</span> : hasErr ? <span style={{ color: 'var(--red)', fontSize: 11 }}>Error</span> : fmtUsd(total)}
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--ink-soft)' }}>
                            {isW ? '…' : fmtUsd(perpEquity)}
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--ink-soft)' }}>
                            {isW ? '…' : fmtUsd(spotVal)}
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--ink-soft)' }}>
                            {isW ? '…' : entityView.evmData[entry.addr] === undefined ? <span style={{ color: 'var(--ink-mute)' }}>…</span> : fmtUsd(evmVal)}
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--ink-soft)' }}>
                            {isW ? '…' : stakedHype > 0 ? `${fmtNum(stakedHype, 2)} HYPE` : '—'}
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)' }}>
                            {isW ? '…' : posCount}
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: pnlColor(upnl) }}>
                            {isW ? '…' : fmtUsd(upnl)}
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                            <button
                              onClick={() => { setEntityView(null); lookup(entry.addr) }}
                              style={{ background: 'var(--blue-soft)', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--blue)', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '3px 10px', whiteSpace: 'nowrap' }}
                            >
                              Deep dive →
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* All open positions */}
            {allPositions.length > 0 && (
              <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>All Open Positions ({allPositions.length})</div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr>
                        {['Wallet', 'Symbol', 'Side', 'Size', 'Entry', 'Unr. PnL', 'Liq. Price'].map((h, i) => (
                          <th key={i} style={{ textAlign: i >= 3 ? 'right' : 'left', padding: '8px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-soft)', borderBottom: '1px solid var(--rule)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...allPositions].sort((a, b) => Math.abs(parseFloat(b.positionValue)) - Math.abs(parseFloat(a.positionValue))).map((p, i) => {
                        const size = parseFloat(p.szi)
                        const isLong = size >= 0
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid var(--rule-soft)' }}>
                            <td style={{ padding: '9px 12px', fontSize: 11, color: 'var(--ink-mute)' }}>{p._wallet}</td>
                            <td style={{ padding: '9px 12px', fontWeight: 700, fontFamily: 'var(--mono)' }}>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <CoinIcon symbol={splitCoin(p.coin).sym} size={18} />{splitCoin(p.coin).sym}<DexTag dex={splitCoin(p.coin).dex} />
                              </span>
                            </td>
                            <td style={{ padding: '9px 12px' }}>
                              <span style={{ fontSize: 11, fontWeight: 700, color: isLong ? 'var(--green)' : 'var(--red)' }}>{isLong ? 'Long' : 'Short'}</span>
                            </td>
                            <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtNum(Math.abs(size))}</td>
                            <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtUsd(p.entryPx)}</td>
                            <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: pnlColor(p.unrealizedPnl) }}>{fmtUsd(p.unrealizedPnl)}</td>
                            <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--ink-mute)' }}>{p.liquidationPx ? fmtUsd(p.liquidationPx) : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* All spot holdings */}
            {allSpot.length > 0 && (
              <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>All Spot Holdings ({allSpot.length})</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      {['Wallet', 'Token', 'Balance', 'USD Value'].map((h, i) => (
                        <th key={i} style={{ textAlign: i >= 2 ? 'right' : 'left', padding: '8px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-soft)', borderBottom: '1px solid var(--rule)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {allSpot.map((b, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--rule-soft)' }}>
                        <td style={{ padding: '9px 12px', fontSize: 11, color: 'var(--ink-mute)' }}>{b._wallet}</td>
                        <td style={{ padding: '9px 12px', fontWeight: 700, fontFamily: 'var(--mono)', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <CoinIcon symbol={b.coin} size={18} />{b.coin}
                        </td>
                        <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtNum(b.total, 4)}</td>
                        <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{b._usdVal !== null ? fmtUsd(b._usdVal) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* HyperEVM tokens */}
            {allEvmTokens.length > 0 && (
              <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                  HyperEVM Tokens ({allEvmTokens.length})
                  <span style={{ fontSize: 10, fontWeight: 600, color: '#9333ea', background: 'rgba(147,51,234,0.10)', borderRadius: 4, padding: '1px 6px' }}>Chain 999</span>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      {['Wallet', 'Token', 'Protocol', 'Balance', 'USD Value'].map((h, i) => (
                        <th key={i} style={{ textAlign: i >= 3 ? 'right' : 'left', padding: '8px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-soft)', borderBottom: '1px solid var(--rule)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {allEvmTokens.map((t, i) => {
                      const usdVal = tokenUsd(t.symbol, t.formatted)
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid var(--rule-soft)' }}>
                          <td style={{ padding: '9px 12px', fontSize: 11, color: 'var(--ink-mute)' }}>{t._wallet}</td>
                          <td style={{ padding: '9px 12px', fontWeight: 700, fontFamily: 'var(--mono)' }}>{t.symbol}</td>
                          <td style={{ padding: '9px 12px', fontSize: 11, color: 'var(--ink-mute)' }}>{t.protocol || '—'}</td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtNum(t.formatted, 4)}</td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{usdVal !== null ? fmtUsd(usdVal) : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* HyperEVM DeFi positions */}
            {allEvmPositions.length > 0 && (
              <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                  HyperEVM DeFi Positions ({allEvmPositions.length})
                  <span style={{ fontSize: 10, fontWeight: 600, color: '#9333ea', background: 'rgba(147,51,234,0.10)', borderRadius: 4, padding: '1px 6px' }}>Chain 999</span>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      {['Wallet', 'Protocol', 'Asset', 'Type', 'Amount', 'USD Value'].map((h, i) => (
                        <th key={i} style={{ textAlign: i >= 4 ? 'right' : 'left', padding: '8px 12px', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-soft)', borderBottom: '1px solid var(--rule)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {allEvmPositions.map((p, i) => {
                      const usdVal = tokenUsd(p.asset, p.amount)
                      const isBorrow = p.type === 'borrow'
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid var(--rule-soft)' }}>
                          <td style={{ padding: '9px 12px', fontSize: 11, color: 'var(--ink-mute)' }}>{p._wallet}</td>
                          <td style={{ padding: '9px 12px', fontWeight: 700 }}>{p.protocol}</td>
                          <td style={{ padding: '9px 12px', fontFamily: 'var(--mono)', fontWeight: 700 }}>{p.asset}</td>
                          <td style={{ padding: '9px 12px' }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: isBorrow ? 'var(--red)' : 'var(--green)', background: isBorrow ? 'rgba(244,63,94,0.08)' : 'rgba(34,197,94,0.08)', borderRadius: 4, padding: '1px 7px' }}>
                              {isBorrow ? 'Borrow' : 'Supply'}
                            </span>
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtNum(p.amount, 4)}</td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'var(--mono)', color: isBorrow ? 'var(--red)' : 'var(--ink)' }}>
                            {usdVal !== null ? (isBorrow ? '-' : '') + fmtUsd(usdVal) : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {!isLoading && allPositions.length === 0 && allSpot.length === 0 && allEvmTokens.length === 0 && (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--ink-mute)', fontSize: 14 }}>No open positions or holdings across this entity</div>
            )}
          </div>
        )
      })()}

      {/* Results */}
      {view === 'trader' && data && !loading && (
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
              <button onClick={() => { lookup(address, true); setEvmData(null); setEvmError(null) }} disabled={refreshing} style={{ background: 'transparent', border: '1px solid rgba(147,51,234,0.3)', borderRadius: 4, color: '#9333ea', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '4px 10px' }}>
                ↻ Refresh
              </button>
              {watchlist.some(e => e.addr === address) ? (
                <button onClick={() => removeFromWatchlist(address)} style={{ background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.4)', borderRadius: 4, color: '#b2740d', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '4px 10px' }}>
                  ★ Watching
                </button>
              ) : adding !== null ? (
                <form onSubmit={ev => { ev.preventDefault(); addToWatchlist(address, adding.label, adding.entityId, adding.newEntityName) }} style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    autoFocus
                    value={adding.label}
                    onChange={ev => setAdding(a => a && ({ ...a, label: ev.target.value }))}
                    placeholder="Label (e.g. Whale #1)"
                    style={{ background: 'var(--card)', border: '1px solid var(--blue)', borderRadius: 4, color: 'var(--ink)', fontFamily: 'var(--sans)', fontSize: 11, padding: '4px 8px', width: 150, outline: 'none' }}
                  />
                  <select
                    value={adding.entityId}
                    onChange={ev => setAdding(a => a && ({ ...a, entityId: ev.target.value, newEntityName: '' }))}
                    style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--ink)', fontFamily: 'var(--sans)', fontSize: 11, padding: '4px 6px', outline: 'none', cursor: 'pointer' }}
                  >
                    <option value="__none__">No entity</option>
                    {entities.map(ent => (
                      <option key={ent.id} value={ent.id}>{ent.name}</option>
                    ))}
                    <option value="__new__">+ New entity…</option>
                  </select>
                  {adding.entityId === '__new__' && (
                    <input
                      autoFocus
                      value={adding.newEntityName}
                      onChange={ev => setAdding(a => a && ({ ...a, newEntityName: ev.target.value }))}
                      placeholder="Entity name"
                      style={{ background: 'var(--card)', border: '1px solid var(--blue)', borderRadius: 4, color: 'var(--ink)', fontFamily: 'var(--sans)', fontSize: 11, padding: '4px 8px', width: 130, outline: 'none' }}
                    />
                  )}
                  <button type="submit" style={{ background: 'var(--blue-soft)', border: '1px solid var(--blue)', borderRadius: 4, color: 'var(--blue)', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '4px 10px' }}>
                    Save
                  </button>
                  <button type="button" onClick={() => setAdding(null)} style={{ background: 'transparent', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--ink-mute)', cursor: 'pointer', fontSize: 11, padding: '4px 8px' }}>
                    ✕
                  </button>
                </form>
              ) : (
                <button onClick={() => setAdding({ label: shortAddr(address), entityId: '__none__', newEntityName: '' })} style={{ background: 'transparent', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--ink-soft)', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '4px 10px' }}>
                  ☆ Watch
                </button>
              )}
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

          {/* Related accounts → entity */}
          {(() => {
            const related = relatedAccounts(data, address)
            const agents = data.extraAgents ?? []
            if (related.length < 2 && agents.length === 0) return null
            const lower = address.toLowerCase()
            const equityOf = (addr: string): string | null => {
              if (addr === lower) return data.perps.marginSummary.accountValue ?? null
              const sub = data.subAccounts.find(s => s.subAccountUser?.toLowerCase() === addr)
              return sub?.clearinghouseState?.marginSummary?.accountValue ?? null
            }
            // If every related wallet already shares one entity, surface it instead of re-grouping.
            const entityIds = related.map(r => watchlist.find(e => e.addr === r.addr)?.entityId)
            const grouped = entityIds[0] && entityIds.every(id => id === entityIds[0])
            const existingEntity = grouped ? entities.find(e => e.id === entityIds[0]) : null
            return (
              <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>⬡ Related Accounts Detected</span>
                  <span style={{ background: 'var(--blue-soft)', color: 'var(--blue)', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 7px' }}>{related.length}</span>
                  <span style={{ fontSize: 11, color: 'var(--ink-mute)' }}>on-chain links · master &amp; sub-accounts</span>
                </div>
                {related.map(r => {
                  const eq = equityOf(r.addr)
                  const isSelf = r.addr === lower
                  return (
                    <div key={r.addr} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--rule-soft)', flexWrap: 'wrap' }}>
                      <RoleBadge role={r.role} />
                      <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--ink)', minWidth: 110 }}>{r.label}</span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>{shortAddr(r.addr)}</span>
                      {eq != null && <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-soft)' }}>{fmtUsd(eq)}</span>}
                      {isSelf
                        ? <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--ink-mute)', fontStyle: 'italic' }}>viewing</span>
                        : <button onClick={() => lookup(r.addr)} style={{ marginLeft: 'auto', background: 'var(--blue-soft)', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--blue)', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '2px 10px' }}>Snoop →</button>}
                    </div>
                  )
                })}
                {agents.length > 0 && (
                  <>
                    <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--rule-soft)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)', background: 'var(--rule-soft)' }}>API / Agent Wallets ({agents.length})</div>
                    {agents.map(a => {
                      const expired = a.validUntil < Date.now()
                      return (
                        <div key={a.address} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--rule-soft)', flexWrap: 'wrap' }}>
                          <RoleBadge role="agent" />
                          <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--ink)', minWidth: 110 }}>{a.name || 'Agent'}</span>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>{shortAddr(a.address)}</span>
                          <span style={{ marginLeft: 'auto', fontSize: 10, color: expired ? 'var(--red)' : 'var(--ink-mute)' }}>{expired ? 'expired' : `valid → ${fmtTime(a.validUntil)}`}</span>
                        </div>
                      )
                    })}
                  </>
                )}
                {related.length >= 2 && (
                  <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
                    {existingEntity ? (
                      <>
                        <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>✓ Grouped as <b style={{ color: 'var(--ink)' }}>{existingEntity.name}</b></span>
                        <button onClick={() => openEntityView(existingEntity.id)} style={{ background: 'var(--blue-soft)', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--blue)', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '4px 12px' }}>View entity →</button>
                      </>
                    ) : (
                      <button onClick={groupRelatedAsEntity} className="hlt-accent-btn" style={{ background: 'var(--blue)', border: 'none', borderRadius: 4, color: '#04211c', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '5px 14px' }}>+ Group as entity</button>
                    )}
                  </div>
                )}
              </div>
            )
          })()}

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
              range={range}
              setRange={setRange}
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
                      const { dex, sym } = splitCoin(p.coin)
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
                          <CoinIcon symbol={sym} />
                          <div>
                            <div style={{ fontWeight: 700, fontFamily: 'var(--mono)', display: 'flex', alignItems: 'center', gap: 6 }}>{sym}<DexTag dex={dex} /></div>
                            <div style={{ fontSize: 11, color: pxChgNum >= 0 ? 'var(--green)' : 'var(--red)', marginTop: 2 }}>{pxChange}</div>
                          </div>
                        </div>,
                        <span key="side" style={{ color: isLong ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{isLong ? 'Long' : 'Short'}</span>,
                        fmtNum(Math.abs(size)),
                        fmtUsd(p.entryPx),
                        fmtUsd(Math.abs(parseFloat(p.positionValue))),
                        <div key="pnl" style={{ textAlign: 'right' }}>
                          <div style={{ color: pnlColor(p.unrealizedPnl) }}>{fmtUsd(p.unrealizedPnl)}</div>
                          <div style={{ fontSize: 11, color: pnlColor(p.returnOnEquity), marginTop: 2 }}>{fmtPct(p.returnOnEquity)}</div>
                        </div>,
                        `${p.leverage.value}× ${p.leverage.type}`,
                        <div key="liq" style={{ textAlign: 'right' }}>
                          <div>{p.liquidationPx ? fmtUsd(p.liquidationPx) : '—'}</div>
                          {p.liquidationPx && ctx && (
                            <div style={{ marginTop: 4, display: 'flex', justifyContent: 'flex-end' }}>
                              <LiqGaugeMini markPx={ctx.markPx} liqPx={p.liquidationPx} isLong={isLong} />
                            </div>
                          )}
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

              {/* Active TWAP orders */}
              {twapOrders.length > 0 && (
                <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>Active TWAP Orders</span>
                    <span style={{ fontSize: 11, fontWeight: 700, background: 'rgba(59,130,246,0.1)', color: 'var(--blue)', borderRadius: 4, padding: '2px 7px' }}>{twapOrders.length}</span>
                  </div>
                  <Table
                    headers={['Symbol', 'Side', 'Total Size', 'Executed', 'Exec. Notional', 'Duration', 'Randomize', 'Time']}
                    alignRight={[2, 3, 4]}
                    empty="No active TWAP orders"
                    rows={[...twapOrders].sort((a, b) => b.timestamp - a.timestamp).map(o => {
                      const pct = parseFloat(o.sz) > 0 ? (parseFloat(o.executedSz) / parseFloat(o.sz) * 100) : 0
                      return [
                        <span key="coin" style={{ fontWeight: 600 }}>{resolveCoins(o.coin, data.spotTokenMap)}</span>,
                        <span key="side" style={{ color: o.side === 'B' ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{o.side === 'B' ? 'Buy' : 'Sell'}</span>,
                        fmtNum(o.sz),
                        <span key="exec" style={{ color: 'var(--ink-soft)' }}>{fmtNum(o.executedSz)} <span style={{ fontSize: 11, opacity: 0.6 }}>({pct.toFixed(1)}%)</span></span>,
                        fmtUsd(o.executedNtl),
                        `${o.minutes}m`,
                        o.randomize ? <span key="rand" style={{ color: 'var(--amber)', fontSize: 11 }}>Yes</span> : '—',
                        fmtTime(o.timestamp),
                      ]
                    })}
                  />
                </div>
              )}

              {/* Open limit/stop orders — uses frontendOpenOrders for TP/SL + trigger detail */}
              <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>Open Orders ({frontendOrders.length || orders.length})</div>
                <Table
                  headers={['Symbol', 'Side', 'Type', 'Size', 'Filled', 'Limit / Trigger', 'Flags', 'Time']}
                  alignRight={[3, 4, 5]}
                  empty="No open orders"
                  rows={[...frontendOrders].sort((a, b) => b.timestamp - a.timestamp).map(o => {
                    const { dex, sym } = splitCoin(resolveCoins(o.coin, data.spotTokenMap))
                    const filled = parseFloat(o.origSz) - parseFloat(o.sz)
                    const flags = [
                      o.reduceOnly ? 'Reduce' : null,
                      o.isPositionTpsl ? 'Pos TP/SL' : null,
                      o.tif && o.tif !== 'Gtc' ? o.tif : null,
                    ].filter(Boolean) as string[]
                    return [
                      <span key="coin" style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>{sym}<DexTag dex={dex} /></span>,
                      <span key="side" style={{ color: o.side === 'B' ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{o.side === 'B' ? 'Buy' : 'Sell'}</span>,
                      <span key="type" style={{ fontSize: 11, color: o.isTrigger ? 'var(--amber)' : 'var(--ink-soft)' }}>{o.orderType}</span>,
                      fmtNum(o.sz),
                      filled > 0 ? fmtNum(filled) : '—',
                      o.isTrigger && parseFloat(o.triggerPx) > 0
                        ? <span key="px" style={{ color: 'var(--amber)' }}>{o.triggerCondition !== 'N/A' ? `${o.triggerCondition} ` : ''}{fmtUsd(o.triggerPx)}</span>
                        : fmtUsd(o.limitPx),
                      flags.length > 0
                        ? <span key="fl" style={{ display: 'flex', gap: 4, justifyContent: 'flex-start', flexWrap: 'wrap' }}>{flags.map(f => <span key={f} style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink-soft)', background: 'var(--rule-soft)', border: '1px solid var(--rule)', borderRadius: 3, padding: '1px 5px' }}>{f}</span>)}</span>
                        : '—',
                      fmtTime(o.timestamp),
                    ]
                  })}
                />
              </div>

              {/* TWAP slice executions */}
              {twapSliceFills.length > 0 && (
                <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>TWAP Slice Fills ({twapSliceFills.length})</div>
                  <Table
                    headers={['Symbol', 'Side', 'Size', 'Price', 'Direction', 'Closed PnL', 'TWAP ID', 'Time']}
                    alignRight={[2, 3, 5]}
                    empty="No TWAP slice fills"
                    rows={[...twapSliceFills].sort((a, b) => b.fill.time - a.fill.time).slice(0, showAllOrders ? undefined : 100).map(({ fill: f, twapId }) => {
                      const { dex, sym } = splitCoin(resolveCoins(f.coin, data.spotTokenMap))
                      const cpnl = parseFloat(f.closedPnl || '0')
                      return [
                        <span key="coin" style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>{sym}<DexTag dex={dex} /></span>,
                        <span key="side" style={{ color: f.side === 'B' ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{f.side === 'B' ? 'Buy' : 'Sell'}</span>,
                        fmtNum(f.sz),
                        fmtUsd(f.px),
                        <span key="dir" style={{ color: 'var(--ink-soft)', fontSize: 12 }}>{f.dir}</span>,
                        <span key="pnl" style={{ color: cpnl !== 0 ? pnlColor(cpnl) : 'var(--ink-mute)', fontWeight: cpnl !== 0 ? 600 : 400 }}>{cpnl !== 0 ? (cpnl >= 0 ? '+' : '') + fmtUsd(cpnl) : '—'}</span>,
                        <span key="tid" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>{twapId ?? '—'}</span>,
                        fmtTime(f.time),
                      ]
                    })}
                  />
                  {twapSliceFills.length > 100 && (
                    <div style={{ padding: '10px 16px', borderTop: '1px solid var(--rule-soft)', display: 'flex', justifyContent: 'flex-end' }}>
                      <button onClick={() => setShowAllOrders(v => !v)} style={{ background: 'var(--blue-soft)', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--blue)', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '4px 12px' }}>
                        {showAllOrders ? 'Show less' : `Show all ${twapSliceFills.length}`}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Historical TWAP orders */}
              {twapHistory.length > 0 && (
                <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>TWAP History ({twapHistory.length})</div>
                  <Table
                    headers={['Symbol', 'Side', 'Total Size', 'Executed', 'Exec. Notional', 'Duration', 'Status', 'Time']}
                    alignRight={[2, 3, 4]}
                    empty="No TWAP history"
                    rows={[...twapHistory].sort((a, b) => b.time - a.time).slice(0, showAllOrders ? undefined : 100).map(entry => {
                      const o = entry.state
                      const pct = parseFloat(o.sz) > 0 ? (parseFloat(o.executedSz) / parseFloat(o.sz) * 100) : 0
                      const st = entry.status.status
                      return [
                        <span key="coin" style={{ fontWeight: 600 }}>{resolveCoins(o.coin, data.spotTokenMap)}</span>,
                        <span key="side" style={{ color: o.side === 'B' ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>{o.side === 'B' ? 'Buy' : 'Sell'}</span>,
                        fmtNum(o.sz),
                        <span key="exec">{fmtNum(o.executedSz)} <span style={{ fontSize: 11, opacity: 0.6 }}>({pct.toFixed(1)}%)</span></span>,
                        fmtUsd(o.executedNtl),
                        `${o.minutes}m`,
                        <span key="st" style={{ fontSize: 11, fontWeight: 600, textTransform: 'capitalize', color: st === 'finished' ? 'var(--green)' : st === 'terminated' ? 'var(--red)' : 'var(--ink-soft)', background: st === 'finished' ? 'rgba(34,197,94,0.08)' : st === 'terminated' ? 'rgba(244,63,94,0.08)' : 'var(--rule-soft)', borderRadius: 4, padding: '2px 7px' }}>{st}</span>,
                        fmtTime(entry.time),
                      ]
                    })}
                  />
                  {twapHistory.length > 100 && (
                    <div style={{ padding: '10px 16px', borderTop: '1px solid var(--rule-soft)', display: 'flex', justifyContent: 'flex-end' }}>
                      <button onClick={() => setShowAllOrders(v => !v)} style={{ background: 'var(--blue-soft)', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--blue)', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '4px 12px' }}>
                        {showAllOrders ? 'Show less' : `Show all ${twapHistory.length}`}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Order history */}
              {historicalOrders.length > 0 && (
                <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', fontWeight: 700, fontSize: 13 }}>Order History ({historicalOrders.length})</div>
                  <Table
                    headers={['Symbol', 'Side', 'Size', 'Limit Price', 'Status', 'Time']}
                    alignRight={[2, 3]}
                    empty="No historical orders"
                    rows={[...historicalOrders].sort((a, b) => b.timestamp - a.timestamp).slice(0, showAllOrders ? undefined : 200).map(o => [
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
                  {historicalOrders.length > 200 && (
                    <div style={{ padding: '10px 16px', borderTop: '1px solid var(--rule-soft)', display: 'flex', justifyContent: 'flex-end' }}>
                      <button onClick={() => setShowAllOrders(v => !v)} style={{ background: 'var(--blue-soft)', border: '1px solid var(--rule)', borderRadius: 4, color: 'var(--blue)', cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '4px 12px' }}>
                        {showAllOrders ? 'Show less' : `Show all ${historicalOrders.length}`}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Trades */}
          {tab === 'trades' && (() => {
            const perpFills = [...fills.filter(f => !f.coin.startsWith('@'))].sort((a, b) => b.time - a.time)
            const spotFills = [...fills.filter(f => f.coin.startsWith('@'))].sort((a, b) => b.time - a.time)
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

          {/* Staking */}
          {tab === 'staking' && <StakingTab data={data} />}

          {/* Transactions */}
          {tab === 'transactions' && (
            <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, overflow: 'hidden' }}>
              <Table
                headers={['Type', 'Amount', 'Time', 'Hash']}
                alignRight={[1]}
                empty="No transactions in last 90 days"
                rows={[...ledger].sort((a, b) => b.time - a.time).map(l => [
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
                      rows={[...evmData.transfers].sort((a, b) => b.blockNumber - a.blockNumber).map(t => [
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
      {view === 'trader' && !data && !loading && !error && (
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
        html[data-theme="dark"] .hlt-wrap { --blue: #5b8def; --blue-soft: rgba(91,141,239,0.12); --green: #4ed398; --red: #ff6b6b; }
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
