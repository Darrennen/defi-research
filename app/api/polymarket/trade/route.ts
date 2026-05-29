import { NextResponse } from 'next/server'
import { ClobClient, Chain, Side, OrderType } from '@polymarket/clob-client-v2'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'

function buildClient() {
  const pk = process.env.POLYMARKET_PRIVATE_KEY
  if (!pk) throw new Error('POLYMARKET_PRIVATE_KEY not set in .env.local')

  const key        = process.env.POLYMARKET_API_KEY
  const secret     = process.env.POLYMARKET_API_SECRET
  const passphrase = process.env.POLYMARKET_API_PASSPHRASE
  if (!key || !secret || !passphrase) {
    throw new Error('API credentials missing. Set POLYMARKET_API_KEY / API_SECRET / API_PASSPHRASE in .env.local')
  }

  const account = privateKeyToAccount(pk as `0x${string}`)
  const walletClient = createWalletClient({ account, chain: polygon, transport: http() })

  return new ClobClient({
    host: 'https://clob.polymarket.com',
    chain: Chain.POLYGON,
    signer: walletClient,
    creds: { key, secret, passphrase },
  })
}

export async function POST(req: Request) {
  const { tokenId, size, price, outcome } = await req.json()

  const isDryRun = process.env.POLYMARKET_DRY_RUN !== 'false'

  if (isDryRun) {
    return NextResponse.json({
      success: true,
      dryRun: true,
      orderId: `DRY-${Date.now()}`,
      message: `DRY RUN: would buy $${size.toFixed(2)} of "${outcome}" at ${price.toFixed(1)}¢`,
    })
  }

  try {
    const client = buildClient()
    const order  = await client.createOrder({
      tokenID: tokenId,
      price:   price / 100,   // cents → 0–1
      size,
      side:    Side.BUY,
    } as any)
    const resp = await client.postOrder(order, OrderType.GTC)
    return NextResponse.json({
      success: true,
      dryRun:  false,
      orderId: resp?.orderID ?? resp?.id ?? null,
      status:  resp?.status ?? null,
    })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message ?? 'Order failed' }, { status: 500 })
  }
}
