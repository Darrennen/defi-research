'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

type RawQuoteSide = { bid: string; ask: string }

type RawListing = {
  ticker: string
  name?: string
  mark_price: string
  volume_24h: string
  open_interest: {
    long_open_interest: string
    short_open_interest: string
  }
  funding_rate: string
  funding_interval_s: number
  base_spread_bps: string
  quotes?: {
    updated_at?: string
    base?: RawQuoteSide
    size_1k?: RawQuoteSide
    size_100k?: RawQuoteSide
    size_1m?: RawQuoteSide
  }
}

type RawStats = {
  total_volume_24h: string
  open_interest: string
  num_markets: number
  listings: RawListing[]
}

type Listing = {
  ticker: string
  name: string
  markPrice: number
  vol24h: number
  oiLong: number
  oiShort: number
  oiTotal: number
  lsRatio: number | null
  fundingRate: number
  fundingIntervalS: number
  spreadBps: number
  funding8h: number
  fundingApr: number
  quotes: { label: string; bid: number; ask: number }[]
}

type Activity = {
  ts: number
  hash: string
  action: 'Deposit' | 'Withdrawal'
  usdc: number
  counterparty: string
}

type WalletData = {
  address: string
  totalDeposited: number
  totalWithdrawn: number
  netPnl: number
  depositCount: number
  withdrawalCount: number
  firstActivity: number | null
  lastActivity: number | null
  activity: Activity[]
}

type LeaderboardRow = {
  rank: number
  wallet: string
  total_deposited: number
  total_withdrawn: number
  net_pnl: number
  deposit_count: number
  withdrawal_count: number
  funding_received: number
  funding_events: number
  first_activity: string | null
  last_activity: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const n = (s: string | number | undefined | null) => parseFloat(String(s ?? '0')) || 0

const fmtUsd = (v: number | null | undefined): string => {
  if (v == null || isNaN(v)) return '—'
  const abs = Math.abs(v), s = v < 0 ? '-' : ''
  if (abs >= 1e9) return s + '$' + (abs / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return s + '$' + (abs / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return s + '$' + (abs / 1e3).toFixed(2) + 'K'
  return s + '$' + abs.toFixed(abs < 1 ? 4 : 2)
}

const fmtPrice = (v: number | null | undefined): string => {
  if (v == null || isNaN(v)) return '—'
  if (v >= 1000) return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (v >= 1) return '$' + v.toFixed(4)
  if (v >= 0.0001) return '$' + v.toFixed(6)
  return '$' + v.toExponential(3)
}

const fmtFunding = (v: number): string => {
  const pct = v * 100
  return (pct >= 0 ? '+' : '') + pct.toFixed(4) + '%'
}

const fmtDate = (ts: number | null): string => {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

const fmtTs = (ts: number): string =>
  new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

const shortAddr = (a: string) => a.slice(0, 6) + '…' + a.slice(-4)

function normalizeListing(r: RawListing): Listing {
  const markPrice = n(r.mark_price)
  const vol24h = n(r.volume_24h)
  const oiLong = n(r.open_interest?.long_open_interest)
  const oiShort = n(r.open_interest?.short_open_interest)
  const oiTotal = oiLong + oiShort
  const lsRatio = oiShort > 0 ? oiLong / oiShort : null
  const fundingRate = n(r.funding_rate)
  const fundingIntervalS = r.funding_interval_s || 28800
  const spreadBps = n(r.base_spread_bps)
  const intervalsPerDay = (24 * 3600) / fundingIntervalS
  const intervals8h = 28800 / fundingIntervalS
  const funding8h = fundingRate * intervals8h
  const fundingApr = fundingRate * intervalsPerDay * 365 * 100

  const qs = r.quotes
  const quotes: Listing['quotes'] = []
  if (qs?.base)       quotes.push({ label: 'Base',   bid: n(qs.base.bid),       ask: n(qs.base.ask) })
  if (qs?.size_1k)    quotes.push({ label: '$1K',    bid: n(qs.size_1k.bid),    ask: n(qs.size_1k.ask) })
  if (qs?.size_100k)  quotes.push({ label: '$100K',  bid: n(qs.size_100k.bid),  ask: n(qs.size_100k.ask) })
  if (qs?.size_1m)    quotes.push({ label: '$1M',    bid: n(qs.size_1m.bid),    ask: n(qs.size_1m.ask) })

  return {
    ticker: r.ticker,
    name: r.name ?? r.ticker,
    markPrice, vol24h, oiLong, oiShort, oiTotal, lsRatio,
    fundingRate, fundingIntervalS, spreadBps,
    funding8h, fundingApr, quotes,
  }
}

// ── Constants ──────────────────────────────────────────────────────────────────

const HISTORY_KEY = 'var-wallet-history'
const APIKEY_KEY  = 'var-arbiscan-key'
const MAX_HISTORY = 8
const ARB_EXPLORER = 'https://arbiscan.io'

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') } catch { return [] }
}
function saveHistory(addr: string) {
  const h = loadHistory().filter(a => a !== addr)
  h.unshift(addr)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, MAX_HISTORY)))
}

type SortKey = 'ticker' | 'markPrice' | 'vol24h' | 'oiTotal' | 'lsRatio' | 'funding8h' | 'spreadBps'

// ── Main component ─────────────────────────────────────────────────────────────

export default function VariationalExplorer() {
  const [tab, setTab] = useState<'markets' | 'wallet' | 'leaderboard'>('markets')

  // Markets state
  const [listings, setListings] = useState<Listing[]>([])
  const [platformStats, setPlatformStats] = useState<{ vol24h: number; oi: number; markets: number } | null>(null)
  const [marketsLoading, setMarketsLoading] = useState(true)
  const [marketsError, setMarketsError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('vol24h')
  const [sortDir, setSortDir] = useState(-1)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Listing | null>(null)
  const lastFetch = useRef(0)

  // Wallet state
  const [addressInput, setAddressInput] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [walletData, setWalletData] = useState<WalletData | null>(null)
  const [walletLoading, setWalletLoading] = useState(false)
  const [walletError, setWalletError] = useState<string | null>(null)
  const histRef = useRef<HTMLDivElement>(null)

  // Leaderboard state
  const [lbRows, setLbRows] = useState<LeaderboardRow[]>([])
  const [lbTotal, setLbTotal] = useState(0)
  const [lbOffset, setLbOffset] = useState(0)
  const [lbLoading, setLbLoading] = useState(false)
  const [lbError, setLbError] = useState<string | null>(null)
  const [lbFilter, setLbFilter] = useState('')
  const LB_LIMIT = 100

  // Load localStorage on mount
  useEffect(() => {
    setHistory(loadHistory())
    const stored = localStorage.getItem(APIKEY_KEY)
    if (stored) setApiKeyInput(stored)
  }, [])

  // Close history dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (histRef.current && !histRef.current.contains(e.target as Node)) setShowHistory(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Fetch markets
  const fetchMarkets = useCallback(async () => {
    const now = Date.now()
    if (now - lastFetch.current < 20_000) return
    lastFetch.current = now
    setMarketsLoading(true)
    setMarketsError(null)
    try {
      const r = await fetch('/api/variational')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data: RawStats = await r.json()
      if ((data as Record<string, unknown>).error) throw new Error(String((data as Record<string, unknown>).error))
      setPlatformStats({
        vol24h: n(data.total_volume_24h),
        oi: n(data.open_interest),
        markets: data.num_markets,
      })
      setListings((data.listings ?? []).map(normalizeListing))
    } catch (e) {
      setMarketsError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setMarketsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchMarkets()
    const iv = setInterval(fetchMarkets, 30_000)
    return () => clearInterval(iv)
  }, [fetchMarkets])

  // Keep selected listing in sync after refresh
  useEffect(() => {
    if (!selected) return
    const updated = listings.find(l => l.ticker === selected.ticker)
    if (updated) setSelected(updated)
  }, [listings]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sorted/filtered listings
  const displayed = useMemo(() => {
    let rows = listings
    if (filter) {
      const q = filter.toLowerCase()
      rows = rows.filter(l => l.ticker.toLowerCase().includes(q) || l.name.toLowerCase().includes(q))
    }
    return [...rows].sort((a, b) => {
      if (sortKey === 'ticker') return sortDir * a.ticker.localeCompare(b.ticker)
      const av = a[sortKey] as number | null
      const bv = b[sortKey] as number | null
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return sortDir * (av - bv)
    })
  }, [listings, filter, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => -d)
    else { setSortKey(key); setSortDir(-1) }
  }
  const sortArrow = (key: SortKey) => sortKey === key ? (sortDir === -1 ? ' ↓' : ' ↑') : ' ↕'

  // Wallet lookup
  const lookupWallet = useCallback(async (addr?: string) => {
    const address = (addr ?? addressInput).trim().toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      setWalletError('Enter a valid Ethereum address (0x…)')
      return
    }
    setWalletLoading(true)
    setWalletError(null)
    setWalletData(null)
    const key = apiKeyInput.trim() || localStorage.getItem(APIKEY_KEY) || ''
    try {
      const url = `/api/variational/wallet?address=${address}${key ? `&apiKey=${encodeURIComponent(key)}` : ''}`
      const r = await fetch(url)
      const data: WalletData & { error?: string } = await r.json()
      if (data.error) throw new Error(data.error)
      setWalletData(data)
      saveHistory(address)
      setHistory(loadHistory())
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : 'Lookup failed')
    } finally {
      setWalletLoading(false)
    }
  }, [addressInput, apiKeyInput])

  const fetchLeaderboard = useCallback(async (offset = 0) => {
    setLbLoading(true)
    setLbError(null)
    try {
      const r = await fetch(`/api/variational/leaderboard?limit=${100}&offset=${offset}`)
      const data = await r.json()
      if (data.error) throw new Error(data.error)
      if (offset === 0) setLbRows(data.rows)
      else setLbRows(prev => [...prev, ...data.rows])
      setLbTotal(data.total_row_count)
      setLbOffset(offset + data.rows.length)
    } catch (e) {
      setLbError(e instanceof Error ? e.message : 'Failed to load leaderboard')
    } finally {
      setLbLoading(false)
    }
  }, [])

  useEffect(() => {
    if (tab === 'leaderboard' && lbRows.length === 0 && !lbLoading) {
      fetchLeaderboard(0)
    }
  }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleAddressKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { setShowHistory(false); lookupWallet() }
    if (e.key === 'Escape') setShowHistory(false)
  }

  function saveApiKey() {
    if (apiKeyInput.trim()) localStorage.setItem(APIKEY_KEY, apiKeyInput.trim())
    setShowApiKey(false)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ paddingTop: 32, paddingBottom: 64 }}>

      {/* Page header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--ink-soft)', textTransform: 'uppercase', marginBottom: 6 }}>
          Derivatives · Protocol Explorer
        </div>
        <h1 style={{ fontSize: 'clamp(1.4rem,3vw,2rem)', fontFamily: 'var(--serif)', fontWeight: 700, lineHeight: 1.15, marginBottom: 8 }}>
          Variational <em>Explorer</em>
        </h1>
        <p style={{ color: 'var(--ink-soft)', fontSize: 14, maxWidth: 600, lineHeight: 1.6 }}>
          Live markets and wallet analytics for{' '}
          <a href="https://omni.variational.io" target="_blank" rel="noopener" style={{ color: 'var(--blue)' }}>Variational Omni</a>
          {' '}— on-chain RFQ perpetuals on Arbitrum.
          Wallet PnL is a capital-flow proxy (withdrawals − deposits); per-trade data requires private API access.
        </p>
      </div>

      {/* Stats bar */}
      {platformStats && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
          {[
            { label: '24h Volume', value: fmtUsd(platformStats.vol24h) },
            { label: 'Open Interest', value: fmtUsd(platformStats.oi) },
            { label: 'Markets', value: String(platformStats.markets) },
          ].map(s => (
            <div key={s.label} style={{
              background: 'var(--card)', border: '1px solid var(--rule)',
              borderRadius: 8, padding: '10px 18px', minWidth: 130,
            }}>
              <div style={{ fontSize: 11, color: 'var(--ink-soft)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 3, fontFamily: 'var(--mono)' }}>{s.label}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 700 }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '2px solid var(--rule)' }}>
        {(['markets', 'leaderboard', 'wallet'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '8px 18px', fontFamily: 'var(--sans)', fontWeight: 600,
            fontSize: 13, textTransform: 'capitalize', letterSpacing: '0.02em',
            color: tab === t ? 'var(--blue)' : 'var(--ink-soft)',
            borderBottom: tab === t ? '2px solid var(--blue)' : '2px solid transparent',
            marginBottom: -2, transition: 'color 0.15s',
          }}>
            {t === 'markets' ? `Markets${listings.length ? ` (${listings.length})` : ''}` : t === 'leaderboard' ? `Leaderboard${lbTotal ? ` (${lbTotal.toLocaleString()})` : ''}` : 'Wallet Lookup'}
          </button>
        ))}
      </div>

      {/* ── MARKETS TAB ── */}
      {tab === 'markets' && (
        <div>
          {marketsLoading && listings.length === 0 && (
            <div style={{ color: 'var(--ink-soft)', fontFamily: 'var(--mono)', fontSize: 13, padding: '40px 0', textAlign: 'center' }}>
              Loading markets…
            </div>
          )}
          {marketsError && (
            <div style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12, padding: '12px 16px', background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 6, marginBottom: 16 }}>
              Error: {marketsError}
            </div>
          )}

          {listings.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 340px' : '1fr', gap: 20, alignItems: 'start' }}>

              {/* Table */}
              <div>
                <div style={{ display: 'flex', gap: 10, marginBottom: 12, alignItems: 'center' }}>
                  <input
                    type="text"
                    placeholder="Search ticker or name…"
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    style={{
                      flex: 1, maxWidth: 280, padding: '7px 12px', fontFamily: 'var(--mono)',
                      fontSize: 13, background: 'var(--card)', border: '1px solid var(--rule)',
                      borderRadius: 6, color: 'var(--ink)', outline: 'none',
                    }}
                  />
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-soft)' }}>
                    {displayed.length}/{listings.length}
                    {marketsLoading && ' · refreshing…'}
                  </div>
                </div>

                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--mono)' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid var(--rule)' }}>
                        {([
                          ['ticker',    'Ticker'],
                          ['markPrice', 'Mark Price'],
                          ['vol24h',    '24h Vol'],
                          ['oiTotal',   'Open Interest'],
                          ['lsRatio',   'L/S Ratio'],
                          ['funding8h', 'Funding 8h'],
                          ['spreadBps', 'Spread bps'],
                        ] as [SortKey, string][]).map(([key, label]) => (
                          <th
                            key={key}
                            onClick={() => toggleSort(key)}
                            style={{
                              textAlign: key === 'ticker' ? 'left' : 'right',
                              padding: '7px 10px', cursor: 'pointer', userSelect: 'none',
                              color: sortKey === key ? 'var(--blue)' : 'var(--ink-soft)',
                              fontWeight: 600, fontSize: 11, letterSpacing: '0.05em', textTransform: 'uppercase',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {label}{sortArrow(key)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {displayed.map(l => {
                        const isSel = selected?.ticker === l.ticker
                        return (
                          <tr
                            key={l.ticker}
                            onClick={() => setSelected(isSel ? null : l)}
                            style={{
                              borderBottom: '1px solid var(--rule-soft)',
                              cursor: 'pointer',
                              background: isSel ? 'var(--blue-soft)' : 'transparent',
                              transition: 'background 0.1s',
                            }}
                            onMouseEnter={e => { if (!isSel) (e.currentTarget as HTMLElement).style.background = 'var(--rule-soft)' }}
                            onMouseLeave={e => { if (!isSel) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                          >
                            <td style={{ padding: '7px 10px', textAlign: 'left' }}>
                              <span style={{ fontWeight: 700, color: 'var(--ink)' }}>{l.ticker}</span>
                              {l.name !== l.ticker && <span style={{ color: 'var(--ink-soft)', marginLeft: 6, fontSize: 11 }}>{l.name}</span>}
                            </td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--ink)' }}>
                              {fmtPrice(l.markPrice)}
                            </td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--ink-soft)' }}>
                              {fmtUsd(l.vol24h)}
                            </td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--ink-soft)' }}>
                              {fmtUsd(l.oiTotal)}
                            </td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', color: l.lsRatio == null ? 'var(--ink-mute)' : l.lsRatio > 1.1 ? 'var(--green)' : l.lsRatio < 0.9 ? 'var(--red)' : 'var(--ink-soft)' }}>
                              {l.lsRatio != null ? l.lsRatio.toFixed(2) : '—'}
                            </td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', color: l.funding8h > 0 ? 'var(--green)' : l.funding8h < 0 ? 'var(--red)' : 'var(--ink-mute)' }}>
                              {fmtFunding(l.funding8h)}
                            </td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--ink-soft)' }}>
                              {l.spreadBps > 0 ? parseFloat(l.spreadBps.toFixed(2)).toString() : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Detail panel */}
              {selected && (
                <div style={{
                  background: 'var(--card)', border: '1px solid var(--rule)',
                  borderRadius: 10, padding: 20, position: 'sticky', top: 80,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
                    <div>
                      <div style={{ fontFamily: 'var(--mono)', fontWeight: 800, fontSize: 18, color: 'var(--ink)' }}>
                        {selected.ticker}
                        {selected.name !== selected.ticker && (
                          <span style={{ fontWeight: 400, fontSize: 13, color: 'var(--ink-soft)', marginLeft: 8 }}>{selected.name}</span>
                        )}
                      </div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 700, color: 'var(--blue)', marginTop: 4 }}>
                        {fmtPrice(selected.markPrice)}
                      </div>
                    </div>
                    <button
                      onClick={() => setSelected(null)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-soft)', fontSize: 20, lineHeight: 1, padding: '0 4px' }}
                    >×</button>
                  </div>

                  {/* OI Bar */}
                  {(selected.oiLong + selected.oiShort) > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 5, fontFamily: 'var(--mono)', fontWeight: 600 }}>
                        <span style={{ color: 'var(--green)' }}>Long {fmtUsd(selected.oiLong)}</span>
                        <span style={{ color: 'var(--red)' }}>Short {fmtUsd(selected.oiShort)}</span>
                      </div>
                      <div style={{ height: 7, background: 'var(--red)', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', background: 'var(--green)', borderRadius: '4px 0 0 4px',
                          width: `${(selected.oiLong / (selected.oiLong + selected.oiShort) * 100).toFixed(1)}%`,
                          transition: 'width 0.3s',
                        }} />
                      </div>
                    </div>
                  )}

                  {/* Stats grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
                    {[
                      ['24h Volume', fmtUsd(selected.vol24h)],
                      ['Total OI', fmtUsd(selected.oiTotal)],
                      ['Funding 8h', fmtFunding(selected.funding8h)],
                      ['Funding APR', (selected.fundingApr >= 0 ? '+' : '') + selected.fundingApr.toFixed(1) + '%'],
                      ['Spread bps', selected.spreadBps > 0 ? parseFloat(selected.spreadBps.toFixed(2)).toString() : '—'],
                      ['Interval', `${Math.round(selected.fundingIntervalS / 3600)}h`],
                    ].map(([label, value]) => (
                      <div key={label} style={{ background: 'var(--paper-2)', borderRadius: 6, padding: '8px 10px' }}>
                        <div style={{ fontSize: 10, color: 'var(--ink-soft)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 2, fontFamily: 'var(--mono)' }}>{label}</div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Quotes */}
                  {selected.quotes.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--ink-soft)', textTransform: 'uppercase', marginBottom: 8, fontFamily: 'var(--mono)' }}>
                        RFQ Quotes
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--mono)' }}>
                        <thead>
                          <tr>
                            {['Size', 'Bid', 'Ask', 'Spread'].map((h, i) => (
                              <th key={h} style={{
                                textAlign: i === 0 ? 'left' : 'right', padding: '4px 6px',
                                color: i === 1 ? 'var(--green)' : i === 2 ? 'var(--red)' : 'var(--ink-soft)',
                                fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                              }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {selected.quotes.map(q => {
                            const spread = q.ask - q.bid
                            const spreadPct = q.bid > 0 ? (spread / q.bid * 100) : null
                            return (
                              <tr key={q.label} style={{ borderTop: '1px solid var(--rule-soft)' }}>
                                <td style={{ padding: '5px 6px', color: 'var(--ink-soft)' }}>{q.label}</td>
                                <td style={{ padding: '5px 6px', textAlign: 'right', color: 'var(--green)' }}>{fmtPrice(q.bid)}</td>
                                <td style={{ padding: '5px 6px', textAlign: 'right', color: 'var(--red)' }}>{fmtPrice(q.ask)}</td>
                                <td style={{ padding: '5px 6px', textAlign: 'right', color: 'var(--ink-mute)' }}>
                                  {spreadPct != null ? spreadPct.toFixed(3) + '%' : '—'}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div style={{ marginTop: 14, fontSize: 11, color: 'var(--ink-soft)', fontFamily: 'var(--mono)' }}>
                    Quotes via Variational RFQ engine · auto-refresh 30s
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── WALLET TAB ── */}
      {tab === 'wallet' && (
        <div style={{ maxWidth: 860 }}>

          {/* Search bar */}
          <div style={{ background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 10, padding: 20, marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 12 }}>
              Look up any wallet's Variational activity
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div ref={histRef} style={{ position: 'relative', flex: 1, minWidth: 280 }}>
                <input
                  type="text"
                  placeholder="0x… Arbitrum wallet address"
                  value={addressInput}
                  onChange={e => setAddressInput(e.target.value)}
                  onKeyDown={handleAddressKeyDown}
                  onFocus={() => history.length > 0 && setShowHistory(true)}
                  style={{
                    width: '100%', padding: '9px 12px', fontFamily: 'var(--mono)',
                    fontSize: 13, background: 'var(--paper-2)', border: '1px solid var(--rule)',
                    borderRadius: 6, color: 'var(--ink)', outline: 'none', boxSizing: 'border-box',
                  }}
                />
                {showHistory && history.length > 0 && (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
                    background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 8,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.12)', zIndex: 100, overflow: 'hidden',
                  }}>
                    <div style={{ padding: '6px 12px', fontSize: 10, fontWeight: 700, color: 'var(--ink-soft)', letterSpacing: '0.08em', textTransform: 'uppercase', borderBottom: '1px solid var(--rule-soft)' }}>
                      Recent
                    </div>
                    {history.map(addr => (
                      <button
                        key={addr}
                        onClick={() => { setAddressInput(addr); setShowHistory(false); lookupWallet(addr) }}
                        style={{
                          width: '100%', background: 'none', border: 'none', cursor: 'pointer',
                          textAlign: 'left', padding: '8px 12px', fontFamily: 'var(--mono)',
                          fontSize: 12, color: 'var(--ink)', display: 'block',
                          borderBottom: '1px solid var(--rule-soft)',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--rule-soft)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                      >
                        {addr}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={() => lookupWallet()}
                disabled={walletLoading}
                style={{
                  padding: '9px 20px', background: 'var(--blue)', color: '#fff',
                  border: 'none', borderRadius: 6, cursor: walletLoading ? 'wait' : 'pointer',
                  fontFamily: 'var(--sans)', fontWeight: 700, fontSize: 13,
                  opacity: walletLoading ? 0.7 : 1, whiteSpace: 'nowrap',
                }}
              >
                {walletLoading ? 'Loading…' : 'Look Up'}
              </button>
              <button
                onClick={() => setShowApiKey(v => !v)}
                style={{
                  padding: '9px 14px', background: 'none', color: 'var(--ink-soft)',
                  border: '1px solid var(--rule)', borderRadius: 6, cursor: 'pointer',
                  fontFamily: 'var(--mono)', fontSize: 12,
                }}
                title="Set Arbiscan API key for higher rate limits"
              >
                API Key
              </button>
            </div>

            {showApiKey && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input
                  type="text"
                  placeholder="Arbiscan API key (free at arbiscan.io/myapikey)"
                  value={apiKeyInput}
                  onChange={e => setApiKeyInput(e.target.value)}
                  style={{
                    flex: 1, padding: '7px 12px', fontFamily: 'var(--mono)',
                    fontSize: 12, background: 'var(--paper-2)', border: '1px solid var(--rule)',
                    borderRadius: 6, color: 'var(--ink)', outline: 'none',
                  }}
                />
                <button onClick={saveApiKey} style={{
                  padding: '7px 14px', background: 'var(--paper-2)', border: '1px solid var(--rule)',
                  borderRadius: 6, cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)',
                }}>
                  Save
                </button>
              </div>
            )}

            {walletError && (
              <div style={{ marginTop: 10, color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                {walletError}
              </div>
            )}

            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--ink-soft)', lineHeight: 1.5 }}>
              Tracks USDC flows between your wallet and Variational's Oracle &amp; OLP vault on Arbitrum.
              Net PnL = withdrawals − deposits (capital flow proxy, not per-trade P&L).
            </div>
          </div>

          {/* Wallet results */}
          {walletData && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-soft)', marginBottom: 3, letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 }}>
                    Wallet
                  </div>
                  <a href={`${ARB_EXPLORER}/address/${walletData.address}`} target="_blank" rel="noopener"
                    style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--blue)', textDecoration: 'none', fontWeight: 700 }}>
                    {walletData.address} ↗
                  </a>
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-soft)', fontFamily: 'var(--mono)', textAlign: 'right' }}>
                  <div>First: {fmtDate(walletData.firstActivity)}</div>
                  <div>Last: {fmtDate(walletData.lastActivity)}</div>
                </div>
              </div>

              {/* Stats cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12, marginBottom: 24 }}>
                {[
                  { label: 'Total Deposited', value: fmtUsd(walletData.totalDeposited), color: 'var(--ink)', sub: `${walletData.depositCount} txs` },
                  { label: 'Total Withdrawn', value: fmtUsd(walletData.totalWithdrawn), color: 'var(--ink)', sub: `${walletData.withdrawalCount} txs` },
                  {
                    label: 'Net PnL (proxy)',
                    value: walletData.netPnl === 0 ? '$0' : fmtUsd(walletData.netPnl),
                    color: walletData.netPnl > 0 ? 'var(--green)' : walletData.netPnl < 0 ? 'var(--red)' : 'var(--ink-soft)',
                    sub: walletData.netPnl > 0 ? 'net profit' : walletData.netPnl < 0 ? 'net loss' : 'breakeven',
                  },
                  { label: 'Total Activity', value: String(walletData.depositCount + walletData.withdrawalCount), color: 'var(--ink)', sub: 'transactions' },
                ].map(s => (
                  <div key={s.label} style={{
                    background: 'var(--card)', border: '1px solid var(--rule)',
                    borderRadius: 8, padding: '14px 16px',
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--ink-soft)', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 6, fontFamily: 'var(--mono)' }}>
                      {s.label}
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 800, color: s.color, marginBottom: 2 }}>
                      {s.value}
                    </div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-soft)' }}>
                      {s.sub}
                    </div>
                  </div>
                ))}
              </div>

              {/* Activity table */}
              {walletData.activity.length === 0 ? (
                <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--ink-soft)', fontFamily: 'var(--mono)', fontSize: 13 }}>
                  No Variational deposit/withdrawal activity found for this address.
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-soft)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10, fontFamily: 'var(--mono)' }}>
                    Activity ({walletData.activity.length})
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--mono)' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid var(--rule)' }}>
                          {['Time', 'Action', 'USDC', 'Counterparty', 'Tx'].map((h, i) => (
                            <th key={h} style={{
                              textAlign: i === 2 ? 'right' : 'left',
                              padding: '7px 10px', color: 'var(--ink-soft)',
                              fontWeight: 600, fontSize: 11, letterSpacing: '0.05em', textTransform: 'uppercase',
                            }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {walletData.activity.map(a => (
                          <tr key={a.hash} style={{ borderBottom: '1px solid var(--rule-soft)' }}>
                            <td style={{ padding: '7px 10px', color: 'var(--ink-soft)', whiteSpace: 'nowrap' }}>
                              {fmtTs(a.ts)}
                            </td>
                            <td style={{ padding: '7px 10px' }}>
                              <span style={{
                                display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700,
                                background: a.action === 'Deposit' ? 'rgba(31,138,91,0.12)' : 'rgba(192,57,43,0.12)',
                                color: a.action === 'Deposit' ? 'var(--green)' : 'var(--red)',
                              }}>
                                {a.action}
                              </span>
                            </td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700, color: 'var(--ink)' }}>
                              {fmtUsd(a.usdc)}
                            </td>
                            <td style={{ padding: '7px 10px', color: 'var(--ink-soft)' }}>
                              <a href={`${ARB_EXPLORER}/address/${a.counterparty}`} target="_blank" rel="noopener"
                                style={{ color: 'var(--ink-soft)', textDecoration: 'none' }}>
                                {shortAddr(a.counterparty)}
                              </a>
                            </td>
                            <td style={{ padding: '7px 10px' }}>
                              <a href={`${ARB_EXPLORER}/tx/${a.hash}`} target="_blank" rel="noopener"
                                style={{ color: 'var(--blue)', textDecoration: 'none' }}>
                                {shortAddr(a.hash)} ↗
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── LEADERBOARD TAB ── */}
      {tab === 'leaderboard' && (
        <div>
          {/* Header + search */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="Filter by wallet address…"
              value={lbFilter}
              onChange={e => setLbFilter(e.target.value)}
              style={{
                flex: 1, maxWidth: 360, padding: '7px 12px', fontFamily: 'var(--mono)',
                fontSize: 13, background: 'var(--card)', border: '1px solid var(--rule)',
                borderRadius: 6, color: 'var(--ink)', outline: 'none',
              }}
            />
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-soft)' }}>
              {lbTotal > 0 && `${lbTotal.toLocaleString()} wallets · showing ${lbRows.length}`}
              {lbLoading && ' · loading…'}
            </div>
            <button
              onClick={() => fetchLeaderboard(0)}
              disabled={lbLoading}
              style={{
                padding: '7px 14px', background: 'none', border: '1px solid var(--rule)',
                borderRadius: 6, cursor: lbLoading ? 'wait' : 'pointer',
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-soft)',
              }}
            >
              Refresh
            </button>
          </div>

          {lbError && (
            <div style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12, padding: '10px 14px', background: 'var(--card)', border: '1px solid var(--rule)', borderRadius: 6, marginBottom: 16 }}>
              {lbError.includes('DUNE_API_KEY') ? (
                <>Add <code>DUNE_API_KEY=your_key</code> to <code>.env.local</code> — free key at <a href="https://dune.com/settings/api" target="_blank" rel="noopener" style={{ color: 'var(--blue)' }}>dune.com/settings/api</a></>
              ) : lbError}
            </div>
          )}

          {lbLoading && lbRows.length === 0 && (
            <div style={{ color: 'var(--ink-soft)', fontFamily: 'var(--mono)', fontSize: 13, padding: '40px 0', textAlign: 'center' }}>
              Loading leaderboard from Dune…
            </div>
          )}

          {lbRows.length > 0 && (() => {
            const filtered = lbFilter
              ? lbRows.filter(r => r.wallet.toLowerCase().includes(lbFilter.toLowerCase()))
              : lbRows
            return (
              <div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--mono)' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid var(--rule)' }}>
                        {[
                          ['#', 'right'], ['Wallet', 'left'], ['Deposited', 'right'],
                          ['Withdrawn', 'right'], ['Net PnL', 'right'],
                          ['Deps', 'right'], ['Wdrs', 'right'],
                          ['Funding Rcvd', 'right'], ['Funding Events', 'right'],
                          ['First Active', 'left'],
                        ].map(([h, align]) => (
                          <th key={h} style={{
                            textAlign: align as 'left' | 'right', padding: '7px 10px',
                            color: 'var(--ink-soft)', fontWeight: 600, fontSize: 11,
                            letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap',
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map(row => (
                        <tr
                          key={row.wallet}
                          style={{ borderBottom: '1px solid var(--rule-soft)', cursor: 'pointer' }}
                          onClick={() => { setTab('wallet'); setAddressInput(row.wallet); lookupWallet(row.wallet) }}
                          onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--rule-soft)'}
                          onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                        >
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--ink-soft)', fontWeight: row.rank <= 3 ? 700 : 400 }}>
                            {row.rank <= 3 ? ['🥇','🥈','🥉'][row.rank - 1] : row.rank}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'left' }}>
                            <a
                              href={`${ARB_EXPLORER}/address/${row.wallet}`}
                              target="_blank" rel="noopener"
                              onClick={e => e.stopPropagation()}
                              style={{ color: 'var(--blue)', textDecoration: 'none' }}
                            >
                              {shortAddr(row.wallet)}
                            </a>
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--ink-soft)' }}>
                            {fmtUsd(row.total_deposited)}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--ink-soft)' }}>
                            {fmtUsd(row.total_withdrawn)}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700, color: row.net_pnl > 0 ? 'var(--green)' : row.net_pnl < 0 ? 'var(--red)' : 'var(--ink-soft)' }}>
                            {row.net_pnl > 0 ? '+' : ''}{fmtUsd(row.net_pnl)}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--ink-soft)' }}>
                            {row.deposit_count}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--ink-soft)' }}>
                            {row.withdrawal_count}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: row.funding_received > 0 ? 'var(--green)' : 'var(--ink-soft)' }}>
                            {row.funding_received > 0 ? fmtUsd(row.funding_received) : '—'}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--ink-soft)' }}>
                            {row.funding_events > 0 ? row.funding_events.toLocaleString() : '—'}
                          </td>
                          <td style={{ padding: '7px 10px', color: 'var(--ink-soft)', whiteSpace: 'nowrap', fontSize: 11 }}>
                            {row.first_activity ? fmtDate(new Date(row.first_activity).getTime()) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Load more */}
                {lbRows.length < lbTotal && !lbFilter && (
                  <div style={{ textAlign: 'center', marginTop: 20 }}>
                    <button
                      onClick={() => fetchLeaderboard(lbOffset)}
                      disabled={lbLoading}
                      style={{
                        padding: '9px 24px', background: 'var(--card)', border: '1px solid var(--rule)',
                        borderRadius: 6, cursor: lbLoading ? 'wait' : 'pointer',
                        fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)',
                        opacity: lbLoading ? 0.6 : 1,
                      }}
                    >
                      {lbLoading ? 'Loading…' : `Load more (${(lbTotal - lbRows.length).toLocaleString()} remaining)`}
                    </button>
                  </div>
                )}

                <div style={{ marginTop: 14, fontSize: 11, color: 'var(--ink-soft)', fontFamily: 'var(--mono)' }}>
                  Source: Dune query{' '}
                  <a href="https://dune.com/queries/7589078" target="_blank" rel="noopener" style={{ color: 'var(--blue)' }}>
                    #7589078
                  </a>
                  {' '}· USDC flows via settlement vaults · cached 1h · click any row to drill into wallet
                </div>
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}
