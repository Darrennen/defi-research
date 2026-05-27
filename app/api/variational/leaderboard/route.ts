import { NextRequest, NextResponse } from 'next/server'

const QUERY_ID = 7589078
const DUNE_API = `https://api.dune.com/api/v1/query/${QUERY_ID}/results`

export async function GET(req: NextRequest) {
  const apiKey = process.env.DUNE_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'DUNE_API_KEY not configured' }, { status: 500 })
  }

  const { searchParams } = new URL(req.url)
  const limit  = Math.min(parseInt(searchParams.get('limit')  ?? '100', 10), 500)
  const offset = Math.max(parseInt(searchParams.get('offset') ?? '0',   10), 0)

  try {
    const r = await fetch(`${DUNE_API}?limit=${limit}&offset=${offset}`, {
      headers: { 'X-DUNE-API-KEY': apiKey },
      next: { revalidate: 3600 }, // cache 1 hour — query is heavy
    })
    if (!r.ok) {
      const text = await r.text()
      return NextResponse.json({ error: `Dune API error ${r.status}: ${text}` }, { status: r.status })
    }
    const data = await r.json()

    // Normalize rows
    const rows = (data.result?.rows ?? []).map((row: Record<string, unknown>) => ({
      rank:                Number(row.rank),
      wallet:              String(row.wallet),
      total_deposited:     Number(row.total_deposited  ?? 0),
      total_withdrawn:     Number(row.total_withdrawn  ?? 0),
      net_pnl:             Number(row.net_pnl          ?? 0),
      deposit_count:       Number(row.deposit_count    ?? 0),
      withdrawal_count:    Number(row.withdrawal_count ?? 0),
      funding_received:    Number(row.funding_received    ?? 0),
      funding_events:      Number(row.funding_events      ?? 0),
      funding_efficiency:  Number(row.funding_efficiency  ?? 0),
      is_likely_bot:       Boolean(row.is_likely_bot      ?? false),
      first_activity:      row.first_activity ? String(row.first_activity) : null,
      last_activity:       row.last_activity  ? String(row.last_activity)  : null,
    }))

    return NextResponse.json({
      rows,
      total_row_count: data.result?.metadata?.total_row_count ?? 0,
      execution_id: data.execution_id,
      state: data.state,
    })
  } catch {
    return NextResponse.json({ error: 'Fetch failed' }, { status: 500 })
  }
}
