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
    const d = (hex.startsWith('0x') ? hex.slice(2) : hex)
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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EvmToken {
  address: string
  symbol: string
  decimals: number
  balance: bigint
  formatted: number
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

const KNOWN_TOKENS = [
  { address: '0x5555555555555555555555555555555555555555', symbol: 'WHYPE', decimals: 18 },
  { address: '0x1fD3a8A9E1Dd00D53c7E58e27F2f70c22Ab6b3f3', symbol: 'USDC',  decimals: 6  },
  { address: '0xBe6427E8c3bbb976c50d7f7b4DFe0b97E8E2d17',  symbol: 'UBTC',  decimals: 8  },
]

// ── Main fetcher ──────────────────────────────────────────────────────────────

export async function fetchEvmWallet(address: string): Promise<EvmWalletData> {
  const addr = address.toLowerCase()

  // Core info
  const [blockHex, balHex, nonceHex] = await Promise.all([
    rpc<string>('eth_blockNumber', []),
    rpc<string>('eth_getBalance', [addr, 'latest']),
    rpc<string>('eth_getTransactionCount', [addr, 'latest']),
  ])

  const blockNumber = parseInt(blockHex, 16)
  const nativeBalance = decodeBigInt(balHex)
  const txCount = parseInt(nonceHex, 16)

  // Discover tokens via ERC-20 Transfer events (~100k blocks ≈ 2–3 days on HyperEVM)
  const fromBlock = '0x' + Math.max(0, blockNumber - 100_000).toString(16)
  const paddedAddr = padAddr(addr)

  const [sentLogs, recvLogs] = await Promise.all([
    rpc<RawLog[]>('eth_getLogs', [{ fromBlock, toBlock: 'latest', topics: [TRANSFER_TOPIC, paddedAddr] }]).catch(() => [] as RawLog[]),
    rpc<RawLog[]>('eth_getLogs', [{ fromBlock, toBlock: 'latest', topics: [TRANSFER_TOPIC, null, paddedAddr] }]).catch(() => [] as RawLog[]),
  ])

  // Collect unique token contract addresses
  const tokenSet = new Set<string>(KNOWN_TOKENS.map(t => t.address.toLowerCase()))
  const allLogs = [...sentLogs, ...recvLogs].filter(l => l.topics.length >= 3)
  for (const log of allLogs) tokenSet.add(log.address.toLowerCase())

  const tokenAddrs = Array.from(tokenSet)
  const knownMap = new Map(KNOWN_TOKENS.map(t => [t.address.toLowerCase(), t]))

  // Query balance + metadata for each token
  const tokenResults = await Promise.all(tokenAddrs.map(async ta => {
    const known = knownMap.get(ta)
    const balResult = await rpc<string>('eth_call', [{ to: ta, data: balanceOfData(addr) }, 'latest']).catch(() => '0x0')
    const bal = decodeBigInt(balResult)
    if (bal === 0n) return null

    let symbol   = known?.symbol   ?? ''
    let decimals = known?.decimals ?? 18

    if (!known) {
      const [symHex, decHex] = await Promise.all([
        rpc<string>('eth_call', [{ to: ta, data: SEL_SYMBOL   }, 'latest']).catch(() => '0x'),
        rpc<string>('eth_call', [{ to: ta, data: SEL_DECIMALS }, 'latest']).catch(() => '0x12'),
      ])
      symbol   = decodeAbiString(symHex) || ta.slice(0, 8) + '…'
      decimals = decodeUint(decHex) || 18
    }

    return {
      address: ta,
      symbol,
      decimals,
      balance: bal,
      formatted: Number(bal) / Math.pow(10, decimals),
    } as EvmToken
  }))

  const tokens = tokenResults.filter((t): t is EvmToken => t !== null)

  // Build token metadata map for rendering transfers
  const metaMap = new Map<string, { symbol: string; decimals: number }>()
  for (const t of tokens) metaMap.set(t.address, { symbol: t.symbol, decimals: t.decimals })
  for (const t of KNOWN_TOKENS) {
    if (!metaMap.has(t.address.toLowerCase())) {
      metaMap.set(t.address.toLowerCase(), { symbol: t.symbol, decimals: t.decimals })
    }
  }

  // Build sorted transfer list (most recent first)
  const transfers: EvmTransfer[] = allLogs
    .sort((a, b) => parseInt(b.blockNumber, 16) - parseInt(a.blockNumber, 16))
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
        from,
        to,
        value:        val,
        formatted:    Number(val) / Math.pow(10, meta.decimals),
        decimals:     meta.decimals,
        direction:    to.toLowerCase() === addr ? 'in' : 'out',
      }
    })

  return { nativeBalance, nativeFormatted: Number(nativeBalance) / 1e18, txCount, blockNumber, tokens, transfers }
}

// ── Formatters ────────────────────────────────────────────────────────────────

export function fmtEvmAmount(amount: number, decimals = 4): string {
  if (amount === 0) return '0'
  if (amount < 0.0001) return '< 0.0001'
  return amount.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: 0 })
}

export const HEVM_EXPLORER = 'https://purrsec.com'
