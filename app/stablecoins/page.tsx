import { getStablecoins, formatUsd, formatPct } from '@/lib/defillama'

function pegDev(price: number) {
  return Math.abs(price - 1) * 100
}

function PegBadge({ price }: { price: number }) {
  const d = pegDev(price)
  if (d < 0.1)
    return (
      <span className="text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
        Stable
      </span>
    )
  if (d < 1)
    return (
      <span className="text-xs font-medium text-yellow-700 bg-yellow-50 px-2 py-0.5 rounded-full">
        Warning
      </span>
    )
  return (
    <span className="text-xs font-medium text-red-700 bg-red-50 px-2 py-0.5 rounded-full">
      Depegged
    </span>
  )
}

function MechBadge({ mech }: { mech: string }) {
  const label = mech?.replace(/-/g, ' ') ?? '—'
  const colors: Record<string, string> = {
    'fiat backed': 'text-blue-600 bg-blue-50',
    'crypto backed': 'text-purple-600 bg-purple-50',
    algorithmic: 'text-orange-600 bg-orange-50',
  }
  const cls = colors[label] ?? 'text-gray-500 bg-gray-50'
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${cls}`}>{label}</span>
  )
}

export default async function StablecoinsPage() {
  const all = await getStablecoins()

  const stables = all
    .filter(
      (s) =>
        s.pegType === 'peggedUSD' &&
        s.price != null &&
        s.price > 0 &&
        (s.circulating?.peggedUSD ?? 0) > 1_000_000
    )
    .sort((a, b) => (b.circulating?.peggedUSD ?? 0) - (a.circulating?.peggedUSD ?? 0))
    .slice(0, 40)

  const totalMcap = stables.reduce((s, x) => s + (x.circulating?.peggedUSD ?? 0), 0)
  const avgDev =
    stables.reduce((s, x) => s + pegDev(x.price), 0) / stables.length
  const offPeg = stables.filter((x) => pegDev(x.price) >= 0.1).length

  return (
    <div>
      {/* Header */}
      <div className="pt-10 pb-8 border-b border-gray-100">
        <p className="text-xs text-gray-400 uppercase tracking-widest font-medium mb-2">
          Stablecoins &amp; Risk
        </p>
        <h1 className="text-2xl font-bold text-gray-900">Peg Stability Monitor</h1>
        <p className="mt-2 text-sm text-gray-500 max-w-xl leading-relaxed">
          Real-time peg tracking for USD-pegged stablecoins. Flags assets deviating more than 0.1%
          from par. Data from DeFiLlama.
        </p>
      </div>

      {/* Summary metrics */}
      <div className="grid grid-cols-3 gap-6 py-8 border-b border-gray-100">
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">
            Total Market Cap
          </p>
          <p className="text-2xl font-bold text-gray-900">{formatUsd(totalMcap)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">
            Avg Peg Deviation
          </p>
          <p className="text-2xl font-bold text-gray-900">{avgDev.toFixed(3)}%</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">
            Off-Peg (&gt;0.1%)
          </p>
          <p
            className={`text-2xl font-bold ${offPeg > 0 ? 'text-yellow-600' : 'text-gray-900'}`}
          >
            {offPeg}
          </p>
        </div>
      </div>

      {/* Table */}
      <div className="mt-8 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              {['#', 'Asset', 'Mechanism', 'Market Cap', 'Price', 'Deviation', 'Status', 'Chains'].map(
                (h, i) => (
                  <th
                    key={h}
                    className={`pb-3 text-xs text-gray-400 font-medium uppercase tracking-wide ${
                      i < 3 ? 'text-left' : 'text-right'
                    } ${i === 0 ? 'w-8' : ''}`}
                  >
                    {h}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {stables.map((s, i) => {
              const dev = pegDev(s.price)
              const devColor =
                dev >= 1
                  ? 'text-red-600'
                  : dev >= 0.1
                  ? 'text-yellow-600'
                  : 'text-green-600'
              return (
                <tr key={s.id} className="hover:bg-gray-50/60 transition-colors">
                  <td className="py-3 text-gray-400 text-xs pr-4">{i + 1}</td>
                  <td className="py-3 pr-6">
                    <span className="font-medium text-gray-900">{s.symbol}</span>
                    <span className="text-gray-400 text-xs ml-2 hidden sm:inline">{s.name}</span>
                  </td>
                  <td className="py-3 pr-6">
                    <MechBadge mech={s.pegMechanism} />
                  </td>
                  <td className="py-3 text-right font-medium text-gray-900">
                    {formatUsd(s.circulating?.peggedUSD ?? 0)}
                  </td>
                  <td className="py-3 text-right text-gray-700 font-mono text-xs">
                    ${s.price?.toFixed(5)}
                  </td>
                  <td className={`py-3 text-right font-semibold ${devColor}`}>
                    {dev.toFixed(3)}%
                  </td>
                  <td className="py-3 text-right">
                    <PegBadge price={s.price} />
                  </td>
                  <td className="py-3 text-right text-gray-400 text-xs">
                    {s.chains?.length ?? 0}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-8 text-xs text-gray-400">
        Source: DeFiLlama Stablecoins API · Refreshes every 5 min
      </p>
    </div>
  )
}
