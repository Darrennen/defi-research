import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { redis, WHALE_ALERTS_KEY, MAX_ALERTS } from '@/lib/redis'

export interface WhaleAlert {
  id: string
  ts: number
  raw: string
  entity?: string
  address?: string
  amount?: number
  amountFmt?: string
  token?: string
  chain?: string
  txHash?: string
  txUrl?: string
  arkhamUrl?: string
  direction?: string
  fromLabel?: string
  toLabel?: string
}

const CHAIN_EXPLORERS: Record<string, string> = {
  ethereum: 'https://etherscan.io/tx/',
  eth: 'https://etherscan.io/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
  base: 'https://basescan.org/tx/',
  polygon: 'https://polygonscan.com/tx/',
  optimism: 'https://optimistic.etherscan.io/tx/',
  avalanche: 'https://snowtrace.io/tx/',
  bsc: 'https://bscscan.com/tx/',
  solana: 'https://solscan.io/tx/',
}

function verifySlackSignature(body: string, timestamp: string, signature: string): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET
  if (!secret) return false
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
  const base = `v0:${timestamp}:${body}`
  const hmac = createHmac('sha256', secret).update(base).digest('hex')
  const expected = Buffer.from(`v0=${hmac}`)
  const received = Buffer.from(signature)
  if (expected.length !== received.length) return false
  return timingSafeEqual(expected, received)
}

function stripSlack(text: string): string {
  return text
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
}

function fmtAmount(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

const MIN_WHALE_USD = 50_000

// Full token name → symbol map (Arkham uses full names in Value field)
const TOKEN_NAMES: Record<string, string> = {
  'usd coin': 'USDC', 'tether': 'USDT', 'tether usd': 'USDT',
  'ethereum': 'ETH', 'wrapped ether': 'WETH', 'wrapped eth': 'WETH',
  'bitcoin': 'BTC', 'wrapped bitcoin': 'WBTC',
  'dai': 'DAI', 'staked ether': 'stETH', 'lido staked ether': 'stETH',
  'uniswap': 'UNI', 'chainlink': 'LINK', 'aave': 'AAVE',
  'coinbase wrapped staked eth': 'cbETH', 'coinbase wrapped btc': 'cbBTC',
  'rocket pool eth': 'rETH', 'frax': 'FRAX', 'curve usd': 'crvUSD',
  'gho': 'GHO', 'lusd': 'LUSD', 'susde': 'sUSDe', 'usde': 'USDe',
}

export function isArkhamAlert(parsed: Partial<WhaleAlert>): boolean {
  if (parsed.amount && parsed.amount >= MIN_WHALE_USD) return true
  if (parsed.txHash && parsed.chain) return true
  return false
}

export function parseArkhamAlert(text: string): Partial<WhaleAlert> {
  const out: Partial<WhaleAlert> = {}

  // ── Extract URLs from raw Slack text BEFORE stripping ──────────────
  // Arkham sends: <https://platform.arkhamintelligence.com/...|View on Arkham>
  const arkhamRaw = text.match(/<(https:\/\/platform\.arkhamintelligence\.com\/[^|>]+)/)
  if (arkhamRaw) out.arkhamUrl = arkhamRaw[1]

  const explorerDomains = Object.values(CHAIN_EXPLORERS).map(u => u.replace('https://', '').split('/')[0])
  const explorerPattern = new RegExp(`<(https://(?:${explorerDomains.join('|').replace(/\./g, '\\.')})\/[^|>]+)`)
  const explorerRaw = text.match(explorerPattern)
  if (explorerRaw) out.txUrl = explorerRaw[1]

  // Also extract tx hash from the Etherscan URL if present
  if (out.txUrl) {
    const hashFromUrl = out.txUrl.match(/\/tx\/(0x[a-fA-F0-9]{64})/)
    if (hashFromUrl) out.txHash = hashFromUrl[1]
  }

  const clean = stripSlack(text)
  const lines = clean.split('\n').map(l => l.trim()).filter(Boolean)

  // ── Line 1: "{Name} Whale Alert" → entity ──────────────────────────
  const titleLine = lines[0] ?? ''
  const titleMatch = titleLine.match(/^(.+?)\s+(?:Whale\s+)?Alert$/i)
  if (titleMatch) out.entity = titleMatch[1].trim()

  // ── From: [CUSTOM] Label (0xShort) ────────────────────────────────
  const fromLine = lines.find(l => /^From:/i.test(l))
  if (fromLine) {
    const m = fromLine.match(/^From:\s+(?:\[.*?\]\s*)?(.+?)(?:\s*\([^)]*\))?$/i)
    if (m) {
      out.fromLabel = m[1].trim()
      // Use From label as entity (more specific than alert title)
      if (out.fromLabel && !/^unknown$/i.test(out.fromLabel)) {
        out.entity = out.fromLabel
      }
    }
  }

  // ── To: [CUSTOM] Label (0xShort) ──────────────────────────────────
  const toLine = lines.find(l => /^To:/i.test(l))
  if (toLine) {
    const m = toLine.match(/^To:\s+(?:\[.*?\]\s*)?(.+?)(?:\s*\([^)]*\))?$/i)
    if (m) out.toLabel = m[1].trim()
  }

  // ── Value: 200,000.000000 USD Coin ($200,000.00) ───────────────────
  const valueLine = lines.find(l => /^Value:/i.test(l))
  if (valueLine) {
    // Dollar amount from parenthetical ($200,000.00)
    const usdMatch = valueLine.match(/\(\$([0-9,]+(?:\.[0-9]+)?)\)/)
    if (usdMatch) {
      out.amount = parseFloat(usdMatch[1].replace(/,/g, ''))
      out.amountFmt = fmtAmount(out.amount)
    }
    // Token name: text between number and opening paren
    const tokenMatch = valueLine.match(/Value:\s+[\d,\.]+\s+(.+?)\s+\(/i)
    if (tokenMatch) {
      const name = tokenMatch[1].trim().toLowerCase()
      out.token = TOKEN_NAMES[name] ?? tokenMatch[1].trim().toUpperCase()
    }
  }

  // ── Network: Ethereum ─────────────────────────────────────────────
  const networkLine = lines.find(l => /^Network:/i.test(l))
  if (networkLine) {
    const m = networkLine.match(/^Network:\s+(.+)$/i)
    if (m) out.chain = m[1].trim()
  }

  // ── Direction: infer from alert title or context ───────────────────
  out.direction = 'transferred'

  return out
}

export async function POST(req: NextRequest) {
  const body = await req.text()
  const timestamp = req.headers.get('x-slack-request-timestamp') ?? ''
  const signature = req.headers.get('x-slack-signature') ?? ''

  if (!verifySlackSignature(body, timestamp, signature)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const payload = JSON.parse(body)

  // Slack URL verification handshake
  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge })
  }

  const ev = payload.event
  if (ev?.type === 'message' && !ev.subtype && ev.text?.length > 10) {
    const parsed = parseArkhamAlert(ev.text)
    // Only store if it looks like a real Arkham alert
    if (!isArkhamAlert(parsed)) return NextResponse.json({ ok: true })

    const ts = Math.floor(parseFloat(ev.ts) * 1000)
    const alert: WhaleAlert = { id: ev.ts, ts, raw: ev.text, ...parsed }

    await redis.zadd(WHALE_ALERTS_KEY, { score: ts, member: JSON.stringify(alert) })

    const count = await redis.zcard(WHALE_ALERTS_KEY)
    if (count > MAX_ALERTS) {
      await redis.zremrangebyrank(WHALE_ALERTS_KEY, 0, count - MAX_ALERTS - 1)
    }
  }

  return NextResponse.json({ ok: true })
}
