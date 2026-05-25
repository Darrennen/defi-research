import { lighterGet, normaliseLitTrade, LIT_MARKETS, type LitTrade } from '@/lib/lighter'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const hours = Number(searchParams.get('hours') ?? 24)
  const marketIdParam = searchParams.get('market_id') ? Number(searchParams.get('market_id')) : null
  const marketIdFilter = marketIdParam != null && LIT_MARKETS.has(marketIdParam) ? marketIdParam : null

  const markets = marketIdFilter != null ? [marketIdFilter] : [120, 2049]

  try {
    const results = await Promise.allSettled(
      markets.map(mid => lighterGet('/recentTrades', { market_id: mid, limit: 100 }))
    )

    let allTrades: LitTrade[] = results.flatMap((r, i) => {
      if (r.status === 'rejected') return []
      const raw: any[] = r.value?.trades ?? r.value?.recent_trades ?? r.value?.data ?? []
      return raw.flatMap((t: any) => {
        const norm = normaliseLitTrade(t, markets[i])
        return norm ? [norm] : []
      })
    })

    if (hours > 0) {
      const since = Date.now() - hours * 3_600_000
      allTrades = allTrades.filter(t => t.ts >= since)
    }

    let buyUsd = 0, sellUsd = 0, buyTrades = 0, sellTrades = 0
    let buySize = 0, sellSize = 0
    const oldestTs = allTrades.reduce((m, t) => Math.min(m, t.ts), Infinity)

    for (const t of allTrades) {
      if (t.taker_is_buyer === 1) {
        buyUsd += t.usd; buyTrades++; buySize += t.size
      } else {
        sellUsd += t.usd; sellTrades++; sellSize += t.size
      }
    }

    return Response.json({
      buy_usd: buyUsd,
      sell_usd: sellUsd,
      delta_usd: buyUsd - sellUsd,
      buy_trades: buyTrades,
      sell_trades: sellTrades,
      net_size: buySize - sellSize,
      trade_count: allTrades.length,
      oldest_ts: isFinite(oldestTs) ? oldestTs : 0,
    })
  } catch (e: any) {
    return Response.json({ buy_usd: 0, sell_usd: 0, delta_usd: 0, buy_trades: 0, sell_trades: 0, net_size: 0, trade_count: 0, oldest_ts: 0, error: e.message }, { status: 500 })
  }
}
