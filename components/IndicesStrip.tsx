'use client'
import { useEffect, useRef, useState } from 'react'

function fmtVal(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`
  return `$${n.toFixed(0)}`
}

function CountUp({ target }: { target: number | null }) {
  const [display, setDisplay] = useState(target == null ? '—' : '$0')
  const raf = useRef<number>()
  useEffect(() => {
    if (target == null) { setDisplay('—'); return }
    const start = performance.now()
    const dur = 1300
    const tick = (now: number) => {
      const t = Math.min((now - start) / dur, 1)
      const ease = 1 - Math.pow(1 - t, 3)
      setDisplay(fmtVal(target * ease))
      if (t < 1) raf.current = requestAnimationFrame(tick)
      else setDisplay(fmtVal(target))
    }
    raf.current = requestAnimationFrame(tick)
    return () => { if (raf.current) cancelAnimationFrame(raf.current) }
  }, [target])
  return <>{display}</>
}

export interface IndexItem { name: string; raw: number | null; chg: string }

export default function IndicesStrip({ items }: { items: IndexItem[] }) {
  return (
    <div className="indices">
      {items.map((ix) => (
        <div className="idx" key={ix.name}>
          <div className="name">{ix.name}</div>
          <div className="val"><CountUp target={ix.raw} /></div>
          <div className="chg">{ix.chg}</div>
        </div>
      ))}
    </div>
  )
}
