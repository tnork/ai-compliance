-- 0028: per-user onboarding completion flag.
--
-- The dashboard's "Onboarding Setup" card (formerly "Next Steps") shows the
-- 6 firm-setup steps with completed ones struck through. Once ALL steps are
-- complete for the viewer, the server stamps this column and the card never
-- renders for that user again (even if a condition later regresses - Key
-- Actions keeps surfacing anything required).
--
-- Written ONLY server-side (service-role update pinned to the caller's own
-- id + firm_id, derived from server-computed completion - never client-set).
-- No RLS change: app_user's existing policies already let a member read
-- their own row, and there is no client write path to this column.

alter table public.app_user
  add column if not exists onboarding_done_at timestamptz;

comment on column public.app_user.onboarding_done_at is
  'Set once when the dashboard onboarding checklist first computed as fully complete for this user; hides the Onboarding Setup card permanently. Server-derived, service-role write only.';
