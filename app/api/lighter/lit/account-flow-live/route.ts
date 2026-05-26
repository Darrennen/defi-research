import { lighterGet, explorerGet, num, LIT_MARKETS, normaliseMarkets } from '@/lib/lighter'

function parseExplorerLitTrade(entry: any): any | null {
  const pubdata = entry.pubdata ?? {}
  const trade = pubdata.trade_pubdata ?? pubdata.trade_pubdata_with_funding
  if (!trade) return null
  const marketId = Number(trade.market_index ?? -1)
  if (!LIT_MARKETS.has(marketId)) return null
  const price = num(trade.price)
  const size = num(trade.size)
  if (price <= 0 || size <= 0) return null
  const txHash = entry.hash ?? ''
  if (!txHash || txHash.length < 16) return null

  const takerIdx = Number(trade.taker_account_index ?? 0)
  const makerIdx = Number(trade.maker_account_index ?? 0)
  const isTakerAsk = Number(trade.is_taker_ask ?? 0)
  const buyerId = isTakerAsk ? makerIdx : takerIdx
  const sellerId = isTakerAsk ? takerIdx : makerIdx
  const takerIsBuyer = isTakerAsk ? 0 : 1

  const timeStr = entry.time ?? ''
  let tsMs: number
  try {
    tsMs = new Date(timeStr.replace('Z', '+00:00')).getTime()
  } catch {
    tsMs = Date.now()
  }

  return { market_id: marketId, ts: tsMs, price, size, usd: price * size, buyer_id: buyerId, seller_id: sellerId, taker_is_buyer: takerIsBuyer }
}

function flowWindow(trades: any[], accountId: number, sinceMs: number) {
  // sort oldest → newest so sequence reflects actual chronological order
  const w = trades.filter(t => t.ts >= sinceMs).sort((a, b) => a.ts - b.ts)
  const buys = w.filter(t => t.buyer_id === accountId)
  const sells = w.filter(t => t.seller_id === accountId)
  const buyUsd = buys.reduce((s, t) => s + t.usd, 0)
  const buySize = buys.reduce((s, t) => s + t.size, 0)
  const sellUsd = sells.reduce((s, t) => s + t.usd, 0)
  const sellSize = sells.reduce((s, t) => s + t.size, 0)

  // chronological sequence: each trade marked B or S, capped at 60
  const sequence = w.slice(0, 60).map(t => ({
    side: t.buyer_id === accountId ? 'B' : 'S',
    usd: t.usd,
    price: t.price,
    ts: t.ts,
  }))
  const firstAction = sequence.length > 0 ? sequence[0].side : null
  const lastAction  = sequence.length > 0 ? sequence[sequence.length - 1].side : null

  return {
    buy_usd: buyUsd, buy_size: buySize, buy_trades: buys.length,
    buy_avg_price: buySize > 0 ? buyUsd / buySize : null,
    sell_usd: sellUsd, sell_size: sellSize, sell_trades: sells.length,
    sell_avg_price: sellSize > 0 ? sellUsd / sellSize : null,
    net_usd: buyUsd - sellUsd,
    net_size: buySize - sellSize,
    sequence,
    first_action: firstAction,
    last_action: lastAction,
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const accountId = Number(searchParams.get('account_id') ?? 0)
  let address = searchParams.get('address') ?? ''
  const marketIdParam = searchParams.get('market_id') ? Number(searchParams.get('market_id')) : null
  const midFilter = marketIdParam != null && LIT_MARKETS.has(marketIdParam) ? marketIdParam : null

  if (!accountId) return Response.json({ error: 'account_id required' }, { status: 400 })

  if (!address) {
    try {
      const j = await lighterGet('/account', { by: 'index', value: accountId })
      address = j?.accounts?.[0]?.l1_address ?? ''
    } catch { /* ignore */ }
  }
  if (!address) return Response.json({ error: 'account address not found' }, { status: 404 })

  // fetch current LIT price in parallel with the trade log scan
  let litMarkPrice = 0
  const pricePromise = lighterGet('/orderBookDetails', {}, 60).then((raw: any) => {
    const markets = normaliseMarkets(raw, {})
    // prefer LIT/USDC spot (2049), fall back to LIT-PERP (120)
    const spot = markets.find(m => m.market_id === 2049)
    const perp = markets.find(m => m.market_id === 120)
    litMarkPrice = spot?.last_price ?? perp?.last_price ?? 0
  }).catch(() => {})

  const nowMs = Date.now()
  const cutoffMs = nowMs - 30 * 24 * 3_600_000
  const trades: any[] = []
  const BATCH = 3
  const MAX_PAGES = 30
  let offset = 0
  let done = false

  while (!done && offset < MAX_PAGES * 100) {
    const pageOffsets = Array.from({ length: BATCH }, (_, i) => offset + i * 100).filter(o => o < MAX_PAGES * 100)
    const results = await Promise.allSettled(
      pageOffsets.map(o => explorerGet(`/accounts/${address}/logs`, { limit: 100, offset: o }))
    )
    for (const r of results) {
      if (r.status === 'rejected' || !r.value || !r.value.length) { done = true; break }
      for (const entry of r.value) {
        const t = parseExplorerLitTrade(entry)
        if (t && (midFilter == null || t.market_id === midFilter)) trades.push(t)
      }
      const oldestInPage = Math.min(...r.value.map((e: any) => {
        try { return new Date((e.time ?? '').replace('Z', '+00:00')).getTime() } catch { return 0 }
      }))
      if (oldestInPage < cutoffMs || r.value.length < 100) { done = true; break }
    }
    offset += BATCH * 100
  }

  await pricePromise

  return Response.json({
    '24h': flowWindow(trades, accountId, nowMs - 86_400_000),
    '7d': flowWindow(trades, accountId, nowMs - 7 * 86_400_000),
    '30d': flowWindow(trades, accountId, nowMs - 30 * 86_400_000),
    lit_mark_price: litMarkPrice,
    _address: address,
  })
}
