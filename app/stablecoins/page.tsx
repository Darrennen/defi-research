import { getStablecoins, formatUsd } from '@/lib/defillama'
import { CoinLogo } from '@/components/CoinLogo'

function pegDev(price: number) { return Math.abs(price - 1) * 100 }

function PegBadge({ price }: { price: number }) {
  const d = pegDev(price)
  if (d < 0.1)  return <span className="badge-stable">Stable</span>
  if (d < 1)    return <span className="badge-warn">Warning</span>
  return              <span className="badge-risk">Depegged</span>
}

function MechBadge({ mech }: { mech: string }) {
  const label = mech?.replace(/-/g, ' ') ?? '—'
  const styles: Record<string, { color: string; background: string }> = {
    'fiat backed':   { color: 'var(--blue)',  background: 'var(--blue-soft)' },
    'crypto backed': { color: '#6040c8',      background: 'rgba(96,64,200,0.08)' },
    algorithmic:     { color: 'var(--amber)', background: 'rgba(178,116,13,0.10)' },
  }
  const s = styles[label] ?? { color: 'var(--ink-mute)', background: 'var(--rule-soft)' }
  return <span className="badge-mech" style={s}>{label}</span>
}

export default async function StablecoinsPage() {
  const all = await getStablecoins()

  const stables = all
    .filter(s => s.pegType === 'peggedUSD' && s.price != null && s.price > 0 && (s.circulating?.peggedUSD ?? 0) > 1_000_000)
    .sort((a, b) => (b.circulating?.peggedUSD ?? 0) - (a.circulating?.peggedUSD ?? 0))
    .slice(0, 40)

  const totalMcap = stables.reduce((s, x) => s + (x.circulating?.peggedUSD ?? 0), 0)
  const avgDev = stables.reduce((s, x) => s + pegDev(x.price), 0) / stables.length
  const offPeg = stables.filter(x => pegDev(x.price) >= 0.1).length

  return (
    <div>
      <div className="page-header">
        <div className="kicker">Stablecoins &amp; Risk</div>
        <h1>Peg Stability <em>Monitor</em></h1>
        <p className="dek">Real-time peg tracking for USD-pegged stablecoins. Flags assets deviating more than 0.1% from par.</p>
      </div>

      <div className="metrics-row">
        <div className="metric-cell">
          <div className="lbl">Total Market Cap</div>
          <div className="val">{formatUsd(totalMcap)}</div>
        </div>
        <div className="metric-cell">
          <div className="lbl">Avg Peg Deviation</div>
          <div className="val">{avgDev.toFixed(3)}%</div>
        </div>
        <div className="metric-cell">
          <div className="lbl">Off-Peg (&gt;0.1%)</div>
          <div className={`val ${offPeg > 0 ? 'warn' : ''}`}>{offPeg}</div>
        </div>
      </div>

      <div style={{ marginTop: 40, overflowX: 'auto' }}>
        <table className="tab">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>#</th>
              <th style={{ textAlign: 'left' }}>Asset</th>
              <th style={{ textAlign: 'left' }}>Mechanism</th>
              <th>Market Cap</th>
              <th>Price</th>
              <th>Deviation</th>
              <th>Status</th>
              <th>Chains</th>
            </tr>
          </thead>
          <tbody>
            {stables.map((s, i) => {
              const dev = pegDev(s.price)
              const devColor = dev >= 1 ? 'var(--red)' : dev >= 0.1 ? 'var(--amber)' : 'var(--green)'
              return (
                <tr key={s.id}>
                  <td>{i + 1}</td>
                  <td className="name">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {s.gecko_id && <CoinLogo geckoId={s.gecko_id} symbol={s.symbol} />}
                      {s.symbol}
                    </span>
                    <span className="sym">{s.name}</span>
                  </td>
                  <td><MechBadge mech={s.pegMechanism} /></td>
                  <td>{formatUsd(s.circulating?.peggedUSD ?? 0)}</td>
                  <td>${s.price?.toFixed(5)}</td>
                  <td style={{ color: devColor, fontWeight: 600 }}>{dev.toFixed(3)}%</td>
                  <td><PegBadge price={s.price} /></td>
                  <td>{s.chains?.length ?? 0}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p style={{ marginTop: 32, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', letterSpacing: '0.04em' }}>
        Source: DeFiLlama Stablecoins API · Refreshes every 5 min
      </p>
    </div>
  )
}
