import { NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'

const COOKIE  = 'pm-session'
const MAX_AGE = 60 * 60 * 24 * 7  // 7 days

function computeToken(secret: string): string {
  return createHmac('sha256', secret).update('pm-v1').digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

// POST /api/polymarket/auth  — login
export async function POST(req: Request) {
  const { password } = await req.json()

  const expected = process.env.POLYMARKET_PASSWORD
  const secret   = process.env.POLYMARKET_SESSION_SECRET

  if (!expected || !secret) {
    return NextResponse.json({ error: 'Auth not configured on server' }, { status: 503 })
  }

  if (!password || !safeEqual(String(password), expected)) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 })
  }

  const token = computeToken(secret)
  const res   = NextResponse.json({ ok: true })
  res.cookies.set(COOKIE, token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path:     '/',
    maxAge:   MAX_AGE,
  })
  return res
}

// DELETE /api/polymarket/auth  — logout
export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(COOKIE, '', { maxAge: 0, path: '/' })
  return res
}
