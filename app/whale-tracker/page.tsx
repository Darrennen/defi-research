'use client'

import { useEffect, useState, useCallback } from 'react'
import type { WhaleAlert } from '@/app/api/slack-events/route'

const CHAINS = ['All', 'Ethereum', 'Arbitrum', 'Base', 'Polygon', 'Optimism', 'Solana', 'BSC']

const CEX_LABELS = [
  'binance', 'coinbase', 'kraken', 'okx', 'okex', 'bybit', 'kucoin', 'huobi', 'htx',
  'gate.io', 'gateio', 'bitfinex', 'gemini', 'bitget', 'mexc', 'crypto.com', 'upbit',
  'bitstamp', 'bithumb', 'poloniex', 'bittrex', 'ftx', 'deribit', 'robinhood',
]

function isCex(label?: string): boolean {
  if (!label) return false
  const l = label.toLowerCase()
  return CEX_LABELS.some(cex => l.includes(cex))
}

function alertInvolvesCex(alert: WhaleAlert): boolean {
  return isCex(alert.entity) || isCex(alert.toLabel) || isCex(alert.fromLabel)
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export default function WhaleTrackerPage() {
  const [alerts, setAlerts] = useState<WhaleAlert[]>([])
  const [updatedAt, setUpdatedAt] = useState<number>(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [chain, setChain] = useState('All')
  const [search, setSearch] = useState('')
  const [backfilling, setBackfilling] = useState(false)
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null)
  const [hideCex, setHideCex] = useState(true)

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch('/api/whale-alerts?limit=200')
      const data = await res.json()
      if (data.alerts) {
        setAlerts(data.alerts)
        setUpdatedAt(data.updatedAt)
        setError(null)
      }
    } catch {
      setError('Could not reach alert store')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAlerts()
    const id = setInterval(fetchAlerts, 30_000)
    return () => clearInterval(id)
  }, [fetchAlerts])

  const runBackfill = async () => {
    setBackfilling(true)
    setBackfillMsg(null)
    try {
      const res = await fetch('/api/backfill-alerts', { method: 'POST' })
      const data = await res.json()
      if (data.ok) {
        setBackfillMsg(`Loaded ${data.stored} alerts from the last 30 days`)
        fetchAlerts()
      } else {
        setBackfillMsg(`Error: ${data.error}`)
      }
    } catch {
      setBackfillMsg('Failed to reach backfill endpoint')
    } finally {
      setBackfilling(false)
    }
  }

  const todayStart = new Date().setHours(0, 0, 0, 0)
  const todayAlerts = alerts.filter(a => a.ts >= todayStart)

  const biggest = todayAlerts.reduce<WhaleAlert | null>(
    (max, a) => a.amount && (!max || a.amount > (max.amount ?? 0)) ? a : max,
    null
  )

  const entityCounts: Record<string, number> = {}
  todayAlerts.forEach(a => {
    if (a.entity) entityCounts[a.entity] = (entityCounts[a.entity] ?? 0) + 1
  })
  const topEntity = Object.entries(entityCounts).sort((a, b) => b[1] - a[1])[0]

  const filtered = alerts.filter(a => {
    if (hideCex && alertInvolvesCex(a)) return false
    if (chain !== 'All' && a.chain !== chain) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        a.entity?.toLowerCase().includes(q) ||
        a.token?.toLowerCase().includes(q) ||
        a.address?.toLowerCase().includes(q) ||
        a.raw.toLowerCase().includes(q)
      )
    }
    return true
  })

  const updatedStr = updatedAt
    ? new Date(updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null

  return (
    <div>
      {/* Page header */}
      <div className="page-header">
        <div className="kicker">Whale Intelligence</div>
        <h1>Whale Alert <em>Tracker</em></h1>
        <p className="dek">
          Real-time on-chain whale movements from Arkham Intelligence — streamed from Slack into a live feed. Refreshes every 30 seconds.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 20, flexWrap: 'wrap' }}>
          <button
            className="btn ghost"
            onClick={runBackfill}
            disabled={backfilling}
            style={{ fontSize: 12, padding: '10px 18px', opacity: backfilling ? 0.6 : 1 }}
          >
            {backfilling ? 'Loading…' : 'Load 30-day History'} <span className="arr">↓</span>
          </button>
          {backfillMsg && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: backfillMsg.startsWith('Error') ? 'var(--red)' : 'var(--green)' }}>
              {backfillMsg}
            </span>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="metrics-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="metric-cell">
          <div className="lbl">Alerts Today</div>
          <div className="val">{todayAlerts.length}</div>
        </div>
        <div className="metric-cell">
          <div className="lbl">Biggest Move</div>
          <div className="val">{biggest?.amountFmt ?? '—'}</div>
        </div>
        <div className="metric-cell">
          <div className="lbl">Most Active Entity</div>
          <div className="val" style={{ fontSize: 'clamp(16px, 2vw, 22px)' }}>
            {topEntity?.[0] ?? '—'}
          </div>
        </div>
        <div className="metric-cell">
          <div className="lbl">Feed Status</div>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
              {!error && <span className="live-dot" />}
              <span style={{ color: error ? 'var(--red)' : 'var(--ink)' }}>
                {loading ? 'Connecting' : error ? 'Error' : 'Live'}
              </span>
            </span>
            {updatedStr && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>
                Updated {updatedStr}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Chain filter + search */}
      <div className="ch-row" style={{ marginTop: 32, alignItems: 'center' }}>
        {CHAINS.map(c => (
          <button key={c} className={`ch${chain === c ? ' on' : ''}`} onClick={() => setChain(c)}>
            {c}
          </button>
        ))}
        <button
          className={`ch${hideCex ? ' on' : ''}`}
          onClick={() => setHideCex(v => !v)}
          style={{ borderColor: hideCex ? 'var(--amber)' : undefined, color: hideCex ? 'var(--amber)' : undefined, background: hideCex ? 'rgba(178,116,13,0.12)' : undefined }}
        >
          Hide CEX
        </button>
        <input
          type="text"
          placeholder="Search entity, token, address…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            flex: 1,
            minWidth: 180,
            padding: '5px 10px',
            border: '1px solid var(--rule)',
            background: 'transparent',
            color: 'var(--ink)',
            fontFamily: 'var(--mono)',
            fontSize: 12,
            outline: 'none',
          }}
        />
      </div>

      {/* Alert table */}
      {loading && (
        <div style={{ padding: '64px 0', textAlign: 'center', color: 'var(--ink-mute)', fontFamily: 'var(--sans)', fontSize: 13, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          <span className="skel" style={{ display: 'inline-block', width: 120, height: 14, borderRadius: 2 }} />
        </div>
      )}

      {!loading && error && (
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <p style={{ fontFamily: 'var(--serif)', fontSize: 18, color: 'var(--red)', marginBottom: 8 }}>{error}</p>
          <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-mute)' }}>
            Check that UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set in your environment.
          </p>
        </div>
      )}

      {!loading && !error && (
        <div style={{ marginTop: 24, overflowX: 'auto' }}>
          <table className="tab">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Entity / Wallet</th>
                <th>Amount</th>
                <th style={{ textAlign: 'left' }}>Token</th>
                <th style={{ textAlign: 'left' }}>Chain</th>
                <th style={{ textAlign: 'left' }}>Direction</th>
                <th style={{ textAlign: 'left' }}>Flow</th>
                <th style={{ textAlign: 'right' }}>Time</th>
                <th style={{ textAlign: 'right' }}>Tx</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '64px 0', fontFamily: 'var(--serif)', fontSize: 17, color: 'var(--ink-mute)' }}>
                    No alerts yet — once Arkham posts to <strong>#alerts</strong>, moves will appear here automatically.
                  </td>
                </tr>
              )}
              {filtered.map(alert => (
                <tr key={alert.id}>
                  {/* Entity */}
                  <td className="name">
                    {alert.entity ?? (alert.address ? shortAddr(alert.address) : '—')}
                    {alert.address && alert.entity && (
                      <span className="sym">{shortAddr(alert.address)}</span>
                    )}
                  </td>

                  {/* Amount */}
                  <td className="pos" style={{ fontWeight: 600 }}>
                    {alert.amountFmt ?? '—'}
                  </td>

                  {/* Token chip */}
                  <td style={{ textAlign: 'left' }}>
                    {alert.token ? (
                      <span style={{ fontFamily: 'var(--sans)', fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)', padding: '1px 5px', border: '1px solid var(--rule)' }}>
                        {alert.token}
                      </span>
                    ) : '—'}
                  </td>

                  {/* Chain chip */}
                  <td style={{ textAlign: 'left' }}>
                    {alert.chain ? (
                      <span style={{ fontFamily: 'var(--sans)', fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--blue)', padding: '1px 5px', border: '1px solid var(--blue)', opacity: 0.85 }}>
                        {alert.chain}
                      </span>
                    ) : '—'}
                  </td>

                  {/* Direction */}
                  <td style={{ textAlign: 'left', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {alert.direction ?? '—'}
                  </td>

                  {/* From → To */}
                  <td style={{ textAlign: 'left' }}>
                    {alert.fromLabel || alert.toLabel ? (
                      <span style={{ fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink-soft)' }}>
                        {alert.fromLabel}
                        {alert.fromLabel && alert.toLabel && (
                          <span style={{ color: 'var(--ink-mute)', margin: '0 4px' }}>→</span>
                        )}
                        {alert.toLabel}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--ink-mute)' }}>—</span>
                    )}
                  </td>

                  {/* Time */}
                  <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-mute)' }}>
                    {timeAgo(alert.ts)}
                  </td>

                  {/* Tx links */}
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center' }}>
                      {alert.arkhamUrl && (
                        <a href={alert.arkhamUrl} target="_blank" rel="noopener noreferrer"
                          style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--blue)', textDecoration: 'none' }}>
                          Arkham ↗
                        </a>
                      )}
                      {alert.txUrl && (
                        <a href={alert.txUrl} target="_blank" rel="noopener noreferrer"
                          style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', textDecoration: 'none' }}>
                          Etherscan ↗
                        </a>
                      )}
                      {!alert.arkhamUrl && !alert.txUrl && '—'}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Raw message panel — shown when parsing extracted nothing meaningful */}
      {!loading && !error && filtered.some(a => !a.amountFmt && !a.entity) && (
        <div style={{ marginTop: 32, borderTop: '1px solid var(--rule)', paddingTop: 24 }}>
          <div className="sec-h" style={{ marginBottom: 16 }}>
            <span className="h">Unstructured Alerts</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>
              Arkham messages that couldn&apos;t be fully parsed
            </span>
          </div>
          <div>
            {filtered.filter(a => !a.amountFmt && !a.entity).map(alert => (
              <div key={alert.id} style={{ borderBottom: '1px solid var(--rule-soft)', padding: '12px 0', display: 'grid', gridTemplateColumns: '1fr auto', gap: 16, alignItems: 'start' }}>
                <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-soft)', margin: 0, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {alert.raw}
                </p>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', whiteSpace: 'nowrap' }}>
                  {timeAgo(alert.ts)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
