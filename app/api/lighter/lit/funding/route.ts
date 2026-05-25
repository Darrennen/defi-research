import { lighterGet, num } from '@/lib/lighter'

export async function GET() {
  try {
    const j = await lighterGet('/funding-rates', undefined, 30)
    const rows: any[] = j?.funding_rates ?? j?.fundingRates ?? j?.data ?? []
    const litRows = rows.filter((f: any) => Number(f.market_id ?? f.marketId ?? -1) === 120)
    const byExchange: Record<string, number> = {}
    for (const row of litRows) {
      const exch = String(row.exchange ?? 'lighter').toLowerCase()
      const rate = row.rate ?? row.funding_rate
      if (rate != null) byExchange[exch] = num(rate)
    }
    return Response.json({ market_id: 120, by_exchange: byExchange, rows: litRows })
  } catch (e: any) {
    return Response.json({ market_id: 120, by_exchange: {}, rows: [], error: e.message }, { status: 500 })
  }
}
