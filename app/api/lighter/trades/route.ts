import { lighterGet, normaliseMarkets, normaliseTrade } from '@/lib/lighter'

const TOP_N = 15
const LIMIT_PER_MKT = 50

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const limit = Math.min(1000, Math.max(1, Number(searchParams.get('limit') ?? 200)))
  const minUsd = Number(searchParams.get('min_usd') ?? 0)
  const marketIdFilter = searchParams.get('market_id') ? Number(searchParams.get('market_id')) : null

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
    const marketById = new Map(markets.map(m => [m.market_id, m]))
    const all: ReturnType<typeof normaliseTrade>[] = []
    for (let i = 0; i < top.length; i++) {
      const r = results[i]
      if (r.status === 'rejected') continue
      const rawTrades: any[] = r.value?.trades ?? r.value?.recent_trades ?? r.value?.data ?? []
      for (const raw of rawTrades) {
        const m = marketById.get(top[i].market_id)
        if (!m) continue
        const t = normaliseTrade(raw, m)
        if (t) all.push(t)
      }
    }
    all.sort((a, b) => (b?.ts ?? 0) - (a?.ts ?? 0))

    const out = all
      .filter(t => t != null && t.usd >= minUsd && (marketIdFilter == null || t.market_id === marketIdFilter))
      .slice(0, limit)

    return Response.json({ trades: out, count: out.length })
  } catch (e: any) {
    return Response.json({ trades: [], count: 0, error: e.message }, { status: 500 })
  }
}
