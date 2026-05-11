import type { StablecoinAsset, YieldPool } from './types'

const STABLECOINS_BASE = 'https://stablecoins.llama.fi'
const YIELDS_BASE = 'https://yields.llama.fi'

export async function getStablecoins(): Promise<StablecoinAsset[]> {
  const res = await fetch(`${STABLECOINS_BASE}/stablecoins?includePrices=true`, {
    next: { revalidate: 300 },
  })
  if (!res.ok) throw new Error('Failed to fetch stablecoins')
  const data = await res.json()
  return data.peggedAssets as StablecoinAsset[]
}

export async function getYieldPools(): Promise<YieldPool[]> {
  // DeFiLlama yields response is ~18MB — too large for Next.js fetch cache.
  // Fetch fresh each request; data is filtered down to <50 rows per page before rendering.
  const res = await fetch(`${YIELDS_BASE}/pools`, { cache: 'no-store' })
  if (!res.ok) throw new Error('Failed to fetch yield pools')
  const data = await res.json()
  return data.data as YieldPool[]
}

export function formatUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

export function formatPct(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n)) return '—'
  return `${n.toFixed(2)}%`
}
