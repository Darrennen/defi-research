import { explorerGet, num } from '@/lib/lighter'

const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/

function parseLog(entry: any, accountIndex: number): any | null {
  const pubdata = entry.pubdata ?? {}
  const trade = pubdata.trade_pubdata ?? pubdata.trade_pubdata_with_funding
  if (!trade) return null
  const marketId = trade.market_index
  const takerIdx = Number(trade.taker_account_index ?? 0)
  const makerIdx = Number(trade.maker_account_index ?? 0)
  const isTakerAsk = Number(trade.is_taker_ask ?? 0)

  let takerIsBuyer: number
  let role: string
  if (takerIdx === accountIndex) {
    takerIsBuyer = isTakerAsk ? 0 : 1
    role = 'taker'
  } else if (makerIdx === accountIndex) {
    takerIsBuyer = isTakerAsk ? 1 : 0
    role = 'maker'
  } else {
    return null
  }

  return {
    hash: entry.hash ?? '',
    time: entry.time ?? '',
    market_id: marketId,
    price: trade.price,
    size: trade.size,
    taker_is_buyer: takerIsBuyer,
    taker_account_index: takerIdx,
    maker_account_index: makerIdx,
    role,
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const address = (searchParams.get('address') ?? '').trim()
  const accountIndex = Number(searchParams.get('account_index') ?? 0)
  const limit = Math.min(500, Math.max(1, Number(searchParams.get('limit') ?? 100)))
  const offset = Math.max(0, Number(searchParams.get('offset') ?? 0))
  const marketIdFilter = searchParams.get('market_id') ? Number(searchParams.get('market_id')) : null

  if (!address || !ETH_ADDR.test(address)) return Response.json({ error: 'Valid Ethereum address required' }, { status: 400 })
  if (!accountIndex) return Response.json({ error: 'account_index required' }, { status: 400 })

  try {
    const logs: any[] = await explorerGet(`/accounts/${address}/logs`, { limit, offset })
    const trades = (Array.isArray(logs) ? logs : []).flatMap((entry: any) => {
      const t = parseLog(entry, accountIndex)
      if (!t) return []
      if (marketIdFilter != null && t.market_id !== marketIdFilter) return []
      return [t]
    })
    return Response.json({ trades, count: trades.length, offset, limit })
  } catch (e: any) {
    return Response.json({ trades: [], count: 0, offset, limit, error: e.message }, { status: 500 })
  }
}
