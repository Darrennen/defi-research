import { NextResponse } from 'next/server'

const MORPHO_GQL = 'https://blue-api.morpho.org/graphql'

const QUERY = `
query UserPositions($address: String!, $chainId: Int!) {
  userByAddress(address: $address, chainId: $chainId) {
    marketPositions {
      market {
        uniqueKey
        lltv
        collateralAsset { address symbol decimals priceUsd }
        loanAsset { symbol decimals priceUsd }
        state { borrowApy supplyApy }
      }
      borrowAssets
      borrowAssetsUsd
      collateral
      collateralUsd
      healthFactor
      supplyAssets
      supplyAssetsUsd
      state {
        borrowPnlUsd
        borrowRoe
        timestamp
      }
      historicalState {
        collateralUsd { x y }
        borrowAssetsUsd { x y }
      }
    }
  }
}
`

function downsample<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr
  const step = arr.length / maxPoints
  return Array.from({ length: maxPoints }, (_, i) => arr[Math.round(i * step)])
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')?.toLowerCase()
  const chainIdRaw = searchParams.get('chainId') || '1'
  const chainId = parseInt(chainIdRaw)

  if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'invalid address' }, { status: 400 })
  }
  if (![1, 8453].includes(chainId)) {
    return NextResponse.json({ error: 'unsupported chainId' }, { status: 400 })
  }

  const res = await fetch(MORPHO_GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { address, chainId } }),
    next: { revalidate: 30 },
  })

  const json = await res.json()
  const positions = json.data?.userByAddress?.marketPositions ?? []

  const parsed = positions
    .filter((p: any) => parseFloat(p.borrowAssetsUsd) > 1 || parseFloat(p.supplyAssetsUsd) > 1 || parseFloat(p.collateralUsd) > 1)
    .map((p: any) => {
      const collUsd = parseFloat(p.collateralUsd) || 0
      const borrowUsd = parseFloat(p.borrowAssetsUsd) || 0
      const supplyUsd = parseFloat(p.supplyAssetsUsd) || 0
      const lltv = parseFloat(p.market.lltv) / 1e18
      const ltv = collUsd > 0 ? borrowUsd / collUsd : 0
      const hf = parseFloat(p.healthFactor) || 0
      const borrowApy = parseFloat(p.market.state?.borrowApy) || 0
      const supplyApy = parseFloat(p.market.state?.supplyApy) || 0
      const collPriceUsd = parseFloat(p.market.collateralAsset?.priceUsd) || 0
      const loanPriceUsd = parseFloat(p.market.loanAsset?.priceUsd) || 1
      const collAmount = collPriceUsd > 0 ? collUsd / collPriceUsd : 0
      const liqPrice = collAmount > 0 ? (borrowUsd / loanPriceUsd * loanPriceUsd) / (collAmount * lltv) : 0
      const dropToLiq = collPriceUsd > 0 && liqPrice > 0 ? ((collPriceUsd - liqPrice) / collPriceUsd) * 100 : 0

      // Align collateral and borrow time-series via step-interpolation.
      // The two series have different timestamps; naive timestamp-matching creates
      // many points with borrow=0 (collateral deposited before borrow tx),
      // which falsely inflates entry equity.
      const rawColl: { x: number; y: number }[] = p.historicalState?.collateralUsd ?? []
      const rawBorrow: { x: number; y: number }[] = p.historicalState?.borrowAssetsUsd ?? []

      const allTs = Array.from(new Set([...rawColl.map(p => p.x), ...rawBorrow.map(p => p.x)])).sort((a, b) => a - b)
      const collMap = new Map(rawColl.map(p => [p.x, p.y]))
      const borrowMap = new Map(rawBorrow.map(p => [p.x, p.y]))
      let lastColl = 0, lastBorrow = 0
      const aligned = allTs.map(ts => {
        if (collMap.has(ts)) lastColl = collMap.get(ts)!
        if (borrowMap.has(ts)) lastBorrow = borrowMap.get(ts)!
        return { ts, coll: lastColl, borrow: lastBorrow }
      })

      // Only keep points where borrow > 0 (position fully opened)
      const equityPoints = aligned
        .filter(v => v.borrow > 0 && v.coll > 0)
        .map(v => ({ ts: v.ts, equity: v.coll - v.borrow }))
        .filter(pt => pt.equity > 0)

      const sampled = downsample(equityPoints, 90)

      // Growth stats from history
      const firstPt = equityPoints[0]
      const entryEquity = firstPt?.equity ?? null
      const entryTs = firstPt?.ts ?? null
      const currentEquity = collUsd - borrowUsd
      const daysHeld = entryTs ? (Date.now() / 1000 - entryTs) / 86400 : null
      const pnlUsd = entryEquity != null ? currentEquity - entryEquity : (parseFloat(p.state?.borrowPnlUsd) || null)
      const returnPct = entryEquity != null && entryEquity > 0 ? (pnlUsd! / entryEquity) * 100 : null
      const apr = returnPct != null && daysHeld != null && daysHeld > 0 ? (returnPct / daysHeld) * 365 : null

      return {
        market: p.market.uniqueKey,
        collateralAddress: (p.market.collateralAsset?.address || '').toLowerCase(),
        collateralSymbol: p.market.collateralAsset?.symbol || '—',
        loanSymbol: p.market.loanAsset?.symbol || '—',
        lltv: Math.round(lltv * 10000) / 100,
        collUsd,
        borrowUsd,
        supplyUsd,
        ltv: Math.round(ltv * 10000) / 100,
        hf,
        borrowApy: Math.round(borrowApy * 10000) / 100,
        supplyApy: Math.round(supplyApy * 10000) / 100,
        collateralPrice: collPriceUsd,
        liquidationPrice: Math.round(liqPrice * 100) / 100,
        dropToLiq: Math.round(dropToLiq * 10) / 10,
        dailyCost: Math.round(borrowUsd * borrowApy / 365 * 100) / 100,
        monthlyCost: Math.round(borrowUsd * borrowApy / 12 * 100) / 100,
        annualCost: Math.round(borrowUsd * borrowApy * 100) / 100,
        // Growth tracking
        entryEquity,
        entryTs,
        currentEquity,
        pnlUsd,
        returnPct: returnPct != null ? Math.round(returnPct * 100) / 100 : null,
        apr: apr != null ? Math.round(apr * 100) / 100 : null,
        daysHeld: daysHeld != null ? Math.round(daysHeld * 10) / 10 : null,
        history: sampled,
      }
    })

  // Enrich any position whose collateral is a Pendle PT token
  const ptPositions = parsed.filter((p: any) => p.collateralSymbol.startsWith('PT-'))
  if (ptPositions.length > 0) {
    try {
      const mktResp = await fetch(
        'https://api-v2.pendle.finance/core/v1/1/markets?skip=0&limit=100',
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      )
      const mktData = await mktResp.json()
      const ptMap: Record<string, any> = {}
      for (const m of mktData.results ?? []) {
        if (m.pt?.address) ptMap[(m.pt.address as string).toLowerCase()] = m
      }
      for (const p of ptPositions) {
        const m = ptMap[p.collateralAddress] ?? null
        if (!m) continue
        const expiry = m.expiry ?? null
        p.pt_implied_apy    = m.impliedApy    != null ? Math.round(m.impliedApy    * 10000) / 100 : null
        p.pt_underlying_apy = m.underlyingApy != null ? Math.round(m.underlyingApy * 10000) / 100 : null
        p.pt_expiry         = expiry ? (expiry as string).slice(0, 10) : null
        p.pt_days_left      = expiry ? Math.max(0, Math.floor((new Date(expiry).getTime() - Date.now()) / 86_400_000)) : null
        // Maturity projection: collateral grows to face value at expiry
        if (p.pt_implied_apy != null && p.pt_days_left != null && p.collUsd > 0) {
          const yrs = p.pt_days_left / 365
          p.pt_maturity_value = Math.round(p.collUsd * Math.pow(1 + p.pt_implied_apy / 100, yrs) * 100) / 100
          p.pt_locked_profit  = Math.round((p.pt_maturity_value - p.collUsd) * 100) / 100
          // Net at maturity = PT matures to face value, repay borrow + accrued interest
          const borrowAtExpiry = p.borrowUsd * Math.pow(1 + p.borrowApy / 100, yrs)
          p.pt_net_at_maturity = Math.round((p.pt_maturity_value - borrowAtExpiry) * 100) / 100
        }
      }
    } catch { /* non-critical enrichment */ }
  }

  return NextResponse.json({ positions: parsed })
}
