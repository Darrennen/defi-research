import { NextResponse } from 'next/server'

const CHANNEL_ID = 'C097VGAQ5FB'

export async function GET() {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) return NextResponse.json({ error: 'no token' }, { status: 500 })

  const res = await fetch(
    `https://slack.com/api/conversations.history?channel=${CHANNEL_ID}&limit=3`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await res.json()
  // Return first 3 raw messages so we can see the real structure
  return NextResponse.json({ messages: (data.messages ?? []).slice(0, 3) })
}
