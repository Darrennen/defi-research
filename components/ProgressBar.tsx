'use client'
import { useEffect, useState } from 'react'

export default function ProgressBar() {
  const [pct, setPct] = useState(0)
  useEffect(() => {
    function update() {
      const el = document.documentElement
      const total = el.scrollHeight - el.clientHeight
      setPct(total > 0 ? Math.min((el.scrollTop / total) * 100, 100) : 0)
    }
    window.addEventListener('scroll', update, { passive: true })
    return () => window.removeEventListener('scroll', update)
  }, [])
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, zIndex: 9999,
      height: 2, width: `${pct}%`,
      background: 'var(--blue)', pointerEvents: 'none',
      transition: 'width 80ms linear',
    }} />
  )
}
