'use client'

import { useEffect, useRef } from 'react'

// Reusable Yes/No confirmation lightbox. Controlled via `open`; the parent owns
// the decision. Fixed overlay (escapes any stacking context), Esc / backdrop
// cancels, focus moves to the confirm button on open.
export default function ConfirmModal({
  open, title, message, confirmLabel = 'Yes', cancelLabel = 'No',
  confirmTone = 'green', pending = false, onConfirm, onCancel,
}: {
  open: boolean
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  confirmTone?: 'green' | 'danger'
  pending?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !pending) onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, pending, onCancel])

  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={() => { if (!pending) onCancel() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        {message && <p className="modal-msg">{message}</p>}
        <div className="modal-actions">
          <button ref={confirmRef} type="button" className={`btn ${confirmTone === 'danger' ? 'btn-danger' : 'btn-green'}`} disabled={pending} onClick={onConfirm}>
            {pending ? 'Working…' : confirmLabel}
          </button>
          <button type="button" className="btn btn-cancel" disabled={pending} onClick={onCancel}>{cancelLabel}</button>
        </div>
      </div>
    </div>
  )
}
