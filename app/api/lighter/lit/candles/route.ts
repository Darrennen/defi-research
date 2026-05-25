import { lighterGet, CANDLE_RES_SECS } from '@/lib/lighter'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const marketId = Number(searchParams.get('market_id') ?? 120)
  const resolution = searchParams.get('resolution') ?? '1h'
  const count = Math.min(200, Math.max(10, Number(searchParams.get('count') ?? 72)))

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
    return Response.json({ candles, market_id: marketId, resolution, ts: Date.now() })
  } catch (e: any) {
    return Response.json({ candles: [], market_id: marketId, resolution, ts: Date.now(), error: e.message }, { status: 500 })
  }
}
