import { lighterGet, normaliseLitTrade, LIT_MARKETS, type LitTrade } from '@/lib/lighter'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const hours = Number(searchParams.get('hours') ?? 24)
  const topN = Math.min(50, Math.max(5, Number(searchParams.get('top_n') ?? 15)))
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

    const buyerMap = new Map<number, { total_usd: number; trade_count: number; first_ts: number; last_ts: number }>()
    const sellerMap = new Map<number, { total_usd: number; trade_count: number; first_ts: number; last_ts: number }>()

    for (const t of allTrades) {
      if (t.buyer_id > 0) {
        const e = buyerMap.get(t.buyer_id) ?? { total_usd: 0, trade_count: 0, first_ts: t.ts, last_ts: t.ts }
        e.total_usd += t.usd; e.trade_count++
        e.first_ts = Math.min(e.first_ts, t.ts); e.last_ts = Math.max(e.last_ts, t.ts)
        buyerMap.set(t.buyer_id, e)
      }
      if (t.seller_id > 0) {
        const e = sellerMap.get(t.seller_id) ?? { total_usd: 0, trade_count: 0, first_ts: t.ts, last_ts: t.ts }
        e.total_usd += t.usd; e.trade_count++
        e.first_ts = Math.min(e.first_ts, t.ts); e.last_ts = Math.max(e.last_ts, t.ts)
        sellerMap.set(t.seller_id, e)
      }
    }

    const toList = (map: Map<number, any>) =>
      [...map.entries()]
        .map(([account_id, v]) => ({ account_id, ...v }))
        .sort((a, b) => b.total_usd - a.total_usd)
        .slice(0, topN)

    const oldestTs = allTrades.reduce((m, t) => Math.min(m, t.ts), Infinity)

    return Response.json({
      buyers: toList(buyerMap),
      sellers: toList(sellerMap),
      hours,
      oldest_ts: isFinite(oldestTs) ? oldestTs : 0,
    })
  } catch (e: any) {
    return Response.json({ buyers: [], sellers: [], hours, oldest_ts: 0, error: e.message }, { status: 500 })
  }
}
