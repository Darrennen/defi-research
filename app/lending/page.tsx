import Link from 'next/link'

const LENDING_SLUGS = new Set(['aave-v3','aave-v2','spark','compound-v3','compound-finance-v3','morpho-blue','morpho','euler','euler-v2','silo-finance','silo-v2','radiant-v2','benqi','venus','kamino-lend','marginfi','fluid','ironclad-finance','zerolend'])
interface Protocol { name: string; slug: string; tvl: number | null; category: string; chains: string[]; logo?: string }
function fmt(n: number) {
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n/1e6).toFixed(1)}M`
  if (n >= 1e3) return `$${(n/1e3).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

export default async function LendingPage() {
  const res = await fetch('https://api.llama.fi/protocols', { next: { revalidate: 300 } })
  const all: Protocol[] = await res.json()
  const lending = all
    .filter(p => {
      const cat = (p.category ?? '').toLowerCase(), slug = (p.slug ?? '').toLowerCase()
      return cat === 'lending' || LENDING_SLUGS.has(slug) || (cat === 'cdp' && (slug.includes('aave') || slug.includes('compound') || slug.includes('morpho')))
    })
    .filter(p => (p.tvl ?? 0) > 1_000_000)
    .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0))
    .slice(0, 50)
  const totalTvl = lending.reduce((s, p) => s + (p.tvl ?? 0), 0)
  const chainSet = new Set(lending.flatMap(p => p.chains ?? []))

  return (
    <div>
      <div className="page-header">
        <div className="kicker">DeFi Lending Risk</div>
        <h1>Lending Market <em>Monitor</em></h1>
        <p className="dek">
          TVL across major DeFi lending protocols — Aave V3, SparkLend, Morpho, Compound, and more. For per-reserve on-chain risk data, see{' '}
          <Link href="/aave" style={{ color: 'var(--blue-ink)', textDecoration: 'underline', textUnderlineOffset: 3 }}>Aave V3 Risk</Link>
          {' '}and{' '}
          <Link href="/hyperlend" style={{ color: 'var(--blue-ink)', textDecoration: 'underline', textUnderlineOffset: 3 }}>HyperLend</Link>.
        </p>
      </div>

      <div className="metrics-row">
        <div className="metric-cell"><div className="lbl">Total TVL</div><div className="val">{fmt(totalTvl)}</div></div>
        <div className="metric-cell"><div className="lbl">Protocols</div><div className="val">{lending.length}</div></div>
        <div className="metric-cell"><div className="lbl">Chains</div><div className="val">{chainSet.size}</div></div>
      </div>

      <div className="table-scroll-x" style={{ marginTop: 40 }}>
        <table className="tab">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>#</th>
              <th style={{ textAlign: 'left' }}>Protocol</th>
              <th>TVL</th>
              <th style={{ textAlign: 'left' }}>Chains</th>
              <th style={{ textAlign: 'left' }}>Category</th>
            </tr>
          </thead>
          <tbody>
            {lending.map((p, i) => (
              <tr key={p.slug}>
                <td>{i + 1}</td>
                <td className="name">
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {p.logo && <img src={p.logo} alt={p.name} width={16} height={16} style={{ borderRadius: 3 }} />}
                    {p.name}
                  </span>
                </td>
                <td className="pos" style={{ fontWeight: 600 }}>{p.tvl != null ? fmt(p.tvl) : '—'}</td>
                <td style={{ textAlign: 'left' }}>
                  <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {(p.chains ?? []).slice(0, 4).map(c => (
                      <span key={c} style={{ fontFamily: 'var(--sans)', fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-mute)', padding: '1px 5px', border: '1px solid var(--rule)' }}>{c}</span>
                    ))}
                    {(p.chains ?? []).length > 4 && <span style={{ color: 'var(--ink-mute)', fontSize: 11 }}>+{(p.chains ?? []).length - 4}</span>}
                  </span>
                </td>
                <td style={{ textAlign: 'left', color: 'var(--ink-mute)', textTransform: 'capitalize' }}>{p.category}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ marginTop: 32, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', letterSpacing: '0.04em' }}>
        Source: DeFiLlama Protocols API · TVL = total value locked · Refreshes every 5 min
      </p>
    </div>
  )
}
