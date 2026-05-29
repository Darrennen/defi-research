import { NextResponse } from 'next/server'
import { ClobClient, Chain, OpenOrder, Trade } from '@polymarket/clob-client-v2'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'

export interface PositionsData {
  configured: boolean
  dryRun:     boolean
  orders:     OpenOrder[]
  trades:     Trade[]
  error?:     string
}

export async function GET(): Promise<NextResponse<PositionsData>> {
  const isDryRun   = process.env.POLYMARKET_DRY_RUN !== 'false'
  const pk         = process.env.POLYMARKET_PRIVATE_KEY
  const key        = process.env.POLYMARKET_API_KEY
  const secret     = process.env.POLYMARKET_API_SECRET
  const passphrase = process.env.POLYMARKET_API_PASSPHRASE

  if (!pk || !key || !secret || !passphrase) {
    return NextResponse.json({ configured: false, dryRun: isDryRun, orders: [], trades: [] })
  }

  try {
    const account = privateKeyToAccount(pk as `0x${string}`)
    const walletClient = createWalletClient({ account, chain: polygon, transport: http() })

    const client = new ClobClient({
      host: 'https://clob.polymarket.com',
      chain: Chain.POLYGON,
      signer: walletClient,
      creds: { key, secret, passphrase },
    })

    const [orders, trades] = await Promise.all([
      client.getOpenOrders(),
      client.getTrades({ page_size: 20 } as any),
    ])

    return NextResponse.json({
      configured: true,
      dryRun:     isDryRun,
      orders:     orders ?? [],
      trades:     (trades ?? []).slice(0, 20),
    })
  } catch (err: any) {
    return NextResponse.json({ configured: true, dryRun: isDryRun, orders: [], trades: [], error: err?.message })
  }
}
