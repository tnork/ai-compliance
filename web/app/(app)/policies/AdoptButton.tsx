'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import ConfirmModal from '@/components/ConfirmModal'
import { adoptPolicy } from './actions'

// Green "Adopt as active" button + Yes/No confirm lightbox. Used on the policies
// list (adopt without opening) and on the detail page.
export default function AdoptButton({
  policyId, className = 'btn btn-green btn-sm', label = 'Adopt as active',
}: { policyId: string; className?: string; label?: string }) {
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const router = useRouter()

  const confirm = () => {
    const fd = new FormData()
    fd.set('id', policyId)
    start(async () => {
      await adoptPolicy(fd)
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{label}</button>
      <ConfirmModal
        open={open}
        title="Make this policy active?"
        message="Do you want to proceed to make this policy the firm's active AI-use policy?"
        confirmLabel="Yes" cancelLabel="No"
        pending={pending}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
      />
    </>
  )
}
