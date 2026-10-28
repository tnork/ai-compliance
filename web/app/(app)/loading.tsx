// Route-transition skeleton for every authenticated page: the shell (sidebar)
// stays put, the content area shows a quiet layout-shaped shimmer instead of a
// blank flash while the server component fetches. Matches the shared page
// anatomy (eyebrow / h1 / lead / cards) so arrival doesn't jump.
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="page-head">
        <div style={{ width: '100%', maxWidth: 640 }}>
          <div className="skel" style={{ width: 180, height: 12, marginBottom: 12 }} />
          <div className="skel" style={{ width: 260, height: 28, marginBottom: 12 }} />
          <div className="skel" style={{ width: '80%', height: 14 }} />
        </div>
      </div>
      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        <div className="skel" style={{ height: 88 }} />
        <div className="skel" style={{ height: 88 }} />
        <div className="skel" style={{ height: 88 }} />
      </div>
      <div className="skel" style={{ height: 220, borderRadius: 'var(--r-lg)' }} />
    </div>
  )
}
