import { NextResponse } from 'next/server'

const ETH_RPC              = 'https://ethereum.publicnode.com'
const AAVE_POOL            = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const AAVE_DATA_PROVIDER   = '0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3'
const AAVE_ORACLE          = '0x54586bE62E3c3580375aE3723C145253060Ca0C2'
const PENDLE_CHAIN = 1

// Top Aave V3 Ethereum mainnet reserves — covers >95% of TVL
const AAVE_RESERVES = [
  { symbol: 'WETH',   address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18 },
  { symbol: 'WBTC',   address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', decimals: 8  },
  { symbol: 'USDC',   address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6  },
  { symbol: 'USDT',   address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6  },
  { symbol: 'DAI',    address: '0x6b175474e89094c44da98b954eedeac495271d0f', decimals: 18 },
  { symbol: 'wstETH', address: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', decimals: 18 },
  { symbol: 'cbETH',  address: '0xbe9895146f7af43049ca1c1ae358b0541ea49704', decimals: 18 },
  { symbol: 'rETH',   address: '0xae78736cd615f374d3085123a210448e74fc6393', decimals: 18 },
  { symbol: 'weETH',  address: '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee', decimals: 18 },
  { symbol: 'USDe',   address: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3', decimals: 18 },
  { symbol: 'GHO',    address: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f', decimals: 18 },
  { symbol: 'LINK',   address: '0x514910771af9ca656af840dff83e8264ecf986ca', decimals: 18 },
  { symbol: 'AAVE',   address: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', decimals: 18 },
  { symbol: 'LUSD',   address: '0x5f98805a4e8be255a32880fdec7f6728c6568ba0', decimals: 18 },
  { symbol: 'sDAI',   address: '0x83f20f44975d03b1b09e64809b757c47f942beea', decimals: 18 },
  { symbol: 'rsETH',  address: '0xa1290d69c65a6fe4df752f95823fae25cb99e5a7', decimals: 18 },
  { symbol: 'ezETH',  address: '0xbf5495efe5db9ce00f80364c8b423567e58d2110', decimals: 18 },
  { symbol: 'PYUSD',  address: '0x6c3ea9036406852006290770bedfcaba0e23a0e8', decimals: 6  },
  { symbol: 'osETH',  address: '0xf1c9acdc66974dfb6decb12aa385b9cd01190e38', decimals: 18 },
  { symbol: 'crvUSD', address: '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e', decimals: 18 },
] as const

function r2(n: number) { return Math.round(n * 100) / 100 }

async function ethCall(to: string, data: string): Promise<string> {
  const res = await fetch(ETH_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  })
  return (await res.json()).result ?? ''
}

function padAddr(addr: string): string {
  return '000000000000000000000000' + addr.replace('0x', '').toLowerCase()
}

// ── Aave V3 ───────────────────────────────────────────────────────────────────

async function fetchAave(address: string) {
  // getUserAccountData(address) = 0xbf92857c
  const result = await ethCall(AAVE_POOL, '0xbf92857c' + padAddr(address))
  if (!result || result.length < 386) return null

  const hex  = result.slice(2)
  const vals = Array.from({ length: 6 }, (_, i) =>
    BigInt('0x' + hex.slice(i * 64, (i + 1) * 64))
  )

  const totalCollateral = Number(vals[0]) / 1e8
  const totalDebt       = Number(vals[1]) / 1e8
  const availBorrow     = Number(vals[2]) / 1e8
  const liqThreshold    = Number(vals[3]) / 100   // basis points → %
  const ltv             = Number(vals[4]) / 100
  const hfRaw           = Number(vals[5]) / 1e18

  if (totalCollateral < 0.01 && totalDebt < 0.01) return null

  return {
    total_collateral:  r2(totalCollateral),
    total_debt:        r2(totalDebt),
    net_equity:        r2(totalCollateral - totalDebt),
    avail_borrow:      r2(availBorrow),
    liq_threshold_pct: r2(liqThreshold),
    ltv_pct:           r2(ltv),
    health_factor:     hfRaw > 1e6 ? null : r2(hfRaw),
  }
}

// ── Pendle ────────────────────────────────────────────────────────────────────

async function fetchPendle(address: string) {
  const [posResp, mktResp] = await Promise.all([
    fetch(
      `https://api-v2.pendle.finance/core/v1/dashboard/positions/database/${address}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    ),
    fetch(
      `https://api-v2.pendle.finance/core/v1/${PENDLE_CHAIN}/markets?skip=0&limit=100`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    ),
  ])
  const posData = await posResp.json()
  const mktData = await mktResp.json()

  const mktMap: Record<string, any> = {}
  for (const m of mktData.results ?? []) {
    mktMap[(m.address ?? '').toLowerCase()] = m
  }

  const chain   = (posData.positions ?? []).find((p: any) => p.chainId === PENDLE_CHAIN)
  if (!chain) return []

  const now = Date.now()
  const out: any[] = []

  for (const pos of [...(chain.openPositions ?? []), ...(chain.closedPositions ?? [])]) {
    const ptVal = pos.pt?.valuation ?? 0
    const ytVal = pos.yt?.valuation ?? 0
    const lpVal = pos.lp?.valuation ?? 0
    if (ptVal + ytVal + lpVal < 1) continue

    const mktAddr = (pos.marketId ?? '').split('-')[1] ?? ''
    const m       = mktMap[mktAddr] ?? {}
    const expiry  = m.expiry ?? null
    const daysLeft = expiry
      ? Math.max(0, Math.floor((new Date(expiry).getTime() - now) / 86_400_000))
      : null

    out.push({
      market_address:    mktAddr,
      name:              m.pt?.symbol ?? pos.marketId ?? '?',
      expiry:            expiry ? (expiry as string).slice(0, 10) : null,
      days_left:         daysLeft,
      implied_apy:       m.impliedApy    != null ? r2(m.impliedApy    * 100) : null,
      underlying_apy:    m.underlyingApy != null ? r2(m.underlyingApy * 100) : null,
      pt_balance:        r2(parseFloat(pos.pt?.balance  ?? '0') / 1e18),
      pt_value_usd:      r2(ptVal),
      yt_balance:        r2(parseFloat(pos.yt?.balance  ?? '0') / 1e18),
      yt_value_usd:      r2(ytVal),
      lp_balance:        r2(parseFloat(pos.lp?.balance  ?? '0') / 1e18),
      lp_value_usd:      r2(lpVal),
      total_value_usd:   r2(ptVal + ytVal + lpVal),
      status:            ptVal + ytVal + lpVal > 0 ? 'open' : 'closed',
    })
  }

  return out.sort((a, b) => b.total_value_usd - a.total_value_usd)
}

// ── PT wallet balances ────────────────────────────────────────────────────────

async function fetchPtBalances(address: string): Promise<any[]> {
  const mktResp = await fetch(
    `https://api-v2.pendle.finance/core/v1/${PENDLE_CHAIN}/markets?skip=0&limit=100`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  )
  const mktData = await mktResp.json()

  const pts = (mktData.results ?? [])
    .filter((m: any) => m.pt?.address && m.isActive !== false)
    .sort((a: any, b: any) => (parseFloat(b.liquidity?.usd ?? '0') - parseFloat(a.liquidity?.usd ?? '0')))
    .slice(0, 50)
    .map((m: any) => ({
      address:     (m.pt.address as string).toLowerCase(),
      symbol:      m.pt.symbol ?? '?',
      price_usd:   m.pt.price?.usd ?? null,
      expiry:      (m.expiry ?? '').slice(0, 10),
      days_left:   m.expiry
        ? Math.max(0, Math.floor((new Date(m.expiry).getTime() - Date.now()) / 86_400_000))
        : null,
      implied_apy: m.impliedApy != null ? r2(m.impliedApy * 100) : null,
    }))

  // balanceOf(address) = 0x70a08231
  const data = '0x70a08231' + padAddr(address)
  const results = await Promise.all(pts.map(async (pt: any) => {
    try {
      const result = await ethCall(pt.address, data)
      if (!result || result === '0x') return null
      const balance = Number(BigInt(result)) / 1e18
      if (balance < 0.001) return null
      return {
        ...pt,
        balance:   r2(balance),
        value_usd: pt.price_usd ? r2(balance * pt.price_usd) : null,
      }
    } catch { return null }
  }))

  return results.filter(Boolean) as any[]
}

// ── Aave V3 per-asset positions ───────────────────────────────────────────────

async function fetchAaveMarkets(address: string) {
  const userHex = padAddr(address)

  // getUserReserveData(address asset, address user) = 0x28dd2d01
  const reserveData = await Promise.all(
    AAVE_RESERVES.map(async (res) => {
      try {
        const data = '0x28dd2d01' + padAddr(res.address) + userHex
        const result = await ethCall(AAVE_DATA_PROVIDER, data)
        // 9 ABI slots × 64 hex chars + 2 for "0x" = 578
        if (!result || result.length < 578) return null
        const hex = result.slice(2)
        const aTokenBalance = BigInt('0x' + hex.slice(0 * 64, 1 * 64))
        const variableDebt  = BigInt('0x' + hex.slice(2 * 64, 3 * 64))
        const isCollateral  = BigInt('0x' + hex.slice(8 * 64, 9 * 64)) === 1n
        if (aTokenBalance === 0n && variableDebt === 0n) return null
        return { res, aTokenBalance, variableDebt, isCollateral }
      } catch { return null }
    })
  )

  const nonZero = reserveData.filter(Boolean) as {
    res: typeof AAVE_RESERVES[number]
    aTokenBalance: bigint
    variableDebt: bigint
    isCollateral: boolean
  }[]
  if (nonZero.length === 0) return []

  // getAssetPrice(address) = 0xb3596f07 — price in USD with 8 decimals
  const prices = await Promise.all(
    nonZero.map(async ({ res }) => {
      try {
        const result = await ethCall(AAVE_ORACLE, '0xb3596f07' + padAddr(res.address))
        if (!result || result === '0x') return 0
        return Number(BigInt(result)) / 1e8
      } catch { return 0 }
    })
  )

  return nonZero
    .map(({ res, aTokenBalance, variableDebt, isCollateral }, i) => {
      const price = prices[i]
      const factor = Math.pow(10, res.decimals)
      const supplyAmt = Number(aTokenBalance) / factor
      const borrowAmt = Number(variableDebt) / factor
      return {
        symbol:        res.symbol,
        supply_amount: r2(supplyAmt),
        supply_usd:    r2(supplyAmt * price),
        borrow_amount: r2(borrowAmt),
        borrow_usd:    r2(borrowAmt * price),
        price_usd:     r2(price),
        is_collateral: isCollateral,
      }
    })
    .filter(m => m.supply_usd > 0.01 || m.borrow_usd > 0.01)
    .sort((a, b) => (b.supply_usd + b.borrow_usd) - (a.supply_usd + a.borrow_usd))
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')?.toLowerCase()

  if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'invalid address' }, { status: 400 })
  }

  const [aaveR, pendleR, ptBalR, aaveMktR] = await Promise.allSettled([
    fetchAave(address),
    fetchPendle(address),
    fetchPtBalances(address),
    fetchAaveMarkets(address),
  ])

  // Deduplicate PT wallet balances against Pendle portfolio positions
  const pendlePos    = pendleR.status === 'fulfilled' ? (pendleR.value ?? []) : []
  const knownMarkets = new Set(pendlePos.map((p: any) => p.market_address))
  const ptBal        = (ptBalR.status === 'fulfilled' ? (ptBalR.value ?? []) : [])
    .filter((b: any) => b.value_usd > 0)

  return NextResponse.json({
    aave:         aaveR.status    === 'fulfilled' ? aaveR.value    : null,
    aave_markets: aaveMktR.status === 'fulfilled' ? aaveMktR.value : [],
    pendle:       pendlePos,
    pt_balances:  ptBal,
    _known_pendle_markets: [...knownMarkets],
  })
}
