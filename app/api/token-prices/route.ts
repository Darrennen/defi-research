import { NextRequest, NextResponse } from 'next/server'

const SYMBOL_TO_GECKO: Record<string, string> = {
  ETH:    'ethereum',
  WETH:   'ethereum',
  BTC:    'bitcoin',
  WBTC:   'wrapped-bitcoin',
  stETH:  'staked-ether',
  wstETH: 'wrapped-steth',
  cbETH:  'coinbase-wrapped-staked-eth',
  cbBTC:  'coinbase-wrapped-btc',
  rETH:   'rocket-pool-eth',
  LINK:   'chainlink',
  AAVE:   'aave',
  UNI:    'uniswap',
  MKR:    'maker',
  CRV:    'curve-dao-token',
  LDO:    'lido-dao',
  RPL:    'rocket-pool',
  PENDLE: 'pendle',
  GMX:    'gmx',
  ARB:    'arbitrum',
  OP:     'optimism',
  SOL:    'solana',
  MATIC:  'matic-network',
  POL:    'matic-network',
  SNX:    'havven',
  BAL:    'balancer',
  COMP:   'compound-governance-token',
}

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const symbol = (searchParams.get('symbol') ?? '').toUpperCase()
  const days = Math.min(parseInt(searchParams.get('days') ?? '30'), 90)

  const geckoId = SYMBOL_TO_GECKO[symbol]
  if (!geckoId) {
    return NextResponse.json({ prices: [], symbol, error: 'unsupported token' })
  }

  try {
    const url = `https://api.coingecko.com/api/v3/coins/${geckoId}/market_chart?vs_currency=usd&days=${days}`
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'defi-research/1.0' },
      next: { revalidate: 3600 },
    })
    if (!res.ok) {
      return NextResponse.json({ prices: [], symbol, error: `upstream ${res.status}` })
    }
    const data = await res.json()
    return NextResponse.json({ prices: data.prices ?? [], symbol, geckoId })
  } catch {
    return NextResponse.json({ prices: [], symbol, error: 'fetch failed' })
  }
}
