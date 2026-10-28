# AI Compliance

A self-hostable **record of supervision** for professionals who use AI in client work. It proves a human reviewed what the AI produced, and exports that proof as a tamper-evident evidence packet a regulator, client or insurer can check.

It is built around US tax practices (IRS Circular 230), but the core (policies, attestations, a hash-chained review log, automatic AI capture) works for any regulated profession.

> Evidence tooling, not assurance. Nothing here is legal or tax advice.

## What it does

- **AI-use policy:** a generator produces a draft policy from a short questionnaire; the app versions it, and staff acknowledge each version.
- **Review records:** every AI interaction becomes an entry in an append-only, per-firm **hash chain**. A human marks each one reviewed and approved.
- **Automatic capture:** a browser extension (ChatGPT, Claude, Grok, Gemini, Copilot) and a desktop app (Claude Code, Codex CLI, Claude Desktop transcripts) log AI use as it happens. Enterprise API connectors (OpenAI, Anthropic, Gemini, Copilot, Grok) pull usage logs on a schedule.
- **Coverage and evidence packet:** a dashboard shows what is covered, and one click freezes a snapshot (policy, attestations, review log, coverage) with a packet hash anyone can verify against the chain.
- **Firm admin:** staff invites, role-scoped permissions, a tool register, training records and firm document uploads.

## Architecture

```
Browser extension ─┐
Desktop app ───────┼──> Next.js app (web/) ──> Supabase: Postgres + Auth + Storage
API connectors ────┘     server-side RPCs        row-level security on every table
```

- **Multi-tenant by design.** Every table is scoped to a firm and protected by row-level security. A CI job (`.github/workflows/rls-check.yml`) replays every migration on a clean Postgres and fails the build if any table is missing RLS or its tenant policy.
- **Integrity is computed in the database.** All writes to the record go through `SECURITY DEFINER` functions (`log_ai_event`, `ingest_ai_event`) that compute the chain hash in Postgres. Clients never supply integrity data.
- **Capture clients pair once.** The app issues a one-time connect code; the extension and desktop app redeem it for their own session and refresh it themselves. They will only send data to the app hostname you configure.
- **Data-minimized by default.** Captured prompts and outputs are stored only if the firm opts in; otherwise only metadata and hashes are kept.

## Repository layout

| Path | What |
|---|---|
| `web/` | Next.js 16 app (App Router, Server Actions, `@supabase/ssr`). |
| `db/migrations/` | Numbered SQL migrations, the source of truth for the schema. |
| `scripts/` | `migrate.mjs` (migration runner), `check-rls.mjs` (RLS enforcement), `run-sql.mjs`, `save-policy.mjs`, and `ci/` (auth shim + tenant-isolation test). |
| `policy-generator/` | Standalone, no-login policy generator (a single static HTML page). |
| `Connectors/extension/` | Manifest V3 browser extension (Chrome, Edge, Firefox). |
| `Connectors/desktop/` | Electron tray app for macOS and Windows. |
| `.do/app.yaml` | Example DigitalOcean App Platform spec. Any Node host works. |
| `DESIGN.md` | Design tokens and visual rules shared by the app and generator. |

## Setup

You need Node 22+, a [Supabase](https://supabase.com) project, and optionally an email provider for invite links (Supabase Auth's built-in SMTP works for testing).

### 1. Configure

```bash
cp .env.example .env            # used by the scripts in scripts/
cp .env.example web/.env.local  # used by the Next.js app
```

Fill in your Supabase URL, publishable key, secret key and database password (Supabase dashboard → Project Settings → API / Database). The secret key bypasses RLS: keep it server-side and never give it a `NEXT_PUBLIC_` prefix.

### 2. Create the database

```bash
npm install
node scripts/migrate.mjs           # applies db/migrations in order
node scripts/check-rls.mjs         # optional: confirm every table has RLS
```

On an IPv4-only network, set the pooler variables (`SUPABASE_DB_HOST`, `SUPABASE_DB_USER`, `SUPABASE_DB_PORT`) described in `.env.example`.

Then create two **private** Storage buckets in Supabase: `firm-documents` and `course-materials`.

### 3. Bootstrap the first admin

There is no public sign-up; admins invite staff from inside the app. To create the first admin:

1. Supabase dashboard → Authentication → Users → **Add user** (email + password). Copy the new user's ID.
2. Run in the SQL editor:

```sql
insert into app_user (id, firm_id, username, email, role)
select '<auth user id>', id, 'admin', '<email>', 'admin'
from firm where name = 'Admin firm';

-- optional: rename the seeded firm
update firm set name = 'Your Firm LLP' where name = 'Admin firm';
-- optional: unlock the developer error console for this login
update app_user set is_developer = true where email = '<email>';
```

### 4. Run the app

```bash
cd web
npm install
npm run dev        # http://localhost:3000
```

Sign in with the admin you created. `NEXT_PUBLIC_APP_URL` controls where invite and recovery email links land (defaults to `http://localhost:3000`).

### 5. Optional services

| Variable | Enables |
|---|---|
| `CONNECTOR_ENC_KEY` | Enterprise API connectors (32 random bytes, base64; encrypts stored provider keys). Generate with `openssl rand -base64 32`. |
| `CRON_SECRET` | `POST /api/cron/sync-connectors`: your scheduler sends it in an `x-cron-secret` header. |
| `STRIPE_SECRET_KEY` | Billing. Without it the billing page records a plan choice and skips checkout. Plans are defined in `web/lib/plans.ts`. |

### 6. Point the capture clients at your app

Both clients refuse to send data anywhere except your app's hostname (or `localhost` for development).

- **Extension:** set `APP_HOST` in `Connectors/extension/auth.js` and add `https://<your host>/*` to `host_permissions` in `manifest.json`. Load the folder unpacked (`chrome://extensions` → Developer mode → Load unpacked).
- **Desktop:** set `APP_HOST` in `Connectors/desktop/src/auth.ts`, then `cd Connectors/desktop && npm install && npm run dev`. `npm run dist:mac` / `npm run dist:win` build installers.

Then in the app, open **Connections**, generate a connect code and paste it into the extension popup or the desktop preferences window.

### 7. Policy generator (optional)

`policy-generator/index.html` is a static page you can host anywhere. To let it hand selections to the app, set `SUPA_URL` and `SUPA_KEY` (publishable key only) near the bottom of the file; left as placeholders, that step is skipped.

## Deploying

The app is stateless, so any Node host works. For DigitalOcean App Platform, edit `.do/app.yaml` (repo, domain, env values) and run `doctl apps create --spec .do/app.yaml`. Set secret values in the platform, never in the spec.

## License

No license has been chosen yet, so all rights are reserved by default. Open an issue if you would like to use it.
