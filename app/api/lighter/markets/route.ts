import { lighterGet, normaliseMarkets, num, type Market } from '@/lib/lighter'

export async function GET() {
  try {
    const [detailsRaw, fundingsRaw] = await Promise.all([
      lighterGet('/orderBookDetails').catch(() => ({})),
      lighterGet('/funding-rates').catch(() => ({})),
    ])
    const markets = normaliseMarkets(detailsRaw, fundingsRaw)
    const totalVol = markets.reduce((s, m) => s + m.volume_24h, 0)
    const totalTrades = markets.reduce((s, m) => s + m.trades_24h, 0)
    const active = markets.filter(m => m.volume_24h > 0).length
    const byChange = [...markets].sort((a, b) => b.price_change - a.price_change)
    const funded = markets.filter(m => m.funding != null && m.volume_24h > 0)
    const fundedVol = funded.reduce((s, m) => s + m.volume_24h, 0)
    const avgFunding = fundedVol > 0
      ? funded.reduce((s, m) => s + m.funding! * m.volume_24h, 0) / fundedVol
      : null
    return Response.json({
      markets,
      summary: {
        total_volume_24h: totalVol,
        total_trades_24h: totalTrades,
        active_markets: active,
        listed_markets: markets.length,
        top_gainer: byChange[0] ?? null,
        top_loser: byChange[byChange.length - 1] ?? null,
        avg_funding_weighted: avgFunding,
        funded_markets: funded.length,
      },
      ts: Date.now(),
    })
  } catch (e: any) {
    return Response.json({ markets: [], summary: null, ts: Date.now(), error: e.message }, { status: 500 })
  }
}
