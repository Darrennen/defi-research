'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

const links = [
  { href: '/stablecoins',   label: 'Stablecoins' },
  { href: '/treasuries',    label: 'Treasuries' },
  { href: '/lending',       label: 'Lending' },
  { href: '/aave',          label: 'Aave V3' },
  { href: '/morpho',        label: 'Morpho Blue' },
  { href: '/hyperlend',     label: 'HyperLend' },
  { href: '/yield-tracker', label: 'Yield Tracker' },
]

function Mark({ size = 56 }: { size?: number }) {
  const h = Math.round(size * (76 / 56))
  return (
    <svg width={size} height={h} viewBox="0 0 560 760" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M339.66 587.06C358.34 535.13 386.43 487.06 426.41 451.5C436.24 438.4 445.39 424.78 453.76 410.6C462.18 396.33 492.97 331.04 493.42 325.89C492.36 327.16 491.44 328.25 490.53 329.35C482.4 339.19 474.44 349.18 466.12 358.85C442.1 386.78 415.83 412.57 389.65 438.42C377.03 450.88 366.29 464.71 358.55 480.7C352.34 493.53 350.02 505.8 343.46 518.47C318.1 567.42 291.95 587.72 276.35 598.16C275.07 599.02 274.25 599.34 273.74 599.35C259.95 612.07 244.76 623.4 228.34 633.08C181.66 661.31 128.8 676.19 78.29 695.66C71.66 698.26 65.04 700.98 58.55 703.94C56.94 704.97 55.33 706.01 53.71 707.02C44.66 712.2 36.65 719.63 30.42 728.13C27.64 732 24.91 736.17 24.16 740.97C13.72 731.92 9.2 720.63 8.83 707.56C8.43 693.06 13.89 677.78 24.28 663.22C28.34 665.74 32.27 668.51 36.48 670.75C48.62 677.21 61.96 678.78 75.39 679.18C129.9 635.13 175.63 581.48 217.82 526.16C241.14 495.25 263.56 463.21 284.98 430.99C337.29 353.14 384.19 271.72 433.12 191.58C369.38 269.11 295.27 338.86 223.19 407.78C181.07 448.23 138.06 487.93 100.87 532.99C78.96 560.33 51.71 597.95 57.61 634.76C45.01 589.28 84.7 536.49 111.51 502.54C142.3 464.61 176.74 429.92 211.32 395.54C306.03 302.1 404.82 211.26 486.74 106.29C496.2 91.8 505.83 77.42 515.66 63.17C520.55 54.57 525.43 46.03 530.31 37.58C537.54 25.06 544.74 12.53 551.95 0C551.11 0.02 550.71 0.37 550.38 0.78C532.56 23.03 515.03 45.53 496.87 67.5C444.41 130.93 389.29 192.01 332.93 251.98C287.87 299.91 241.32 346.34 193.65 391.68C160.92 422.8 128.11 453.85 96.04 485.64C70.86 510.6 47.94 537.58 30.45 568.73C19.68 587.91 10.61 607.74 7.29 629.71C5.64 640.63 6 651.33 12.83 660.76C12.41 661.51 12.06 662.14 11.7 662.76C0.85 682.05 -3.31 702.39 2.9 724.04C6.66 737.15 13.69 747.98 26.75 753.78C28.52 754.57 30.37 755.18 32.57 756.03C30.45 744.62 34.42 736.24 43.01 730.58C48.68 726.85 55.15 723.91 61.66 721.05C123.66 693.85 188.66 673.78 247.41 638.4C277.84 620.07 305.36 597.78 326.62 568.91C334.39 570.16 336.95 578.55 339.66 587.06Z" fill="var(--blue)"/>
      <path d="M558.69 57.75C553.77 64.75 548.84 71.74 543.96 78.77C502.43 138.57 459.5 197.33 415.38 255.2C376.95 322.84 337.14 389.93 293.28 454.23C237.41 535.5 175.49 614.69 97.65 676.12C114.8 668.29 132.56 660.94 149.21 653.69C237.8 616.05 296.28 573.93 340.22 486.05C365.44 424.98 386.96 378.07 410.38 332.05C428.61 296.24 448.11 261.06 467.41 225.79C492.78 179.42 518.53 133.25 544.05 86.96C549.5 77.08 554.7 67.07 560.02 57.12C559.24 57.09 558.94 57.39 558.7 57.73Z" fill="var(--blue)"/>
    </svg>
  )
}

export default function Masthead() {
  const pathname = usePathname()
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  useEffect(() => {
    const saved = localStorage.getItem('paragrine-theme') as 'light' | 'dark' | null
    if (saved) { setTheme(saved); document.documentElement.dataset.theme = saved }
  }, [])

  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light'
    setTheme(next)
    document.documentElement.dataset.theme = next
    localStorage.setItem('paragrine-theme', next)
  }

  const now = new Date()
  const dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <header className="masthead">
      <div className="masthead-row">
        {/* Left meta */}
        <div className="meta-l">
          <span>Paragrine Research</span>
          <span>Est. 2025</span>
          <span>Independent</span>
        </div>

        {/* Centre brand */}
        <Link href="/" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="brand">
            <div className="mk"><Mark size={56} /></div>
            <h4 className="nm">Paragrine <em>Research</em></h4>
            <div className="ad">Evidence-led analysis on digital asset markets</div>
          </div>
        </Link>

        {/* Right meta */}
        <div className="meta-r">
          <span>{dateStr}</span>
          <span>Public On-Chain Data</span>
          <span>DeFiLlama APIs</span>
        </div>
      </div>

      {/* Nav row */}
      <div className="masthead-sub">
        <nav>
          {links.map((l) => {
            const active = pathname === l.href || (l.href !== '/' && pathname.startsWith(l.href))
            return (
              <Link key={l.href} href={l.href} className={active ? 'active' : ''}>
                {l.label}
              </Link>
            )
          })}
        </nav>
        <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
          <Mark size={16} />
        </button>
      </div>
    </header>
  )
}
