import { NextRequest, NextResponse } from 'next/server'

const HEVM_RPC = 'https://rpc.hyperliquid.xyz/evm'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const r = await fetch(HEVM_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data: unknown
  try {
    data = await r.json()
  } catch {
    // HyperEVM returned non-JSON (e.g., rate-limit HTML page)
    data = { jsonrpc: '2.0', id: null, error: { code: -32000, message: `Upstream HTTP ${r.status}` } }
  }
  return NextResponse.json(data, { status: r.status })
}
