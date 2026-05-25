'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'

// ── types ──────────────────────────────────────────────────────

type TrackedWallet = { account_id: number; label: string; address?: string; added_at: number }
type FlowWindow = {
  buy_usd: number; sell_usd: number; net_usd: number
  buy_size: number; sell_size: number; net_size: number
  buy_trades: number; sell_trades: number
  buy_avg_price: number | null; sell_avg_price: number | null
}
type WalletData = { '24h': FlowWindow; '7d': FlowWindow; '30d': FlowWindow; _error?: boolean; _error_msg?: string }

const TW_KEY = 'lit_tracked_v1'

// ── formatters ─────────────────────────────────────────────────

const fmtUsd = (n: number | null | undefined): string => {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n), s = n < 0 ? '-' : ''
  if (abs >= 1e6) return s + '$' + (abs / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return s + '$' + (abs / 1e3).toFixed(2) + 'K'
  return s + '$' + abs.toFixed(2)
}
const fmtLit = (n: number | null | undefined): string => {
  if (n == null || isNaN(n)) return '—'
  const abs = Math.abs(n), s = n < 0 ? '-' : ''
  if (abs >= 1e6) return s + (abs / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return s + (abs / 1e3).toFixed(2) + 'K'
  return s + abs.toLocaleString('en-US', { maximumFractionDigits: 2 })
}
const fmtSign = (n: number) => n >= 0 ? '+' : ''

// ── main component ──────────────────────────────────────────────

export default function WatchlistPage() {
  const [wallets, setWallets] = useState<TrackedWallet[]>([])
  const [data, setData] = useState<Record<number, WalletData | null>>({})
  const [period, setPeriod] = useState<'24h' | '7d' | '30d'>('24h')
  const [addInput, setAddInput] = useState('')
  const [addError, setAddError] = useState('')
  const [status, setStatus] = useState('')
  const [litPrice, setLitPrice] = useState<number | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── localStorage helpers ──
  const loadWallets = (): TrackedWallet[] => {
    try { return JSON.parse(localStorage.getItem(TW_KEY) || '[]') } catch { return [] }
  }
  const saveWallets = (list: TrackedWallet[]) => {
    try { localStorage.setItem(TW_KEY, JSON.stringify(list)) } catch {}
  }

  useEffect(() => {
    const list = loadWallets()
    setWallets(list)
    if (list.length) refreshAll(list)
    refreshTimerRef.current = setInterval(() => {
      const current = loadWallets()
      setWallets(current)
      if (current.length) refreshAll(current)
    }, 120_000)
    return () => { if (refreshTimerRef.current) clearInterval(refreshTimerRef.current) }
  }, [])  // eslint-disable-line

  const refreshAll = useCallback(async (list?: TrackedWallet[]) => {
    const wl = list ?? loadWallets()
    if (!wl.length) { setStatus('No tracked wallets.'); return }
    setStatus(`Fetching ${wl.length} account${wl.length !== 1 ? 's' : ''}…`)

    // Fetch LIT price in parallel
    fetch('/api/lighter/lit/summary').then(r => r.json()).then(j => {
      const p = parseFloat(j?.spot?.last_price || j?.perp?.last_price || '0')
      if (p > 0) setLitPrice(p)
    }).catch(() => {})

    // Mark all as loading
    setData(prev => {
      const next = { ...prev }
      wl.forEach(w => { if (!next[w.account_id]) next[w.account_id] = null })
      return next
    })

    await Promise.allSettled(wl.map(async w => {
      const params = new URLSearchParams({ account_id: String(w.account_id) })
      if (w.address) params.set('address', w.address)
      try {
        const r = await fetch(`/api/lighter/lit/account-flow-live?${params}`)
        if (!r.ok) {
          const msg = r.status === 404 ? 'Account not found on exchange.'
            : r.status === 429 ? 'Rate limited — try again shortly.'
            : `API error ${r.status}`
          setData(prev => ({ ...prev, [w.account_id]: { _error: true, _error_msg: msg } as any }))
          return
        }
        const d = await r.json()
        // Cache address if discovered
        if (d._address && !w.address) {
          const updated = loadWallets().map(x => x.account_id === w.account_id ? { ...x, address: d._address } : x)
          saveWallets(updated)
          setWallets(updated)
        }
        setData(prev => ({ ...prev, [w.account_id]: d }))
      } catch {
        setData(prev => ({ ...prev, [w.account_id]: { _error: true, _error_msg: 'Network error.' } as any }))
      }
    }))

    setStatus(`Updated ${new Date().toLocaleTimeString('en-GB', { hour12: false })} · ${wl.length} accounts`)
  }, [])

  const addWallet = () => {
    const raw = addInput.trim()
    const id = parseInt(raw, 10)
    if (!raw || isNaN(id) || id < 1) { setAddError('Enter a valid account number'); setTimeout(() => setAddError(''), 2000); return }
    const list = loadWallets()
    if (list.find(w => w.account_id === id)) { setAddError('Already tracked'); setTimeout(() => setAddError(''), 2000); return }
    const next = [...list, { account_id: id, label: '', added_at: Date.now() }]
    saveWallets(next); setWallets(next); setAddInput('')
    // Fetch data for new wallet
    const params = new URLSearchParams({ account_id: String(id) })
    fetch(`/api/lighter/lit/account-flow-live?${params}`).then(r => r.json()).then(d => {
      if (d._address) {
        const updated = loadWallets().map(x => x.account_id === id ? { ...x, address: d._address } : x)
        saveWallets(updated); setWallets(updated)
      }
      setData(prev => ({ ...prev, [id]: d }))
    }).catch(() => {
      setData(prev => ({ ...prev, [id]: { _error: true, _error_msg: 'Network error.' } as any }))
    })
  }

  const removeWallet = (id: number) => {
    const next = loadWallets().filter(w => w.account_id !== id)
    saveWallets(next); setWallets(next)
    setData(prev => { const n = { ...prev }; delete n[id]; return n })
  }

  const setLabel = (id: number, label: string) => {
    const next = loadWallets().map(w => w.account_id === id ? { ...w, label } : w)
    saveWallets(next); setWallets(next)
  }

  // ── aggregate stats ──
  const periodData = (w: TrackedWallet) => (data[w.account_id] as WalletData)?.[period]
  let aggBuy = 0, aggSell = 0, aggNetLit = 0, loadedCount = 0
  wallets.forEach(w => {
    const d = periodData(w)
    if (d && d.buy_usd != null) { aggBuy += d.buy_usd ?? 0; aggSell += d.sell_usd ?? 0; aggNetLit += d.net_size ?? 0; loadedCount++ }
  })
  const aggNet = aggBuy - aggSell

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      {/* header */}
      <div className="page-header" style={{ marginBottom: 24 }}>
        <div className="kicker">Lighter DEX · LIT Token</div>
        <h1 style={{ fontSize: 28, fontWeight: 700, margin: '4px 0 6px' }}>Watchlist</h1>
        <p style={{ color: 'var(--ink-dim)', fontSize: 13, margin: 0 }}>
          Track LIT buy/sell flow for any set of accounts across 24h, 7d, and 30d windows.
        </p>
      </div>

      {/* sub-nav */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap', alignItems: 'center' }}>
        <Link href="/lighter" className="ch" style={{ padding: '6px 14px' }}>Overview</Link>
        <Link href="/lighter/lit" className="ch" style={{ padding: '6px 14px' }}>LIT Tracker</Link>
        <Link href="/lighter/explorer" className="ch" style={{ padding: '6px 14px' }}>Explorer</Link>
        <span className="ch on" style={{ padding: '6px 14px' }}>Watchlist</span>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--ink-faint)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Period</span>
          {(['24h', '7d', '30d'] as const).map(p => (
            <button key={p} className={`ch${period === p ? ' on' : ''}`}
              onClick={() => setPeriod(p)} style={{ padding: '4px 12px', fontSize: 12 }}>{p}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input value={addInput} onChange={e => setAddInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addWallet() }}
            placeholder="Account #"
            style={{ background: 'var(--bg)', border: `1px solid ${addError ? 'var(--red)' : 'var(--line)'}`, color: 'var(--ink)', padding: '5px 10px', fontSize: 12, borderRadius: 4, width: 110, outline: 'none', fontFamily: 'var(--font-mono)' }} />
          <button onClick={addWallet} className="ch on" style={{ padding: '5px 14px', fontSize: 12 }}>+ Add</button>
          {wallets.length > 0 && (
            <button onClick={() => refreshAll()} className="ch" style={{ padding: '5px 14px', fontSize: 12 }}>↺ Refresh</button>
          )}
        </div>
      </div>

      {addError && (
        <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--red)' }}>{addError}</div>
      )}

      {/* aggregate bar */}
      {wallets.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 1, background: 'var(--line)', border: '1px solid var(--line)', marginBottom: 1 }}>
          {[
            { lbl: 'Accounts', val: wallets.length.toString(), cls: '' },
            { lbl: 'Total Buy', val: loadedCount ? fmtUsd(aggBuy) : '…', cls: 'pos' },
            { lbl: 'Total Sell', val: loadedCount ? fmtUsd(aggSell) : '…', cls: 'neg' },
            { lbl: 'Net Flow', val: loadedCount ? fmtSign(aggNet) + fmtUsd(aggNet) : '…', cls: aggNet >= 0 ? 'pos' : 'neg' },
            { lbl: 'Net LIT', val: loadedCount ? fmtSign(aggNetLit) + fmtLit(aggNetLit) + ' LIT' : '…', cls: aggNetLit >= 0 ? 'pos' : 'neg' },
            { lbl: 'Last Refresh', val: status.startsWith('Updated') ? status.replace('Updated ', '') : status || '—', cls: '' },
          ].map(k => (
            <div key={k.lbl} style={{ background: 'var(--paper)', padding: '14px 18px' }}>
              <div style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-faint)', marginBottom: 4 }}>{k.lbl}</div>
              <div className={k.cls} style={{ fontSize: 18, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{k.val}</div>
            </div>
          ))}
        </div>
      )}

      {/* empty state */}
      {!wallets.length && (
        <div style={{ textAlign: 'center', padding: '80px 20px', background: 'var(--paper)', color: 'var(--ink-faint)', fontSize: 13 }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>☆</div>
          <div style={{ marginBottom: 8 }}>No tracked wallets yet.</div>
          <div style={{ fontSize: 11 }}>Type an account number above and press Enter, or use the <strong>Track</strong> button on the Explorer page.</div>
        </div>
      )}

      {/* cards grid */}
      {wallets.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 1, background: 'var(--line)', border: '1px solid var(--line)' }}>
          {wallets.map(w => {
            const raw = data[w.account_id]
            const isLoading = raw === undefined || raw === null
            const hasError = (raw as any)?._error
            const errMsg = (raw as any)?._error_msg
            const d = isLoading || hasError ? null : (raw as WalletData)?.[period]
            const noData = d && (d.buy_usd ?? 0) === 0 && (d.sell_usd ?? 0) === 0
            const buy = d?.buy_usd ?? 0; const sell = d?.sell_usd ?? 0
            const net = d?.net_usd ?? 0; const nSize = d?.net_size ?? 0
            const bSize = d?.buy_size ?? 0; const sSize = d?.sell_size ?? 0
            const buyAvg = d?.buy_avg_price; const selAvg = d?.sell_avg_price
            const buyT = d?.buy_trades ?? 0; const sellT = d?.sell_trades ?? 0
            const total = buy + sell || 1; const buyPct = (buy / total * 100)
            const netCls = net >= 0 ? 'var(--green)' : 'var(--red)'
            const litCls = nSize >= 0 ? 'var(--green)' : 'var(--red)'

            let pnlPct: number | null = null, pnlUsd: number | null = null
            if (!isLoading && !hasError && !noData && buyAvg && buyAvg > 0 && litPrice && bSize > 0) {
              pnlPct = (litPrice - buyAvg) / buyAvg * 100
              pnlUsd = bSize * (litPrice - buyAvg)
            }

            return (
              <div key={w.account_id} style={{ background: 'var(--paper)', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* card header */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 18, fontWeight: 700 }}>
                      <Link href={`/lighter/explorer?q=${w.account_id}`} target="_blank"
                        style={{ color: 'var(--ink)', textDecoration: 'none' }}>#{w.account_id}</Link>
                    </div>
                    <div
                      style={{ fontSize: 11, color: w.label ? 'var(--ink-dim)' : 'var(--ink-faint)', fontStyle: w.label ? 'normal' : 'italic', cursor: 'pointer', marginTop: 2 }}
                      contentEditable suppressContentEditableWarning
                      onBlur={e => setLabel(w.account_id, e.currentTarget.textContent?.trim() ?? '')}>
                      {w.label || 'click to label'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                    <Link href={`/lighter/explorer?q=${w.account_id}`} target="_blank"
                      style={{ color: 'var(--blue)', fontSize: 10, textDecoration: 'none', letterSpacing: '0.06em' }}>open ↗</Link>
                    <button onClick={() => removeWallet(w.account_id)}
                      style={{ background: 'none', border: 'none', color: 'var(--ink-faint)', cursor: 'pointer', fontSize: 20, padding: '0 2px', lineHeight: 1 }} title="Remove">×</button>
                  </div>
                </div>

                {/* card body */}
                {isLoading ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {[['70%', 22], ['50%', 12], ['40%', 12]].map(([w, h], i) => (
                      <div key={i} style={{ width: w, height: h, background: 'var(--line)', borderRadius: 2, opacity: 0.6 }} />
                    ))}
                  </div>
                ) : hasError ? (
                  <div style={{ color: 'var(--ink-faint)', fontSize: 11, padding: '8px 0' }}>{errMsg || 'No data available.'}</div>
                ) : noData ? (
                  <div style={{ color: 'var(--ink-faint)', fontSize: 11, padding: '8px 0' }}>No LIT trades found in this window.</div>
                ) : (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <div>
                        <div style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--green)', marginBottom: 4 }}>Buy</div>
                        <div className="pos" style={{ fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtUsd(buy)}</div>
                        {bSize > 0 && <div style={{ fontSize: 11, color: 'var(--green)', opacity: 0.75, marginTop: 1, fontVariantNumeric: 'tabular-nums' }}>{fmtLit(bSize)} LIT</div>}
                        <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 2 }}>{buyT} trade{buyT !== 1 ? 's' : ''}</div>
                        {buyAvg != null && <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>avg ${Number(buyAvg).toFixed(4)}</div>}
                      </div>
                      <div>
                        <div style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--red)', marginBottom: 4 }}>Sell</div>
                        <div className="neg" style={{ fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtUsd(sell)}</div>
                        {sSize > 0 && <div style={{ fontSize: 11, color: 'var(--red)', opacity: 0.75, marginTop: 1, fontVariantNumeric: 'tabular-nums' }}>{fmtLit(sSize)} LIT</div>}
                        <div style={{ fontSize: 10, color: 'var(--ink-faint)', marginTop: 2 }}>{sellT} trade{sellT !== 1 ? 's' : ''}</div>
                        {selAvg != null && <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>avg ${Number(selAvg).toFixed(4)}</div>}
                      </div>
                    </div>
                    <div>
                      <div style={{ height: 4, background: 'var(--line)', borderRadius: 2, overflow: 'hidden', margin: '4px 0' }}>
                        <div style={{ height: '100%', width: buyPct.toFixed(1) + '%', background: 'var(--green)', borderRadius: 2 }} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ink-faint)' }}>
                        <span>{buyPct.toFixed(1)}% buy</span>
                        <span>{(100 - buyPct).toFixed(1)}% sell</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, borderTop: '1px solid var(--line)' }}>
                      <div style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-faint)' }}>Net {period}</div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 17, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: netCls }}>{fmtSign(net)}{fmtUsd(net)}</div>
                        {nSize != null && <div style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums', opacity: 0.8, color: litCls }}>{fmtSign(nSize)}{fmtLit(nSize)} LIT</div>}
                      </div>
                    </div>
                    {pnlPct != null && pnlUsd != null && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
                        <div style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-faint)' }}>Unrealized PnL</div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: pnlPct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                            {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                          </div>
                          <div style={{ fontSize: 10, opacity: 0.8, color: pnlPct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                            {pnlUsd >= 0 ? '+' : ''}{fmtUsd(pnlUsd)} on {fmtLit(bSize)} LIT
                          </div>
                          <div style={{ fontSize: 9, color: 'var(--ink-faint)', marginTop: 1 }}>
                            avg ${buyAvg!.toFixed(4)} → now ${litPrice!.toFixed(4)}
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

      {status && wallets.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 12 }}>{status}</div>
      )}
      <div style={{ height: 40 }} />
    </div>
  )
}
