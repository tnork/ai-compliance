'use client'

import { useState, useTransition } from 'react'
import ConfirmModal from '@/components/ConfirmModal'
import { deleteFirmDocument } from './actions'

// Danger "Delete document" button + Yes/No confirm. Deleting removes the document,
// all its versions, acknowledgements, and stored files (creator-or-admin).
export default function DeleteDocumentButton({ documentId }: { documentId: string }) {
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()

  const confirm = () => {
    const fd = new FormData()
    fd.set('document_id', documentId)
    start(async () => { await deleteFirmDocument(fd) })
  }

  return (
    <>
      <button type="button" className="btn btn-danger btn-sm" onClick={() => setOpen(true)}>Delete document</button>
      <ConfirmModal
        open={open}
        title="Delete this document?"
        message="This permanently removes the document, every version, its acknowledgements, and the stored files. This cannot be undone."
        confirmLabel="Delete" cancelLabel="Cancel" confirmTone="danger"
        pending={pending}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
      />
    </>
  )
}
