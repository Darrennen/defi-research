import { NextResponse, type NextRequest } from 'next/server'

const COOKIE = 'pm-session'
const MAX_AGE = 60 * 60 * 24 * 7  // 7 days

async function expectedToken(secret: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('pm-v1'))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl

  // Always allow: login page and auth API
  if (pathname === '/polymarket/login' || pathname === '/api/polymarket/auth') {
    return NextResponse.next()
  }

  const secret = process.env.POLYMARKET_SESSION_SECRET
  if (!secret) {
    // Not configured — block with a plain message rather than an infinite loop
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'POLYMARKET_SESSION_SECRET not set' }, { status: 503 })
    }
    return NextResponse.next()  // let the page handle it
  }

  const cookieVal = req.cookies.get(COOKIE)?.value
  const expected  = await expectedToken(secret)

  if (cookieVal === expected) return NextResponse.next()

  // Not authenticated
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const loginUrl = req.nextUrl.clone()
  loginUrl.pathname = '/polymarket/login'
  if (pathname !== '/polymarket') loginUrl.searchParams.set('next', pathname)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  matcher: [
    '/polymarket',
    '/polymarket/:path*',
    '/api/polymarket',
    '/api/polymarket/trade',
    '/api/polymarket/cancel',
    '/api/polymarket/positions',
  ],
}

export { expectedToken, COOKIE, MAX_AGE }
