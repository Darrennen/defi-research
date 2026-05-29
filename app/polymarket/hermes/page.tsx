'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

// ── types (mirror /api/polymarket/hermes) ────────────────────────────────────
interface Pattern { name: string; detected: boolean; direction: 'up' | 'down' | 'none'; confidence: number; note: string }
interface HermesData {
  engine: { name: string; wallet: string | null; mode: string; updatedAt: string; priceSource: string }
  market: null | {
    slug: string; question: string; asset: string; phase: 'live' | 'upcoming' | 'settling' | 'none'; live: boolean
    priceToBeat: number; spot: number; spotDelta: number; prevDelta: number; upPrice: number; downPrice: number
    secondsLeft: number; windowEndMs: number; endDateMs: number
  }
  model: {
    regime: { current: 'bull' | 'bear' | 'side'; P: number[][]; stationary: { bull: number; bear: number; side: number }
      stats: Record<string, { mu: number; sigma: number; n: number }> }
    montecarlo: { paths: number; horizon: number; pUp: number; pDown: number; meanDelta: number; meanFinal: number
      converged: boolean; fan: number[][]; deltaHist: { bin: number; count: number }[] }
    patterns: Pattern[]
  }
  signal: { side: 'UP' | 'DOWN' | 'NONE'; edge: number; modelProb: number; marketPrice: number; stake: number
    kellyFull: number; tradable: boolean; conviction: string; patternsAgree: number
    tokenId: string | null; outcome: string | null }
  performance: { backtest: { windows: number; winRate: number; sharpe: number }
    realized: null | { pnl: number; trades: number; winRate: number; biggestWin: number; dayPnl: number } }
  priceSeries: { t: number; c: number }[]
  configured: boolean
  tradeDryRun: boolean
}

interface TradeResult { ts: string; outcome: string; size: number; price: number; status: 'ok' | 'error'; dryRun: boolean; message?: string; orderId?: string }

const fmtUsd = (n: number, d = 2) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const pad = (n: number) => String(n).padStart(2, '0')
const REFRESH_MS = 8000

// shared inline style atoms using the site's design tokens
const lbl: React.CSSProperties = { fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-mute)' }
const mono: React.CSSProperties = { fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums' }

export default function HermesPage() {
  const [data, setData] = useState<HermesData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [now, setNow] = useState(0)
  const [confirm, setConfirm] = useState(false)
  const [placing, setPlacing] = useState(false)
  const [lastTrade, setLastTrade] = useState<TradeResult | null>(null)
  const fetchedAt = useRef(0)

  const placeOrder = useCallback(async () => {
    const s = data?.signal
    if (!s?.tokenId || s.side === 'NONE') return
    setPlacing(true)
    try {
      const res = await fetch('/api/polymarket/trade', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenId: s.tokenId, size: s.stake, price: s.marketPrice, outcome: s.outcome }),
      })
      const j = await res.json()
      setLastTrade({
        ts: new Date().toISOString().slice(11, 19), outcome: s.outcome ?? s.side, size: s.stake, price: s.marketPrice,
        status: j.success ? 'ok' : 'error', dryRun: !!j.dryRun, message: j.message ?? j.error, orderId: j.orderId,
      })
    } catch (e: any) {
      setLastTrade({ ts: new Date().toISOString().slice(11, 19), outcome: s.outcome ?? s.side, size: s.stake, price: s.marketPrice, status: 'error', dryRun: true, message: e?.message ?? 'request failed' })
    } finally { setPlacing(false); setConfirm(false) }
  }, [data])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/polymarket/hermes', { cache: 'no-store' })
      const j = await r.json()
      if (j.error) { setErr(j.error) } else { setData(j); setErr(null); fetchedAt.current = Date.now() }
    } catch (e: any) { setErr(e?.message ?? 'fetch failed') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(); const id = setInterval(load, REFRESH_MS); return () => clearInterval(id) }, [load])
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(id) }, [])

  const secsLeft = data?.market
    ? Math.max(0, data.market.secondsLeft - Math.floor((now - fetchedAt.current) / 1000))
    : 0
  const utc = now ? new Date(now).toISOString().slice(11, 19) + ' UTC' : '—'

  return (
    <>
      {/* ── page header ───────────────────────────────────────── */}
      <section className="page-header" style={{ borderBottom: '3px solid var(--ink)', padding: '40px 0 32px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div className="kicker" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              Prediction Markets · Quant Engine
              <span style={{ flex: 1, height: 1, background: 'var(--rule)' }} />
            </div>
            <h1 style={{ fontFamily: 'var(--serif)', fontWeight: 500, fontSize: 'clamp(32px,4vw,56px)', lineHeight: 0.98, margin: '0 0 14px' }}>
              Hermes <em style={{ color: 'var(--blue)', fontStyle: 'italic' }}>Engine</em>
            </h1>
            <p style={{ fontFamily: 'var(--sans)', fontSize: 15, color: 'var(--ink-soft)', maxWidth: '64ch', lineHeight: 1.6, margin: 0 }}>
              A {data?.market?.asset ?? 'BTC'} 5-minute up/down scalper. A 3-state Markov regime model and a {data?.model.montecarlo.paths ?? 500}-path
              Monte Carlo simulation estimate the true probability of an UP close; edge is that probability minus the live Polymarket price,
              sized with fractional Kelly.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 }}>
            <span style={{ ...mono, fontSize: 11, color: 'var(--ink-mute)' }}>{utc}</span>
            <ModeBadge mode={data?.engine.mode} />
            <button onClick={load} disabled={loading} className="btn ghost" style={{ fontSize: 12, padding: '10px 18px', opacity: loading ? 0.5 : 1 }}>
              {loading ? 'Syncing…' : 'Refresh'} <span className="arr">↻</span>
            </button>
          </div>
        </div>
      </section>

      {err && (
        <div style={{ padding: '12px 16px', background: 'rgba(192,57,43,0.08)', border: '1px solid rgba(192,57,43,0.2)', borderRadius: 4, margin: '20px 0' }}>
          <span style={{ ...mono, fontSize: 12, color: 'var(--red)' }}>Engine error: {err}</span>
        </div>
      )}

      {!data && !err && (
        <div style={{ padding: '64px 0', textAlign: 'center', color: 'var(--ink-mute)', fontFamily: 'var(--sans)', fontSize: 13 }}>
          Booting engine — fitting the regime model…
        </div>
      )}

      {confirm && data?.signal.tokenId && (
        <ConfirmModal data={data} placing={placing} onConfirm={placeOrder} onCancel={() => setConfirm(false)} />
      )}

      {data && <>
        <PerfRow data={data} />
        {lastTrade && <TradeBanner t={lastTrade} onDismiss={() => setLastTrade(null)} />}
        <PulsePanel data={data} secsLeft={secsLeft} />
        <ConvictionStrip data={data} onEnter={() => setConfirm(true)} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 20, margin: '20px 0' }}>
          <MarkovPanel data={data} />
          <MonteCarloPanel data={data} />
        </div>
        <PatternScanner data={data} />
        <p style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)', lineHeight: 1.7, margin: '20px 0 56px' }}>
          Price feed: {data.engine.priceSource} · 1-minute candles · {data.model.montecarlo.paths} Monte Carlo paths.
          Model probabilities are estimates, not guarantees. The backtest measures model skill at a neutral 0.50 entry, not realized profit.
          Realized P&L populates only when the bot trades. Not financial advice.
        </p>
      </>}
    </>
  )
}

// ── mode badge ─────────────────────────────────────────────────────────────────
function ModeBadge({ mode }: { mode?: string }) {
  const live = mode === 'live'
  return (
    <span className={live ? 'badge-risk' : 'badge-warn'} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className="live-dot" style={{ background: live ? 'var(--red)' : 'var(--amber)' }} />
      {live ? 'Live · Mainnet' : 'Paper · Dry-run'}
    </span>
  )
}

// ── performance metrics row ──────────────────────────────────────────────────────
function PerfRow({ data }: { data: HermesData }) {
  const r = data.performance.realized
  const bt = data.performance.backtest
  const pnl = r?.pnl ?? 0
  return (
    <section style={{ padding: '28px 0', borderBottom: '1px solid var(--rule)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 28 }}>
        <Metric label="Realized P&L" value={r ? fmtUsd(pnl) : '—'} color={pnl >= 0 ? 'var(--green)' : 'var(--red)'} big
          sub={r ? `${r.trades} trades · all-time` : 'awaiting first trade'} />
        <Metric label="Backtest Win Rate" value={`${bt.winRate}%`} color="var(--blue)" sub={`${bt.windows} windows`} />
        <Metric label="Backtest Sharpe" value={bt.sharpe.toFixed(2)} color="var(--blue)" sub="annualized · model skill" />
        <Metric label="Today P&L" value={r ? fmtUsd(r.dayPnl) : '—'} color={r && r.dayPnl >= 0 ? 'var(--green)' : 'var(--red)'} sub="session" />
        <Metric label="Biggest Win" value={r ? fmtUsd(r.biggestWin) : '—'} color="var(--green)" sub="single round" />
        <Metric label="Live Win Rate" value={r && r.trades ? `${r.winRate}%` : '—'} sub="realized" />
      </div>
    </section>
  )
}
function Metric({ label, value, color, sub, big }: { label: string; value: string; color?: string; sub?: string; big?: boolean }) {
  return (
    <div>
      <div style={{ ...lbl, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: big ? 38 : 30, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.05, color: color ?? 'var(--ink)' }}>{value}</div>
      {sub && <div style={{ ...mono, fontSize: 10, color: 'var(--ink-mute)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

// ── pulse panel ───────────────────────────────────────────────────────────────
function PulsePanel({ data, secsLeft }: { data: HermesData; secsLeft: number }) {
  const m = data.market
  if (!m) return (
    <div className="panel" style={{ margin: '20px 0', padding: 24, fontFamily: 'var(--sans)', fontSize: 14, color: 'var(--ink-soft)' }}>
      No BTC 5-minute market available right now — the next round is pending.
    </div>
  )
  const mins = Math.floor(secsLeft / 60), secs = secsLeft % 60
  const phaseClr = m.live ? 'var(--green)' : m.phase === 'upcoming' ? 'var(--amber)' : 'var(--ink-mute)'

  return (
    <div className="panel" style={{ margin: '20px 0' }}>
      <div className="ph">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="t" style={{ fontSize: 13, color: 'var(--ink)' }}>{m.asset} 5-Minute Pulse</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: phaseClr }}>
            <span className="live-dot" style={{ background: phaseClr }} />{m.phase}
          </span>
        </div>
        <span className="ts">{m.question}</span>
      </div>

      <div style={{ padding: 22, display: 'grid', gridTemplateColumns: 'minmax(220px,1.1fr) minmax(280px,1.4fr)', gap: 28, alignItems: 'center' }}>
        <div>
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 18 }}>
            <div>
              <div style={{ ...lbl, marginBottom: 6 }}>Price to beat</div>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500, letterSpacing: '-0.02em' }}>{fmtUsd(m.priceToBeat)}</div>
              <div style={{ ...mono, fontSize: 10, color: 'var(--ink-mute)' }}>window open</div>
            </div>
            <div>
              <div style={{ ...lbl, marginBottom: 6 }}>Current price</div>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500, letterSpacing: '-0.02em', color: m.spotDelta >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmtUsd(m.spot)}</div>
              <div style={{ ...mono, fontSize: 11, color: m.spotDelta >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {m.spotDelta >= 0 ? '▲' : '▼'} {fmtUsd(Math.abs(m.spotDelta))}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
            <SideBox label="UP" cents={m.upPrice} active={data.signal.side === 'UP' && data.signal.tradable} color="var(--green)" />
            <SideBox label="DOWN" cents={m.downPrice} active={data.signal.side === 'DOWN' && data.signal.tradable} color="var(--red)" />
          </div>
          <div>
            <div style={{ ...lbl, marginBottom: 4 }}>{m.live ? 'Resolves in' : 'Starts in'}</div>
            <div style={{ ...mono, fontSize: 40, fontWeight: 600, lineHeight: 1, color: secsLeft > 0 && secsLeft < 30 ? 'var(--red)' : 'var(--ink)' }}>
              {pad(mins)}<span style={{ color: 'var(--ink-mute)' }}>:</span>{pad(secs)}</div>
          </div>
        </div>
        <PriceChart data={data} />
      </div>
    </div>
  )
}
function SideBox({ label, cents, active, color }: { label: string; cents: number; active: boolean; color: string }) {
  return (
    <div style={{ flex: 1, border: `1px solid ${active ? color : 'var(--rule)'}`, borderRadius: 4, padding: '10px 12px',
      background: active ? (label === 'UP' ? 'rgba(31,138,91,0.08)' : 'rgba(192,57,43,0.08)') : 'transparent', textAlign: 'center' }}>
      <div style={{ ...lbl, color, marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 24, fontWeight: 500, color }}>{cents}¢</div>
    </div>
  )
}

// ── price chart with target line ───────────────────────────────────────────────
function PriceChart({ data }: { data: HermesData }) {
  const series = data.priceSeries
  const m = data.market
  if (!series.length || !m) return null
  const W = 100, H = 42
  const prices = series.map(s => s.c).concat([m.priceToBeat])
  const lo = Math.min(...prices), hi = Math.max(...prices), rng = hi - lo || 1
  const x = (i: number) => (i / (series.length - 1)) * W
  const y = (p: number) => H - ((p - lo) / rng) * H
  const path = series.map((s, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(s.c).toFixed(2)}`).join(' ')
  const area = `${path} L ${W} ${H} L 0 ${H} Z`
  const last = series[series.length - 1]
  const above = last.c >= m.priceToBeat
  const lineClr = above ? 'var(--green)' : 'var(--red)'
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 160, display: 'block' }}>
        <defs>
          <linearGradient id="hxfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={lineClr} stopOpacity="0.16" />
            <stop offset="100%" stopColor={lineClr} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#hxfill)" />
        <line x1="0" x2={W} y1={y(m.priceToBeat)} y2={y(m.priceToBeat)} stroke="var(--ink-mute)" strokeWidth="0.3" strokeDasharray="1.4 1.2" />
        <path d={path} fill="none" stroke={lineClr} strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
        <circle cx={x(series.length - 1)} cy={y(last.c)} r="1.1" fill={lineClr} />
      </svg>
      <div style={{ ...mono, fontSize: 9, color: 'var(--ink-mute)', display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        <span>last 90 min · 1m</span><span>— — target {fmtUsd(m.priceToBeat, 0)}</span>
      </div>
    </div>
  )
}

// ── conviction strip ───────────────────────────────────────────────────────────
function ConvictionStrip({ data, onEnter }: { data: HermesData; onEnter: () => void }) {
  const s = data.signal
  const isUp = s.side === 'UP'
  const clr = s.side === 'NONE' ? 'var(--ink-mute)' : isUp ? 'var(--green)' : 'var(--red)'
  const canTrade = s.tradable && data.configured && !!s.tokenId
  return (
    <div className="panel" style={{ margin: '20px 0', borderColor: s.tradable ? clr : 'var(--rule)' }}>
      <div className="ph"><span className="t">Live Conviction</span>
        <span className="ts" style={{ color: clr }}>{s.side === 'NONE' ? 'no edge' : `${s.side} signal`} · {s.conviction}</span>
      </div>
      <div className="kpi kpi-4col" style={{ borderTop: 0, borderBottom: 0, padding: '18px 22px', gap: 18 }}>
        <KB label="Direction" value={s.side === 'NONE' ? 'FLAT' : s.side} color={clr} />
        <KB label="Model P" value={`${s.modelProb}%`} />
        <KB label="Market" value={`${s.marketPrice}¢`} />
        <KB label="Edge" value={`${s.edge >= 0 ? '+' : ''}${s.edge}%`} color={s.edge >= 0 ? 'var(--green)' : 'var(--red)'} />
        <KB label="¼ Kelly stake" value={fmtUsd(s.stake)} color="var(--blue)" d={`full ${fmtUsd(s.kellyFull)}`} />
        <KB label="Patterns agree" value={`${s.patternsAgree}/3`} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, justifyContent: 'center' }}>
          <div style={{ ...lbl }}>Action</div>
          {canTrade ? (
            <button onClick={onEnter} style={{
              alignSelf: 'flex-start', fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
              textTransform: 'uppercase', padding: '7px 14px', cursor: 'pointer', borderRadius: 3, color: '#fff',
              background: isUp ? 'var(--green)' : 'var(--red)', border: `1px solid ${isUp ? 'var(--green)' : 'var(--red)'}`,
            }}>▶ Enter {s.side}</button>
          ) : (
            <span className="badge-mech" style={{ alignSelf: 'flex-start', color: 'var(--ink-mute)', border: '1px solid var(--rule)' }}
              title={!data.configured ? 'Set POLYMARKET_PRIVATE_KEY + API creds to enable trading' : s.side === 'NONE' ? 'No positive edge' : 'Round not live / edge below threshold'}>
              ◼ {!data.configured ? 'Not configured' : 'Stand down'}</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── confirm modal ────────────────────────────────────────────────────────────────
function ConfirmModal({ data, placing, onConfirm, onCancel }: { data: HermesData; placing: boolean; onConfirm: () => void; onCancel: () => void }) {
  const s = data.signal
  const live = !data.tradeDryRun
  const shares = s.marketPrice > 0 ? (s.stake / (s.marketPrice / 100)) : 0
  return (
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--paper)', border: '2px solid var(--ink)', borderRadius: 4, padding: '28px 32px', maxWidth: 440, width: '100%' }}>
        <div style={{ ...lbl, color: live ? 'var(--red)' : 'var(--amber)', marginBottom: 14 }}>
          {live ? '● Live order — real money' : '⚠ Dry-run order — simulation'}
        </div>
        <h3 style={{ fontFamily: 'var(--serif)', fontWeight: 500, fontSize: 24, margin: '0 0 16px' }}>
          Buy {s.side} · {data.market?.asset} 5-min
        </h3>
        {([
          ['Outcome', s.outcome ?? s.side],
          ['Round', data.market?.question ?? '—'],
          ['Price', `${s.marketPrice}¢`],
          ['Model P', `${s.modelProb}%`],
          ['Edge', `+${s.edge}%`],
          ['Stake', `${fmtUsd(s.stake)} (¼ Kelly)`],
          ['~Shares', shares.toFixed(1)],
        ] as [string, string][]).map(([k, v]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--rule-soft)' }}>
            <span style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-soft)' }}>{k}</span>
            <span style={{ ...mono, fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{v}</span>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
          <button className="btn primary" style={{ flex: 1, opacity: placing ? 0.6 : 1 }} disabled={placing} onClick={onConfirm}>
            {placing ? 'Placing…' : live ? 'Place live order' : 'Simulate order'}
          </button>
          <button className="btn ghost" disabled={placing} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ── last-trade banner ──────────────────────────────────────────────────────────────
function TradeBanner({ t, onDismiss }: { t: TradeResult; onDismiss: () => void }) {
  const ok = t.status === 'ok'
  const clr = ok ? (t.dryRun ? 'var(--amber)' : 'var(--green)') : 'var(--red)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', margin: '20px 0 0', borderRadius: 4,
      border: `1px solid ${clr}`, background: ok ? (t.dryRun ? 'rgba(178,116,13,0.06)' : 'rgba(31,138,91,0.06)') : 'rgba(192,57,43,0.06)' }}>
      <span style={{ ...mono, fontSize: 11, color: 'var(--ink-mute)' }}>{t.ts}</span>
      <span style={{ fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: clr }}>
        {ok ? (t.dryRun ? 'Dry-run' : 'Live') + ' order placed' : 'Order failed'}</span>
      <span style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink-soft)' }}>
        {t.outcome} · {fmtUsd(t.size)} @ {t.price}¢{t.message ? ` — ${t.message}` : ''}</span>
      <button onClick={onDismiss} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-mute)', fontSize: 16 }}>×</button>
    </div>
  )
}
function KB({ label, value, color, d }: { label: string; value: string; color?: string; d?: string }) {
  return (
    <div className="b">
      <span className="l">{label}</span>
      <span className="v" style={{ color: color ?? 'var(--ink)' }}>{value}</span>
      {d && <span className="d">{d}</span>}
    </div>
  )
}

// ── markov regime panel ──────────────────────────────────────────────────────────
function MarkovPanel({ data }: { data: HermesData }) {
  const r = data.model.regime
  const names = ['bull', 'bear', 'side'] as const
  const clr: Record<string, string> = { bull: 'var(--green)', bear: 'var(--red)', side: 'var(--ink-mute)' }
  return (
    <div className="panel">
      <div className="ph"><span className="t">Markov Regime Model</span>
        <span className="ts" style={{ color: clr[r.current] }}>now · {r.current}</span></div>
      <div style={{ padding: 22 }}>
        <div style={{ ...lbl, marginBottom: 8 }}>Transition matrix P(next | current)</div>
        <table className="tab" style={{ marginBottom: 18 }}>
          <thead><tr><th></th>{names.map(n => <th key={n} style={{ color: clr[n], textAlign: 'center' }}>{n}</th>)}</tr></thead>
          <tbody>
            {names.map((from, i) => (
              <tr key={from}>
                <td className="name" style={{ color: clr[from], fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{from}</td>
                {names.map((_t, j) => (
                  <td key={j} style={{ textAlign: 'center', color: i === j ? 'var(--ink)' : 'var(--ink-soft)', fontWeight: i === j ? 700 : 400,
                    background: `rgba(0,82,255,${r.P[i][j] * 0.16})` }}>{r.P[i][j].toFixed(2)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ ...lbl, marginBottom: 8 }}>Stationary distribution π</div>
        {names.map(n => (
          <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ width: 36, fontFamily: 'var(--sans)', fontSize: 11, color: clr[n], textTransform: 'uppercase' }}>{n}</span>
            <div style={{ flex: 1, height: 6, background: 'var(--rule-soft)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${r.stationary[n] * 100}%`, height: '100%', background: clr[n] }} /></div>
            <span style={{ ...mono, width: 38, fontSize: 11, textAlign: 'right' }}>{r.stationary[n].toFixed(2)}</span>
          </div>
        ))}
        <div style={{ ...mono, fontSize: 10, color: 'var(--ink-mute)', marginTop: 12 }}>
          drift μ ({r.current}) = {(r.stats[r.current].mu * 100).toFixed(3)}% / bar · σ = {(r.stats[r.current].sigma * 100).toFixed(3)}%
        </div>
      </div>
    </div>
  )
}

// ── monte carlo panel ─────────────────────────────────────────────────────────────
function MonteCarloPanel({ data }: { data: HermesData }) {
  const mc = data.model.montecarlo
  const m = data.market
  return (
    <div className="panel">
      <div className="ph"><span className="t">Monte Carlo · {mc.paths} paths · {mc.horizon}m</span>
        <span className="ts" style={{ color: mc.converged ? 'var(--green)' : 'var(--amber)' }}>{mc.converged ? 'converged' : 'noisy'}</span></div>
      <div style={{ padding: 22 }}>
        <FanChart mc={mc} priceToBeat={m?.priceToBeat ?? mc.meanFinal} />
        <div className="kpi kpi-4col" style={{ borderBottom: 0, marginTop: 14, padding: '14px 0 0' }}>
          <KB label="P(UP)" value={`${(mc.pUp * 100).toFixed(0)}%`} color="var(--green)" />
          <KB label="P(DOWN)" value={`${(mc.pDown * 100).toFixed(0)}%`} color="var(--red)" />
          <KB label="Mean Δ" value={`${mc.meanDelta >= 0 ? '+' : ''}${fmtUsd(mc.meanDelta)}`} color={mc.meanDelta >= 0 ? 'var(--green)' : 'var(--red)'} />
          <KB label="Mean final" value={fmtUsd(mc.meanFinal, 0)} />
        </div>
        <div style={{ ...lbl, margin: '16px 0 6px' }}>Δ distribution at horizon</div>
        <Histogram hist={mc.deltaHist} />
      </div>
    </div>
  )
}
function FanChart({ mc, priceToBeat }: { mc: HermesData['model']['montecarlo']; priceToBeat: number }) {
  const fan = mc.fan
  if (!fan.length) return null
  const W = 100, H = 60
  const all = fan.flat().concat([priceToBeat])
  const lo = Math.min(...all), hi = Math.max(...all), rng = hi - lo || 1
  const x = (i: number) => (i / (fan.length - 1)) * W
  const y = (p: number) => H - ((p - lo) / rng) * H
  const band = (loi: number, hii: number) => {
    const top = fan.map((f, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(f[hii]).toFixed(2)}`).join(' ')
    const bot = fan.map((f, i) => `L ${x(fan.length - 1 - i).toFixed(2)} ${y(fan[fan.length - 1 - i][loi]).toFixed(2)}`).join(' ')
    return `${top} ${bot} Z`
  }
  const median = fan.map((f, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(f[2]).toFixed(2)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 130, display: 'block' }}>
      <path d={band(0, 4)} fill="var(--blue)" opacity="0.10" />
      <path d={band(1, 3)} fill="var(--blue)" opacity="0.18" />
      <line x1="0" x2={W} y1={y(priceToBeat)} y2={y(priceToBeat)} stroke="var(--ink-mute)" strokeWidth="0.3" strokeDasharray="1.4 1" />
      <path d={median} fill="none" stroke="var(--blue)" strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
function Histogram({ hist }: { hist: { bin: number; count: number }[] }) {
  const max = Math.max(...hist.map(h => h.count)) || 1
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 44 }}>
      {hist.map((h, i) => (
        <div key={i} title={`Δ ${h.bin.toFixed(0)} · ${h.count}`} style={{ flex: 1, height: `${(h.count / max) * 100}%`,
          minHeight: 1, borderRadius: 1, background: h.bin >= 0 ? 'var(--green)' : 'var(--red)', opacity: 0.8 }} />
      ))}
    </div>
  )
}

// ── pattern scanner ──────────────────────────────────────────────────────────────
function PatternScanner({ data }: { data: HermesData }) {
  return (
    <div className="panel" style={{ margin: '20px 0' }}>
      <div className="ph"><span className="t">Pattern Scanner · M1</span>
        <span className="ts">liquidity · structure · imbalance</span></div>
      <div style={{ padding: 22, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14 }}>
        {data.model.patterns.map(p => {
          const clr = p.direction === 'up' ? 'var(--green)' : p.direction === 'down' ? 'var(--red)' : 'var(--ink-mute)'
          return (
            <div key={p.name} style={{ border: `1px solid ${p.detected ? clr : 'var(--rule)'}`, borderRadius: 4, padding: 14,
              background: p.detected ? (p.direction === 'up' ? 'rgba(31,138,91,0.05)' : p.direction === 'down' ? 'rgba(192,57,43,0.05)' : 'transparent') : 'transparent' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontFamily: 'var(--serif)', fontSize: 16, fontWeight: 500 }}>{p.name}</span>
                <span style={{ ...lbl, color: p.detected ? clr : 'var(--ink-mute)' }}>{p.detected ? p.direction : 'none'}</span>
              </div>
              <div style={{ fontFamily: 'var(--sans)', fontSize: 11, color: 'var(--ink-soft)', marginBottom: 10 }}>{p.note}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, height: 5, background: 'var(--rule-soft)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${p.confidence * 100}%`, height: '100%', background: clr }} /></div>
                <span style={{ ...mono, fontSize: 10, color: 'var(--ink-mute)' }}>{(p.confidence * 100).toFixed(0)}%</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
