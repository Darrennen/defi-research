import { NextResponse } from 'next/server'

const CG = 'https://api.coingecko.com/api/v3'

export async function GET() {
  try {
    const [p1, p2] = await Promise.all([
      fetch(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1`, {
        next: { revalidate: 86400 },
      }).then(r => r.json()).catch(() => []),
      fetch(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=2`, {
        next: { revalidate: 86400 },
      }).then(r => r.json()).catch(() => []),
    ])

    const coins = [...(Array.isArray(p1) ? p1 : []), ...(Array.isArray(p2) ? p2 : [])]
    const map: Record<string, string> = {}
    for (const coin of coins) {
      const sym = (coin.symbol as string).toUpperCase()
      // Only store the first match (highest market cap) per symbol
      if (coin.image && !map[sym]) map[sym] = coin.image
    }

    return NextResponse.json(map, {
      headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=3600' },
    })
  } catch {
    return NextResponse.json({})
  }
}
