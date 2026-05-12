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
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700 bg-green-50 px-2.5 py-1 rounded-full">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
        Live
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400 bg-gray-50 px-2.5 py-1 rounded-full">
      <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />
      Coming soon
    </span>
  )
}

export default function Home() {
  return (
    <div>
      {/* Hero */}
      <div className="pt-14 pb-12 border-b border-gray-100">
        <p className="text-xs text-gray-400 uppercase tracking-widest font-medium mb-4">
          Independent Research
        </p>
        <h1 className="text-3xl font-bold text-gray-900 leading-snug max-w-lg">
          Evidence-led analysis on{' '}
          <em className="not-italic text-gray-500">digital asset markets</em>
        </h1>
        <p className="mt-4 text-sm text-gray-500 max-w-xl leading-relaxed">
          Data-driven research on tokenized real-world assets, stablecoin risk, and DeFi lending
          markets — powered entirely by public on-chain data.
        </p>
      </div>

      {/* Cards */}
      <div className="pt-10">
        <p className="text-xs text-gray-400 uppercase tracking-widest font-medium mb-6">
          Research Dashboards
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {sections.map((s) => {
            const isDisabled = s.status === 'soon'
            const card = (
              <div
                className={`group p-6 rounded-2xl border transition-all duration-150 ${
                  isDisabled
                    ? 'border-gray-100 opacity-50 cursor-default'
                    : 'border-gray-100 hover:border-gray-200 hover:shadow-md cursor-pointer'
                }`}
              >
                <div className="flex items-center justify-between mb-5">
                  <Badge status={s.status} />
                </div>
                <h2 className="font-semibold text-gray-900 mb-2 text-base">{s.title}</h2>
                <p className="text-sm text-gray-500 leading-relaxed mb-5">{s.description}</p>
                <div className="flex items-center justify-between">
                  <div className="flex gap-2 flex-wrap">
                    {s.tags.map((t) => (
                      <span key={t} className="text-xs text-gray-400 bg-gray-50 px-2 py-0.5 rounded-md">
                        {t}
                      </span>
                    ))}
                  </div>
                  {!isDisabled && (
                    <span className="text-sm text-gray-900 font-medium group-hover:underline underline-offset-2 shrink-0 ml-4">
                      Open →
                    </span>
                  )}
                </div>
              </div>
            )

            return isDisabled ? (
              <div key={s.title}>{card}</div>
            ) : (
              <Link key={s.title} href={s.href} className="block">
                {card}
              </Link>
            )
          })}
        </div>
      </div>

      {/* Data note */}
      <p className="mt-12 text-xs text-gray-400">
        Data sourced from DeFiLlama public APIs. Refreshed every 5 minutes. Not financial advice.
      </p>
    </div>
  )
}
