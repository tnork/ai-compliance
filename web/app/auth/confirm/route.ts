import { NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

// Email-link landing (invite, recovery, email-change). The dashboard email templates
// link here as `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite` - the
// token_hash + verifyOtp pattern, which works with server-initiated (admin API) links
// where the default ConfirmationURL/PKCE code exchange does not (no client verifier).
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const token_hash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null

  if (token_hash && type) {
    const supabase = await createClient()
    const { error } = await supabase.auth.verifyOtp({ type, token_hash })
    if (!error) {
      // Invited or recovering users set a password first; everyone else goes to the app.
      const next = type === 'invite' || type === 'recovery' ? '/welcome' : '/dashboard'
      return NextResponse.redirect(new URL(next, origin))
    }
  }
  return NextResponse.redirect(new URL('/login?e=invite-link', origin))
}
