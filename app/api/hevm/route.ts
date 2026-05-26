import { NextRequest, NextResponse } from 'next/server'

const HEVM_RPC = 'https://rpc.hyperliquid.xyz/evm'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const r = await fetch(HEVM_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await r.json()
  return NextResponse.json(data, { status: r.status })
}
