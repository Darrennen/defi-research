import { getYieldPools, formatUsd, formatPct } from '@/lib/defillama'

const LENDING_PROJECTS = [
  'aave-v3',
  'aave-v2',
  'spark',
  'compound-v3',
  'compound-finance-v3',
  'morpho-blue',
  'morpho',
  'euler',
  'euler-v2',
  'silo-finance',
  'radiant-v2',
  'benqi',
  'venus',
]

function UtilBar({ util }: { util: number }) {
  const color = util > 90 ? 'bg-red-400' : util > 70 ? 'bg-yellow-400' : 'bg-green-400'
  return (
    <div className="flex items-center gap-2 justify-end">
      <span className="text-xs text-gray-500 w-10 text-right">{util.toFixed(0)}%</span>
      <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(util, 100)}%` }} />
      </div>
    </div>
  )
}

export default async function LendingPage() {
  const pools = await getYieldPools()

  const lending = pools
    .filter((p) => LENDING_PROJECTS.includes(p.project?.toLowerCase() ?? ''))
    .filter((p) => p.tvlUsd > 500_000)
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, 60)

  const totalTvl = lending.reduce((s, p) => s + p.tvlUsd, 0)
  const protocols = new Set(lending.map((p) => p.project)).size
  const chains = new Set(lending.map((p) => p.chain)).size

  // rough utilisation = (borrows / (borrows + tvl)) — proxy from apy when available
  function utilisation(p: (typeof lending)[0]): number | null {
    if (!p.apyBaseBorrow || !p.apyBase || p.apyBase === 0) return null
    // higher borrow rate vs supply rate implies higher utilisation
    const util = Math.min((p.apyBase / (p.apyBaseBorrow || 1)) * 100, 100)
    return util
  }

  return (
    <div>
      {/* Header */}
      <div className="pt-10 pb-8 border-b border-gray-100">
        <p className="text-xs text-gray-400 uppercase tracking-widest font-medium mb-2">
          DeFi Lending Risk
        </p>
        <h1 className="text-2xl font-bold text-gray-900">Lending Market Monitor</h1>
        <p className="mt-2 text-sm text-gray-500 max-w-xl leading-relaxed">
          Supply rates, borrow rates, and TVL across major DeFi lending protocols — Aave V3,
          SparkLend, Morpho, Compound, and more. Data from DeFiLlama.
        </p>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-6 py-8 border-b border-gray-100">
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">Total TVL</p>
          <p className="text-2xl font-bold text-gray-900">{formatUsd(totalTvl)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">
            Protocols
          </p>
          <p className="text-2xl font-bold text-gray-900">{protocols}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">Chains</p>
          <p className="text-2xl font-bold text-gray-900">{chains}</p>
        </div>
      </div>

      {/* Table */}
      <div className="mt-8 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              {[
                'Protocol',
                'Market',
                'Chain',
                'TVL',
                'Supply APY',
                'Borrow APY',
                'Stablecoin',
              ].map((h, i) => (
                <th
                  key={h}
                  className={`pb-3 text-xs text-gray-400 font-medium uppercase tracking-wide ${
                    i < 3 ? 'text-left' : 'text-right'
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {lending.map((p) => {
              const util = utilisation(p)
              return (
                <tr key={p.pool} className="hover:bg-gray-50/60 transition-colors">
                  <td className="py-3 font-medium text-gray-900 capitalize pr-6">
                    {p.project?.replace(/-/g, ' ') ?? '—'}
                  </td>
                  <td className="py-3 text-gray-500 font-mono text-xs pr-6 max-w-[140px] truncate">
                    {p.symbol}
                  </td>
                  <td className="py-3 pr-6">
                    <span className="text-xs text-gray-400 bg-gray-50 px-2 py-0.5 rounded-md">
                      {p.chain}
                    </span>
                  </td>
                  <td className="py-3 text-right font-medium text-gray-900">
                    {formatUsd(p.tvlUsd)}
                  </td>
                  <td className="py-3 text-right">
                    {p.apyBase != null ? (
                      <span className="font-semibold text-blue-600">{formatPct(p.apyBase)}</span>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="py-3 text-right">
                    {p.apyBaseBorrow != null ? (
                      <span className="font-semibold text-orange-500">
                        {formatPct(p.apyBaseBorrow)}
                      </span>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="py-3 text-right">
                    {p.stablecoin ? (
                      <span className="text-xs font-medium text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                        Yes
                      </span>
                    ) : (
                      <span className="text-gray-300 text-xs">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-8 text-xs text-gray-400">
        Source: DeFiLlama Yields API · Refreshes every 5 min · Supply APY = base lending rate ·
        Borrow APY = base borrow cost
      </p>
    </div>
  )
}
