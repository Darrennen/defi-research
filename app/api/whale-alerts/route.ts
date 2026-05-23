import { NextRequest, NextResponse } from 'next/server'
import { redis, WHALE_ALERTS_KEY } from '@/lib/redis'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const entityFilter = searchParams.get('entity')?.toLowerCase()

  // When filtering by entity, scan all stored alerts to find theirs
  const fetchCount = entityFilter
    ? 5000
    : Math.min(parseInt(searchParams.get('limit') ?? '100'), 200)

  try {
    const raw = await redis.zrange(WHALE_ALERTS_KEY, 0, fetchCount - 1, { rev: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let alerts = (raw as string[]).map((r): any => {
      try { return typeof r === 'string' ? JSON.parse(r) : r } catch { return null }
    }).filter(Boolean)

    if (entityFilter) {
      alerts = alerts.filter((a: { entity?: string }) =>
        (a.entity ?? '').toLowerCase() === entityFilter
      )
    }

    return NextResponse.json({ alerts, updatedAt: Date.now() })
  } catch (e) {
    console.error('whale-alerts:', e)
    return NextResponse.json({ alerts: [], updatedAt: Date.now(), error: 'store unavailable' })
  }
}
