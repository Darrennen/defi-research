// Maps token symbols to CoinGecko image URLs.
// Accepts ?symbols=BTC,ETH,LIT,1000PEPE and returns { SYMBOL: imageUrl | null }.
// Stocks, ETFs, forex, commodities, and unknown tokens get null → initials badge fallback.

const SYMBOL_TO_ID: Record<string, string> = {
  // ── major crypto ──────────────────────────────────────────────────────────
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  TRX: 'tron',
  LTC: 'litecoin',
  BCH: 'bitcoin-cash',
  XMR: 'monero',
  DASH: 'dash',
  ZEC: 'zcash',
  ETC: 'ethereum-classic',
  XLM: 'stellar',
  DOT: 'polkadot',
  ATOM: 'cosmos',
  AVAX: 'avalanche-2',
  NEAR: 'near',
  FIL: 'filecoin',
  ICP: 'internet-computer',
  APT: 'aptos',
  SUI: 'sui',
  SEI: 'sei-network',
  TON: 'the-open-network',
  HBAR: 'hedera-hashgraph',
  VET: 'vechain',
  EOS: 'eos',
  XTZ: 'tezos',

  // ── Lighter native ────────────────────────────────────────────────────────
  LIT: 'lighter',         // Lighter exchange native token (NOT litentry)
  HYPE: 'hyperliquid',

  // ── DeFi / L2 ─────────────────────────────────────────────────────────────
  LINK: 'chainlink',
  UNI: 'uniswap',
  AAVE: 'aave',
  MKR: 'maker',
  SKY: 'sky',
  CRV: 'curve-dao-token',
  LDO: 'lido-dao',
  SNX: 'synthetix-network-token',
  COMP: 'compound-governance-token',
  BAL: 'balancer',
  SUSHI: 'sushi',
  YFI: 'yearn-finance',
  GMX: 'gmx',
  DYDX: 'dydx-chain',
  PENDLE: 'pendle',
  MORPHO: 'morpho',
  ETHFI: 'ether-fi',
  EIGEN: 'eigenlayer',
  ONDO: 'ondo-finance',
  ENA: 'ethena',
  RESOLV: 'resolv',
  SYRUP: 'maple-finance',
  AERO: 'aerodrome-finance',
  ZRO: 'layerzero',
  ARB: 'arbitrum',
  OP: 'optimism',
  STRK: 'starknet',
  MATIC: 'matic-network',
  POL: 'matic-network',
  MNT: 'mantle',
  ZK: 'zksync',
  BERA: 'berachain-bera',
  S: 'sonic-3',

  // ── meme / culture ────────────────────────────────────────────────────────
  SHIB: 'shiba-inu',
  PEPE: 'pepe',
  BONK: 'bonk',
  WIF: 'dogwifcoin',
  FLOKI: 'floki',
  POPCAT: 'popcat',
  FARTCOIN: 'fartcoin',
  TRUMP: 'official-trump',
  PENGU: 'pudgy-penguins',
  TURBO: 'turbo',
  MEW: 'cat-in-a-dogs-world',
  KAITO: 'kaito',
  NOT: 'notcoin',

  // ── AI / agents ────────────────────────────────────────────────────────────
  TAO: 'bittensor',
  WLD: 'worldcoin-org',
  AI16Z: 'ai16z',
  VIRTUAL: 'virtual-protocol',
  ZEREBRO: 'zerebro',
  GRASS: 'grass',
  SWARMS: 'swarms',
  IP: 'story-protocol',

  // ── gaming / metaverse ────────────────────────────────────────────────────
  AXS: 'axie-infinity',
  SAND: 'the-sandbox',
  MANA: 'decentraland',
  GALA: 'gala',
  APE: 'apecoin',
  IMX: 'immutable-x',
  THETA: 'theta-token',
  DUSK: 'dusk-network',

  // ── RWA / stables adjacent ────────────────────────────────────────────────
  PAXG: 'pax-gold',

  // ── others ────────────────────────────────────────────────────────────────
  NMR: 'numerai',
  JUP: 'jupiter-exchange-solana',
  JTO: 'jito-governance-token',
  PYTH: 'pyth-network',
  TIA: 'celestia',
  INJ: 'injective-protocol',
  CRO: 'crypto-com-chain',
  BLUR: 'blur',
  ORDI: 'ordinals',
  MANTA: 'manta-network',
  ALT: 'altlayer',
  W: 'wormhole',
  BOME: 'book-of-meme',
  NEIRO: 'first-neiro-on-ethereum',
  PNUT: 'peanut-the-squirrel',
}

// Symbols that are stocks, ETFs, forex, or commodities — no CoinGecko icon
const NO_ICON = new Set([
  // US stocks
  'AAPL','AMZN','GOOGL','MSFT','META','NVDA','TSLA','AMD','PLTR','MSTR',
  'COIN','HOOD','BABA','GME','ORCL','INTC','MU','TSM','ASML','MRVL',
  'TTWO','SNDK','HANMI','CRWV','BMNR',
  // Korean stocks
  'SKHYNIX','SKHYNIXUSD','SAMSUNG','SAMSUNGUSD','HYUNDAI','HYUNDAIUSD','KRCOMP',
  // ETFs / indices
  'SPY','QQQ','IWM','EWY','BOTZ','SOXX','ROBO','MAGS','URA','CHIP',
  'US500','US100','SPX','IWM','SPACEX','H100',
  // Forex
  'USDJPY','AUDUSD','GBPUSD','EURUSD','NZDUSD','USDCAD','USDCHF','USDKRW',
  // Commodities
  'XAU','XAG','XPD','XPT','WTI','BRENTOIL','NATGAS','WHEAT','XCU','CC',
])

// Strip 1000 prefix for tokens like 1000PEPE, 1000BONK, 1000SHIB, 1000NOT, 1000FLOKI
function normalise(symbol: string): string {
  if (/^1000/.test(symbol)) return symbol.slice(4)
  return symbol
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const rawSymbols = searchParams.get('symbols') ?? ''
  const symbols = rawSymbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)

  if (!symbols.length) return Response.json({})

  const result: Record<string, string | null> = {}
  const toFetch: string[] = []

  for (const sym of symbols) {
    if (NO_ICON.has(sym)) { result[sym] = null; continue }
    const base = normalise(sym)
    const id = SYMBOL_TO_ID[base] ?? SYMBOL_TO_ID[sym]
    if (id) toFetch.push(sym)
    else result[sym] = null
  }

  if (!toFetch.length) {
    return Response.json(result, { headers: { 'Cache-Control': 'public, max-age=3600' } })
  }

  const coinIds = [...new Set(toFetch.map(s => {
    const base = normalise(s)
    return SYMBOL_TO_ID[base] ?? SYMBOL_TO_ID[s]
  }))]

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coinIds.join(',')}&per_page=250&page=1`,
      { next: { revalidate: 3600 } }
    )
    const coins: { id: string; image: string }[] = await res.json()
    const idToImage: Record<string, string> = {}
    coins.forEach(c => { idToImage[c.id] = c.image })

    for (const sym of toFetch) {
      const base = normalise(sym)
      const id = SYMBOL_TO_ID[base] ?? SYMBOL_TO_ID[sym]
      result[sym] = id && idToImage[id] ? idToImage[id] : null
    }
  } catch {
    for (const sym of toFetch) result[sym] = null
  }

  return Response.json(result, { headers: { 'Cache-Control': 'public, max-age=3600' } })
}
