const HEVM_API = '/api/hevm'

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(HEVM_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const d = await r.json()
  if (d.error) throw new Error(d.error.message ?? 'RPC error')
  return d.result
}

// Batch eth_call — single HTTP round-trip for many read calls, avoiding rate-limit drops
async function batchEthCall(calls: Array<{ to: string; data: string }>): Promise<string[]> {
  if (calls.length === 0) return []
  const batch = calls.map((call, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [call, 'latest'] }))
  const r = await fetch(HEVM_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const results: Array<{ id: number; result?: string }> = await r.json()
  const out = new Array<string>(calls.length).fill('0x0')
  for (const res of results) { if (res.result) out[res.id] = res.result }
  return out
}

// ── ABI helpers ───────────────────────────────────────────────────────────────

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const SEL_SYMBOL   = '0x95d89b41'
const SEL_DECIMALS = '0x313ce567'
const SEL_BALANCE  = '0x70a08231'

function padAddr(a: string): string {
  return '0x' + a.replace('0x', '').toLowerCase().padStart(64, '0')
}

function balanceOfData(wallet: string): string {
  return SEL_BALANCE + wallet.replace('0x', '').toLowerCase().padStart(64, '0')
}

function decodeAbiString(hex: string): string {
  try {
    const d = hex.startsWith('0x') ? hex.slice(2) : hex
    if (d.length < 128) return ''
    const len = parseInt(d.slice(64, 128), 16)
    if (!len || len > 300) return ''
    const chars: string[] = []
    for (let i = 128; i < 128 + len * 2; i += 2) {
      const code = parseInt(d.slice(i, i + 2), 16)
      if (code) chars.push(String.fromCharCode(code))
    }
    return chars.join('')
  } catch { return '' }
}

function decodeUint(hex: string): number {
  if (!hex || hex === '0x') return 0
  try { return Number(BigInt(hex)) } catch { return 0 }
}

function decodeBigInt(hex: string): bigint {
  if (!hex || hex === '0x' || hex === '0x0') return 0n
  try { return BigInt(hex) } catch { return 0n }
}

function slot(hex: string, index: number): bigint {
  const d = hex.startsWith('0x') ? hex.slice(2) : hex
  const s = d.slice(index * 64, (index + 1) * 64)
  if (!s || s.length < 64) return 0n
  return decodeBigInt('0x' + s)
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EvmToken {
  address: string
  symbol: string
  name: string
  decimals: number
  balance: bigint
  formatted: number
  protocol: string
}

export interface EvmProtocolPosition {
  protocol: string
  type: 'supply' | 'borrow' | 'stake' | 'vault' | 'cdp'
  asset: string
  decimals: number
  amount: number
  raw: bigint
}

export interface EvmTransfer {
  txHash: string
  blockNumber: number
  tokenAddress: string
  tokenSymbol: string
  from: string
  to: string
  value: bigint
  formatted: number
  decimals: number
  direction: 'in' | 'out'
}

export interface EvmWalletData {
  nativeBalance: bigint
  nativeFormatted: number
  txCount: number
  blockNumber: number
  tokens: EvmToken[]
  protocolPositions: EvmProtocolPosition[]
  transfers: EvmTransfer[]
}

interface RawLog {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  transactionHash: string
}

// ── Known tokens ──────────────────────────────────────────────────────────────

export const KNOWN_TOKENS: { address: string; symbol: string; name: string; decimals: number; protocol: string }[] = [
  // Core assets
  { address: '0x5555555555555555555555555555555555555555', symbol: 'WHYPE',   name: 'Wrapped HYPE',       decimals: 18, protocol: 'Native'      },
  { address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', symbol: 'USDC',    name: 'USD Coin',           decimals: 6,  protocol: 'Native'      },
  { address: '0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463', symbol: 'UBTC',    name: 'Unit Bitcoin',       decimals: 8,  protocol: 'Native'      },
  { address: '0xBe6727B535545C67d5cAa73dEa54865B92CF7907', symbol: 'UETH',    name: 'Unit Ethereum',      decimals: 18, protocol: 'Native'      },
  { address: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', symbol: 'USDT0',   name: 'USDT Zero',          decimals: 6,  protocol: 'Native'      },
  { address: '0x9b498C3c8A0b8CD8BA1D9851d40D186F1872b44E', symbol: 'PURR',    name: 'Purr',               decimals: 18, protocol: 'Native'      },
  // Stablecoins
  { address: '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34', symbol: 'USDe',    name: 'USDe',               decimals: 18, protocol: 'Ethena'      },
  { address: '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2', symbol: 'sUSDe',   name: 'Staked USDe',        decimals: 18, protocol: 'Ethena'      },
  { address: '0x0aD339d66BF4AeD5ce31c64Bc37B3244b6394A77', symbol: 'USR',     name: 'Resolv USD',         decimals: 18, protocol: 'Resolv'      },
  { address: '0xb50A96253aBDF803D85efcDce07Ad8becBc52BD5', symbol: 'USDHL',   name: 'Hyper USD',          decimals: 6,  protocol: 'HyperLend'   },
  { address: '0x111111a1a0667d36bD57c0A9f569b98057111111', symbol: 'USDH',    name: 'Paxos USDH',         decimals: 6,  protocol: 'Paxos'       },
  // Kinetiq
  { address: '0xfD739d4e423301CE9385c1fb8850539D657C296D', symbol: 'kHYPE',    name: 'Kinetiq Staked HYPE', decimals: 18, protocol: 'Kinetiq'    },
  { address: '0x360C140E5344A1A0593D44B4ea6Fc7C3DAf0C473', symbol: 'kmHYPE',   name: 'Kinetiq Markets',     decimals: 18, protocol: 'Kinetiq'    },
  { address: '0x86d96fF0E78Dba9570b00f75807ce21213a19f3d', symbol: 'flowHYPE', name: 'Flowdesk HYPE',       decimals: 18, protocol: 'Kinetiq'    },
  { address: '0x4f322145aBedb2b39f69e7d4531AB4B2e6483154', symbol: 'HiHYPE',   name: 'Hyperion HYPE',       decimals: 18, protocol: 'Kinetiq'    },
  // StakedHYPE
  { address: '0xfFaa4a3D97fE9107Cef8a3F48c069F577Ff76cC1', symbol: 'stHYPE',  name: 'Staked HYPE',         decimals: 18, protocol: 'StakedHYPE' },
  { address: '0x94e8396e0869c9F2200760aF0621aFd240E1CF38', symbol: 'wstHYPE', name: 'Wrapped stHYPE',      decimals: 18, protocol: 'StakedHYPE' },
  // Felix CDP
  { address: '0x02c6a2fa58cc01a18b8d9e00ea48d65e4df26c70', symbol: 'feUSD',   name: 'Felix USD',           decimals: 18, protocol: 'Felix'      },
  // Hyperstable
  { address: '0x8ff0dd9f9c40a0d76ef1bcfaf5f98c1610c74bd8', symbol: 'USH',     name: 'Hyperstable USD',     decimals: 18, protocol: 'Hyperstable'},
  // Hyperbeat
  { address: '0x81e064d0eB539de7c3170EDF38C1A42CBd752A76', symbol: 'lstHYPE', name: 'Hyperbeat LST',       decimals: 18, protocol: 'Hyperbeat'  },
  { address: '0xd8FC8F0b03eBA61F64D08B0bef69d80916E5DdA9', symbol: 'beHYPE',  name: 'Hyperbeat efHYPE',    decimals: 18, protocol: 'Hyperbeat'  },
  { address: '0x96C6cBB6251Ee1c257b2162ca0f39AA5Fa44B1FB', symbol: 'hbHYPE',  name: 'Hyperbeat Ultra',     decimals: 18, protocol: 'Hyperbeat'  },
  { address: '0x5e105266db42f78FA814322Bce7f388B4C2e61eb', symbol: 'hbUSDT',  name: 'Hyperbeat USDT',      decimals: 6,  protocol: 'Hyperbeat'  },
  // HyperLend governance
  { address: '0xbd6dab50f03a305a80037294fa8d1a9dc0cac91b', symbol: 'HPL',     name: 'HyperLend Token',     decimals: 18, protocol: 'HyperLend'  },
  // Morpho vaults
  { address: '0x242572d6f1AF7111bcA807ECDd0f74108cEAeD5d', symbol: 'mUSDT',   name: 'Morpho USDT Vault',   decimals: 6,  protocol: 'Morpho'     },
  { address: '0x9FA2074E43ef6F6dB4a1bB5eeB72e4bc8558bFDe', symbol: 'mUSDC',   name: 'Morpho USDC Vault',   decimals: 6,  protocol: 'Morpho'     },
  // Nest
  { address: '0x07c57e32a3c29d5659bda1d3efc2e7bf004e3035', symbol: 'NEST',    name: 'Nest',                decimals: 18, protocol: 'Nest'       },
  // Kinetiq governance
  { address: '0x000000000000780555bd0bca3791f89f9542c2d6', symbol: 'KNTQ',    name: 'Kinetiq Token',       decimals: 18, protocol: 'Kinetiq'    },
  // Misc
  { address: '0xE6829d9a7eE3040e1276Fa75293Bde931859e8fA', symbol: 'cmETH',   name: 'cmETH',               decimals: 18, protocol: 'Native'     },
  { address: '0xfDD22Ce6D1F66bc0Ec89b20BF16CcB6670F55A5a', symbol: 'thBILL',  name: 'T-Bill Token',        decimals: 18, protocol: 'TradFi'     },
  { address: '0x9FD7466f987Fd4C45a5BBDe22ED8aba5BC8D72d1', symbol: 'hwHLP',   name: 'Hyperwave HLP',       decimals: 18, protocol: 'Hyperwave'  },
  { address: '0x9ab96A4668456896d45c301Bc3A15Cee76AA7B8D', symbol: 'rUSDC',   name: 'Relend USDC',         decimals: 6,  protocol: 'Relend'     },
  { address: '0xf44f49e6577b3934f981c6f0629d15154d2606e6', symbol: 'hXXI',    name: 'D2 XXI BTC Vault',    decimals: 18, protocol: 'D2.Finance' },
  { address: '0x0e01e3afd147c7f079ea19d0eca166ad3a22e79d', symbol: 'HWAVE',   name: 'Hyperwave',           decimals: 18, protocol: 'Hyperwave'  },
  // Institutional LSTs
  { address: '0x8599F2eFA5064C666B920E71381b5aaBc7Bb27F6', symbol: 'asxnHYPE', name: 'Asymmetrix HYPE',     decimals: 18, protocol: 'Asymmetrix' },
  { address: '0x498edC41Fa92530920a95483dea7a6CCe91F1C5c', symbol: 'hylqHYPE', name: 'Hyperliquid LST',     decimals: 18, protocol: 'Hyperion'   },
  { address: '0x74323CD0Db2FD826CadCc90153995F1E2b1d0801', symbol: 'GhostLST', name: 'Ghost LST HYPE',      decimals: 18, protocol: 'Ghost'      },
]

// ── Protocol position readers ─────────────────────────────────────────────────

// HyperLend (Aave V3 fork) — ProtocolDataProvider
const HYPERLEND_DATA_PROVIDER = '0x4f4d4cA1e0a8A21FE0B460613bEbe917f2eb4326'
// getUserReserveData(address asset, address user)
const SEL_USER_RESERVE = '0x28dd2d01'

const HYPERLEND_ASSETS = [
  { address: '0x5555555555555555555555555555555555555555', symbol: 'WHYPE',   decimals: 18 },
  { address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', symbol: 'USDC',    decimals: 6  },
  { address: '0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463', symbol: 'UBTC',    decimals: 8  },
  { address: '0xBe6727B535545C67d5cAa73dEa54865B92CF7907', symbol: 'UETH',    decimals: 18 },
  { address: '0xfD739d4e423301CE9385c1fb8850539D657C296D', symbol: 'kHYPE',   decimals: 18 },
  { address: '0x94e8396e0869c9F2200760aF0621aFd240E1CF38', symbol: 'wstHYPE', decimals: 18 },
  { address: '0xfFaa4a3D97fE9107Cef8a3F48c069F577Ff76cC1', symbol: 'stHYPE',  decimals: 18 },
  { address: '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34', symbol: 'USDe',    decimals: 18 },
  { address: '0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2', symbol: 'sUSDe',   decimals: 18 },
  { address: '0xb50A96253aBDF803D85efcDce07Ad8becBc52BD5', symbol: 'USDHL',   decimals: 6  },
]

async function getHyperLendPositions(user: string): Promise<EvmProtocolPosition[]> {
  const addr = user.replace('0x', '').toLowerCase().padStart(64, '0')
  const results = await Promise.all(HYPERLEND_ASSETS.map(async asset => {
    try {
      const data = SEL_USER_RESERVE
        + asset.address.replace('0x', '').toLowerCase().padStart(64, '0')
        + addr
      const res = await rpc<string>('eth_call', [{ to: HYPERLEND_DATA_PROVIDER, data }, 'latest'])
      if (!res || res === '0x' || res.length < 18) return []
      // Returns: (currentATokenBalance, currentStableDebt, currentVariableDebt, ...)
      const aToken = slot(res, 0)
      const stableDebt = slot(res, 1)
      const variableDebt = slot(res, 2)
      const out: EvmProtocolPosition[] = []
      if (aToken > 0n) out.push({ protocol: 'HyperLend', type: 'supply', asset: asset.symbol, decimals: asset.decimals, amount: Number(aToken) / 10 ** asset.decimals, raw: aToken })
      const totalDebt = stableDebt + variableDebt
      if (totalDebt > 0n) out.push({ protocol: 'HyperLend', type: 'borrow', asset: asset.symbol, decimals: asset.decimals, amount: Number(totalDebt) / 10 ** asset.decimals, raw: totalDebt })
      return out
    } catch { return [] }
  }))
  return results.flat()
}

// Felix StabilityPool deposits — getCompoundedDeposit(address) → 0x... (Liquity v2 style)
// Function selector: keccak256("getCompoundedBoldDeposit(address)") — Felix uses feUSD so might differ
// Use balanceOf on feUSD token directly (simpler & accurate for wallet holdings)

// Kinetiq StakingAccountant — kHYPEToHYPE(uint256) converts token balance → underlying HYPE
// kHYPE accountant: 0x9209648Ec9D448EF57116B73A2f081835643dc7A
// kmHYPE accountant: 0x5901e744759561C63309865Ef8822aBb041655E2
// Both expose kHYPEToHYPE(uint256) with selector 0x759bc2fc
const SEL_KHYPE_TO_HYPE = '0x759bc2fc'
const KHYPE_ACCOUNTANT  = '0x9209648Ec9D448EF57116B73A2f081835643dc7A'
const KMHYPE_ACCOUNTANT = '0x5901e744759561C63309865Ef8822aBb041655E2'

async function getKinetiqUnderlying(accountant: string, tokenBalance: bigint): Promise<number> {
  if (tokenBalance === 0n) return 0
  try {
    const data = SEL_KHYPE_TO_HYPE + tokenBalance.toString(16).padStart(64, '0')
    const res = await rpc<string>('eth_call', [{ to: accountant, data }, 'latest'])
    return Number(decodeBigInt(res)) / 1e18
  } catch { return 0 }
}

// wstHYPE — ERC-4626, balanceOf + convertToAssets for underlying
const SEL_CONVERT_TO_ASSETS = '0x07a2d13a' // convertToAssets(uint256)

async function getWstHypeUnderlying(user: string, balance: bigint): Promise<number> {
  if (balance === 0n) return 0
  try {
    const sharesHex = '0x' + balance.toString(16).padStart(64, '0')
    const data = SEL_CONVERT_TO_ASSETS + sharesHex.slice(2).padStart(64, '0')
    const res = await rpc<string>('eth_call', [{ to: '0x94e8396e0869c9F2200760aF0621aFd240E1CF38', data }, 'latest'])
    const underlying = decodeBigInt(res)
    return Number(underlying) / 1e18
  } catch { return Number(balance) / 1e18 }
}

// ── Main fetcher ──────────────────────────────────────────────────────────────

export async function fetchEvmWallet(address: string): Promise<EvmWalletData> {
  const addr = address.toLowerCase()

  // Core chain info
  const [blockHex, balHex, nonceHex] = await Promise.all([
    rpc<string>('eth_blockNumber', []),
    rpc<string>('eth_getBalance', [addr, 'latest']),
    rpc<string>('eth_getTransactionCount', [addr, 'latest']),
  ])

  const blockNumber   = parseInt(blockHex, 16)
  const nativeBalance = decodeBigInt(balHex)
  const txCount       = parseInt(nonceHex, 16)

  // HyperEVM RPC hard-limits eth_getLogs to 1000 blocks per query (~33 min)
  const fromBlock   = '0x' + Math.max(0, blockNumber - 1000).toString(16)
  const paddedAddr  = padAddr(addr)

  const [sentLogs, recvLogs] = await Promise.all([
    rpc<RawLog[]>('eth_getLogs', [{ fromBlock, toBlock: 'latest', topics: [TRANSFER_TOPIC, paddedAddr] }]).catch(() => [] as RawLog[]),
    rpc<RawLog[]>('eth_getLogs', [{ fromBlock, toBlock: 'latest', topics: [TRANSFER_TOPIC, null, paddedAddr] }]).catch(() => [] as RawLog[]),
  ])

  // Collect unique token addresses — start with full known list
  const tokenSet = new Set<string>(KNOWN_TOKENS.map(t => t.address.toLowerCase()))
  const allLogs = [...sentLogs, ...recvLogs].filter(l => l.topics.length >= 3)
  for (const log of allLogs) tokenSet.add(log.address.toLowerCase())

  const tokenAddrs = Array.from(tokenSet)
  const knownMap   = new Map(KNOWN_TOKENS.map(t => [t.address.toLowerCase(), t]))

  // Batch all balanceOf calls in one request to avoid rate-limit drops
  const balanceCalls = tokenAddrs.map(ta => ({ to: ta, data: balanceOfData(addr) }))
  const balanceResults = await batchEthCall(balanceCalls).catch(() => tokenAddrs.map(() => '0x0'))

  // Fetch symbol() for all non-zero balance tokens:
  //   - Known tokens: verify the on-chain symbol matches what we expect (catches wrong addresses)
  //   - Unknown tokens: discover symbol and decimals
  const nonZeroIdxs = tokenAddrs.reduce<number[]>((a, _, i) => {
    if (decodeBigInt(balanceResults[i]) > 0n) a.push(i)
    return a
  }, [])
  const symCalls = nonZeroIdxs.map(i => ({ to: tokenAddrs[i], data: SEL_SYMBOL }))
  const unknownNonZeroIdxs = nonZeroIdxs.filter(i => !knownMap.has(tokenAddrs[i]))
  const decCalls = unknownNonZeroIdxs.map(i => ({ to: tokenAddrs[i], data: SEL_DECIMALS }))

  const [symResults, decResults] = await Promise.all([
    symCalls.length > 0 ? batchEthCall(symCalls).catch(() => symCalls.map(() => '0x')) : Promise.resolve([]),
    decCalls.length > 0 ? batchEthCall(decCalls).catch(() => decCalls.map(() => '0x')) : Promise.resolve([]),
  ])

  const chainSymMap = new Map<number, string>()
  for (let j = 0; j < nonZeroIdxs.length; j++) {
    const s = decodeAbiString(symResults[j] ?? '0x')
    if (s) chainSymMap.set(nonZeroIdxs[j], s)
  }
  const chainDecMap = new Map<number, number>()
  for (let j = 0; j < unknownNonZeroIdxs.length; j++) {
    chainDecMap.set(unknownNonZeroIdxs[j], decodeUint(decResults[j] ?? '0x12') || 18)
  }

  const tokens: EvmToken[] = []
  for (let i = 0; i < tokenAddrs.length; i++) {
    const ta  = tokenAddrs[i]
    const bal = decodeBigInt(balanceResults[i])
    if (bal === 0n) continue
    const known    = knownMap.get(ta)
    const chainSym = chainSymMap.get(i) ?? ''

    if (known) {
      // Guard against wrong addresses: on-chain symbol must contain or be contained by the expected symbol
      if (chainSym &&
          !chainSym.toLowerCase().includes(known.symbol.toLowerCase()) &&
          !known.symbol.toLowerCase().includes(chainSym.toLowerCase())) continue
      tokens.push({ address: ta, symbol: known.symbol, name: known.name, decimals: known.decimals, balance: bal, formatted: Number(bal) / 10 ** known.decimals, protocol: known.protocol })
    } else {
      const symbol   = chainSym || ta.slice(0, 8) + '…'
      const decimals = chainDecMap.get(i) ?? 18
      tokens.push({ address: ta, symbol, name: symbol, decimals, balance: bal, formatted: Number(bal) / 10 ** decimals, protocol: 'Unknown' })
    }
  }

  // Protocol positions — batch independent calls where possible
  const kHypeToken  = tokens.find(t => t.symbol === 'kHYPE')
  const kmHypeToken = tokens.find(t => t.symbol === 'kmHYPE')
  const wstHypeToken = tokens.find(t => t.symbol === 'wstHYPE')

  const [hyperLendPositions, kHypeUnderlying, kmHypeUnderlying, wstHypeUnderlying] = await Promise.all([
    getHyperLendPositions(addr).catch(() => [] as EvmProtocolPosition[]),
    kHypeToken  ? getKinetiqUnderlying(KHYPE_ACCOUNTANT,  kHypeToken.balance).catch(() => 0)  : Promise.resolve(0),
    kmHypeToken ? getKinetiqUnderlying(KMHYPE_ACCOUNTANT, kmHypeToken.balance).catch(() => 0) : Promise.resolve(0),
    wstHypeToken ? getWstHypeUnderlying(addr, wstHypeToken.balance).catch(() => wstHypeToken.formatted) : Promise.resolve(0),
  ])

  const vaultPositions: EvmProtocolPosition[] = []
  if (kHypeToken && kHypeToken.balance > 0n && kHypeUnderlying > 0) {
    vaultPositions.push({
      protocol: 'Kinetiq', type: 'stake', asset: 'kHYPE → HYPE',
      decimals: 18, amount: kHypeUnderlying, raw: kHypeToken.balance,
    })
  }
  if (kmHypeToken && kmHypeToken.balance > 0n && kmHypeUnderlying > 0) {
    vaultPositions.push({
      protocol: 'Kinetiq', type: 'stake', asset: 'kmHYPE → HYPE',
      decimals: 18, amount: kmHypeUnderlying, raw: kmHypeToken.balance,
    })
  }
  if (wstHypeToken && wstHypeToken.balance > 0n && wstHypeUnderlying > 0) {
    vaultPositions.push({
      protocol: 'StakedHYPE', type: 'vault', asset: 'wstHYPE → HYPE',
      decimals: 18, amount: wstHypeUnderlying, raw: wstHypeToken.balance,
    })
  }

  const protocolPositions = [...hyperLendPositions, ...vaultPositions]

  // Build token metadata map for transfer rendering
  const metaMap = new Map<string, { symbol: string; decimals: number }>()
  for (const t of tokens) metaMap.set(t.address, { symbol: t.symbol, decimals: t.decimals })
  for (const t of KNOWN_TOKENS) {
    if (!metaMap.has(t.address.toLowerCase())) {
      metaMap.set(t.address.toLowerCase(), { symbol: t.symbol, decimals: t.decimals })
    }
  }

  // Transfer list (most recent first, deduped by tx hash)
  const seen = new Set<string>()
  const transfers: EvmTransfer[] = allLogs
    .sort((a, b) => parseInt(b.blockNumber, 16) - parseInt(a.blockNumber, 16))
    .filter(log => {
      const key = log.transactionHash + log.address + log.topics[1] + log.topics[2]
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 150)
    .map(log => {
      const ta   = log.address.toLowerCase()
      const from = '0x' + log.topics[1].slice(26)
      const to   = '0x' + log.topics[2].slice(26)
      const val  = decodeBigInt(log.data)
      const meta = metaMap.get(ta) ?? { symbol: '?', decimals: 18 }
      return {
        txHash:       log.transactionHash,
        blockNumber:  parseInt(log.blockNumber, 16),
        tokenAddress: ta,
        tokenSymbol:  meta.symbol,
        from, to, value: val,
        formatted:    Number(val) / 10 ** meta.decimals,
        decimals:     meta.decimals,
        direction:    to.toLowerCase() === addr ? 'in' : 'out',
      }
    })

  return { nativeBalance, nativeFormatted: Number(nativeBalance) / 1e18, txCount, blockNumber, tokens, protocolPositions, transfers }
}

// ── Formatters ────────────────────────────────────────────────────────────────

export function fmtEvmAmount(amount: number, decimals = 4): string {
  if (amount === 0) return '0'
  if (amount < 0.00001) return '< 0.00001'
  if (amount < 0.01) return amount.toFixed(6)
  return amount.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: 0 })
}

export const HEVM_EXPLORER = 'https://purrsec.com'

// Group protocol positions by protocol name
export function groupByProtocol(positions: EvmProtocolPosition[]): Map<string, EvmProtocolPosition[]> {
  const map = new Map<string, EvmProtocolPosition[]>()
  for (const p of positions) {
    const list = map.get(p.protocol) ?? []
    list.push(p)
    map.set(p.protocol, list)
  }
  return map
}
