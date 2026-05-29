'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'

interface Opportunity {
  match:   string
  outcome: string
  tokenId: string
  teamA:   string
  teamB:   string
  eloA:    number
  eloB:    number
  pModel:  number
  pMarket: number
  edge:    number
  price:   number
  stake:   number
  signal:  'trade' | 'watch' | 'skip'
}

interface Summary {
  total:      number
  actionable: number
  bestEdge:   number
  avgEdge:    number
}

interface ApiData {
  opportunities: Opportunity[]
  summary:       Summary
  fetchedAt:     string
  dryRun:        boolean
  configured:    boolean
  error?:        string
}

interface TradeLog {
  id:        string
  ts:        string
  match:     string
  outcome:   string
  size:      number
  price:     number
  edge:      number
  dryRun:    boolean
  status:    'ok' | 'error'
  orderId?:  string
  message?:  string
}

interface OpenOrder {
  id:            string
  outcome:       string
  side:          string
  price:         string
  original_size: string
  size_matched:  string
  status:        string
  created_at:    number
}

const REFRESH_MS = 60_000

function EdgeBadge({ edge, signal }: { edge: number; signal: string }) {
  const color = signal === 'trade' ? 'var(--green)' : signal === 'watch' ? 'var(--amber)' : 'var(--ink-mute)'
  return (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
      color, padding: '2px 6px',
      background: signal === 'trade' ? 'rgba(31,138,91,0.10)' : signal === 'watch' ? 'rgba(178,116,13,0.10)' : 'transparent',
      borderRadius: 3,
    }}>
      {edge >= 0 ? '+' : ''}{edge.toFixed(1)}%
    </span>
  )
}

function SignalBadge({ signal }: { signal: string }) {
  if (signal === 'trade') return (
    <span style={{
      fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
      textTransform: 'uppercase', color: '#fff',
      background: 'var(--green)', padding: '2px 7px', borderRadius: 3,
    }}>TRADE</span>
  )
  if (signal === 'watch') return (
    <span style={{
      fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
      textTransform: 'uppercase', color: 'var(--amber)',
      border: '1px solid var(--amber)', padding: '2px 7px', borderRadius: 3,
    }}>WATCH</span>
  )
  return null
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontFamily: 'var(--sans)', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-soft)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 600, color: 'var(--ink)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontFamily: 'var(--sans)', fontSize: 11, color: 'var(--ink-mute)' }}>{sub}</div>}
    </div>
  )
}

function ModeBanner({ dryRun, configured }: { dryRun: boolean; configured: boolean }) {
  if (!configured) {
    return (
      <div style={{
        marginTop: 20, padding: '12px 16px',
        background: 'rgba(100,100,100,0.06)', border: '1px solid var(--rule)',
        borderRadius: 4,
      }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-soft)', fontWeight: 700, marginBottom: 6 }}>
          ○ BOT NOT CONFIGURED
        </div>
        <div style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-mute)', lineHeight: 1.8 }}>
          Add these to <code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>defi-research/.env.local</code> to enable live trading:
          <br /><code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>POLYMARKET_PRIVATE_KEY=0x…</code>
          <br /><code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>POLYMARKET_API_KEY=…</code>
          <br /><code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>POLYMARKET_API_SECRET=…</code>
          <br /><code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>POLYMARKET_API_PASSPHRASE=…</code>
          <br /><code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>POLYMARKET_DRY_RUN=true</code>
          <br /><br />
          Get API credentials from <a href="https://clob.polymarket.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--blue)' }}>Polymarket CLOB API</a> after connecting your wallet.
        </div>
      </div>
    )
  }

  if (dryRun) {
    return (
      <div style={{
        marginTop: 20, padding: '10px 16px',
        background: 'rgba(178,116,13,0.08)', border: '1px solid rgba(178,116,13,0.25)',
        borderRadius: 4, display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--amber)', fontWeight: 700, flexShrink: 0 }}>⚠ DRY RUN</span>
        <span style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-soft)' }}>
          Credentials configured. Trades are simulated — no real money moves. Set{' '}
          <code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>POLYMARKET_DRY_RUN=false</code> in{' '}
          <code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>.env.local</code> and restart to go live.
        </span>
      </div>
    )
  }

  return (
    <div style={{
      marginTop: 20, padding: '10px 16px',
      background: 'rgba(192,57,43,0.06)', border: '1px solid rgba(192,57,43,0.35)',
      borderRadius: 4, display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)', fontWeight: 700, flexShrink: 0 }}>● LIVE MODE</span>
      <span style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-soft)' }}>
        Real money trading is active. Orders go on-chain. Use Emergency Stop to cancel all open orders.
      </span>
    </div>
  )
}

export default function PolymarketPage() {
  const router = useRouter()

  const [data, setData]             = useState<ApiData | null>(null)
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState('')
  const [filter, setFilter]         = useState<'all' | 'trade' | 'watch'>('all')

  // Bot control state
  const [confirmOpp, setConfirmOpp] = useState<Opportunity | null>(null)
  const [executing, setExecuting]   = useState<string | null>(null)  // tokenId in flight
  const [tradeLog, setTradeLog]     = useState<TradeLog[]>([])
  const [stopping, setStopping]     = useState(false)
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([])
  const [posLoading, setPosLoading] = useState(false)

  const logRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch('/api/polymarket')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: ApiData = await res.json()
      setData(json)
      setError(json.error ?? null)
      setLastRefresh(new Date().toLocaleTimeString('en-GB'))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadPositions = useCallback(async () => {
    setPosLoading(true)
    try {
      const res  = await fetch('/api/polymarket/positions')
      const json = await res.json()
      setOpenOrders(json.orders ?? [])
    } catch {
      // silent
    } finally {
      setPosLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  useEffect(() => {
    loadPositions()
    const id = setInterval(loadPositions, 30_000)
    return () => clearInterval(id)
  }, [loadPositions])

  // Auto-scroll trade log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [tradeLog])

  const opps = data?.opportunities ?? []
  const shown = filter === 'all' ? opps : opps.filter(o => o.signal === filter)

  async function executeTrade(opp: Opportunity) {
    setConfirmOpp(null)
    setExecuting(opp.tokenId)
    const entry: TradeLog = {
      id:      `${Date.now()}`,
      ts:      new Date().toLocaleTimeString('en-GB'),
      match:   opp.match,
      outcome: opp.outcome,
      size:    opp.stake,
      price:   opp.price,
      edge:    opp.edge,
      dryRun:  data?.dryRun ?? true,
      status:  'ok',
    }
    try {
      const res  = await fetch('/api/polymarket/trade', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ tokenId: opp.tokenId, size: opp.stake, price: opp.price, outcome: opp.outcome }),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error ?? 'Order failed')
      entry.orderId  = json.orderId
      entry.message  = json.message ?? (json.dryRun ? 'Simulated' : 'Placed')
      entry.status   = 'ok'
    } catch (e: any) {
      entry.status  = 'error'
      entry.message = e.message
    }
    setTradeLog(prev => [...prev, entry])
    setExecuting(null)
    if (entry.status === 'ok') loadPositions()
  }

  async function handleEmergencyStop() {
    if (!window.confirm('Cancel ALL open orders on Polymarket? This cannot be undone.')) return
    setStopping(true)
    try {
      const res  = await fetch('/api/polymarket/cancel', { method: 'POST' })
      const json = await res.json()
      const msg  = json.dryRun ? 'DRY RUN: no orders cancelled' : json.success ? 'All orders cancelled' : `Error: ${json.error}`
      setTradeLog(prev => [...prev, {
        id: `stop-${Date.now()}`, ts: new Date().toLocaleTimeString('en-GB'),
        match: '—', outcome: 'EMERGENCY STOP', size: 0, price: 0, edge: 0,
        dryRun: json.dryRun ?? false, status: json.success ? 'ok' : 'error', message: msg,
      }])
      loadPositions()
    } catch {
      // silent
    } finally {
      setStopping(false)
    }
  }

  const dryRun    = data?.dryRun ?? true
  const configured = data?.configured ?? false

  return (
    <>
      {/* Confirm trade dialog */}
      {confirmOpp && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={e => { if (e.target === e.currentTarget) setConfirmOpp(null) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 200,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div style={{
            background: 'var(--paper)', border: '2px solid var(--ink)', borderRadius: 4,
            padding: '28px 32px', maxWidth: 420, width: '100%', margin: '0 16px',
          }}>
            <div style={{ fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: dryRun ? 'var(--amber)' : 'var(--red)', marginBottom: 14 }}>
              {dryRun ? '⚠ Dry Run Order' : '● Live Order — Real Money'}
            </div>
            <h3 style={{ fontFamily: 'var(--serif)', fontWeight: 500, fontSize: 24, margin: '0 0 16px' }}>
              Confirm Buy
            </h3>
            {[
              ['Outcome', confirmOpp.outcome],
              ['Match',   confirmOpp.match],
              ['Price',   `${confirmOpp.price.toFixed(1)}¢`],
              ['Model',   `${confirmOpp.pModel.toFixed(1)}%`],
              ['Edge',    `+${confirmOpp.edge.toFixed(1)}%`],
              ['Stake',   `$${confirmOpp.stake.toFixed(2)} (¼ Kelly)`],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--rule-soft)' }}>
                <span style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-soft)' }}>{k}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{v}</span>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
              <button
                className="btn primary"
                style={{ flex: 1 }}
                onClick={() => executeTrade(confirmOpp)}
              >
                {dryRun ? 'Simulate Order' : 'Place Live Order'}
              </button>
              <button
                className="btn ghost"
                onClick={() => setConfirmOpp(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Page header */}
      <section className="page-header" style={{ borderBottom: '3px solid var(--ink)', padding: '40px 0 32px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div className="kicker" style={{
              fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 700,
              letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--blue)',
              display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14,
            }}>
              Prediction Markets
              <span style={{ flex: 1, height: 1, background: 'var(--rule)' }} />
            </div>
            <h1 style={{ fontFamily: 'var(--serif)', fontWeight: 500, fontSize: 'clamp(32px,4vw,56px)', lineHeight: 0.98, margin: '0 0 14px' }}>
              Polymarket <em style={{ color: 'var(--blue)', fontStyle: 'italic' }}>Bot</em>
            </h1>
            <p style={{ fontFamily: 'var(--sans)', fontSize: 15, color: 'var(--ink-soft)', maxWidth: '64ch', lineHeight: 1.6, margin: 0 }}>
              Live Polymarket odds vs ELO model probability for every 2026 FIFA World Cup match.
              Edge = model probability minus market price. Trade signals fire above 7%.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexShrink: 0 }}>
            <button
              onClick={load}
              disabled={loading}
              className="btn ghost"
              style={{ fontSize: 12, padding: '10px 18px', opacity: loading ? 0.5 : 1 }}
            >
              {loading ? 'Scanning…' : 'Refresh'} <span className="arr">↻</span>
            </button>
            <button
              onClick={async () => {
                await fetch('/api/polymarket/auth', { method: 'DELETE' })
                router.push('/polymarket/login')
              }}
              className="btn ghost"
              style={{ fontSize: 12, padding: '10px 18px', color: 'var(--ink-mute)' }}
            >
              Lock
            </button>
          </div>
        </div>

        <ModeBanner dryRun={dryRun} configured={configured} />
      </section>

      {/* Summary stats */}
      <section style={{ padding: '28px 0', borderBottom: '1px solid var(--rule)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 32 }}>
          <Stat label="Markets Scanned" value={loading ? '—' : String(data?.summary.total ?? 0)} sub="Active WC outcomes" />
          <Stat label="Trade Signals"   value={loading ? '—' : String(data?.summary.actionable ?? 0)} sub="Edge ≥ 7%" />
          <Stat label="Best Edge"       value={loading ? '—' : `+${data?.summary.bestEdge.toFixed(1) ?? 0}%`} sub="Highest mispricing" />
          <Stat label="Avg Edge"        value={loading ? '—' : `${data?.summary.avgEdge.toFixed(1) ?? 0}%`} sub="All scanned markets" />
          <Stat label="Bankroll"        value="$140" sub="Session cap" />
          <Stat label="Max Single Bet"  value="$30"  sub="Hard limit" />
          <Stat label="Last Scan"       value={lastRefresh || '—'} sub={`Refreshes every ${REFRESH_MS / 1000}s`} />
        </div>
      </section>

      {/* Filter tabs */}
      <div style={{ padding: '20px 0 0', display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontFamily: 'var(--sans)', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-soft)', marginRight: 8 }}>Show</span>
        {(['all', 'trade', 'watch'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 600,
              letterSpacing: '0.12em', textTransform: 'uppercase',
              padding: '6px 14px', cursor: 'pointer', border: '1px solid',
              borderRadius: 3, background: filter === f ? 'var(--ink)' : 'transparent',
              color: filter === f ? 'var(--paper)' : 'var(--ink-soft)',
              borderColor: filter === f ? 'var(--ink)' : 'var(--rule)',
              transition: 'all 120ms',
            }}
          >
            {f === 'all'   ? `All (${opps.length})`
             : f === 'trade' ? `Trade (${opps.filter(o => o.signal === 'trade').length})`
             : `Watch (${opps.filter(o => o.signal === 'watch').length})`}
          </button>
        ))}
      </div>

      {/* Edge table */}
      <section style={{ padding: '16px 0 48px' }}>
        {error && (
          <div style={{ padding: '12px 16px', background: 'rgba(192,57,43,0.08)', border: '1px solid rgba(192,57,43,0.2)', borderRadius: 4, marginBottom: 16 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--red)' }}>Error: {error}</span>
          </div>
        )}

        {loading && !data ? (
          <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--ink-mute)', fontFamily: 'var(--sans)', fontSize: 13 }}>
            Fetching live Polymarket odds…
          </div>
        ) : shown.length === 0 ? (
          <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--ink-mute)', fontFamily: 'var(--sans)', fontSize: 13 }}>
            No markets found for this filter.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--sans)', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--ink)' }}>
                  {['Match', 'Outcome', 'ELO', 'Model', 'Market', 'Edge', '¼ Kelly', 'Signal', ''].map(h => (
                    <th key={h} style={{
                      padding: '10px 12px', textAlign: h === 'Match' || h === 'Outcome' ? 'left' : 'right',
                      fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700,
                      letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-soft)',
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((o, i) => {
                  const isBuying = executing === o.tokenId
                  return (
                    <tr
                      key={`${o.tokenId}-${i}`}
                      style={{
                        borderBottom: '1px solid var(--rule-soft)',
                        background: o.signal === 'trade'
                          ? 'rgba(31,138,91,0.04)'
                          : i % 2 === 0 ? 'transparent' : 'rgba(21,22,26,0.02)',
                      }}
                    >
                      <td style={{ padding: '12px 12px', fontWeight: 500, whiteSpace: 'nowrap' }}>
                        <span style={{ color: 'var(--ink)' }}>{o.teamA.charAt(0).toUpperCase() + o.teamA.slice(1)}</span>
                        <span style={{ color: 'var(--ink-mute)', margin: '0 6px', fontFamily: 'var(--mono)', fontSize: 11 }}>vs</span>
                        <span style={{ color: 'var(--ink-soft)' }}>{o.teamB.charAt(0).toUpperCase() + o.teamB.slice(1)}</span>
                      </td>
                      <td style={{ padding: '12px 12px', color: 'var(--ink-soft)', fontSize: 12 }}>{o.outcome}</td>
                      <td style={{ padding: '12px 12px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', whiteSpace: 'nowrap' }}>
                        {o.eloA} <span style={{ color: 'var(--rule)' }}>|</span> {o.eloB}
                      </td>
                      <td style={{ padding: '12px 12px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                        {o.pModel.toFixed(1)}%
                      </td>
                      <td style={{ padding: '12px 12px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink-soft)' }}>
                        {o.pMarket.toFixed(1)}%
                      </td>
                      <td style={{ padding: '12px 12px', textAlign: 'right' }}>
                        <EdgeBadge edge={o.edge} signal={o.signal} />
                      </td>
                      <td style={{ padding: '12px 12px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 13, color: o.stake > 0 ? 'var(--ink)' : 'var(--ink-mute)' }}>
                        {o.stake > 0 ? `$${o.stake.toFixed(2)}` : '—'}
                      </td>
                      <td style={{ padding: '12px 12px', textAlign: 'right' }}>
                        <SignalBadge signal={o.signal} />
                      </td>
                      <td style={{ padding: '12px 8px', textAlign: 'right', width: 80 }}>
                        {(o.signal === 'trade' || o.signal === 'watch') && (
                          <button
                            disabled={!!executing || !configured}
                            onClick={() => setConfirmOpp(o)}
                            style={{
                              fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 700,
                              letterSpacing: '0.1em', textTransform: 'uppercase',
                              padding: '5px 12px', cursor: executing || !configured ? 'not-allowed' : 'pointer',
                              border: '1px solid',
                              borderRadius: 3,
                              opacity: executing && !isBuying ? 0.4 : 1,
                              background: isBuying ? 'var(--ink-mute)'
                                : o.signal === 'trade' ? 'var(--green)' : 'transparent',
                              color: o.signal === 'trade' ? '#fff' : 'var(--ink-soft)',
                              borderColor: o.signal === 'trade' ? 'var(--green)' : 'var(--rule)',
                              transition: 'all 120ms',
                              minWidth: 52,
                            }}
                          >
                            {isBuying ? '…' : 'Buy'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Bot Controls */}
      <section style={{ padding: '32px 0 64px', borderTop: '1px solid var(--rule)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--blue)', marginBottom: 6 }}>
              Bot Controls
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, letterSpacing: '0.12em',
                padding: '3px 10px', borderRadius: 3,
                background: !configured ? 'var(--rule)' : dryRun ? 'rgba(178,116,13,0.15)' : 'rgba(192,57,43,0.12)',
                color: !configured ? 'var(--ink-mute)' : dryRun ? 'var(--amber)' : 'var(--red)',
                border: `1px solid ${!configured ? 'var(--rule)' : dryRun ? 'rgba(178,116,13,0.3)' : 'rgba(192,57,43,0.3)'}`,
              }}>
                {!configured ? 'NOT CONFIGURED' : dryRun ? '⚠ DRY RUN' : '● LIVE'}
              </span>
              {configured && (
                <span style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-mute)' }}>
                  {dryRun ? 'Simulated trades only' : 'Real money — orders go on-chain'}
                </span>
              )}
            </div>
          </div>

          <button
            onClick={handleEmergencyStop}
            disabled={stopping || !configured}
            style={{
              fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 700,
              letterSpacing: '0.1em', textTransform: 'uppercase',
              padding: '10px 20px', cursor: stopping || !configured ? 'not-allowed' : 'pointer',
              border: '2px solid',
              borderRadius: 3,
              background: 'rgba(192,57,43,0.08)',
              color: configured ? 'var(--red)' : 'var(--ink-mute)',
              borderColor: configured ? 'var(--red)' : 'var(--rule)',
              opacity: stopping ? 0.6 : 1,
              transition: 'all 120ms',
            }}
          >
            {stopping ? 'Stopping…' : '■ Emergency Stop'}
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

          {/* Open positions */}
          <div style={{ padding: '20px', border: '1px solid var(--rule)', borderRadius: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-soft)' }}>
                Open Orders
              </div>
              <button
                onClick={loadPositions}
                disabled={posLoading}
                style={{
                  fontFamily: 'var(--mono)', fontSize: 10, padding: '3px 8px', cursor: posLoading ? 'not-allowed' : 'pointer',
                  border: '1px solid var(--rule)', borderRadius: 3,
                  background: 'transparent', color: 'var(--ink-mute)', opacity: posLoading ? 0.5 : 1,
                }}
              >
                {posLoading ? '…' : '↻'}
              </button>
            </div>
            {!configured ? (
              <div style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-mute)', padding: '16px 0' }}>
                Configure credentials to see open orders.
              </div>
            ) : openOrders.length === 0 ? (
              <div style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-mute)', padding: '16px 0' }}>
                No open orders.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {openOrders.map(ord => (
                  <div key={ord.id} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 10px', background: 'rgba(21,22,26,0.03)', borderRadius: 3,
                    border: '1px solid var(--rule-soft)',
                  }}>
                    <div>
                      <div style={{ fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 500, color: 'var(--ink)' }}>{ord.outcome}</div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)' }}>
                        {ord.side} @ {(parseFloat(ord.price) * 100).toFixed(1)}¢ · ${parseFloat(ord.original_size).toFixed(2)}
                      </div>
                    </div>
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 10, padding: '2px 6px',
                      background: ord.status === 'LIVE' ? 'rgba(31,138,91,0.1)' : 'var(--rule)',
                      color: ord.status === 'LIVE' ? 'var(--green)' : 'var(--ink-mute)',
                      borderRadius: 3,
                    }}>
                      {ord.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Trade log */}
          <div style={{ padding: '20px', border: '1px solid var(--rule)', borderRadius: 4 }}>
            <div style={{ fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-soft)', marginBottom: 14 }}>
              Session Log
            </div>
            <div
              ref={logRef}
              style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}
            >
              {tradeLog.length === 0 ? (
                <div style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-mute)', padding: '16px 0' }}>
                  No trades this session. Click Buy on a TRADE signal to execute.
                </div>
              ) : [...tradeLog].reverse().map(entry => (
                <div key={entry.id} style={{
                  padding: '8px 10px',
                  background: entry.status === 'error' ? 'rgba(192,57,43,0.06)' : 'rgba(31,138,91,0.04)',
                  border: `1px solid ${entry.status === 'error' ? 'rgba(192,57,43,0.2)' : 'rgba(31,138,91,0.15)'}`,
                  borderRadius: 3,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink)', fontWeight: 500 }}>
                      {entry.outcome}
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)', flexShrink: 0 }}>{entry.ts}</div>
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', marginTop: 2 }}>
                    ${entry.size.toFixed(2)} @ {entry.price.toFixed(1)}¢ · edge +{entry.edge.toFixed(1)}%
                    {entry.dryRun && <span style={{ color: 'var(--amber)', marginLeft: 6 }}>DRY</span>}
                  </div>
                  {entry.message && (
                    <div style={{ fontFamily: 'var(--sans)', fontSize: 11, color: entry.status === 'error' ? 'var(--red)' : 'var(--ink-mute)', marginTop: 3 }}>
                      {entry.message}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

        </div>
      </section>
    </>
  )
}
