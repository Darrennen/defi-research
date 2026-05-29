// ────────────────────────────────────────────────────────────────────────────
// Hermes Trading Engine — quant core for Polymarket BTC "Up or Down" markets
//
// Strategy: on each recurring `btc-updown-5m` market (resolves UP if BTC closes
// above the window-open price), estimate the true probability of UP using:
//   1. A 3-state Markov regime model (Bull / Bear / Side) fit on recent returns
//   2. A 500-path Monte Carlo simulation to the market's resolution horizon
//   3. A short-term pattern scanner (liquidity sweep / order block / FVG)
// Then compare the model probability to the live CLOB price to find edge and
// size the bet with fractional Kelly.
//
// This module is pure + isomorphic: the dashboard route and the Python trader
// both mirror the same math.
// ────────────────────────────────────────────────────────────────────────────

export type Regime = 'bull' | 'bear' | 'side'
export const REGIMES: Regime[] = ['bull', 'bear', 'side']

export interface Candle {
  t: number      // open time, ms
  o: number
  h: number
  l: number
  c: number
  v: number
}

// ── Price data (Binance global → Binance.US → Coinbase fallback) ──────────────

const SYMBOL_MAP: Record<string, { binance: string; coinbase: string }> = {
  btc:  { binance: 'BTCUSDT', coinbase: 'BTC-USD' },
  eth:  { binance: 'ETHUSDT', coinbase: 'ETH-USD' },
  sol:  { binance: 'SOLUSDT', coinbase: 'SOL-USD' },
  xrp:  { binance: 'XRPUSDT', coinbase: 'XRP-USD' },
  doge: { binance: 'DOGEUSDT', coinbase: 'DOGE-USD' },
}

async function fetchBinance(host: string, sym: string, interval: string, limit: number): Promise<Candle[]> {
  const res = await fetch(`${host}/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`,
    { next: { revalidate: 15 } })
  if (!res.ok) throw new Error(`binance ${res.status}`)
  const rows = await res.json()
  return rows.map((r: any[]) => ({
    t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5],
  }))
}

async function fetchCoinbase(sym: string, granularitySec: number, limit: number): Promise<Candle[]> {
  // Coinbase returns [time, low, high, open, close, volume] newest-first
  const res = await fetch(`https://api.exchange.coinbase.com/products/${sym}/candles?granularity=${granularitySec}`,
    { next: { revalidate: 15 }, headers: { 'User-Agent': 'hermes/1.0' } })
  if (!res.ok) throw new Error(`coinbase ${res.status}`)
  const rows = await res.json()
  const candles: Candle[] = rows.map((r: any[]) => ({
    t: r[0] * 1000, l: +r[1], h: +r[2], o: +r[3], c: +r[4], v: +r[5],
  }))
  candles.sort((a, b) => a.t - b.t)
  return candles.slice(-limit)
}

/** Fetch recent 1-minute candles for an asset, with multi-source fallback. */
export async function fetchCandles(asset: string, limit = 300): Promise<{ candles: Candle[]; source: string }> {
  const map = SYMBOL_MAP[asset] ?? SYMBOL_MAP.btc
  const attempts: Array<[string, () => Promise<Candle[]>]> = [
    ['binance',    () => fetchBinance('https://api.binance.com', map.binance, '1m', limit)],
    ['binance.us', () => fetchBinance('https://api.binance.us', map.binance, '1m', limit)],
    ['coinbase',   () => fetchCoinbase(map.coinbase, 60, limit)],
  ]
  let lastErr: unknown
  for (const [source, fn] of attempts) {
    try {
      const candles = await fn()
      if (candles.length > 30) return { candles, source }
    } catch (e) { lastErr = e }
  }
  throw new Error(`all price sources failed: ${lastErr}`)
}

// ── Returns & regime labelling ────────────────────────────────────────────────

export function logReturns(candles: Candle[]): number[] {
  const r: number[] = []
  for (let i = 1; i < candles.length; i++) r.push(Math.log(candles[i].c / candles[i - 1].c))
  return r
}

function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / (xs.length || 1) }
function std(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}

/**
 * Label each bar's regime from the rolling trend of returns. We use the mean of
 * the trailing `win` returns relative to the overall return volatility — this
 * makes regimes *sticky* (a trend persists across bars) rather than flipping on
 * every tick, which is what produces a high-persistence transition matrix.
 */
export function labelRegimes(returns: number[], win = 10, theta = 0.35): Regime[] {
  const sigma = std(returns) || 1e-9
  const labels: Regime[] = []
  for (let i = 0; i < returns.length; i++) {
    const lo = Math.max(0, i - win + 1)
    const m = mean(returns.slice(lo, i + 1))
    if (m > theta * sigma) labels.push('bull')
    else if (m < -theta * sigma) labels.push('bear')
    else labels.push('side')
  }
  return labels
}

// ── Markov transition matrix + stationary distribution ────────────────────────

export interface MarkovModel {
  /** P[from][to] row-stochastic transition matrix, order = REGIMES */
  P: number[][]
  /** stationary distribution π, order = REGIMES */
  stationary: Record<Regime, number>
  current: Regime
  /** per-regime 1-bar return stats used by the Monte Carlo step */
  regimeStats: Record<Regime, { mu: number; sigma: number; n: number }>
}

export function fitMarkov(returns: number[], labels: Regime[]): MarkovModel {
  const idx: Record<Regime, number> = { bull: 0, bear: 1, side: 2 }

  // Transition counts with Laplace smoothing (avoids zero-probability rows)
  const counts = [[1, 1, 1], [1, 1, 1], [1, 1, 1]]
  for (let i = 1; i < labels.length; i++) counts[idx[labels[i - 1]]][idx[labels[i]]] += 1
  const P = counts.map(row => {
    const s = row.reduce((a, b) => a + b, 0)
    return row.map(x => x / s)
  })

  // Stationary distribution via power iteration on Pᵀ
  let pi = [1 / 3, 1 / 3, 1 / 3]
  for (let it = 0; it < 500; it++) {
    const next = [0, 0, 0]
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) next[j] += pi[i] * P[i][j]
    const s = next.reduce((a, b) => a + b, 0) || 1
    pi = next.map(x => x / s)
  }

  // Per-regime return distribution
  const regimeStats = {} as Record<Regime, { mu: number; sigma: number; n: number }>
  for (const reg of REGIMES) {
    const rs = returns.filter((_, i) => labels[i] === reg)
    regimeStats[reg] = { mu: mean(rs), sigma: std(rs) || std(returns) || 1e-6, n: rs.length }
  }

  return {
    P,
    stationary: { bull: pi[0], bear: pi[1], side: pi[2] },
    current: labels[labels.length - 1] ?? 'side',
    regimeStats,
  }
}

// ── Monte Carlo simulation to horizon ─────────────────────────────────────────

export interface MonteCarlo {
  paths: number             // number of simulated paths
  horizon: number           // steps (minutes) simulated
  pUp: number               // P(final > priceToBeat)
  pDown: number
  meanDelta: number         // mean (final - priceToBeat) in price units
  meanFinal: number
  converged: boolean
  /** quantile fan over the horizon: [step][p05,p25,p50,p75,p95] */
  fan: number[][]
  /** histogram of final Δ for the distribution bar chart */
  deltaHist: { bin: number; count: number }[]
}

// Box-Muller standard normal
function gauss(): number {
  let u = 0, v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const REG_IDX: Record<Regime, number> = { bull: 0, bear: 1, side: 2 }

export function monteCarlo(
  model: MarkovModel,
  spot: number,
  priceToBeat: number,
  horizon: number,
  paths = 500,
): MonteCarlo {
  const H = Math.max(1, Math.min(horizon, 240))
  const finals: number[] = []
  // fan[step] collects all path prices at that step
  const stepPrices: number[][] = Array.from({ length: H }, () => [])

  for (let p = 0; p < paths; p++) {
    let price = spot
    let reg = model.current
    for (let s = 0; s < H; s++) {
      // advance regime via the Markov chain
      const row = model.P[REG_IDX[reg]]
      const u = Math.random()
      let acc = 0, next = 2
      for (let j = 0; j < 3; j++) { acc += row[j]; if (u <= acc) { next = j; break } }
      reg = REGIMES[next]
      // draw a return from the regime's distribution and apply it
      const { mu, sigma } = model.regimeStats[reg]
      price = price * Math.exp(mu + sigma * gauss())
      stepPrices[s].push(price)
    }
    finals.push(price)
  }

  const up = finals.filter(f => f > priceToBeat).length
  const pUp = up / paths
  const meanFinal = mean(finals)

  // quantile fan
  const q = (arr: number[], p: number) => {
    const a = [...arr].sort((x, y) => x - y)
    return a[Math.min(a.length - 1, Math.floor(p * a.length))]
  }
  const fan = stepPrices.map(ps => [q(ps, 0.05), q(ps, 0.25), q(ps, 0.5), q(ps, 0.75), q(ps, 0.95)])

  // delta histogram (15 bins centered on 0, scaled to final spread)
  const deltas = finals.map(f => f - priceToBeat)
  const maxAbs = Math.max(...deltas.map(Math.abs)) || 1
  const BINS = 15
  const hist = Array.from({ length: BINS }, (_, i) => ({
    bin: -maxAbs + (2 * maxAbs * (i + 0.5)) / BINS,
    count: 0,
  }))
  for (const d of deltas) {
    let bi = Math.floor(((d + maxAbs) / (2 * maxAbs)) * BINS)
    bi = Math.max(0, Math.min(BINS - 1, bi))
    hist[bi].count++
  }

  // crude convergence check: split-half stability of pUp
  const half = Math.floor(paths / 2)
  const pUpA = finals.slice(0, half).filter(f => f > priceToBeat).length / half
  const pUpB = finals.slice(half).filter(f => f > priceToBeat).length / (paths - half)
  const converged = Math.abs(pUpA - pUpB) < 0.05

  return {
    paths, horizon: H, pUp, pDown: 1 - pUp,
    meanDelta: meanFinal - priceToBeat, meanFinal, converged,
    fan, deltaHist: hist,
  }
}

// ── Pattern scanner ───────────────────────────────────────────────────────────

export interface Pattern {
  name: string
  detected: boolean
  direction: 'up' | 'down' | 'none'
  confidence: number   // 0..1
  note: string
}

/** Liquidity sweep: price takes out a recent swing high/low then closes back inside. */
function liquiditySweep(c: Candle[]): Pattern {
  const n = c.length
  if (n < 12) return { name: 'Liquidity Sweep', detected: false, direction: 'none', confidence: 0, note: 'insufficient data' }
  const win = c.slice(n - 11, n - 1)
  const last = c[n - 1]
  const priorHigh = Math.max(...win.map(x => x.h))
  const priorLow = Math.min(...win.map(x => x.l))
  if (last.h > priorHigh && last.c < priorHigh) {
    const conf = Math.min(1, (last.h - priorHigh) / (priorHigh * 0.001))
    return { name: 'Liquidity Sweep', detected: true, direction: 'down', confidence: 0.4 + 0.4 * conf, note: 'swept highs, reversed' }
  }
  if (last.l < priorLow && last.c > priorLow) {
    const conf = Math.min(1, (priorLow - last.l) / (priorLow * 0.001))
    return { name: 'Liquidity Sweep', detected: true, direction: 'up', confidence: 0.4 + 0.4 * conf, note: 'swept lows, reversed' }
  }
  return { name: 'Liquidity Sweep', detected: false, direction: 'none', confidence: 0.2, note: 'no sweep' }
}

/** Order block: last opposing candle before an impulsive move (institutional zone). */
function orderBlock(c: Candle[]): Pattern {
  const n = c.length
  if (n < 6) return { name: 'Order Block', detected: false, direction: 'none', confidence: 0, note: 'insufficient data' }
  const sigma = std(logReturns(c.slice(-30))) || 1e-9
  // impulsive last candle?
  const impulse = Math.log(c[n - 1].c / c[n - 1].o)
  if (Math.abs(impulse) > 1.6 * sigma) {
    const bullish = impulse > 0
    // the opposing candle just before the impulse is the order block
    const ob = c[n - 2]
    const obBull = ob.c > ob.o
    if (bullish && !obBull) return { name: 'Order Block', detected: true, direction: 'up', confidence: 0.55 + Math.min(0.35, Math.abs(impulse) / (3 * sigma)), note: 'bullish OB · institutional zone' }
    if (!bullish && obBull) return { name: 'Order Block', detected: true, direction: 'down', confidence: 0.55 + Math.min(0.35, Math.abs(impulse) / (3 * sigma)), note: 'bearish OB · institutional zone' }
  }
  return { name: 'Order Block', detected: false, direction: 'none', confidence: 0.25, note: 'no fresh OB' }
}

/** Fair value gap: 3-candle imbalance where candle1 and candle3 do not overlap. */
function fairValueGap(c: Candle[]): Pattern {
  const n = c.length
  if (n < 3) return { name: 'FVG · Imbalance', detected: false, direction: 'none', confidence: 0, note: 'insufficient data' }
  const a = c[n - 3], _b = c[n - 2], d = c[n - 1]
  // bullish FVG: gap between a.high and d.low
  if (d.l > a.h) {
    const gap = (d.l - a.h) / a.h
    return { name: 'FVG · Imbalance', detected: true, direction: 'up', confidence: Math.min(0.9, 0.4 + gap / 0.001), note: 'bullish gap · price magnet' }
  }
  if (a.l > d.h) {
    const gap = (a.l - d.h) / d.h
    return { name: 'FVG · Imbalance', detected: true, direction: 'down', confidence: Math.min(0.9, 0.4 + gap / 0.001), note: 'bearish gap · price magnet' }
  }
  return { name: 'FVG · Imbalance', detected: false, direction: 'none', confidence: 0.2, note: 'no imbalance' }
}

export function scanPatterns(candles: Candle[]): Pattern[] {
  return [liquiditySweep(candles), orderBlock(candles), fairValueGap(candles)]
}

// ── Kelly sizing ──────────────────────────────────────────────────────────────

/** Fractional-Kelly stake (USD) for a binary contract priced at `priceProb` (0..1). */
export function kellyStake(pModel: number, priceProb: number, bankroll: number, fraction = 0.25, cap = 50): number {
  if (priceProb <= 0 || priceProb >= 1) return 0
  const b = (1 - priceProb) / priceProb       // net odds per $1 risked
  const f = (pModel * b - (1 - pModel)) / b    // full Kelly fraction
  return Math.min(Math.max(0, f * fraction * bankroll), cap)
}

// ── Live Polymarket market discovery ──────────────────────────────────────────

const GAMMA = 'https://gamma-api.polymarket.com'
const CLOB = 'https://clob.polymarket.com'

export interface PulseMarket {
  slug: string
  question: string
  asset: string
  windowStartSec: number   // unix seconds of window open (from slug)
  endDateMs: number
  upTokenId: string
  downTokenId: string
  upPrice: number          // 0..1 from CLOB midpoint
  downPrice: number
}

/** Find the live `<asset>-updown-5m` market — the round nearest to resolving. */
export async function fetchLivePulse(asset = 'btc'): Promise<PulseMarket | null> {
  const res = await fetch(`${GAMMA}/markets?closed=false&limit=400&order=startDate&ascending=false`,
    { next: { revalidate: 20 } })
  if (!res.ok) return null
  const json = await res.json()
  const markets: any[] = Array.isArray(json) ? json : json.data ?? []
  const prefix = `${asset}-updown-5m`
  const now = Date.now()

  const candidates = markets
    .filter(m => (m.slug ?? '').startsWith(prefix))
    .map(m => ({ m, end: Date.parse(m.endDate ?? '') }))
    .filter(x => Number.isFinite(x.end) && x.end > now)
    .sort((a, b) => a.end - b.end)

  if (!candidates.length) return null
  const { m } = candidates[0]

  let tokenIds: string[] = []
  try { tokenIds = JSON.parse(m.clobTokenIds ?? '[]') } catch { /* noop */ }
  if (tokenIds.length < 2) return null

  const slugTs = parseInt((m.slug ?? '').split('-').pop() ?? '0', 10)

  const [upPrice, downPrice] = await Promise.all([
    clobMidpoint(tokenIds[0]),
    clobMidpoint(tokenIds[1]),
  ])

  return {
    slug: m.slug,
    question: m.question ?? '',
    asset,
    windowStartSec: slugTs,
    endDateMs: Date.parse(m.endDate),
    upTokenId: tokenIds[0],
    downTokenId: tokenIds[1],
    upPrice: upPrice ?? (downPrice != null ? 1 - downPrice : 0.5),
    downPrice: downPrice ?? (upPrice != null ? 1 - upPrice : 0.5),
  }
}

async function clobMidpoint(tokenId: string): Promise<number | null> {
  try {
    const res = await fetch(`${CLOB}/midpoint?token_id=${tokenId}`, { next: { revalidate: 10 } })
    if (!res.ok) return null
    const j = await res.json()
    const mid = j.mid ?? j.price
    return mid != null ? parseFloat(mid) : null
  } catch { return null }
}
