'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import './lighter.css'

const NAV = [
  { href: '/lighter', label: 'overview' },
  { href: '/lighter/lit', label: 'lit tracker' },
  { href: '/lighter/explorer', label: 'explorer' },
  { href: '/lighter/watchlist', label: 'watchlist' },
]

export default function LighterLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div data-lighter className="cockpit-root">
      <header className="cockpit-header">
        <a href="/lighter" className="cockpit-brand" style={{ textDecoration: 'none' }}>
          <span className="cockpit-mark">
            <span className="first">l</span>ighter
          </span>
          <span className="cockpit-sub">analyst cockpit</span>
        </a>

        <nav className="cockpit-nav">
          {NAV.map(({ href, label }) => {
            const active = href === '/lighter' ? pathname === '/lighter' : pathname.startsWith(href)
            return (
              <Link key={href} href={href} className={`cockpit-nav-pill${active ? ' active' : ''}`}>
                {label}
              </Link>
            )
          })}
        </nav>

        <a href="/" className="cockpit-back">← paragrine</a>
      </header>

      {children}
    </div>
  )
}
