-- AI Compliance — 0006: contact_message (public "Contact us" form submissions).
-- Separate from `lead` (policy-gen funnel) by design: contact inquiries carry a message/phone
-- and are not lead-magnet signups. Same public-capture posture as `lead`:
-- firm_id-EXEMPT (submissions arrive before any tenant exists), RLS on, anon may INSERT only
-- (public form), NO anon SELECT (only the service role reads). See 0004 `lead` for the pattern.

create table if not exists contact_message (
  id uuid primary key default gen_random_uuid(),
  email      citext not null,
  first_name text,
  last_name  text,
  firm_name  text,
  phone      text,
  message    text,
  source     text default 'contact',
  created_at timestamptz not null default now()
);
alter table contact_message enable row level security;
drop policy if exists contact_message_insert on contact_message;
create policy contact_message_insert on contact_message for insert to anon, authenticated with check (true);
-- (no select/update/delete policy → only the service role can read contact submissions)
comment on table contact_message is 'Public "Contact us" submissions (anon INSERT only, no anon SELECT; firm_id-exempt public capture). Read via service role.';
