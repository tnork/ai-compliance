'use client'

import { useState, useTransition } from 'react'
import { generateDesktopConnectCode } from '@/app/(app)/connections/actions'

// Pairing UI for the desktop logger: one click mints a one-time connect code
// (server action), shown once for copy-paste into the logger's settings. The
// code is bearer-equivalent until redeemed - never stored, only displayed.
export default function DesktopConnectCode() {
  const [code, setCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [pending, startTransition] = useTransition()

  const generate = () => startTransition(async () => {
    setError(null); setCopied(false)
    const r = await generateDesktopConnectCode()
    if (r.error) { setError(r.error); setCode(null) } else setCode(r.code ?? null)
  })

  const copy = async () => {
    if (!code) return
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2500) } catch { /* select manually */ }
  }

  return (
    <div>
      <div className="rowflex" style={{ gap: 10, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={generate} disabled={pending}>
          {pending ? 'Generating…' : code ? 'Generate a new code' : 'Generate connect code'}
        </button>
        {code && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>{copied ? 'Copied ✓' : 'Copy code'}</button>
        )}
      </div>
      {error && <p className="hint" role="alert" style={{ color: 'var(--err-ink)', marginTop: 8 }}>{error}</p>}
      {code && (
        <div style={{ marginTop: 10, maxWidth: 640 }}>
          <textarea
            className="input"
            readOnly
            rows={4}
            style={{ fontFamily: 'var(--font-mono-stack)', fontSize: 12 }}
            value={code}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Desktop connect code"
          />
          <p className="hint" style={{ marginTop: 6 }}>
            Paste this into the extension popup&rsquo;s Connect code field, or the desktop logger&rsquo;s Settings → Connect code.
            It works <b>once</b> and expires quickly - treat it like a password. After connecting, the client keeps its own
            session and stays connected on its own. Connecting both clients? Generate one code for each.
          </p>
        </div>
      )}
    </div>
  )
}
