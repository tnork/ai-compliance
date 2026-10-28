'use client'

import { use, useActionState } from 'react'
import { signIn, type AuthState } from './actions'

// Redirect-reason banners (e.g. /auth/confirm sends expired/used invite links here).
const NOTICES: Record<string, string> = {
  'invite-link': 'That invite link is invalid or has expired. Ask your firm admin to send a new one.',
  'no-firm': 'Your account isn’t linked to a firm yet. Contact your firm admin.',
}

export default function LoginPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const sp = use(searchParams)
  const notice = sp.e ? NOTICES[sp.e] : undefined
  const [state, action, pending] = useActionState<AuthState, FormData>(signIn, {})
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand">
          <img src="/logo-primary.svg" alt="" />
          <span>AI Compliance</span>
        </div>
        <h1>Sign in</h1>
        <p className="sub">Your firm&rsquo;s record of AI supervision.</p>

        {notice && !state?.error && <div className="msg err" role="alert">{notice}</div>}
        {state?.error && <div className="msg err" role="alert">{state.error}</div>}

        <form action={action}>
          <div className="field">
            <label htmlFor="email">Work email</label>
            <input className="input" id="email" name="email" type="email" autoComplete="email" placeholder="you@firm.com" required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <label className="checkline" style={{ marginBottom: 16 }}>
            <input type="checkbox" name="remember" value="1" defaultChecked />
            Keep this device signed in
          </label>
          <button className="btn btn-primary btn-block" type="submit" disabled={pending}>
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="hint" style={{ marginTop: 18, textAlign: 'center' }}>
          Evidence tooling, not assurance. Not legal or tax advice.
        </p>
      </div>
    </div>
  )
}
