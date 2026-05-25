import { lighterGet, num, LIT_STAKING_POOL } from '@/lib/lighter'

function parseTs(raw: unknown): number {
  if (raw == null) return 0
  if (typeof raw === 'number') return raw > 1e10 ? raw : raw * 1000
  if (typeof raw === 'string') {
    const n = Number(raw)
    if (!isNaN(n)) return n > 1e10 ? n : n * 1000
    try { return new Date(raw).getTime() } catch { return 0 }
  }
  return 0
}

function parseAmount(t: any): number {
  for (const key of ['principal_amount', 'amount', 'usdc_amount', 'value']) {
    if (t[key] != null) { const n = num(t[key]); if (n > 0) return n }
  }
  return 0
}

function window(events: any[], cutoffMs: number) {
  const w = events.filter(e => e.ts_ms >= cutoffMs)
  const stakes = w.filter(e => e.type === 'stake')
  const unstakes = w.filter(e => e.type === 'unstake')
  return {
    stakes: stakes.length,
    unstakes: unstakes.length,
    stake_usd: stakes.reduce((s, e) => s + e.amount, 0),
    unstake_usd: unstakes.reduce((s, e) => s + e.amount, 0),
    net_usd: stakes.reduce((s, e) => s + e.amount, 0) - unstakes.reduce((s, e) => s + e.amount, 0),
    unique_accounts: new Set(w.map(e => e.account_id)).size,
  }
}

export async function GET() {
  try {
    const j = await lighterGet('/transfer/history', { account_index: LIT_STAKING_POOL, limit: 100 }, 120)
    const raw: any[] = Array.isArray(j) ? j : (j?.transfers ?? j?.data ?? j?.history ?? [])

    const events = raw.flatMap((t: any) => {
      const tsMs = parseTs(t.created_at ?? t.timestamp ?? t.time ?? 0)
      const evType = String(t.type ?? '').toLowerCase()
      const isStake = evType.includes('mint')
      const isUnstake = evType.includes('burn')
      if (!isStake && !isUnstake) return []
      const amount = parseAmount(t)
      const accountId = Number(t.account_index ?? t.user_account_index ?? 0)
      return [{ type: isStake ? 'stake' : 'unstake', ts_ms: tsMs, amount, account_id: accountId }]
    })

    const now = Date.now()
    return Response.json({
      h24: window(events, now - 86_400_000),
      h168: window(events, now - 7 * 86_400_000),
      total_events: events.length,
      raw_count: raw.length,
      ts: now,
    })
  } catch (e: any) {
    const empty = { stakes: 0, unstakes: 0, stake_usd: 0, unstake_usd: 0, net_usd: 0, unique_accounts: 0 }
    return Response.json({ h24: empty, h168: empty, total_events: 0, raw_count: 0, ts: Date.now(), error: e.message }, { status: 500 })
  }
}
