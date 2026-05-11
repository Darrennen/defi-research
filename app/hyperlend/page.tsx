'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
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

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
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
        <span className="text-sm font-medium text-gray-900">{capUsd ? usd(capUsd) : `${cap.toLocaleString()} ${symbol}`}</span>
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
}: {
  reserve: Reserve
  open: boolean
  onToggle: () => void
}) {
  const scanBase = 'https://hyperevmscan.io/address'

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

export default function HyperLendPage() {
  const [reserves, setReserves] = useState<Reserve[]>([])
  const [selected, setSelected] = useState(0)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [configOpen, setConfigOpen] = useState(false)
  const [fetchedAt, setFetchedAt]   = useState('')

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res  = await fetch('/api/hyperlend')
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setReserves(data.reserves)
      setFetchedAt(data.fetchedAt)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const r = reserves[selected]

  return (
    <div>
      {/* Protocol switcher */}
      <div className="pt-6 pb-0 flex items-center gap-3 text-sm flex-wrap">
        <Link
          href="/aave"
          className="flex items-center gap-1.5 text-gray-400 hover:text-gray-700 transition-colors"
        >
          <Image
            src="https://icons.llamao.fi/icons/protocols/aave.jpg"
            alt="Aave"
            width={18}
            height={18}
            className="rounded-sm"
            unoptimized
          />
          Aave V3 →
        </Link>
        <span className="text-gray-200">|</span>
        <Link
          href="/sparklend"
          className="flex items-center gap-1.5 text-gray-400 hover:text-gray-700 transition-colors"
        >
          SparkLend →
        </Link>
        <span className="text-gray-200">|</span>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
          LIVE
        </span>
      </div>

      {/* Header */}
      <div className="pt-6 pb-6 border-b border-gray-100 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Image
              src="https://icons.llamao.fi/icons/protocols/hyperlend.jpg"
              alt="HyperLend"
              width={24}
              height={24}
              className="rounded-sm"
              unoptimized
            />
            <p className="text-sm text-gray-500 font-medium">HyperLend · Risk Exposures</p>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">On-Chain Lending Risk</h1>
          <p className="mt-1 text-sm text-gray-400">
            Per-asset reserve-level risk view across HyperLend Core Pool on HyperEVM.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="shrink-0 text-xs text-gray-400 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-gray-50 hover:text-gray-700 transition-colors disabled:opacity-40"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="mt-4 px-4 py-3 bg-red-50 text-red-700 text-sm rounded-lg">
          Failed to load: {error}
        </div>
      )}

      {loading && !reserves.length && (
        <div className="mt-10 space-y-4">
          <div className="flex gap-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-9 w-32 bg-gray-100 rounded-lg animate-pulse" />
            ))}
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-6">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-24 bg-gray-100 rounded-xl animate-pulse" />
            ))}
          </div>
        </div>
      )}

      {!loading && reserves.length > 0 && (
        <>
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
                <span>{res.symbol}</span>
                <span className={`text-xs ${i === selected ? 'text-gray-400' : 'text-gray-400'}`}>
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
                {' '}on HyperLend (HyperEVM) · HyperLend Core Pool
              </p>

              {/* Metric cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <MetricCard
                  label="Total Supplied"
                  primary={usd(r.totalSuppliedUsd)}
                  secondary={compactNum(r.totalSupplied, r.symbol)}
                />
                <MetricCard
                  label="Total Borrowed"
                  primary={usd(r.totalBorrowedUsd)}
                  secondary={compactNum(r.totalBorrowed, r.symbol)}
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
                      symbol={r.symbol}
                      usedUsd={r.totalSuppliedUsd}
                      capUsd={r.supplyCapUsd}
                    />
                  )}
                  {r.borrowCap > 0 && (
                    <CapBar
                      label="Borrow Cap"
                      used={r.totalBorrowed}
                      cap={r.borrowCap}
                      symbol={r.symbol}
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
              />

              {/* Risk params summary */}
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

              {/* Borrower section */}
              <div className="border border-gray-100 rounded-xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-semibold text-gray-900">
                    {r.symbol} Borrowers
                  </h2>
                  <span className="text-xs text-gray-400 bg-gray-50 px-2 py-1 rounded-md">
                    {pct(r.utilization)} utilized
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-4 pb-4 border-b border-gray-50">
                  <div>
                    <p className="text-xs text-gray-400 mb-0.5">Total Debt</p>
                    <p className="font-semibold text-gray-900">{usd(r.totalBorrowedUsd)}</p>
                    <p className="text-xs text-gray-400">{compactNum(r.totalBorrowed, r.symbol)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 mb-0.5">Borrow APY</p>
                    <p className="font-semibold text-orange-500">{pct(r.borrowApy)}</p>
                    <p className="text-xs text-gray-400">variable rate</p>
                  </div>
                </div>

                <div className="mt-4 text-center py-6">
                  <p className="text-sm text-gray-400">
                    Individual borrower positions require on-chain indexing.
                  </p>
                  <a
                    href={`https://hyperevmscan.io/address/${r.vDebtAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block text-xs text-gray-500 hover:text-gray-800 underline underline-offset-2"
                  >
                    View vDebt token on HyperEVM scan ↗
                  </a>
                </div>
              </div>

              {/* Protocol overview */}
              <div className="border border-gray-100 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-50">
                  <h2 className="text-sm font-semibold text-gray-900">All Reserves Overview</h2>
                </div>
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
                        onClick={() => { setSelected(i); setConfigOpen(false) }}
                        className={`cursor-pointer transition-colors ${i === selected ? 'bg-gray-50' : 'hover:bg-gray-50/60'}`}
                      >
                        <td className="px-4 py-3 font-medium text-gray-900">{res.symbol}</td>
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

              <p className="text-xs text-gray-400">
                Data from HyperEVM RPC · hToken + variableDebtToken multicall ·{' '}
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
