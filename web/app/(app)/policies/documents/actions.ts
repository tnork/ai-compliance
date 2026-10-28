'use server'

import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/error-log'

// Bring-your-own firm documents (AUP, WISP, other): upload + version + optional
// staff acknowledgement, firm-isolated. Files live in the private `firm-documents`
// bucket; metadata + version numbering go through the 0034 RPCs. Server-mediated
// like the training-course attachments: RLS confirms firm ownership, the service
// role does the storage I/O, and the metadata write forces attribution in-DB.

const BUCKET = 'firm-documents'
const MAX_BYTES = 15 * 1024 * 1024
const DOC_TYPES = new Set(['aup', 'wisp', 'other'])
const safeName = (n: string) => (n || 'file').replace(/[^\w.\-]+/g, '_').slice(-120)

// Upload a brand-new document (creates the logical doc + its v1 atomically).
export async function createFirmDocument(formData: FormData) {
  const u = await requireUser()
  const back = '/policies?e='
  const title = String(formData.get('title') || '').trim()
  const docType = String(formData.get('doc_type') || 'other')
  const description = String(formData.get('description') || '').trim()
  const file = formData.get('file')
  if (!title) redirect(back + encodeURIComponent('A document title is required.'))
  if (!DOC_TYPES.has(docType)) redirect(back + encodeURIComponent('Choose a valid document type.'))
  if (!(file instanceof File) || file.size === 0) redirect(back + encodeURIComponent('Choose a file to upload.'))
  const f = file as File
  if (f.size > MAX_BYTES) redirect(back + encodeURIComponent('File is too large (max 15 MB).'))

  // Pre-generate the doc id so the storage path is inside the firm prefix before
  // the row exists; the RPC re-validates the prefix (defense-in-depth).
  const docId = randomUUID()
  const path = `${u.firm_id}/${docId}/${randomUUID()}__${safeName(f.name)}`
  const admin = createAdminClient()
  const buf = Buffer.from(await f.arrayBuffer())
  const up = await admin.storage.from(BUCKET).upload(path, buf, { contentType: f.type || 'application/octet-stream', upsert: false })
  if (up.error) redirect(back + encodeURIComponent('Upload failed: ' + up.error.message))

  const supabase = await createClient()
  const { error } = await supabase.rpc('create_firm_document', {
    p_id: docId, p_doc_type: docType, p_title: title, p_description: description || null,
    p_file_name: f.name || safeName(f.name), p_storage_path: path, p_mime: f.type || null, p_size: f.size,
  })
  if (error) {
    // roll back the orphaned object so a failed metadata write leaves nothing behind
    await admin.storage.from(BUCKET).remove([path])
    redirect(back + encodeURIComponent('Could not save the document. Please try again.'))
  }
  revalidatePath('/policies')
  redirect(`/policies/documents/${docId}`)
}

// Upload a new version of an existing document (creator-or-admin; enforced in the RPC).
export async function addDocumentVersion(formData: FormData) {
  const u = await requireUser()
  const documentId = String(formData.get('document_id') || '')
  const note = String(formData.get('note') || '').trim()
  const back = `/policies/documents/${documentId}?e=`
  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) redirect(back + encodeURIComponent('Choose a file to upload.'))
  const f = file as File
  if (f.size > MAX_BYTES) redirect(back + encodeURIComponent('File is too large (max 15 MB).'))

  // RLS read confirms the document is in the caller's firm before we touch storage.
  const supabase = await createClient()
  const { data: doc } = await supabase.from('firm_document').select('id').eq('id', documentId).maybeSingle()
  if (!doc) redirect(back + encodeURIComponent('That document is not in your firm.'))

  const path = `${u.firm_id}/${documentId}/${randomUUID()}__${safeName(f.name)}`
  const admin = createAdminClient()
  const buf = Buffer.from(await f.arrayBuffer())
  const up = await admin.storage.from(BUCKET).upload(path, buf, { contentType: f.type || 'application/octet-stream', upsert: false })
  if (up.error) redirect(back + encodeURIComponent('Upload failed: ' + up.error.message))

  const { error } = await supabase.rpc('add_firm_document_version', {
    p_document_id: documentId, p_file_name: f.name || safeName(f.name), p_storage_path: path,
    p_mime: f.type || null, p_size: f.size, p_note: note || null,
  })
  if (error) {
    await admin.storage.from(BUCKET).remove([path])
    redirect(back + encodeURIComponent(error.message))
  }
  revalidatePath(`/policies/documents/${documentId}`)
  revalidatePath('/policies')
}

// Optional: acknowledge the current head version (any member, for themselves).
export async function attestFirmDocument(formData: FormData) {
  const documentId = String(formData.get('document_id') || '')
  const supabase = await createClient()
  const { error } = await supabase.rpc('attest_firm_document', { p_document_id: documentId })
  if (error) redirect(`/policies/documents/${documentId}?e=` + encodeURIComponent(error.message))
  revalidatePath(`/policies/documents/${documentId}`)
}

// Delete a document (creator-or-admin). Authorize FIRST via the RLS row delete,
// confirm it removed a row, THEN purge the storage prefix - never touch files on
// the service role until the caller has proven they may delete. The row delete
// cascade-removes version + attestation metadata via the composite FKs.
export async function deleteFirmDocument(formData: FormData) {
  const documentId = String(formData.get('document_id') || '')
  const supabase = await createClient()
  const { data: doc } = await supabase.from('firm_document').select('id, firm_id').eq('id', documentId).maybeSingle()
  if (!doc) redirect('/policies?e=' + encodeURIComponent('Document not found.'))
  const { data: deleted, error } = await supabase.from('firm_document').delete().eq('id', documentId).select('id')
  if (error) redirect(`/policies/documents/${documentId}?e=` + encodeURIComponent(error.message))
  if (!deleted || deleted.length === 0) {
    redirect(`/policies/documents/${documentId}?e=` + encodeURIComponent('You do not have permission to delete this document.'))
  }
  // Purge every file under the document's prefix. storage.list() pages at 100;
  // re-list from the top each pass (removal shrinks the set) until empty.
  const admin = createAdminClient()
  const prefix = `${doc.firm_id}/${documentId}`
  for (let guard = 0; guard < 1000; guard++) {
    const { data: files, error: listErr } = await admin.storage.from(BUCKET).list(prefix, { limit: 100 })
    if (listErr) {
      // don't treat a list FAILURE as "empty" - that would silently orphan every
      // remaining file (metadata rows are already cascade-gone). Log and stop.
      await logError(admin, { firmId: doc.firm_id, source: 'storage', message: 'firm-document file purge failed (list error) - possible orphaned storage objects: ' + listErr.message, context: { documentId, prefix } })
      break
    }
    if (!files?.length) break
    const { error: rmErr } = await admin.storage.from(BUCKET).remove(files.map((fi) => `${prefix}/${fi.name}`))
    if (rmErr) {
      await logError(admin, { firmId: doc.firm_id, source: 'storage', message: 'firm-document file purge failed - orphaned storage objects: ' + rmErr.message, context: { documentId, prefix } })
      break
    }
  }
  revalidatePath('/policies')
  redirect('/policies')
}
