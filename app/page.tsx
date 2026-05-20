import Link from 'next/link'
import { getStablecoins, formatUsd } from '@/lib/defillama'

async function getIndicesData() {
  try {
    const [stablesRes, protosRes] = await Promise.all([
      fetch('https://stablecoins.llama.fi/stablecoins?includePrices=true', { next: { revalidate: 300 } }),
      fetch('https://api.llama.fi/protocols', { next: { revalidate: 300 } }),
    ])
    const stablesData = await stablesRes.json()
    const protos: Array<{ name: string; slug: string; tvl: number | null; category: string }> = await protosRes.json()

    const totalStables = (stablesData.peggedAssets ?? [])
      .filter((s: { pegType: string; circulating?: { peggedUSD?: number } }) => s.pegType === 'peggedUSD')
      .reduce((sum: number, s: { circulating?: { peggedUSD?: number } }) => sum + (s.circulating?.peggedUSD ?? 0), 0)

    const aave = protos.find(p => p.slug === 'aave-v3')
    const morpho = protos.find(p => p.slug === 'morpho-blue' || p.slug === 'morpho')
    const rwaProtos = protos.filter(p => (p.category ?? '').toLowerCase() === 'rwa')
    const totalRwa = rwaProtos.reduce((s, p) => s + (p.tvl ?? 0), 0)
    const lendingTvl = protos
      .filter(p => ['lending', 'money-market'].includes((p.category ?? '').toLowerCase()))
      .reduce((s, p) => s + (p.tvl ?? 0), 0)

    return {
      stables: totalStables,
      lending: lendingTvl,
      rwa: totalRwa,
      aave: aave?.tvl ?? null,
      morpho: morpho?.tvl ?? null,
    }
  } catch {
    return { stables: null, lending: null, rwa: null, aave: null, morpho: null }
  }
}

function fmt(n: number | null) {
  if (n == null) return '—'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`
  return `$${n.toFixed(0)}`
}

const dashboards = [
  {
    href: '/stablecoins',
    category: 'Stablecoins & Risk',
    num: '01',
    title: 'Peg Stability Monitor',
    desc: 'Real-time peg tracking for USD-pegged stablecoins. Flags assets deviating more than 0.1% from par.',
    chips: ['Peg Monitor', 'Market Cap', 'Depeg Risk'],
    status: 'live' as const,
  },
  {
    href: '/treasuries',
    category: 'Tokenized RWA',
    num: '02',
    title: 'Tokenized Treasuries',
    desc: 'TVL across tokenized T-bill, treasury, and RWA protocols — BUIDL, USTB, OUSG, and others.',
    chips: ['TVL', 'Yield', 'RWA'],
    status: 'live' as const,
  },
  {
    href: '/lending',
    category: 'DeFi Lending',
    num: '03',
    title: 'Lending Market Monitor',
    desc: 'TVL across major DeFi lending protocols — Aave V3, SparkLend, Morpho, Compound, and more.',
    chips: ['Aave V3', 'SparkLend', 'Morpho'],
    status: 'live' as const,
  },
  {
    href: '/aave',
    category: 'Protocol Risk',
    num: '04',
    title: 'Aave V3 On-Chain Risk',
    desc: 'Per-reserve risk view across Ethereum, Arbitrum, Base, Polygon, Optimism, and Avalanche.',
    chips: ['Multi-chain', 'Live RPC', 'Risk Params'],
    status: 'live' as const,
  },
  {
    href: '/morpho',
    category: 'Protocol Risk',
    num: '05',
    title: 'Morpho Blue Markets',
    desc: 'Per-market risk view for Morpho Blue — supply, borrow, utilization, LLTV, and APYs across Ethereum and Base.',
    chips: ['Morpho Blue', 'Multi-chain', 'LLTV Risk'],
    status: 'live' as const,
  },
  {
    href: '/hyperlend',
    category: 'Protocol Risk',
    num: '06',
    title: 'HyperLend Exposures',
    desc: 'Reserve-level risk view for HyperLend Core Pool on HyperEVM — live on-chain data.',
    chips: ['HyperEVM', 'Live RPC', 'Risk Params'],
    status: 'live' as const,
  },
  {
    href: '/yield-tracker',
    category: 'Yield Research',
    num: '07',
    title: 'Yield Tracker',
    desc: 'Compare PT fixed-yield loops, Morpho lending markets, and Aave rates across strategies.',
    chips: ['Pendle PT', 'Morpho', 'Aave Rates'],
    status: 'live' as const,
  },
]

const methods = [
  { n: '01', title: 'Public data only', desc: 'Every metric derives from public on-chain state or open APIs. No proprietary feeds, no black boxes.' },
  { n: '02', title: 'Evidence first', desc: 'Claims are backed by verifiable data. Methodology is shown, not hidden behind a paywall.' },
  { n: '03', title: 'Risk-focused', desc: 'We track what can go wrong — depeg risk, utilisation, cap proximity — not just headline TVL.' },
  { n: '04', title: 'Always live', desc: 'Dashboards refresh every five minutes from live RPC calls and DeFiLlama\'s public endpoints.' },
]

export default async function Home() {
  const idx = await getIndicesData()

  const indices = [
    { name: 'Total Stables', val: fmt(idx.stables), chg: 'USD-pegged' },
    { name: 'Lending TVL',   val: fmt(idx.lending),  chg: 'DeFi markets' },
    { name: 'Tokenized RWA', val: fmt(idx.rwa),       chg: 'On-chain' },
    { name: 'Aave V3 TVL',   val: fmt(idx.aave),      chg: 'Multi-chain' },
    { name: 'Morpho TVL',    val: fmt(idx.morpho),    chg: 'Blue + vaults' },
  ]

  return (
    <>
      {/* Hero */}
      <section className="hero" style={{ borderBottom: '3px solid var(--ink)', padding: '56px 0 64px', margin: 0 }}>
        <div className="kicker">
          Independent Research
          <span className="div" />
        </div>
        <h1>
          Evidence-led analysis on{' '}
          <em>digital asset markets</em>
        </h1>
        <p className="dek">
          Data-driven research on tokenized real-world assets, stablecoin risk, and DeFi lending
          markets — powered entirely by public on-chain data.
        </p>
        <div className="actions">
          <a className="btn primary" href="#dashboards">
            View Dashboards <span className="arr">→</span>
          </a>
          <a className="btn ghost" href="#method">
            Our Method
          </a>
        </div>
      </section>

      {/* Indices strip */}
      <div className="indices">
        {indices.map((ix) => (
          <div className="idx" key={ix.name}>
            <div className="name">{ix.name}</div>
            <div className="val">{ix.val}</div>
            <div className="chg">{ix.chg}</div>
          </div>
        ))}
      </div>

      {/* Dashboards section */}
      <section id="dashboards" style={{ padding: '64px 0', borderBottom: '1px solid var(--rule)' }}>
        <div className="section-head">
          <h2><em>Research</em> Dashboards</h2>
          <div className="vol">{dashboards.length} live</div>
        </div>

        <div className="dash-grid">
          {dashboards.map((d) => (
            <Link key={d.href} href={d.href} className="dash">
              <div className="top">
                <span>{d.category}</span>
                <span className="live">
                  <span className="live-dot" />
                  Live
                </span>
              </div>
              <div className="num-tag">{d.num}</div>
              <h3>{d.title}</h3>
              <p>{d.desc}</p>
              <div className="chips">
                {d.chips.map((c) => (
                  <span key={c} className="chip">{c}</span>
                ))}
              </div>
              <div className="open">
                Open Dashboard <span className="arr">→</span>
              </div>
            </Link>
          ))}
        </div>

        {/* Coming soon */}
        <div className="soon">
          <div>
            <div className="badge">Coming soon</div>
            <h3>Cross-chain Monitoring</h3>
            <p>Bridge exposure monitoring, cross-chain TVL flows, and risk analysis across major L1s and L2s.</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
              {['Bridges', 'TVL Flows', 'L2s'].map(c => (
                <span key={c} className="chip">{c}</span>
              ))}
            </div>
          </div>
          <div className="viz" />
        </div>
      </section>

      {/* Method section */}
      <section id="method" style={{ padding: '64px 0', borderBottom: '1px solid var(--rule)' }}>
        <div className="section-head">
          <h2>How we <em>work</em></h2>
          <div className="vol">Evidence-led</div>
        </div>
        <div className="method">
          {methods.map((m) => (
            <div key={m.n} className="meth">
              <div className="n">{m.n}</div>
              <h4>{m.title}</h4>
              <p>{m.desc}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
