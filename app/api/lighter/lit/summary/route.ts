import { lighterGet, normaliseMarkets, normaliseLitTrade } from '@/lib/lighter'

const LIT_IDS = [120, 2049]

export async function GET() {
  try {
    const [detailsRaw, fundingsRaw, trades120Raw, trades2049Raw] = await Promise.all([
      lighterGet('/orderBookDetails').catch(() => ({})),
      lighterGet('/funding-rates').catch(() => ({})),
      lighterGet('/recentTrades', { market_id: 120, limit: 100 }).catch(() => ({})),
      lighterGet('/recentTrades', { market_id: 2049, limit: 100 }).catch(() => ({})),
    ])

    const markets = normaliseMarkets(detailsRaw, fundingsRaw)
    const marketById = new Map(markets.map(m => [m.market_id, m]))
    const perp = marketById.get(120) ?? null
    const spot = marketById.get(2049) ?? null

    const litTrades = [
      ...(trades120Raw?.trades ?? trades120Raw?.recent_trades ?? []).flatMap((r: any) => {
        const t = normaliseLitTrade(r, 120); return t ? [t] : []
      }),
      ...(trades2049Raw?.trades ?? trades2049Raw?.recent_trades ?? []).flatMap((r: any) => {
        const t = normaliseLitTrade(r, 2049); return t ? [t] : []
      }),
    ]

    let buyUsd = 0, sellUsd = 0
    for (const t of litTrades) {
      if (t.taker_is_buyer === 1) buyUsd += t.usd
      else sellUsd += t.usd
    }

    const oldestTs = litTrades.reduce((m, t) => Math.min(m, t.ts), Infinity)

    return Response.json({
      perp,
      spot,
      buy_usd: buyUsd,
      sell_usd: sellUsd,
      net_usd: buyUsd - sellUsd,
      trade_count: litTrades.length,
      db_trade_count: litTrades.length,
      oldest_trade_ts: isFinite(oldestTs) ? oldestTs : 0,
      ts: Date.now(),
    })
  } catch (e: any) {
    return Response.json({ perp: null, spot: null, buy_usd: 0, sell_usd: 0, net_usd: 0, trade_count: 0, ts: Date.now(), error: e.message }, { status: 500 })
  }
}
