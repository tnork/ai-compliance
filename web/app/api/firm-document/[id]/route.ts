import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// Download a firm_document_version file. The RLS-scoped select only returns rows
// in the caller's firm, so a user can never fetch another firm's document. We
// then mint a short-lived signed URL (service role) and redirect to it.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: ver } = await supabase
    .from('firm_document_version').select('storage_path, file_name').eq('id', id).maybeSingle()
  if (!ver) return new NextResponse('Not found', { status: 404 })

  const { data, error } = await createAdminClient()
    .storage.from('firm-documents')
    .createSignedUrl(ver.storage_path, 60, { download: ver.file_name })
  if (error || !data) return new NextResponse('Could not generate download link', { status: 500 })
  return NextResponse.redirect(data.signedUrl)
}
