import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// Download a course attachment. The RLS-scoped select only returns rows in the
// caller's firm, so a user can never fetch another firm's file. We then mint a
// short-lived signed URL (service role) and redirect to it.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: att } = await supabase
    .from('course_attachment').select('storage_path, file_name').eq('id', id).maybeSingle()
  if (!att) return new NextResponse('Not found', { status: 404 })

  const { data, error } = await createAdminClient()
    .storage.from('course-materials')
    .createSignedUrl(att.storage_path, 60, { download: att.file_name })
  if (error || !data) return new NextResponse('Could not generate download link', { status: 500 })
  return NextResponse.redirect(data.signedUrl)
}
