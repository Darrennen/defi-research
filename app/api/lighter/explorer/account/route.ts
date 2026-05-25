import { lighterGet, num, LIT_STAKING_POOL } from '@/lib/lighter'

const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const query = (searchParams.get('query') ?? '').trim()

  if (!query) return Response.json({ error: 'query required' }, { status: 400 })

  let by: string
  if (query.startsWith('0x')) {
    if (!ETH_ADDR.test(query)) return Response.json({ error: 'Invalid Ethereum address' }, { status: 400 })
    by = 'l1_address'
  } else {
    if (!/^\d+$/.test(query)) return Response.json({ error: 'Account index must be a number' }, { status: 400 })
    by = 'index'
  }

  try {
    const j = await lighterGet('/account', { by, value: query }, 10)
    const accounts: any[] = j?.accounts ?? []
    const data = accounts[0]
    if (!data) return Response.json({ error: 'Account not found' }, { status: 404 })

    const positions = (data.positions ?? []).filter((p: any) => num(p.position) !== 0)
    const assets = (data.assets ?? []).filter((a: any) => num(a.balance) > 0)
    const litAsset = (data.assets ?? []).find((a: any) => a.symbol === 'LIT')
    const litFree = litAsset ? num(litAsset.balance) : 0
    const stakingShare = (data.shares ?? []).find((s: any) => s.public_pool_index === LIT_STAKING_POOL)

    return Response.json({
      account_index: data.account_index ?? data.index,
      l1_address: data.l1_address ?? '',
      collateral: data.collateral ?? '0',
      available_balance: data.available_balance ?? '0',
      total_asset_value: data.total_asset_value ?? '0',
      cross_asset_value: data.cross_asset_value ?? '0',
      cross_initial_margin_requirement: data.cross_initial_margin_requirement ?? '0',
      cross_maintenance_margin_requirement: data.cross_maintenance_margin_requirement ?? '0',
      status: data.status ?? 0,
      pending_order_count: data.pending_order_count ?? 0,
      total_order_count: data.total_order_count ?? 0,
      name: data.name ?? '',
      positions,
      assets,
      lit_staking: {
        is_staking: stakingShare != null,
        staked_usdc_value: stakingShare ? num(stakingShare.principal_amount) : 0,
        shares_amount: stakingShare?.shares_amount ?? 0,
        entry_usdc: stakingShare ? num(stakingShare.entry_usdc ?? 0) : 0,
        pending_unlocks: data.pending_unlocks ?? [],
        lit_free_balance: litFree,
      },
    })
  } catch (e: any) {
    const status = e.message?.includes('404') ? 404 : 500
    return Response.json({ error: e.message }, { status })
  }
}
