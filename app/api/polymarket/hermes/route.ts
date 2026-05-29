import { NextResponse } from 'next/server'
import {
  fetchCandles, logReturns, labelRegimes, fitMarkov, monteCarlo,
  scanPatterns, kellyStake, fetchLivePulse, type Candle,
} from '@/lib/hermes'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const BANKROLL = Number(process.env.HERMES_BANKROLL ?? 200)
const KELLY_FRACTION = Number(process.env.HERMES_KELLY_FRACTION ?? 0.25)
const MIN_EDGE = Number(process.env.HERMES_MIN_EDGE ?? 0.05)

/** Open price of the 5-min window that started at `windowStartSec`. */
function priceToBeatFor(candles: Candle[], windowStartSec: number, spot: number): number {
  if (!windowStartSec) return spot
  const startMs = windowStartSec * 1000
  // exact 1-min candle at the window open, else the last candle at/before it
  let best: Candle | null = null
  for (const c of candles) {
    if (c.t === startMs) return c.o
    if (c.t <= startMs && (!best || c.t > best.t)) best = c
  }
  return best ? best.c : spot
}

/**
 * Honest walk-forward backtest over the recent 1-min candles. For each 5-min
 * window we fit the model on data available *before* the window opened, take the
 * model's side, and check whether it resolved correctly. Per-trade P&L assumes a
 * neutral 0.50 entry (we don't have historical CLOB prices), so this measures
 * model skill, not realized profit.
 */
function backtest(candles: Candle[]) {
  const trades: number[] = []   // +1 win / 0 loss per resolved window
  const pnl: number[] = []      // payout − cost at 0.50 entry
  for (let i = 60; i + 5 < candles.length; i += 5) {
    const hist = candles.slice(0, i)
    const rets = logReturns(hist)
    if (rets.length < 30) continue
    const labels = labelRegimes(rets)
    const m = fitMarkov(rets, labels)
    // model side from regime drift over the horizon
    const drift = m.regimeStats[m.current].mu
    const side: 'up' | 'down' = drift >= 0 ? 'up' : 'down'
    const open = candles[i].o
    const close = candles[i + 5].c
    const wentUp = close > open
    const win = (side === 'up' && wentUp) || (side === 'down' && !wentUp)
    trades.push(win ? 1 : 0)
    pnl.push(win ? 0.5 : -0.5)
  }
  const n = trades.length || 1
  const winRate = trades.reduce((a, b) => a + b, 0) / n
  const mu = pnl.reduce((a, b) => a + b, 0) / n
  const sd = Math.sqrt(pnl.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, n - 1)) || 1e-9
  // annualize per-trade Sharpe: ~ (60/5)*24*365 windows/yr ≈ 1.05M; cap display
  const sharpe = (mu / sd) * Math.sqrt(288 * 365 / 5)
  return {
    windows: trades.length,
    winRate: Math.round(winRate * 1000) / 10,
    sharpe: Math.round(Math.min(sharpe, 12) * 100) / 100,
  }
}

async function readRealized() {
  try {
    const { redis } = await import('@/lib/redis')
    const s = await redis.get<any>('hermes:state')
    if (!s) return null
    return {
      pnl: Number(s.realizedPnl ?? 0),
      trades: Number(s.trades ?? 0),
      winRate: Number(s.winRate ?? 0),
      biggestWin: Number(s.biggestWin ?? 0),
      dayPnl: Number(s.dayPnl ?? 0),
      wallet: s.wallet ?? null,
      mode: s.mode ?? null,
      updatedAt: s.updatedAt ?? null,
    }
  } catch { return null }
}

export async function GET(req: Request) {
  const asset = new URL(req.url).searchParams.get('asset')?.toLowerCase() || 'btc'

  try {
    const { candles, source } = await fetchCandles(asset, 300)
    const spot = candles[candles.length - 1].c
    const prevClose = candles[candles.length - 2]?.c ?? spot

    const returns = logReturns(candles)
    const labels = labelRegimes(returns)
    const markov = fitMarkov(returns, labels)
    const patterns = scanPatterns(candles)

    const pulse = await fetchLivePulse(asset)

    const now = Date.now()
    // 5-min rounds are timed by their window [windowStart, windowStart+300s].
    // Edge only exists once the round is LIVE (the open price is known); before
    // that the open is unknown, so it's a ~50/50 coin flip with no edge.
    const windowStart = pulse ? pulse.windowStartSec * 1000 : 0
    const windowEnd = windowStart + 300_000
    const isLive = pulse ? now >= windowStart && now < windowEnd : false
    const phase = !pulse ? 'none' : isLive ? 'live' : now < windowStart ? 'upcoming' : 'settling'

    // countdown: time to window-end when live, else time to window-start
    const secondsLeft = pulse
      ? Math.max(0, Math.round(((isLive ? windowEnd : windowStart) - now) / 1000))
      : 0
    // simulate only the window (≤5 min), never the wall-clock until it starts
    const secsToEnd = pulse ? Math.max(0, (windowEnd - now) / 1000) : 300
    const horizon = isLive ? Math.max(1, Math.ceil(secsToEnd / 60)) : 5
    const priceToBeat = isLive ? priceToBeatFor(candles, pulse!.windowStartSec, spot) : spot

    const mc = monteCarlo(markov, spot, priceToBeat, horizon, 500)

    // Signal: pick the side with the larger positive edge vs the live CLOB price
    const upPrice = pulse?.upPrice ?? 0.5
    const downPrice = pulse?.downPrice ?? 0.5
    const upEdge = mc.pUp - upPrice
    const downEdge = mc.pDown - downPrice

    let side: 'UP' | 'DOWN' | 'NONE' = 'NONE'
    let edge = 0, modelProb = 0, marketPrice = 0
    if (upEdge >= downEdge && upEdge > 0) { side = 'UP'; edge = upEdge; modelProb = mc.pUp; marketPrice = upPrice }
    else if (downEdge > 0) { side = 'DOWN'; edge = downEdge; modelProb = mc.pDown; marketPrice = downPrice }

    const kellyFull = marketPrice > 0 ? kellyStake(modelProb, marketPrice, BANKROLL, 1) : 0
    const stake = marketPrice > 0 ? kellyStake(modelProb, marketPrice, BANKROLL, KELLY_FRACTION) : 0

    // conviction: edge size + agreement of patterns with the chosen side
    const patAgree = patterns.filter(p => p.detected &&
      ((side === 'UP' && p.direction === 'up') || (side === 'DOWN' && p.direction === 'down'))).length
    const tradable = isLive && side !== 'NONE' && edge >= MIN_EDGE && stake >= 1
    const conviction = !tradable ? 'flat'
      : edge >= 0.12 || patAgree >= 2 ? 'high'
      : edge >= 0.08 ? 'medium' : 'low'

    const bt = backtest(candles)
    const realized = await readRealized()

    const priceSeries = candles.slice(-90).map(c => ({ t: c.t, c: c.c }))

    return NextResponse.json({
      engine: {
        name: 'HermesTradingEngine',
        wallet: realized?.wallet ?? null,
        mode: realized?.mode ?? (process.env.HERMES_DRY_RUN === 'false' ? 'live' : 'dry'),
        updatedAt: new Date(now).toISOString(),
        priceSource: source,
      },
      market: pulse ? {
        slug: pulse.slug,
        question: pulse.question,
        asset: asset.toUpperCase(),
        phase,
        live: isLive,
        priceToBeat: Math.round(priceToBeat * 100) / 100,
        spot: Math.round(spot * 100) / 100,
        spotDelta: Math.round((spot - priceToBeat) * 100) / 100,
        prevDelta: Math.round((spot - prevClose) * 100) / 100,
        upPrice: Math.round(upPrice * 100),
        downPrice: Math.round(downPrice * 100),
        secondsLeft,
        windowEndMs: windowEnd,
        endDateMs: pulse.endDateMs,
      } : null,
      model: {
        regime: {
          current: markov.current,
          P: markov.P.map(row => row.map(x => Math.round(x * 1000) / 1000)),
          stationary: {
            bull: Math.round(markov.stationary.bull * 100) / 100,
            bear: Math.round(markov.stationary.bear * 100) / 100,
            side: Math.round(markov.stationary.side * 100) / 100,
          },
          stats: markov.regimeStats,
        },
        montecarlo: {
          paths: mc.paths,
          horizon: mc.horizon,
          pUp: Math.round(mc.pUp * 100) / 100,
          pDown: Math.round(mc.pDown * 100) / 100,
          meanDelta: Math.round(mc.meanDelta * 100) / 100,
          meanFinal: Math.round(mc.meanFinal * 100) / 100,
          converged: mc.converged,
          fan: mc.fan.map(r => r.map(x => Math.round(x * 100) / 100)),
          deltaHist: mc.deltaHist,
        },
        patterns,
      },
      signal: {
        side, edge: Math.round(edge * 1000) / 10, modelProb: Math.round(modelProb * 1000) / 10,
        marketPrice: Math.round(marketPrice * 100), stake: Math.round(stake * 100) / 100,
        kellyFull: Math.round(kellyFull * 100) / 100, tradable, conviction,
        patternsAgree: patAgree,
      },
      performance: { backtest: bt, realized },
      priceSeries,
      configured: !!(process.env.POLYMARKET_PRIVATE_KEY && process.env.POLYMARKET_API_KEY),
      fetchedAt: new Date(now).toISOString(),
    })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'engine error' }, { status: 500 })
  }
}
