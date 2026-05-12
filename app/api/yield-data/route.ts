import { NextResponse } from 'next/server'

export const revalidate = 300   // 5-minute Vercel CDN cache

const PENDLE_CHAIN    = 1
const PENDLE_MIN_LIQ  = 500_000
const PENDLE_MIN_DAYS = 5
const MORPHO_GQL      = 'https://blue-api.morpho.org/graphql'
const MORPHO_MIN_LIQ  = 10_000
const MORPHO_LENDING_MIN_LIQ = 500_000
const CAPITAL         = 4100
const HF              = 2.0
const GAS_SIMPLE      = 35
const GAS_LOOP        = 150

// ── Helpers ───────────────────────────────────────────────────────────

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn() }
  catch (e) { console.warn(e); return fallback }
}

function r2(n: number) { return Math.round(n * 100) / 100 }
function r1(n: number) { return Math.round(n * 10) / 10 }

// ── Pendle ────────────────────────────────────────────────────────────

async function fetchPendle() {
  const resp = await fetch(
    `https://api-v2.pendle.finance/core/v1/${PENDLE_CHAIN}/markets?skip=0&limit=50`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  )
  const data = await resp.json()
  const now  = Date.now()
  const out: any[] = []

  for (const m of data.results ?? []) {
    if (m.isActive === false) continue
    const apy = m.impliedApy ?? 0
    if (apy <= 0) continue
    const exp = m.expiry ? new Date(m.expiry).getTime() : null
    const days = exp ? Math.max(0, Math.floor((exp - now) / 86_400_000)) : null
    if (days !== null && days < PENDLE_MIN_DAYS) continue
    const liq = m.liquidity?.usd ?? 0
    if (liq < PENDLE_MIN_LIQ) continue
    const pt = m.pt ?? {}
    out.push({
      name:           pt.symbol ?? m.symbol ?? '?',
      address:        m.address ?? '',
      pt_address:     pt.address ?? '',
      pt_apy:         r2(apy * 100),
      underlying_apy: r2((m.underlyingApy ?? 0) * 100),
      pt_price:       pt.price?.usd ? r2(pt.price.usd) : null,
      pt_discount:    r2((m.ptDiscount ?? 0) * 100),
      volume_24h:     Math.round(m.tradingVolume?.usd ?? 0),
      expiry:         (m.expiry ?? '').slice(0, 10),
      days_left:      days,
      liquidity_usd:  Math.round(liq),
    })
  }
  return out.sort((a, b) => b.pt_apy - a.pt_apy)
}

// ── Morpho ────────────────────────────────────────────────────────────

async function morphoQuery(skip: number) {
  const query = `{
    markets(where:{whitelisted:true},first:200,skip:${skip}) {
      items {
        marketId lltv
        state { borrowApy supplyApy utilization
                liquidityAssetsUsd supplyAssetsUsd borrowAssetsUsd }
        loanAsset { symbol }
        collateralAsset { symbol }
      }
    }
  }`
  const r = await fetch(MORPHO_GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  const d = await r.json()
  return (d?.data?.markets?.items ?? []) as any[]
}

async function fetchMorphoAll() {
  const all: any[] = []
  let skip = 0
  while (true) {
    const items = await morphoQuery(skip)
    all.push(...items)
    if (items.length < 200) break
    skip += 200
  }

  const ptList:      any[] = []
  const lendingList: any[] = []
  for (const m of all) {
    const col    = m.collateralAsset?.symbol ?? ''
    const state  = m.state ?? {}
    const liq    = state.liquidityAssetsUsd ?? 0
    const lltv   = Number(m.lltv ?? '860000000000000000') / 1e18
    const entry  = {
      market_id:        m.marketId ?? '',
      collateral:       col,
      loan:             m.loanAsset?.symbol ?? '?',
      lltv:             r1(lltv * 100),
      borrow_apy:       r2((state.borrowApy  ?? 0) * 100),
      supply_apy:       r2((state.supplyApy  ?? 0) * 100),
      utilization:      r1((state.utilization ?? 0) * 100),
      liquidity_usd:    Math.round(liq),
      supply_total_usd: Math.round(state.supplyAssetsUsd ?? 0),
      borrow_total_usd: Math.round(state.borrowAssetsUsd ?? 0),
    }
    if (col.toLowerCase().startsWith('pt-')) {
      if (liq >= MORPHO_MIN_LIQ) ptList.push(entry)
    } else if (col) {
      if (liq >= MORPHO_LENDING_MIN_LIQ) lendingList.push(entry)
    }
  }
  lendingList.sort((a, b) => b.liquidity_usd - a.liquidity_usd)
  return { ptList, lendingList }
}

// ── Aave ──────────────────────────────────────────────────────────────

async function fetchAaveRates() {
  const TARGET = new Set(['USDC','USDT','WETH','SUSDE','WEETH','WSTETH','DAI'])
  const [pResp, lbResp] = await Promise.all([
    fetch('https://yields.llama.fi/pools',      { headers: { 'User-Agent': 'Mozilla/5.0' } }),
    fetch('https://yields.llama.fi/lendBorrow', { headers: { 'User-Agent': 'Mozilla/5.0' } }),
  ])
  const poolsData = await pResp.json()
  const lbData    = await lbResp.json()

  const pools: Record<string, any> = {}
  for (const p of poolsData.data ?? []) pools[p.pool] = p

  const lb: Record<string, any> = {}
  for (const p of (Array.isArray(lbData) ? lbData : lbData.data ?? [])) lb[p.pool] = p

  const results: Record<string, any> = {}
  for (const [id, p] of Object.entries(pools) as [string, any][]) {
    if (p.project !== 'aave-v3' || p.chain !== 'Ethereum') continue
    const sym = (p.symbol ?? '').toUpperCase()
    if (!TARGET.has(sym)) continue
    const tvl = p.tvlUsd ?? 0
    if (!results[sym] || tvl > results[sym].total_supply_usd) {
      const l = lb[id] ?? {}
      results[sym] = {
        symbol:           sym,
        supply_apy:       r2(p.apyBase ?? 0),
        borrow_apy:       r2(l.apyBaseBorrow ?? 0),
        ltv:              r1((l.ltv ?? 0) * 100),
        total_supply_usd: Math.round(tvl),
        total_borrow_usd: Math.round(l.totalBorrowUsd ?? 0),
      }
    }
  }
  const ORDER = ['USDC','USDT','WETH','WSTETH','WEETH','SUSDE','DAI']
  return Object.values(results).sort((a,b) => {
    const ia = ORDER.indexOf(a.symbol), ib = ORDER.indexOf(b.symbol)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
}

// ── Ethena ────────────────────────────────────────────────────────────

async function fetchEthenaYield() {
  const resp = await fetch('https://app.ethena.fi/api/yields/protocol-and-staking-yield')
  const d    = await resp.json()
  return {
    staking_apy:  r2(d.stakingYield?.value    ?? 0),
    avg30d_apy:   r2(d.avg30dSusdeYield?.value ?? 0),
    protocol_apy: r2(d.protocolYield?.value    ?? 0),
  }
}

// ── Gas ───────────────────────────────────────────────────────────────

async function fetchGas() {
  const res: any = {}
  try {
    const r = await fetch('https://eth.llamarpc.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', method:'eth_gasPrice', params:[], id:1 }),
    })
    const d = await r.json()
    res.gwei = r2(parseInt(d.result, 16) / 1e9)
  } catch { res.gwei = null }
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { headers: { 'User-Agent': 'Mozilla/5.0' } })
    res.eth_usd = (await r.json()).ethereum?.usd ?? null
  } catch { res.eth_usd = null }
  if (res.gwei && res.eth_usd) {
    res.cost_simple = r2(200_000   * res.gwei * 1e-9 * res.eth_usd)
    res.cost_loop   = r2(1_350_000 * res.gwei * 1e-9 * res.eth_usd)
  }
  return res
}

// ── Peg ───────────────────────────────────────────────────────────────

async function fetchPeg() {
  const r = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=apxusd&vs_currencies=usd&include_24hr_change=true',
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  )
  const d    = await r.json()
  const info = d.apxusd ?? {}
  if (info.usd) return {
    price:      info.usd,
    change_24h: r2(info.usd_24h_change ?? 0),
    status:     info.usd >= 0.995 ? 'ok' : 'depeg',
  }
  return { price: null, change_24h: null, status: 'unknown' }
}

// ── Strategy math ─────────────────────────────────────────────────────

function loopAtHf(ptApy: number, borrowApy: number, lltvPct: number, days: number, capital: number, gasLoop: number, hf: number) {
  const ltv      = (lltvPct / 100) / hf
  const leverage = 1 / (1 - ltv)
  const netApy   = (ptApy / 100) * leverage - (borrowApy / 100) * (leverage - 1)
  const gross    = capital * netApy * days / 365
  return {
    hf,
    ltv:        r1(ltv * 100),
    leverage:   r2(leverage),
    net_apy:    r2(netApy * 100),
    gross:      r2(gross),
    net_profit: r2(gross - gasLoop),
  }
}

function buildLoops(pendle: any[], morphoPt: any[], gas: any) {
  const gasLoop   = gas.cost_loop   ?? GAS_LOOP
  const gasSimple = gas.cost_simple ?? GAS_SIMPLE
  const bySymbol: Record<string, any> = {}
  for (const pm of pendle) bySymbol[pm.name.toLowerCase()] = pm

  const loops = morphoPt.map((mm: any) => {
    const pm   = bySymbol[mm.collateral.toLowerCase()]
    let loop: any = null, hfTable: any[] = [], liqPrice = null
    let bevenBorrow = null, bevenCapital = null

    if (pm?.days_left) {
      loop    = loopAtHf(pm.pt_apy, mm.borrow_apy, mm.lltv, pm.days_left, CAPITAL, gasLoop, HF)
      hfTable = [1.5,1.75,2.0,2.5,3.0].map(h =>
        loopAtHf(pm.pt_apy, mm.borrow_apy, mm.lltv, pm.days_left, CAPITAL, gasLoop, h))
      const totalPt = CAPITAL * loop.leverage
      const debt    = totalPt - CAPITAL
      liqPrice      = r2(debt / (totalPt * (mm.lltv / 100)))
      if (loop.leverage > 1)
        bevenBorrow = r2(pm.pt_apy * loop.leverage / (loop.leverage - 1))
      const extraFrac = Math.max(0, (loop.net_apy - pm.pt_apy) / 100)
      if (extraFrac > 0)
        bevenCapital = Math.round((gasLoop - gasSimple) / (extraFrac * pm.days_left / 365))
    }

    return {
      ...mm,
      pendle_pt_apy:     pm?.pt_apy   ?? null,
      days_left:         pm?.days_left ?? null,
      pendle_liq:        pm?.liquidity_usd ?? null,
      loop,
      hf_table:          hfTable,
      liquidation_price: liqPrice,
      breakeven_borrow:  bevenBorrow,
      breakeven_capital: bevenCapital,
      trend: { borrow: 'flat', util: 'flat' },
    }
  })

  return loops.sort((a: any, b: any) => {
    const an = a.loop?.net_profit ?? null
    const bn = b.loop?.net_profit ?? null
    if (an !== null && bn !== null) return bn > 0 === an > 0 ? b.loop.net_apy - a.loop.net_apy : (bn > 0 ? 1 : -1)
    if (an !== null) return -1
    if (bn !== null) return 1
    return b.liquidity_usd - a.liquidity_usd
  })
}

// ── Handler ───────────────────────────────────────────────────────────

export async function GET() {
  try {
    const [pendleR, morphoR, aaveR, ethenaR, gasR, pegR] = await Promise.allSettled([
      fetchPendle(),
      fetchMorphoAll(),
      safe(fetchAaveRates,   []),
      safe(fetchEthenaYield, { staking_apy: 0, avg30d_apy: 0, protocol_apy: 0 }),
      safe(fetchGas,         {}),
      safe(fetchPeg,         { price: null, change_24h: null, status: 'unknown' }),
    ])

    const pendle  = pendleR.status  === 'fulfilled' ? pendleR.value  : []
    const morpho  = morphoR.status  === 'fulfilled' ? morphoR.value  : { ptList: [], lendingList: [] }
    const aave    = aaveR.status    === 'fulfilled' ? aaveR.value    : []
    const ethena  = ethenaR.status  === 'fulfilled' ? ethenaR.value  : {}
    const gas     = gasR.status     === 'fulfilled' ? gasR.value     : {}
    const peg     = pegR.status     === 'fulfilled' ? pegR.value     : { price: null, status: 'unknown' }

    const loops = buildLoops(pendle, (morpho as any).ptList, gas)

    const data = {
      pendle,
      loops,
      morpho_lending:  (morpho as any).lendingList,
      aave,
      ethena,
      gas,
      peg,
      capital:    CAPITAL,
      hf:         HF,
      gas_simple: (gas as any).cost_simple ?? GAS_SIMPLE,
      gas_loop:   (gas as any).cost_loop   ?? GAS_LOOP,
      updated_at: new Date().toISOString(),
    }
    return NextResponse.json({ data, updated_at: data.updated_at, error: null }, {
      headers: { 'Cache-Control': 's-maxage=300, stale-while-revalidate=3600' },
    })
  } catch (e: any) {
    return NextResponse.json({ data: null, error: e.message }, { status: 500 })
  }
}
