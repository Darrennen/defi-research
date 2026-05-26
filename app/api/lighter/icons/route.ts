// Maps token symbols to CoinGecko image URLs.
// Accepts ?symbols=BTC,ETH,LIT and returns { SYMBOL: imageUrl }.
// Stocks and unknown symbols get null.

const SYMBOL_TO_ID: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  NEAR: 'near',
  ZEC: 'zcash',
  AVAX: 'avalanche-2',
  MATIC: 'matic-network',
  POL: 'matic-network',
  ARB: 'arbitrum',
  OP: 'optimism',
  LINK: 'chainlink',
  UNI: 'uniswap',
  AAVE: 'aave',
  LDO: 'lido-dao',
  MKR: 'maker',
  CRV: 'curve-dao-token',
  SNX: 'synthetix-network-token',
  COMP: 'compound-governance-token',
  BAL: 'balancer',
  SUSHI: 'sushi',
  YFI: 'yearn-finance',
  DOGE: 'dogecoin',
  SHIB: 'shiba-inu',
  PEPE: 'pepe',
  WIF: 'dogwifcoin',
  BONK: 'bonk',
  FTM: 'fantom',
  ATOM: 'cosmos',
  DOT: 'polkadot',
  ADA: 'cardano',
  XRP: 'ripple',
  BNB: 'binancecoin',
  LTC: 'litecoin',
  BCH: 'bitcoin-cash',
  ICP: 'internet-computer',
  FIL: 'filecoin',
  ALGO: 'algorand',
  TRX: 'tron',
  XLM: 'stellar',
  VET: 'vechain',
  HBAR: 'hedera-hashgraph',
  EOS: 'eos',
  XTZ: 'tezos',
  THETA: 'theta-token',
  ETC: 'ethereum-classic',
  SAND: 'the-sandbox',
  MANA: 'decentraland',
  AXS: 'axie-infinity',
  GALA: 'gala',
  APE: 'apecoin',
  IMX: 'immutable-x',
  LIT: 'litentry',
  HYPE: 'hyperliquid',
  SUI: 'sui',
  SEI: 'sei-network',
  INJ: 'injective-protocol',
  TIA: 'celestia',
  PYTH: 'pyth-network',
  JTO: 'jito-governance-token',
  BOME: 'book-of-meme',
  WEN: 'wen',
  JUP: 'jupiter-exchange-solana',
  ONDO: 'ondo-finance',
  ENA: 'ethena',
  W: 'wormhole',
  STRK: 'starknet',
  ALT: 'altlayer',
  MANTA: 'manta-network',
  BLUR: 'blur',
  TAO: 'bittensor',
  WLD: 'worldcoin-org',
  ORDI: 'ordinals',
  SATS: '1000sats-ordinals',
  RATS: 'rats-ordinals',
  NEIRO: 'first-neiro-on-ethereum',
  MOODENG: 'moo-deng',
  PNUT: 'peanut-the-squirrel',
  ACT: 'act-i-the-ai-prophecy',
  FARTCOIN: 'fartcoin',
  AI16Z: 'ai16z',
  ZEREBRO: 'zerebro',
  VIRTUAL: 'virtual-protocol',
  AIXBT: 'aixbt-by-virtuals',
  GRIFFAIN: 'griffain',
  SWARMS: 'swarms',
  ZEN: 'zencash',
  FLOKI: 'floki',
  TURBO: 'turbo',
  POPCAT: 'popcat',
  MEW: 'cat-in-a-dogs-world',
  MYRO: 'myro',
  SLERF: 'slerf',
  PONKE: 'ponke',
  TRUMP: 'maga-hat',
  MELANIA: 'melania-meme',
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const rawSymbols = searchParams.get('symbols') ?? ''
  const symbols = rawSymbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)

  if (!symbols.length) return Response.json({})

  const coinIds = [...new Set(symbols.map(s => SYMBOL_TO_ID[s]).filter(Boolean))]

  if (!coinIds.length) {
    const result: Record<string, string | null> = {}
    symbols.forEach(s => { result[s] = null })
    return Response.json(result, { headers: { 'Cache-Control': 'public, max-age=3600' } })
  }

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coinIds.join(',')}&per_page=250&page=1`,
      { next: { revalidate: 3600 } }
    )
    const coins: { id: string; symbol: string; image: string }[] = await res.json()

    const idToImage: Record<string, string> = {}
    coins.forEach(c => { idToImage[c.id] = c.image })

    const result: Record<string, string | null> = {}
    symbols.forEach(s => {
      const id = SYMBOL_TO_ID[s]
      result[s] = id && idToImage[id] ? idToImage[id] : null
    })

    return Response.json(result, { headers: { 'Cache-Control': 'public, max-age=3600' } })
  } catch {
    const result: Record<string, string | null> = {}
    symbols.forEach(s => { result[s] = null })
    return Response.json(result, { headers: { 'Cache-Control': 'public, max-age=3600' } })
  }
}
