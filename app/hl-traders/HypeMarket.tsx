'use client'

import { useEffect, useState, useCallback } from 'react'

type Market = {
  ts: number
  hype: {
    price: number; oraclePx: number; change24hPct: number
    oiCoins: number; oiUsd: number; volume24h: number
    fundingHourly: number; fundingAnnualizedPct: number
  }
  platform: { totalVolume24h: number; totalOiUsd: number; perpCount: number }
  buyback: { hypeHeld: number; currentValueUsd: number }
  fees: { day: number | null; week: number | null; month: number | null; revenueDay: number | null }
}

const usd = (n: number | null | undefined, d = 2) =>
  n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
const compact = (n: number | null | undefined) => {
  if (n == null) return '—'
  const a = Math.abs(n)
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}
const num = (n: number, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d })
const pct = (n: number, d = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`
const signColor = (n: number) => (n > 0 ? 'var(--green)' : n < 0 ? 'var(--red)' : 'var(--ink-soft)')

function Metric({ label, value, sub, color, hint }: {
  label: string; value: string; sub?: string; color?: string; hint?: string
}) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-mute)' }}>{label}</span>
        {hint && <span title={hint} style={{ fontSize: 10, color: 'var(--ink-mute)', cursor: 'help' }}>ⓘ</span>}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 24, fontWeight: 600, color: color ?? 'var(--ink)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 6 }}>{sub}</div>}
    </div>
  )
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h2 style={{ fontFamily: 'var(--serif)', fontWeight: 500, fontSize: 20, margin: 0 }}>{title}</h2>
        {note && <span style={{ fontSize: 12, color: 'var(--ink-mute)' }}>{note}</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {children}
      </div>
    </div>
  )
}

export default function HypeMarket() {
  const [data, setData] = useState<Market | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/hl-market')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || 'failed')
      setData(j); setError(null); setRefreshedAt(new Date())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load])

  if (loading && !data) return <div style={{ color: 'var(--ink-soft)', padding: '40px 0' }}>Loading HYPE market data…</div>
  if (error && !data) return <div style={{ color: 'var(--red)', padding: '40px 0' }}>Failed to load: {error}</div>
  if (!data) return null

  const { hype, platform, buyback, fees } = data
  const fundingPositive = hype.fundingHourly >= 0

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 32, fontWeight: 700 }}>{usd(hype.price)}</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 600, color: signColor(hype.change24hPct) }}>
          {pct(hype.change24hPct)} <span style={{ fontSize: 12, color: 'var(--ink-mute)' }}>24h</span>
        </div>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-mute)' }}>
          {refreshedAt ? `Updated ${refreshedAt.toLocaleTimeString()}` : ''} · auto-refresh 60s
        </span>
      </div>

      {/* 1. Fundamentals */}
      <Section title="Fundamentals" note="the business: is usage & revenue growing?">
        <Metric label="HYPE Price" value={usd(hype.price)} sub={`Oracle ${usd(hype.oraclePx)}`} />
        <Metric label="24h Change" value={pct(hype.change24hPct)} color={signColor(hype.change24hPct)} />
        <Metric label="Platform Volume 24h" value={compact(platform.totalVolume24h)} sub={`${platform.perpCount} perp markets`} hint="Sum of 24h notional volume across every Hyperliquid perp. Rising volume → rising fees → bigger buybacks." />
        <Metric label="Fees 24h" value={compact(fees.day)} sub={fees.revenueDay != null ? `Revenue ${compact(fees.revenueDay)}` : undefined} hint="Protocol fees — the buyback budget. Source: DefiLlama." />
        <Metric label="Fees 7d / 30d" value={compact(fees.week)} sub={`30d ${compact(fees.month)}`} />
        <Metric label="Platform OI" value={compact(platform.totalOiUsd)} hint="Total open interest (notional) across all perps — capital committed to the platform." />
      </Section>

      {/* 2. Positioning */}
      <Section title="Positioning & Leverage" note="what could snap? drives sharp moves">
        <Metric label="HYPE Open Interest" value={compact(hype.oiUsd)} sub={`${num(hype.oiCoins)} HYPE`} />
        <Metric label="HYPE Volume 24h" value={compact(hype.volume24h)} />
        <Metric
          label="Funding (hourly)"
          value={`${(hype.fundingHourly * 100).toFixed(4)}%`}
          color={signColor(hype.fundingHourly)}
          sub={fundingPositive ? 'longs pay shorts — crowded longs' : 'shorts pay longs — crowded shorts'}
          hint="Positive = longs crowded (squeeze-down risk). Negative = shorts crowded (squeeze-up setup)."
        />
        <Metric label="Funding (annualized)" value={pct(hype.fundingAnnualizedPct, 1)} color={signColor(hype.fundingAnnualizedPct)} />
      </Section>

      {/* 3. Buybacks */}
      <Section title="Assistance Fund Buybacks" note="structural bid — fees auto-buy HYPE">
        <Metric label="HYPE Held by AF" value={num(buyback.hypeHeld)} sub="cumulative" hint="The Assistance Fund (0x2222…2222) accumulates HYPE bought back with protocol fees." />
        <Metric label="AF Holdings Value" value={compact(buyback.currentValueUsd)} sub={`@ ${usd(hype.price)}`} />
        <Metric label="Daily Buyback Budget ≈" value={compact(fees.day)} hint="Approximated by 24h fees — most of which funds buybacks. Exact daily flow requires snapshotting AF holdings over time." />
        <Metric label="7d Buyback Budget ≈" value={compact(fees.week)} sub={`30d ${compact(fees.month)}`} />
      </Section>

      <p style={{ fontSize: 11, color: 'var(--ink-mute)', lineHeight: 1.6, marginTop: 8 }}>
        Sources: Hyperliquid API (price, OI, funding, volume, AF holdings) · DefiLlama (fees / revenue).
        No metric predicts price — read fundamentals for the trend, positioning for the timing. Not financial advice.
      </p>
    </div>
  )
}
