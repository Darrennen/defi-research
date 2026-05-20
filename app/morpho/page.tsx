'use client'

import { useEffect, useState, useCallback } from 'react'
import Image from 'next/image'

interface Market {
  marketId: string
  pair: string
  collateralSymbol: string
  loanSymbol: string
  collateralAddress: string
  loanAddress: string
  oracleAddress: string
  irmAddress: string
  creationTimestamp: number
  lltv: number
  supplyApy: number
  borrowApy: number
  utilization: number
  totalSupplyUsd: number
  totalBorrowUsd: number
  fee: number
  collateralPriceUsd: number
  loanPriceUsd: number
}

interface Vault {
  address: string
  name: string
  symbol: string
  assetSymbol: string
  totalAssetsUsd: number
  apy: number
  netApy: number
  fee: number
}

interface ChainMeta { name: string; icon: string }
interface ApiResponse {
  markets: Market[]
  vaults: Vault[]
  chain: string
  chainIcon: string
  chains: Record<string, ChainMeta>
  totalSupplyUsd: number
  totalBorrowUsd: number
  activeMarkets: number
  highUtilMarkets: number
  fetchedAt: string
  error?: string
}

const u = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`
const p = (n: number, d = 2) => `${n.toFixed(d)}%`
const shortAddr = (a: string) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—'
const fmtDate = (ts: number) => ts ? new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

const CHAIN_EXPLORER: Record<string, string> = {
  ethereum: 'https://etherscan.io/address',
  base: 'https://basescan.org/address',
}

export default function MorphoPage() {
  const [chainKey, setChainKey] = useState('ethereum')
  const [markets, setMarkets] = useState<Market[]>([])
  const [vaults, setVaults] = useState<Vault[]>([])
  const [chains, setChains] = useState<Record<string, ChainMeta>>({})
  const [chainName, setChainName] = useState('')
  const [chainIcon, setChainIcon] = useState('')
  const [totalSupplyUsd, setTotalSupplyUsd] = useState(0)
  const [totalBorrowUsd, setTotalBorrowUsd] = useState(0)
  const [activeMarkets, setActiveMarkets] = useState(0)
  const [highUtilMarkets, setHighUtilMarkets] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState('')
  const [filter, setFilter] = useState('')

  const load = useCallback(async (chain: string) => {
    setLoading(true); setError(null); setSelected(null)
    try {
      const res = await fetch(`/api/morpho?chain=${chain}`)
      const data: ApiResponse = await res.json()
      if (data.error) throw new Error(data.error)
      setMarkets(data.markets)
      setVaults(data.vaults ?? [])
      setChains(data.chains)
      setChainName(data.chain)
      setChainIcon(data.chainIcon)
      setTotalSupplyUsd(data.totalSupplyUsd)
      setTotalBorrowUsd(data.totalBorrowUsd)
      setActiveMarkets(data.activeMarkets)
      setHighUtilMarkets(data.highUtilMarkets)
      setFetchedAt(data.fetchedAt)
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }, [])

  useEffect(() => { load(chainKey) }, [chainKey, load])

  const scanBase = CHAIN_EXPLORER[chainKey] ?? 'https://etherscan.io/address'
  const morphoAppMarket = `https://app.morpho.org/market?id=`
  const morphoAppVault = `https://app.morpho.org/vault?vault=`

  const filtered = markets.filter((m) => {
    if (!filter) return true
    const q = filter.toLowerCase()
    return (
      m.collateralSymbol.toLowerCase().includes(q) ||
      m.loanSymbol.toLowerCase().includes(q)
    )
  })

  const m = selected !== null ? filtered[selected] : null

  // Loan asset breakdown (computed client-side)
  const loanBreakdown = Object.entries(
    markets.reduce<Record<string, number>>((acc, mkt) => {
      acc[mkt.loanSymbol] = (acc[mkt.loanSymbol] || 0) + mkt.totalSupplyUsd
      return acc
    }, {})
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)

  const loanBreakdownMax = loanBreakdown[0]?.[1] ?? 1

  return (
    <div>
      {/* Page header */}
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Image src="https://icons.llamao.fi/icons/protocols/morpho-blue" alt="Morpho Blue" width={20} height={20} style={{ borderRadius: 3 }} unoptimized />
            <div className="kicker" style={{ margin: 0 }}>Morpho Blue · Market Risk Exposures</div>
          </div>
          <h1>On-Chain <em>Morpho Markets</em></h1>
          <p className="dek">Per-market risk view across Morpho Blue — supply, borrow, utilization, and LLTV for every active lending pair.</p>
        </div>
        <button onClick={() => load(chainKey)} disabled={loading} className="btn ghost" style={{ flexShrink: 0, marginTop: 8, padding: '8px 16px', fontSize: 11 }}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Chain switcher */}
      <div className="ch-row">
        {Object.entries(chains).map(([key, meta]) => (
          <button key={key} onClick={() => setChainKey(key)} disabled={loading} className={`ch ${key === chainKey ? 'on' : ''}`}>
            <Image src={meta.icon} alt={meta.name} width={12} height={12} style={{ borderRadius: '50%', marginRight: 4, verticalAlign: 'middle' }} unoptimized />
            {meta.name}
          </button>
        ))}
        {!Object.keys(chains).length && [...Array(2)].map((_, i) => <div key={i} className="skel" style={{ height: 32, width: 100 }} />)}
      </div>

      {error && (
        <div style={{ marginTop: 16, padding: '12px 16px', background: 'rgba(192,57,43,0.08)', color: 'var(--red)', fontFamily: 'var(--sans)', fontSize: 13, border: '1px solid rgba(192,57,43,0.2)' }}>
          Failed to load: {error}
        </div>
      )}

      {loading && !markets.length && (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
            {[...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 88 }} />)}
          </div>
          <div className="skel" style={{ height: 180, marginTop: 20 }} />
          <div className="skel" style={{ height: 320, marginTop: 16 }} />
        </div>
      )}

      {!loading && markets.length > 0 && (
        <>
          {/* Protocol KPIs */}
          <div className="kpi" style={{ marginTop: 24, gridTemplateColumns: 'repeat(4,1fr)' }}>
            {[
              { l: 'Total Supplied', v: u(totalSupplyUsd), d: chainName },
              { l: 'Total Borrowed', v: u(totalBorrowUsd), d: `${activeMarkets} active markets` },
              { l: 'Avg. Utilization', v: p(totalSupplyUsd > 0 ? (totalBorrowUsd / totalSupplyUsd) * 100 : 0), d: 'across all markets', warn: totalSupplyUsd > 0 && (totalBorrowUsd / totalSupplyUsd) > 0.8 },
              { l: 'High Util. Markets', v: String(highUtilMarkets), d: '≥ 80% utilized', warn: highUtilMarkets > 5 },
            ].map(({ l, v, d, warn }) => (
              <div className="b" key={l}>
                <div className="l">{l}</div>
                <div className="v" style={{ color: warn ? 'var(--amber)' : undefined }}>{v}</div>
                <div className={`d${warn ? ' warn' : ''}`}>{d}</div>
              </div>
            ))}
          </div>

          {/* Loan asset breakdown */}
          {loanBreakdown.length > 0 && (
            <div className="panel" style={{ marginTop: 20, padding: '16px 20px' }}>
              <div className="ph" style={{ padding: 0, marginBottom: 14 }}>
                <span className="t">Supply by Loan Asset</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>{chainName}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {loanBreakdown.map(([symbol, supplyUsd]) => {
                  const pct = (supplyUsd / loanBreakdownMax) * 100
                  return (
                    <div key={symbol} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, width: 64, flexShrink: 0 }}>{symbol}</div>
                      <div style={{ flex: 1, background: 'var(--rule)', height: 6, borderRadius: 2 }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--blue)', borderRadius: 2 }} />
                      </div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-mute)', width: 80, textAlign: 'right', flexShrink: 0 }}>{u(supplyUsd)}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Selected market detail */}
          {m && (
            <div style={{ marginTop: 20 }}>
              <p style={{ fontFamily: 'var(--sans)', fontSize: 11, color: 'var(--ink-mute)', margin: '0 0 12px' }}>
                <strong style={{ color: 'var(--ink)' }}>{m.pair}</strong> · Morpho Blue · {chainName}
                <span style={{ marginLeft: 12, opacity: 0.5 }}>{m.marketId.slice(0, 10)}…</span>
              </p>

              {/* Market KPIs */}
              <div className="kpi">
                {[
                  { l: 'Total Supplied', v: u(m.totalSupplyUsd), d: m.loanSymbol },
                  { l: 'Total Borrowed', v: u(m.totalBorrowUsd), d: m.loanSymbol },
                  { l: 'Utilization', v: p(m.utilization), warn: m.utilization > 80 },
                  { l: 'Supply / Borrow APY', v: `${p(m.supplyApy)} / ${p(m.borrowApy)}`, blue: true },
                ].map(({ l, v, d, warn, blue }) => (
                  <div className="b" key={l}>
                    <div className="l">{l}</div>
                    <div className="v" style={{ color: warn ? 'var(--amber)' : blue ? 'var(--blue)' : undefined }}>{v}</div>
                    {d && <div className="d">{d}</div>}
                  </div>
                ))}
              </div>

              {/* Utilization bar */}
              <div className="panel" style={{ marginTop: 16, padding: '4px 20px' }}>
                <div className="cap-row">
                  <div className="lbl">Utilization</div>
                  <div className="cap-track">
                    <div className={`cap-fill ${m.utilization > 95 ? 'hot' : m.utilization > 80 ? 'warn' : ''}`} style={{ width: `${Math.min(m.utilization, 100)}%` }} />
                  </div>
                  <span className="cap-val">{u(m.totalBorrowUsd)} borrowed</span>
                  <span className="cap-pct">{p(m.utilization, 1)} of supply</span>
                </div>
              </div>

              {/* Risk params */}
              <div className="risk-grid" style={{ marginTop: 16 }}>
                {[
                  ['LLTV', p(m.lltv), 'var(--ink)'],
                  ['Protocol Fee', m.fee > 0 ? p(m.fee) : '0%', 'var(--ink)'],
                  ['Collateral Price', m.collateralPriceUsd > 0 ? u(m.collateralPriceUsd) : '—', 'var(--ink)'],
                  ['Loan Asset Price', m.loanPriceUsd > 0 ? u(m.loanPriceUsd) : '—', 'var(--ink)'],
                  ['Created', fmtDate(m.creationTimestamp), 'var(--ink-mute)'],
                ].map(([lbl, val, color]) => (
                  <div className="risk-cell" key={lbl as string}><div className="k">{lbl}</div><div className="v" style={{ color: color as string }}>{val}</div></div>
                ))}
              </div>

              {/* Addresses */}
              <div className="cfg-panel" style={{ marginTop: 14 }}>
                <div className="cfg-body" style={{ padding: '12px 16px' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 24px' }}>
                    {[
                      ['Collateral', m.collateralAddress],
                      ['Loan Asset', m.loanAddress],
                      ['Oracle', m.oracleAddress],
                      ['IRM', m.irmAddress],
                    ].map(([lbl, addr]) => addr ? (
                      <a key={lbl} href={`${scanBase}/${addr}`} target="_blank" rel="noopener noreferrer"
                        style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--blue-ink)', textDecoration: 'underline', textUnderlineOffset: 3 }}>
                        {lbl} {shortAddr(addr)} ↗
                      </a>
                    ) : null)}
                    <a href={`${morphoAppMarket}${m.marketId}`} target="_blank" rel="noopener noreferrer"
                      style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--blue-ink)', textDecoration: 'underline', textUnderlineOffset: 3 }}>
                      Morpho App ↗
                    </a>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Search */}
          <div style={{ marginTop: 20, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="text"
              value={filter}
              onChange={(e) => { setFilter(e.target.value); setSelected(null) }}
              placeholder="Filter by asset (e.g. WBTC, USDC, wstETH)…"
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 12,
                padding: '7px 12px',
                border: '1px solid var(--rule)',
                background: 'var(--bg)',
                color: 'var(--ink)',
                outline: 'none',
                width: 320,
              }}
            />
            {filter && (
              <button onClick={() => setFilter('')} className="btn ghost" style={{ padding: '6px 12px', fontSize: 11 }}>
                Clear
              </button>
            )}
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', marginLeft: 'auto' }}>
              {filtered.length} market{filtered.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Markets table */}
          <div className="panel">
            <div className="ph">
              <span className="t">All Markets — {chainName}</span>
              {chainIcon && <Image src={chainIcon} alt={chainName} width={16} height={16} style={{ borderRadius: '50%' }} unoptimized />}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="tab">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', paddingLeft: 22 }}>Collateral / Loan</th>
                    <th>LLTV</th>
                    <th>Supplied</th>
                    <th>Borrowed</th>
                    <th>Util.</th>
                    <th>Supply APY</th>
                    <th>Borrow APY</th>
                    <th>Fee</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((mkt, i) => (
                    <tr
                      key={mkt.marketId}
                      onClick={() => { setSelected(i === selected ? null : i); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                      style={{ cursor: 'pointer', background: i === selected ? 'var(--blue-soft)' : undefined }}
                    >
                      <td className="name" style={{ paddingLeft: 22 }}>
                        <span style={{ fontWeight: 600 }}>{mkt.collateralSymbol}</span>
                        <span style={{ color: 'var(--ink-mute)', margin: '0 4px' }}>/</span>
                        <span>{mkt.loanSymbol}</span>
                      </td>
                      <td style={{ fontFamily: 'var(--mono)' }}>{p(mkt.lltv)}</td>
                      <td>{u(mkt.totalSupplyUsd)}</td>
                      <td>{u(mkt.totalBorrowUsd)}</td>
                      <td style={{ color: mkt.utilization > 80 ? 'var(--amber)' : undefined, fontWeight: mkt.utilization > 80 ? 600 : undefined }}>
                        {p(mkt.utilization, 1)}
                      </td>
                      <td className="pos">{p(mkt.supplyApy)}</td>
                      <td style={{ color: 'var(--amber)', fontWeight: 600 }}>{p(mkt.borrowApy)}</td>
                      <td style={{ color: 'var(--ink-mute)' }}>{mkt.fee > 0 ? p(mkt.fee) : '—'}</td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={8} style={{ textAlign: 'center', padding: '24px', fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink-mute)' }}>
                        No markets match &ldquo;{filter}&rdquo;
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* MetaMorpho Vaults */}
          {vaults.length > 0 && (
            <div className="panel" style={{ marginTop: 20 }}>
              <div className="ph">
                <span className="t">MetaMorpho Vaults — {chainName}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>Curated liquidity</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="tab">
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', paddingLeft: 22 }}>Vault</th>
                      <th>Asset</th>
                      <th>TVL</th>
                      <th>Gross APY</th>
                      <th>Net APY</th>
                      <th>Mgmt Fee</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vaults.map((v) => (
                      <tr key={v.address} style={{ cursor: 'pointer' }}
                        onClick={() => window.open(`${morphoAppVault}${v.address}`, '_blank')}>
                        <td className="name" style={{ paddingLeft: 22 }}>
                          <span style={{ fontWeight: 600 }}>{v.name}</span>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)', marginLeft: 6 }}>{v.symbol}</span>
                        </td>
                        <td style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{v.assetSymbol}</td>
                        <td>{u(v.totalAssetsUsd)}</td>
                        <td className="pos">{p(v.apy)}</td>
                        <td style={{ color: 'var(--blue)', fontWeight: 600 }}>{p(v.netApy)}</td>
                        <td style={{ color: 'var(--ink-mute)' }}>{v.fee > 0 ? p(v.fee) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p style={{ marginTop: 24, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', letterSpacing: '0.04em' }}>
            Data from Morpho Blue GraphQL API · {fetchedAt ? `Fetched ${new Date(fetchedAt).toLocaleTimeString()}` : 'Live'} · LLTV = Liquidation LTV · Click any market row for details
          </p>
        </>
      )}
    </div>
  )
}
