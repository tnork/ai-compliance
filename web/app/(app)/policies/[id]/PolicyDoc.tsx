'use client'

import { memo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import ConfirmModal from '@/components/ConfirmModal'
import AdoptButton from '../AdoptButton'
import { savePolicyVersion, deletePolicy } from '../actions'

export type VersionEntry = { version: number; note: string | null; editor: string; createdAt: string }

const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })

// The editable document is isolated in a memoized child so that parent state
// changes DURING an edit (typing the note, opening a confirm modal, the pending
// flag) never re-render it. Re-rendering would re-apply dangerouslySetInnerHTML
// and wipe the user's contenteditable edits before we read them on save.
// It only re-renders when the version body (html) or edit mode actually change.
const EditableDoc = memo(function EditableDoc({
  html, editing, docRef,
}: { html: string; editing: boolean; docRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div
      ref={docRef}
      className={`card policy-doc ${editing ? 'policy-doc-editing' : ''}`}
      contentEditable={editing}
      suppressContentEditableWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

export default function PolicyDoc({
  policyId, status, canEdit, bodyHtml, selectedVersion, headVersion, versions,
}: {
  policyId: string
  status: string
  canEdit: boolean
  bodyHtml: string
  selectedVersion: number
  headVersion: number
  versions: VersionEntry[]
}) {
  const router = useRouter()
  const docRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [confirmHead, setConfirmHead] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const isHead = selectedVersion === headVersion
  const selMeta = versions.find((v) => v.version === selectedVersion)

  const goTo = (v: number) => { if (v !== selectedVersion) { setEditing(false); router.push(`/policies/${policyId}?v=${v}`) } }

  const doSave = () => {
    const html = docRef.current?.innerHTML ?? ''
    start(async () => {
      const res = await savePolicyVersion({ policyId, bodyHtml: html, note })
      if ('error' in res) { setErr(res.error); setConfirmHead(false); return }
      setEditing(false); setConfirmHead(false); setNote(''); setErr(null)
      router.push(`/policies/${policyId}?v=${res.version}`)
      router.refresh()
    })
  }
  // Editing an OLDER version and saving branches it to a new head - confirm first.
  const onSave = () => { if (!isHead) setConfirmHead(true); else doSave() }
  const cancelEdit = () => { setEditing(false); setNote(''); setErr(null); router.refresh() }

  const doDelete = () => {
    const fd = new FormData(); fd.set('id', policyId)
    start(async () => { await deletePolicy(fd) })
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow"><Link href="/policies" style={{ color: 'var(--muted)' }}>← Policies</Link></div>
          <div className="rowflex" style={{ marginTop: 4, gap: 12 }}>
            <span className={`badge ${status === 'adopted' ? 'ok' : 'neutral'}`}>{status}</span>
            {versions.length > 0 && (
              <label className="rowflex" style={{ gap: 6 }}>
                <span className="sr-only">Version</span>
                <select className="select select-sm" value={selectedVersion} onChange={(e) => goTo(Number(e.target.value))} aria-label="Select policy version">
                  {versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version} · {fmt(v.createdAt)}{v.version === headVersion ? ' (current)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
        <div className="rowflex">
          {editing ? (
            <>
              <button type="button" className="btn btn-green" disabled={pending} onClick={onSave}>{pending ? 'Saving…' : 'Save'}</button>
              <button type="button" className="btn btn-ghost" disabled={pending} onClick={cancelEdit}>Cancel</button>
            </>
          ) : (
            <>
              {canEdit && <button type="button" className="btn btn-ghost" onClick={() => { setErr(null); setEditing(true) }}>Edit the policy</button>}
              {canEdit && status !== 'adopted' && <AdoptButton policyId={policyId} className="btn btn-green" />}
              <button type="button" className={`btn btn-ghost ${showHistory ? 'is-active' : ''}`} aria-pressed={showHistory} onClick={() => setShowHistory((s) => !s)}>History</button>
              {canEdit && <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>Delete</button>}
            </>
          )}
        </div>
      </div>

      {err && <div className="msg err" role="alert" style={{ maxWidth: 820 }}>{err}</div>}
      {!isHead && !editing && (
        <div className="msg" style={{ maxWidth: 820, background: 'var(--paper-2)', border: '1px solid var(--line)', color: 'var(--muted)' }}>
          Viewing v{selectedVersion} (older). <button type="button" className="linkbtn" onClick={() => goTo(headVersion)}>Go to current version (v{headVersion})</button>
        </div>
      )}

      <div className={`policy-layout ${showHistory ? 'with-history' : ''}`}>
        <div className="policy-main">
          {editing && (
            <div className="field" style={{ maxWidth: 820 }}>
              <label htmlFor="version-note">What changed? <span className="sub">(optional - shows in history)</span></label>
              <input id="version-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Added Gemini to approved tools" />
            </div>
          )}
          {editing && <p className="hint" style={{ maxWidth: 820, marginBottom: 8 }}>Click into the document to edit. Saving creates a new version and records who changed it and when.</p>}
          <EditableDoc html={bodyHtml} editing={editing} docRef={docRef} />
        </div>

        {showHistory && (
          <aside className="policy-history" aria-label="Version history">
            <div className="policy-history-head">
              <b>Version history</b>
              <button type="button" className="linkbtn" onClick={() => setShowHistory(false)} aria-label="Close history">✕</button>
            </div>
            <ol className="policy-history-list">
              {versions.map((v) => (
                <li key={v.version} className={v.version === selectedVersion ? 'is-selected' : ''}>
                  <button type="button" className="policy-history-item" onClick={() => goTo(v.version)}>
                    <div className="rowflex" style={{ justifyContent: 'space-between' }}>
                      <b>v{v.version}{v.version === headVersion ? ' · current' : ''}</b>
                      <span className="hint">{fmt(v.createdAt)}</span>
                    </div>
                    <div className="hint">{v.note || 'Edited'} · {v.editor}</div>
                  </button>
                </li>
              ))}
            </ol>
          </aside>
        )}
      </div>

      <ConfirmModal
        open={confirmHead}
        title="Use this as the most recent version?"
        message={`You're editing v${selectedVersion}. Saving will create a new current version (v${headVersion + 1}) from these edits.`}
        confirmLabel="Yes" cancelLabel="No" pending={pending}
        onConfirm={doSave} onCancel={() => setConfirmHead(false)}
      />
      <ConfirmModal
        open={confirmDelete}
        title="Delete this policy?"
        message="This removes the policy and all its versions. This cannot be undone."
        confirmLabel="Delete" cancelLabel="Cancel" confirmTone="danger" pending={pending}
        onConfirm={doDelete} onCancel={() => setConfirmDelete(false)}
      />
    </>
  )
}
