'use client'

import { useState } from 'react'

// Log-form course picker: choose a saved course, or "Other" to free-type one
// (backward-compatible with the original free-text course_name field).
export default function CourseSelect({ courses }: { courses: { id: string; name: string }[] }) {
  const [val, setVal] = useState(courses[0]?.id ?? 'other')
  return (
    <>
      <select className="select" id="course_id" name="course_id" value={val} onChange={(e) => setVal(e.target.value)}>
        {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        <option value="other">Other (type below)…</option>
      </select>
      {val === 'other' && (
        <input className="input" name="course_name" placeholder="Course name" style={{ marginTop: 8 }} required aria-label="Course name" />
      )}
    </>
  )
}
