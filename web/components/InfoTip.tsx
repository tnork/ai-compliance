'use client'
import { useState, type ReactNode } from 'react'

// Small "?" affordance that reveals an explainer on hover or click (click pins
// it - hover alone is useless on touch). Content is arbitrary JSX; keep it to
// short paragraphs. Accessible: real button, aria-expanded, Escape closes.
export default function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [pinned, setPinned] = useState(false)
  const [hover, setHover] = useState(false)
  const open = pinned || hover
  return (
    <span
      style={{ position: 'relative', display: 'inline-block', marginLeft: 6, verticalAlign: 'middle' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setPinned(!pinned)}
        onKeyDown={(e) => { if (e.key === 'Escape') setPinned(false) }}
        style={{
          width: 17, height: 17, borderRadius: '50%', border: '1.5px solid var(--blue-ink)',
          background: 'transparent', color: 'var(--blue-ink)', fontWeight: 800, fontSize: 11,
          lineHeight: 1, cursor: 'pointer', padding: 0, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
        }}
      >?</button>
      {open && (
        <span
          role="tooltip"
          className="tip-pop"
          style={{
            position: 'absolute', zIndex: 'var(--z-tip)', top: 'calc(100% + 8px)', left: '50%',
            transform: 'translateX(-50%)', width: 'min(360px, 82vw)', maxHeight: '60vh',
            overflowY: 'auto', background: '#fff', border: '1px solid var(--line)',
            borderRadius: 10, boxShadow: 'var(--shadow)', padding: '12px 14px',
            fontSize: 13, lineHeight: 1.55, color: 'var(--ink)', fontWeight: 400,
            textAlign: 'left', whiteSpace: 'normal', display: 'block',
          }}
        >{children}</span>
      )}
    </span>
  )
}
