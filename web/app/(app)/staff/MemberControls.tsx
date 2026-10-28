'use client'

import { useState } from 'react'
import SubmitButton from '@/components/SubmitButton'
import { updateMember } from './actions'

// Admin-only per-member controls: role (User/Admin) + the two granular grants.
// Admins implicitly have every permission, and review-and-approve implies
// view-logs (you can't review what you can't see) - so the checkboxes lock
// (checked + disabled) whenever a higher grant already covers them.
export default function MemberControls({
  userId, role, canViewLogs, canReview, isSelf,
}: {
  userId: string; role: string; canViewLogs: boolean; canReview: boolean; isSelf: boolean
}) {
  const [isAdmin, setIsAdmin] = useState(role === 'admin')
  const [review, setReview] = useState(canReview)
  const [viewLogs, setViewLogs] = useState(canViewLogs)

  const viewImplied = isAdmin || review // higher grant already covers view-logs
  const viewChecked = viewImplied || viewLogs
  const reviewChecked = isAdmin || review

  return (
    <form action={updateMember} className="member-controls">
      <input type="hidden" name="user_id" value={userId} />
      <div className="member-controls-row">
        <label className="sr-only" htmlFor={`role-${userId}`}>Role</label>
        <select
          id={`role-${userId}`}
          name="role"
          className="select select-sm"
          value={isAdmin ? 'admin' : 'staff'}
          onChange={(e) => setIsAdmin(e.target.value === 'admin')}
        >
          <option value="staff">User</option>
          <option value="admin">Admin</option>
        </select>
        <label className="checkline checkline-inline">
          <input type="checkbox" name="can_view_logs" checked={viewChecked} disabled={viewImplied}
            onChange={(e) => setViewLogs(e.target.checked)} /> View logs
        </label>
        <label className="checkline checkline-inline">
          <input type="checkbox" name="can_review" checked={reviewChecked} disabled={isAdmin}
            onChange={(e) => setReview(e.target.checked)} /> <span>Review <span className="amp">&amp;</span> approve</span>
        </label>
        <SubmitButton className="btn btn-ghost btn-sm" pendingLabel="Saving…">Save</SubmitButton>
      </div>
      {isSelf && <p className="hint" style={{ margin: '6px 0 0' }}>This is you - changing your own role takes effect on your next action.</p>}
    </form>
  )
}
