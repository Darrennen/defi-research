'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Link from 'next/link'

type Market = {
  market_id: number; symbol: string; market_type: string
  last_price: number; price_change: number; volume_24h: number
  trades_24h: number; oi_usd: number; funding: number | null
  funding_apr: number | null; price_high_24h: number; price_low_24h: number
}
type Trade = {
  id: string; market_id: number; symbol: string
  price: number; size: number; usd: number; ts: number
  side: 'buy' | 'sell'; is_liq: boolean
  buyer_id?: number; seller_id?: number
}
type CVDRow = { symbol: string; delta: number; buy: number; sell: number }
type Summary = {
  total_volume_24h: number; total_trades_24h: number
  active_markets: number; listed_markets: number
  top_gainer: Market | null; top_loser: Market | null
  avg_funding_weighted: number | null; funded_markets: number
}

const fmtUsd = (n: number | null | undefined, short = false): string => {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n), s = n < 0 ? '-' : ''
  if (abs >= 1e9) return s + '$' + (abs / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return s + '$' + (abs / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return s + '$' + (abs / 1e3).toFixed(short ? 1 : 2) + 'K'
  return s + '$' + abs.toFixed(abs < 1 ? 4 : 2)
}
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

const SORT_KEYS = ['symbol', 'last_price', 'price_change', 'volume_24h', 'funding', 'trades_24h'] as const
type SortKey = typeof SORT_KEYS[number]

function buildCandleSvg(rawCandles: any[]): string {
  const W = 800, H = 260
  const pad = { t: 16, r: 16, b: 28, l: 64 }
  const cW = W - pad.l - pad.r, cH = H - pad.t - pad.b
  if (!rawCandles.length) return `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:12px">no candle data</text>`
  const data = rawCandles.map((c: any) => ({
    t: c.t || c.time || c.open_time || c.timestamp || 0,
    o: parseFloat(c.o ?? c.open ?? 0), h: parseFloat(c.h ?? c.high ?? 0),
    l: parseFloat(c.l ?? c.low ?? 0), c: parseFloat(c.c ?? c.close ?? 0),
  })).filter(c => !isNaN(c.o) && c.o > 0)
  if (!data.length) return `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:12px">no candle data</text>`
  const yMin = Math.min(...data.map(c => c.l)), yMax = Math.max(...data.map(c => c.h))
  const yRange = yMax - yMin || 0.001, yPad = yRange * 0.06
  const y0 = yMin - yPad, y1 = yMax + yPad
  const sy = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0)) * cH
  const n = data.length, slotW = cW / n, bodyW = Math.max(2, slotW * 0.55)
  let out = ''
  for (let i = 0; i <= 4; i++) {
    const v = y0 + ((y1 - y0) * i) / 4
    const y = sy(v).toFixed(1)
    out += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/>`
    out += `<text x="${pad.l - 6}" y="${parseFloat(y) + 4}" text-anchor="end" fill="var(--ink-faint)" style="font-size:10px;font-family:monospace">${fmtUsd(v)}</text>`
  }
  data.forEach((c, i) => {
    const cx = (pad.l + (i + 0.5) * slotW).toFixed(1)
    const isUp = c.c >= c.o, col = isUp ? 'var(--green)' : 'var(--red)'
    const bTop = sy(Math.max(c.o, c.c)).toFixed(1), bBot = sy(Math.min(c.o, c.c)).toFixed(1)
    const bH = Math.max(1, parseFloat(bBot) - parseFloat(bTop)).toFixed(1)
    const bX = (parseFloat(cx) - bodyW / 2).toFixed(1)
    out += `<line x1="${cx}" x2="${cx}" y1="${sy(c.h).toFixed(1)}" y2="${sy(c.l).toFixed(1)}" stroke="${col}" stroke-width="1" opacity="0.6"/>`
    out += `<rect x="${bX}" y="${bTop}" width="${bodyW.toFixed(1)}" height="${bH}" fill="${col}" opacity="0.9"/>`
  })
  const step = Math.max(1, Math.floor(n / 4))
  for (let i = 0; i < n; i += step) {
    const c = data[i], x = (pad.l + (i + 0.5) * slotW).toFixed(1)
    const ts = c.t > 1e12 ? c.t : c.t * 1000
    const lbl = new Date(ts).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    out += `<text x="${x}" y="${H - 8}" text-anchor="middle" fill="var(--ink-faint)" style="font-size:10px;font-family:monospace">${lbl}</text>`
  }
  return out
}

export default function LighterCockpit() {
  const [markets, setMarkets] = useState<Market[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [trades, setTrades] = useState<Trade[]>([])
  const [flow, setFlow] = useState<{ buy_usd: number; sell_usd: number; delta_usd: number; cvd: CVDRow[] } | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('volume_24h')
  const [sortDir, setSortDir] = useState(-1)
  const [filter, setFilter] = useState('')
  const [whaleThreshold, setWhaleThreshold] = useState(50000)
  const [refreshMs, setRefreshMs] = useState(5000)
  const [status, setStatus] = useState<'ok' | 'warn' | 'err'>('warn')
  const [lastSync, setLastSync] = useState('—')
  const [pollCount, setPollCount] = useState(0)
  const [drawer, setDrawer] = useState<{ marketId: number | null; candles: any[]; loading: boolean }>({ marketId: null, candles: [], loading: false })
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastPrices = useRef<Map<number, number>>(new Map())

  const poll = useCallback(async () => {
    setStatus('warn')
    try {
      const [mj, tj, fj] = await Promise.all([
        fetch('/api/lighter/markets').then(r => r.json()),
        fetch('/api/lighter/trades?limit=500').then(r => r.json()),
        fetch('/api/lighter/flow?limit=500').then(r => r.json()),
      ])
      setMarkets(mj.markets ?? [])
      setSummary(mj.summary ?? null)
      setTrades(tj.trades ?? [])
      setFlow(fj)
      setLastSync(new Date().toLocaleTimeString('en-GB', { hour12: false }))
      setPollCount(n => n + 1)
      setStatus('ok')
    } catch {
      setStatus('err')
    }
  }, [])

  useEffect(() => {
    poll()
  }, [poll])

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (refreshMs > 0) timerRef.current = setInterval(poll, refreshMs)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [poll, refreshMs])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(d => ({ ...d, marketId: null })) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openDrawer = useCallback(async (marketId: number) => {
    setDrawer({ marketId, candles: [], loading: true })
    try {
      const j = await fetch(`/api/lighter/candles?market_id=${marketId}&resolution=1h&count=24`).then(r => r.json())
      setDrawer({ marketId, candles: j.candles ?? [], loading: false })
    } catch {
      setDrawer({ marketId, candles: [], loading: false })
    }
  }, [])

  const sorted = useMemo(() => {
    const f = filter.toLowerCase()
    return [...markets]
      .filter(m => !f || m.symbol.toLowerCase().includes(f))
      .sort((a, b) => {
        const va = a[sortKey] ?? null, vb = b[sortKey] ?? null
        if (va == null) return 1; if (vb == null) return -1
        if (typeof va === 'string') return sortDir * va.localeCompare(String(vb))
        return sortDir * ((va as number) - (vb as number))
      })
  }, [markets, filter, sortKey, sortDir])

  const whaleTrades = useMemo(() => trades.filter(t => t.usd >= whaleThreshold).slice(0, 100), [trades, whaleThreshold])
  const liqs = useMemo(() => trades.filter(t => t.is_liq).slice(0, 50), [trades])
  const gainers = useMemo(() => [...markets].sort((a, b) => b.price_change - a.price_change).filter(m => m.price_change > 0).slice(0, 6), [markets])
  const losers = useMemo(() => [...markets].sort((a, b) => a.price_change - b.price_change).filter(m => m.price_change < 0).slice(0, 6), [markets])
  const volLeaders = useMemo(() => [...markets].sort((a, b) => b.volume_24h - a.volume_24h).slice(0, 6), [markets])
  const heatmapItems = useMemo(() => [...markets].filter(m => m.funding != null).sort((a, b) => Math.abs(b.funding!) - Math.abs(a.funding!)).slice(0, 48), [markets])
  const maxVol = useMemo(() => Math.max(...sorted.map(m => m.volume_24h), 1), [sorted])

  const drawerMarket = drawer.marketId != null ? markets.find(m => m.market_id === drawer.marketId) ?? null : null
  const drawerTrades = drawer.marketId != null ? trades.filter(t => t.market_id === drawer.marketId).slice(0, 25) : []

  const dotColor = status === 'ok' ? 'var(--green)' : status === 'err' ? 'var(--red)' : 'var(--amber)'

  return (
    <div>
      {/* Page header */}
      <div className="page-header">
        <div className="kicker">Lighter DEX · Live</div>
        <h1>Analyst <em>Cockpit</em></h1>
        <p className="dek">Real-time market data, large-trade surveillance, funding heatmap and flow analysis for Lighter.xyz</p>
      </div>

      {/* Sub-nav */}
      <div className="ch-row" style={{ marginBottom: '24px' }}>
        <Link href="/lighter" className="ch on">Overview</Link>
        <Link href="/lighter/lit" className="ch">LIT Tracker</Link>
        <Link href="/lighter/explorer" className="ch">Explorer</Link>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--ink-faint)' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: dotColor, display: 'inline-block' }} />
          <span>{status === 'ok' ? 'live' : status === 'err' ? 'error' : 'syncing…'}</span>
          <span>last sync {lastSync}</span>
          <span>·</span>
          <span>{pollCount} polls</span>
        </div>
      </div>

      {/* Refresh controls */}
      <div className="ch-row" style={{ marginBottom: '20px' }}>
        <span style={{ fontSize: '10px', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--ink-faint)', marginRight: '4px' }}>REFRESH</span>
        {[5, 15, 60, 0].map(s => (
          <button key={s} className={`ch${refreshMs === s * 1000 || (s === 0 && refreshMs === 0) ? ' on' : ''}`} onClick={() => setRefreshMs(s * 1000)}>{s === 0 ? 'pause' : `${s}s`}</button>
        ))}
      </div>

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: '1px', background: 'var(--line)', border: '1px solid var(--line)', marginBottom: '24px' }}>
        {[
          { lbl: '24h Volume', val: fmtUsd(summary?.total_volume_24h), sub: 'quote · all markets' },
          {
            lbl: 'Avg Funding', cls: summary?.avg_funding_weighted != null ? (summary.avg_funding_weighted > 0 ? 'up' : 'down') : '',
            val: summary?.avg_funding_weighted != null ? (summary.avg_funding_weighted * 100).toFixed(4) + '%' : '—',
            sub: summary?.avg_funding_weighted != null ? (summary.avg_funding_weighted * 3 * 365 * 100).toFixed(1) + '% APR' : 'no data',
          },
          { lbl: 'Active Markets', val: summary ? `${summary.active_markets} / ${summary.listed_markets}` : '—', sub: 'trading · listed' },
          { lbl: '24h Trades', val: summary ? Number(summary.total_trades_24h).toLocaleString() : '—', sub: 'executions' },
          {
            lbl: 'Top Gainer', val: summary?.top_gainer ? summary.top_gainer.symbol : '—',
            sub: summary?.top_gainer ? fmtPct(summary.top_gainer.price_change) : '—', cls2: 'up',
          },
          {
            lbl: 'Top Loser', val: summary?.top_loser ? summary.top_loser.symbol : '—',
            sub: summary?.top_loser ? fmtPct(summary.top_loser.price_change) : '—', cls2: 'down',
          },
        ].map((k, i) => (
          <div key={i} className="metric-cell" style={{ background: 'var(--paper)' }}>
            <div className="lbl">{k.lbl}</div>
            <div className={`val${k.cls ? ' ' + k.cls : ''}`} style={{ fontSize: '20px' }}>{k.val}</div>
            <div className={`sub${k.cls2 ? ' ' + k.cls2 : ''}`} style={{ fontSize: '11px', color: 'var(--ink-dim)' }}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Main grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 420px', gap: '20px', marginBottom: '20px' }}>
        {/* Markets table */}
        <div className="panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
            <h2 style={{ margin: 0 }}>Markets <span style={{ fontSize: '11px', color: 'var(--ink-faint)', fontWeight: 400 }}>{sorted.length} markets</span></h2>
            <input
              value={filter} onChange={e => setFilter(e.target.value)}
              placeholder="filter symbol…"
              style={{ marginLeft: 'auto', width: '140px', padding: '3px 8px', fontSize: '11px', background: 'var(--paper)', border: '1px solid var(--line-2)', borderRadius: '3px', color: 'var(--ink)' }}
            />
          </div>
          <div className="table-scroll-x">
            <table className="tab">
              <thead>
                <tr>
                  {(['symbol', 'last_price', 'price_change', 'volume_24h', 'funding', 'trades_24h'] as SortKey[]).map(k => (
                    <th key={k} onClick={() => { if (sortKey === k) setSortDir(d => d * -1); else { setSortKey(k); setSortDir(-1) } }}
                      style={{ cursor: 'pointer', userSelect: 'none', textAlign: k !== 'symbol' ? 'right' : 'left', whiteSpace: 'nowrap' }}>
                      {k === 'last_price' ? 'Price' : k === 'price_change' ? '24h%' : k === 'volume_24h' ? 'Volume' : k === 'trades_24h' ? 'Trades' : k.charAt(0).toUpperCase() + k.slice(1)}
                      {sortKey === k ? (sortDir === -1 ? ' ↓' : ' ↑') : ''}
                    </th>
                  ))}
                  <th style={{ width: '30px' }}></th>
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--ink-faint)', padding: '20px' }}>loading markets…</td></tr>
                )}
                {sorted.map(m => {
                  const prev = lastPrices.current.get(m.market_id)
                  lastPrices.current.set(m.market_id, m.last_price)
                  const chgCls = m.price_change > 0 ? 'pos' : m.price_change < 0 ? 'neg' : ''
                  const fundCls = (m.funding ?? 0) > 0 ? 'pos' : (m.funding ?? 0) < 0 ? 'neg' : ''
                  const barPct = (m.volume_24h / maxVol) * 100
                  return (
                    <tr key={m.market_id} onClick={() => openDrawer(m.market_id)} style={{ cursor: 'pointer' }}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', fontWeight: 600 }}>{m.symbol}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{fmtUsd(m.last_price)}</td>
                      <td className={chgCls} style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{fmtPct(m.price_change)}</td>
                      <td style={{ textAlign: 'right', position: 'relative', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
                        <div style={{ position: 'absolute', left: 0, top: '25%', height: '50%', width: barPct + '%', background: 'rgba(99,179,255,.15)', borderRadius: '2px' }} />
                        <span style={{ position: 'relative' }}>{fmtUsd(m.volume_24h)}</span>
                      </td>
                      <td className={fundCls} style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
                        {m.funding != null ? (m.funding * 100).toFixed(4) + '%' : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{Number(m.trades_24h).toLocaleString()}</td>
                      <td><button onClick={e => { e.stopPropagation(); openDrawer(m.market_id) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--blue)', fontSize: '14px', padding: '0 4px' }}>▸</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Large trades */}
          <div className="panel">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
              <h2 style={{ margin: 0, fontSize: '13px' }}>Large Trades <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--ink-faint)' }}>{whaleTrades.length}</span></h2>
              <select value={whaleThreshold} onChange={e => setWhaleThreshold(Number(e.target.value))}
                style={{ marginLeft: 'auto', fontSize: '11px', padding: '2px 6px', background: 'var(--paper)', border: '1px solid var(--line-2)', borderRadius: '3px', color: 'var(--ink)' }}>
                {[10000, 50000, 100000, 250000, 1000000].map(v => <option key={v} value={v}>≥ ${v >= 1e6 ? v / 1e6 + 'M' : v >= 1e3 ? v / 1e3 + 'K' : v}</option>)}
              </select>
            </div>
            <div style={{ maxHeight: '280px', overflow: 'auto' }}>
              <table className="tab">
                <thead><tr><th>Time</th><th>Mkt</th><th>Side</th><th style={{ textAlign: 'right' }}>USD</th></tr></thead>
                <tbody>
                  {whaleTrades.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--ink-faint)', padding: '16px' }}>watching…</td></tr>}
                  {whaleTrades.map((t, i) => (
                    <tr key={i}>
                      <td style={{ color: 'var(--ink-dim)', fontSize: '11px' }}>{fmtTime(t.ts)}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>{t.symbol}</td>
                      <td><span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '2px', background: t.side === 'buy' ? 'rgba(111,224,137,.15)' : 'rgba(255,90,90,.15)', color: t.side === 'buy' ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--font-mono)' }}>{t.side}</span></td>
                      <td className={t.side === 'buy' ? 'pos' : 'neg'} style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: t.usd >= 250000 ? 700 : 400 }}>{fmtUsd(t.usd, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Funding heatmap */}
          <div className="panel">
            <h2 style={{ marginBottom: '10px', fontSize: '13px' }}>Funding Heatmap <span style={{ fontWeight: 400, fontSize: '10px', color: 'var(--ink-faint)' }}>hover for APR · click for chart</span></h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(68px,1fr))', gap: '2px' }}>
              {heatmapItems.length === 0 && <div style={{ color: 'var(--ink-faint)', fontSize: '11px' }}>loading…</div>}
              {heatmapItems.map(m => {
                const r = m.funding!
                const intensity = Math.min(Math.abs(r) / Math.max(...heatmapItems.map(x => Math.abs(x.funding!)), 0.0001), 1)
                const bg = r >= 0 ? `rgba(111,224,137,${0.1 + intensity * 0.5})` : `rgba(255,106,119,${0.1 + intensity * 0.5})`
                const apr = (r * 3 * 365 * 100).toFixed(1)
                return (
                  <div key={m.market_id} onClick={() => openDrawer(m.market_id)}
                    title={`${m.symbol} · ${apr}% APR`}
                    style={{ background: bg, padding: '6px 4px', cursor: 'pointer', borderRadius: '2px', textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', fontWeight: 600, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.symbol}</div>
                    <div style={{ fontSize: '9px', fontFamily: 'var(--font-mono)', color: r >= 0 ? 'var(--green)' : 'var(--red)' }}>{(r * 100).toFixed(4)}%</div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom 3-col section */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '20px', marginBottom: '20px' }}>
        {/* Flow panel */}
        <div className="panel">
          <h2 style={{ marginBottom: '12px', fontSize: '13px' }}>Buy / Sell Flow <span style={{ fontWeight: 400, fontSize: '10px', color: 'var(--ink-faint)' }}>last 500 trades</span></h2>
          {flow && (() => {
            const total = (flow.buy_usd + flow.sell_usd) || 1
            const pctBuy = (flow.buy_usd / total) * 100
            return (
              <div>
                <div style={{ display: 'flex', gap: '16px', marginBottom: '10px', alignItems: 'baseline' }}>
                  <div><div style={{ fontSize: '10px', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '.1em' }}>Buy</div><div className="pos" style={{ fontSize: '18px', fontFamily: 'var(--font-mono)' }}>{fmtUsd(flow.buy_usd)}</div></div>
                  <div><div style={{ fontSize: '10px', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '.1em' }}>Sell</div><div className="neg" style={{ fontSize: '18px', fontFamily: 'var(--font-mono)' }}>{fmtUsd(flow.sell_usd)}</div></div>
                  <div style={{ marginLeft: 'auto', textAlign: 'right' }}><div style={{ fontSize: '10px', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '.1em' }}>Delta</div><div className={flow.delta_usd >= 0 ? 'pos' : 'neg'} style={{ fontSize: '18px', fontFamily: 'var(--font-mono)' }}>{fmtUsd(flow.delta_usd)}</div></div>
                </div>
                <div style={{ display: 'flex', height: '6px', borderRadius: '3px', overflow: 'hidden', marginBottom: '4px' }}>
                  <div style={{ width: pctBuy + '%', background: 'var(--green)' }} />
                  <div style={{ flex: 1, background: 'var(--red)' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--ink-dim)', marginBottom: '14px' }}>
                  <span>{pctBuy.toFixed(1)}% buy</span>
                  <span>{(100 - pctBuy).toFixed(1)}% sell</span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--ink-faint)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '.06em' }}>Top CVD</div>
                <table className="tab" style={{ fontSize: '11px' }}>
                  <tbody>
                    {flow.cvd.slice(0, 6).map((c, i) => (
                      <tr key={i}>
                        <td style={{ fontFamily: 'var(--font-mono)' }}>{c.symbol}</td>
                        <td className={c.delta > 0 ? 'pos' : 'neg'} style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{c.delta > 0 ? '+' : ''}{fmtUsd(c.delta)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--ink-dim)', fontFamily: 'var(--font-mono)' }}>{fmtUsd(c.buy + c.sell)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })()}
        </div>

        {/* Liquidations */}
        <div className="panel">
          <h2 style={{ marginBottom: '10px', fontSize: '13px' }}>Liquidations <span style={{ fontWeight: 400, fontSize: '11px', color: 'var(--ink-faint)' }}>{liqs.length} events</span></h2>
          <div style={{ maxHeight: '320px', overflow: 'auto' }}>
            <table className="tab">
              <thead><tr><th>Time</th><th>Mkt</th><th>Side</th><th style={{ textAlign: 'right' }}>USD</th></tr></thead>
              <tbody>
                {liqs.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--ink-faint)', padding: '16px', fontSize: '11px' }}>no liquidations in recent sample</td></tr>}
                {liqs.map((t, i) => (
                  <tr key={i}>
                    <td style={{ color: 'var(--ink-dim)', fontSize: '11px' }}>{fmtTime(t.ts)}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>{t.symbol}</td>
                    <td><span style={{ fontSize: '10px', padding: '1px 5px', background: 'rgba(255,90,90,.15)', color: 'var(--red)', borderRadius: '2px' }}>{t.side}</span></td>
                    <td className="neg" style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>{fmtUsd(t.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Movers */}
        <div className="panel">
          <h2 style={{ marginBottom: '10px', fontSize: '13px' }}>Movers <span style={{ fontWeight: 400, fontSize: '10px', color: 'var(--ink-faint)' }}>24h</span></h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            <div>
              <div style={{ fontSize: '10px', color: 'var(--green)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '4px' }}>▲ Gainers</div>
              <table className="tab" style={{ fontSize: '11px' }}>
                <tbody>
                  {gainers.map((m, i) => <tr key={i}><td style={{ fontFamily: 'var(--font-mono)' }}>{m.symbol}</td><td className="pos" style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtPct(m.price_change)}</td></tr>)}
                  {gainers.length === 0 && <tr><td colSpan={2} style={{ color: 'var(--ink-faint)' }}>—</td></tr>}
                </tbody>
              </table>
            </div>
            <div>
              <div style={{ fontSize: '10px', color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '4px' }}>▼ Losers</div>
              <table className="tab" style={{ fontSize: '11px' }}>
                <tbody>
                  {losers.map((m, i) => <tr key={i}><td style={{ fontFamily: 'var(--font-mono)' }}>{m.symbol}</td><td className="neg" style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtPct(m.price_change)}</td></tr>)}
                  {losers.length === 0 && <tr><td colSpan={2} style={{ color: 'var(--ink-faint)' }}>—</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ fontSize: '10px', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '4px' }}>Volume Leaders</div>
          <table className="tab" style={{ fontSize: '11px' }}>
            <tbody>
              {volLeaders.map((m, i) => <tr key={i}><td style={{ fontFamily: 'var(--font-mono)' }}>{m.symbol}</td><td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtUsd(m.volume_24h)}</td><td style={{ textAlign: 'right', color: 'var(--ink-dim)', fontFamily: 'var(--font-mono)' }}>{Number(m.trades_24h).toLocaleString()}</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>

      {/* Market detail drawer */}
      {drawer.marketId != null && (
        <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: '560px', background: 'var(--paper)', borderLeft: '1px solid var(--line)', zIndex: 100, overflow: 'auto', padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '16px' }}>{drawerMarket?.symbol ?? `MKT-${drawer.marketId}`}</div>
              {drawerMarket && (
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '11px', color: 'var(--ink-dim)', marginTop: '4px' }}>
                  <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{fmtUsd(drawerMarket.last_price)}</span>
                  <span className={drawerMarket.price_change >= 0 ? 'pos' : 'neg'}>{fmtPct(drawerMarket.price_change)} 24h</span>
                  <span>Vol {fmtUsd(drawerMarket.volume_24h)}</span>
                  {drawerMarket.funding != null && <span className={drawerMarket.funding >= 0 ? 'pos' : 'neg'}>Fund {(drawerMarket.funding * 100).toFixed(4)}%</span>}
                </div>
              )}
            </div>
            <button onClick={() => setDrawer(d => ({ ...d, marketId: null }))}
              style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--ink-dim)' }}>×</button>
          </div>

          {drawer.loading && <div style={{ color: 'var(--ink-faint)', fontSize: '12px', padding: '20px 0' }}>loading chart…</div>}
          {!drawer.loading && (
            <div style={{ marginBottom: '16px' }}>
              <svg viewBox="0 0 800 260" preserveAspectRatio="none" style={{ width: '100%', height: '260px', display: 'block' }}
                dangerouslySetInnerHTML={{ __html: buildCandleSvg(drawer.candles) }} />
            </div>
          )}

          <div style={{ fontSize: '11px', color: 'var(--ink-faint)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '6px' }}>Recent Trades</div>
          <table className="tab" style={{ fontSize: '11px' }}>
            <thead><tr><th>Time</th><th>Side</th><th style={{ textAlign: 'right' }}>Price</th><th style={{ textAlign: 'right' }}>USD</th></tr></thead>
            <tbody>
              {drawerTrades.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--ink-faint)' }}>no recent trades in buffer</td></tr>}
              {drawerTrades.map((t, i) => (
                <tr key={i}>
                  <td style={{ color: 'var(--ink-dim)' }}>{fmtTime(t.ts)}</td>
                  <td><span style={{ fontSize: '10px', padding: '1px 5px', background: t.side === 'buy' ? 'rgba(111,224,137,.15)' : 'rgba(255,90,90,.15)', color: t.side === 'buy' ? 'var(--green)' : 'var(--red)', borderRadius: '2px' }}>{t.side}</span></td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtUsd(t.price)}</td>
                  <td className={t.side === 'buy' ? 'pos' : 'neg'} style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtUsd(t.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {drawer.marketId != null && (
        <div onClick={() => setDrawer(d => ({ ...d, marketId: null }))}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.3)', zIndex: 99 }} />
      )}
    </div>
  )
}
