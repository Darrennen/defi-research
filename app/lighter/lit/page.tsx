'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'

// ── types ──────────────────────────────────────────────────────

type LitSummary = {
  perp: { last_price: number; price_change: number; volume_24h: number; trades_24h: number; price_high_24h: number; price_low_24h: number; funding: number | null } | null
  spot: { last_price: number; price_change: number; volume_24h: number; trades_24h: number } | null
  perp_flow: { buy_usd: number; sell_usd: number; delta_usd: number }
  spot_flow: { buy_usd: number; sell_usd: number; delta_usd: number }
}

type LitTrade = {
  market_id: number; ts: number; price: number; size: number; usd: number
  taker_is_buyer: number; buyer_id: number; seller_id: number
}

type LitFlow = {
  buy_usd: number; sell_usd: number; delta_usd: number; trade_count: number
  oldest_ts: number | null
}

type LeaderItem = {
  account_id: number; total_usd: number; trade_count: number
  first_ts: number | null; last_ts: number | null
}

type Leaders = { buyers: LeaderItem[]; sellers: LeaderItem[]; oldest_ts: number | null }

type TwapAlert = {
  side: 'BUY' | 'SELL'
  account_id: number
  total_usd: number
  count: number
  avgSpacingMs: number
  max_usd: number
  first_ts: number
  last_ts: number
}

type StakingStats = {
  h24: { stake_usd: number; unstake_usd: number; net_usd: number; stakes: number; unstakes: number; unique_accounts: number }
  h168: { stake_usd: number; unstake_usd: number; net_usd: number; stakes: number; unstakes: number; unique_accounts: number }
  raw_count: number
}

// ── formatters ─────────────────────────────────────────────────

const fmtUsd = (n: number | null | undefined): string => {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n), s = n < 0 ? '-' : ''
  if (abs >= 1e9) return s + '$' + (abs / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return s + '$' + (abs / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return s + '$' + (abs / 1e3).toFixed(2) + 'K'
  return s + '$' + abs.toFixed(abs < 1 ? 4 : 2)
}
const fmtPrice = (n: number | null | undefined): string =>
  n == null ? '—' : '$' + Number(n).toFixed(4)
const fmtPct = (n: number | null | undefined, dp = 2): string => {
  if (n == null || isNaN(n)) return '—'
  return (n >= 0 ? '+' : '') + n.toFixed(dp) + '%'
}
const fmtNum = (n: number | null | undefined, dp = 2): string => {
  if (n == null || isNaN(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}
const fmtTime = (ts: number): string =>
  new Date(ts > 1e12 ? ts : ts * 1000).toLocaleTimeString('en-GB', { hour12: false })
const fmtDuration = (ms: number): string => {
  const h = ms / 3_600_000
  if (h < 1) return Math.round(h * 60) + 'm'
  if (h < 48) return h.toFixed(1) + 'h'
  return (h / 24).toFixed(1) + 'd'
}
const fmtAcct = (id: number | null | undefined): string => id ? '#' + id : '—'

// ── TWAP detection ──────────────────────────────────────────────

function detectTwap(trades: LitTrade[], windowMs: number, minUsd: number, minTrades: number): TwapAlert[] {
  const cutoff = Date.now() - windowMs
  const byBuyer = new Map<number, { total_usd: number; count: number; max_usd: number; first_ts: number; last_ts: number; tsList: number[] }>()
  for (const t of trades) {
    if (t.taker_is_buyer !== 1 || t.ts < cutoff) continue
    if (!byBuyer.has(t.buyer_id)) byBuyer.set(t.buyer_id, { total_usd: 0, count: 0, max_usd: 0, first_ts: t.ts, last_ts: t.ts, tsList: [] })
    const acc = byBuyer.get(t.buyer_id)!
    acc.total_usd += t.usd; acc.count++; acc.max_usd = Math.max(acc.max_usd, t.usd)
    acc.first_ts = Math.min(acc.first_ts, t.ts); acc.last_ts = Math.max(acc.last_ts, t.ts)
    acc.tsList.push(t.ts)
  }
  const out: TwapAlert[] = []
  for (const [id, acc] of byBuyer) {
    if (acc.total_usd < minUsd || acc.count < minTrades) continue
    acc.tsList.sort((a, b) => a - b)
    const gaps = acc.tsList.slice(1).map((ts, i) => ts - acc.tsList[i])
    const avgSpacingMs = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0
    out.push({ side: 'BUY', account_id: id, ...acc, avgSpacingMs })
  }
  return out.sort((a, b) => b.total_usd - a.total_usd)
}

function detectTwapSells(trades: LitTrade[], windowMs: number, minUsd: number, minTrades: number): TwapAlert[] {
  const cutoff = Date.now() - windowMs
  const bySeller = new Map<number, { total_usd: number; count: number; max_usd: number; first_ts: number; last_ts: number; tsList: number[] }>()
  for (const t of trades) {
    if (t.taker_is_buyer !== 0 || t.ts < cutoff) continue
    if (!bySeller.has(t.seller_id)) bySeller.set(t.seller_id, { total_usd: 0, count: 0, max_usd: 0, first_ts: t.ts, last_ts: t.ts, tsList: [] })
    const acc = bySeller.get(t.seller_id)!
    acc.total_usd += t.usd; acc.count++; acc.max_usd = Math.max(acc.max_usd, t.usd)
    acc.first_ts = Math.min(acc.first_ts, t.ts); acc.last_ts = Math.max(acc.last_ts, t.ts)
    acc.tsList.push(t.ts)
  }
  const out: TwapAlert[] = []
  for (const [id, acc] of bySeller) {
    if (acc.total_usd < minUsd || acc.count < minTrades) continue
    acc.tsList.sort((a, b) => a - b)
    const gaps = acc.tsList.slice(1).map((ts, i) => ts - acc.tsList[i])
    const avgSpacingMs = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0
    out.push({ side: 'SELL', account_id: id, ...acc, avgSpacingMs })
  }
  return out.sort((a, b) => b.total_usd - a.total_usd)
}

// ── candle SVG ─────────────────────────────────────────────────

function buildCandleSvg(rawCandles: any[]): string {
  const W = 800, H = 200, VH = 36, OIH = 50
  const pad = { t: 8, r: 56, b: 4, l: 4 }
  const cW = W - pad.l - pad.r, cH = H - pad.t - pad.b
  if (!rawCandles.length) return `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:11px">no candle data</text>`
  const data = rawCandles.map((c: any) => ({
    t: Number(c.t || c.open_time || c.time || c.timestamp || 0),
    o: parseFloat(c.o ?? c.open ?? 0), h: parseFloat(c.h ?? c.high ?? 0),
    l: parseFloat(c.l ?? c.low ?? 0), c: parseFloat(c.c ?? c.close ?? 0),
    v: parseFloat(c.base_volume ?? c.quote_volume ?? c.volume ?? c.v ?? 0),
    oi: parseFloat(c.i ?? 0),
  })).filter(c => c.o > 0).sort((a, b) => a.t - b.t)
  if (data.length < 2) return `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:11px">waiting for data…</text>`
  const prices = data.flatMap(c => [c.h, c.l]).filter(p => p > 0)
  const yMin = Math.min(...prices), yMax = Math.max(...prices)
  const yRange = yMax - yMin || yMin * 0.01
  const py = (p: number) => pad.t + ((yMax - p) / yRange) * cH
  const n = data.length, slotW = cW / n, bodyW = Math.max(1, slotW * 0.6)
  // axis lines
  let out = [0,1,2,3,4].map(i => {
    const p = yMin + yRange * (i / 4), y = py(p).toFixed(1)
    return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/>` +
      `<text x="${W - pad.r + 4}" y="${(parseFloat(y) + 3).toFixed(1)}" fill="var(--ink-faint)" font-size="9" font-family="monospace">$${p.toFixed(4)}</text>`
  }).join('')
  // candles
  data.forEach((c, i) => {
    const cx = (pad.l + (i + 0.5) * slotW).toFixed(1)
    const isBull = c.c >= c.o, col = isBull ? 'var(--green)' : 'var(--red)'
    const bTop = py(Math.max(c.o, c.c)).toFixed(1), bBot = py(Math.min(c.o, c.c)).toFixed(1)
    const bH = Math.max(1, parseFloat(bBot) - parseFloat(bTop)).toFixed(1)
    out += `<line x1="${cx}" x2="${cx}" y1="${py(c.h).toFixed(1)}" y2="${py(c.l).toFixed(1)}" stroke="${col}" stroke-width="1" opacity="0.7"/>`
    out += `<rect x="${(parseFloat(cx) - bodyW/2).toFixed(1)}" y="${bTop}" width="${bodyW.toFixed(1)}" height="${bH}" fill="${col}" opacity="0.85" rx="0.5"/>`
  })
  // volume bars (separate SVG, rendered after)
  let volSvg = ''
  const maxV = Math.max(...data.map(c => c.v)) || 1
  data.forEach((c, i) => {
    const x = (pad.l + i * slotW).toFixed(1), bh = (c.v / maxV * VH).toFixed(1)
    const col = c.c >= c.o ? 'rgba(111,224,137,0.5)' : 'rgba(255,106,119,0.5)'
    volSvg += `<rect x="${x}" y="${(VH - parseFloat(bh)).toFixed(1)}" width="${(slotW - 0.5).toFixed(1)}" height="${bh}" fill="${col}"/>`
  })
  // time axis labels
  const step = Math.max(1, Math.floor(n / 5))
  for (let i = 0; i < n; i += step) {
    const c = data[i], x = (pad.l + (i + 0.5) * slotW).toFixed(1)
    const ts = c.t > 1e12 ? c.t : c.t * 1000
    const lbl = new Date(ts).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    out += `<text x="${x}" y="${H - 2}" text-anchor="middle" fill="var(--ink-faint)" font-size="9" font-family="monospace">${lbl}</text>`
  }
  // OI chart — oi field is in LIT tokens; multiply by close for USD value
  let oiSvg = ''
  const oiUsd = data.map(c => c.oi * c.c)
  const maxOi = Math.max(...oiUsd) || 1
  if (oiUsd.some(v => v > 0)) {
    const pts = oiUsd.map((v, i) => {
      const x = (pad.l + (i + 0.5) * slotW).toFixed(1)
      const y = (OIH - 4 - (v / maxOi) * (OIH - 8)).toFixed(1)
      return `${x},${y}`
    }).join(' ')
    const x0 = (pad.l + 0.5 * slotW).toFixed(1), xN = (pad.l + (n - 0.5) * slotW).toFixed(1)
    oiSvg += `<polygon points="${x0},${OIH} ${pts} ${xN},${OIH}" fill="rgba(100,160,255,0.15)"/>`
    oiSvg += `<polyline points="${pts}" fill="none" stroke="var(--blue)" stroke-width="1.5" opacity="0.8"/>`
    const cur = oiUsd[oiUsd.length - 1] ?? 0
    const prev = oiUsd[0] ?? 0
    const chgPct = prev > 0 ? ((cur - prev) / prev * 100) : 0
    const oiLbl = cur >= 1e6 ? `$${(cur / 1e6).toFixed(2)}M` : cur >= 1e3 ? `$${(cur / 1e3).toFixed(1)}K` : `$${cur.toFixed(0)}`
    const chgSign = chgPct >= 0 ? '+' : ''
    oiSvg += `<text x="${W - pad.r + 4}" y="14" fill="var(--blue)" font-size="9" font-family="monospace">${oiLbl}</text>`
    oiSvg += `<text x="${W - pad.r + 4}" y="26" fill="${chgPct >= 0 ? 'var(--green)' : 'var(--red)'}" font-size="9" font-family="monospace">${chgSign}${chgPct.toFixed(1)}%</text>`
  }
  return `__CANDLE__${out}__VOL__${volSvg}__OI__${oiSvg}`
}

// ── order book heatmap (canvas) ─────────────────────────────────

const HM_SNAPSHOTS = 100
const HM_LEVELS = 60
const HM_RANGE = 0.06

type ObSnap = { bids: { price: number; size: number }[]; asks: { price: number; size: number }[]; ts: number }

function normBook(raw: any): { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } {
  const norm = (arr: any[]) => (arr || []).map((l: any) => ({
    price: parseFloat(l.price || l.p || 0),
    size: parseFloat(l.base_amount || l.quantity || l.size || l.s || l.amount || 0),
  })).filter((l: any) => l.price > 0 && l.size > 0)
  return { bids: norm(raw.bid_book || raw.bids || []), asks: norm(raw.ask_book || raw.asks || []) }
}

function bucketize(levels: { price: number; size: number }[], minP: number, maxP: number, n: number): Float32Array {
  const step = (maxP - minP) / n
  const out = new Float32Array(n)
  for (const l of levels) {
    if (l.price <= minP || l.price >= maxP) continue
    const idx = Math.min(n - 1, Math.floor((l.price - minP) / step))
    out[idx] += l.size
  }
  return out
}

function drawHeatmap(canvas: HTMLCanvasElement, history: ObSnap[], mid: number) {
  const dpr = window.devicePixelRatio || 1
  const W = canvas.offsetWidth, H = canvas.offsetHeight
  if (!W || !H) return
  canvas.width = W * dpr; canvas.height = H * dpr
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)
  const cs = getComputedStyle(document.documentElement)
  const bg = cs.getPropertyValue('--bg').trim() || '#0e1117'
  const dim = cs.getPropertyValue('--ink-faint').trim() || '#555'
  const lineCol = cs.getPropertyValue('--line').trim() || '#1e2028'
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H)
  if (!history.length || !mid) {
    ctx.fillStyle = dim; ctx.font = '11px monospace'; ctx.textAlign = 'center'
    ctx.fillText('waiting for order book data…', W / 2, H / 2); return
  }
  const AXIS_W = 54, chartW = W - AXIS_W
  const minP = mid * (1 - HM_RANGE), maxP = mid * (1 + HM_RANGE)
  const rowH = H / HM_LEVELS, colW = chartW / HM_SNAPSHOTS
  let gMax = 0
  const cols = history.map(snap => {
    const bidB = bucketize(snap.bids, minP, maxP, HM_LEVELS)
    const askB = bucketize(snap.asks, minP, maxP, HM_LEVELS)
    for (let i = 0; i < HM_LEVELS; i++) { if (bidB[i] > gMax) gMax = bidB[i]; if (askB[i] > gMax) gMax = askB[i] }
    return { bidB, askB }
  })
  const logMax = gMax > 0 ? Math.log1p(gMax) : 1
  const offset = HM_SNAPSHOTS - cols.length
  cols.forEach((col, i) => {
    const x = (offset + i) * colW
    for (let b = 0; b < HM_LEVELS; b++) {
      const y = H - (b + 1) * rowH
      if (col.bidB[b] > 0) {
        ctx.fillStyle = `rgba(111,224,137,${(Math.log1p(col.bidB[b]) / logMax * 0.9).toFixed(3)})`
        ctx.fillRect(x, y, colW + 0.5, rowH + 0.5)
      }
      if (col.askB[b] > 0) {
        ctx.fillStyle = `rgba(255,90,90,${(Math.log1p(col.askB[b]) / logMax * 0.9).toFixed(3)})`
        ctx.fillRect(x, y, colW + 0.5, rowH + 0.5)
      }
    }
  })
  const midY = H - ((mid - minP) / (maxP - minP)) * H
  ctx.beginPath(); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1
  ctx.setLineDash([4, 4]); ctx.moveTo(0, midY); ctx.lineTo(chartW, midY); ctx.stroke(); ctx.setLineDash([])
  ctx.fillStyle = dim; ctx.font = '9px monospace'; ctx.textAlign = 'left'
  for (let i = 0; i <= 5; i++) {
    const price = minP + (maxP - minP) * (i / 5), y = H - (i / 5) * H
    ctx.fillStyle = lineCol; ctx.fillRect(chartW, y - 0.5, AXIS_W, 1)
    ctx.fillStyle = dim; ctx.fillText('$' + price.toFixed(4), chartW + 4, y + 3)
  }
}

// ── CVD SVG ──────────────────────────────────────────────────────

function buildCvdSvg(trades: LitTrade[]): string {
  if (trades.length < 2) return '<text x="300" y="36" text-anchor="middle" fill="var(--ink-faint)" style="font-size:11px">collecting trades…</text>'
  const sorted = [...trades].sort((a, b) => a.ts - b.ts)
  let cvd = 0
  const series = sorted.map(t => { cvd += t.taker_is_buyer === 1 ? t.usd : -t.usd; return { ts: t.ts, cvd } })
  const W = 600, H = 72
  const minCvd = Math.min(...series.map(p => p.cvd))
  const maxCvd = Math.max(...series.map(p => p.cvd))
  const range = maxCvd - minCvd || 1
  const minTs = series[0].ts, spanMs = (series[series.length - 1].ts - minTs) || 1
  const px = (ts: number) => ((ts - minTs) / spanMs * W).toFixed(1)
  const py = (v: number) => (H - ((v - minCvd) / range * H)).toFixed(1)
  const zeroY = py(Math.max(minCvd, Math.min(maxCvd, 0)))
  const pts = series.map(p => `${px(p.ts)},${py(p.cvd)}`).join(' ')
  const lastCvd = series[series.length - 1].cvd
  const lineColor = lastCvd >= 0 ? 'var(--green)' : 'var(--red)'
  const fillPts = `0,${zeroY} ${pts} ${px(series[series.length-1].ts)},${zeroY}`
  const fillColor = lastCvd >= 0 ? 'rgba(111,224,137,0.08)' : 'rgba(255,90,90,0.08)'
  return `<polygon points="${fillPts}" fill="${fillColor}"/>` +
    `<line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="var(--line-2)" stroke-width="1" stroke-dasharray="3,3"/>` +
    `<polyline points="${pts}" fill="none" stroke="${lineColor}" stroke-width="1.5"/>`
}

// ── tracked wallets storage ─────────────────────────────────────

const TW_KEY = 'lit_tracked_v1'
type TrackedWallet = { account_id: number; label: string; address?: string; added_at: number }

// ── main component ──────────────────────────────────────────────

export default function LitTracker() {
  const [summary, setSummary] = useState<LitSummary | null>(null)
  const [trades, setTrades] = useState<LitTrade[]>([])
  const [flow, setFlow] = useState<LitFlow | null>(null)
  const [leaders, setLeaders] = useState<Leaders | null>(null)
  const [funding, setFunding] = useState<Record<string, number>>({})
  const [stakingStats, setStakingStats] = useState<StakingStats | null>(null)
  const [stakingActivity, setStakingActivity] = useState<{ events: any[]; accounts_scanned: number } | null>(null)
  const [buybacks, setBuybacks] = useState<{ stats: any[]; balances: any } | null>(null)
  const [buybackPeriod, setBuybackPeriod] = useState(7)
  const [candles, setCandles] = useState<any[]>([])
  const [chartRes, setChartRes] = useState('1h')

  const [market, setMarket] = useState('')   // '' = all, '120' = perp, '2049' = spot
  const [hours, setHours] = useState(24)
  const [refreshMs, setRefreshMs] = useState(10000)
  const [whaleMin, setWhaleMin] = useState(100000)
  const [twapWindowMs, setTwapWindowMs] = useState(600000)
  const [twapMinTrades, setTwapMinTrades] = useState(3)

  const [status, setStatus] = useState<'ok' | 'warn' | 'err'>('warn')
  const [lastSync, setLastSync] = useState('—')
  const [pollCount, setPollCount] = useState(0)

  const [expandedLeader, setExpandedLeader] = useState<{ id: number; role: 'buyer' | 'seller'; trades: any[] | null; loading: boolean } | null>(null)

  const [trackedWallets, setTrackedWallets] = useState<TrackedWallet[]>([])
  const [trackedFlows, setTrackedFlows] = useState<Record<number, any>>({})
  const [trackAddInput, setTrackAddInput] = useState('')

  const hmHistoryRef = useRef<ObSnap[]>([])
  const hmMidRef = useRef<number>(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const obTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const mainTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const candleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const slowTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── tracked wallets persistence ──
  useEffect(() => {
    try { setTrackedWallets(JSON.parse(localStorage.getItem(TW_KEY) || '[]')) } catch {}
  }, [])

  const saveTracked = (list: TrackedWallet[]) => {
    setTrackedWallets(list)
    try { localStorage.setItem(TW_KEY, JSON.stringify(list)) } catch {}
  }

  const addTracked = (id: number) => {
    setTrackedWallets(prev => {
      if (prev.find(w => w.account_id === id)) return prev
      const next = [...prev, { account_id: id, label: '', added_at: Date.now() }]
      try { localStorage.setItem(TW_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }
  const removeTracked = (id: number) => saveTracked(trackedWallets.filter(w => w.account_id !== id))
  const labelTracked = (id: number, label: string) => {
    const next = trackedWallets.map(w => w.account_id === id ? { ...w, label } : w)
    saveTracked(next)
  }

  // ── main poll ──
  const poll = useCallback(async () => {
    setStatus('warn')
    try {
      const mq = market ? `&market_id=${market}` : ''
      const [sumRes, tradesRes, flowRes, leadersRes] = await Promise.all([
        fetch('/api/lighter/lit/summary').then(r => r.json()),
        fetch(`/api/lighter/lit/trades?limit=500${mq}`).then(r => r.json()),
        fetch(`/api/lighter/lit/flow?hours=${hours}${mq}`).then(r => r.json()),
        fetch(`/api/lighter/lit/leaders?hours=${hours}&top_n=15${mq}`).then(r => r.json()),
      ])
      setSummary(sumRes)
      setTrades(tradesRes.trades ?? [])
      setFlow(flowRes)
      setLeaders(leadersRes)
      setLastSync(new Date().toLocaleTimeString('en-GB', { hour12: false }))
      setPollCount(n => n + 1)
      setStatus('ok')
    } catch (e: any) {
      setStatus('err')
      console.error(e)
    }
  }, [market, hours])

  // ── candle poll ──
  const pollCandles = useCallback(async () => {
    try {
      const mq = market === '2049' ? '&market_id=2049' : '&market_id=120'
      const res = await fetch(`/api/lighter/lit/candles?resolution=${chartRes}&count=100${mq}`)
      const j = await res.json()
      setCandles(j.candles ?? [])
    } catch {}
  }, [chartRes, market])

  // ── slow polls (funding, staking) ──
  const pollSlow = useCallback(async () => {
    try {
      const [fRes, sRes, saRes, bbRes] = await Promise.all([
        fetch('/api/lighter/lit/funding').then(r => r.json()),
        fetch('/api/lighter/lit/staking-stats').then(r => r.json()),
        fetch('/api/lighter/lit/staking-activity').then(r => r.json()),
        fetch('/api/lighter/lit/buybacks').then(r => r.json()),
      ])
      setFunding(fRes.by_exchange ?? {})
      setStakingStats(sRes)
      setStakingActivity(saRes)
      setBuybacks(bbRes)
    } catch {}
  }, [])

  // ── order book poll ──
  const pollOrderbook = useCallback(async () => {
    try {
      const mid = market === '2049' ? '2049' : '120'
      const res = await fetch(`/api/lighter/lit/orderbook?market_id=${mid}`)
      const data = await res.json()
      const { bids, asks } = normBook(data)
      const bestBid = data.best_bid_price ? parseFloat(data.best_bid_price) : bids.reduce((m: number, l: { price: number }) => l.price > m ? l.price : m, 0)
      const bestAsk = data.best_ask_price ? parseFloat(data.best_ask_price) : asks.reduce((m: number, l: { price: number }) => l.price < m ? l.price : m, Infinity)
      if (bestBid && isFinite(bestAsk)) hmMidRef.current = (bestBid + bestAsk) / 2
      else if (bestBid) hmMidRef.current = bestBid
      if (bids.length || asks.length) {
        hmHistoryRef.current.push({ bids, asks, ts: data.ts || Date.now() })
        if (hmHistoryRef.current.length > HM_SNAPSHOTS) hmHistoryRef.current.shift()
      }
      if (canvasRef.current) drawHeatmap(canvasRef.current, hmHistoryRef.current, hmMidRef.current)
    } catch {}
  }, [market])

  // ── refresh tracked wallets ──
  const refreshTracked = useCallback(async () => {
    if (!trackedWallets.length) return
    const results = await Promise.allSettled(
      trackedWallets.map(w => {
        const params = new URLSearchParams({ account_id: String(w.account_id) })
        if (w.address) params.set('address', w.address)
        return fetch(`/api/lighter/lit/account-flow-live?${params}`).then(r => r.json())
          .then(d => ({ id: w.account_id, data: d }))
      })
    )
    setTrackedFlows(prev => {
      const next = { ...prev }
      for (const r of results) {
        if (r.status === 'fulfilled') next[r.value.id] = r.value.data
      }
      return next
    })
  }, [trackedWallets])

  // ── timers ──
  useEffect(() => {
    poll()
    pollSlow()
    pollOrderbook()
    pollCandles()
    if (mainTimerRef.current) clearInterval(mainTimerRef.current)
    if (refreshMs > 0) mainTimerRef.current = setInterval(poll, refreshMs)
    return () => { if (mainTimerRef.current) clearInterval(mainTimerRef.current) }
  }, [poll, pollSlow, pollCandles, pollOrderbook, refreshMs])

  useEffect(() => {
    if (obTimerRef.current) clearInterval(obTimerRef.current)
    obTimerRef.current = setInterval(pollOrderbook, 3000)
    return () => { if (obTimerRef.current) clearInterval(obTimerRef.current) }
  }, [pollOrderbook])

  useEffect(() => {
    if (candleTimerRef.current) clearInterval(candleTimerRef.current)
    candleTimerRef.current = setInterval(pollCandles, 60000)
    return () => { if (candleTimerRef.current) clearInterval(candleTimerRef.current) }
  }, [pollCandles])

  useEffect(() => {
    if (slowTimerRef.current) clearInterval(slowTimerRef.current)
    slowTimerRef.current = setInterval(pollSlow, 120000)
    return () => { if (slowTimerRef.current) clearInterval(slowTimerRef.current) }
  }, [pollSlow])

  useEffect(() => {
    const t = setInterval(refreshTracked, 120000)
    return () => clearInterval(t)
  }, [refreshTracked])

  useEffect(() => {
    const h = () => { if (canvasRef.current && hmHistoryRef.current.length) drawHeatmap(canvasRef.current, hmHistoryRef.current, hmMidRef.current) }
    window.addEventListener('resize', h)
    return () => window.removeEventListener('resize', h)
  }, [])

  // ── TWAP detection from trades ──
  const twapBuys = detectTwap(trades, twapWindowMs, whaleMin, twapMinTrades)
  const twapSells = detectTwapSells(trades, twapWindowMs, whaleMin, twapMinTrades)
  const twapBuyerIds = new Set(twapBuys.map(a => a.account_id))
  const twapSellerIds = new Set(twapSells.map(a => a.account_id))

  // ── leader expand ──
  const toggleLeader = async (id: number, role: 'buyer' | 'seller') => {
    if (expandedLeader?.id === id && expandedLeader?.role === role) {
      setExpandedLeader(null); return
    }
    setExpandedLeader({ id, role, trades: null, loading: true })
    try {
      const mq = market ? `&market_id=${market}` : ''
      const res = await fetch(`/api/lighter/lit/account-flow-live?account_id=${id}${mq}`)
      const j = await res.json()
      const allTrades: any[] = []
      for (const w of ['24h', '7d', '30d']) {
        const wData = j[w]
        if (wData) allTrades.push({ window: w, ...wData })
      }
      setExpandedLeader({ id, role, trades: allTrades, loading: false })
    } catch {
      setExpandedLeader({ id, role, trades: [], loading: false })
    }
  }

  // ── candle parse for header label ──
  const lastCandle = candles.length ? candles[candles.length - 1] : null
  const lastClose = lastCandle ? parseFloat(lastCandle.c ?? lastCandle.close ?? 0) : 0
  const prevCandle = candles.length > 1 ? candles[candles.length - 2] : null
  const prevClose = prevCandle ? parseFloat(prevCandle.c ?? prevCandle.close ?? 0) : 0
  const candleChg = prevClose > 0 ? ((lastClose - prevClose) / prevClose * 100) : null

  const svgResult = buildCandleSvg(candles)
  const candleParts = svgResult.split('__VOL__')
  const candleSvgBody = candleParts[0].replace('__CANDLE__', '')
  const [volSvgBody, oiSvgBody] = (candleParts[1] ?? '').split('__OI__')

  // ── flow data ──
  const perpFlow = summary?.perp_flow ?? { buy_usd: 0, sell_usd: 0, delta_usd: 0 }
  const spotFlow = summary?.spot_flow ?? { buy_usd: 0, sell_usd: 0, delta_usd: 0 }
  const flowBuy = flow?.buy_usd ?? 0
  const flowSell = flow?.sell_usd ?? 0
  const flowDelta = flow?.delta_usd ?? 0
  const flowTotal = flowBuy + flowSell || 1
  const pctBuy = (flowBuy / flowTotal * 100)
  const actualHoursMs = flow?.oldest_ts ? Date.now() - flow.oldest_ts : 0
  const actualHours = actualHoursMs / 3_600_000
  const insufficient = actualHours > 0 && actualHours < hours * 0.95

  // ── funding grid ──
  const EXCHANGE_DISPLAY: Record<string, string> = {
    lighter: 'Lighter', binance: 'Binance', bybit: 'Bybit',
    hyperliquid: 'HyperLiquid', okx: 'OKX', gate: 'Gate', deribit: 'Deribit',
  }
  const fundingOrder = ['lighter', 'binance', 'bybit', 'hyperliquid', 'okx', 'gate', 'deribit']
  const fundingRates = Object.entries(funding)
    .map(([key, rate]) => ({ key, exchange: EXCHANGE_DISPLAY[key] || key, rate }))
    .sort((a, b) => (fundingOrder.indexOf(a.key) + 10) - (fundingOrder.indexOf(b.key) + 10))
  const lighterRate = fundingRates.find(r => r.key === 'lighter')?.rate ?? fundingRates[0]?.rate ?? 0

  const cvdSvg = buildCvdSvg(trades)

  // ── period label ──
  const periodLabel = hours === 24 ? '24h' : hours === 168 ? '7d' : hours === 720 ? '30d' : hours + 'h'

  return (
    <div>
      {/* controls bar */}
      <div style={{ display: 'flex', gap: 8, padding: '10px 24px', borderBottom: '1px solid var(--line)', background: 'var(--paper-2)', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--ink-faint)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Market</span>
        {[['', 'All'], ['120', 'Perp'], ['2049', 'Spot']].map(([val, lbl]) => (
          <button key={val} className={`ch${market === val ? ' on' : ''}`}
            onClick={() => { setMarket(val); hmHistoryRef.current = [] }}
            style={{ padding: '4px 12px', fontSize: 12 }}>{lbl}</button>
        ))}
        <div style={{ width: 1, height: 20, background: 'var(--line)', margin: '0 4px' }} />
        <span style={{ fontSize: 11, color: 'var(--ink-faint)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Period</span>
        {[[24, '24h'], [168, '7d'], [720, '30d']].map(([val, lbl]) => (
          <button key={val} className={`ch${hours === val ? ' on' : ''}`}
            onClick={() => setHours(Number(val))}
            style={{ padding: '4px 12px', fontSize: 12 }}>{lbl}</button>
        ))}
        <div style={{ width: 1, height: 20, background: 'var(--line)', margin: '0 4px' }} />
        <span style={{ fontSize: 11, color: 'var(--ink-faint)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Refresh</span>
        {([[5, '5s'], [10, '10s'], [30, '30s'], [0, 'Pause']] as [number, string][]).map(([val, lbl]) => (
          <button key={val} className={`ch${refreshMs === val * 1000 ? ' on' : ''}`}
            onClick={() => setRefreshMs(Number(val) * 1000)}
            style={{ padding: '4px 12px', fontSize: 12 }}>{lbl}</button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className={`status-dot${status === 'err' ? ' err' : status === 'warn' ? ' warn' : ''}`} />
          <span style={{ fontSize: 10, color: 'var(--ink-faint)', fontVariantNumeric: 'tabular-nums' }}>{lastSync}</span>
        </div>
      </div>

      {/* KPI strip */}
      <div className="cockpit-kpis">
        <div className="cockpit-kpi">
          <div className="lbl">LIT Perp</div>
          <div className={`val ${summary?.perp && summary.perp.price_change >= 0 ? 'up' : 'down'}`}>{fmtPrice(summary?.perp?.last_price)}</div>
          <div className="sub">{summary?.perp ? fmtPct(summary.perp.price_change) + ' 24h' : '—'}</div>
        </div>
        <div className="cockpit-kpi">
          <div className="lbl">LIT Spot</div>
          <div className={`val ${summary?.spot && summary.spot.price_change >= 0 ? 'up' : 'down'}`}>{fmtPrice(summary?.spot?.last_price)}</div>
          <div className="sub">{summary?.spot ? fmtPct(summary.spot.price_change) + ' 24h' : '—'}</div>
        </div>
        <div className="cockpit-kpi">
          <div className="lbl">Funding Rate</div>
          <div className={`val ${summary?.perp?.funding != null ? (summary.perp.funding >= 0 ? 'up' : 'down') : ''}`}>
            {summary?.perp?.funding != null ? (summary.perp.funding * 100).toFixed(4) + '%' : '—'}
          </div>
          <div className="sub">{summary?.perp?.funding != null ? (summary.perp.funding * 3 * 365 * 100).toFixed(1) + '% APR' : '—'}</div>
        </div>
        <div className="cockpit-kpi">
          <div className="lbl">Perp Vol 24h</div>
          <div className="val">{fmtUsd(summary?.perp?.volume_24h)}</div>
          <div className="sub">{summary?.perp ? summary.perp.trades_24h?.toLocaleString() + ' trades' : '—'}</div>
        </div>
        <div className="cockpit-kpi">
          <div className="lbl">Buy Flow · {periodLabel}</div>
          <div className="val up">{fmtUsd(flowBuy)}</div>
          <div className="sub">{fmtNum(flow?.trade_count, 0)} trades</div>
        </div>
        <div className="cockpit-kpi">
          <div className="lbl">Net Flow · {periodLabel}</div>
          <div className={`val ${flowDelta >= 0 ? 'up' : 'down'}`}>{fmtUsd(flowDelta)}</div>
          <div className="sub">{insufficient ? `⚠ only ${fmtDuration(actualHoursMs)}` : fmtDuration(actualHoursMs) + ' data'}</div>
        </div>
      </div>

      {/* main grid — 2 col */}
      <div className="cockpit-grid" style={{ marginBottom: 1 }}>
        {/* trades table */}
        <div className="panel" style={{ padding: 0 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Live Trades</div>
            <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{trades.length} loaded</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={whaleMin} onChange={e => setWhaleMin(Number(e.target.value))}
                style={{ background: 'var(--paper)', border: '1px solid var(--line)', color: 'var(--ink)', padding: '3px 8px', fontSize: 11, borderRadius: 4 }}>
                <option value={10000}>Whale ≥ $10K</option>
                <option value={50000}>≥ $50K</option>
                <option value={100000}>≥ $100K</option>
                <option value={500000}>≥ $500K</option>
              </select>
              <select value={twapWindowMs} onChange={e => setTwapWindowMs(Number(e.target.value))}
                style={{ background: 'var(--paper)', border: '1px solid var(--line)', color: 'var(--ink)', padding: '3px 8px', fontSize: 11, borderRadius: 4 }}>
                <option value={300000}>TWAP 5m</option>
                <option value={600000}>TWAP 10m</option>
                <option value={1800000}>TWAP 30m</option>
                <option value={3600000}>TWAP 1h</option>
              </select>
              <select value={twapMinTrades} onChange={e => setTwapMinTrades(Number(e.target.value))}
                style={{ background: 'var(--paper)', border: '1px solid var(--line)', color: 'var(--ink)', padding: '3px 8px', fontSize: 11, borderRadius: 4 }}>
                <option value={3}>min 3 trades</option>
                <option value={5}>min 5 trades</option>
                <option value={10}>min 10 trades</option>
              </select>
            </div>
          </div>
          <div className="table-scroll-x" style={{ maxHeight: 400, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ position: 'sticky', top: 0, background: 'var(--paper)', zIndex: 1 }}>
                  {['Time', 'Mkt', 'Side', 'Price', 'Size', 'USD', 'Buyer', 'Seller'].map(h => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: h === 'Time' || h === 'Side' || h === 'Mkt' ? 'left' : 'right', fontWeight: 500, fontSize: 11, color: 'var(--ink-dim)', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trades.slice(0, 100).map((t, idx) => {
                  const isBuy = t.taker_is_buyer === 1
                  const mkt = t.market_id === 120 ? 'PERP' : 'SPOT'
                  const bigBuy = isBuy && t.usd >= whaleMin
                  const bigSell = !isBuy && t.usd >= whaleMin
                  const mega = isBuy && t.usd >= 1_000_000
                  const megaSell = !isBuy && t.usd >= 1_000_000
                  const isTwap = isBuy && twapBuyerIds.has(t.buyer_id)
                  const isTwapSell = !isBuy && twapSellerIds.has(t.seller_id)
                  const rowBg = isTwap ? 'rgba(242,193,78,0.06)' : bigBuy ? 'rgba(111,224,137,0.07)' : isTwapSell ? 'rgba(255,90,90,0.06)' : bigSell ? 'rgba(255,90,90,0.05)' : ''
                  const rowBorder = isTwap ? 'inset 3px 0 0 var(--amber)' : bigBuy ? 'inset 3px 0 0 var(--green)' : bigSell || isTwapSell ? 'inset 3px 0 0 var(--red)' : ''
                  return (
                    <tr key={idx} style={{ background: rowBg, boxShadow: rowBorder, borderBottom: '1px solid var(--line)' }}>
                      <td style={{ padding: '6px 10px', color: 'var(--ink-dim)', whiteSpace: 'nowrap' }}>{fmtTime(t.ts)}</td>
                      <td style={{ padding: '6px 10px', color: 'var(--ink-faint)', fontSize: 10, letterSpacing: '0.06em' }}>{mkt}</td>
                      <td style={{ padding: '6px 10px' }}>
                        <span className={isBuy ? 'pos' : 'neg'} style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', background: isBuy ? 'rgba(111,224,137,0.1)' : 'rgba(255,90,90,0.1)', borderRadius: 3 }}>
                          {isBuy ? 'BUY' : 'SELL'}
                        </span>
                        {mega && <span style={{ marginLeft: 4, fontSize: 9, background: 'rgba(111,224,137,0.2)', color: 'var(--green)', padding: '1px 5px', borderRadius: 2 }}>MEGA</span>}
                        {!mega && bigBuy && <span style={{ marginLeft: 4, fontSize: 9, background: 'rgba(111,224,137,0.15)', color: 'var(--green)', padding: '1px 5px', borderRadius: 2 }}>BIG</span>}
                        {isTwap && <span style={{ marginLeft: 4, fontSize: 9, background: 'rgba(242,193,78,0.2)', color: 'var(--amber)', padding: '1px 5px', borderRadius: 2 }}>TWAP</span>}
                        {megaSell && <span style={{ marginLeft: 4, fontSize: 9, background: 'rgba(255,90,90,0.2)', color: 'var(--red)', padding: '1px 5px', borderRadius: 2 }}>MEGA</span>}
                        {!megaSell && bigSell && <span style={{ marginLeft: 4, fontSize: 9, background: 'rgba(255,90,90,0.15)', color: 'var(--red)', padding: '1px 5px', borderRadius: 2 }}>BIG</span>}
                        {isTwapSell && <span style={{ marginLeft: 4, fontSize: 9, background: 'rgba(255,90,90,0.2)', color: 'var(--red)', padding: '1px 5px', borderRadius: 2 }}>TWAP</span>}
                      </td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtPrice(t.price)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(t.size)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: (bigBuy || bigSell) ? 700 : 400, color: bigBuy ? 'var(--green)' : bigSell ? 'var(--red)' : t.usd >= 10000 ? 'var(--ink)' : 'var(--ink-dim)' }}>{fmtUsd(t.usd)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--blue)', fontSize: 11 }}>{fmtAcct(t.buyer_id)}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--blue)', fontSize: 11 }}>{fmtAcct(t.seller_id)}</td>
                    </tr>
                  )
                })}
                {!trades.length && (
                  <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center', color: 'var(--ink-faint)', fontSize: 12 }}>no trades loaded</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* flow + CVD */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="panel" style={{ padding: '16px' }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>
              Flow · {periodLabel}{market === '120' ? ' · Perp' : market === '2049' ? ' · Spot' : ''}
            </div>
            {insufficient && (
              <div style={{ color: 'var(--amber)', fontSize: 11, marginBottom: 8 }}>
                ⚠ only {fmtDuration(actualHoursMs)} collected
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 13 }}>
              <div><span style={{ color: 'var(--ink-faint)', fontSize: 11 }}>Buy</span><br /><span className="pos" style={{ fontWeight: 600 }}>{fmtUsd(flowBuy)}</span></div>
              <div style={{ textAlign: 'right' }}><span style={{ color: 'var(--ink-faint)', fontSize: 11 }}>Sell</span><br /><span className="neg" style={{ fontWeight: 600 }}>{fmtUsd(flowSell)}</span></div>
            </div>
            <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', background: 'var(--line-2)', marginBottom: 6 }}>
              <div style={{ width: pctBuy + '%', background: 'var(--green)', transition: 'width 0.3s' }} />
              <div style={{ flex: 1, background: 'var(--red)' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--ink-dim)', marginBottom: 12 }}>
              <span>{pctBuy.toFixed(1)}% buy</span>
              <span>{(100 - pctBuy).toFixed(1)}% sell</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>Net</span>
              <span className={flowDelta >= 0 ? 'pos' : 'neg'} style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtUsd(flowDelta)}</span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 4, textAlign: 'right' }}>{fmtNum(flow?.trade_count, 0)} trades</div>
          </div>

          <div className="panel" style={{ padding: '14px 16px' }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>CVD · All LIT Trades</div>
            <svg viewBox="0 0 600 72" preserveAspectRatio="none" style={{ width: '100%', height: 72, display: 'block' }}
              dangerouslySetInnerHTML={{ __html: cvdSvg }} />
            <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 4 }}>{trades.length} trades loaded</div>
          </div>

          {/* perp stats */}
          <div className="panel" style={{ padding: '14px 16px' }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Perp Stats</div>
            {summary?.perp ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
                {[
                  ['24h High', fmtPrice(summary.perp.price_high_24h)],
                  ['24h Low', fmtPrice(summary.perp.price_low_24h)],
                  ['Volume', fmtUsd(summary.perp.volume_24h)],
                  ['Trades', summary.perp.trades_24h?.toLocaleString() ?? '—'],
                  ['Perp Buy', fmtUsd(perpFlow.buy_usd)],
                  ['Spot Buy', fmtUsd(spotFlow.buy_usd)],
                ].map(([lbl, val]) => (
                  <div key={lbl}>
                    <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>{lbl}</div>
                    <div style={{ fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{val}</div>
                  </div>
                ))}
              </div>
            ) : <div style={{ color: 'var(--ink-faint)', fontSize: 12 }}>loading…</div>}
          </div>
        </div>
      </div>

      {/* TWAP alerts */}
      <div className="panel" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>TWAP Detection</div>
          {twapBuys.length + twapSells.length > 0 && (
            <span style={{ fontSize: 11, color: 'var(--amber)' }}>{twapBuys.length + twapSells.length} active</span>
          )}
          <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>· {fmtDuration(twapWindowMs)} window · ≥ {fmtUsd(whaleMin)} · min {twapMinTrades} trades</span>
        </div>
        <div className="table-scroll-x">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--paper)' }}>
                {['Side', 'Account', 'Total', 'Trades', 'Avg', 'Max', 'First', 'Last', 'Spacing'].map(h => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: h === 'Side' || h === 'Account' ? 'left' : 'right', fontWeight: 500, fontSize: 11, color: 'var(--ink-dim)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...twapBuys, ...twapSells].sort((a, b) => b.total_usd - a.total_usd).map((a, idx) => {
                const isBuy = a.side === 'BUY'
                const avg = a.total_usd / a.count
                const spacingLbl = a.avgSpacingMs >= 60000 ? (a.avgSpacingMs / 60000).toFixed(1) + 'm' : Math.round(a.avgSpacingMs / 1000) + 's'
                const rowBg = isBuy ? 'rgba(111,224,137,0.05)' : 'rgba(255,90,90,0.05)'
                const rowBorder = isBuy ? 'inset 3px 0 0 var(--green)' : 'inset 3px 0 0 var(--red)'
                return (
                  <tr key={idx} style={{ background: rowBg, boxShadow: rowBorder, borderBottom: '1px solid var(--line)' }}>
                    <td style={{ padding: '6px 10px' }}>
                      <span className={isBuy ? 'pos' : 'neg'} style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', background: isBuy ? 'rgba(111,224,137,0.15)' : 'rgba(255,90,90,0.15)', borderRadius: 3 }}>
                        {a.side}
                      </span>
                    </td>
                    <td style={{ padding: '6px 10px', color: 'var(--blue)' }}>
                      {a.total_usd >= 1_000_000 && <span style={{ fontSize: 9, background: isBuy ? 'rgba(111,224,137,0.2)' : 'rgba(255,90,90,0.2)', color: isBuy ? 'var(--green)' : 'var(--red)', padding: '1px 5px', borderRadius: 2, marginRight: 4 }}>MEGA</span>}
                      {fmtAcct(a.account_id)}
                    </td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700 }} className={isBuy ? 'pos' : 'neg'}>{fmtUsd(a.total_usd)}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>{a.count}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--ink-dim)' }}>{fmtUsd(avg)}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--ink-dim)' }}>{fmtUsd(a.max_usd)}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--ink-faint)', fontSize: 11 }}>{fmtTime(a.first_ts)}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--ink-faint)', fontSize: 11 }}>{fmtTime(a.last_ts)}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--amber)' }}>{spacingLbl}</td>
                  </tr>
                )
              })}
              {twapBuys.length + twapSells.length === 0 && (
                <tr><td colSpan={9} style={{ padding: 20, textAlign: 'center', color: 'var(--ink-faint)', fontSize: 12 }}>no TWAP patterns detected in window</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* leaders */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        {(['buyer', 'seller'] as const).map(role => {
          const items = role === 'buyer' ? (leaders?.buyers ?? []) : (leaders?.sellers ?? [])
          const title = role === 'buyer' ? 'Top Buyers' : 'Top Sellers'
          const col = role === 'buyer' ? 'USD Bought' : 'USD Sold'
          return (
            <div key={role} className="panel" style={{ padding: 0 }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{title}</div>
                <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>· {periodLabel}{market ? (market === '120' ? ' · Perp' : ' · Spot') : ''}</span>
                {insufficient && <span style={{ fontSize: 10, color: 'var(--amber)', marginLeft: 4 }}>⚠ {fmtDuration(actualHoursMs)} data</span>}
              </div>
              <div className="table-scroll-x">
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--paper)' }}>
                      {['#', 'Account', col, 'Trades', 'Avg', 'First', 'Last'].map(h => (
                        <th key={h} style={{ padding: '7px 10px', textAlign: h === '#' || h === 'Account' ? 'left' : 'right', fontWeight: 500, fontSize: 11, color: 'var(--ink-dim)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => {
                      const avg = item.trade_count > 0 ? item.total_usd / item.trade_count : 0
                      const isExpanded = expandedLeader?.id === item.account_id && expandedLeader?.role === role
                      return (
                        <>
                          <tr key={item.account_id}
                            onClick={() => toggleLeader(item.account_id, role)}
                            style={{ cursor: 'pointer', borderBottom: '1px solid var(--line)', background: isExpanded ? 'rgba(100,100,255,0.04)' : '' }}>
                            <td style={{ padding: '7px 10px', color: 'var(--ink-faint)' }}>{i + 1}</td>
                            <td style={{ padding: '7px 10px', color: 'var(--blue)' }}>
                              {fmtAcct(item.account_id)}
                              <Link href={`/lighter/explorer?q=${item.account_id}`} target="_blank"
                                onClick={e => e.stopPropagation()}
                                style={{ color: 'var(--blue)', fontSize: 9, marginLeft: 4, textDecoration: 'none' }}>↗</Link>
                            </td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700 }} className={role === 'buyer' ? 'pos' : 'neg'}>{fmtUsd(item.total_usd)}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right' }}>{item.trade_count.toLocaleString()}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--ink-dim)' }}>{fmtUsd(avg)}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--ink-faint)', fontSize: 11 }}>{item.first_ts ? fmtTime(item.first_ts) : '—'}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--ink-faint)', fontSize: 11 }}>{item.last_ts ? fmtTime(item.last_ts) : '—'}</td>
                          </tr>
                          {isExpanded && (
                            <tr key={`exp-${item.account_id}`}>
                              <td colSpan={7} style={{ padding: 0, background: 'var(--bg)' }}>
                                <div style={{ padding: '10px 14px', borderTop: '1px solid var(--line-2)' }}>
                                  {expandedLeader?.loading ? (
                                    <div style={{ color: 'var(--ink-faint)', fontSize: 11 }}>loading flow data…</div>
                                  ) : expandedLeader?.trades?.length === 0 ? (
                                    <div style={{ color: 'var(--ink-faint)', fontSize: 11 }}>no flow data found</div>
                                  ) : (
                                    <div style={{ fontSize: 11 }}>
                                      <div style={{ fontSize: 10, color: 'var(--ink-faint)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>
                                        Flow windows · Account {fmtAcct(item.account_id)}
                                      </div>
                                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                                        {expandedLeader?.trades?.map((w: any, wi: number) => (
                                          <div key={wi} style={{ background: 'var(--paper)', padding: '10px 12px', borderRadius: 4 }}>
                                            <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginBottom: 4 }}>{w.window}</div>
                                            <div className="pos">{fmtUsd(w.buy_usd)}<span style={{ color: 'var(--ink-faint)', fontWeight: 400 }}> buy</span></div>
                                            <div className="neg">{fmtUsd(w.sell_usd)}<span style={{ color: 'var(--ink-faint)', fontWeight: 400 }}> sell</span></div>
                                            <div className={w.net_usd >= 0 ? 'pos' : 'neg'} style={{ fontWeight: 700 }}>{fmtUsd(w.net_usd)} net</div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      )
                    })}
                    {!items.length && (
                      <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: 'var(--ink-faint)', fontSize: 12 }}>no data yet — history builds over time</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })}
      </div>

      {/* candle chart */}
      <div className="panel" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>LIT Price Chart</div>
          {lastClose > 0 && (
            <span style={{ fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>
              {fmtPrice(lastClose)}
              {candleChg != null && <span className={candleChg >= 0 ? 'pos' : 'neg'} style={{ marginLeft: 6, fontSize: 12 }}>{fmtPct(candleChg)}</span>}
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {['5m', '15m', '1h', '4h', '1d'].map(res => (
              <button key={res} className={`ch${chartRes === res ? ' on' : ''}`}
                onClick={() => { setChartRes(res); setCandles([]) }}
                style={{ padding: '3px 10px', fontSize: 11 }}>{res}</button>
            ))}
          </div>
        </div>
        <div style={{ padding: '12px 16px' }}>
          <svg viewBox={`0 0 800 200`} preserveAspectRatio="none"
            style={{ width: '100%', height: 200, display: 'block', overflow: 'visible' }}
            dangerouslySetInnerHTML={{ __html: candleSvgBody }} />
          <svg viewBox="0 0 800 36" preserveAspectRatio="none"
            style={{ width: '100%', height: 36, display: 'block', marginTop: 4 }}
            dangerouslySetInnerHTML={{ __html: volSvgBody }} />
          {oiSvgBody && (
            <>
              <div style={{ fontSize: 10, color: 'var(--ink-faint)', letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 10, marginBottom: 2 }}>Open Interest (USD)</div>
              <svg viewBox="0 0 800 50" preserveAspectRatio="none"
                style={{ width: '100%', height: 50, display: 'block' }}
                dangerouslySetInnerHTML={{ __html: oiSvgBody }} />
            </>
          )}
        </div>
      </div>

      {/* order book heatmap */}
      <div className="panel" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Order Book Heatmap</div>
          <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>
            {market === '2049' ? 'LIT/USDC Spot' : 'LIT-PERP'}
            · {hmHistoryRef.current.length > 0 ? `mid $${hmMidRef.current.toFixed(4)} · ±${(HM_RANGE * 100).toFixed(0)}% range` : 'loading…'}
          </span>
        </div>
        <div style={{ padding: '8px 16px 16px' }}>
          <canvas ref={canvasRef} style={{ width: '100%', height: 280, display: 'block', borderRadius: 2 }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ink-faint)', marginTop: 4 }}>
            <span style={{ color: 'var(--green)' }}>■ bids</span>
            <span>rolling {HM_SNAPSHOTS} snapshots</span>
            <span style={{ color: 'var(--red)' }}>■ asks</span>
          </div>
        </div>
      </div>

      {/* funding comparison */}
      <div className="panel" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>LIT Funding Rate Comparison</div>
        </div>
        <div style={{ padding: '12px 16px' }}>
          {!fundingRates.length ? (
            <div style={{ color: 'var(--ink-faint)', fontSize: 12 }}>no cross-exchange data available</div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 10 }}>
                {fundingRates.map(r => {
                  const diff = r.rate - lighterRate
                  const cls = r.rate >= 0 ? 'pos' : 'neg'
                  const apr = (r.rate * 3 * 365 * 100).toFixed(1)
                  return (
                    <div key={r.key} style={{ background: 'var(--bg)', padding: '14px', textAlign: 'center' }}>
                      <div style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-faint)', marginBottom: 6 }}>{r.exchange}</div>
                      <div className={cls} style={{ fontSize: 18, fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{(r.rate * 100).toFixed(4)}%</div>
                      <div style={{ fontSize: 10, color: 'var(--ink-dim)', marginTop: 2 }}>{apr}% APR</div>
                      {r.key !== 'lighter' && Math.abs(diff) > 0.000001 && (
                        <div style={{ fontSize: 9, marginTop: 3, color: Math.abs(diff) > 0.00005 ? (diff > 0 ? 'var(--green)' : 'var(--red)') : 'var(--ink-faint)' }}>
                          vs Lighter {diff >= 0 ? '+' : ''}{(diff * 100).toFixed(4)}%
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              {fundingRates.length >= 2 && (() => {
                const sorted = [...fundingRates].sort((a, b) => b.rate - a.rate)
                const spread = sorted[0].rate - sorted[sorted.length - 1].rate
                return (
                  <div style={{ fontSize: 11, color: spread > 0.0002 ? 'var(--amber)' : 'var(--ink-faint)' }}>
                    {spread > 0.0002
                      ? `⚡ Funding spread ${(spread * 100).toFixed(4)}% — ${sorted[0].exchange} highest, ${sorted[sorted.length - 1].exchange} lowest.`
                      : `Spread ${(spread * 100).toFixed(4)}% — rates aligned.`}
                  </div>
                )
              })()}
            </>
          )}
        </div>
      </div>

      {/* staking stats */}
      <div className="panel" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Staking Pool Activity</div>
          {stakingStats && <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>· {stakingStats.raw_count} events · pool-wide</span>}
        </div>
        <div style={{ padding: '12px 16px' }}>
          {!stakingStats ? (
            <div style={{ color: 'var(--ink-faint)', fontSize: 12 }}>loading…</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
              {[
                { lbl: '24h Staked', val: fmtUsd(stakingStats.h24.stake_usd), sub: stakingStats.h24.stakes + ' tx', cls: 'pos' },
                { lbl: '24h Unstaked', val: fmtUsd(stakingStats.h24.unstake_usd), sub: stakingStats.h24.unstakes + ' tx', cls: 'neg' },
                { lbl: '24h Net Flow', val: fmtUsd(stakingStats.h24.net_usd), sub: stakingStats.h24.unique_accounts + ' accounts', cls: stakingStats.h24.net_usd >= 0 ? 'pos' : 'neg' },
                { lbl: '7d Staked', val: fmtUsd(stakingStats.h168.stake_usd), sub: stakingStats.h168.stakes + ' tx', cls: 'pos' },
                { lbl: '7d Unstaked', val: fmtUsd(stakingStats.h168.unstake_usd), sub: stakingStats.h168.unstakes + ' tx', cls: 'neg' },
                { lbl: '7d Net Flow', val: fmtUsd(stakingStats.h168.net_usd), sub: stakingStats.h168.unique_accounts + ' accounts', cls: stakingStats.h168.net_usd >= 0 ? 'pos' : 'neg' },
              ].map(k => (
                <div key={k.lbl} style={{ background: 'var(--bg)', padding: '14px' }}>
                  <div style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-faint)', marginBottom: 6 }}>{k.lbl}</div>
                  <div className={k.cls} style={{ fontSize: 18, fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{k.val}</div>
                  <div style={{ fontSize: 10, color: 'var(--ink-dim)', marginTop: 3 }}>{k.sub}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* protocol buybacks */}
      <div className="panel" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Protocol Buybacks</div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {[[7, '7d'], [30, '30d'], [0, 'All']].map(([v, l]) => (
              <button key={v} className={`ch${buybackPeriod === v ? ' on' : ''}`}
                onClick={() => setBuybackPeriod(Number(v))} style={{ padding: '3px 10px', fontSize: 11 }}>{l}</button>
            ))}
          </div>
        </div>
        <div style={{ padding: '12px 16px' }}>
          {!buybacks ? (
            <div style={{ color: 'var(--ink-faint)', fontSize: 12 }}>loading…</div>
          ) : buybacks.stats?.length === 0 ? (
            <div style={{ color: 'var(--ink-faint)', fontSize: 12 }}>buyback data unavailable — external feed may be offline</div>
          ) : (() => {
            const cutoffDate = buybackPeriod > 0
              ? new Date(Date.now() - buybackPeriod * 86400000).toISOString().slice(0, 10)
              : '2000-01-01'
            const allStats: any[] = [...(buybacks.stats ?? [])].reverse()
            const filtered = allStats.filter((s: any) => s.date >= cutoffDate)
            const totalVol = filtered.reduce((s: number, r: any) => s + (r.volume ?? 0), 0)
            const totalTrades = filtered.reduce((s: number, r: any) => s + (r.count ?? 0), 0)
            const avgDaily = filtered.length > 0 ? totalVol / filtered.length : 0
            const lit = buybacks.balances?.lit ?? {}; const usdc = buybacks.balances?.usdc ?? {}
            const maxVol = Math.max(...filtered.map((s: any) => s.volume ?? 0)) || 1
            const W = 800, H = 80
            const bw = filtered.length > 0 ? W / filtered.length : W
            const barsSvg = filtered.map((s: any, i: number) => {
              const bh = ((s.volume ?? 0) / maxVol * H).toFixed(1)
              const x = (i * bw).toFixed(1); const y = (H - parseFloat(bh)).toFixed(1)
              return `<rect x="${x}" y="${y}" width="${(bw - 1).toFixed(1)}" height="${bh}" fill="rgba(111,224,137,0.6)" rx="1"><title>${s.date}: ${fmtUsd(s.volume)} · ${s.count} trades</title></rect>`
            }).join('')
            return (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginBottom: 12 }}>
                  {[
                    { lbl: 'Total Bought', val: fmtUsd(totalVol), cls: 'pos' },
                    { lbl: 'Avg / Day', val: fmtUsd(avgDaily), cls: '' },
                    { lbl: 'Total Trades', val: Number(totalTrades).toLocaleString(), cls: '' },
                    { lbl: 'LIT in Treasury', val: Number(lit.total ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }), cls: '' },
                    { lbl: 'USDC Available', val: fmtUsd(usdc.available ?? 0), cls: '' },
                    { lbl: 'USDC Locked', val: fmtUsd(usdc.locked ?? 0), cls: '' },
                  ].map(k => (
                    <div key={k.lbl} style={{ background: 'var(--bg)', padding: '12px 14px' }}>
                      <div style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-faint)', marginBottom: 4 }}>{k.lbl}</div>
                      <div className={k.cls} style={{ fontSize: 16, fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{k.val}</div>
                    </div>
                  ))}
                </div>
                {filtered.length >= 2 && (
                  <>
                    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: H, display: 'block', marginBottom: 2 }}
                      dangerouslySetInnerHTML={{ __html: barsSvg }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ink-faint)', marginBottom: 12 }}>
                      <span>{filtered[0]?.date ?? ''}</span>
                      <span style={{ color: 'var(--green)', fontWeight: 700 }}>avg {fmtUsd(avgDaily)}/day</span>
                      <span>{filtered[filtered.length - 1]?.date ?? ''}</span>
                    </div>
                  </>
                )}
                <div className="table-scroll-x">
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: 'var(--paper)' }}>
                        {['Date', 'Volume', 'Trades', 'Avg / Trade'].map(h => (
                          <th key={h} style={{ padding: '7px 10px', textAlign: h === 'Date' ? 'left' : 'right', fontWeight: 500, fontSize: 11, color: 'var(--ink-dim)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...filtered].reverse().slice(0, 60).map((s: any, i: number) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--line)' }}>
                          <td style={{ padding: '6px 10px', color: 'var(--ink-dim)' }}>{s.date}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600 }} className="pos">{fmtUsd(s.volume)}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right' }}>{Number(s.count ?? 0).toLocaleString()}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--ink-dim)' }}>{s.count > 0 ? fmtUsd(s.volume / s.count) : '—'}</td>
                        </tr>
                      ))}
                      {!filtered.length && (
                        <tr><td colSpan={4} style={{ padding: 20, textAlign: 'center', color: 'var(--ink-faint)', fontSize: 12 }}>no data for this period</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )
          })()}
        </div>
      </div>

      {/* staking activity feed */}
      <div className="panel" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>LIT Staking Activity</div>
          {stakingActivity && (
            <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>
              · {stakingActivity.events.length} events · {stakingActivity.accounts_scanned} accounts scanned
            </span>
          )}
        </div>
        <div className="table-scroll-x">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--paper)' }}>
                {['Time', 'Type', 'Account', 'Amount (USDC)'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Amount (USDC)' ? 'right' : 'left', fontWeight: 500, fontSize: 11, color: 'var(--ink-dim)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!stakingActivity ? (
                <tr><td colSpan={4} style={{ padding: 20, textAlign: 'center', color: 'var(--ink-faint)', fontSize: 12 }}>loading…</td></tr>
              ) : !stakingActivity.events.length ? (
                <tr><td colSpan={4} style={{ padding: 20, textAlign: 'center', color: 'var(--ink-faint)', fontSize: 12 }}>no recent stake / unstake events found among top traders</td></tr>
              ) : stakingActivity.events.map((e: any, i: number) => {
                const isStake = e.type === 'stake'
                const rowBg = isStake ? 'rgba(111,224,137,0.04)' : 'rgba(255,90,90,0.04)'
                const rowBorder = isStake ? 'inset 3px 0 0 var(--green)' : 'inset 3px 0 0 var(--red)'
                const timeLbl = e.time ? new Date(e.time).toLocaleString('en-GB', { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
                return (
                  <tr key={i} style={{ background: rowBg, boxShadow: rowBorder, borderBottom: '1px solid var(--line)' }}>
                    <td style={{ padding: '7px 12px', color: 'var(--ink-dim)', fontSize: 11 }}>{timeLbl}</td>
                    <td style={{ padding: '7px 12px' }}>
                      <span className={isStake ? 'pos' : 'neg'} style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', background: isStake ? 'rgba(111,224,137,0.15)' : 'rgba(255,90,90,0.15)', borderRadius: 3 }}>
                        {isStake ? 'STAKE' : 'UNSTAKE'}
                      </span>
                    </td>
                    <td style={{ padding: '7px 12px', color: 'var(--blue)' }}>
                      {fmtAcct(e.account_id)}
                      <Link href={`/lighter/explorer?q=${e.account_id}`} target="_blank"
                        style={{ color: 'var(--blue)', fontSize: 9, marginLeft: 5, textDecoration: 'none' }}>↗</Link>
                    </td>
                    <td style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }} className={isStake ? 'pos' : 'neg'}>
                      {fmtUsd(e.amount)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* tracked wallets */}
      <div className="panel" style={{ padding: 0, marginBottom: 16 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Tracked Wallets</div>
          {trackedWallets.length > 0 && <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{trackedWallets.length} accounts</span>}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input value={trackAddInput} onChange={e => setTrackAddInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { const id = parseInt(trackAddInput); if (id > 0) { addTracked(id); setTrackAddInput(''); refreshTracked() } } }}
              placeholder="account #" type="number"
              style={{ background: 'var(--bg)', border: '1px solid var(--line)', color: 'var(--ink)', padding: '4px 8px', fontSize: 12, borderRadius: 4, width: 100 }} />
            <button onClick={() => { const id = parseInt(trackAddInput); if (id > 0) { addTracked(id); setTrackAddInput(''); refreshTracked() } }}
              className="ch on" style={{ padding: '4px 12px', fontSize: 12 }}>Add</button>
            {trackedWallets.length > 0 && (
              <button onClick={refreshTracked} className="ch" style={{ padding: '4px 12px', fontSize: 12 }}>Refresh</button>
            )}
          </div>
        </div>
        {!trackedWallets.length ? (
          <div style={{ padding: '20px 16px', color: 'var(--ink-faint)', fontSize: 12, textAlign: 'center' }}>
            Add account IDs above to track their LIT buy/sell flow across time windows.
          </div>
        ) : (
          <div className="table-scroll-x">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--paper)' }}>
                  {['Account', 'Label', 'Buy 24h', 'Sell 24h', '24h P&L', '7d P&L', '30d P&L', ''].map(h => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: h === 'Account' || h === 'Label' || h === '' ? 'left' : 'right', fontWeight: 500, fontSize: 11, color: 'var(--ink-dim)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trackedWallets.map(w => {
                  const f = trackedFlows[w.account_id]
                  const d24 = f?.['24h'] ?? {}; const d7d = f?.['7d'] ?? {}; const d30d = f?.['30d'] ?? {}
                  const currentPrice = summary?.perp?.last_price ?? summary?.spot?.last_price ?? 0
                  const pnl24 = f ? (d24.sell_usd ?? 0) - (d24.buy_usd ?? 0) + (d24.net_size ?? 0) * currentPrice : null
                  const pnl7d = f ? (d7d.sell_usd ?? 0) - (d7d.buy_usd ?? 0) + (d7d.net_size ?? 0) * currentPrice : null
                  const pnl30d = f ? (d30d.sell_usd ?? 0) - (d30d.buy_usd ?? 0) + (d30d.net_size ?? 0) * currentPrice : null
                  const PnlCell = ({ pnl, buy, sell }: { pnl: number | null; buy?: number; sell?: number }) => {
                    if (pnl === null) return <span style={{ color: 'var(--ink-faint)' }}>…</span>
                    const isWin = pnl >= 0
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span className={isWin ? 'pos' : 'neg'} style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtUsd(pnl)}</span>
                          <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 2, background: isWin ? 'rgba(111,224,137,0.18)' : 'rgba(255,106,119,0.18)', color: isWin ? 'var(--green)' : 'var(--red)', letterSpacing: '0.06em' }}>{isWin ? 'W' : 'L'}</span>
                        </div>
                        {(buy != null || sell != null) && (
                          <div style={{ fontSize: 10, color: 'var(--ink-faint)', display: 'flex', gap: 6 }}>
                            <span style={{ color: 'var(--green)' }}>{fmtUsd(buy)}</span>
                            <span style={{ color: 'var(--red)' }}>{fmtUsd(sell)}</span>
                          </div>
                        )}
                      </div>
                    )
                  }
                  return (
                    <tr key={w.account_id} style={{ borderBottom: '1px solid var(--line)' }}>
                      <td style={{ padding: '8px 10px' }}>
                        <Link href={`/lighter/explorer?q=${w.account_id}`} style={{ color: 'var(--blue)', textDecoration: 'none', fontWeight: 600 }}>
                          #{w.account_id}
                        </Link>
                      </td>
                      <td style={{ padding: '8px 10px', color: w.label ? 'var(--ink)' : 'var(--ink-faint)', fontSize: 11 }}>
                        <span style={{ cursor: 'pointer' }} title="click to edit"
                          contentEditable
                          suppressContentEditableWarning
                          onBlur={e => labelTracked(w.account_id, e.currentTarget.textContent?.trim() ?? '')}>
                          {w.label || 'click to label'}
                        </span>
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--green)' }}>{f ? fmtUsd(d24.buy_usd) : '…'}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--red)' }}>{f ? fmtUsd(d24.sell_usd) : '…'}</td>
                      <td style={{ padding: '10px 10px', textAlign: 'right' }}><PnlCell pnl={pnl24} /></td>
                      <td style={{ padding: '10px 10px', textAlign: 'right' }}><PnlCell pnl={pnl7d} /></td>
                      <td style={{ padding: '10px 10px', textAlign: 'right' }}><PnlCell pnl={pnl30d} /></td>
                      <td style={{ padding: '8px 10px' }}>
                        <button onClick={() => removeTracked(w.account_id)}
                          style={{ background: 'none', border: 'none', color: 'var(--ink-faint)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 4px' }} title="Remove">×</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ height: 40 }} />
    </div>
  )
}
