'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie,
} from 'recharts'
import type { WhaleAlert } from '@/app/api/slack-events/route'
import EntityIntelligence from './EntityIntelligence'

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

function alertTowardsCex(alert: WhaleAlert): boolean {
  return isCex(alert.toLabel) || isCex(alert.fromLabel) && !isCex(alert.toLabel) ? false : isCex(alert.toLabel)
}

function alertAwayFromCex(alert: WhaleAlert): boolean {
  return isCex(alert.fromLabel) && !isCex(alert.toLabel)
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

function fmtUSD(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

function dayLabel(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

const PIE_COLORS = ['#4a90d9', '#e8a838', '#48bb78', '#f56565', '#9f7aea', '#ed8936', '#38b2ac']

// ── Analysis components ──────────────────────────────────────────────────────

function VolumeChart({ alerts }: { alerts: WhaleAlert[] }) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  const { data, dayAlertsMap } = useMemo(() => {
    const buckets: Record<string, number> = {}
    const map: Record<string, WhaleAlert[]> = {}
    const now = Date.now()
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now - i * 86400000)
      const key = `${d.getMonth() + 1}/${d.getDate()}`
      buckets[key] = 0
      map[key] = []
    }
    for (const a of alerts) {
      if (!a.amount) continue
      const label = dayLabel(a.ts)
      if (label in buckets) {
        buckets[label] += a.amount
        map[label].push(a)
      }
    }
    // Sort each day's alerts by amount desc
    for (const key of Object.keys(map)) map[key].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
    return { data: Object.entries(buckets).map(([day, vol]) => ({ day, vol })), dayAlertsMap: map }
  }, [alerts])

  const maxVol = Math.max(...data.map(d => d.vol), 1)
  const selectedAlerts = selectedDay ? (dayAlertsMap[selectedDay] ?? []) : []
  const totalForDay = selectedAlerts.reduce((s, a) => s + (a.amount ?? 0), 0)

  // Entity breakdown for selected day
  const dayEntities = useMemo(() => {
    const m: Record<string, number> = {}
    for (const a of selectedAlerts) if (a.entity) m[a.entity] = (m[a.entity] ?? 0) + (a.amount ?? 0)
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5)
  }, [selectedAlerts])

  return (
    <div>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart
          data={data}
          margin={{ top: 4, right: 0, left: 0, bottom: 0 }}
          onClick={e => {
            const day = e?.activeLabel as string | undefined
            setSelectedDay(prev => prev === day ? null : (day ?? null))
          }}
          style={{ cursor: 'pointer' }}
        >
          <XAxis
            dataKey="day"
            tick={{ fontFamily: 'var(--mono)', fontSize: 9, fill: 'var(--ink-mute)' }}
            tickLine={false}
            axisLine={false}
            interval={4}
          />
          <YAxis hide />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.06)' }}
            contentStyle={{ background: '#111', border: '1px solid #2a2a2a', fontFamily: 'monospace', fontSize: 11, color: '#ccc' }}
            labelStyle={{ color: '#ccc' }}
            itemStyle={{ color: '#ccc' }}
            formatter={(v: number, _: string, p) => [
              `${fmtUSD(v as number)} · ${dayAlertsMap[(p?.payload as { day?: string })?.day ?? '']?.length ?? 0} txs`,
              'Volume',
            ]}
          />
          <Bar dataKey="vol" radius={[2, 2, 0, 0]}>
            {data.map((d, i) => (
              <Cell
                key={i}
                fill={d.day === selectedDay ? '#7ab8f5' : d.vol > maxVol * 0.6 ? 'var(--blue)' : 'var(--rule)'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* Day drill-down panel */}
      {selectedDay && selectedAlerts.length > 0 && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--rule)', paddingTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)' }}>
              {selectedDay} — {fmtUSD(totalForDay)} across {selectedAlerts.length} txs
            </span>
            <button onClick={() => setSelectedDay(null)} style={{ background: 'none', border: 'none', color: 'var(--ink-mute)', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11 }}>
              ✕ close
            </button>
          </div>

          {/* Top entities that day */}
          {dayEntities.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {dayEntities.map(([entity, vol]) => (
                <span key={entity} style={{ fontFamily: 'var(--mono)', fontSize: 10, padding: '2px 8px', border: '1px solid var(--rule)', color: 'var(--ink-soft)' }}>
                  {entity} <span style={{ color: 'var(--blue)' }}>{fmtUSD(vol)}</span>
                </span>
              ))}
            </div>
          )}

          {/* Transaction list */}
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            <table className="tab" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Entity</th>
                  <th>Amount</th>
                  <th style={{ textAlign: 'left' }}>Token</th>
                  <th style={{ textAlign: 'left' }}>Flow</th>
                  <th style={{ textAlign: 'right' }}>Time</th>
                </tr>
              </thead>
              <tbody>
                {selectedAlerts.map(a => (
                  <tr key={a.id}>
                    <td className="name" style={{ fontSize: 12 }}>{a.entity ?? '—'}</td>
                    <td className="pos" style={{ fontWeight: 600, fontSize: 12 }}>{a.amountFmt ?? '—'}</td>
                    <td style={{ textAlign: 'left' }}>
                      {a.token ? <span style={{ fontFamily: 'var(--mono)', fontSize: 9, padding: '1px 4px', border: '1px solid var(--rule)', color: 'var(--ink-mute)' }}>{a.token}</span> : '—'}
                    </td>
                    <td style={{ textAlign: 'left', fontFamily: 'var(--serif)', fontSize: 11, color: 'var(--ink-mute)' }}>
                      {a.fromLabel}{a.fromLabel && a.toLabel ? ' → ' : ''}{a.toLabel}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', whiteSpace: 'nowrap' }}>
                      {new Date(a.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function BreakdownChart({ alerts, field, title }: { alerts: WhaleAlert[], field: 'token' | 'chain', title: string }) {
  const data = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const a of alerts) {
      const key = a[field]
      if (!key || !a.amount) continue
      counts[key] = (counts[key] ?? 0) + a.amount
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, value]) => ({ name, value }))
  }, [alerts, field])

  const total = data.reduce((s, d) => s + d.value, 0)

  return (
    <div>
      <div style={{ fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)', marginBottom: 12 }}>
        {title}
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <PieChart width={100} height={100}>
          <Pie
            data={data}
            cx={50} cy={50}
            innerRadius={28} outerRadius={46}
            dataKey="value"
            strokeWidth={0}
          >
            {data.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
          </Pie>
        </PieChart>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {data.map((d, i) => (
            <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: PIE_COLORS[i % PIE_COLORS.length], flexShrink: 0 }} />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-soft)', flex: 1 }}>{d.name}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>
                {total > 0 ? `${((d.value / total) * 100).toFixed(0)}%` : '—'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function CexFlowBar({ alerts }: { alerts: WhaleAlert[] }) {
  const { inflow, outflow } = useMemo(() => {
    let inflow = 0, outflow = 0
    const todayStart = new Date().setHours(0, 0, 0, 0)
    for (const a of alerts) {
      if (a.ts < todayStart || !a.amount) continue
      if (alertTowardsCex(a)) inflow += a.amount
      else if (alertAwayFromCex(a)) outflow += a.amount
    }
    return { inflow, outflow }
  }, [alerts])

  const total = inflow + outflow
  const inflowPct = total > 0 ? (inflow / total) * 100 : 50
  const net = outflow - inflow
  const netFmt = fmtUSD(Math.abs(net))
  const signal = net > 0 ? 'Net outflow' : net < 0 ? 'Net inflow' : 'Neutral'
  const signalColor = net > 0 ? 'var(--green)' : net < 0 ? 'var(--red)' : 'var(--ink-mute)'

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--green)' }}>Out {fmtUSD(outflow)}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)' }}>In {fmtUSD(inflow)}</span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: 'var(--rule)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${100 - inflowPct}%`, background: 'var(--green)', borderRadius: 4, transition: 'width 0.4s ease' }} />
      </div>
      <div style={{ marginTop: 8, fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', color: signalColor }}>
        {signal} {total > 0 ? netFmt : ''}{net !== 0 ? (net > 0 ? ' → accumulation signal' : ' → sell pressure signal') : ''}
      </div>
    </div>
  )
}

function EntityLeaderboard({ alerts }: { alerts: WhaleAlert[] }) {
  const rows = useMemo(() => {
    const map: Record<string, { volume: number, count: number }> = {}
    for (const a of alerts) {
      if (!a.entity || !a.amount) continue
      if (!map[a.entity]) map[a.entity] = { volume: 0, count: 0 }
      map[a.entity].volume += a.amount
      map[a.entity].count++
    }
    return Object.entries(map)
      .sort((a, b) => b[1].volume - a[1].volume)
      .slice(0, 10)
  }, [alerts])

  if (rows.length === 0) {
    return <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-mute)' }}>No data yet</p>
  }

  const maxVol = rows[0][1].volume

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map(([entity, { volume, count }], i) => (
        <div key={entity}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink)' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)', marginRight: 8 }}>#{i + 1}</span>
              {entity}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', marginLeft: 12, whiteSpace: 'nowrap' }}>
              {fmtUSD(volume)} · {count}tx
            </span>
          </div>
          <div style={{ height: 3, borderRadius: 2, background: 'var(--rule)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(volume / maxVol) * 100}%`, background: 'var(--blue)', borderRadius: 2 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function WhaleTrackerPage() {
  const [alerts, setAlerts] = useState<WhaleAlert[]>([])
  const [updatedAt, setUpdatedAt] = useState<number>(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [chain, setChain] = useState('All')
  const [search, setSearch] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [hideCex, setHideCex] = useState(true)
  const [analysisOpen, setAnalysisOpen] = useState(true)
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 720)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

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

  const runSync = useCallback(async (silent = false) => {
    if (!silent) setSyncing(true)
    setSyncMsg(null)
    try {
      const res = await fetch('/api/backfill-alerts', { method: 'POST' })
      const data = await res.json()
      if (data.ok) {
        if (data.stored > 0) {
          fetchAlerts()
          if (!silent) setSyncMsg(`Synced ${data.stored} new alerts`)
        } else if (!silent) {
          setSyncMsg('Already up to date')
        }
      } else if (!silent) {
        setSyncMsg(`Error: ${data.error}`)
      }
    } catch {
      if (!silent) setSyncMsg('Sync failed')
    } finally {
      if (!silent) setSyncing(false)
    }
  }, [fetchAlerts])

  useEffect(() => {
    fetchAlerts()
    runSync(true) // auto-sync on mount, silently
    const id = setInterval(fetchAlerts, 30_000)
    return () => clearInterval(id)
  }, [fetchAlerts, runSync])

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
            onClick={() => runSync(false)}
            disabled={syncing}
            style={{ fontSize: 12, padding: '10px 18px', opacity: syncing ? 0.6 : 1 }}
          >
            {syncing ? 'Syncing…' : 'Force Sync'} <span className="arr">↺</span>
          </button>
          {syncMsg && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: syncMsg.startsWith('Error') || syncMsg.startsWith('Sync') ? 'var(--red)' : 'var(--green)' }}>
              {syncMsg}
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

      {/* ── Analysis Section ── */}
      {!loading && !error && alerts.length > 0 && (
        <div style={{ marginTop: 40 }}>
          <div
            className="sec-h"
            style={{ marginBottom: analysisOpen ? 24 : 0, cursor: 'pointer', userSelect: 'none' }}
            onClick={() => setAnalysisOpen(v => !v)}
          >
            <span className="h">Analysis</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>
              {alerts.length} alerts · last 30 days
            </span>
            <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-mute)' }}>
              {analysisOpen ? '▲' : '▼'}
            </span>
          </div>

          {analysisOpen && (
            <div className="wt-analysis-grid">

              {/* Volume over time — full width */}
              <div className="wt-analysis-full" style={{ background: 'var(--paper)', padding: '24px 28px' }}>
                <div style={{ fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)', marginBottom: 16 }}>
                  Daily Volume — Last 30 Days
                </div>
                <VolumeChart alerts={alerts} />
              </div>

              {/* Token breakdown */}
              <div style={{ background: 'var(--paper)', padding: '24px 28px' }}>
                <BreakdownChart alerts={alerts} field="token" title="Volume by Token" />
              </div>

              {/* Chain breakdown */}
              <div style={{ background: 'var(--paper)', padding: '24px 28px' }}>
                <BreakdownChart alerts={alerts} field="chain" title="Volume by Chain" />
              </div>

              {/* CEX flow */}
              <div style={{ background: 'var(--paper)', padding: '24px 28px' }}>
                <div style={{ fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)', marginBottom: 16 }}>
                  CEX Flow Today
                </div>
                <CexFlowBar alerts={alerts} />
              </div>

              {/* Entity leaderboard */}
              <div style={{ background: 'var(--paper)', padding: '24px 28px' }}>
                <div style={{ fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)', marginBottom: 16 }}>
                  Top Whales by Volume
                </div>
                <EntityLeaderboard alerts={alerts} />
              </div>

            </div>
          )}
        </div>
      )}

      {/* Entity Intelligence */}
      {!loading && !error && alerts.length > 0 && (
        <EntityIntelligence alerts={alerts} />
      )}

      {/* Chain filter + search */}
      <div className="ch-row" style={{ marginTop: 40, alignItems: 'center' }}>
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
        <div style={{ marginTop: 24 }}>
          {filtered.length === 0 && (
            <p style={{ textAlign: 'center', padding: '64px 0', fontFamily: 'var(--serif)', fontSize: 17, color: 'var(--ink-mute)' }}>
              No alerts yet — once Arkham posts to <strong>#alerts</strong>, moves will appear here automatically.
            </p>
          )}

          {/* Mobile card list */}
          {isMobile && filtered.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--rule)' }}>
              {filtered.map(alert => (
                <div key={alert.id} style={{ background: 'var(--paper)', padding: '14px 16px' }}>
                  {/* Row 1: entity + amount */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div className="name" style={{ fontSize: 15 }}>
                      {alert.entity ?? (alert.address ? shortAddr(alert.address) : '—')}
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 15, fontWeight: 700, color: 'var(--blue)', flexShrink: 0, marginLeft: 12 }}>
                      {alert.amountFmt ?? '—'}
                    </div>
                  </div>
                  {/* Row 2: chips + time */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                    {alert.token && (
                      <span style={{ fontFamily: 'var(--sans)', fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)', padding: '1px 5px', border: '1px solid var(--rule)' }}>
                        {alert.token}
                      </span>
                    )}
                    {alert.chain && (
                      <span style={{ fontFamily: 'var(--sans)', fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--blue)', padding: '1px 5px', border: '1px solid var(--blue)', opacity: 0.85 }}>
                        {alert.chain}
                      </span>
                    )}
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', marginLeft: 'auto' }}>
                      {timeAgo(alert.ts)}
                    </span>
                  </div>
                  {/* Row 3: flow */}
                  {(alert.fromLabel || alert.toLabel) && (
                    <div style={{ fontFamily: 'var(--serif)', fontSize: 12, color: 'var(--ink-mute)', marginBottom: 8 }}>
                      {alert.fromLabel}
                      {alert.fromLabel && alert.toLabel && <span style={{ margin: '0 4px' }}>→</span>}
                      {alert.toLabel}
                    </div>
                  )}
                  {/* Row 4: links */}
                  {(alert.arkhamUrl || alert.txUrl) && (
                    <div style={{ display: 'flex', gap: 12 }}>
                      {alert.arkhamUrl && (
                        <a href={alert.arkhamUrl} target="_blank" rel="noopener noreferrer"
                          style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--blue)', textDecoration: 'none' }}>
                          Arkham ↗
                        </a>
                      )}
                      {alert.txUrl && (
                        <a href={alert.txUrl} target="_blank" rel="noopener noreferrer"
                          style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', textDecoration: 'none' }}>
                          Explorer ↗
                        </a>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Desktop table */}
          {!isMobile && filtered.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
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
                  {filtered.map(alert => (
                    <tr key={alert.id}>
                      <td className="name">
                        {alert.entity ?? (alert.address ? shortAddr(alert.address) : '—')}
                        {alert.address && alert.entity && (
                          <span className="sym">{shortAddr(alert.address)}</span>
                        )}
                      </td>
                      <td className="pos" style={{ fontWeight: 600 }}>{alert.amountFmt ?? '—'}</td>
                      <td style={{ textAlign: 'left' }}>
                        {alert.token ? (
                          <span style={{ fontFamily: 'var(--sans)', fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)', padding: '1px 5px', border: '1px solid var(--rule)' }}>
                            {alert.token}
                          </span>
                        ) : '—'}
                      </td>
                      <td style={{ textAlign: 'left' }}>
                        {alert.chain ? (
                          <span style={{ fontFamily: 'var(--sans)', fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--blue)', padding: '1px 5px', border: '1px solid var(--blue)', opacity: 0.85 }}>
                            {alert.chain}
                          </span>
                        ) : '—'}
                      </td>
                      <td style={{ textAlign: 'left', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        {alert.direction ?? '—'}
                      </td>
                      <td style={{ textAlign: 'left' }}>
                        {alert.fromLabel || alert.toLabel ? (
                          <span style={{ fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink-soft)' }}>
                            {alert.fromLabel}
                            {alert.fromLabel && alert.toLabel && <span style={{ color: 'var(--ink-mute)', margin: '0 4px' }}>→</span>}
                            {alert.toLabel}
                          </span>
                        ) : <span style={{ color: 'var(--ink-mute)' }}>—</span>}
                      </td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-mute)' }}>
                        {timeAgo(alert.ts)}
                      </td>
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
                              Explorer ↗
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
        </div>
      )}

      {/* Raw message panel */}
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
