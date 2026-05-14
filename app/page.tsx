import Link from 'next/link'

const sections = [
  {
    href: '/stablecoins',
    title: 'Stablecoins & Risk',
    description:
      'Monitor peg stability, market cap trends, and depeg risk across major USD stablecoins — USDC, USDT, DAI, GHO, USDe, and more.',
    tags: ['Peg Monitor', 'Market Cap', 'Depeg Risk'],
    status: 'live' as const,
  },
  {
    href: '/treasuries',
    title: 'Tokenized Treasuries',
    description:
      'Track TVL, yield, and issuance data for tokenized T-bill and treasury products: BUIDL, USTB, OUSG, TBILL, and others.',
    tags: ['TVL', 'Yield', 'RWA'],
    status: 'live' as const,
  },
  {
    href: '/lending',
    title: 'DeFi Lending Risk',
    description:
      'Analyse reserve exposures, utilization rates, and yield data across Aave V3, SparkLend, Compound, and Morpho.',
    tags: ['Aave V3', 'SparkLend', 'Morpho'],
    status: 'live' as const,
  },
  {
    href: '/aave',
    title: 'Aave V3 — On-Chain Risk',
    description:
      'Per-reserve risk view for Aave V3 across Ethereum, Arbitrum, Base, Polygon, Optimism, and Avalanche. Live supply, borrow, utilization, APY, and risk params from on-chain RPC.',
    tags: ['Aave V3', 'Multi-chain', 'Live RPC'],
    status: 'live' as const,
  },
  {
    href: '/hyperlend',
    title: 'HyperLend Exposures',
    description:
      'Reserve-level risk view for HyperLend Core Pool on HyperEVM — live supply, borrow, utilization, APY, and risk params from on-chain RPC.',
    tags: ['HyperEVM', 'Live RPC', 'Risk Params'],
    status: 'live' as const,
  },
  {
    href: '/yield-tracker',
    title: 'Yield Tracker',
    description:
      'Compare PT fixed-yield loops, Morpho lending markets, and Aave rates. Live gas-adjusted net profit calculations for sUSDe, weETH, and PT strategies.',
    tags: ['Pendle PT', 'Morpho Loops', 'Aave Rates'],
    status: 'live' as const,
  },
  {
    href: '#',
    title: 'Cross-chain Monitoring',
    description:
      'Bridge exposure monitoring, cross-chain TVL flows, and risk analysis across major L1s and L2s.',
    tags: ['Bridges', 'TVL Flows', 'L2s'],
    status: 'soon' as const,
  },
]

function Badge({ status }: { status: 'live' | 'soon' }) {
  if (status === 'live') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 11, fontWeight: 500,
        color: '#4ade80', background: 'rgba(74,222,128,.1)',
        padding: '3px 10px', borderRadius: 99,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', display: 'inline-block' }} />
        Live
      </span>
    )
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 11, fontWeight: 500,
      color: '#5c6480', background: 'rgba(92,100,128,.1)',
      padding: '3px 10px', borderRadius: 99,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#5c6480', display: 'inline-block' }} />
      Coming soon
    </span>
  )
}

export default function Home() {
  return (
    <div>
      {/* Hero */}
      <div style={{ paddingTop: 56, paddingBottom: 48, borderBottom: '1px solid #2a3055' }}>
        <p style={{ fontSize: 11, color: '#5c6480', letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 500, marginBottom: 16 }}>
          Independent Research
        </p>
        <h1 style={{ fontSize: 30, fontWeight: 700, color: '#e8e4dc', lineHeight: 1.25, maxWidth: 480, margin: '0 0 16px' }}>
          Evidence-led analysis on{' '}
          <em style={{ fontStyle: 'normal', color: '#7b8fe8' }}>digital asset markets</em>
        </h1>
        <p style={{ fontSize: 14, color: '#8892b0', maxWidth: 520, lineHeight: 1.65, margin: 0 }}>
          Data-driven research on tokenized real-world assets, stablecoin risk, and DeFi lending
          markets — powered entirely by public on-chain data.
        </p>
      </div>

      {/* Cards */}
      <div style={{ paddingTop: 40 }}>
        <p style={{ fontSize: 11, color: '#5c6480', letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 500, marginBottom: 24 }}>
          Research Dashboards
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(340px, 100%), 1fr))', gap: 10 }}>
          {sections.map((s) => {
            const isDisabled = s.status === 'soon'
            const card = (
              <div
                style={{
                  padding: '20px 22px',
                  borderRadius: 14,
                  border: `1px solid ${isDisabled ? '#232840' : '#2a3055'}`,
                  background: isDisabled ? 'rgba(26,31,56,0.4)' : '#1a1f38',
                  opacity: isDisabled ? 0.5 : 1,
                  cursor: isDisabled ? 'default' : 'pointer',
                  transition: 'border-color 0.15s, box-shadow 0.15s, background 0.15s',
                }}
                className={isDisabled ? '' : 'dna-card'}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <Badge status={s.status} />
                </div>
                <h2 style={{ fontSize: 15, fontWeight: 600, color: '#e8e4dc', margin: '0 0 8px' }}>{s.title}</h2>
                <p style={{ fontSize: 13, color: '#8892b0', lineHeight: 1.6, margin: '0 0 18px' }}>{s.description}</p>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {s.tags.map((t) => (
                      <span key={t} style={{ fontSize: 11, color: '#6b7394', background: '#21284a', padding: '2px 8px', borderRadius: 5 }}>
                        {t}
                      </span>
                    ))}
                  </div>
                  {!isDisabled && (
                    <span style={{ fontSize: 13, color: '#7b8fe8', fontWeight: 500, marginLeft: 12, whiteSpace: 'nowrap' }}>
                      Open →
                    </span>
                  )}
                </div>
              </div>
            )

            return isDisabled ? (
              <div key={s.title}>{card}</div>
            ) : (
              <Link key={s.title} href={s.href} style={{ display: 'block', textDecoration: 'none' }}>
                {card}
              </Link>
            )
          })}
        </div>
      </div>

      {/* Footer note */}
      <p style={{ marginTop: 48, fontSize: 12, color: '#4d5478' }}>
        Data sourced from DeFiLlama public APIs. Refreshed every 5 minutes. Not financial advice.
      </p>

      <style>{`
        .dna-card:hover {
          border-color: #3d4780 !important;
          background: #1e2440 !important;
          box-shadow: 0 4px 24px rgba(123,143,232,.08);
        }
      `}</style>
    </div>
  )
}
