'use client'
import { useState } from 'react'

// Repeatable "Other or Local" AI-system entries for the policy form. Each saved
// entry renders as a checked `name="tools"` checkbox, so it submits exactly like
// the built-in options (persisted in the policy inputs and rendered into the
// approved-tools list of the generated doc). Saving one reveals a fresh empty
// "Other or Local" input below, so a firm can list several - e.g. local LLMs.
export default function OtherTools() {
  const [saved, setSaved] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim().slice(0, 120)
    if (!v || saved.includes(v)) return
    setSaved([...saved, v])
    setDraft('')
  }
  return (
    <div style={{ marginTop: 8 }}>
      {saved.map((v) => (
        <label key={v} className="checkline" style={{ display: 'flex', marginBottom: 6 }}>
          <input type="checkbox" name="tools" value={v} defaultChecked /> {v}
        </label>
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          className="input"
          style={{ maxWidth: 320 }}
          placeholder="Other or Local - e.g. Llama 3 via LM Studio"
          aria-label="Other or Local AI system"
          maxLength={120}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
        />
        <button type="button" className="btn btn-sm" onClick={add} disabled={!draft.trim()}>Save</button>
      </div>
      <p className="hint" style={{ margin: '6px 0 0' }}>Any other AI system, including local LLMs - Save each one to include it in the policy. Saved entries appear above with a fresh field below.</p>
    </div>
  )
}
