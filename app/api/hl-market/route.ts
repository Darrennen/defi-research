import { NextResponse } from 'next/server'

export const revalidate = 60

const HL_API = 'https://api.hyperliquid.xyz/info'
// Hyperliquid Assistance Fund — accumulates HYPE bought back from protocol fees.
const ASSISTANCE_FUND = '0x2222222222222222222222222222222222222222'

async function hlPost(body: unknown) {
  const r = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    next: { revalidate: 60 },
  })
  if (!r.ok) throw new Error(`HL ${r.status}`)
  return r.json()
}

async function llamaFees(dataType: 'dailyFees' | 'dailyRevenue') {
  try {
    const r = await fetch(`https://api.llama.fi/summary/fees/hyperliquid?dataType=${dataType}`, {
      next: { revalidate: 300 },
    })
    if (!r.ok) return null
    return r.json()
  } catch {
    return null
  }
}

export async function GET() {
  try {
    const [metaCtx, afState, feesD, revD] = await Promise.all([
      hlPost({ type: 'metaAndAssetCtxs' }),
      hlPost({ type: 'spotClearinghouseState', user: ASSISTANCE_FUND }),
      llamaFees('dailyFees'),
      llamaFees('dailyRevenue'),
    ])

    const universe: Array<{ name: string }> = metaCtx[0].universe
    const ctxs: Array<Record<string, string>> = metaCtx[1]

    // ── HYPE perp ───────────────────────────────────────────────
    const hi = universe.findIndex(u => u.name === 'HYPE')
    const h = ctxs[hi] ?? {}
    const price = Number(h.markPx)
    const prevDay = Number(h.prevDayPx)
    const fundingHourly = Number(h.funding) // per-hour rate
    const hype = {
      price,
      oraclePx: Number(h.oraclePx),
      change24hPct: prevDay ? ((price - prevDay) / prevDay) * 100 : 0,
      oiCoins: Number(h.openInterest),
      oiUsd: Number(h.openInterest) * price,
      volume24h: Number(h.dayNtlVlm),
      fundingHourly,
      fundingAnnualizedPct: fundingHourly * 24 * 365 * 100,
    }

    // ── Platform-wide (sum across all perps) ────────────────────
    let totalVol = 0
    let totalOi = 0
    for (const c of ctxs) {
      totalVol += Number(c.dayNtlVlm) || 0
      totalOi += (Number(c.openInterest) || 0) * (Number(c.markPx) || 0)
    }
    const platform = { totalVolume24h: totalVol, totalOiUsd: totalOi, perpCount: universe.length }

    // ── Assistance Fund buybacks ────────────────────────────────
    // NOTE: the AF balance's entryNtl is NOT a reliable buyback cost basis
    // (implies ~$177/HYPE avg, well above any traded price) — so we expose only
    // the trustworthy figures: HYPE held and its current market value.
    const afHype = (afState.balances ?? []).find((b: { coin: string }) => b.coin === 'HYPE')
    const hypeHeld = afHype ? Number(afHype.total) : 0
    const buyback = {
      hypeHeld,
      currentValueUsd: hypeHeld * price,
    }

    // ── Fees / revenue ──────────────────────────────────────────
    const fees = {
      day: feesD?.total24h ?? null,
      week: feesD?.total7d ?? null,
      month: feesD?.total30d ?? null,
      revenueDay: revD?.total24h ?? null,
    }

    return NextResponse.json({ ts: Date.now(), hype, platform, buyback, fees })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'failed' },
      { status: 502 },
    )
  }
}
