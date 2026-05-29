'use client'

import { useState, FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

function LoginForm() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const next         = searchParams.get('next') ?? '/polymarket'

  const [password, setPassword] = useState('')
  const [error, setError]       = useState<string | null>(null)
  const [loading, setLoading]   = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res  = await fetch('/api/polymarket/auth', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Login failed')
      } else {
        router.push(next)
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '0 24px',
    }}>
      <div style={{ width: '100%', maxWidth: 360 }}>
        {/* Brand mark */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--blue)', marginBottom: 10 }}>
            Paragrine Research
          </div>
          <h1 style={{ fontFamily: 'var(--serif)', fontWeight: 500, fontSize: 28, margin: 0, lineHeight: 1.1 }}>
            Polymarket <em style={{ color: 'var(--blue)', fontStyle: 'italic' }}>Bot</em>
          </h1>
          <p style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink-mute)', margin: '10px 0 0' }}>
            Private access only
          </p>
        </div>

        {/* Form */}
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontFamily: 'var(--sans)', fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-soft)' }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoFocus
              autoComplete="current-password"
              placeholder="Enter access password"
              required
              style={{
                fontFamily: 'var(--mono)', fontSize: 14, padding: '10px 12px',
                border: error ? '1px solid var(--red)' : '1px solid var(--rule)',
                borderRadius: 3, background: 'var(--paper)', color: 'var(--ink)',
                outline: 'none', width: '100%', boxSizing: 'border-box',
              }}
            />
          </div>

          {error && (
            <div style={{
              fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--red)',
              padding: '8px 12px',
              background: 'rgba(192,57,43,0.06)', border: '1px solid rgba(192,57,43,0.2)',
              borderRadius: 3,
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            className="btn primary"
            style={{ marginTop: 4, opacity: loading || !password ? 0.6 : 1, cursor: loading || !password ? 'not-allowed' : 'pointer' }}
          >
            {loading ? 'Checking…' : 'Enter'}
          </button>
        </form>

        <p style={{ fontFamily: 'var(--sans)', fontSize: 11, color: 'var(--ink-mute)', textAlign: 'center', marginTop: 28 }}>
          Set <code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>POLYMARKET_PASSWORD</code> in <code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>.env.local</code>
        </p>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}
