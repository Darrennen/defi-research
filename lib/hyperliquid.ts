const HL_API = '/api/hl'

async function post<T>(body: object): Promise<T> {
  const r = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type HLRole = 'user' | 'agent' | 'subAccount' | 'vault' | 'missing'

export interface HLUserRole {
  role: HLRole
  user?: string   // master address when role is agent or subAccount
}

export interface HLSubAccount {
  subAccountUser: string
  name: string
  master: string
  clearinghouseState?: HLClearinghouseState
  spotState?: HLSpotState
}

export interface HLMarginSummary {
  accountValue: string
  totalNtlPos: string
  totalRawUsd: string
  totalMarginUsed: string
}

export interface HLPosition {
  coin: string
  szi: string
  leverage: { type: 'cross' | 'isolated'; value: number }
  entryPx: string
  positionValue: string
  unrealizedPnl: string
  returnOnEquity: string
  liquidationPx: string | null
  marginUsed: string
  cumFunding: { allTime: string; sinceOpen: string; sinceChange: string }
}

export interface HLClearinghouseState {
  marginSummary: HLMarginSummary
  crossMarginSummary: HLMarginSummary
  crossMaintenanceMarginUsed: string
  withdrawable: string
  assetPositions: Array<{ position: HLPosition; type: string }>
  time: number
}

export interface HLSpotBalance {
  coin: string
  token: number
  hold: string
  total: string
  entryNtl: string
}

export interface HLSpotState {
  balances: HLSpotBalance[]
}

export interface HLOpenOrder {
  coin: string
  side: 'B' | 'A'
  limitPx: string
  sz: string
  oid: number
  timestamp: number
  origSz: string
  cloid: string | null
  orderType?: string
  reduceOnly?: boolean
}

export interface HLFill {
  coin: string
  px: string
  sz: string
  side: 'B' | 'A'
  time: number
  startPosition: string
  dir: string
  closedPnl: string
  hash: string
  oid: number
  crossed: boolean
  fee: string
  tid: number
  feeToken: string
}

export type HLPortfolioPeriod = 'day' | 'week' | 'month' | 'allTime' | 'perpDay' | 'perpWeek' | 'perpMonth' | 'perpAllTime'

export interface HLPortfolioSeries {
  accountValueHistory: [number, string][]
  pnlHistory: [number, string][]
  vlm: string
}

export type HLPortfolio = Record<HLPortfolioPeriod, HLPortfolioSeries>

export interface HLSpotToken {
  name: string
  szDecimals: number
  weiDecimals: number
  index: number
  tokenId: string
  isCanonical: boolean
}

export interface HLSpotMeta {
  tokens: HLSpotToken[]
  universe: Array<{ name: string; tokens: number[]; index: number }>
}

export interface HLLedgerUpdate {
  time: number
  hash: string
  delta: {
    type: string
    usdc?: string
    coin?: string
    amount?: string
    user?: string
    fee?: string
  }
}

export interface HLAssetCtx {
  funding: string
  openInterest: string
  prevDayPx: string
  dayNtlVlm: string
  premium: string
  oraclePx: string
  markPx: string
  midPx: string | null
  impactPxs: [string, string] | null
}

export interface HLPerpMeta {
  name: string
  szDecimals: number
  maxLeverage: number
  onlyIsolated?: boolean
}

export interface HLSpotAssetCtx {
  dayNtlVlm: string
  markPx: string
  midPx: string | null
  prevDayPx: string
}

export interface HLPredictedFundingEntry {
  fundingRate: string
  nextFundingTime: number
}

export type HLPredictedFundings = [string, [string, HLPredictedFundingEntry][]][]

export interface HLUserFunding {
  delta: {
    coin: string
    fundingRate: string
    szi: string
    type: 'funding'
    usdc: string
    nSamples: number | null
  }
  hash: string
  time: number
}

export interface HLHistoricalOrder {
  coin: string
  side: 'B' | 'A'
  limitPx: string
  sz: string
  oid: number
  timestamp: number
  origSz: string
  cloid: string | null
  orderType?: string
  reduceOnly?: boolean
  status: string
  statusTimestamp?: number
}

export interface HLTwapOrder {
  coin: string
  side: 'B' | 'A'
  sz: string
  executedSz: string
  executedNtl: string
  minutes: number
  randomize: boolean
  timestamp: number
  id: number
}

export interface HLTwapHistoryEntry {
  state: HLTwapOrder
  status: { status: string }
  time: number
}

export interface HLUserFees {
  dailyUserVlm: [string, string, string][]
  feeSchedule: {
    taker: string
    maker: string
    referralDiscount: string
    userCrossRate: string
    userAddRate: string
  }
  userCrossRate: string
  userAddRate: string
  activeReferralDiscount: string
}

export interface HLDelegatorSummary {
  delegated: string
  undelegating: string
  totalPendingRewards: string
  nValidators: number
}

// ── Fetchers ──────────────────────────────────────────────────────────────────

export const getUserRole = (address: string) =>
  post<HLUserRole>({ type: 'userRole', user: address })

export const getSubAccounts = (address: string) =>
  post<HLSubAccount[]>({ type: 'subAccounts', user: address })

export const getClearinghouseState = (address: string) =>
  post<HLClearinghouseState>({ type: 'clearinghouseState', user: address })

export const getSpotState = (address: string) =>
  post<HLSpotState>({ type: 'spotClearinghouseState', user: address })

export const getOpenOrders = (address: string) =>
  post<HLOpenOrder[]>({ type: 'openOrders', user: address })

export const getUserFills = (address: string) =>
  post<HLFill[]>({ type: 'userFills', user: address })

export const getSpotMeta = () =>
  post<HLSpotMeta>({ type: 'spotMeta' })

export const getPortfolio = (address: string) =>
  post<[HLPortfolioPeriod, HLPortfolioSeries][]>({ type: 'portfolio', user: address })
    .then(arr => Object.fromEntries(arr) as HLPortfolio)

export const getLedgerUpdates = (address: string) =>
  post<HLLedgerUpdate[]>({
    type: 'userNonFundingLedgerUpdates',
    user: address,
    startTime: Date.now() - 90 * 24 * 60 * 60 * 1000,
  })

function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  return p.catch(() => fallback)
}

export const getMetaAndAssetCtxs = () =>
  post<[{ universe: HLPerpMeta[]; marginTables: unknown[] }, HLAssetCtx[]]>({ type: 'metaAndAssetCtxs' })

// Builder-deployed (HIP-3) perp dexs — e.g. "xyz" (equities), "km" (Kinetiq).
export interface HLPerpDex { name: string; fullName: string }
export const getPerpDexs = () =>
  post<(HLPerpDex | null)[]>({ type: 'perpDexs' })

export const getClearinghouseStateDex = (address: string, dex: string) =>
  post<HLClearinghouseState>({ type: 'clearinghouseState', user: address, dex })

export const getMetaAndAssetCtxsDex = (dex: string) =>
  post<[{ universe: HLPerpMeta[]; marginTables: unknown[] }, HLAssetCtx[]]>({ type: 'metaAndAssetCtxs', dex })

export const getSpotMetaAndAssetCtxs = () =>
  post<[HLSpotMeta, HLSpotAssetCtx[]]>({ type: 'spotMetaAndAssetCtxs' })

export const getPredictedFundings = () =>
  post<HLPredictedFundings>({ type: 'predictedFundings' })

export const getUserFundingHistory = (address: string) =>
  post<HLUserFunding[]>({
    type: 'userFunding',
    user: address,
    startTime: Date.now() - 90 * 24 * 60 * 60 * 1000,
  })

export const getHistoricalOrders = (address: string) =>
  post<HLHistoricalOrder[]>({ type: 'historicalOrders', user: address })

export const getTwapOrders = (address: string) =>
  post<HLTwapOrder[]>({ type: 'twapOrders', user: address })

export const getTwapHistory = (address: string) =>
  post<HLTwapHistoryEntry[]>({ type: 'twapHistory', user: address })

export const getUserFees = (address: string) =>
  post<HLUserFees>({ type: 'userFees', user: address })

export const getDelegatorSummary = (address: string) =>
  post<HLDelegatorSummary>({ type: 'delegatorSummary', user: address })

// ── All-in-one fetch ──────────────────────────────────────────────────────────

// A builder (HIP-3) perp dex the wallet has an account on. Its positions use
// dex-prefixed coin names (e.g. "xyz:MU"), so their asset contexts are merged
// into the main assetCtxMap without collision.
export interface HLBuilderDex {
  name: string
  fullName: string
  perps: HLClearinghouseState
}

export interface HLWalletData {
  role: HLUserRole
  subAccounts: HLSubAccount[]
  perps: HLClearinghouseState
  builderDexes: HLBuilderDex[]
  spot: HLSpotState
  orders: HLOpenOrder[]
  fills: HLFill[]
  ledger: HLLedgerUpdate[]
  spotTokenMap: Map<string, string>
  portfolio: HLPortfolio
  assetCtxMap: Map<string, HLAssetCtx>
  spotAssetCtxMap: Map<string, HLSpotAssetCtx>
  predictedFundings: HLPredictedFundings
  userFunding: HLUserFunding[]
  historicalOrders: HLHistoricalOrder[]
  twapOrders: HLTwapOrder[]
  twapHistory: HLTwapHistoryEntry[]
  fees: HLUserFees | null
}

export async function fetchWallet(address: string): Promise<HLWalletData> {
  const [
    role, subAccounts, perps, spot, orders, fills, ledger, spotMeta, portfolio,
    metaAndCtxs, spotMetaAndCtxs, predictedFundings, userFunding, historicalOrders,
    twapOrders, twapHistory, fees,
  ] = await Promise.all([
    getUserRole(address),
    getSubAccounts(address),
    getClearinghouseState(address),
    getSpotState(address),
    getOpenOrders(address),
    getUserFills(address),
    getLedgerUpdates(address),
    getSpotMeta(),
    getPortfolio(address),
    safe(getMetaAndAssetCtxs(), [{ universe: [], marginTables: [] }, [] as HLAssetCtx[]]),
    safe(getSpotMetaAndAssetCtxs(), [{ tokens: [], universe: [] } as HLSpotMeta, [] as HLSpotAssetCtx[]]),
    safe(getPredictedFundings(), [] as HLPredictedFundings),
    safe(getUserFundingHistory(address), [] as HLUserFunding[]),
    safe(getHistoricalOrders(address), [] as HLHistoricalOrder[]),
    safe(getTwapOrders(address), [] as HLTwapOrder[]),
    safe(getTwapHistory(address), [] as HLTwapHistoryEntry[]),
    safe(getUserFees(address), null),
  ])

  const spotTokenMap = new Map<string, string>()
  for (const t of spotMeta.tokens) {
    spotTokenMap.set(`@${t.index}`, t.name)
  }

  const [perpMeta, assetCtxs] = metaAndCtxs
  const assetCtxMap = new Map<string, HLAssetCtx>()
  for (let i = 0; i < perpMeta.universe.length; i++) {
    if (assetCtxs[i]) assetCtxMap.set(perpMeta.universe[i].name, assetCtxs[i])
  }

  const [spotMetaData, spotCtxs] = spotMetaAndCtxs as [HLSpotMeta, HLSpotAssetCtx[]]
  const spotAssetCtxMap = new Map<string, HLSpotAssetCtx>()
  for (let i = 0; i < spotMetaData.universe.length; i++) {
    if (spotCtxs[i]) {
      const pairName = spotMetaData.universe[i].name
      const tokenName = pairName.split('/')[0]
      spotAssetCtxMap.set(tokenName, spotCtxs[i])
    }
  }

  // Builder (HIP-3) dexs — discover any the wallet trades and merge their positions.
  // Coin names are dex-prefixed (e.g. "xyz:MU"), so their ctxs share assetCtxMap
  // without colliding with main-dex coins. Best-effort: failures are ignored.
  let builderDexes: HLBuilderDex[] = []
  try {
    const dexs = await getPerpDexs()
    const named = dexs.filter((d): d is HLPerpDex => !!d?.name)
    const states = await Promise.all(
      named.map(d => safe(getClearinghouseStateDex(address, d.name), null as HLClearinghouseState | null))
    )
    const active = named
      .map((d, i) => ({ d, state: states[i] }))
      .filter((x): x is { d: HLPerpDex; state: HLClearinghouseState } =>
        !!x.state && (parseFloat(x.state.marginSummary?.accountValue ?? '0') > 0 || (x.state.assetPositions?.length ?? 0) > 0))
    const dexCtxs = await Promise.all(
      active.map(({ d }) =>
        safe(
          getMetaAndAssetCtxsDex(d.name),
          [{ universe: [], marginTables: [] }, [] as HLAssetCtx[]] as [{ universe: HLPerpMeta[]; marginTables: unknown[] }, HLAssetCtx[]],
        ))
    )
    dexCtxs.forEach(([meta, cs]) => {
      for (let i = 0; i < meta.universe.length; i++) {
        if (cs[i]) assetCtxMap.set(meta.universe[i].name, cs[i])
      }
    })
    builderDexes = active.map(({ d, state }) => ({ name: d.name, fullName: d.fullName, perps: state }))
  } catch { /* builder dexs are best-effort */ }

  return {
    role, subAccounts, perps, builderDexes, spot, orders, fills, ledger, spotTokenMap, portfolio,
    assetCtxMap, spotAssetCtxMap, predictedFundings, userFunding, historicalOrders,
    twapOrders, twapHistory, fees,
  }
}

export function resolveCoins(coin: string, map: Map<string, string>): string {
  return map.get(coin) ?? coin
}

// ── Formatters ────────────────────────────────────────────────────────────────

export function fmtUsd(v: string | number | null | undefined, decimals = 2): string {
  if (v == null || v === '') return '—'
  const n = typeof v === 'string' ? parseFloat(v) : v
  if (isNaN(n)) return '—'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`
  return `${sign}$${abs.toFixed(decimals)}`
}

export function fmtNum(v: string | number | null | undefined, decimals = 4): string {
  if (v == null || v === '') return '—'
  const n = typeof v === 'string' ? parseFloat(v) : v
  if (isNaN(n)) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: 0 })
}

export function fmtPct(v: string | number | null | undefined): string {
  if (v == null || v === '') return '—'
  const n = typeof v === 'string' ? parseFloat(v) : v
  if (isNaN(n)) return '—'
  return `${(n * 100).toFixed(2)}%`
}

export function fmtTime(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleString('en-US', {
    year: sameYear ? undefined : 'numeric',
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  })
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function fmtFundingRate(v: string | number | null | undefined): string {
  if (v == null || v === '') return '—'
  const n = typeof v === 'string' ? parseFloat(v) : v
  if (isNaN(n)) return '—'
  const pct = (n * 100).toFixed(4)
  const ann = (n * 3 * 365 * 100).toFixed(2)
  return `${pct}% / ${ann}%yr`
}

export function annualizedFunding(rate: string | number): number {
  const n = typeof rate === 'string' ? parseFloat(rate) : rate
  return n * 3 * 365
}

export function fundingDirection(szi: string, fundingRate: string): 'paying' | 'receiving' | 'neutral' {
  const size = parseFloat(szi)
  const rate = parseFloat(fundingRate)
  if (size === 0 || rate === 0) return 'neutral'
  if ((size > 0 && rate > 0) || (size < 0 && rate < 0)) return 'paying'
  return 'receiving'
}
