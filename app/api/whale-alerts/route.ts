import { NextRequest, NextResponse } from 'next/server'
import { redis, WHALE_ALERTS_KEY } from '@/lib/redis'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '100'), 200)

  try {
    const raw = await redis.zrange(WHALE_ALERTS_KEY, 0, limit - 1, { rev: true })
    const alerts = (raw as string[]).map(r => {
      try { return typeof r === 'string' ? JSON.parse(r) : r } catch { return null }
    }).filter(Boolean)
    return NextResponse.json({ alerts, updatedAt: Date.now() })
  } catch (e) {
    console.error('whale-alerts:', e)
    return NextResponse.json({ alerts: [], updatedAt: Date.now(), error: 'store unavailable' })
  }
}
