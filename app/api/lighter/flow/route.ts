import { lighterGet, normaliseMarkets, normaliseTrade, type Trade } from '@/lib/lighter'

const TOP_N = 15
const LIMIT_PER_MKT = 50

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const limit = Math.min(1000, Math.max(10, Number(searchParams.get('limit') ?? 500)))

  try {
    const [detailsRaw, fundingsRaw] = await Promise.all([
      lighterGet('/orderBookDetails').catch(() => ({})),
      lighterGet('/funding-rates').catch(() => ({})),
    ])
    const markets = normaliseMarkets(detailsRaw, fundingsRaw)
    const top = [...markets].sort((a, b) => b.volume_24h - a.volume_24h).slice(0, TOP_N)

    const results = await Promise.allSettled(
      top.map(m => lighterGet('/recentTrades', { market_id: m.market_id, limit: LIMIT_PER_MKT }))
    )
    const trades: Trade[] = []
    for (let i = 0; i < top.length; i++) {
      const r = results[i]
      if (r.status === 'rejected') continue
      const rawTrades: any[] = r.value?.trades ?? r.value?.recent_trades ?? r.value?.data ?? []
      for (const raw of rawTrades) {
        const t = normaliseTrade(raw, top[i])
        if (t) trades.push(t)
      }
    }

    let buyUsd = 0, sellUsd = 0
    const perMarket: Record<string, { buy: number; sell: number }> = {}
    const sample = trades.slice(0, limit)
    for (const t of sample) {
      if (t.side === 'buy') buyUsd += t.usd
      else sellUsd += t.usd
      const pm = perMarket[t.symbol] ?? (perMarket[t.symbol] = { buy: 0, sell: 0 })
      pm[t.side] += t.usd
    }

    const cvd = Object.entries(perMarket)
      .map(([symbol, v]) => ({ symbol, delta: v.buy - v.sell, buy: v.buy, sell: v.sell }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 10)

    return Response.json({
      buy_usd: buyUsd,
      sell_usd: sellUsd,
      delta_usd: buyUsd - sellUsd,
      sample_size: sample.length,
      cvd,
    })
  } catch (e: any) {
    return Response.json({ buy_usd: 0, sell_usd: 0, delta_usd: 0, sample_size: 0, cvd: [], error: e.message }, { status: 500 })
  }
}
