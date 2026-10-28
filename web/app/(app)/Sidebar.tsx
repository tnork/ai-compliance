'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from '../login/actions'
import SubmitButton from '@/components/SubmitButton'

type Perms = { isAdmin: boolean; viewLogs: boolean; isDeveloper: boolean }

const NAV: { href: string; label: string; icon: string; need?: (p: Perms) => boolean }[] = [
  { href: '/dashboard', label: 'Dashboard', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z' },
  { href: '/records', label: 'Review records', icon: 'M7 3h7l5 5v13H7zM14 3v5h5M9 14l2 2 4-4', need: (p) => p.viewLogs },
  { href: '/coverage', label: 'Coverage', icon: 'M12 3 4 7v5c0 5 3.5 8 8 9 4.5-1 8-4 8-9V7zM8 12h8M8 12v4M16 12v4M12 8v8', need: (p) => p.viewLogs },
  // Connections stays visible to everyone: the page gives each member their own
  // browser-extension token (capture their own AI use); the enterprise-connect
  // section inside is admin-gated separately.
  { href: '/connections', label: 'Connections', icon: 'M9 12a3 3 0 0 0 3 3m-3-3a3 3 0 0 1 3-3m-3 3H4m8 0h8M7 8l-3 4 3 4M17 8l3 4-3 4' },
  { href: '/policies', label: 'Policies', icon: 'M7 3h7l5 5v13H7zM14 3v5h5M9 13h6M9 17h4' },
  { href: '/staff', label: 'Staff', icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' },
  { href: '/tools', label: 'AI tools', icon: 'M12 3 4 7v5c0 5 3.5 8 8 9 4.5-1 8-4 8-9V7zM9 12l2 2 4-4' },
  { href: '/training', label: 'Training', icon: 'M22 10 12 5 2 10l10 5 10-5zM6 12v5c0 1 3 3 6 3s6-2 6-3v-5' },
  { href: '/accounts', label: 'AI accounts', icon: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1' },
  { href: '/billing', label: 'Billing', icon: 'M2 7h20v10H2zM2 11h20M6 15h4' },
  // Developer-only (dev@example.com): the error console. Never shown to others.
  { href: '/developers', label: 'Developers', icon: 'M8 9l-4 3 4 3M16 9l4 3-4 3M13 6l-2 12', need: (p) => p.isDeveloper },
]

export default function Sidebar({ firmName, who, isAdmin, viewLogs, isDeveloper }: { firmName: string; who: string; isAdmin: boolean; viewLogs: boolean; isDeveloper: boolean }) {
  const path = usePathname()
  const perms = { isAdmin, viewLogs, isDeveloper }
  return (
    <aside className="side">
      <Link href="/dashboard" className="brand">
        <img src="/logo-reversed.svg" alt="" />
        <span>AI Compliance</span>
      </Link>
      <nav>
        {NAV.filter((n) => !n.need || n.need(perms)).map((n) => {
          const active = path === n.href || path?.startsWith(n.href + '/')
          return (
            <Link
              key={n.href}
              href={n.href}
              className={active ? 'active' : ''}
              aria-label={n.label}
              aria-current={active ? 'page' : undefined}
            >
              <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={n.icon} /></svg>
              <span>{n.label}</span>
            </Link>
          )
        })}
      </nav>
      <div className="who">
        <b>{firmName}</b>
        {who}
        <form action={signOut} style={{ marginTop: 10 }}>
          <SubmitButton className="btn btn-ghost btn-sm btn-block" pendingLabel="Signing out…">Sign out</SubmitButton>
        </form>
      </div>
    </aside>
  )
}
