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

const EXPLORER_HOSTS = [
  'etherscan.io',
  'arbiscan.io',
  'basescan.org',
  'polygonscan.com',
  'optimistic.etherscan.io',
  'snowtrace.io',
  'bscscan.com',
  'solscan.io',
]

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

function fmtAmount(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

const MIN_WHALE_USD = 50_000

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

const ENTITY_BLOCKLIST = [
  'pause', 'null address', 'unknown', 'view on arkham', 'view on etherscan',
]

function cleanEntity(entity: string | undefined): string | undefined {
  if (!entity) return undefined
  // Drop Arkham "(Copy)" custom labels — they're duplicates, not real whales
  if (/\(copy\)/i.test(entity)) return undefined
  // Drop blocklisted names
  if (ENTITY_BLOCKLIST.some(b => entity.toLowerCase() === b)) return undefined
  return entity
}

export function isArkhamAlert(parsed: Partial<WhaleAlert>): boolean {
  if (parsed.amount && parsed.amount >= MIN_WHALE_USD) return true
  if (parsed.txHash && parsed.chain) return true
  return false
}

// Parse Arkham bot messages that use Slack mrkdwn <url|label> link format.
// All entity names, addresses, and tx hashes live inside those link tokens —
// never in plain text — so we work against the raw Slack text, not stripped text.
export function parseArkhamAlert(text: string): Partial<WhaleAlert> {
  const out: Partial<WhaleAlert> = {}

  // ── Title: must be the very first token in the message ───────────────
  // Anchored to ^ so we never match the "Pause Alert" footer CTA link
  const titleMatch = text.match(/^<[^|>]+\|([^>]+?)\s+(?:Whale\s+)?Alert>/)
  if (titleMatch) out.entity = titleMatch[1].trim()

  // ── From line ─────────────────────────────────────────────────────
  const fromLineRaw = text.match(/From:[^\n]*/i)?.[0] ?? ''
  // Named entity link: <intel.arkm.com/explorer/entity/...|Name>
  const fromEntityMatch = fromLineRaw.match(
    /<https?:\/\/intel\.arkm\.com\/explorer\/entity\/[^|>]+\|([^>]+)>/
  )
  if (fromEntityMatch && !/^unknown$/i.test(fromEntityMatch[1]) && !out.entity) {
    out.entity = fromEntityMatch[1].trim()
  }
  // Address link: <intel.arkm.com/explorer/address/0xFULL|Label (0xShort)>
  const fromAddrMatch = fromLineRaw.match(
    /<https?:\/\/intel\.arkm\.com\/explorer\/address\/(0x[a-fA-F0-9]+)\|([^>]+)>/
  )
  if (fromAddrMatch) {
    const addr = fromAddrMatch[1]
    if (!/^0x0+$/.test(addr)) out.address = addr
    const label = fromAddrMatch[2].replace(/\s*\(0x[a-fA-F0-9]+\)\s*$/, '').trim()
    out.fromLabel = label
    // Only use from-label as entity if the title gave us nothing
    if (label && !/^unknown$/i.test(label) && !out.entity) out.entity = label
  }

  // ── To line ───────────────────────────────────────────────────────
  const toLineRaw = text.match(/To:[^\n]*/i)?.[0] ?? ''
  const toAddrMatch = toLineRaw.match(
    /<https?:\/\/intel\.arkm\.com\/explorer\/address\/[^|>]+\|([^>]+)>/
  )
  if (toAddrMatch) {
    out.toLabel = toAddrMatch[1].replace(/\s*\(0x[a-fA-F0-9]+\)\s*$/, '').trim()
  }
  // Also accept entity links in To line
  const toEntityMatch = toLineRaw.match(
    /<https?:\/\/intel\.arkm\.com\/explorer\/entity\/[^|>]+\|([^>]+)>/
  )
  if (toEntityMatch && !out.toLabel) {
    out.toLabel = toEntityMatch[1].trim()
  }

  // ── Value: N TokenName ($N) ───────────────────────────────────────
  const valueMatch = text.match(/Value:\s+[\d,\.]+\s+(.+?)\s+\(\$([0-9,]+(?:\.[0-9]+)?)\)/)
  if (valueMatch) {
    out.amount = parseFloat(valueMatch[2].replace(/,/g, ''))
    out.amountFmt = fmtAmount(out.amount)
    const name = valueMatch[1].trim().toLowerCase()
    out.token = TOKEN_NAMES[name] ?? valueMatch[1].trim().toUpperCase()
  }

  // ── Network ───────────────────────────────────────────────────────
  const networkMatch = text.match(/Network:\s+([^\n<]+)/i)
  if (networkMatch) out.chain = networkMatch[1].trim()

  // ── Arkham tx URL: <intel.arkm.com/explorer/tx/0xHASH|...> ───────
  const arkhamTxMatch = text.match(
    /<(https?:\/\/intel\.arkm\.com\/explorer\/tx\/(0x[a-fA-F0-9]{64}))[^>]*>/
  )
  if (arkhamTxMatch) {
    out.arkhamUrl = arkhamTxMatch[1]
    out.txHash = arkhamTxMatch[2]
  }

  // ── Explorer tx URL (Etherscan, Arbiscan, etc.) ───────────────────
  const explorerPattern = new RegExp(
    `<(https?://(?:${EXPLORER_HOSTS.map(h => h.replace(/\./g, '\\.')).join('|')})/tx/[^|> ]+)`
  )
  const explorerMatch = text.match(explorerPattern)
  if (explorerMatch) {
    out.txUrl = explorerMatch[1]
    if (!out.txHash) {
      const hashFromUrl = out.txUrl.match(/\/tx\/(0x[a-fA-F0-9]{64})/)
      if (hashFromUrl) out.txHash = hashFromUrl[1]
    }
  }

  out.direction = 'transferred'
  out.entity = cleanEntity(out.entity)
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
  if (ev?.type === 'message' && ev.subtype !== 'message_deleted' && ev.subtype !== 'message_changed' && ev.text?.length > 10) {
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
