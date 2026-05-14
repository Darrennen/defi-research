'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const links = [
  { href: '/stablecoins',   label: 'Stablecoins' },
  { href: '/treasuries',    label: 'Treasuries' },
  { href: '/lending',       label: 'Lending' },
  { href: '/aave',          label: 'Aave V3' },
  { href: '/hyperlend',     label: 'HyperLend' },
  { href: '/yield-tracker', label: 'Yield Tracker' },
]

function DnaLogo() {
  return (
    <svg width="20" height="26" viewBox="0 0 20 26" fill="none">
      <line x1="2" y1="6.5"  x2="18" y2="6.5"  stroke="#4d5478" strokeWidth="1.4" strokeLinecap="round"/>
      <line x1="2" y1="13"   x2="18" y2="13"   stroke="#4d5478" strokeWidth="1.4" strokeLinecap="round"/>
      <line x1="2" y1="19.5" x2="18" y2="19.5" stroke="#4d5478" strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M2 1.5 C2 1.5,18 8,18 13 C18 18,2 24.5,2 24.5" stroke="#7b8fe8" strokeWidth="2.4" strokeLinecap="round" fill="none"/>
      <path d="M18 1.5 C18 1.5,2 8,2 13 C2 18,18 24.5,18 24.5" stroke="#e8e3d0" strokeWidth="2.4" strokeLinecap="round" fill="none"/>
      <circle cx="2"  cy="1.5"  r="1.8" fill="#7b8fe8"/>
      <circle cx="18" cy="24.5" r="1.8" fill="#7b8fe8"/>
      <circle cx="18" cy="1.5"  r="1.8" fill="#e8e3d0"/>
      <circle cx="2"  cy="24.5" r="1.8" fill="#e8e3d0"/>
    </svg>
  )
}

export default function Nav() {
  const pathname = usePathname()

  return (
    <nav
      className="sticky top-0 z-50 border-b"
      style={{ background: 'rgba(19,22,40,0.93)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', borderColor: '#2a3055' }}
    >
      <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2.5 shrink-0 no-underline">
          <DnaLogo />
          <div className="flex items-baseline gap-1.5">
            <span style={{ color: '#e8e4dc', fontWeight: 700, fontSize: 15, letterSpacing: '-0.01em' }}>DNA</span>
            <span style={{ color: '#5c6480', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Research</span>
          </div>
        </Link>

        <div className="flex items-center overflow-x-auto" style={{ gap: 2 }}>
          {links.map((l) => {
            const active = pathname === l.href || (l.href !== '/' && pathname.startsWith(l.href))
            return (
              <Link
                key={l.href}
                href={l.href}
                style={{
                  padding: '5px 10px',
                  borderRadius: 6,
                  fontSize: 13,
                  whiteSpace: 'nowrap',
                  color: active ? '#e8e4dc' : '#8892b0',
                  background: active ? '#252c50' : 'transparent',
                  fontWeight: active ? 500 : 400,
                  textDecoration: 'none',
                  transition: 'color 0.15s, background 0.15s',
                }}
                onMouseEnter={e => { if (!active) { (e.target as HTMLElement).style.color = '#e8e4dc' } }}
                onMouseLeave={e => { if (!active) { (e.target as HTMLElement).style.color = '#8892b0' } }}
              >
                {l.label}
              </Link>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
