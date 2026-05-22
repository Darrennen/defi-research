'use client'

export function CoinLogo({ geckoId, symbol }: { geckoId: string; symbol: string }) {
  return (
    <img
      src={`https://icons.llamao.fi/icons/pegged/${geckoId}`}
      alt={symbol}
      width={16}
      height={16}
      style={{ borderRadius: '50%', flexShrink: 0 }}
      onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
    />
  )
}
