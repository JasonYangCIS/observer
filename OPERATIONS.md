# Operations

How Observer is hosted, configured, and monitored. Never put real secret values in this file or anywhere else in the repo.

## Stack

- **Hosting:** Netlify (`netlify.toml`, `NITRO_PRESET=netlify`). Merging to `main` builds and deploys production.
- **Database:** Supabase, used only as plain Postgres. The app connects directly; it does not use Supabase Auth, Storage, the REST API, or any Supabase keys.
- **Auth:** Better Auth (framework-provided).
- **LLM:** Builder.io credits, connected through the app's "Use Builder.io" flow after sign-in. No provider API key is set.
- **Local dev:** PGlite (`data/pglite`), no Supabase connection needed.

## Environment variables (Netlify)

| Name | Value | Scope |
|---|---|---|
| `DATABASE_URL` | Supabase **transaction pooler** URL (port 6543) | Runtime |
| `MIGRATION_DATABASE_URL` | Supabase **session pooler** URL (port 5432) | Production builds only |
| `BETTER_AUTH_SECRET` | 32+ char random string (`openssl rand -hex 32`) | All contexts |

Notes:
- `netlify.toml` runs `pnpm migrate:production` only on production builds, with `DATABASE_URL` set to `MIGRATION_DATABASE_URL`. The build fails with a clear message if it is missing. Migrations must not run through the transaction pooler.
- Keep `BETTER_AUTH_SECRET` stable. Changing it logs everyone out and can strand values encrypted with it.
- Redeploy after changing any environment variable; existing deploys keep old values.
- Preview deploys must not share the production database. Use a separate Supabase project for previews, or leave `DATABASE_URL` scoped to Production until one exists.
- If a database password is ever exposed (chat, logs, commits), reset it in Supabase (Project Settings → Database) and update both URLs in Netlify.

## Supabase security posture

- The **Data API (PostgREST) is disabled** (since 2026-10-06). RLS is **not** enabled on `public` tables, so Supabase Advisor "RLS Disabled in Public" warnings are expected.
- Do not re-enable the Data API or use the anon/service-role keys in this app without first enabling RLS on every `public` table. Do that in small batches with `SET lock_timeout`, or via `psql` over the session pooler; one big transaction in the SQL Editor timed out.
- Consider adding `ENABLE ROW LEVEL SECURITY` to Drizzle migrations for new tables.

## What to monitor

### Supabase
- **Project status / pausing:** free projects pause after about a week of inactivity, which takes the site down. Upgrading to Pro removes this risk.
- **Database size:** the free tier caps around 500 MB. Watch Database → Usage/Reports; follow the `fetched_text` retention policy in `PLAN.md`.
- **Connections:** Reports → Database. Serverless functions can exhaust connections, hence the transaction pooler.
- **Postgres errors:** Logs → Postgres. Some errors around deploy-time migrations are normal; repeated errors during normal use are not.
- **Advisors:** ignore the known RLS warnings; watch for new categories (slow queries, missing indexes).
- **Backups:** free projects have limited backups. Decide on a backup plan before storing data that can't be rebuilt (feedback, interest profiles).

### Netlify
- **Deploys:** confirm production builds succeed; a failed migration fails the deploy and the previous version stays live. Enable failure notifications (Project configuration → Notifications).
- **Function logs:** Logs → Functions for timeouts and 5xx errors; especially once the daily ingest job exists.
- **Usage:** build minutes, function invocations, and bandwidth against plan limits.

### Builder
- Credits drain with every agent call. Check the balance in the Builder account, and see the cost limits in `PLAN.md`.

## Related

- `PLAN.md` — product plan, phases, and hosting decisions.
- `DEVELOPING.md` — local development.

## Secret hygiene

- GitHub secret scanning and push protection are enabled on the repo (it is public).
- CI runs gitleaks (`.github/workflows/secrets.yml`, config in `.gitleaks.toml`) on every PR and push to `main`. It adds a rule for database URLs with inline passwords. Real values never belong in code, docs, tests, or chat; use obvious placeholders such as `postgresql://user:password@host/db`.
- `.env*` (except `.env.example`), `.agent-native/`, and local database files are gitignored. If a secret is ever committed, rotate it immediately; removing it from a later commit does not remove it from history.
