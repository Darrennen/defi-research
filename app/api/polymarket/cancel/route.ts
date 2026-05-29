import { NextResponse } from 'next/server'
import { ClobClient, Chain } from '@polymarket/clob-client-v2'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'

export async function POST() {
  const isDryRun = process.env.POLYMARKET_DRY_RUN !== 'false'

  if (isDryRun) {
    return NextResponse.json({ success: true, dryRun: true, message: 'DRY RUN: no live orders to cancel' })
  }

  const pk         = process.env.POLYMARKET_PRIVATE_KEY
  const key        = process.env.POLYMARKET_API_KEY
  const secret     = process.env.POLYMARKET_API_SECRET
  const passphrase = process.env.POLYMARKET_API_PASSPHRASE

  if (!pk || !key || !secret || !passphrase) {
    return NextResponse.json({ success: false, error: 'Bot credentials not configured' }, { status: 500 })
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

    const resp = await client.cancelAll()
    return NextResponse.json({ success: true, dryRun: false, result: resp })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message ?? 'Cancel failed' }, { status: 500 })
  }
}
