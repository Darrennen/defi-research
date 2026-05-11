import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const CHAINS = {
  'ethereum-core': {
    name: 'Ethereum (Core)',
    rpc: 'https://ethereum.publicnode.com',
    pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    llamaPrefix: 'ethereum',
    icon: 'https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg',
  },
  arbitrum: {
    name: 'Arbitrum',
    rpc: 'https://arbitrum-one.publicnode.com',
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    llamaPrefix: 'arbitrum',
    icon: 'https://icons.llamao.fi/icons/chains/rsz_arbitrum.jpg',
  },
  base: {
    name: 'Base',
    rpc: 'https://base.publicnode.com',
    pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    llamaPrefix: 'base',
    icon: 'https://icons.llamao.fi/icons/chains/rsz_base.jpg',
  },
  polygon: {
    name: 'Polygon',
    rpc: 'https://polygon-bor-rpc.publicnode.com',
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    llamaPrefix: 'polygon',
    icon: 'https://icons.llamao.fi/icons/chains/rsz_polygon.jpg',
  },
  optimism: {
    name: 'Optimism',
    rpc: 'https://optimism.publicnode.com',
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    llamaPrefix: 'optimism',
    icon: 'https://icons.llamao.fi/icons/chains/rsz_optimism.jpg',
  },
  avalanche: {
    name: 'Avalanche',
    rpc: 'https://avalanche-c-chain-rpc.publicnode.com',
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    llamaPrefix: 'avax',
    icon: 'https://icons.llamao.fi/icons/chains/rsz_avalanche.jpg',
  },
} as const

type ChainKey = keyof typeof CHAINS

// ── ABI helpers ──────────────────────────────────────────────────────────────

async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'defi-research/1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }),
    cache: 'no-store',
  })
  const json = await res.json()
  const raw = (json.result as string | undefined) ?? '0x0'
  return raw === '0x' ? '0x0' : raw
}

// Decode address[] ABI return (offset + length + packed addresses)
function decodeAddressArray(hex: string): string[] {
  const d = hex.startsWith('0x') ? hex.slice(2) : hex
  if (d.length < 128) return []
  const length = parseInt(d.slice(64, 128), 16)
  const addrs: string[] = []
  for (let i = 0; i < length; i++) {
    const start = 128 + i * 64 + 24
    addrs.push('0x' + d.slice(start, start + 40))
  }
  return addrs
}

function parseSlots(hex: string): bigint[] {
  const d = hex.startsWith('0x') ? hex.slice(2) : hex
  const out: bigint[] = []
  for (let i = 0; i < d.length; i += 64) out.push(BigInt('0x' + (d.slice(i, i + 64) || '0')))
  return out
}

function toAddr(val: bigint): string {
  return '0x' + val.toString(16).padStart(40, '0')
}

const RAY = 1e27

function decodeConfig(c: bigint) {
  return {
    ltv:                  Number(c & 0xFFFFn) / 100,
    liquidationThreshold: Number((c >> 16n) & 0xFFFFn) / 100,
    liquidationBonus:     Number((c >> 32n) & 0xFFFFn) / 100,
    decimals:             Number((c >> 48n) & 0xFFn),
    reserveFactor:        Number((c >> 64n) & 0xFFFFn) / 100,
    borrowCap:            Number((c >> 80n) & 0xFFFFFFFFFn),
    supplyCap:            Number((c >> 116n) & 0xFFFFFFFFFn),
  }
}

async function batch<T, R>(items: T[], fn: (item: T) => Promise<R>, size = 15): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    const chunk = await Promise.all(items.slice(i, i + size).map(fn))
    out.push(...chunk)
  }
  return out
}

// ── handler ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const key = (req.nextUrl.searchParams.get('chain') ?? 'ethereum-core') as ChainKey
  const cfg = CHAINS[key] ?? CHAINS['ethereum-core']

  try {
    // 1. Get reserve list directly from on-chain (getReservesList selector: 0xd1946dbc)
    const listRaw = await ethCall(cfg.rpc, cfg.pool, '0xd1946dbc')
    const assets = decodeAddressArray(listRaw)

    if (!assets.length) {
      return NextResponse.json({ reserves: [], chain: cfg.name, chains: buildChainMeta() })
    }

    // 2. Fetch prices + symbols from DeFiLlama coins API
    const ids = assets.map(a => `${cfg.llamaPrefix}:${a.toLowerCase()}`).join(',')
    let coins: Record<string, { price: number; symbol?: string; decimals?: number }> = {}
    try {
      const pr = await fetch(`https://coins.llama.fi/prices/current/${ids}`, { cache: 'no-store' })
      coins = (await pr.json()).coins ?? {}
    } catch { /* prices optional */ }

    // 3. getReserveData(asset) for each asset — batched
    const reserveDataRaw = await batch(assets, async (asset) => {
      const padded = asset.slice(2).padStart(64, '0')
      const raw = await ethCall(cfg.rpc, cfg.pool, '0x35ea6a75' + padded)
      return { asset, raw }
    })

    // 4. totalSupply on aToken + vDebt — batched
    const processed = await batch(reserveDataRaw, async ({ asset, raw }) => {
      const s = parseSlots(raw)
      if (s.length < 11) return null

      const config           = decodeConfig(s[0])
      const supplyApy        = Number(s[2]) / RAY * 100
      const borrowApy        = Number(s[4]) / RAY * 100
      const aTokenAddress    = toAddr(s[8])
      const vDebtAddress     = toAddr(s[10])

      const coinKey = `${cfg.llamaPrefix}:${asset.toLowerCase()}`
      const coinData = coins[coinKey]
      const dec      = coinData?.decimals ?? (config.decimals || 18)
      const divisor  = 10 ** dec

      const [aRaw, vRaw] = await Promise.all([
        ethCall(cfg.rpc, aTokenAddress, '0x18160ddd'),
        ethCall(cfg.rpc, vDebtAddress, '0x18160ddd'),
      ])

      const totalSupplied = Number(BigInt(aRaw)) / divisor
      const totalBorrowed = Number(BigInt(vRaw)) / divisor
      const utilization   = totalSupplied > 0 ? (totalBorrowed / totalSupplied) * 100 : 0
      const price         = coinData?.price ?? 0
      const symbol        = coinData?.symbol ?? asset.slice(0, 6)

      return {
        symbol,
        assetAddress: asset,
        aTokenAddress,
        vDebtAddress,
        supplyApy,
        borrowApy,
        utilization,
        totalSupplied,
        totalBorrowed,
        price,
        totalSuppliedUsd:  totalSupplied * price,
        totalBorrowedUsd:  totalBorrowed * price,
        supplyCapUsd:      config.supplyCap > 0 ? config.supplyCap * price : null,
        borrowCapUsd:      config.borrowCap > 0 ? config.borrowCap * price : null,
        ...config,
      }
    })

    const reserves = (processed.filter(Boolean) as NonNullable<(typeof processed)[number]>[])
      .sort((a, b) => b.totalSuppliedUsd - a.totalSuppliedUsd)

    return NextResponse.json({
      reserves,
      chain:     cfg.name,
      chainIcon: cfg.icon,
      chains:    buildChainMeta(),
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
