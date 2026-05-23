import { NextResponse } from 'next/server'

const ETH_RPC     = 'https://ethereum.publicnode.com'
const AAVE_POOL   = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const PENDLE_CHAIN = 1

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
      pt_balance:        r2(parseFloat(pos.pt?.balance  ?? '0')),
      pt_value_usd:      r2(ptVal),
      yt_balance:        r2(parseFloat(pos.yt?.balance  ?? '0')),
      yt_value_usd:      r2(ytVal),
      lp_balance:        r2(parseFloat(pos.lp?.balance  ?? '0')),
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
    .map((m: any) => ({
      address:    (m.pt.address as string).toLowerCase(),
      symbol:     m.pt.symbol ?? '?',
      price_usd:  m.pt.price?.usd ?? null,
      expiry:     (m.expiry ?? '').slice(0, 10),
      days_left:  m.expiry
        ? Math.max(0, Math.floor((new Date(m.expiry).getTime() - Date.now()) / 86_400_000))
        : null,
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

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')?.toLowerCase()

  if (!address || !/^0x[a-f0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'invalid address' }, { status: 400 })
  }

  const [aaveR, pendleR, ptBalR] = await Promise.allSettled([
    fetchAave(address),
    fetchPendle(address),
    fetchPtBalances(address),
  ])

  // Deduplicate PT wallet balances against Pendle portfolio positions
  const pendlePos    = pendleR.status === 'fulfilled' ? (pendleR.value ?? []) : []
  const knownMarkets = new Set(pendlePos.map((p: any) => p.market_address))
  const ptBal        = (ptBalR.status === 'fulfilled' ? (ptBalR.value ?? []) : [])
    .filter((b: any) => b.value_usd > 0)

  return NextResponse.json({
    aave:        aaveR.status   === 'fulfilled' ? aaveR.value   : null,
    pendle:      pendlePos,
    pt_balances: ptBal,
    _known_pendle_markets: [...knownMarkets],
  })
}
