'use server'

import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireRole } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/error-log'

const BUCKET = 'course-materials'
const MAX_BYTES = 15 * 1024 * 1024
const err = (msg: string) => redirect('/training?e=' + encodeURIComponent(msg))

export async function addTraining(formData: FormData) {
  const supabase = await createClient()
  const completed = String(formData.get('completed_at') || '')
  const expires = String(formData.get('expires_at') || '')
  const user_id = String(formData.get('user_id'))
  // Confirm the target user is in the caller's firm (RLS scopes this select) before logging.
  const { data: member } = await supabase.from('app_user').select('id').eq('id', user_id).maybeSingle()
  if (!member) err('That staff member is not in your firm.')

  // Course can come from the catalog (course_id) or be free-typed. If a catalog
  // course is chosen, copy its name into course_name so coverage/§10.35 and the
  // list keep working unchanged.
  const courseId = String(formData.get('course_id') || '').trim()
  let course_id: string | null = null
  let course_name = String(formData.get('course_name') || '').trim()
  if (courseId && courseId !== 'other') {
    const { data: c } = await supabase.from('course').select('id, name').eq('id', courseId).maybeSingle()
    if (!c) err('That course is not in your firm.')
    course_id = c!.id
    course_name = c!.name
  }
  if (!course_name) err('A course is required.')

  const { error } = await supabase.from('training_record').insert({
    user_id,
    course_id,
    course_name,
    completed_at: completed ? new Date(completed).toISOString() : null,
    expires_at: expires ? new Date(expires).toISOString() : null,
  })
  if (error) err(error.message)
  revalidatePath('/training')
}

export async function deleteTraining(formData: FormData) {
  await requireRole('admin') // the firm training log is admin-managed; staff can't delete
  const supabase = await createClient()
  const { error } = await supabase.from('training_record').delete().eq('id', String(formData.get('id')))
  if (error) err(error.message)
  revalidatePath('/training')
}

// ── Courses (catalog) ──────────────────────────────────────────────────────
export async function addCourse(formData: FormData) {
  const supabase = await createClient()
  const name = String(formData.get('name') || '').trim()
  if (!name) err('A course name is required.')
  // Only store http(s) links - the website is rendered as an anchor, so a
  // javascript:/data: URL (POSTed past the type=url input) would be an XSS vector.
  const websiteRaw = String(formData.get('website') || '').trim()
  const website = /^https?:\/\//i.test(websiteRaw) ? websiteRaw : null
  const { error } = await supabase.from('course').insert({
    name,
    provider: String(formData.get('provider') || '').trim() || null,
    website,
    summary: String(formData.get('summary') || '').trim() || null,
  })
  if (error) err(error.message)
  revalidatePath('/training')
}

export async function deleteCourse(formData: FormData) {
  const supabase = await createClient()
  const id = String(formData.get('id') || '')
  // AUTHORIZE FIRST: delete the row under RLS (creator-or-admin) and confirm it
  // actually removed a row. Only THEN purge storage - never touch files on the
  // service role until the caller has proven they may delete this course. (Row
  // delete cascade-deletes the attachment metadata via the composite FK.)
  const { data: course } = await supabase.from('course').select('id, firm_id').eq('id', id).maybeSingle()
  if (!course) err('Course not found.')
  const { data: deleted, error } = await supabase.from('course').delete().eq('id', id).select('id')
  if (error) err(error.message)
  if (!deleted || deleted.length === 0) err('You do not have permission to delete this course.')
  // Purge ALL of the course's private files. storage.list() pages at 100, so loop
  // until a short page - otherwise a course with >100 attachments would orphan the
  // objects beyond the first page (their metadata rows are already cascade-gone).
  const admin = createAdminClient()
  const prefix = `${course!.firm_id}/${course!.id}`
  // Re-list from the top each pass (removal shrinks the set, so incrementing an
  // offset would skip files); loop until empty, with a guard against an infinite
  // loop if a remove ever fails.
  for (let guard = 0; guard < 1000; guard++) {
    const { data: files } = await admin.storage.from(BUCKET).list(prefix, { limit: 100 })
    if (!files?.length) break
    const { error: rmErr } = await admin.storage.from(BUCKET).remove(files.map((f) => `${prefix}/${f.name}`))
    if (rmErr) {
      // metadata rows are already cascade-gone; files beyond this page are now
      // orphaned. Record it so it can be cleaned up (needs a deletion outbox — P2 #18).
      await logError(admin, { firmId: course!.firm_id, source: 'storage', message: 'course file purge failed - orphaned storage objects: ' + rmErr.message, context: { courseId: id, prefix } })
      break
    }
  }
  revalidatePath('/training')
}

export async function uploadAttachment(formData: FormData) {
  const supabase = await createClient()
  const course_id = String(formData.get('course_id') || '')
  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) err('Choose a file to upload.')
  const f = file as File
  if (f.size > MAX_BYTES) err('File is too large (max 15 MB).')

  // RLS read confirms the course belongs to the caller's firm + gives firm_id for the path.
  const { data: course } = await supabase.from('course').select('id, firm_id').eq('id', course_id).maybeSingle()
  if (!course) err('That course is not in your firm.')

  const safe = (f.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-120)
  const path = `${course!.firm_id}/${course!.id}/${randomUUID()}__${safe}`
  const admin = createAdminClient()
  const buf = Buffer.from(await f.arrayBuffer())
  const up = await admin.storage.from(BUCKET).upload(path, buf, { contentType: f.type || 'application/octet-stream', upsert: false })
  if (up.error) err('Upload failed: ' + up.error.message)

  // Metadata insert goes through RLS (uploaded_by forced to auth.uid()). Roll back
  // the storage object if it fails so we don't leave an orphan file.
  const { error } = await supabase.from('course_attachment').insert({
    course_id, file_name: f.name || safe, storage_path: path, mime_type: f.type || null, byte_size: f.size,
  })
  if (error) {
    await admin.storage.from(BUCKET).remove([path])
    err(error.message)
  }
  revalidatePath('/training')
}

export async function deleteAttachment(formData: FormData) {
  const supabase = await createClient()
  const id = String(formData.get('id') || '')
  const { data: att } = await supabase.from('course_attachment').select('id, storage_path, firm_id').eq('id', id).maybeSingle()
  if (!att) err('Attachment not found.')
  // AUTHORIZE FIRST: delete the metadata row under RLS (uploader-or-admin) and
  // confirm it removed a row before touching the service-role storage object -
  // otherwise a non-uploader could delete files they may not remove.
  const { data: deleted, error } = await supabase.from('course_attachment').delete().eq('id', id).select('id')
  if (error) err(error.message)
  if (!deleted || deleted.length === 0) err('You do not have permission to remove this attachment.')
  const admin = createAdminClient()
  const { error: rmErr } = await admin.storage.from(BUCKET).remove([att!.storage_path])
  if (rmErr) await logError(admin, { firmId: att!.firm_id, source: 'storage', message: 'attachment file delete failed - orphaned object: ' + rmErr.message, context: { attachmentId: id, path: att!.storage_path } })
  revalidatePath('/training')
}
