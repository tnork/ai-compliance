'use client'

import { useActionState } from 'react'
import { setPassword, type WelcomeState } from './actions'

// Invited (or recovering) users land here from the email link with a live session
// (established by /auth/confirm) and choose their own password.
export default function WelcomePage() {
  const [state, action, pending] = useActionState<WelcomeState, FormData>(setPassword, {})
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand">
          <img src="/logo-primary.svg" alt="" />
          <span>AI Compliance</span>
        </div>
        <h1>Set your password</h1>
        <p className="sub">You&rsquo;re joining your firm&rsquo;s record of AI supervision.</p>

        {state?.error && <div className="msg err" role="alert">{state.error}</div>}

        <form action={action}>
          <div className="field">
            <label htmlFor="password">New password</label>
            <input className="input" id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
          </div>
          <div className="field">
            <label htmlFor="confirm">Confirm password</label>
            <input className="input" id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={8} required />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save and continue'}
          </button>
        </form>

        <p className="hint" style={{ marginTop: 18, textAlign: 'center' }}>
          Evidence tooling, not assurance. Not legal or tax advice.
        </p>
      </div>
    </div>
  )
}
