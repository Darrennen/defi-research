'use client'

import { useMemo } from 'react'
import type { WhaleAlert } from '@/app/api/slack-events/route'

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

// 9am MYT = 01:00 UTC on the same MYT calendar date
function getSnapshotWindow(): { start: number; end: number; label: string } {
  const now = Date.now()
  const MYT_MS = 8 * 60 * 60 * 1000

  const nowMYT = new Date(now + MYT_MS)
  const todayNineAmUTC = Date.UTC(
    nowMYT.getUTCFullYear(),
    nowMYT.getUTCMonth(),
    nowMYT.getUTCDate(),
    1, 0, 0, 0,
  )

  const snapshotEnd = now >= todayNineAmUTC ? todayNineAmUTC : todayNineAmUTC - 86400000
  const snapshotStart = snapshotEnd - 86400000

  const endMYT = new Date(snapshotEnd + MYT_MS)
  const label = endMYT.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  return { start: snapshotStart, end: snapshotEnd, label }
}

interface EntitySummary {
  entity: string
  volume: number
  txCount: number
  biggestMove: WhaleAlert
  tokens: { name: string; pct: number }[]
  chains: string[]
  recentFlows: { from?: string; to?: string; amount?: number }[]
  hourly: number[] // 24 buckets, oldest first
  lastActivity: number
}

function buildSummaries(alerts: WhaleAlert[], start: number, end: number): EntitySummary[] {
  const window = alerts.filter(a => a.ts >= start && a.ts < end && a.entity)
  const byEntity: Record<string, WhaleAlert[]> = {}

  for (const a of window) {
    const key = a.entity!
    if (!byEntity[key]) byEntity[key] = []
    byEntity[key].push(a)
  }

  return Object.entries(byEntity)
    .map(([entity, txs]): EntitySummary => {
      const volume = txs.reduce((s, a) => s + (a.amount ?? 0), 0)
      const biggestMove = txs.reduce((max, a) => (a.amount ?? 0) > (max.amount ?? 0) ? a : max, txs[0])

      // Token breakdown by volume
      const tokenVol: Record<string, number> = {}
      for (const a of txs) if (a.token && a.amount) tokenVol[a.token] = (tokenVol[a.token] ?? 0) + a.amount
      const totalVol = Object.values(tokenVol).reduce((s, v) => s + v, 0)
      const tokens = Object.entries(tokenVol)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, vol]) => ({ name, pct: totalVol > 0 ? Math.round((vol / totalVol) * 100) : 0 }))

      // Unique chains
      const chains = [...new Set(txs.map(a => a.chain).filter(Boolean))] as string[]

      // Recent notable flows (biggest 3)
      const recentFlows = [...txs]
        .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
        .slice(0, 3)
        .map(a => ({ from: a.fromLabel, to: a.toLabel, amount: a.amount }))

      // Hourly activity (24 buckets from start)
      const hourly = Array(24).fill(0)
      for (const a of txs) {
        const bucket = Math.floor((a.ts - start) / 3600000)
        if (bucket >= 0 && bucket < 24) hourly[bucket] += a.amount ?? 0
      }

      const lastActivity = Math.max(...txs.map(a => a.ts))

      return { entity, volume, txCount: txs.length, biggestMove, tokens, chains, recentFlows, hourly, lastActivity }
    })
    .filter(s => s.volume > 0)
    .sort((a, b) => b.volume - a.volume)
}

function HourlyBar({ hourly }: { hourly: number[] }) {
  const max = Math.max(...hourly, 1)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 28, marginTop: 12 }}>
      {hourly.map((v, i) => (
        <div
          key={i}
          title={`${i}:00–${i + 1}:00 MYT · ${fmtUSD(v)}`}
          style={{
            flex: 1,
            height: `${Math.max((v / max) * 100, v > 0 ? 8 : 2)}%`,
            background: v > 0 ? 'var(--blue)' : 'var(--rule)',
            borderRadius: 1,
            opacity: v > 0 ? 0.85 : 0.3,
            transition: 'height 0.2s',
          }}
        />
      ))}
    </div>
  )
}

function EntityCard({ s }: { s: EntitySummary }) {
  return (
    <div style={{
      background: 'var(--paper)',
      border: '1px solid var(--rule)',
      padding: '20px 22px',
      display: 'flex',
      flexDirection: 'column',
      gap: 0,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 17, fontWeight: 700, color: 'var(--ink)', lineHeight: 1.2 }}>
          {s.entity}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 15, fontWeight: 700, color: 'var(--blue)' }}>
            {fmtUSD(s.volume)}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)', marginTop: 2 }}>
            {s.txCount}tx
          </div>
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--rule)', margin: '14px 0' }} />

      {/* Biggest move */}
      <div style={{ marginBottom: 10 }}>
        <span style={{ fontFamily: 'var(--sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)', marginRight: 8 }}>
          Biggest
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-soft)' }}>
          {s.biggestMove.amountFmt ?? '—'}
          {s.biggestMove.token && (
            <span style={{ marginLeft: 5, padding: '0 4px', border: '1px solid var(--rule)', fontSize: 9, letterSpacing: '0.08em', color: 'var(--ink-mute)' }}>
              {s.biggestMove.token}
            </span>
          )}
        </span>
        {(s.biggestMove.fromLabel || s.biggestMove.toLabel) && (
          <span style={{ fontFamily: 'var(--serif)', fontSize: 11, color: 'var(--ink-mute)', marginLeft: 8 }}>
            {s.biggestMove.fromLabel}
            {s.biggestMove.fromLabel && s.biggestMove.toLabel && <span style={{ margin: '0 3px' }}>→</span>}
            {s.biggestMove.toLabel}
          </span>
        )}
      </div>

      {/* Tokens */}
      {s.tokens.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {s.tokens.map(t => (
            <span key={t.name} style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)', padding: '1px 6px', border: '1px solid var(--rule)' }}>
              {t.name} <span style={{ color: 'var(--ink-soft)' }}>{t.pct}%</span>
            </span>
          ))}
        </div>
      )}

      {/* Chains */}
      {s.chains.length > 0 && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
          {s.chains.map(c => (
            <span key={c} style={{ fontFamily: 'var(--sans)', fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--blue)', padding: '1px 5px', border: '1px solid var(--blue)', opacity: 0.75 }}>
              {c}
            </span>
          ))}
        </div>
      )}

      {/* Key flows */}
      {s.recentFlows.some(f => f.from || f.to) && (
        <div style={{ marginBottom: 4 }}>
          {s.recentFlows.filter(f => f.from || f.to).map((f, i) => (
            <div key={i} style={{ fontFamily: 'var(--serif)', fontSize: 11, color: 'var(--ink-mute)', marginBottom: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {f.amount ? <span style={{ fontFamily: 'var(--mono)', fontSize: 10, marginRight: 6, color: 'var(--ink-soft)' }}>{fmtUSD(f.amount)}</span> : null}
              {f.from}{f.from && f.to && <span style={{ margin: '0 4px', color: 'var(--ink-mute)' }}>→</span>}{f.to}
            </div>
          ))}
        </div>
      )}

      {/* Hourly activity bar */}
      <HourlyBar hourly={s.hourly} />

      {/* Footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-mute)', letterSpacing: '0.06em' }}>
          HOURLY ACTIVITY (MYT)
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-mute)' }}>
          last active {timeAgo(s.lastActivity)}
        </span>
      </div>
    </div>
  )
}

export default function EntityIntelligence({ alerts }: { alerts: WhaleAlert[] }) {
  const { start, end, label } = useMemo(getSnapshotWindow, [])
  const summaries = useMemo(() => buildSummaries(alerts, start, end), [alerts, start, end])

  if (summaries.length === 0) {
    return (
      <div style={{ marginTop: 40 }}>
        <div className="sec-h">
          <span className="h">Entity Intelligence</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>
            24h snapshot · {label}
          </span>
        </div>
        <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-mute)', marginTop: 16 }}>
          No entity activity in this snapshot window yet.
        </p>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 40 }}>
      <div className="sec-h" style={{ marginBottom: 24 }}>
        <span className="h">Entity Intelligence</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>
          24h snapshot ending {label} · {summaries.length} active entities
        </span>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
        gap: 1,
        background: 'var(--rule)',
      }}>
        {summaries.map(s => <EntityCard key={s.entity} s={s} />)}
      </div>
    </div>
  )
}
