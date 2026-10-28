import { redirect } from 'next/navigation'

// Intentional: the marketing homepage is the static site on the apex (example.com).
// This Next app deploys on the app subdomain (app.example.com), so its root goes
// straight to the product - /dashboard (which redirects unauthenticated users to /login).
export default function Home() {
  redirect('/dashboard')
}
