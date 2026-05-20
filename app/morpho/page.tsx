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
  lltv: number
  supplyApy: number
  borrowApy: number
  utilization: number
  totalSupplyUsd: number
  totalBorrowUsd: number
  collateralPriceUsd: number
  loanPriceUsd: number
}

interface ChainMeta { name: string; icon: string }
interface ApiResponse {
  markets: Market[]
  chain: string
  chainIcon: string
  chains: Record<string, ChainMeta>
  totalSupplyUsd: number
  totalBorrowUsd: number
  activeMarkets: number
  fetchedAt: string
  error?: string
}

const u = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`
const p = (n: number, d = 2) => `${n.toFixed(d)}%`

const CHAIN_EXPLORER: Record<string, string> = {
  ethereum: 'https://etherscan.io/address',
  base: 'https://basescan.org/address',
}

const MORPHO_APP: Record<string, string> = {
  ethereum: 'https://app.morpho.org/market?id=',
  base: 'https://app.morpho.org/market?id=',
}

export default function MorphoPage() {
  const [chainKey, setChainKey] = useState('ethereum')
  const [markets, setMarkets] = useState<Market[]>([])
  const [chains, setChains] = useState<Record<string, ChainMeta>>({})
  const [chainName, setChainName] = useState('')
  const [chainIcon, setChainIcon] = useState('')
  const [totalSupplyUsd, setTotalSupplyUsd] = useState(0)
  const [totalBorrowUsd, setTotalBorrowUsd] = useState(0)
  const [activeMarkets, setActiveMarkets] = useState(0)
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
      setChains(data.chains)
      setChainName(data.chain)
      setChainIcon(data.chainIcon)
      setTotalSupplyUsd(data.totalSupplyUsd)
      setTotalBorrowUsd(data.totalBorrowUsd)
      setActiveMarkets(data.activeMarkets)
      setFetchedAt(data.fetchedAt)
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }, [])

  useEffect(() => { load(chainKey) }, [chainKey, load])

  const scanBase = CHAIN_EXPLORER[chainKey] ?? 'https://etherscan.io/address'
  const morphoBase = MORPHO_APP[chainKey] ?? 'https://app.morpho.org/market?id='

  const filtered = markets.filter((m) => {
    if (!filter) return true
    const q = filter.toLowerCase()
    return (
      m.collateralSymbol.toLowerCase().includes(q) ||
      m.loanSymbol.toLowerCase().includes(q) ||
      m.pair.toLowerCase().includes(q)
    )
  })

  const m = selected !== null ? filtered[selected] : null

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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginTop: 24 }}>
            {[...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 88 }} />)}
          </div>
          <div className="skel" style={{ height: 320, marginTop: 20 }} />
        </div>
      )}

      {!loading && markets.length > 0 && (
        <>
          {/* Protocol KPIs */}
          <div className="kpi kpi-3col" style={{ marginTop: 24 }}>
            {[
              { l: 'Total Supplied', v: u(totalSupplyUsd), d: chainName },
              { l: 'Total Borrowed', v: u(totalBorrowUsd), d: `${activeMarkets} active markets` },
              { l: 'Avg. Utilization', v: p(totalSupplyUsd > 0 ? (totalBorrowUsd / totalSupplyUsd) * 100 : 0), d: 'across all markets', warn: totalSupplyUsd > 0 && (totalBorrowUsd / totalSupplyUsd) > 0.8 },
            ].map(({ l, v, d, warn }) => (
              <div className="b" key={l}>
                <div className="l">{l}</div>
                <div className="v">{v}</div>
                <div className={`d${warn ? ' warn' : ''}`}>{d}</div>
              </div>
            ))}
          </div>

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
                  { l: 'Total Supplied', v: u(m.totalSupplyUsd), d: `${m.loanSymbol}` },
                  { l: 'Total Borrowed', v: u(m.totalBorrowUsd), d: `${m.loanSymbol}` },
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
                  ['Collateral Price', m.collateralPriceUsd > 0 ? u(m.collateralPriceUsd) : '—', 'var(--ink)'],
                  ['Loan Asset Price', m.loanPriceUsd > 0 ? u(m.loanPriceUsd) : '—', 'var(--ink)'],
                ].map(([lbl, val, color]) => (
                  <div className="risk-cell" key={lbl as string}><div className="k">{lbl}</div><div className="v" style={{ color: color as string }}>{val}</div></div>
                ))}
              </div>

              {/* Links */}
              <div style={{ marginTop: 14, display: 'flex', gap: 16 }}>
                {m.collateralAddress && (
                  <a href={`${scanBase}/${m.collateralAddress}`} target="_blank" rel="noopener noreferrer" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--blue-ink)', textDecoration: 'underline', textUnderlineOffset: 3 }}>
                    {m.collateralSymbol} ↗
                  </a>
                )}
                {m.loanAddress && (
                  <a href={`${scanBase}/${m.loanAddress}`} target="_blank" rel="noopener noreferrer" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--blue-ink)', textDecoration: 'underline', textUnderlineOffset: 3 }}>
                    {m.loanSymbol} ↗
                  </a>
                )}
                <a href={`${morphoBase}${m.marketId}`} target="_blank" rel="noopener noreferrer" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--blue-ink)', textDecoration: 'underline', textUnderlineOffset: 3 }}>
                  Morpho App ↗
                </a>
              </div>
            </div>
          )}

          {/* Search */}
          <div style={{ marginTop: m ? 20 : 20, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
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
          <div className="panel" style={{ marginTop: 8 }}>
            <div className="ph">
              <span className="t">All Markets — {chainName}</span>
              {chainIcon && <Image src={chainIcon} alt={chainName} width={16} height={16} style={{ borderRadius: '50%' }} unoptimized />}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="tab">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', paddingLeft: 22 }}>Market (Collateral / Loan)</th>
                    <th>LLTV</th>
                    <th>Supplied</th>
                    <th>Borrowed</th>
                    <th>Util.</th>
                    <th>Supply APY</th>
                    <th>Borrow APY</th>
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
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: '24px', fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink-mute)' }}>
                        No markets match &ldquo;{filter}&rdquo;
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <p style={{ marginTop: 24, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', letterSpacing: '0.04em' }}>
            Data from Morpho Blue GraphQL API · {fetchedAt ? `Fetched ${new Date(fetchedAt).toLocaleTimeString()}` : 'Live'} · LLTV = Liquidation LTV
          </p>
        </>
      )}
    </div>
  )
}
