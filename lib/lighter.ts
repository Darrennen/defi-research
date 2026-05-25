const LIGHTER_API = process.env.LIGHTER_API ?? 'https://mainnet.zklighter.elliot.ai/api/v1'
const EXPLORER_API = 'https://explorer.elliot.ai/api'
const UA = 'paragrine-research/1.0'

export function num(x: unknown, def = 0): number {
  if (x == null) return def
  const n = Number(x)
  return isFinite(n) ? n : def
}

export async function lighterGet(
  path: string,
  params?: Record<string, string | number>,
  revalidate = 5,
): Promise<any> {
  const url = new URL(LIGHTER_API + path)
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    next: { revalidate },
  })
  if (!res.ok) throw new Error(`Lighter ${path} → ${res.status}`)
  return res.json()
}

export async function lighterGetNoCache(
  path: string,
  params?: Record<string, string | number>,
): Promise<any> {
  const url = new URL(LIGHTER_API + path)
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Lighter ${path} → ${res.status}`)
  return res.json()
}

export async function explorerGet(
  path: string,
  params?: Record<string, string | number>,
): Promise<any> {
  const url = new URL(EXPLORER_API + path)
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    next: { revalidate: 30 },
  })
  if (!res.ok) throw new Error(`Explorer ${path} → ${res.status}`)
  return res.json()
}

export type Market = {
  market_id: number
  symbol: string
  market_type: string
  last_price: number
  price_change: number
  volume_24h: number
  trades_24h: number
  oi_usd: number
  funding: number | null
  funding_apr: number | null
  price_high_24h: number
  price_low_24h: number
}

export type Trade = {
  id: string
  market_id: number
  symbol: string
  price: number
  size: number
  usd: number
  ts: number
  side: 'buy' | 'sell'
  is_liq: boolean
  buyer_id?: number
  seller_id?: number
}

export type LitTrade = {
  trade_id: number
  market_id: number
  ts: number
  price: number
  size: number
  usd: number
  buyer_id: number
  seller_id: number
  taker_is_buyer: number
}

export function normaliseMarkets(detailsRaw: any, fundingsRaw: any): Market[] {
  const allDetails: any[] = [
    ...(detailsRaw?.order_book_details ?? []),
    ...(detailsRaw?.spot_order_book_details ?? []),
  ]
  const fundings: any[] = fundingsRaw?.funding_rates ?? fundingsRaw?.fundingRates ?? fundingsRaw?.data ?? []
  const fundById: Record<number, number> = {}
  for (const f of fundings) {
    const mid = f.market_id ?? f.marketId
    const rate = f.rate ?? f.funding_rate
    if (mid != null && rate != null) fundById[Number(mid)] = num(rate)
  }
  return allDetails.flatMap((d: any) => {
    const mid = d.market_id ?? d.marketId
    if (mid == null) return []
    const last = num(d.last_trade_price)
    const oiBase = num(d.open_interest)
    const funding = fundById[Number(mid)] ?? null
    return [{
      market_id: Number(mid),
      symbol: d.symbol ?? `MKT-${mid}`,
      market_type: d.market_type ?? 'perp',
      last_price: last,
      price_change: num(d.daily_price_change),
      volume_24h: num(d.daily_quote_token_volume),
      trades_24h: Math.round(num(d.daily_trades_count)),
      oi_usd: oiBase * last,
      funding,
      funding_apr: funding != null ? funding * 3 * 365 * 100 : null,
      price_high_24h: num(d.daily_price_high),
      price_low_24h: num(d.daily_price_low),
    } as Market]
  })
}

export function normaliseTrade(raw: any, market: Market): Trade | null {
  const price = num(raw.price)
  const size = num(raw.size)
  if (price <= 0 || size <= 0) return null
  const rawTs = raw.timestamp
  let tsMs: number
  if (rawTs == null) {
    tsMs = Date.now()
  } else {
    const tsNum = num(rawTs)
    tsMs = Math.round(tsNum > 1e12 ? tsNum : tsNum * 1000)
  }
  let takerBuy: boolean
  if (typeof raw.is_maker_ask === 'boolean') {
    takerBuy = raw.is_maker_ask
  } else if (raw.taker_side === 'buy' || raw.taker_side === 'bid') {
    takerBuy = true
  } else if (raw.taker_side === 'sell' || raw.taker_side === 'ask') {
    takerBuy = false
  } else if (raw.side === 'buy' || raw.side === 'bid') {
    takerBuy = true
  } else if (raw.side === 'sell' || raw.side === 'ask') {
    takerBuy = false
  } else {
    takerBuy = true
  }
  const tradeIdRaw = raw.trade_id ?? raw.id ?? raw.tx_hash ?? `${tsMs}-${price}-${size}`
  return {
    id: `${market.market_id}-${tradeIdRaw}`,
    market_id: market.market_id,
    symbol: market.symbol,
    price,
    size,
    usd: price * size,
    ts: tsMs,
    side: takerBuy ? 'buy' : 'sell',
    is_liq: Boolean(raw.is_liquidation || raw.liquidation),
    buyer_id: raw.bid_account_id != null ? Number(raw.bid_account_id) : undefined,
    seller_id: raw.ask_account_id != null ? Number(raw.ask_account_id) : undefined,
  }
}

export function normaliseLitTrade(raw: any, marketId: number): LitTrade | null {
  const price = num(raw.price)
  const size = num(raw.size)
  const tradeId = raw.trade_id
  if (price <= 0 || size <= 0 || !tradeId) return null
  const takerIsBuyer = typeof raw.is_maker_ask === 'boolean' ? (raw.is_maker_ask ? 1 : 0) : 1
  const tsRaw = raw.timestamp ?? 0
  const tsMs = Math.round(num(tsRaw))
  return {
    trade_id: Number(tradeId),
    market_id: marketId,
    ts: tsMs,
    price,
    size,
    usd: price * size,
    buyer_id: Number(raw.bid_account_id ?? 0),
    seller_id: Number(raw.ask_account_id ?? 0),
    taker_is_buyer: takerIsBuyer,
  }
}

export const LIT_MARKETS = new Set([120, 2049])
export const LIT_STAKING_POOL = 281_474_976_710_654

export const CANDLE_RES_SECS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400,
}
