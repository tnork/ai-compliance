import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { addTraining, deleteTraining, addCourse, deleteCourse, uploadAttachment, deleteAttachment } from './actions'
import CourseSelect from './CourseSelect'
import SubmitButton from '@/components/SubmitButton'

function fmt(d: string | null) {
  return d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '-'
}
function kb(n: number | null) {
  if (!n) return ''
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}

export default async function TrainingPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const me = await requireUser()
  const sp = await searchParams
  const supabase = await createClient()
  const [{ data: rows }, { data: staff }, { data: courses }, { data: attachments }] = await Promise.all([
    supabase.from('training_record').select('id, course_name, completed_at, expires_at, user_id').order('completed_at', { ascending: false }),
    supabase.from('app_user').select('id, username, email'),
    supabase.from('course').select('id, name, provider, website, summary, created_by').order('created_at', { ascending: false }),
    supabase.from('course_attachment').select('id, course_id, file_name, byte_size, uploaded_by').order('created_at', { ascending: true }),
  ])
  const nameOf = (id: string) => {
    const s = staff?.find((u) => u.id === id)
    return s?.username || s?.email || '-'
  }
  const expired = (d: string | null) => (d ? new Date(d) < new Date() : false)
  const attsFor = (cid: string) => (attachments ?? []).filter((a) => a.course_id === cid)
  const courseList = (courses ?? []).map((c) => ({ id: c.id, name: c.name }))

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">§10.35 · COMPETENCE</div>
          <h1>Training log</h1>
          <p>Record who completed AI-use training and when it lapses - the competence evidence Circular 230 §10.35 expects. Build a course catalog below and pick from it when logging.</p>
        </div>
      </div>

      {sp.e && <div className="msg err" role="alert" style={{ maxWidth: 720 }}>{sp.e}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginBottom: 14 }}>Log a completion</h2>
        <form action={addTraining}>
          <div className="grid grid-4">
            <div className="field"><label htmlFor="user_id">Staff member</label>
              <select className="select" id="user_id" name="user_id" required>
                {staff?.map((u) => <option key={u.id} value={u.id}>{u.username || u.email}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="course_id">Course</label><CourseSelect courses={courseList} /></div>
            <div className="field"><label htmlFor="completed_at">Completed</label><input className="input" id="completed_at" name="completed_at" type="date" /></div>
            <div className="field"><label htmlFor="expires_at">Expires</label><input className="input" id="expires_at" name="expires_at" type="date" /></div>
          </div>
          <SubmitButton className="btn btn-primary" pendingLabel="Logging…">Log training</SubmitButton>
        </form>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        {rows && rows.length > 0 ? (
          <table className="table">
            <thead><tr><th>Staff</th><th>Course</th><th>Completed</th><th>Expires</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="t-key">{nameOf(r.user_id)}</td>
                  <td>{r.course_name}</td>
                  <td>{fmt(r.completed_at)}</td>
                  <td>{r.expires_at ? <span className={`badge ${expired(r.expires_at) ? 'warn' : 'ok'}`}>{expired(r.expires_at) ? 'Expired' : fmt(r.expires_at)}</span> : '-'}</td>
                  <td>{me.role === 'admin' ? <form action={deleteTraining}><input type="hidden" name="id" value={r.id} /><SubmitButton className="btn btn-danger btn-sm" pendingLabel="Removing…">Remove</SubmitButton></form> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No training logged yet.</div>
        )}
      </div>

      {/* ── Course catalog ──────────────────────────────────────────────── */}
      <div className="page-head" style={{ marginBottom: 16 }}>
        <div>
          <div className="eyebrow">COURSE CATALOG</div>
          <h2 className="section-title">Courses</h2>
          <p className="section-sub">Save courses your firm uses for AI-competence training - provider, a link, a summary, and the materials themselves. Saved courses appear in the log dropdown above and can back your §10.35 evidence.</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 14 }}>Add a course</h3>
        <form action={addCourse}>
          <div className="grid grid-2" style={{ marginBottom: 14 }}>
            <div className="field" style={{ marginBottom: 0 }}><label htmlFor="c-name">Name</label><input className="input" id="c-name" name="name" placeholder="Responsible AI Use under Circular 230" required /></div>
            <div className="field" style={{ marginBottom: 0 }}><label htmlFor="c-provider">Provider</label><input className="input" id="c-provider" name="provider" placeholder="AICPA, IRS, internal…" /></div>
            <div className="field" style={{ marginBottom: 0 }}><label htmlFor="c-website">Website</label><input className="input" id="c-website" name="website" type="url" placeholder="https://…" /></div>
            <div className="field" style={{ marginBottom: 0 }}><label htmlFor="c-summary">Notes / content summary</label><input className="input" id="c-summary" name="summary" placeholder="What the course covers" /></div>
          </div>
          <SubmitButton className="btn btn-primary" pendingLabel="Saving…">Add course</SubmitButton>
        </form>
      </div>

      <div className="card">
        {courses && courses.length > 0 ? (
          courses.map((c) => {
            const canManage = me.role === 'admin' || c.created_by === me.id
            const atts = attsFor(c.id)
            return (
              <div key={c.id} style={{ borderTop: '1px solid var(--line)', padding: '16px 0' }}>
                <div className="rowflex" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ color: 'var(--navy)', fontSize: 15.5 }}>{c.name}</strong>
                    {c.provider && <span className="hint" style={{ marginLeft: 8 }}>{c.provider}</span>}
                    {c.website && /^https?:\/\//i.test(c.website) && <div style={{ marginTop: 3 }}><Link href={c.website} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--blue-ink)', fontWeight: 600, fontSize: 13.5 }}>{c.website}</Link></div>}
                    {c.summary && <p style={{ color: 'var(--muted)', fontSize: 14, margin: '6px 0 0' }}>{c.summary}</p>}
                  </div>
                  {canManage && (
                    <form action={deleteCourse}><input type="hidden" name="id" value={c.id} /><SubmitButton className="btn btn-danger btn-sm" pendingLabel="Deleting…">Delete</SubmitButton></form>
                  )}
                </div>

                <div style={{ marginTop: 12 }}>
                  {atts.length > 0 && (
                    <ul style={{ listStyle: 'none', margin: '0 0 10px', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {atts.map((a) => (
                        <li key={a.id} className="rowflex" style={{ gap: 10, fontSize: 14 }}>
                          <span aria-hidden style={{ color: 'var(--muted)' }}>📎</span>
                          <a href={`/api/course-attachment/${a.id}`} style={{ color: 'var(--blue-ink)', fontWeight: 600 }}>{a.file_name}</a>
                          <span className="hint">{kb(a.byte_size)}</span>
                          {(me.role === 'admin' || a.uploaded_by === me.id) && (
                            <form action={deleteAttachment} style={{ marginLeft: 'auto' }}><input type="hidden" name="id" value={a.id} /><SubmitButton className="btn btn-ghost btn-sm" pendingLabel="…">Remove</SubmitButton></form>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <form action={uploadAttachment} className="rowflex" style={{ gap: 10 }}>
                    <input type="hidden" name="course_id" value={c.id} />
                    <input className="input" type="file" name="file" required style={{ maxWidth: 360, padding: '7px 10px' }} aria-label={`Attach a file to ${c.name}`} />
                    <SubmitButton className="btn btn-ghost btn-sm" pendingLabel="Uploading…">Upload material</SubmitButton>
                  </form>
                </div>
              </div>
            )
          })
        ) : (
          <div className="empty">No courses yet. Add one above to build your firm&rsquo;s training catalog.</div>
        )}
        <p className="hint" style={{ marginTop: 14 }}>Attachments are stored privately (max 15 MB each) and shared only within your firm. Not legal or tax advice.</p>
      </div>
    </>
  )
}
