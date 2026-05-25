let _cache: any = null
let _cacheTs = 0
const TTL = 300_000   // 5 min

const BUYBACKS_WS = 'wss://lighterliquidations.store/ws'

async function fetchBuybacksWs(): Promise<any> {
  return new Promise((resolve, reject) => {
    // Node 21+ has globalThis.WebSocket; older versions don't
    const WS = (globalThis as any).WebSocket
    if (!WS) { reject(new Error('WebSocket not available')); return }

    const ws = new WS(BUYBACKS_WS)
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')) }, 10_000)

    ws.onmessage = (ev: any) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
        if (msg?.type === 'buybacks_update') {
          clearTimeout(timeout)
          ws.close()
          resolve(msg.data ?? {})
        }
      } catch {}
    }
    ws.onerror = () => { clearTimeout(timeout); reject(new Error('ws error')) }
    ws.onclose = () => { clearTimeout(timeout) }
  })
}

export async function GET() {
  const now = Date.now()
  if (_cache && now - _cacheTs < TTL) return Response.json(_cache)

  try {
    const data = await fetchBuybacksWs()
    if (data && (data.stats || data.balances)) {
      _cache = data; _cacheTs = now
      return Response.json(data)
    }
    // Return stale cache if fetch succeeded but data was empty
    if (_cache) return Response.json(_cache)
    return Response.json({ stats: [], balances: {}, error: 'no data received' })
  } catch (e: any) {
    // Return stale cache on error
    if (_cache) return Response.json(_cache)
    return Response.json({ stats: [], balances: {}, error: e.message }, { status: 503 })
  }
}
