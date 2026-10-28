import { requireUser, canViewLogs, isDeveloper } from '@/lib/auth'
import Sidebar from './Sidebar'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const u = await requireUser()
  const who = `${u.username || u.email} · ${u.role === 'admin' ? 'admin' : 'user'}`
  return (
    <div className="shell">
      <Sidebar firmName={u.firmName} who={who} isAdmin={u.role === 'admin'} viewLogs={canViewLogs(u)} isDeveloper={isDeveloper(u)} />
      <main className="main">{children}</main>
    </div>
  )
}
