'use client'

export default function PrintButton({ children }: { children: React.ReactNode }) {
  return (
    <button type="button" className="btn btn-primary no-print" onClick={() => window.print()}>
      {children}
    </button>
  )
}
