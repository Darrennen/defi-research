import { getYieldPools, formatUsd, formatPct } from '@/lib/defillama'

const TREASURY_KEYWORDS = [
  'ondo', 'superstate', 'backed', 'openeden', 'mountain-protocol',
  'hashnote', 'franklin', 'wisdomtree', 'maple', 'securitize',
]

const TREASURY_SYMBOLS = ['ustb', 'buidl', 'ousg', 'tbill', 'jtrsy', 'usdm', 'usdm', 'ibil', 'benji']

function isLikelyTreasury(project: string, symbol: string): boolean {
  const p = (project ?? '').toLowerCase()
  const s = (symbol ?? '').toLowerCase()
  return (
    TREASURY_KEYWORDS.some((k) => p.includes(k)) ||
    TREASURY_SYMBOLS.some((k) => s.includes(k))
  )
}

function ApyCell({ apy }: { apy: number | null }) {
  if (apy === null || apy === undefined) return <span className="text-gray-300">—</span>
  const color = apy > 6 ? 'text-green-600' : apy > 3 ? 'text-blue-600' : 'text-gray-600'
  return <span className={`font-semibold ${color}`}>{formatPct(apy)}</span>
}

export default async function TreasuriesPage() {
  const pools = await getYieldPools()

  const treasury = pools
    .filter((p) => isLikelyTreasury(p.project, p.symbol))
    .filter((p) => p.tvlUsd > 50_000)
    .sort((a, b) => b.tvlUsd - a.tvlUsd)

  const totalTvl = treasury.reduce((s, p) => s + p.tvlUsd, 0)
  const validApys = treasury.filter((p) => p.apy != null && p.apy > 0)
  const avgApy = validApys.length
    ? validApys.reduce((s, p) => s + (p.apy ?? 0), 0) / validApys.length
    : 0
  const protocols = new Set(treasury.map((p) => p.project)).size

  return (
    <div>
      {/* Header */}
      <div className="pt-10 pb-8 border-b border-gray-100">
        <p className="text-xs text-gray-400 uppercase tracking-widest font-medium mb-2">
          Tokenized Treasuries
        </p>
        <h1 className="text-2xl font-bold text-gray-900">Treasury Token Monitor</h1>
        <p className="mt-2 text-sm text-gray-500 max-w-xl leading-relaxed">
          TVL and yield data for tokenized T-bill and treasury products. Includes BUIDL, USTB,
          OUSG, TBILL, and more. Data from DeFiLlama.
        </p>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-6 py-8 border-b border-gray-100">
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">Total TVL</p>
          <p className="text-2xl font-bold text-gray-900">{formatUsd(totalTvl)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">Avg Yield</p>
          <p className="text-2xl font-bold text-gray-900">{formatPct(avgApy)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">
            Protocols Tracked
          </p>
          <p className="text-2xl font-bold text-gray-900">{protocols}</p>
        </div>
      </div>

      {/* Table */}
      <div className="mt-8 overflow-x-auto">
        {treasury.length === 0 ? (
          <p className="text-center text-gray-400 text-sm py-16">No treasury pools found</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                {['Protocol', 'Symbol', 'Chain', 'TVL', 'Base APY', 'Total APY'].map((h, i) => (
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
              {treasury.map((p) => (
                <tr key={p.pool} className="hover:bg-gray-50/60 transition-colors">
                  <td className="py-3 font-medium text-gray-900 capitalize pr-6">
                    {p.project?.replace(/-/g, ' ') ?? '—'}
                  </td>
                  <td className="py-3 text-gray-500 font-mono text-xs pr-6">{p.symbol}</td>
                  <td className="py-3 pr-6">
                    <span className="text-xs text-gray-400 bg-gray-50 px-2 py-0.5 rounded-md">
                      {p.chain}
                    </span>
                  </td>
                  <td className="py-3 text-right font-medium text-gray-900">
                    {formatUsd(p.tvlUsd)}
                  </td>
                  <td className="py-3 text-right text-gray-500">{formatPct(p.apyBase)}</td>
                  <td className="py-3 text-right">
                    <ApyCell apy={p.apy} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-8 text-xs text-gray-400">
        Source: DeFiLlama Yields API · Refreshes every 5 min
      </p>
    </div>
  )
}
