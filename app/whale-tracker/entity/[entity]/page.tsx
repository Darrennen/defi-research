'use client'

import { useEffect, useState, useMemo } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts'
import type { WhaleAlert } from '@/app/api/slack-events/route'

const CEX_LABELS = [
  'binance', 'coinbase', 'kraken', 'okx', 'okex', 'bybit', 'kucoin', 'huobi', 'htx',
  'gate.io', 'gateio', 'bitfinex', 'gemini', 'bitget', 'mexc', 'crypto.com', 'upbit',
  'bitstamp', 'bithumb', 'poloniex', 'bittrex', 'ftx', 'deribit', 'robinhood',
]

function isCex(label?: string): boolean {
  if (!label) return false
  const l = label.toLowerCase()
  return CEX_LABELS.some(c => l.includes(c))
}

function fmtUSD(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

const PIE_COLORS = ['#4a90d9', '#e8a838', '#48bb78', '#f56565', '#9f7aea', '#ed8936', '#38b2ac']

interface PatternGroup {
  type: 'RAPID' | 'CEX_RUSH'
  count: number
  destination?: string
  totalAmount: number
  firstTs: number
}

function detectPatternGroups(alerts: WhaleAlert[]): PatternGroup[] {
  const ONE_HOUR = 3600000
  const TWO_HOURS = 7200000
  const sorted = [...alerts].sort((a, b) => a.ts - b.ts)
  const groups: PatternGroup[] = []
  const usedRapid = new Set<number>()
  const usedCex = new Set<number>()

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]

    if (a.toLabel && !usedRapid.has(i)) {
      const idxs = [i]
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].ts - a.ts > ONE_HOUR) break
        if (sorted[j].toLabel === a.toLabel) idxs.push(j)
      }
      if (idxs.length >= 3) {
        idxs.forEach(idx => usedRapid.add(idx))
        groups.push({
          type: 'RAPID',
          count: idxs.length,
          destination: a.toLabel,
          totalAmount: idxs.reduce((s, idx) => s + (sorted[idx].amount ?? 0), 0),
          firstTs: a.ts,
        })
      }
    }

    if (isCex(a.toLabel) && !usedCex.has(i)) {
      const idxs = [i]
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].ts - a.ts > TWO_HOURS) break
        if (isCex(sorted[j].toLabel)) idxs.push(j)
      }
      if (idxs.length >= 3) {
        idxs.forEach(idx => usedCex.add(idx))
        groups.push({
          type: 'CEX_RUSH',
          count: idxs.length,
          destination: a.toLabel,
          totalAmount: idxs.reduce((s, idx) => s + (sorted[idx].amount ?? 0), 0),
          firstTs: a.ts,
        })
      }
    }
  }

  return groups.sort((a, b) => b.firstTs - a.firstTs)
}

function detectAlertFlags(alerts: WhaleAlert[]): Map<string, Array<'RAPID' | 'CEX_RUSH'>> {
  const ONE_HOUR = 3600000
  const TWO_HOURS = 7200000
  const sorted = [...alerts].sort((a, b) => a.ts - b.ts)
  const flags = new Map<string, Array<'RAPID' | 'CEX_RUSH'>>()

  const addFlag = (id: string, type: 'RAPID' | 'CEX_RUSH') => {
    if (!flags.has(id)) flags.set(id, [])
    const arr = flags.get(id)!
    if (!arr.includes(type)) arr.push(type)
  }

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]

    if (a.toLabel) {
      const group = [i]
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].ts - a.ts > ONE_HOUR) break
        if (sorted[j].toLabel === a.toLabel) group.push(j)
      }
      if (group.length >= 3) group.forEach(idx => addFlag(sorted[idx].id, 'RAPID'))
    }

    if (isCex(a.toLabel)) {
      const group = [i]
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].ts - a.ts > TWO_HOURS) break
        if (isCex(sorted[j].toLabel)) group.push(j)
      }
      if (group.length >= 3) group.forEach(idx => addFlag(sorted[idx].id, 'CEX_RUSH'))
    }
  }

  return flags
}

function PatternBadge({ type }: { type: 'RAPID' | 'CEX_RUSH' }) {
  const isCexRush = type === 'CEX_RUSH'
  return (
    <span style={{
      fontFamily: 'var(--mono)',
      fontSize: 9,
      fontWeight: 700,
      padding: '1px 5px',
      letterSpacing: '0.08em',
      background: isCexRush ? 'rgba(192,57,43,0.12)' : 'rgba(178,116,13,0.12)',
      color: isCexRush ? 'var(--red)' : 'var(--amber)',
      border: `1px solid ${isCexRush ? 'var(--red)' : 'var(--amber)'}`,
      whiteSpace: 'nowrap' as const,
    }}>
      {isCexRush ? 'CEX RUSH' : 'RAPID'}
    </span>
  )
}

export default function EntityProfilePage() {
  const params = useParams()
  const entityName = decodeURIComponent(params.entity as string)
  const [alerts, setAlerts] = useState<WhaleAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<'7d' | '30d'>('30d')

  useEffect(() => {
    fetch(`/api/whale-alerts?entity=${encodeURIComponent(entityName)}&limit=5000`)
      .then(r => r.json())
      .then(d => { setAlerts(d.alerts ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [entityName])

  const days = range === '7d' ? 7 : 30
  const cutoff = useMemo(() => Date.now() - days * 86400000, [days])
  const rangeAlerts = useMemo(() => alerts.filter(a => a.ts >= cutoff), [alerts, cutoff])

  const totalVolume = rangeAlerts.reduce((s, a) => s + (a.amount ?? 0), 0)
  const cexOutflow = rangeAlerts.filter(a => isCex(a.toLabel)).reduce((s, a) => s + (a.amount ?? 0), 0)
  const cexPct = totalVolume > 0 ? Math.round((cexOutflow / totalVolume) * 100) : 0
  const signal = cexPct > 50 ? 'Distributing' : cexPct > 20 ? 'Mixed' : 'Accumulating'
  const signalColor = cexPct > 50 ? 'var(--red)' : cexPct > 20 ? 'var(--amber)' : 'var(--green)'

  const biggestMove = rangeAlerts.reduce<WhaleAlert | null>(
    (m, a) => a.amount && (!m || a.amount > (m.amount ?? 0)) ? a : m, null
  )

  const netFlowData = useMemo(() => {
    const now = Date.now()
    const result: { day: string; cex: number; deFi: number }[] = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86400000)
      result.push({ day: `${d.getMonth() + 1}/${d.getDate()}`, cex: 0, deFi: 0 })
    }
    for (const a of rangeAlerts) {
      if (!a.amount) continue
      const d = new Date(a.ts)
      const key = `${d.getMonth() + 1}/${d.getDate()}`
      const bucket = result.find(b => b.day === key)
      if (!bucket) continue
      if (isCex(a.toLabel)) bucket.cex += a.amount
      else bucket.deFi += a.amount
    }
    return result
  }, [rangeAlerts, days])

  const tokenData = useMemo(() => {
    const m: Record<string, number> = {}
    for (const a of rangeAlerts) if (a.token && a.amount) m[a.token] = (m[a.token] ?? 0) + a.amount
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, value]) => ({ name, value }))
  }, [rangeAlerts])

  const destinations = useMemo(() => {
    const m: Record<string, number> = {}
    for (const a of rangeAlerts) if (a.toLabel && a.amount) m[a.toLabel] = (m[a.toLabel] ?? 0) + a.amount
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8)
  }, [rangeAlerts])

  const patternGroups = useMemo(() => detectPatternGroups(rangeAlerts), [rangeAlerts])
  const alertFlags = useMemo(() => detectAlertFlags(rangeAlerts), [rangeAlerts])

  const tokenTotal = tokenData.reduce((s, d) => s + d.value, 0)
  const destMax = destinations[0]?.[1] ?? 1

  const sortedAlerts = useMemo(
    () => [...rangeAlerts].sort((a, b) => b.ts - a.ts),
    [rangeAlerts]
  )

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <Link
          href="/whale-tracker"
          style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-mute)', textDecoration: 'none' }}
        >
          ← Whale Tracker
        </Link>
      </div>

      <div className="page-header">
        <div className="kicker">Entity Profile</div>
        <h1>{entityName}</h1>
        <p className="dek">
          On-chain transaction history and behavioral analysis for this tracked whale.
        </p>
      </div>

      {loading ? (
        <div style={{ padding: '64px 0', textAlign: 'center', color: 'var(--ink-mute)', fontFamily: 'var(--sans)', fontSize: 13, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          <span className="skel" style={{ display: 'inline-block', width: 120, height: 14, borderRadius: 2 }} />
        </div>
      ) : alerts.length === 0 ? (
        <p style={{ fontFamily: 'var(--serif)', fontSize: 17, color: 'var(--ink-mute)', marginTop: 40 }}>
          No alerts found for <strong>{entityName}</strong> in the store.
        </p>
      ) : (
        <>
          {/* Range toggle */}
          <div className="ch-row" style={{ marginTop: 32 }}>
            {(['7d', '30d'] as const).map(r => (
              <button key={r} className={`ch${range === r ? ' on' : ''}`} onClick={() => setRange(r)}>
                {r}
              </button>
            ))}
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', alignSelf: 'center', marginLeft: 4 }}>
              {rangeAlerts.length} transactions · {alerts.length} total
            </span>
          </div>

          {/* Stats */}
          <div className="metrics-row metrics-4" style={{ marginTop: 24 }}>
            <div className="metric-cell">
              <div className="lbl">Total Volume</div>
              <div className="val">{fmtUSD(totalVolume)}</div>
            </div>
            <div className="metric-cell">
              <div className="lbl">Transactions</div>
              <div className="val">{rangeAlerts.length}</div>
            </div>
            <div className="metric-cell">
              <div className="lbl">CEX Outflow</div>
              <div className="val">{fmtUSD(cexOutflow)}</div>
            </div>
            <div className="metric-cell">
              <div className="lbl">Signal ({range})</div>
              <div className="val" style={{ color: signalColor, fontSize: 'clamp(14px, 2vw, 22px)' }}>{signal}</div>
            </div>
          </div>

          {/* Net flow chart */}
          <div style={{ background: 'var(--paper)', padding: '24px 28px', marginTop: 32 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
              <div style={{ fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)' }}>
                Flow Distribution — {range}
              </div>
              <div style={{ display: 'flex', gap: 16, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)' }}>
                <span>
                  <span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--green)', marginRight: 4, borderRadius: 1, verticalAlign: 'middle' }} />
                  DeFi / Other
                </span>
                <span>
                  <span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--red)', marginRight: 4, borderRadius: 1, verticalAlign: 'middle' }} />
                  CEX Outflow
                </span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={netFlowData} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                <XAxis
                  dataKey="day"
                  tick={{ fontFamily: 'var(--mono)', fontSize: 9, fill: 'var(--ink-mute)' }}
                  tickLine={false}
                  axisLine={false}
                  interval={range === '30d' ? 4 : 0}
                />
                <YAxis hide />
                <Tooltip
                  contentStyle={{ background: '#111', border: '1px solid #2a2a2a', fontFamily: 'monospace', fontSize: 11, color: '#ccc' }}
                  labelStyle={{ color: '#ccc' }}
                  itemStyle={{ color: '#ccc' }}
                  formatter={(v: number, name: string) => [fmtUSD(v as number), name === 'deFi' ? 'DeFi / Other' : 'CEX Outflow']}
                />
                <Bar dataKey="deFi" stackId="a" fill="var(--green)" name="DeFi / Other" />
                <Bar dataKey="cex" stackId="a" fill="var(--red)" radius={[2, 2, 0, 0]} name="CEX Outflow" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Token breakdown + Top destinations */}
          <div className="wt-analysis-grid" style={{ marginTop: 1 }}>
            <div style={{ background: 'var(--paper)', padding: '24px 28px' }}>
              <div style={{ fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)', marginBottom: 16 }}>
                Volume by Token
              </div>
              {tokenData.length === 0 ? (
                <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-mute)' }}>No token data</p>
              ) : (
                <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                  <PieChart width={90} height={90}>
                    <Pie data={tokenData} cx={45} cy={45} innerRadius={24} outerRadius={42} dataKey="value" strokeWidth={0}>
                      {tokenData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                  </PieChart>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {tokenData.map((d, i) => (
                      <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: PIE_COLORS[i % PIE_COLORS.length], flexShrink: 0 }} />
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-soft)', flex: 1 }}>{d.name}</span>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>
                          {tokenTotal > 0 ? `${((d.value / tokenTotal) * 100).toFixed(0)}%` : '—'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div style={{ background: 'var(--paper)', padding: '24px 28px' }}>
              <div style={{ fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)', marginBottom: 16 }}>
                Top Destinations
              </div>
              {destinations.length === 0 ? (
                <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-mute)' }}>No destination data</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {destinations.map(([dest, vol], i) => (
                    <div key={dest}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                        <span style={{ fontFamily: 'var(--serif)', fontSize: 12, color: isCex(dest) ? 'var(--red)' : 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '65%' }}>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-mute)', marginRight: 5 }}>#{i + 1}</span>
                          {dest}
                          {isCex(dest) && (
                            <span style={{ marginLeft: 5, fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--red)', letterSpacing: '0.05em' }}>CEX</span>
                          )}
                        </span>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', flexShrink: 0, marginLeft: 8 }}>
                          {fmtUSD(vol)}
                        </span>
                      </div>
                      <div style={{ height: 2, borderRadius: 1, background: 'var(--rule)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${(vol / destMax) * 100}%`, background: isCex(dest) ? 'var(--red)' : 'var(--blue)', borderRadius: 1 }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Detected patterns */}
          {patternGroups.length > 0 && (
            <div style={{ background: 'var(--paper)', padding: '24px 28px', marginTop: 1 }}>
              <div style={{ fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)', marginBottom: 16 }}>
                Detected Patterns — {range}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {patternGroups.map((g, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      gap: 12,
                      alignItems: 'flex-start',
                      padding: '10px 14px',
                      border: `1px solid ${g.type === 'CEX_RUSH' ? 'rgba(192,57,43,0.25)' : 'rgba(178,116,13,0.25)'}`,
                      background: g.type === 'CEX_RUSH' ? 'rgba(192,57,43,0.05)' : 'rgba(178,116,13,0.05)',
                    }}
                  >
                    <PatternBadge type={g.type} />
                    <div>
                      <div style={{ fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink)', marginBottom: 3 }}>
                        {g.type === 'CEX_RUSH'
                          ? `${g.count} CEX transfers within 2 hours`
                          : `${g.count} transfers to ${g.destination} within 1 hour`}
                      </div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>
                        Total: {fmtUSD(g.totalAmount)} · {timeAgo(g.firstTs)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Biggest move strip */}
          {biggestMove && (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '14px 0', borderBottom: '1px solid var(--rule)', marginTop: 28, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-mute)', flexShrink: 0 }}>
                Biggest ({range})
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 15, fontWeight: 700, color: 'var(--blue)' }}>
                {biggestMove.amountFmt}
              </span>
              {biggestMove.token && (
                <span style={{ fontFamily: 'var(--sans)', fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)', padding: '1px 5px', border: '1px solid var(--rule)' }}>
                  {biggestMove.token}
                </span>
              )}
              {(biggestMove.fromLabel || biggestMove.toLabel) && (
                <span style={{ fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink-mute)' }}>
                  {biggestMove.fromLabel}{biggestMove.fromLabel && biggestMove.toLabel ? ' → ' : ''}{biggestMove.toLabel}
                </span>
              )}
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', marginLeft: 'auto' }}>
                {timeAgo(biggestMove.ts)}
              </span>
            </div>
          )}

          {/* Transaction history */}
          <div style={{ marginTop: 32 }}>
            <div className="sec-h" style={{ marginBottom: 16 }}>
              <span className="h">Transaction History</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>
                {rangeAlerts.length} tx · {range}
              </span>
            </div>
            <div className="table-scroll-x">
              <table className="tab">
                <thead>
                  <tr>
                    <th>Amount</th>
                    <th style={{ textAlign: 'left' }}>Token</th>
                    <th style={{ textAlign: 'left' }}>Chain</th>
                    <th style={{ textAlign: 'left' }}>Flow</th>
                    <th style={{ textAlign: 'left' }}>Flags</th>
                    <th style={{ textAlign: 'right' }}>Time</th>
                    <th style={{ textAlign: 'right' }}>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAlerts.map(a => {
                    const flags = alertFlags.get(a.id) ?? []
                    return (
                      <tr key={a.id}>
                        <td className="pos" style={{ fontWeight: 600, textAlign: 'right' }}>{a.amountFmt ?? '—'}</td>
                        <td style={{ textAlign: 'left' }}>
                          {a.token ? (
                            <span style={{ fontFamily: 'var(--sans)', fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)', padding: '1px 5px', border: '1px solid var(--rule)' }}>
                              {a.token}
                            </span>
                          ) : '—'}
                        </td>
                        <td style={{ textAlign: 'left' }}>
                          {a.chain ? (
                            <span style={{ fontFamily: 'var(--sans)', fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--blue)', padding: '1px 5px', border: '1px solid var(--blue)', opacity: 0.85 }}>
                              {a.chain}
                            </span>
                          ) : '—'}
                        </td>
                        <td style={{ textAlign: 'left', fontFamily: 'var(--serif)', fontSize: 12, color: 'var(--ink-mute)' }}>
                          {a.fromLabel || a.toLabel ? (
                            <>
                              {a.fromLabel}
                              {a.fromLabel && a.toLabel && (
                                <span style={{ margin: '0 4px' }}>→</span>
                              )}
                              {a.toLabel && (
                                <span style={{ color: isCex(a.toLabel) ? 'var(--red)' : 'inherit' }}>
                                  {a.toLabel}
                                </span>
                              )}
                            </>
                          ) : '—'}
                        </td>
                        <td style={{ textAlign: 'left' }}>
                          {flags.length > 0 ? (
                            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                              {flags.map(type => <PatternBadge key={type} type={type} />)}
                            </div>
                          ) : ''}
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-mute)', whiteSpace: 'nowrap' }}>
                          {timeAgo(a.ts)}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                            {a.arkhamUrl && (
                              <a href={a.arkhamUrl} target="_blank" rel="noopener noreferrer"
                                style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--blue)', textDecoration: 'none' }}>
                                Arkham ↗
                              </a>
                            )}
                            {a.txUrl && (
                              <a href={a.txUrl} target="_blank" rel="noopener noreferrer"
                                style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', textDecoration: 'none' }}>
                                Explorer ↗
                              </a>
                            )}
                            {!a.arkhamUrl && !a.txUrl && '—'}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
