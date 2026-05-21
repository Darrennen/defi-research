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

const TOKENS = 'USDC|USDT|ETH|BTC|WBTC|WETH|DAI|FRAX|sDAI|cbBTC|cbETH|rETH|weETH|rsETH|stETH|LUSD|BUSD|UNI|LINK|AAVE|GHO|crvUSD'
const MULTIPLIERS: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 }

const MIN_WHALE_USD = 50_000  // ignore anything under $50K

export function isArkhamAlert(parsed: Partial<WhaleAlert>): boolean {
  // Must have a meaningful amount (>= $50K) or a tx hash with a chain
  if (parsed.amount && parsed.amount >= MIN_WHALE_USD) return true
  if (parsed.txHash && parsed.chain) return true
  return false
}

export function parseArkhamAlert(text: string): Partial<WhaleAlert> {
  const clean = stripSlack(text)
  const out: Partial<WhaleAlert> = {}

  // Amount: "$4.2M USDC" or "4,200,000 USDC" — require $ sign OR multiplier OR 5+ digit number to avoid matching "4 ETH" noise
  const amtRe = new RegExp(
    `(?:\\$([\\d,]+(?:\\.\\d+)?)\\s*([KMBkmb])?|([\\d,]+(?:\\.\\d+)?)\\s*([KMBkmb])(?=\\s)|([\\d]{5,}(?:,[\\d]{3})*(?:\\.\\d+)?)\\s*([KMBkmb])?)\\s+(${TOKENS})`,
    'i'
  )
  const amtMatch = clean.match(amtRe)
  if (amtMatch) {
    // groups: (1,$num)(2,mult) | (3,num)(4,mult) | (5,num)(6,mult) then (7,token)
    const rawNum = amtMatch[1] ?? amtMatch[3] ?? amtMatch[5] ?? '0'
    const rawMult = amtMatch[2] ?? amtMatch[4] ?? amtMatch[6] ?? ''
    const num = parseFloat(rawNum.replace(/,/g, ''))
    const mult = MULTIPLIERS[rawMult.toUpperCase()] ?? 1
    out.amount = num * mult
    out.token = amtMatch[7].toUpperCase()
    out.amountFmt = fmtAmount(out.amount)
  }

  // Chain
  const chainRe = /\b(Ethereum|Arbitrum|Base|Polygon|Optimism|Avalanche|BSC|Solana|Tron|Bitcoin)\b/i
  const chainMatch = clean.match(chainRe)
  if (chainMatch) out.chain = chainMatch[1]

  // Tx hash (64-char hex) — txUrl is always constructed from our whitelist, never from message text
  const txMatch = clean.match(/0x[a-fA-F0-9]{64}/)
  if (txMatch) {
    out.txHash = txMatch[0]
    const key = (out.chain ?? 'ethereum').toLowerCase()
    const base = CHAIN_EXPLORERS[key] ?? CHAIN_EXPLORERS.ethereum
    const url = base + txMatch[0]
    // Final guard: only store URLs that start with a known explorer domain
    const allowed = Object.values(CHAIN_EXPLORERS)
    if (allowed.some(prefix => url.startsWith(prefix))) {
      out.txUrl = url
    }
  }

  // Wallet address (40-char hex, skip tx hashes)
  const addrMatches = clean.match(/0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g)
  if (addrMatches) out.address = addrMatches[0]

  // Direction
  if (/\b(sent|transferred|moved|outflow)\b/i.test(clean)) out.direction = 'transferred'
  if (/\b(deposited|received|inflow)\b/i.test(clean)) out.direction = 'received'
  if (/\b(withdrew|withdrawal|withdrawn)\b/i.test(clean)) out.direction = 'withdrew'

  // Entity — text before verb
  const entityRe = /(?:^|[\n])\s*(?:[🐋⚠️🔔💰🚨⬆️⬇️]+\s*)?(?:Alert[:\s]+)?([A-Z][A-Za-z0-9 \-\.&']+?)(?:\s+(?:moved|sent|transferred|deposited|withdrew|received|flagged))/m
  const entityMatch = clean.match(entityRe)
  if (entityMatch) out.entity = entityMatch[1].trim()

  // From/To labels
  const fromMatch = clean.match(/From[:\s]+([^\n]+)/i)
  const toMatch = clean.match(/To[:\s]+([^\n]+)/i)
  if (fromMatch) out.fromLabel = fromMatch[1].trim()
  if (toMatch) out.toLabel = toMatch[1].trim()

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
