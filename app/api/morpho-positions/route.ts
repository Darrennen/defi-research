import { NextResponse } from 'next/server'

const MORPHO_GQL = 'https://blue-api.morpho.org/graphql'

const QUERY = `
query UserPositions($address: String!, $chainId: Int!) {
  userByAddress(address: $address, chainId: $chainId) {
    marketPositions {
      market {
        uniqueKey
        lltv
        collateralAsset { symbol decimals priceUsd }
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
    }
  }
}
`

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')?.toLowerCase()
  const chainId = parseInt(searchParams.get('chainId') || '1')

  if (!address) return NextResponse.json({ error: 'address required' }, { status: 400 })

  const res = await fetch(MORPHO_GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { address, chainId } }),
    next: { revalidate: 30 },
  })

  const json = await res.json()
  const positions = json.data?.userByAddress?.marketPositions ?? []

  const parsed = positions
    .filter((p: any) => parseFloat(p.borrowAssetsUsd) > 1 || parseFloat(p.supplyAssetsUsd) > 1)
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

      return {
        market: p.market.uniqueKey,
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
      }
    })

  return NextResponse.json({ positions: parsed })
}
