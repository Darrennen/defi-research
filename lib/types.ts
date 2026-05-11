export interface StablecoinAsset {
  id: string
  name: string
  symbol: string
  pegType: string
  pegMechanism: string
  circulating: { peggedUSD?: number; peggedEUR?: number }
  price: number
  chains: string[]
}

export interface YieldPool {
  pool: string
  chain: string
  project: string
  symbol: string
  tvlUsd: number
  apyBase: number | null
  apyReward: number | null
  apy: number | null
  apyBaseBorrow: number | null
  apyRewardBorrow: number | null
  apyBorrow: number | null
  stablecoin: boolean
  ilRisk: string
  exposure: string
  poolMeta: string | null
  rewardTokens: string[] | null
  underlyingTokens: string[] | null
}
