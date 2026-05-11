interface Protocol {
  name: string
  slug: string
  tvl: number | null
  category: string
  chains: string[]
  logo?: string
  description?: string
}

const TREASURY_KEYWORDS = ['ondo', 'superstate', 'backed', 'openeden', 'mountain', 'hashnote', 'franklin', 'wisdomtree', 'maple', 'securitize', 'spiko', 'anemoy', 'matrixdock', 'midas']

function isTreasury(p: Protocol): boolean {
  const cat = (p.category ?? '').toLowerCase()
  const slug = (p.slug ?? '').toLowerCase()
  const name = (p.name ?? '').toLowerCase()
  if (cat === 'rwa') return true
  return TREASURY_KEYWORDS.some(k => slug.includes(k) || name.includes(k))
}

function formatUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

export const revalidate = 300

export default async function TreasuriesPage() {
  const res = await fetch('https://api.llama.fi/protocols', { next: { revalidate: 300 } })
  const all: Protocol[] = await res.json()

  const treasury = all
    .filter(isTreasury)
    .filter(p => (p.tvl ?? 0) > 1_000_000)
    .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0))

  const totalTvl = treasury.reduce((s, p) => s + (p.tvl ?? 0), 0)
  const chainSet = new Set(treasury.flatMap(p => p.chains ?? []))

  return (
    <div>
      {/* Header */}
      <div className="pt-10 pb-8 border-b border-gray-100">
        <p className="text-xs text-gray-400 uppercase tracking-widest font-medium mb-2">
          Tokenized Real World Assets
        </p>
        <h1 className="text-2xl font-bold text-gray-900">Tokenized Treasuries & RWA</h1>
        <p className="mt-2 text-sm text-gray-500 max-w-xl leading-relaxed">
          TVL across tokenized T-bill, treasury, and RWA protocols — BUIDL, USTB, OUSG, TBILL, and others. Data from DeFiLlama.
        </p>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-6 py-8 border-b border-gray-100">
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">Total TVL</p>
          <p className="text-2xl font-bold text-gray-900">{formatUsd(totalTvl)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">Protocols</p>
          <p className="text-2xl font-bold text-gray-900">{treasury.length}</p>
        </div>
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">Chains</p>
          <p className="text-2xl font-bold text-gray-900">{chainSet.size}</p>
        </div>
      </div>

      {/* Table */}
      <div className="mt-8 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              {['#', 'Protocol', 'TVL', 'Chains', 'Category'].map((h, i) => (
                <th
                  key={h}
                  className={`pb-3 text-xs text-gray-400 font-medium uppercase tracking-wide ${
                    i < 2 ? 'text-left' : i === 2 ? 'text-right' : 'text-left'
                  } ${i === 0 ? 'w-8 pr-4' : ''}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {treasury.map((p, idx) => (
              <tr key={p.slug} className="hover:bg-gray-50/60 transition-colors">
                <td className="py-3 text-xs text-gray-300 pr-4">{idx + 1}</td>
                <td className="py-3 pr-6">
                  <div className="flex items-center gap-2">
                    {p.logo && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.logo} alt={p.name} width={20} height={20} className="rounded-sm shrink-0" />
                    )}
                    <span className="font-medium text-gray-900">{p.name}</span>
                  </div>
                </td>
                <td className="py-3 text-right font-semibold text-gray-900 pr-8">
                  {p.tvl != null ? formatUsd(p.tvl) : '—'}
                </td>
                <td className="py-3 pr-6">
                  <div className="flex flex-wrap gap-1">
                    {(p.chains ?? []).slice(0, 4).map(c => (
                      <span key={c} className="text-xs text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded-md">
                        {c}
                      </span>
                    ))}
                    {(p.chains ?? []).length > 4 && (
                      <span className="text-xs text-gray-300">+{(p.chains ?? []).length - 4}</span>
                    )}
                  </div>
                </td>
                <td className="py-3">
                  <span className="text-xs text-gray-400">{p.category}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-8 text-xs text-gray-400">
        Source: DeFiLlama Protocols API · RWA category + known treasury issuers · Refreshes every 5 min · Not financial advice
      </p>
    </div>
  )
}
