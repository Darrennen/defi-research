import { lighterGetNoCache } from '@/lib/lighter'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const marketId = Number(searchParams.get('market_id') ?? 120)

  try {
    for (const path of ['/orderBook', '/order_book']) {
      try {
        const j = await lighterGetNoCache(path, { market_id: marketId })
        if (j && (j.bid_book || j.bids || j.ask_book || j.asks)) {
          return Response.json({ market_id: marketId, ts: Date.now(), ...j })
        }
        const inner = j?.order_book ?? {}
        if (inner.bid_book || inner.bids || inner.ask_book || inner.asks) {
          return Response.json({ market_id: marketId, ts: Date.now(), ...inner })
        }
      } catch { /* try next */ }
    }
    return Response.json({ market_id: marketId, ts: Date.now(), bid_book: [], ask_book: [] })
  } catch (e: any) {
    return Response.json({ market_id: marketId, ts: Date.now(), bid_book: [], ask_book: [], error: e.message }, { status: 500 })
  }
}
