import { NextResponse } from 'next/server'
import { redis, WHALE_ALERTS_KEY, MAX_ALERTS } from '@/lib/redis'
import { parseArkhamAlert, isArkhamAlert, type WhaleAlert } from '@/app/api/slack-events/route'

const CHANNEL_ID = 'C097VGAQ5FB'
const DAYS = 30

export async function POST() {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) {
    return NextResponse.json({ error: 'SLACK_BOT_TOKEN not set' }, { status: 500 })
  }

  // Find the newest alert already stored — only fetch since then (incremental sync).
  // Falls back to 30 days if Redis is empty.
  let oldest: string
  try {
    const newest = await redis.zrange<string[]>(WHALE_ALERTS_KEY, -1, -1)
    if (newest.length > 0) {
      const parsed = JSON.parse(newest[0]) as { ts: number }
      // Use the newest stored alert's timestamp (minus 60s buffer for safety)
      oldest = Math.max(
        Math.floor(parsed.ts / 1000) - 60,
        Math.floor((Date.now() - DAYS * 24 * 60 * 60 * 1000) / 1000)
      ).toString()
    } else {
      oldest = Math.floor((Date.now() - DAYS * 24 * 60 * 60 * 1000) / 1000).toString()
    }
  } catch {
    oldest = Math.floor((Date.now() - DAYS * 24 * 60 * 60 * 1000) / 1000).toString()
  }

  let cursor: string | undefined
  let stored = 0
  let fetched = 0

  try {
    do {
      const params = new URLSearchParams({
        channel: CHANNEL_ID,
        oldest,
        limit: '200',
        ...(cursor ? { cursor } : {}),
      })

      const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()

      if (!data.ok) {
        return NextResponse.json({ error: data.error ?? 'Slack API error', detail: data }, { status: 400 })
      }

      const messages: Array<{ ts: string; text?: string; subtype?: string }> = data.messages ?? []
      fetched += messages.length

      for (const msg of messages) {
        if (!msg.text || msg.text.length < 10) continue
        if (msg.subtype && msg.subtype !== 'bot_message') continue

        const parsedAlert = parseArkhamAlert(msg.text)
        if (!isArkhamAlert(parsedAlert)) continue

        const ts = Math.floor(parseFloat(msg.ts) * 1000)
        const alert: WhaleAlert = { id: msg.ts, ts, raw: msg.text, ...parsedAlert }

        await redis.zadd(WHALE_ALERTS_KEY, { nx: true }, { score: ts, member: JSON.stringify(alert) })
        stored++
      }

      cursor = data.response_metadata?.next_cursor || undefined
    } while (cursor)

    // Trim to MAX_ALERTS keeping newest
    const count = await redis.zcard(WHALE_ALERTS_KEY)
    if (count > MAX_ALERTS) {
      await redis.zremrangebyrank(WHALE_ALERTS_KEY, 0, count - MAX_ALERTS - 1)
    }

    return NextResponse.json({ ok: true, fetched, stored, filtered: fetched - stored })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
