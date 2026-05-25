import { lighterGet, CANDLE_RES_SECS } from '@/lib/lighter'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const marketId = Number(searchParams.get('market_id') ?? 0)
  const resolution = searchParams.get('resolution') ?? '1h'
  const count = Math.min(200, Math.max(1, Number(searchParams.get('count') ?? 24)))

  if (!marketId) return Response.json({ error: 'market_id required' }, { status: 400 })

  try {
    const bucket = CANDLE_RES_SECS[resolution] ?? 3600
    const endMs = Date.now()
    const startMs = endMs - bucket * count * 1000
    const j = await lighterGet('/candles', {
      market_id: marketId,
      resolution,
      start_timestamp: startMs,
      end_timestamp: endMs,
      count_back: count,
    }, 60)
    const candles = j?.c ?? j?.candlesticks ?? j?.candles ?? j?.data ?? []
    return Response.json({ market_id: marketId, resolution, candles })
  } catch (e: any) {
    return Response.json({ market_id: marketId, resolution, candles: [], error: e.message }, { status: 500 })
  }
}
