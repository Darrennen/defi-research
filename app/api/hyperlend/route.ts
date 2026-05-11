import { NextResponse } from 'next/server'

const RPC = 'https://rpc.hyperliquid.xyz/evm'
const POOL = '0x00a89d7a5a02160f20150ebea7a2b5e4879a1a8b'
const RAY = 1e27

// Known HyperLend Core Pool reserves (from on-chain + DeFiLlama)
const ASSETS = [
  { symbol: 'kHYPE',   address: '0xfD739d4e423301CE9385c1fb8850539D657C296D' },
  { symbol: 'WHYPE',   address: '0x5555555555555555555555555555555555555555' },
  { symbol: 'USDC',    address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f' },
  { symbol: 'wstHYPE', address: '0x94e8396e0869c9F2200760aF0621aFd240E1CF38' },
  { symbol: 'UBTC',    address: '0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463' },
]

async function ethCall(to: string, data: string): Promise<string> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }),
    cache: 'no-store',
  })
  const json = await res.json()
  const raw = (json.result as string | undefined) ?? '0x0'
  return raw === '0x' ? '0x0' : raw
}

function slots(hex: string): bigint[] {
  const d = hex.startsWith('0x') ? hex.slice(2) : hex
  const out: bigint[] = []
  for (let i = 0; i < d.length; i += 64) {
    out.push(BigInt('0x' + (d.slice(i, i + 64) || '0')))
  }
  return out
}

function toAddr(val: bigint): string {
  return '0x' + val.toString(16).padStart(40, '0')
}

function decodeConfig(c: bigint) {
  return {
    ltv:                 Number(c & 0xFFFFn) / 100,
    liquidationThreshold: Number((c >> 16n) & 0xFFFFn) / 100,
    liquidationBonus:    Number((c >> 32n) & 0xFFFFn) / 100,
    decimals:            Number((c >> 48n) & 0xFFn),
    reserveFactor:       Number((c >> 64n) & 0xFFFFn) / 100,
    // supply cap in whole tokens (36-bit field, 0 = no cap)
    supplyCap:           Number((c >> 116n) & 0xFFFFFFFFFn),
    // borrow cap in whole tokens (36-bit field, 0 = no cap)
    borrowCap:           Number((c >> 80n) & 0xFFFFFFFFFn),
  }
}

export async function GET() {
  try {
    const reserves = await Promise.all(
      ASSETS.map(async (asset) => {
        const padded = asset.address.slice(2).padStart(64, '0')
        const raw = await ethCall(POOL, '0x35ea6a75' + padded)
        const s = slots(raw)
        if (s.length < 11) return null

        const cfg = decodeConfig(s[0])
        const supplyApy = Number(s[2]) / RAY * 100
        const borrowApy = Number(s[4]) / RAY * 100
        const aTokenAddress = toAddr(s[8])
        const vDebtAddress  = toAddr(s[10])

        const dec = cfg.decimals || 18
        const divisor = 10 ** dec

        const [aRaw, vRaw] = await Promise.all([
          ethCall(aTokenAddress, '0x18160ddd'),
          ethCall(vDebtAddress,  '0x18160ddd'),
        ])

        const totalSupplied = Number(BigInt(aRaw)) / divisor
        const totalBorrowed = Number(BigInt(vRaw)) / divisor
        const utilization   = totalSupplied > 0 ? (totalBorrowed / totalSupplied) * 100 : 0

        return {
          symbol: asset.symbol,
          assetAddress: asset.address,
          aTokenAddress,
          vDebtAddress,
          supplyApy,
          borrowApy,
          utilization,
          totalSupplied,
          totalBorrowed,
          ...cfg,
        }
      })
    )

    const valid = reserves.filter(Boolean)

    // Prices via DeFiLlama coins API
    const ids = ASSETS.map(a => `hyperliquid:${a.address.toLowerCase()}`).join(',')
    const priceRes = await fetch(`https://coins.llama.fi/prices/current/${ids}`, { cache: 'no-store' })
    const priceData = await priceRes.json()

    const withPrices = valid.map((r, i) => {
      if (!r) return null
      const key   = `hyperliquid:${ASSETS[i].address.toLowerCase()}`
      const price = (priceData.coins?.[key]?.price as number) ?? 0
      return {
        ...r,
        price,
        totalSuppliedUsd: r.totalSupplied * price,
        totalBorrowedUsd: r.totalBorrowed * price,
        supplyCapUsd:     r.supplyCap > 0 ? r.supplyCap * price : null,
        borrowCapUsd:     r.borrowCap > 0 ? r.borrowCap * price : null,
      }
    })

    return NextResponse.json({ reserves: withPrices, fetchedAt: new Date().toISOString() })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
