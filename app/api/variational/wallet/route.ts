import { NextRequest, NextResponse } from 'next/server'

const USDC    = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
const ORACLE  = '0x84be56470d45b7f6629a66a219a38681f6ba6172'
const OLP     = '0x74bbbb0e7f0bad6938509dd4b556a39a4db1f2cd'
const VAR_ADDRS = [ORACLE, OLP]

type RawTx = {
  hash: string; timeStamp: string; from: string; to: string
  value: string; tokenDecimal: string; blockNumber: string
}

function toUsdc(value: string, dec: string) {
  return parseFloat(value) / Math.pow(10, parseInt(dec || '6', 10))
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')?.toLowerCase()
  const apiKey  = searchParams.get('apiKey') || 'YourApiKeyToken'

  if (!address || !/^0x[0-9a-f]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  const url = `https://api.etherscan.io/v2/api?chainid=42161&module=account&action=tokentx` +
    `&contractaddress=${USDC}&address=${address}&sort=asc&apikey=${apiKey}`

  try {
    const r = await fetch(url, { next: { revalidate: 60 } })
    const data = await r.json()

    if (data.status === '0' && data.message !== 'No transactions found') {
      return NextResponse.json({ error: data.result ?? data.message }, { status: 400 })
    }

    const txs: RawTx[] = data.result ?? []

    const deposits    = txs.filter(t => VAR_ADDRS.includes(t.to.toLowerCase())   && !VAR_ADDRS.includes(t.from.toLowerCase()))
    const withdrawals = txs.filter(t => VAR_ADDRS.includes(t.from.toLowerCase()) && !VAR_ADDRS.includes(t.to.toLowerCase()))

    const totalDeposited  = deposits.reduce((s, t)    => s + toUsdc(t.value, t.tokenDecimal), 0)
    const totalWithdrawn  = withdrawals.reduce((s, t) => s + toUsdc(t.value, t.tokenDecimal), 0)

    const activity = [
      ...deposits.map(t => ({
        ts: parseInt(t.timeStamp, 10) * 1000,
        hash: t.hash,
        action: 'Deposit' as const,
        usdc: toUsdc(t.value, t.tokenDecimal),
        counterparty: t.to,
      })),
      ...withdrawals.map(t => ({
        ts: parseInt(t.timeStamp, 10) * 1000,
        hash: t.hash,
        action: 'Withdrawal' as const,
        usdc: toUsdc(t.value, t.tokenDecimal),
        counterparty: t.from,
      })),
    ].sort((a, b) => b.ts - a.ts)

    const sorted = [...txs].sort((a, b) => parseInt(a.timeStamp) - parseInt(b.timeStamp))
    return NextResponse.json({
      address,
      totalDeposited,
      totalWithdrawn,
      netPnl: totalWithdrawn - totalDeposited,
      depositCount: deposits.length,
      withdrawalCount: withdrawals.length,
      firstActivity: sorted.length ? parseInt(sorted[0].timeStamp, 10) * 1000 : null,
      lastActivity: sorted.length ? parseInt(sorted[sorted.length - 1].timeStamp, 10) * 1000 : null,
      activity,
    })
  } catch {
    return NextResponse.json({ error: 'Fetch failed' }, { status: 500 })
  }
}
