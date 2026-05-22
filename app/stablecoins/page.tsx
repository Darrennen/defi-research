import { getStablecoins, formatUsd } from '@/lib/defillama'

const CG = 'https://coin-images.coingecko.com/coins/images'

// Static map: gecko_id → CoinGecko image path (large→small swap at render)
// Sourced once from CoinGecko /coins/markets — CDN URLs are stable.
const COIN_IMAGES: Record<string, string> = {
  'tether':                                               '325/Tether.png',
  'usd-coin':                                             '6319/USDC.png',
  'usds':                                                 '39926/usds.webp',
  'usd1-wlfi':                                            '54977/USD1_1000x1000_transparent.png',
  'dai':                                                  '9956/Badge_Dai.png',
  'ethena-usde':                                          '33613/usde.png',
  'paypal-usd':                                           '31212/PYUSD_Token_Logo_2x.png',
  'blackrock-usd-institutional-digital-liquidity-fund':   '36291/blackrock.png',
  'hashnote-usyc':                                        '51054/Hashnote_SDYC_200x200.png',
  'global-dollar':                                        '51281/GDN_USDG_Token_200x200.png',
  'ondo-us-dollar-yield':                                 '31700/usdy_%281%29.png',
  'ripple-usd':                                           '39651/RLUSD_200x200_%281%29.png',
  'falcon-finance':                                       '54558/ff_200_X_200.png',
  'usdd':                                                 '25380/UUSD.jpg',
  'usdtb':                                                '52804/76357aa8-4ef7-446c-bad3-a3f944eeec7a.jpeg',
  'united-stables':                                       '71157/united-stables-logo.jpg',
  'usdx-money-usdx':                                      '50360/USDX200px.png',
  'gho':                                                  '30663/gho-token-logo.png',
  'usual-usd':                                            '38272/USD0LOGO.png',
  'ylds':                                                 '66486/YLDS.png',
  'apxusd':                                               '102172243/apxUSD.png',
  'true-usd':                                             '3449/tusd.png',
  'usx':                                                  '68429/Solstice_Icons_for_DEX_512x512_USX.png',
  'first-digital-usd':                                    '31079/FDUSD_icon_black.png',
  'usdgo':                                                '102172077/USDGO_%287%29.png',
  'usda-2':                                               '51599/SUSDA.png',
  'crvusd':                                               '30118/crvusd.jpg',
  'frax':                                                 '13422/LFRAX.png',
  'frax-usd':                                             '53963/frxUSD.png',
  'husd':                                                 '9567/HUSD.jpg',
  'openeden-tbill':                                       '30576/OE_Logo_200x200_Transparent.png',
  'gusd':                                                 '68725/gusd-logo.jpeg',
  'agora-dollar':                                         '39284/AUSD_1024px.png',
  'dola-usd':                                             '14287/dola.png',
  'binance-peg-busd':                                     '9576/BUSD.png',
}

function coinImg(geckoId?: string): string | undefined {
  if (!geckoId) return undefined
  const path = COIN_IMAGES[geckoId]
  if (!path) return undefined
  const [numId, file] = path.split('/')
  return `${CG}/${numId}/small/${file}`
}

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
              const imgUrl = coinImg(s.gecko_id)
              return (
                <tr key={s.id}>
                  <td>{i + 1}</td>
                  <td className="name">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {imgUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={imgUrl} alt={s.symbol} width={16} height={16} style={{ borderRadius: '50%', flexShrink: 0 }} />
                      )}
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
