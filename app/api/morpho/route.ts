import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const MORPHO_GQL = 'https://blue-api.morpho.org/graphql'

const CHAINS = {
  ethereum: {
    name: 'Ethereum',
    chainId: 1,
    icon: 'https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg',
    explorer: 'https://etherscan.io/address',
  },
  base: {
    name: 'Base',
    chainId: 8453,
    icon: 'https://icons.llamao.fi/icons/chains/rsz_base.jpg',
    explorer: 'https://basescan.org/address',
  },
} as const

type ChainKey = keyof typeof CHAINS

const QUERY = `
query Markets($chainId: Int!) {
  markets(
    where: { chainId_in: [$chainId] }
    first: 200
    orderBy: SupplyAssetsUsd
    orderDirection: Desc
  ) {
    items {
      marketId
      lltv
      collateralAsset { symbol address price { usd } }
      loanAsset { symbol address price { usd } }
      state {
        supplyApy
        borrowApy
        utilization
        supplyAssets
        borrowAssets
        supplyAssetsUsd
        borrowAssetsUsd
      }
    }
  }
}
`

export async function GET(req: NextRequest) {
  const key = (req.nextUrl.searchParams.get('chain') ?? 'ethereum') as ChainKey
  const cfg = CHAINS[key] ?? CHAINS.ethereum

  try {
    const res = await fetch(MORPHO_GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'defi-research/1.0' },
      body: JSON.stringify({ query: QUERY, variables: { chainId: cfg.chainId } }),
      cache: 'no-store',
    })

    const json = await res.json()
    const items: any[] = json.data?.markets?.items ?? []

    const markets = items
      .filter((m) => {
        const supplyUsd = parseFloat(m.state?.supplyAssetsUsd) || 0
        const rawApy = parseFloat(m.state?.supplyApy) || 0
        // filter dust markets and spam/exploit markets (APY > 500 raw = >50,000%)
        return supplyUsd >= 1000 && rawApy < 5
      })
      .map((m) => {
        const lltv = (parseFloat(m.lltv) / 1e18) * 100
        const supplyApy = (parseFloat(m.state?.supplyApy) || 0) * 100
        const borrowApy = (parseFloat(m.state?.borrowApy) || 0) * 100
        const rawUtil = parseFloat(m.state?.utilization)
        const supplyRaw = parseFloat(m.state?.supplyAssets) || 0
        const borrowRaw = parseFloat(m.state?.borrowAssets) || 0
        const utilization = !isNaN(rawUtil)
          ? rawUtil * 100
          : supplyRaw > 0
          ? (borrowRaw / supplyRaw) * 100
          : 0
        const totalSupplyUsd = parseFloat(m.state?.supplyAssetsUsd) || 0
        const totalBorrowUsd = parseFloat(m.state?.borrowAssetsUsd) || 0
        const collateralSymbol = m.collateralAsset?.symbol ?? '—'
        const loanSymbol = m.loanAsset?.symbol ?? '—'

        return {
          marketId: m.marketId as string,
          pair: `${collateralSymbol} / ${loanSymbol}`,
          collateralSymbol,
          loanSymbol,
          collateralAddress: (m.collateralAsset?.address ?? '') as string,
          loanAddress: (m.loanAsset?.address ?? '') as string,
          lltv: Math.round(lltv * 100) / 100,
          supplyApy: Math.round(supplyApy * 100) / 100,
          borrowApy: Math.round(borrowApy * 100) / 100,
          utilization: Math.round(utilization * 100) / 100,
          totalSupplyUsd,
          totalBorrowUsd,
          collateralPriceUsd: parseFloat(m.collateralAsset?.price?.usd) || 0,
          loanPriceUsd: parseFloat(m.loanAsset?.price?.usd) || 0,
        }
      })

    const totalSupplyUsd = markets.reduce((s, m) => s + m.totalSupplyUsd, 0)
    const totalBorrowUsd = markets.reduce((s, m) => s + m.totalBorrowUsd, 0)
    const activeMarkets = markets.filter((m) => m.totalSupplyUsd > 0).length

    return NextResponse.json({
      markets,
      chain: cfg.name,
      chainIcon: cfg.icon,
      chains: buildChainMeta(),
      totalSupplyUsd,
      totalBorrowUsd,
      activeMarkets,
      fetchedAt: new Date().toISOString(),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

function buildChainMeta() {
  return Object.fromEntries(
    Object.entries(CHAINS).map(([k, v]) => [k, { name: v.name, icon: v.icon }])
  )
}
