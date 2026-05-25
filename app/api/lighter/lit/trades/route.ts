import { lighterGet, normaliseLitTrade, LIT_MARKETS } from '@/lib/lighter'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const limit = Math.min(500, Math.max(1, Number(searchParams.get('limit') ?? 100)))
  const marketIdParam = searchParams.get('market_id') ? Number(searchParams.get('market_id')) : null
  const marketIdFilter = marketIdParam != null && LIT_MARKETS.has(marketIdParam) ? marketIdParam : null

  const markets = marketIdFilter != null ? [marketIdFilter] : [120, 2049]

  try {
    const results = await Promise.allSettled(
      markets.map(mid => lighterGet('/recentTrades', { market_id: mid, limit: 500 }))
    )

    const trades = results.flatMap((r, i) => {
      if (r.status === 'rejected') return []
      const raw: any[] = r.value?.trades ?? r.value?.recent_trades ?? r.value?.data ?? []
      return raw.flatMap((t: any) => {
        const norm = normaliseLitTrade(t, markets[i])
        return norm ? [norm] : []
      })
    })

    trades.sort((a, b) => b.ts - a.ts)

    return Response.json({ trades: trades.slice(0, limit), count: Math.min(trades.length, limit) })
  } catch (e: any) {
    return Response.json({ trades: [], count: 0, error: e.message }, { status: 500 })
  }
}
