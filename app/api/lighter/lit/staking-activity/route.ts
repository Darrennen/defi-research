import { lighterGet, explorerGet, normaliseLitTrade, num, LIT_STAKING_POOL } from '@/lib/lighter'

let _cache: any = null
let _cacheTs = 0
const TTL = 120_000

export async function GET() {
  const now = Date.now()
  if (_cache && now - _cacheTs < TTL) return Response.json(_cache)

  try {
    // Fetch recent LIT trades directly (market 120 = LIT-PERP, 2049 = LIT/USDC spot)
    const markets = [120, 2049]
    const tradesByMarket = await Promise.allSettled(
      markets.map(mid =>
        lighterGet('/recentTrades', { market_id: mid, limit: 200 }, 10).then(j => {
          const raw: any[] = j?.trades ?? j?.recent_trades ?? j?.data ?? []
          return raw.flatMap((t: any) => {
            const norm = normaliseLitTrade(t, mid)
            return norm ? [{ buyer_id: norm.buyer_id, seller_id: norm.seller_id }] : []
          })
        })
      )
    )

    const trades: { buyer_id: number; seller_id: number }[] = []
    for (const r of tradesByMarket) {
      if (r.status === 'fulfilled') trades.push(...r.value)
    }

    // Collect unique account IDs, top 20 by activity
    const activityMap = new Map<number, number>()
    for (const t of trades) {
      activityMap.set(t.buyer_id, (activityMap.get(t.buyer_id) ?? 0) + 1)
      activityMap.set(t.seller_id, (activityMap.get(t.seller_id) ?? 0) + 1)
    }
    const topIds = [...activityMap.entries()]
      .filter(([id]) => id > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([id]) => id)

    if (!topIds.length) {
      const result = { events: [], accounts_scanned: 0, ts: now }
      _cache = result; _cacheTs = now
      return Response.json(result)
    }

    // Fetch l1_address for each account ID
    const addrResults = await Promise.allSettled(
      topIds.map(async id => {
        const j = await lighterGet('/account', { by: 'index', value: String(id) }, 10)
        const addr = j?.accounts?.[0]?.l1_address ?? ''
        return { id, addr }
      })
    )
    const accounts = addrResults
      .filter(r => r.status === 'fulfilled' && r.value.addr)
      .map(r => (r as PromiseFulfilledResult<{ id: number; addr: string }>).value)

    // Fetch explorer logs for each account and parse staking events
    const eventResults = await Promise.allSettled(
      accounts.map(async ({ id, addr }) => {
        const logs: any[] = await explorerGet(`/accounts/${addr}/logs`, { limit: 50 })
        const events: any[] = []
        for (const entry of Array.isArray(logs) ? logs : []) {
          const logType: string = entry.type ?? ''
          const pubdata = entry.pubdata ?? {}
          if (logType === 'L2MintShares') {
            const ms = pubdata.mint_shares_pubdata ?? {}
            if (Number(ms.public_pool_index ?? -1) === LIT_STAKING_POOL) {
              events.push({ type: 'stake', account_id: id, time: entry.time, amount: num(ms.principal_amount), hash: entry.hash ?? '' })
            }
          } else if (logType === 'BurnedShares' || logType === 'BurnShares') {
            const bs = pubdata.burn_shares_pubdata ?? pubdata.burned_shares_pubdata ?? {}
            if (Number(bs.public_pool_index ?? -1) === LIT_STAKING_POOL) {
              events.push({ type: 'unstake', account_id: id, time: entry.time, amount: num(bs.principal_amount), hash: entry.hash ?? '' })
            }
          }
        }
        return events
      })
    )

    const allEvents: any[] = []
    for (const r of eventResults) {
      if (r.status === 'fulfilled') allEvents.push(...r.value)
    }
    allEvents.sort((a, b) => (a.time ?? '') < (b.time ?? '') ? 1 : -1)

    const result = { events: allEvents.slice(0, 50), accounts_scanned: accounts.length, ts: now }
    _cache = result; _cacheTs = now
    return Response.json(result)
  } catch (e: any) {
    return Response.json({ events: [], accounts_scanned: 0, error: e.message }, { status: 500 })
  }
}
