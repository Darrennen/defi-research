'use client'

import { useEffect, useState, useCallback } from 'react'
import Image from 'next/image'

interface Reserve {
  symbol: string; assetAddress: string; aTokenAddress: string; vDebtAddress: string
  supplyApy: number; borrowApy: number; utilization: number
  totalSupplied: number; totalBorrowed: number; totalSuppliedUsd: number; totalBorrowedUsd: number
  ltv: number; liquidationThreshold: number; liquidationBonus: number
  decimals: number; reserveFactor: number; supplyCap: number; borrowCap: number
  supplyCapUsd: number | null; borrowCapUsd: number | null; price: number
}

const u = (n: number) => n >= 1e9 ? `$${(n/1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n/1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n/1e3).toFixed(1)}K` : `$${n.toFixed(2)}`
const p = (n: number, d = 2) => `${n.toFixed(d)}%`
const cn = (n: number, s: string) => n >= 1e6 ? `${(n/1e6).toFixed(2)}M ${s}` : n >= 1e3 ? `${(n/1e3).toFixed(1)}K ${s}` : `${n.toFixed(2)} ${s}`

export default function HyperLendPage() {
  const [reserves, setReserves] = useState<Reserve[]>([])
  const [selected, setSelected] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cfgOpen, setCfgOpen] = useState(false)
  const [fetchedAt, setFetchedAt] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/hyperlend')
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setReserves(data.reserves); setFetchedAt(data.fetchedAt); setSelected(0); setCfgOpen(false)
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const r = reserves[selected]
  const totalSupplied = reserves.reduce((s, x) => s + x.totalSuppliedUsd, 0)
  const totalBorrowed = reserves.reduce((s, x) => s + x.totalBorrowedUsd, 0)
  const avgUtil = reserves.length ? reserves.reduce((s, x) => s + x.utilization, 0) / reserves.length : 0

  return (
    <div>
      {/* Page header */}
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Image src="https://icons.llamao.fi/icons/protocols/hyperlend.jpg" alt="HyperLend" width={20} height={20} style={{ borderRadius: 3 }} unoptimized />
            <div className="kicker" style={{ margin: 0 }}>HyperLend · Reserve Risk Exposures</div>
          </div>
          <h1>On-Chain <em>Lending Risk</em></h1>
          <p className="dek">Per-asset reserve-level risk view across HyperLend Core Pool on HyperEVM.</p>
        </div>
        <button onClick={load} disabled={loading} className="btn ghost" style={{ flexShrink: 0, marginTop: 8, padding: '8px 16px', fontSize: 11 }}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <div style={{ marginTop: 16, padding: '12px 16px', background: 'rgba(192,57,43,0.08)', color: 'var(--red)', fontFamily: 'var(--sans)', fontSize: 13, border: '1px solid rgba(192,57,43,0.2)' }}>Failed to load: {error}</div>}

      {loading && !reserves.length && (
        <div style={{ marginTop: 24 }}>
          <div className="ch-row">{[...Array(5)].map((_, i) => <div key={i} className="skel" style={{ height: 32, width: 110, flexShrink: 0 }} />)}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginTop: 24 }}>
            {[...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 88 }} />)}
          </div>
        </div>
      )}

      {!loading && reserves.length > 0 && (
        <>
          {/* Protocol KPIs */}
          <div className="kpi kpi-3col" style={{ marginTop: 24 }}>
            {[
              { l: 'Total Supplied', v: u(totalSupplied), d: 'HyperEVM Core Pool' },
              { l: 'Total Borrowed', v: u(totalBorrowed), d: `${reserves.length} active markets` },
              { l: 'Avg. Utilization', v: p(avgUtil), d: 'across all reserves', warn: avgUtil > 80 },
            ].map(({ l, v, d, warn }) => (
              <div className="b" key={l}>
                <div className="l">{l}</div>
                <div className="v">{v}</div>
                <div className={`d${warn ? ' warn' : ''}`}>{d}</div>
              </div>
            ))}
          </div>

          {/* Asset tabs */}
          <div className="ch-row" style={{ marginTop: 20 }}>
            {reserves.map((res, i) => (
              <button key={res.symbol} onClick={() => { setSelected(i); setCfgOpen(false) }} className={`ch ${i === selected ? 'on' : ''}`}>
                {res.symbol.split('-')[0]}
                <span style={{ marginLeft: 6, fontFamily: 'var(--mono)', fontSize: 10, opacity: 0.7 }}>{u(res.totalSuppliedUsd)}</span>
              </button>
            ))}
          </div>

          {r && (
            <>
              <p style={{ fontFamily: 'var(--sans)', fontSize: 11, color: 'var(--ink-mute)', margin: '16px 0 16px' }}>
                <strong style={{ color: 'var(--ink)' }}>{r.symbol}</strong> on HyperLend · HyperEVM Core Pool
              </p>

              {/* Reserve KPIs */}
              <div className="kpi">
                {[
                  { l: 'Total Supplied', v: u(r.totalSuppliedUsd), d: cn(r.totalSupplied, r.symbol.split('-')[0]) },
                  { l: 'Total Borrowed', v: u(r.totalBorrowedUsd), d: cn(r.totalBorrowed, r.symbol.split('-')[0]) },
                  { l: 'Utilization', v: p(r.utilization), warn: r.utilization > 80 },
                  { l: 'Supply / Borrow APY', v: `${p(r.supplyApy)} / ${p(r.borrowApy)}`, blue: true },
                ].map(({ l, v, d, warn, blue }) => (
                  <div className="b" key={l}>
                    <div className="l">{l}</div>
                    <div className="v" style={{ color: warn ? 'var(--amber)' : blue ? 'var(--blue)' : undefined }}>{v}</div>
                    {d && <div className="d">{d}</div>}
                  </div>
                ))}
              </div>

              {/* Cap bars */}
              {(r.supplyCap > 0 || r.borrowCap > 0) && (
                <div className="panel" style={{ marginTop: 16, padding: '4px 20px' }}>
                  {r.supplyCap > 0 && (() => {
                    const pct = r.supplyCap > 0 ? Math.min((r.totalSupplied / r.supplyCap) * 100, 100) : 0
                    return (
                      <div className="cap-row">
                        <div className="lbl">Supply Cap</div>
                        <div className="cap-track"><div className={`cap-fill ${pct > 95 ? 'hot' : pct > 80 ? 'warn' : ''}`} style={{ width: `${pct}%` }} /></div>
                        <span className="cap-val">{r.supplyCapUsd ? u(r.supplyCapUsd) : cn(r.supplyCap, r.symbol.split('-')[0])}</span>
                        <span className="cap-pct">{pct.toFixed(0)}% used</span>
                      </div>
                    )
                  })()}
                  {r.borrowCap > 0 && (() => {
                    const pct = r.borrowCap > 0 ? Math.min((r.totalBorrowed / r.borrowCap) * 100, 100) : 0
                    return (
                      <div className="cap-row">
                        <div className="lbl">Borrow Cap</div>
                        <div className="cap-track"><div className={`cap-fill ${pct > 95 ? 'hot' : pct > 80 ? 'warn' : ''}`} style={{ width: `${pct}%` }} /></div>
                        <span className="cap-val">{r.borrowCapUsd ? u(r.borrowCapUsd) : cn(r.borrowCap, r.symbol.split('-')[0])}</span>
                        <span className="cap-pct">{pct.toFixed(0)}% used</span>
                      </div>
                    )
                  })()}
                </div>
              )}

              {/* Reserve config */}
              <div className="cfg-panel" style={{ marginTop: 16 }}>
                <button className="cfg-toggle" onClick={() => setCfgOpen(v => !v)}>
                  Reserve Config
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>{cfgOpen ? '▲' : '▶'}</span>
                </button>
                {cfgOpen && (
                  <div className="cfg-body">
                    <div className="cfg-grid">
                      {[['LTV', p(r.ltv)], ['Liq. Threshold', p(r.liquidationThreshold)], ['Liq. Bonus', p(r.liquidationBonus - 100)], ['Reserve Factor', p(r.reserveFactor)], ['Decimals', String(r.decimals)], ['Supply Cap', r.supplyCap > 0 ? cn(r.supplyCap, r.symbol) : '∞'], ['Borrow Cap', r.borrowCap > 0 ? cn(r.borrowCap, r.symbol) : '∞']].map(([k, v]) => (
                        <div className="cfg-item" key={k}><div className="k">{k}</div><div className="v">{v}</div></div>
                      ))}
                    </div>
                    <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--rule-soft)', display: 'flex', gap: 16 }}>
                      {[['Asset', r.assetAddress], ['aToken', r.aTokenAddress], ['vDebt', r.vDebtAddress]].map(([lbl, addr]) => (
                        <a key={lbl} href={`https://hyperevmscan.io/address/${addr}`} target="_blank" rel="noopener noreferrer" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--blue-ink)', textDecoration: 'underline', textUnderlineOffset: 3 }}>{lbl} ↗</a>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Risk params */}
              <div className="risk-grid" style={{ marginTop: 16 }}>
                {[['Max LTV', p(r.ltv), 'var(--ink)'], ['Liq. Threshold', p(r.liquidationThreshold), 'var(--amber)'], ['Liq. Bonus', `+${p(r.liquidationBonus - 100)}`, 'var(--red)']].map(([lbl, val, color]) => (
                  <div className="risk-cell" key={lbl as string}><div className="k">{lbl}</div><div className="v" style={{ color: color as string }}>{val}</div></div>
                ))}
              </div>

              {/* All reserves table */}
              <div className="panel" style={{ marginTop: 20 }}>
                <div className="ph">
                  <span className="t">All Reserves — HyperEVM</span>
                  <Image src="https://icons.llamao.fi/icons/chains/rsz_hyperliquid.jpg" alt="HyperEVM" width={16} height={16} style={{ borderRadius: '50%' }} unoptimized />
                </div>
                <div className="table-scroll-x">
                  <table className="tab">
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', paddingLeft: 22 }}>Asset</th>
                        <th>Supplied</th><th>Borrowed</th><th>Util.</th><th>Supply APY</th><th>Borrow APY</th><th>LTV</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reserves.map((res, i) => (
                        <tr key={res.symbol} onClick={() => { setSelected(i); setCfgOpen(false); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                          style={{ cursor: 'pointer', background: i === selected ? 'var(--blue-soft)' : undefined }}>
                          <td className="name" style={{ paddingLeft: 22 }}>{res.symbol.split('-')[0]}</td>
                          <td>{u(res.totalSuppliedUsd)}</td>
                          <td>{u(res.totalBorrowedUsd)}</td>
                          <td style={{ color: res.utilization > 80 ? 'var(--amber)' : undefined, fontWeight: res.utilization > 80 ? 600 : undefined }}>{p(res.utilization)}</td>
                          <td className="pos">{p(res.supplyApy)}</td>
                          <td style={{ color: 'var(--amber)', fontWeight: 600 }}>{p(res.borrowApy)}</td>
                          <td className="neg">{p(res.ltv)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <p style={{ marginTop: 24, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', letterSpacing: '0.04em' }}>
                Data from HyperEVM RPC · hToken + variableDebtToken multicall · {fetchedAt ? `Fetched ${new Date(fetchedAt).toLocaleTimeString()}` : 'Live'} · LT = Liquidation Threshold
              </p>
            </>
          )}
        </>
      )}
    </div>
  )
}
