'use client'

import { useEffect, useState, useCallback } from 'react'
import Image from 'next/image'

interface Reserve {
  symbol: string
  assetAddress: string
  aTokenAddress: string
  vDebtAddress: string
  supplyApy: number
  borrowApy: number
  utilization: number
  totalSupplied: number
  totalBorrowed: number
  totalSuppliedUsd: number
  totalBorrowedUsd: number
  ltv: number
  liquidationThreshold: number
  liquidationBonus: number
  decimals: number
  reserveFactor: number
  supplyCap: number
  borrowCap: number
  supplyCapUsd: number | null
  borrowCapUsd: number | null
  price: number
}

interface ChainMeta {
  name: string
  icon: string
}

interface ApiResponse {
  reserves: Reserve[]
  chain: string
  chainIcon: string
  chains: Record<string, ChainMeta>
  fetchedAt: string
  error?: string
}

// ─── helpers ────────────────────────────────────────────────────────────────

function usd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

function pct(n: number, decimals = 2): string {
  return `${n.toFixed(decimals)}%`
}

function compactNum(n: number, symbol: string): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M ${symbol}`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K ${symbol}`
  return `${n.toFixed(2)} ${symbol}`
}

const CHAIN_SCAN: Record<string, string> = {
  'ethereum-core': 'https://etherscan.io/address',
  arbitrum:        'https://arbiscan.io/address',
  base:            'https://basescan.org/address',
  polygon:         'https://polygonscan.com/address',
  optimism:        'https://optimistic.etherscan.io/address',
  avalanche:       'https://snowtrace.io/address',
}

// ─── sub-components ──────────────────────────────────────────────────────────

function MetricCard({
  label,
  primary,
  secondary,
  accent,
}: {
  label: string
  primary: string
  secondary?: string
  accent?: boolean
}) {
  return (
    <div className="border border-gray-100 rounded-xl p-5">
      <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-2">{label}</p>
      <p className={`text-xl font-bold ${accent ? 'text-blue-600' : 'text-gray-900'}`}>{primary}</p>
      {secondary && <p className="text-xs text-gray-400 mt-0.5">{secondary}</p>}
    </div>
  )
}

function CapBar({
  label,
  used,
  cap,
  symbol,
  usedUsd,
  capUsd,
}: {
  label: string
  used: number
  cap: number
  symbol: string
  usedUsd: number
  capUsd: number | null
}) {
  const pctUsed = cap > 0 ? Math.min((used / cap) * 100, 100) : 0
  const barColor =
    pctUsed > 95 ? 'bg-red-400' : pctUsed > 80 ? 'bg-yellow-400' : 'bg-green-400'

  return (
    <div className="flex items-center gap-4 py-3 border-b border-gray-50 last:border-0">
      <p className="text-xs text-gray-400 w-24 shrink-0">{label}</p>
      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pctUsed}%` }} />
      </div>
      <div className="text-right shrink-0">
        <span className="text-sm font-medium text-gray-900">
          {capUsd ? usd(capUsd) : `${cap.toLocaleString()} ${symbol}`}
        </span>
        <span className="text-xs text-gray-400 ml-2">
          {pct(pctUsed, 0)} used · {compactNum(cap, symbol)}
        </span>
      </div>
    </div>
  )
}

function ReserveConfig({
  reserve,
  open,
  onToggle,
  scanBase,
}: {
  reserve: Reserve
  open: boolean
  onToggle: () => void
  scanBase: string
}) {
  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-5 py-4 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
      >
        <span>Reserve Config</span>
        <span className="text-gray-400">{open ? '▲' : '▶'}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-4 text-sm">
            {[
              ['LTV', pct(reserve.ltv)],
              ['Liquidation Threshold', pct(reserve.liquidationThreshold)],
              ['Liquidation Bonus', pct(reserve.liquidationBonus - 100)],
              ['Reserve Factor', pct(reserve.reserveFactor)],
              ['Decimals', String(reserve.decimals)],
              ['Supply Cap', reserve.supplyCap > 0 ? compactNum(reserve.supplyCap, reserve.symbol) : '∞'],
              ['Borrow Cap', reserve.borrowCap > 0 ? compactNum(reserve.borrowCap, reserve.symbol) : '∞'],
            ].map(([k, v]) => (
              <div key={k}>
                <p className="text-xs text-gray-400 mb-0.5">{k}</p>
                <p className="font-medium text-gray-900">{v}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 pt-4 border-t border-gray-50 flex flex-wrap gap-3 text-xs">
            <a
              href={`${scanBase}/${reserve.assetAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-gray-700 underline underline-offset-2"
            >
              Asset ↗
            </a>
            <a
              href={`${scanBase}/${reserve.aTokenAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-gray-700 underline underline-offset-2"
            >
              aToken ↗
            </a>
            <a
              href={`${scanBase}/${reserve.vDebtAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-gray-700 underline underline-offset-2"
            >
              vDebt ↗
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── main page ────────────────────────────────────────────────────────────────

const DEFAULT_CHAIN = 'ethereum-core'

export default function AavePage() {
  const [chainKey, setChainKey]   = useState(DEFAULT_CHAIN)
  const [reserves, setReserves]   = useState<Reserve[]>([])
  const [chains, setChains]       = useState<Record<string, ChainMeta>>({})
  const [chainName, setChainName] = useState('')
  const [chainIcon, setChainIcon] = useState('')
  const [selected, setSelected]   = useState(0)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [configOpen, setConfigOpen] = useState(false)
  const [fetchedAt, setFetchedAt]   = useState('')

  const load = useCallback(async (chain: string) => {
    setLoading(true)
    setError(null)
    try {
      const res  = await fetch(`/api/aave?chain=${chain}`)
      const data: ApiResponse = await res.json()
      if (data.error) throw new Error(data.error)
      setReserves(data.reserves)
      setChains(data.chains)
      setChainName(data.chain)
      setChainIcon(data.chainIcon)
      setFetchedAt(data.fetchedAt)
      setSelected(0)
      setConfigOpen(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(chainKey) }, [chainKey, load])

  const r = reserves[selected]
  const scanBase = CHAIN_SCAN[chainKey] ?? 'https://etherscan.io/address'

  const totalSupplied = reserves.reduce((s, x) => s + x.totalSuppliedUsd, 0)
  const totalBorrowed = reserves.reduce((s, x) => s + x.totalBorrowedUsd, 0)
  const avgUtil = reserves.length
    ? reserves.reduce((s, x) => s + x.utilization, 0) / reserves.length
    : 0

  return (
    <div>
      {/* Header */}
      <div className="pt-6 pb-6 border-b border-gray-100 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Image
              src="https://icons.llamao.fi/icons/protocols/aave.jpg"
              alt="Aave"
              width={24}
              height={24}
              className="rounded-sm"
              unoptimized
            />
            <p className="text-sm text-gray-500 font-medium">Aave V3 · Reserve Risk Exposures</p>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">On-Chain Lending Risk</h1>
          <p className="mt-1 text-sm text-gray-400">
            Per-asset reserve-level risk view across Aave V3 on multiple chains. On-chain RPC + DeFiLlama yields.
          </p>
        </div>
        <button
          onClick={() => load(chainKey)}
          disabled={loading}
          className="shrink-0 text-xs text-gray-400 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-gray-50 hover:text-gray-700 transition-colors disabled:opacity-40"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Chain switcher */}
      <div className="mt-5 flex gap-2 flex-wrap">
        {Object.entries(chains).map(([key, meta]) => (
          <button
            key={key}
            onClick={() => { setChainKey(key) }}
            disabled={loading}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border transition-all disabled:opacity-50 ${
              key === chainKey
                ? 'border-gray-900 bg-gray-900 text-white font-medium'
                : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-800'
            }`}
          >
            <Image
              src={meta.icon}
              alt={meta.name}
              width={16}
              height={16}
              className="rounded-full"
              unoptimized
            />
            {meta.name}
          </button>
        ))}

        {Object.keys(chains).length === 0 && (
          // skeleton while chain list loads
          [...Array(6)].map((_, i) => (
            <div key={i} className="h-8 w-28 bg-gray-100 rounded-lg animate-pulse" />
          ))
        )}
      </div>

      {error && (
        <div className="mt-4 px-4 py-3 bg-red-50 text-red-700 text-sm rounded-lg">
          Failed to load: {error}
        </div>
      )}

      {loading && !reserves.length && (
        <div className="mt-8 space-y-4">
          <div className="flex gap-2 overflow-x-auto">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-9 w-28 bg-gray-100 rounded-lg animate-pulse shrink-0" />
            ))}
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-24 bg-gray-100 rounded-xl animate-pulse" />
            ))}
          </div>
        </div>
      )}

      {!loading && reserves.length > 0 && (
        <>
          {/* Protocol-level summary */}
          <div className="mt-6 grid grid-cols-3 gap-4">
            <div className="border border-gray-100 rounded-xl p-4">
              <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">Total Supplied</p>
              <p className="text-xl font-bold text-gray-900">{usd(totalSupplied)}</p>
              <p className="text-xs text-gray-400 mt-0.5">{chainName}</p>
            </div>
            <div className="border border-gray-100 rounded-xl p-4">
              <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">Total Borrowed</p>
              <p className="text-xl font-bold text-gray-900">{usd(totalBorrowed)}</p>
              <p className="text-xs text-gray-400 mt-0.5">{reserves.length} active markets</p>
            </div>
            <div className="border border-gray-100 rounded-xl p-4">
              <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">Avg. Utilization</p>
              <p className={`text-xl font-bold ${avgUtil > 80 ? 'text-yellow-600' : 'text-gray-900'}`}>
                {pct(avgUtil)}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">across all reserves</p>
            </div>
          </div>

          {/* Asset tabs */}
          <div className="mt-6 flex gap-2 overflow-x-auto pb-1">
            {reserves.map((res, i) => (
              <button
                key={res.symbol}
                onClick={() => { setSelected(i); setConfigOpen(false) }}
                className={`shrink-0 flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm border transition-all ${
                  i === selected
                    ? 'border-gray-900 bg-gray-900 text-white font-medium'
                    : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-800'
                }`}
              >
                <span>{res.symbol.split('-')[0]}</span>
                <span className="text-xs text-gray-400">
                  {usd(res.totalSuppliedUsd)}
                </span>
              </button>
            ))}
          </div>

          {r && (
            <div className="mt-6 space-y-4">
              {/* Reserve label */}
              <p className="text-xs text-gray-400">
                <span className="font-medium text-gray-600">{r.symbol}</span>
                {' '}on Aave V3 · {chainName}
              </p>

              {/* Metric cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <MetricCard
                  label="Total Supplied"
                  primary={usd(r.totalSuppliedUsd)}
                  secondary={compactNum(r.totalSupplied, r.symbol.split('-')[0])}
                />
                <MetricCard
                  label="Total Borrowed"
                  primary={usd(r.totalBorrowedUsd)}
                  secondary={compactNum(r.totalBorrowed, r.symbol.split('-')[0])}
                />
                <MetricCard
                  label="Utilization"
                  primary={pct(r.utilization)}
                  accent={r.utilization > 80}
                />
                <MetricCard
                  label="Supply APY / Borrow APY"
                  primary={`${pct(r.supplyApy)} / ${pct(r.borrowApy)}`}
                  accent
                />
              </div>

              {/* Caps */}
              {(r.supplyCap > 0 || r.borrowCap > 0) && (
                <div className="border border-gray-100 rounded-xl px-5 py-2">
                  {r.supplyCap > 0 && (
                    <CapBar
                      label="Supply Cap"
                      used={r.totalSupplied}
                      cap={r.supplyCap}
                      symbol={r.symbol.split('-')[0]}
                      usedUsd={r.totalSuppliedUsd}
                      capUsd={r.supplyCapUsd}
                    />
                  )}
                  {r.borrowCap > 0 && (
                    <CapBar
                      label="Borrow Cap"
                      used={r.totalBorrowed}
                      cap={r.borrowCap}
                      symbol={r.symbol.split('-')[0]}
                      usedUsd={r.totalBorrowedUsd}
                      capUsd={r.borrowCapUsd}
                    />
                  )}
                </div>
              )}

              {/* Reserve config */}
              <ReserveConfig
                reserve={r}
                open={configOpen}
                onToggle={() => setConfigOpen((v) => !v)}
                scanBase={scanBase}
              />

              {/* Risk params */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Max LTV', value: pct(r.ltv), color: 'text-gray-900' },
                  { label: 'Liq. Threshold', value: pct(r.liquidationThreshold), color: 'text-yellow-700' },
                  { label: 'Liq. Bonus', value: `+${pct(r.liquidationBonus - 100)}`, color: 'text-red-600' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="border border-gray-100 rounded-xl p-4 text-center">
                    <p className="text-xs text-gray-400 mb-1">{label}</p>
                    <p className={`text-lg font-bold ${color}`}>{value}</p>
                  </div>
                ))}
              </div>

              {/* All reserves overview table */}
              <div className="border border-gray-100 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-gray-900">All Reserves — {chainName}</h2>
                  {chainIcon && (
                    <Image src={chainIcon} alt={chainName} width={20} height={20} className="rounded-full" unoptimized />
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-50">
                        {['Asset', 'Supplied', 'Borrowed', 'Util.', 'Supply APY', 'Borrow APY', 'LTV'].map((h, i) => (
                          <th
                            key={h}
                            className={`px-4 py-3 text-xs text-gray-400 font-medium uppercase tracking-wide ${i === 0 ? 'text-left' : 'text-right'}`}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {reserves.map((res, i) => (
                        <tr
                          key={res.symbol}
                          onClick={() => { setSelected(i); setConfigOpen(false); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                          className={`cursor-pointer transition-colors ${i === selected ? 'bg-gray-50' : 'hover:bg-gray-50/60'}`}
                        >
                          <td className="px-4 py-3 font-medium text-gray-900">{res.symbol.split('-')[0]}</td>
                          <td className="px-4 py-3 text-right text-gray-600">{usd(res.totalSuppliedUsd)}</td>
                          <td className="px-4 py-3 text-right text-gray-600">{usd(res.totalBorrowedUsd)}</td>
                          <td className="px-4 py-3 text-right">
                            <span className={`font-medium ${res.utilization > 80 ? 'text-yellow-600' : 'text-gray-600'}`}>
                              {pct(res.utilization)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right text-blue-600 font-medium">{pct(res.supplyApy)}</td>
                          <td className="px-4 py-3 text-right text-orange-500 font-medium">{pct(res.borrowApy)}</td>
                          <td className="px-4 py-3 text-right text-gray-500">{pct(res.ltv)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <p className="text-xs text-gray-400">
                Data from {chainName} RPC + DeFiLlama Yields API ·{' '}
                {fetchedAt ? `Fetched ${new Date(fetchedAt).toLocaleTimeString()}` : 'Live'}
                {' '}· LT = Liquidation Threshold
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
