import { NextResponse } from 'next/server'

const API = 'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats'

export async function GET() {
  try {
    const r = await fetch(API, { next: { revalidate: 25 } })
    if (!r.ok) return NextResponse.json({ error: 'upstream error' }, { status: r.status })
    const data = await r.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'fetch failed' }, { status: 500 })
  }
}
