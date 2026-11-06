import { useEffect, useRef, useState } from 'react'
import './App.css'
import './index.css'
import './dashboard.css'
import { backend } from './lib/backend/index.js'
import { MAIN_HTML } from './dashboard-markup.js'
import { startDashboard } from './dashboard-script.js'

// The verbatim source page, gated by a login screen in the page's own style
// (white card on #f2f3f6, ink #151a2b, blue #3266d9).
export default function App() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof backend.auth.me>>>(null)
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState('')
  const started = useRef(false)

  useEffect(() => {
    let alive = true
    backend.auth
      .me()
      .then((u) => { if (alive) { setSession(u); setReady(true) } })
      .catch((e) => { if (alive) { setErr(String(e)); setReady(true) } })
    return () => { alive = false }
  }, [])

  if (!ready) {
    return (
      <div className="gate-wrap">
        <div className="card gate-card">Connecting…</div>
      </div>
    )
  }

  if (session) {
    if (!started.current) {
      started.current = true
      requestAnimationFrame(() => startDashboard())
    }
    return (
      <div
        className="dash-root"
        // The source page's markup, verbatim, is mounted once and its script takes it from there.
        dangerouslySetInnerHTML={{ __html: MAIN_HTML }}
      />
    )
  }
  return <Login onSignedIn={(u) => setSession(u)} err={err} />
}

function Login({ onSignedIn, err }: { onSignedIn: (u: any) => void; err: string }) {
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg('')
    try {
      await backend.auth.login(email, pw)
      const u = await backend.auth.me()
      onSignedIn(u ?? ({ email } as any))
    } catch (e2) {
      setMsg('That email and password did not work.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gate-wrap">
      <form className="card gate-card" onSubmit={submit}>
        <h1 className="gate-title">Northside Portal</h1>
        <p className="gate-sub">Owner dashboard for Northside Heating &amp; Air</p>
        {err ? <p className="gate-msg">{err}</p> : null}
        <label className="gate-label">
          Email
          <input
            className="gate-input"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="gate-label">
          Password
          <input
            className="gate-input"
            type="password"
            required
            autoComplete="current-password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </label>
        {msg ? <p className="gate-msg">{msg}</p> : null}
        <button className="gate-btn" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
