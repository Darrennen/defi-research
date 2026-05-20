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

const MARKETS_QUERY = `
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
      oracleAddress
      irmAddress
      creationTimestamp
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
        fee
      }
    }
  }
}
`

const VAULTS_QUERY = `
query Vaults($chainId: Int!) {
  vaults(
    where: { chainId_in: [$chainId] }
    first: 20
    orderBy: TotalAssetsUsd
    orderDirection: Desc
  ) {
    items {
      address
      name
      symbol
      asset { symbol }
      state {
        totalAssetsUsd
        apy
        netApy
        fee
      }
    }
  }
}
`

export async function GET(req: NextRequest) {
  const key = (req.nextUrl.searchParams.get('chain') ?? 'ethereum') as ChainKey
  const cfg = CHAINS[key] ?? CHAINS.ethereum

  try {
    const [marketsRes, vaultsRes] = await Promise.all([
      fetch(MORPHO_GQL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'defi-research/1.0' },
        body: JSON.stringify({ query: MARKETS_QUERY, variables: { chainId: cfg.chainId } }),
        cache: 'no-store',
      }),
      fetch(MORPHO_GQL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'defi-research/1.0' },
        body: JSON.stringify({ query: VAULTS_QUERY, variables: { chainId: cfg.chainId } }),
        cache: 'no-store',
      }),
    ])

    const [marketsJson, vaultsJson] = await Promise.all([marketsRes.json(), vaultsRes.json()])

    const items: any[] = marketsJson.data?.markets?.items ?? []

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
        const fee = parseFloat(m.state?.fee) || 0
        const collateralSymbol = m.collateralAsset?.symbol ?? '—'
        const loanSymbol = m.loanAsset?.symbol ?? '—'

        return {
          marketId: m.marketId as string,
          pair: `${collateralSymbol} / ${loanSymbol}`,
          collateralSymbol,
          loanSymbol,
          collateralAddress: (m.collateralAsset?.address ?? '') as string,
          loanAddress: (m.loanAsset?.address ?? '') as string,
          oracleAddress: (m.oracleAddress ?? '') as string,
          irmAddress: (m.irmAddress ?? '') as string,
          creationTimestamp: (m.creationTimestamp ?? 0) as number,
          lltv: Math.round(lltv * 100) / 100,
          supplyApy: Math.round(supplyApy * 100) / 100,
          borrowApy: Math.round(borrowApy * 100) / 100,
          utilization: Math.round(utilization * 100) / 100,
          totalSupplyUsd,
          totalBorrowUsd,
          fee: Math.round(fee * 10000) / 100,
          collateralPriceUsd: parseFloat(m.collateralAsset?.price?.usd) || 0,
          loanPriceUsd: parseFloat(m.loanAsset?.price?.usd) || 0,
        }
      })

    const totalSupplyUsd = markets.reduce((s, m) => s + m.totalSupplyUsd, 0)
    const totalBorrowUsd = markets.reduce((s, m) => s + m.totalBorrowUsd, 0)
    const activeMarkets = markets.filter((m) => m.totalSupplyUsd > 0).length
    const highUtilMarkets = markets.filter((m) => m.utilization >= 80).length

    const vaultItems: any[] = vaultsJson.data?.vaults?.items ?? []
    const vaults = vaultItems.map((v) => ({
      address: v.address as string,
      name: v.name as string,
      symbol: v.symbol as string,
      assetSymbol: v.asset?.symbol ?? '—',
      totalAssetsUsd: parseFloat(v.state?.totalAssetsUsd) || 0,
      apy: Math.round((parseFloat(v.state?.apy) || 0) * 10000) / 100,
      netApy: Math.round((parseFloat(v.state?.netApy) || 0) * 10000) / 100,
      fee: Math.round((parseFloat(v.state?.fee) || 0) * 10000) / 100,
    }))

    return NextResponse.json({
      markets,
      vaults,
      chain: cfg.name,
      chainIcon: cfg.icon,
      chains: buildChainMeta(),
      totalSupplyUsd,
      totalBorrowUsd,
      activeMarkets,
      highUtilMarkets,
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
