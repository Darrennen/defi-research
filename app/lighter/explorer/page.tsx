'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'

// ── types ──────────────────────────────────────────────────────

type AccountData = {
  account_index: number
  l1_address: string
  collateral: string
  available_balance: string
  total_asset_value: string
  cross_asset_value: string
  cross_initial_margin_requirement: string
  cross_maintenance_margin_requirement: string
  status: number
  pending_order_count: number
  total_order_count: number
  name: string
  positions: Position[]
  assets: Asset[]
  lit_staking: LitStaking
}

type Position = {
  symbol: string; market_id: number
  position: string; position_value: string
  avg_entry_price: string; liquidation_price: string
  unrealized_pnl: string; realized_pnl: string; total_funding_paid_out: string
  sign: string
}

type Asset = {
  symbol: string; balance: string; locked_balance: string
}

type LitStaking = {
  is_staking: boolean
  staked_usdc_value: number
  shares_amount: number
  entry_usdc: number
  pending_unlocks: { usdc_amount?: string; amount?: string; unlock_time?: string }[]
  lit_free_balance: number
}

type HistTrade = {
  hash: string; time: string
  market_id: number; price: string; size: string
  taker_is_buyer: number; taker_account_index: number; maker_account_index: number
  role: string
}

type FlowWindow = {
  buy_usd: number; sell_usd: number; net_usd: number
  buy_trades: number; sell_trades: number
  buy_size?: number; sell_size?: number; net_size?: number
  buy_avg_price?: number | null; sell_avg_price?: number | null
}

// ── formatters ─────────────────────────────────────────────────

const fmtUsd = (n: number | null | undefined): string => {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n), s = n < 0 ? '-' : ''
  if (abs >= 1e9) return s + '$' + (abs / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return s + '$' + (abs / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return s + '$' + (abs / 1e3).toFixed(2) + 'K'
  return s + '$' + abs.toFixed(2)
}
const fmtNum = (n: number | string | null | undefined, dp = 4): string => {
  if (n == null) return '—'
  const v = Number(n)
  if (isNaN(v)) return '—'
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}
const fmtLit = (n: number | null | undefined): string => {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n), s = n < 0 ? '-' : ''
  if (abs >= 1e6) return s + (abs / 1e6).toFixed(2) + 'M LIT'
  if (abs >= 1e3) return s + (abs / 1e3).toFixed(2) + 'K LIT'
  return s + abs.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' LIT'
}
const truncAddr = (a: string) => a ? a.slice(0, 8) + '…' + a.slice(-6) : '—'
const fmtTime = (ts: string | number) => {
  const d = typeof ts === 'string' ? new Date(ts) : new Date(ts > 1e12 ? ts : ts * 1000)
  return d.toLocaleString('en-GB', { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// ── leverage arc gauge ─────────────────────────────────────────

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = deg * Math.PI / 180
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
}
function arc(cx: number, cy: number, r: number, startDeg: number, sweepDeg: number) {
  const [sx, sy] = polar(cx, cy, r, startDeg)
  const [ex, ey] = polar(cx, cy, r, startDeg + sweepDeg)
  const large = Math.abs(sweepDeg) > 180 ? 1 : 0
  const sweep = sweepDeg >= 0 ? 1 : 0
  return `M ${sx.toFixed(2)},${sy.toFixed(2)} A ${r},${r} 0 ${large},${sweep} ${ex.toFixed(2)},${ey.toFixed(2)}`
}

function LevGauge({ leverage }: { leverage: number }) {
  const CX = 60, CY = 52, R = 38, START = 150, TOTAL = 240, MAX = 20
  const color = leverage > 10 ? 'var(--red)' : leverage > 5 ? 'var(--amber)' : 'var(--green)'
  const frac = leverage > 0 ? Math.min(leverage / MAX, 1) : 0
  const sweep = frac * TOTAL
  const [dx, dy] = polar(CX, CY, R, START + sweep)
  return (
    <svg viewBox="0 0 120 80" style={{ width: 100, height: 68 }}>
      <path d={arc(CX, CY, R, START, TOTAL)} fill="none" stroke="var(--line-2)" strokeWidth={6} strokeLinecap="round" />
      {leverage > 0 && <>
        <path d={arc(CX, CY, R, START, Math.max(sweep, 2))} fill="none" stroke={color} strokeWidth={6} strokeLinecap="round" />
        <circle cx={dx.toFixed(2)} cy={dy.toFixed(2)} r={4} fill={color} />
      </>}
      <text x={CX} y={CY + 6} textAnchor="middle" fill={leverage > 0 ? color : 'var(--ink-faint)'} style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        {leverage > 0 ? leverage.toFixed(1) + 'x' : '—'}
      </text>
      <text x={CX} y={CY + 20} textAnchor="middle" fill="var(--ink-faint)" style={{ fontSize: 9 }}>leverage</text>
    </svg>
  )
}

// ── token icon circle ───────────────────────────────────────────────────────────

function TokenIcon({ symbol, icons, size = 28 }: { symbol: string; icons: Record<string, string | null>; size?: number }) {
  const url = icons[symbol]
  const initials = symbol.slice(0, 2).toUpperCase()
  const colors: Record<string, string> = {
    BTC: '#f7931a', ETH: '#627eea', SOL: '#9945ff', NEAR: '#00c08b',
    LIT: '#e0ff6b', HYPE: '#7fb8ff', AVAX: '#e84142', ARB: '#28a0f0',
    OP: '#ff0420', LINK: '#2a5ada', DOGE: '#c3a634', PEPE: '#3d9970',
  }
  const bg = colors[symbol] ?? '#2a3035'
  if (url) {
    return (
      <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', flexShrink: 0, background: bg }}>
        <img src={url} alt={symbol} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={(e: any) => { e.currentTarget.style.display = 'none' }} />
      </div>
    )
  }
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: Math.round(size * 0.34), fontWeight: 700, color: '#fff', letterSpacing: '-0.03em' }}>
      {initials}
    </div>
  )
}

// ── size formatter with symbol suffix ─────────────────────────────────────────────────

function fmtSizeWithSym(size: number, baseSym: string): string {
  const abs = Math.abs(size)
  const pfx = size < 0 ? '-' : ''
  if (abs >= 1e9) return pfx + (abs / 1e9).toFixed(2) + 'B ' + baseSym
  if (abs >= 1e6) return pfx + (abs / 1e6).toFixed(2) + 'M ' + baseSym
  if (abs >= 1e3) return pfx + (abs / 1e3).toFixed(2) + 'K ' + baseSym
  return pfx + abs.toFixed(abs < 10 ? 4 : 2) + ' ' + baseSym
}

// ── flow PnL chart SVG ─────────────────────────────────────────

function buildFlowSvg(trades: HistTrade[], accountIndex: number): { svg: string; lastVal: number } {
  const fills = trades.map(t => {
    const isBuy = (t.role === 'taker' && t.taker_is_buyer === 1) || (t.role === 'maker' && t.taker_is_buyer === 0)
    const usd = parseFloat(t.price) * parseFloat(t.size)
    return { t: new Date(t.time).getTime(), delta: isBuy ? -usd : usd }
  }).sort((a, b) => a.t - b.t)
  if (fills.length < 2) return { svg: '', lastVal: 0 }
  let cum = 0
  const series = fills.map(f => { cum += f.delta; return { t: f.t, v: cum } })
  const W = 600, H = 100, P = 4
  const minT = series[0].t, maxT = series[series.length - 1].t
  const vals = series.map(p => p.v)
  const minV = Math.min(...vals, 0), maxV = Math.max(...vals, 0)
  const rangeT = (maxT - minT) || 1, rangeV = (maxV - minV) || 1
  const toX = (t: number) => P + (t - minT) / rangeT * (W - P * 2)
  const toY = (v: number) => H - P - (v - minV) / rangeV * (H - P * 2)
  const z = toY(0)
  const pts = series.map(p => `${toX(p.t).toFixed(1)},${toY(p.v).toFixed(1)}`).join(' ')
  const firstX = toX(fills[0].t).toFixed(1), lastX = toX(fills[fills.length - 1].t).toFixed(1)
  const lastVal = vals[vals.length - 1]
  const col = lastVal >= 0 ? '#6fe089' : '#ff6a77'
  const area = `M ${firstX},${z.toFixed(1)} ` + series.map(p => `L ${toX(p.t).toFixed(1)},${toY(p.v).toFixed(1)}`).join(' ') + ` L ${lastX},${z.toFixed(1)} Z`
  const svg = `<defs>
    <linearGradient id="fgUp" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#6fe089" stop-opacity="0.4"/><stop offset="100%" stop-color="#6fe089" stop-opacity="0.03"/></linearGradient>
    <linearGradient id="fgDn" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#ff6a77" stop-opacity="0.4"/><stop offset="100%" stop-color="#ff6a77" stop-opacity="0.03"/></linearGradient>
  </defs>
  <line x1="0" y1="${z.toFixed(1)}" x2="${W}" y2="${z.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
  <path d="${area}" fill="url(#${lastVal >= 0 ? 'fgUp' : 'fgDn'})" stroke="none"/>
  <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`
  return { svg, lastVal }
}

// ── mini candle chart SVG (for position expand) ──────────────────

function buildPosCandleSvg(rawCandles: any[]): string {
  const W = 800, H = 160
  const pad = { t: 8, r: 60, b: 20, l: 4 }
  const cW = W - pad.l - pad.r, cH = H - pad.t - pad.b
  if (!rawCandles.length) return `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:11px">no chart data</text>`
  const data = rawCandles.map((c: any) => ({
    t: Number(c.t || c.open_time || c.time || c.timestamp || 0),
    o: parseFloat(c.o ?? c.open ?? 0), h: parseFloat(c.h ?? c.high ?? 0),
    l: parseFloat(c.l ?? c.low ?? 0), c: parseFloat(c.c ?? c.close ?? 0),
    v: parseFloat(c.base_volume ?? c.quote_volume ?? c.volume ?? c.v ?? 0),
  })).filter(c => c.o > 0).sort((a, b) => a.t - b.t)
  if (data.length < 2) return `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:11px">loading…</text>`
  const prices = data.flatMap(c => [c.h, c.l]).filter(p => p > 0)
  const yMin = Math.min(...prices), yMax = Math.max(...prices)
  const yRange = yMax - yMin || yMin * 0.01
  const py = (p: number) => pad.t + ((yMax - p) / yRange) * cH
  const n = data.length, slotW = cW / n, bodyW = Math.max(1, slotW * 0.6)
  let out = [0,1,2,3,4].map(i => {
    const p = yMin + yRange * (i / 4), y = py(p).toFixed(1)
    return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/>` +
      `<text x="${W - pad.r + 4}" y="${(parseFloat(y)+3).toFixed(1)}" fill="var(--ink-faint)" font-size="9" font-family="monospace">$${p.toFixed(4)}</text>`
  }).join('')
  data.forEach((c, i) => {
    const cx = (pad.l + (i + 0.5) * slotW).toFixed(1)
    const isBull = c.c >= c.o, col = isBull ? 'var(--green)' : 'var(--red)'
    const bTop = py(Math.max(c.o, c.c)).toFixed(1), bBot = py(Math.min(c.o, c.c)).toFixed(1)
    const bH = Math.max(1, parseFloat(bBot) - parseFloat(bTop)).toFixed(1)
    out += `<line x1="${cx}" x2="${cx}" y1="${py(c.h).toFixed(1)}" y2="${py(c.l).toFixed(1)}" stroke="${col}" stroke-width="1" opacity="0.7"/>`
    out += `<rect x="${(parseFloat(cx) - bodyW/2).toFixed(1)}" y="${bTop}" width="${bodyW.toFixed(1)}" height="${bH}" fill="${col}" opacity="0.85" rx="0.5"/>`
  })
  const step = Math.max(1, Math.floor(n / 5))
  for (let i = 0; i < n; i += step) {
    const c = data[i], x = (pad.l + (i + 0.5) * slotW).toFixed(1)
    const ts = c.t > 1e12 ? c.t : c.t * 1000
    const lbl = new Date(ts).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    out += `<text x="${x}" y="${H - 4}" text-anchor="middle" fill="var(--ink-faint)" font-size="9" font-family="monospace">${lbl}</text>`
  }
  // volume strip (30px)
  const VH = 28, maxV = Math.max(...data.map(c => c.v)) || 1
  let volSvg = ''
  data.forEach((c, i) => {
    const x = (pad.l + i * slotW).toFixed(1), bh = (c.v / maxV * VH).toFixed(1)
    const col = c.c >= c.o ? 'rgba(111,224,137,0.5)' : 'rgba(255,106,119,0.5)'
    volSvg += `<rect x="${x}" y="${(VH - parseFloat(bh)).toFixed(1)}" width="${(slotW - 0.5).toFixed(1)}" height="${bh}" fill="${col}"/>`
  })
  return `__CANDLE__${out}__VOL__${volSvg}`
}

// ── tracked wallets ─────────────────────────────────────────────

const TW_KEY = 'lit_tracked_v1'
type TrackedWallet = { account_id: number; label: string; added_at: number }

// ── inner component that uses searchParams ──────────────────────

function ExplorerInner() {
  const searchParams = useSearchParams()
  const router = useRouter()

  const [query, setQuery] = useState(searchParams?.get('q') ?? '')
  const [inputVal, setInputVal] = useState(searchParams?.get('q') ?? '')
  const [account, setAccount] = useState<AccountData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<'overview' | 'positions' | 'assets' | 'staking' | 'history' | 'flow'>('overview')
  const [histTrades, setHistTrades] = useState<HistTrade[]>([])
  const [histOffset, setHistOffset] = useState(0)
  const [histLoading, setHistLoading] = useState(false)
  const [histHasMore, setHistHasMore] = useState(false)
  const [litFlow, setLitFlow] = useState<{ '24h': FlowWindow; '7d': FlowWindow; '30d': FlowWindow } | null>(null)
  const [litFlowLoading, setLitFlowLoading] = useState(false)
  const [flowPeriod, setFlowPeriod] = useState<'all' | '24h' | '7d' | '30d'>('all')
  const [allFills, setAllFills] = useState<HistTrade[]>([])
  const [isTracked, setIsTracked] = useState(false)
  const [expandedPos, setExpandedPos] = useState<number | null>(null)
  const [posCandles, setPosCandles] = useState<Record<number, any[]>>({})
  const [posCandleLoading, setPosCandleLoading] = useState<number | null>(null)
  const [tokenIcons, setTokenIcons] = useState<Record<string, string | null>>({})

  const checkTracked = (idx: number) => {
    try {
      const list: TrackedWallet[] = JSON.parse(localStorage.getItem(TW_KEY) || '[]')
      return list.some(w => w.account_id === idx)
    } catch { return false }
  }

  const toggleTracked = (idx: number) => {
    try {
      const list: TrackedWallet[] = JSON.parse(localStorage.getItem(TW_KEY) || '[]')
      const existing = list.findIndex(w => w.account_id === idx)
      if (existing >= 0) { list.splice(existing, 1); setIsTracked(false) }
      else { list.push({ account_id: idx, label: '', added_at: Date.now() }); setIsTracked(true) }
      localStorage.setItem(TW_KEY, JSON.stringify(list))
    } catch {}
  }

  const lookup = useCallback(async (q: string) => {
    if (!q.trim()) return
    setLoading(true); setError(''); setAccount(null); setHistTrades([]); setAllFills([]); setLitFlow(null)
    try {
      const res = await fetch(`/api/lighter/explorer/account?query=${encodeURIComponent(q.trim())}`)
      const j = await res.json()
      if (!res.ok) { setError(j.error || 'Not found'); return }
      setAccount(j)
      setIsTracked(checkTracked(j.account_index))
      setActiveTab('overview')
      router.replace(`/lighter/explorer?q=${encodeURIComponent(q.trim())}`, { scroll: false })
      // background fills fetch
      fetchFills(j.l1_address, j.account_index, 0, true)
      fetchLitFlow(j.account_index, j.l1_address)
      // fetch token icons for positions
      const posSym = (j.positions ?? []).map((p: any) => p.symbol.replace(/-PERP$/, '').replace(/\/USDC$/, ''))
      const assetSym = (j.assets ?? []).map((a: any) => a.symbol)
      const allSym = [...new Set([...posSym, ...assetSym])].join(',')
      if (allSym) fetch(`/api/lighter/icons?symbols=${encodeURIComponent(allSym)}`).then(r => r.json()).then(setTokenIcons).catch(() => {})
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [router])

  const fetchFills = async (address: string, accountIndex: number, offset: number, reset = false) => {
    if (!address) return
    setHistLoading(true)
    try {
      const res = await fetch(`/api/lighter/explorer/history?address=${encodeURIComponent(address)}&account_index=${accountIndex}&limit=100&offset=${offset}`)
      const j = await res.json()
      const trades: HistTrade[] = j.trades ?? []
      if (reset) {
        setHistTrades(trades); setAllFills(trades)
      } else {
        setHistTrades(prev => [...prev, ...trades])
        setAllFills(prev => [...prev, ...trades])
      }
      setHistHasMore(trades.length === 100)
      setHistOffset(offset)
    } catch {}
    finally { setHistLoading(false) }
  }

  const fetchLitFlow = async (accountIndex: number, address: string) => {
    setLitFlowLoading(true)
    try {
      const params = new URLSearchParams({ account_id: String(accountIndex) })
      if (address) params.set('address', address)
      const res = await fetch(`/api/lighter/lit/account-flow-live?${params}`)
      const j = await res.json()
      setLitFlow(j)
    } catch {} finally { setLitFlowLoading(false) }
  }

  const loadPosCandles = async (marketId: number) => {
    if (posCandles[marketId] || posCandleLoading === marketId) return
    setPosCandleLoading(marketId)
    try {
      const res = await fetch(`/api/lighter/lit/candles?market_id=${marketId}&resolution=1h&count=72`)
      const j = await res.json()
      setPosCandles(prev => ({ ...prev, [marketId]: j.candles ?? [] }))
    } catch {} finally { setPosCandleLoading(null) }
  }

  useEffect(() => {
    const q = searchParams?.get('q')
    if (q) { setQuery(q); setInputVal(q); lookup(q) }
  }, [])  // eslint-disable-line

  const handleTabChange = (tab: typeof activeTab) => {
    setActiveTab(tab)
    if (tab === 'history' && account && histTrades.length === 0) {
      fetchFills(account.l1_address, account.account_index, 0, true)
    }
    if (tab === 'flow' && account && !litFlow) {
      fetchLitFlow(account.account_index, account.l1_address)
    }
  }

  // ── derived values ──
  const collateral = parseFloat(account?.collateral ?? '0')
  const available = parseFloat(account?.available_balance ?? '0')
  const totalVal = parseFloat(account?.total_asset_value ?? '0')
  const crossAssetVal = parseFloat(account?.cross_asset_value ?? '0')
  const initMarginReq = parseFloat(account?.cross_initial_margin_requirement ?? '0')
  const maintMarginReq = parseFloat(account?.cross_maintenance_margin_requirement ?? '0')
  const positions = account?.positions ?? []
  const assets = account?.assets ?? []
  const staking = account?.lit_staking ?? { is_staking: false, staked_usdc_value: 0, shares_amount: 0, entry_usdc: 0, pending_unlocks: [], lit_free_balance: 0 }

  const totalPosVal = positions.reduce((s, p) => s + Math.abs(parseFloat(p.position_value || '0')), 0)
  const unrealPnl = positions.reduce((s, p) => s + parseFloat(p.unrealized_pnl || '0'), 0)
  const realPnl = positions.reduce((s, p) => s + parseFloat(p.realized_pnl || '0'), 0)
  const netPnl = unrealPnl + realPnl
  const leverage = collateral > 0 ? totalPosVal / collateral : 0
  const stakingVal = staking.staked_usdc_value ?? 0
  const portfolio = totalVal > 0 ? totalVal : collateral
  // margin health: cross asset value vs initial margin requirement (>100% = safe, <100% = at risk)
  const marginHealthPct = initMarginReq > 0 ? (crossAssetVal / initMarginReq) * 100 : null
  const maintHealthPct = maintMarginReq > 0 ? (crossAssetVal / maintMarginReq) * 100 : null
  const marginColor = marginHealthPct == null ? 'var(--ink-faint)' : marginHealthPct < 105 ? 'var(--red)' : marginHealthPct < 130 ? 'var(--amber)' : 'var(--green)'

  let longVal = 0, shortVal = 0
  positions.forEach(p => {
    const v = Math.abs(parseFloat(p.position_value || '0'))
    if (parseInt(p.sign || '0') >= 0) longVal += v; else shortVal += v
  })
  const biasTotal = longVal + shortVal
  const longPct = biasTotal > 0 ? longVal / biasTotal * 100 : 50
  const biasLabel = biasTotal === 0 ? 'No positions' : longPct > 75 ? '▲ Strong Long' : longPct > 55 ? '↑ Slightly Long' : longPct > 45 ? '→ Balanced' : longPct > 25 ? '↓ Slightly Short' : '▼ Strong Short'
  const biasColor = biasTotal === 0 ? 'var(--ink-faint)' : longPct > 50 ? 'var(--green)' : 'var(--red)'

  // flow chart
  const filterFills = (period: string) => {
    if (period === 'all') return allFills
    const ms: Record<string, number> = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 }
    const cutoff = Date.now() - (ms[period] ?? 0)
    return allFills.filter(t => new Date(t.time).getTime() >= cutoff)
  }
  const { svg: flowSvg, lastVal: flowPnl } = buildFlowSvg(filterFills(flowPeriod), account?.account_index ?? 0)

  return (
    <div>
      {/* search control bar */}
      <div style={{ display: 'flex', gap: 8, padding: '10px 24px', borderBottom: '1px solid var(--line)', background: 'var(--paper-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={inputVal}
          onChange={e => setInputVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { setQuery(inputVal); lookup(inputVal) } }}
          placeholder="account # or 0x address…"
          style={{ flex: 1, maxWidth: 440, background: 'var(--bg)', border: '1px solid var(--line-2)', borderRadius: 3, color: 'var(--ink)', padding: '7px 12px', fontSize: 13, outline: 'none', fontFamily: 'var(--font-mono)' }} />
        <button onClick={() => { setQuery(inputVal); lookup(inputVal) }} disabled={loading}
          className="ch on" style={{ padding: '7px 20px', fontSize: 11 }}>
          {loading ? 'searching…' : 'search'}
        </button>
        {error && <span style={{ fontSize: 12, color: 'var(--red)', marginLeft: 4 }}>{error}</span>}
        {!account && !loading && !error && (
          <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>enter an account index or ethereum address</span>
        )}
      </div>

      {account && (
        <>
          {/* identity strip */}
          <div style={{ padding: '12px 24px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-serif)', fontWeight: 500, fontSize: 22, letterSpacing: '-0.02em', fontStyle: 'italic' }}>
              #{account.account_index}
            </span>
            {account.name && <span style={{ fontSize: 13, color: 'var(--ink-dim)' }}>{account.name}</span>}
            {account.l1_address && (
              <span style={{ fontSize: 11, color: 'var(--blue)', fontFamily: 'var(--font-mono)' }}>
                {account.l1_address}
                <a href={`https://app.lighter.xyz/explorer/accounts/${account.l1_address}`} target="_blank" rel="noopener"
                  style={{ marginLeft: 6, color: 'var(--blue)', textDecoration: 'none', fontSize: 10 }}>↗</a>
              </span>
            )}
            <span style={{ fontSize: 11, color: account.status === 1 ? 'var(--green)' : 'var(--ink-faint)' }}>
              {account.status === 1 ? '● active' : '○ inactive'}
            </span>
            {staking.is_staking && (
              <span style={{ padding: '2px 7px', border: '1px solid var(--amber)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--amber)' }}>
                lit staking
              </span>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{account.total_order_count.toLocaleString()} orders total</span>
              <button onClick={() => toggleTracked(account.account_index)}
                style={{ padding: '4px 12px', fontSize: 10, border: isTracked ? '1px solid var(--amber)' : '1px solid var(--line-2)', background: isTracked ? 'rgba(242,193,78,0.1)' : 'transparent', color: isTracked ? 'var(--amber)' : 'var(--ink-dim)', borderRadius: 3, cursor: 'pointer', letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
                {isTracked ? '★ tracked' : '☆ track'}
              </button>
            </div>
          </div>

          {/* cockpit KPI strip */}
          <div className="cockpit-kpis" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
            <div className="cockpit-kpi">
              <div className="lbl">Collateral</div>
              <div className="val">{fmtUsd(collateral)}</div>
              <div className="sub">{fmtUsd(available)} free</div>
            </div>
            <div className="cockpit-kpi">
              <div className="lbl">Portfolio</div>
              <div className="val">{fmtUsd(portfolio)}</div>
              <div className="sub">{positions.length} open position{positions.length !== 1 ? 's' : ''}</div>
            </div>
            <div className="cockpit-kpi">
              <div className="lbl">Unrealized PnL</div>
              <div className={`val ${unrealPnl > 0 ? 'up' : unrealPnl < 0 ? 'down' : ''}`}>
                {unrealPnl !== 0 ? (unrealPnl >= 0 ? '+' : '') + fmtUsd(unrealPnl) : '—'}
              </div>
              <div className="sub">{realPnl !== 0 ? 'real: ' + (realPnl >= 0 ? '+' : '') + fmtUsd(realPnl) : 'no realized pnl'}</div>
            </div>
            <div className="cockpit-kpi">
              <div className="lbl">Direction</div>
              <div className="val" style={{ color: biasColor, fontSize: biasTotal > 0 ? 20 : 16, letterSpacing: 0 }}>{biasLabel}</div>
              <div className="sub">{biasTotal > 0 ? `${longPct.toFixed(0)}% long · ${(100 - longPct).toFixed(0)}% short` : 'no positions'}</div>
            </div>
            <div className="cockpit-kpi">
              <div className="lbl">Leverage</div>
              <div className="val" style={{ color: leverage > 10 ? 'var(--red)' : leverage > 5 ? 'var(--amber)' : leverage > 0 ? 'var(--green)' : 'var(--ink-faint)' }}>
                {leverage > 0 ? leverage.toFixed(1) + '×' : '—'}
              </div>
              <div className="sub">{totalPosVal > 0 ? fmtUsd(totalPosVal) + ' notional' : 'no exposure'}</div>
            </div>
            <div className="cockpit-kpi">
              <div className="lbl">Margin Health</div>
              <div className="val" style={{ color: marginColor, fontSize: 24 }}>
                {marginHealthPct != null ? marginHealthPct.toFixed(0) + '%' : '—'}
              </div>
              <div className="sub" style={{ color: marginHealthPct == null ? 'var(--ink-faint)' : marginHealthPct < 105 ? 'var(--red)' : marginHealthPct < 130 ? 'var(--amber)' : 'var(--ink-dim)' }}>
                {marginHealthPct == null ? 'no positions' : marginHealthPct < 105 ? '⚠ near liquidation' : marginHealthPct < 130 ? 'caution' : 'healthy'}
              </div>
            </div>
          </div>

          {/* allocation + margin bar */}
          {(portfolio > 0 || (marginHealthPct != null && totalPosVal > 0)) && (
            <div style={{ padding: '10px 24px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'center' }}>
              {portfolio > 0 && (
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 10, color: 'var(--ink-faint)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 5 }}>Allocation</div>
                  <div style={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden', background: 'var(--line)', marginBottom: 4 }}>
                    <div style={{ width: Math.min(totalPosVal / portfolio * 100, 100).toFixed(1) + '%', background: 'var(--blue)', transition: 'width .4s' }} />
                    <div style={{ width: Math.min(stakingVal / portfolio * 100, 100).toFixed(1) + '%', background: 'var(--amber)' }} />
                    <div style={{ flex: 1, background: 'rgba(111,224,137,0.3)' }} />
                  </div>
                  <div style={{ display: 'flex', gap: 16, fontSize: 10, color: 'var(--ink-dim)' }}>
                    <span><span style={{ color: 'var(--blue)' }}>■</span> perps {(totalPosVal / portfolio * 100).toFixed(1)}%</span>
                    {stakingVal > 0 && <span><span style={{ color: 'var(--amber)' }}>■</span> staking {(stakingVal / portfolio * 100).toFixed(1)}%</span>}
                    <span><span style={{ color: 'rgba(111,224,137,0.6)' }}>■</span> free {Math.max(0, 100 - totalPosVal / portfolio * 100 - stakingVal / portfolio * 100).toFixed(1)}%</span>
                  </div>
                </div>
              )}
              {marginHealthPct != null && totalPosVal > 0 && (
                <div style={{ minWidth: 200 }}>
                  <div style={{ fontSize: 10, color: 'var(--ink-faint)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 5 }}>Margin Bar</div>
                  <div style={{ width: '100%', height: 4, background: 'var(--line)', borderRadius: 2, position: 'relative', marginBottom: 4 }}>
                    <div style={{ height: '100%', width: `${Math.min(marginHealthPct, 300) / 3}%`, background: marginColor, borderRadius: 2, transition: 'width .4s' }} />
                    {maintHealthPct != null && (
                      <div style={{ position: 'absolute', top: -2, left: `${Math.min(maintHealthPct, 300) / 3}%`, width: 1, height: 8, background: 'var(--red)', opacity: 0.7 }} title="maintenance margin" />
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--ink-dim)' }}>
                    {fmtUsd(crossAssetVal)} / <span style={{ color: 'var(--ink-faint)' }}>{fmtUsd(initMarginReq)} init required</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* tabs */}
          <div style={{ display: 'flex', gap: 4, padding: '8px 24px', borderBottom: '1px solid var(--line)', background: 'var(--paper-2)', flexWrap: 'wrap' }}>
            {([
              ['overview', 'overview'],
              ['positions', `positions${positions.length ? ` (${positions.length})` : ''}`],
              ['assets', `assets${assets.length ? ` (${assets.length})` : ''}`],
              ['staking', 'lit staking'],
              ['history', 'trade history'],
              ['flow', 'lit flow'],
            ] as const).map(([id, label]) => (
              <button key={id}
                className={`ch${activeTab === id ? ' on' : ''}`}
                onClick={() => handleTabChange(id)}
                style={{ padding: '4px 14px', fontSize: 11 }}>
                {label}
              </button>
            ))}
          </div>

          {/* overview tab */}
          {activeTab === 'overview' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 1, background: 'var(--line)' }}>
              {/* left: positions snapshot + assets */}
              <div style={{ background: 'var(--bg)', padding: '20px 24px' }}>
                <div className="cockpit-h2">Open Positions</div>
                {positions.length === 0 ? (
                  <div style={{ color: 'var(--ink-faint)', fontSize: 12, marginBottom: 20 }}>no open positions</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 20 }}>
                    <tbody>
                      {[...positions].sort((a, b) => Math.abs(parseFloat(b.position_value)) - Math.abs(parseFloat(a.position_value))).map((p, i) => {
                        const size = parseFloat(p.position)
                        const isLong = size >= 0
                        const pnl = parseFloat(p.unrealized_pnl || '0')
                        const posVal = Math.abs(parseFloat(p.position_value || '0'))
                        const liqPrice = parseFloat(p.liquidation_price || '0')
                        const markPrice = posVal > 0 && Math.abs(size) > 0 ? posVal / Math.abs(size) : 0
                        const distPct = liqPrice > 0 && markPrice > 0 ? Math.abs(markPrice - liqPrice) / markPrice * 100 : null
                        const baseSym = p.symbol.replace(/-PERP$/, '').replace(/\/USDC$/, '')
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid var(--line)', cursor: 'pointer' }}
                            onClick={() => setActiveTab('positions')}>
                            <td style={{ padding: '8px 0', width: 36 }}>
                              <TokenIcon symbol={baseSym} icons={tokenIcons} size={24} />
                            </td>
                            <td style={{ padding: '8px 4px' }}>
                              <div style={{ fontWeight: 600, fontSize: 12 }}>{baseSym}</div>
                              <div style={{ fontSize: 9, color: 'var(--ink-faint)' }}>{isLong ? 'LONG' : 'SHORT'}</div>
                            </td>
                            <td style={{ padding: '8px 4px', textAlign: 'right', color: 'var(--ink-dim)', fontSize: 11 }}>{fmtUsd(posVal)}</td>
                            <td style={{ padding: '8px 0', textAlign: 'right', fontWeight: 600 }} className={pnl >= 0 ? 'pos' : 'neg'}>{pnl >= 0 ? '+' : ''}{fmtUsd(pnl)}</td>
                            {distPct != null && distPct < 20 && (
                              <td style={{ padding: '8px 0 8px 8px', textAlign: 'right', fontSize: 10, color: distPct < 8 ? 'var(--red)' : 'var(--amber)' }}>liq {distPct.toFixed(1)}%</td>
                            )}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
                {assets.length > 0 && (
                  <>
                    <div className="cockpit-h2">Assets</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                      {assets.map((a, i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--line)', fontSize: 12 }}>
                          <span style={{ fontWeight: 600 }}>{a.symbol}</span>
                          <span style={{ color: 'var(--ink-dim)', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(parseFloat(a.balance), 4)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {/* right: staking + LIT flow */}
              <div style={{ background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--line)' }}>
                  <div className="cockpit-h2">LIT Staking</div>
                  {staking.is_staking ? (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <div>
                        <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginBottom: 4 }}>Staked</div>
                        <div className="pos" style={{ fontFamily: 'var(--font-serif)', fontSize: 20, fontWeight: 500 }}>{fmtUsd(staking.staked_usdc_value)}</div>
                      </div>
                      {staking.entry_usdc > 0 && (
                        <div>
                          <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginBottom: 4 }}>Staking PnL</div>
                          <div className={staking.staked_usdc_value >= staking.entry_usdc ? 'pos' : 'neg'} style={{ fontFamily: 'var(--font-serif)', fontSize: 20, fontWeight: 500 }}>
                            {staking.staked_usdc_value - staking.entry_usdc >= 0 ? '+' : ''}{fmtUsd(staking.staked_usdc_value - staking.entry_usdc)}
                          </div>
                        </div>
                      )}
                      {staking.lit_free_balance > 0 && (
                        <div>
                          <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginBottom: 4 }}>LIT Free</div>
                          <div style={{ fontSize: 14, fontWeight: 500 }}>{fmtLit(staking.lit_free_balance)}</div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ color: 'var(--ink-faint)', fontSize: 12 }}>
                      not staking{staking.lit_free_balance > 0 ? ` · holds ${fmtLit(staking.lit_free_balance)}` : ''}
                    </div>
                  )}
                </div>
                <div style={{ padding: '20px 24px', flex: 1 }}>
                  <div className="cockpit-h2">LIT Flow</div>
                  {litFlowLoading && <div style={{ color: 'var(--ink-faint)', fontSize: 12 }}>loading…</div>}
                  {litFlow && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {(['24h', '7d', '30d'] as const).map(w => {
                        const wd = litFlow[w]
                        if (!wd) return null
                        const flowPnl = wd.sell_usd - wd.buy_usd
                        const isWin = flowPnl >= 0
                        const total = wd.buy_usd + wd.sell_usd || 1
                        const hasTrades = wd.buy_trades + wd.sell_trades > 0
                        return (
                          <div key={w}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
                              <span style={{ fontSize: 10, color: 'var(--ink-faint)', letterSpacing: '0.12em', textTransform: 'uppercase', width: 28 }}>{w}</span>
                              {hasTrades ? (
                                <>
                                  <div style={{ flex: 1, height: 3, background: 'var(--line)', borderRadius: 2, overflow: 'hidden' }}>
                                    <div style={{ height: '100%', width: (wd.buy_usd / total * 100).toFixed(1) + '%', background: 'var(--green)', transition: 'width .4s' }} />
                                  </div>
                                  <span className="pos" style={{ fontSize: 11, width: 56, textAlign: 'right' }}>{fmtUsd(wd.buy_usd)}</span>
                                  <span className="neg" style={{ fontSize: 11, width: 56, textAlign: 'right' }}>{fmtUsd(wd.sell_usd)}</span>
                                  <span className={isWin ? 'pos' : 'neg'} style={{ fontSize: 13, fontWeight: 700, width: 64, textAlign: 'right' }}>{flowPnl >= 0 ? '+' : ''}{fmtUsd(flowPnl)}</span>
                                  <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 2, background: isWin ? 'rgba(111,224,137,0.18)' : 'rgba(255,106,119,0.18)', color: isWin ? 'var(--green)' : 'var(--red)' }}>{isWin ? 'W' : 'L'}</span>
                                </>
                              ) : (
                                <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>no LIT trades</span>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {!litFlowLoading && !litFlow && (
                    <div style={{ color: 'var(--ink-faint)', fontSize: 12 }}>no LIT activity found</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* positions tab */}
          {activeTab === 'positions' && (
            <div>
              <div className="table-scroll-x">
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      {['Asset', 'Size', 'Value', 'Entry', 'Mark', 'PnL', 'Liq Price'].map(h => (
                        <th key={h} style={{ padding: '10px 16px', textAlign: h === 'Asset' ? 'left' : 'right', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...positions].sort((a, b) => Math.abs(parseFloat(b.position_value)) - Math.abs(parseFloat(a.position_value))).map((p, i) => {
                      const size = parseFloat(p.position)
                      const isLong = size >= 0
                      const pnl = parseFloat(p.unrealized_pnl || '0')
                      const posVal = Math.abs(parseFloat(p.position_value || '0'))
                      const liqPrice = parseFloat(p.liquidation_price || '0')
                      const entryPrice = parseFloat(p.avg_entry_price || '0')
                      const markPrice = posVal > 0 && Math.abs(size) > 0 ? posVal / Math.abs(size) : 0
                      const distPct = liqPrice > 0 && markPrice > 0 ? Math.abs(markPrice - liqPrice) / markPrice * 100 : null
                      const distColor = distPct == null ? '' : distPct < 8 ? 'var(--red)' : distPct < 18 ? 'var(--amber)' : 'var(--green)'
                      const roe = posVal > 0 ? pnl / posVal * 100 : 0
                      const rowBg = distPct != null && distPct < 8 ? 'rgba(255,90,90,0.04)' : ''
                      const baseSym = p.symbol.replace(/-PERP$/, '').replace(/\/USDC$/, '')
                      const priceDecimals = markPrice > 1000 ? 2 : markPrice > 1 ? 4 : 6
                      return (
                        <>
                        <tr key={i} style={{ borderBottom: '1px solid var(--line)', background: rowBg, cursor: 'pointer' }}
                          onClick={() => {
                            if (expandedPos === p.market_id) { setExpandedPos(null) }
                            else { setExpandedPos(p.market_id); loadPosCandles(p.market_id) }
                          }}>
                          {/* Asset: icon + symbol + side pill */}
                          <td style={{ padding: '10px 16px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <TokenIcon symbol={baseSym} icons={tokenIcons} size={30} />
                              <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span style={{ fontWeight: 700, fontSize: 13 }}>{baseSym}</span>
                                  <span className={isLong ? 'pill-buy' : 'pill-sell'} style={{ fontSize: 9, padding: '1px 5px' }}>{isLong ? 'LONG' : 'SHORT'}</span>
                                  <span style={{ fontSize: 8, color: 'var(--ink-faint)', letterSpacing: '0.06em' }}>{expandedPos === p.market_id ? '▲' : '▼'}</span>
                                </div>
                                <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 2 }}>{p.symbol}</div>
                              </div>
                            </div>
                          </td>
                          {/* Size with token suffix */}
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            <div className={isLong ? 'pos' : 'neg'} style={{ fontWeight: 600 }}>{fmtSizeWithSym(size, baseSym)}</div>
                          </td>
                          {/* Value */}
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtUsd(posVal)}</td>
                          {/* Entry */}
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--ink-dim)' }}>
                            ${entryPrice.toLocaleString('en-US', { minimumFractionDigits: priceDecimals, maximumFractionDigits: priceDecimals })}
                          </td>
                          {/* Mark */}
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            ${markPrice > 0 ? markPrice.toLocaleString('en-US', { minimumFractionDigits: priceDecimals, maximumFractionDigits: priceDecimals }) : '—'}
                          </td>
                          {/* PnL */}
                          <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                            <div className={pnl >= 0 ? 'pos' : 'neg'} style={{ fontWeight: 700 }}>{pnl >= 0 ? '+' : ''}{fmtUsd(pnl)}</div>
                            {posVal > 0 && <div style={{ fontSize: 10, color: roe >= 0 ? 'var(--green)' : 'var(--red)', marginTop: 1 }}>{roe >= 0 ? '+' : ''}{roe.toFixed(2)}%</div>}
                          </td>
                          {/* Liq Price */}
                          <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                            <div style={{ color: distPct != null && distPct < 8 ? 'var(--red)' : 'var(--ink-dim)', fontVariantNumeric: 'tabular-nums' }}>
                              {liqPrice > 0 ? '$' + liqPrice.toLocaleString('en-US', { minimumFractionDigits: priceDecimals, maximumFractionDigits: priceDecimals }) : '—'}
                            </div>
                            {distPct != null && <div style={{ fontSize: 9, color: distColor, marginTop: 2 }}>{distPct.toFixed(1)}% away</div>}
                          </td>
                        </tr>
                        {expandedPos === p.market_id && (
                          <tr key={`chart-${p.market_id}`}>
                            <td colSpan={7} style={{ padding: 0, background: 'var(--paper-2)', borderBottom: '1px solid var(--line)' }}>
                              <div style={{ padding: '12px 16px' }}>
                                <div style={{ fontSize: 10, color: 'var(--ink-faint)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>
                                  {p.symbol} · 1h chart
                                  {posCandleLoading === p.market_id && <span style={{ marginLeft: 8 }}>loading…</span>}
                                </div>
                                {posCandles[p.market_id] ? (() => {
                                  const result = buildPosCandleSvg(posCandles[p.market_id])
                                  const parts = result.split('__VOL__')
                                  const candleBody = parts[0].replace('__CANDLE__', '')
                                  const volBody = parts[1] ?? ''
                                  return (
                                    <>
                                      <svg viewBox="0 0 800 160" preserveAspectRatio="none" style={{ width: '100%', height: 160, display: 'block', overflow: 'visible' }}
                                        dangerouslySetInnerHTML={{ __html: candleBody }} />
                                      <svg viewBox="0 0 800 28" preserveAspectRatio="none" style={{ width: '100%', height: 28, display: 'block', marginTop: 2 }}
                                        dangerouslySetInnerHTML={{ __html: volBody }} />
                                    </>
                                  )
                                })() : (
                                  <div style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-faint)', fontSize: 12 }}>
                                    {posCandleLoading === p.market_id ? 'loading chart…' : 'no chart data'}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                        </>
                      )
                    })}
                    {!positions.length && (
                      <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center', color: 'var(--ink-faint)' }}>no open positions</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* assets tab */}
          {activeTab === 'assets' && (
            <div>
              <div className="table-scroll-x">
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      {['Symbol', 'Balance', 'Allocation', 'Locked'].map(h => (
                        <th key={h} style={{ padding: '10px 16px', textAlign: h === 'Symbol' ? 'left' : 'right' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {assets.map((a, i) => {
                      const bal = parseFloat(a.balance)
                      const locked = parseFloat(a.locked_balance || '0')
                      const allocPct = portfolio > 0 && bal > 0 ? Math.min(bal / portfolio * 100, 100) : 0
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid var(--line)' }}>
                          <td style={{ padding: '9px 16px', fontWeight: 600 }}>{a.symbol}</td>
                          <td style={{ padding: '9px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(bal, 6)}</td>
                          <td style={{ padding: '9px 16px', textAlign: 'right' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                              <div style={{ width: 48, height: 3, background: 'var(--line)', borderRadius: 2 }}>
                                <div style={{ height: '100%', width: allocPct.toFixed(1) + '%', background: 'var(--green)', borderRadius: 2 }} />
                              </div>
                              <span style={{ fontSize: 11, color: 'var(--ink-dim)', minWidth: 30 }}>{allocPct.toFixed(1)}%</span>
                            </div>
                          </td>
                          <td style={{ padding: '9px 16px', textAlign: 'right', color: locked > 0 ? 'var(--amber)' : 'var(--ink-faint)' }}>{locked > 0 ? fmtNum(locked, 6) : '—'}</td>
                        </tr>
                      )
                    })}
                    {!assets.length && (
                      <tr><td colSpan={4} style={{ padding: 32, textAlign: 'center', color: 'var(--ink-faint)' }}>no spot assets held</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* staking tab */}
          {activeTab === 'staking' && (
            <div style={{ padding: '20px 24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 16, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 18, fontWeight: 600, color: staking.is_staking ? 'var(--green)' : 'var(--ink-faint)' }}>
                  {staking.is_staking ? '● Staking' : '○ Not Staking'}
                </div>
                <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                  <div style={{ fontSize: 10, color: 'var(--ink-faint)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4 }}>LIT Free Balance</div>
                  <div style={{ fontSize: 18, fontWeight: 600 }}>{staking.lit_free_balance > 0 ? fmtLit(staking.lit_free_balance) : '—'}</div>
                </div>
              </div>
              {staking.is_staking && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1, background: 'var(--line)', marginBottom: 16 }}>
                  {[
                    { lbl: 'Staked Value', val: fmtUsd(staking.staked_usdc_value), cls: 'pos' },
                    { lbl: 'Entry Value', val: staking.entry_usdc > 0 ? fmtUsd(staking.entry_usdc) : '—', cls: '' },
                    {
                      lbl: 'Staking PnL',
                      val: staking.entry_usdc > 0 ? (staking.staked_usdc_value - staking.entry_usdc >= 0 ? '+' : '') + fmtUsd(staking.staked_usdc_value - staking.entry_usdc) : '—',
                      cls: staking.entry_usdc > 0 ? (staking.staked_usdc_value >= staking.entry_usdc ? 'pos' : 'neg') : '',
                    },
                    { lbl: 'Shares Held', val: Number(staking.shares_amount).toLocaleString(), cls: '' },
                  ].map(k => (
                    <div key={k.lbl} style={{ background: 'var(--bg)', padding: '16px 20px' }}>
                      <div style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-faint)', marginBottom: 6 }}>{k.lbl}</div>
                      <div className={k.cls} style={{ fontSize: 20, fontVariantNumeric: 'tabular-nums', fontWeight: 500, fontFamily: 'var(--font-serif)' }}>{k.val}</div>
                    </div>
                  ))}
                </div>
              )}
              {staking.pending_unlocks.length > 0 && (
                <div>
                  <div style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--amber)', marginBottom: 8 }}>
                    ⚠ Pending Unstake ({staking.pending_unlocks.length})
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th style={{ padding: '4px 8px', textAlign: 'left' }}>Amount</th>
                        <th style={{ padding: '4px 8px', textAlign: 'right' }}>Unlock Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {staking.pending_unlocks.map((u, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--line)' }}>
                          <td style={{ padding: '6px 8px', fontVariantNumeric: 'tabular-nums' }}>{fmtUsd(parseFloat(u.usdc_amount ?? u.amount ?? '0'))}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--amber)', fontSize: 11 }}>{u.unlock_time ? fmtTime(u.unlock_time) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* history tab */}
          {activeTab === 'history' && (
            <div>
              {/* cumulative flow chart */}
              <div style={{ padding: '14px 24px', borderBottom: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: 'var(--ink-dim)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Cumulative Flow</span>
                  <span className={flowPnl >= 0 ? 'pos' : 'neg'} style={{ fontFamily: 'var(--font-serif)', fontSize: 20, fontWeight: 500 }}>
                    {flowPnl !== 0 ? (flowPnl >= 0 ? '+' : '') + fmtUsd(flowPnl) : '—'}
                  </span>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    {(['all', '24h', '7d', '30d'] as const).map(p => (
                      <button key={p} className={`ch${flowPeriod === p ? ' on' : ''}`}
                        onClick={() => setFlowPeriod(p)} style={{ padding: '3px 10px', fontSize: 11 }}>{p}</button>
                    ))}
                  </div>
                </div>
                {flowSvg ? (
                  <svg viewBox="0 0 600 100" preserveAspectRatio="none" style={{ width: '100%', height: 90, display: 'block' }}
                    dangerouslySetInnerHTML={{ __html: flowSvg }} />
                ) : (
                  <div style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-faint)', fontSize: 12 }}>
                    {histLoading ? 'loading…' : 'no trade history to chart'}
                  </div>
                )}
              </div>
              {/* trade table */}
              <div className="table-scroll-x" style={{ maxHeight: 480, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 1 }}>
                      {['Time', 'Market', 'Role', 'Side', 'Price', 'Size', 'Value'].map(h => (
                        <th key={h} style={{ padding: '8px 16px', textAlign: ['Price', 'Size', 'Value'].includes(h) ? 'right' : 'left', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {histTrades.map((t, i) => {
                      const isBuy = (t.role === 'taker' && t.taker_is_buyer === 1) || (t.role === 'maker' && t.taker_is_buyer === 0)
                      const usd = parseFloat(t.price) * parseFloat(t.size)
                      const mkt = t.market_id === 120 ? 'LIT-PERP' : t.market_id === 2049 ? 'LIT/USDC' : `Mkt ${t.market_id}`
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid var(--line)' }}>
                          <td style={{ padding: '7px 16px', color: 'var(--ink-dim)', fontSize: 11, whiteSpace: 'nowrap' }}>{fmtTime(t.time)}</td>
                          <td style={{ padding: '7px 16px', fontSize: 11, color: 'var(--ink-faint)' }}>{mkt}</td>
                          <td style={{ padding: '7px 16px', fontSize: 10, letterSpacing: '0.08em', color: 'var(--ink-faint)' }}>{t.role?.toUpperCase()}</td>
                          <td style={{ padding: '7px 16px' }}>
                            <span className={isBuy ? 'pill-buy' : 'pill-sell'}>{isBuy ? 'BUY' : 'SELL'}</span>
                          </td>
                          <td style={{ padding: '7px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>${parseFloat(t.price).toFixed(4)}</td>
                          <td style={{ padding: '7px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(t.size, 2)}</td>
                          <td style={{ padding: '7px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtUsd(usd)}</td>
                        </tr>
                      )
                    })}
                    {!histTrades.length && !histLoading && (
                      <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center', color: 'var(--ink-faint)' }}>no trade history found</td></tr>
                    )}
                    {histLoading && (
                      <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: 'var(--ink-faint)' }}>loading…</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {histHasMore && (
                <div style={{ padding: '12px 24px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button onClick={() => fetchFills(account.l1_address, account.account_index, histOffset + 100)}
                    disabled={histLoading} className="ch" style={{ padding: '6px 16px', fontSize: 11 }}>
                    {histLoading ? 'loading…' : 'load more'}
                  </button>
                  <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{histTrades.length} loaded</span>
                </div>
              )}
            </div>
          )}

          {/* LIT flow tab */}
          {activeTab === 'flow' && (
            <div>
              {litFlowLoading && (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--ink-faint)', fontSize: 12 }}>loading LIT flow data…</div>
              )}
              {!litFlowLoading && !litFlow && (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--ink-faint)', fontSize: 12 }}>no LIT trading data found for this account</div>
              )}
              {litFlow && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, background: 'var(--line)' }}>
                  {(['24h', '7d', '30d'] as const).map(w => {
                    const wData = litFlow[w]
                    if (!wData) return null
                    const net = wData.net_usd
                    const flowPnl = wData.sell_usd - wData.buy_usd
                    const isWin = flowPnl >= 0
                    const total = wData.buy_usd + wData.sell_usd || 1
                    const pctBuy = wData.buy_usd / total * 100
                    return (
                      <div key={w} style={{ background: 'var(--bg)', padding: '20px 24px' }}>
                        <div style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--ink-faint)', marginBottom: 14 }}>{w}</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                          <div>
                            <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginBottom: 3 }}>Bought</div>
                            <div className="pos" style={{ fontFamily: 'var(--font-serif)', fontSize: 20, fontWeight: 500 }}>{fmtUsd(wData.buy_usd)}</div>
                            <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 2 }}>{wData.buy_trades} trades</div>
                            {wData.buy_avg_price != null && <div style={{ fontSize: 10, color: 'var(--ink-dim)', marginTop: 1 }}>avg ${wData.buy_avg_price.toFixed(4)}</div>}
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginBottom: 3 }}>Sold</div>
                            <div className="neg" style={{ fontFamily: 'var(--font-serif)', fontSize: 20, fontWeight: 500 }}>{fmtUsd(wData.sell_usd)}</div>
                            <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 2 }}>{wData.sell_trades} trades</div>
                            {wData.sell_avg_price != null && <div style={{ fontSize: 10, color: 'var(--ink-dim)', marginTop: 1 }}>avg ${wData.sell_avg_price.toFixed(4)}</div>}
                          </div>
                        </div>
                        <div style={{ display: 'flex', height: 3, borderRadius: 2, overflow: 'hidden', background: 'var(--line)', marginBottom: 14 }}>
                          <div style={{ width: pctBuy.toFixed(1) + '%', background: 'var(--green)', transition: 'width .4s' }} />
                          <div style={{ flex: 1, background: 'var(--red)' }} />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div>
                            <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginBottom: 3 }}>Flow P&amp;L</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span className={isWin ? 'pos' : 'neg'} style={{ fontFamily: 'var(--font-serif)', fontSize: 22, fontWeight: 500 }}>
                                {flowPnl >= 0 ? '+' : ''}{fmtUsd(flowPnl)}
                              </span>
                              <span style={{ fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 2, background: isWin ? 'rgba(111,224,137,0.18)' : 'rgba(255,106,119,0.18)', color: isWin ? 'var(--green)' : 'var(--red)', letterSpacing: '0.06em' }}>
                                {isWin ? 'W' : 'L'}
                              </span>
                            </div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginBottom: 3 }}>Net</div>
                            <div className={net <= 0 ? 'pos' : 'neg'} style={{ fontSize: 13, fontWeight: 600 }}>
                              {net > 0 ? '+' : ''}{fmtUsd(-net)} {net > 0 ? 'holding' : 'took'}
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {!account && !loading && !error && (
        <div style={{ padding: '80px 24px', textAlign: 'center', color: 'var(--ink-faint)', fontSize: 13 }}>
          search by account index or ethereum address to explore positions, assets, and trade history
        </div>
      )}

      <div style={{ height: 40 }} />
    </div>
  )
}

// ── outer component with Suspense ───────────────────────────────

export default function ExplorerPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40, color: 'var(--ink-faint)', fontSize: 13 }}>Loading…</div>}>
      <ExplorerInner />
    </Suspense>
  )
}
