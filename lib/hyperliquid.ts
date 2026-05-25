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

// ── All-in-one fetch ──────────────────────────────────────────────────────────

export interface HLWalletData {
  role: HLUserRole
  subAccounts: HLSubAccount[]
  perps: HLClearinghouseState
  spot: HLSpotState
  orders: HLOpenOrder[]
  fills: HLFill[]
  ledger: HLLedgerUpdate[]
  spotTokenMap: Map<string, string>
  portfolio: HLPortfolio
}

export async function fetchWallet(address: string): Promise<HLWalletData> {
  const [role, subAccounts, perps, spot, orders, fills, ledger, spotMeta, portfolio] = await Promise.all([
    getUserRole(address),
    getSubAccounts(address),
    getClearinghouseState(address),
    getSpotState(address),
    getOpenOrders(address),
    getUserFills(address),
    getLedgerUpdates(address),
    getSpotMeta(),
    getPortfolio(address),
  ])

  // Build @index → name map for resolving spot coin names in fills
  const spotTokenMap = new Map<string, string>()
  for (const t of spotMeta.tokens) {
    spotTokenMap.set(`@${t.index}`, t.name)
  }

  return { role, subAccounts, perps, spot, orders, fills, ledger, spotTokenMap, portfolio }
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
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  })
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}
