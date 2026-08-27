# City Wide Boston — Key Management System

## Quick Start

```bash
# Backend
cd backend && npm install && npm run seed && npm run dev

# Frontend (new terminal)
cd frontend && npm install && npm run dev
```

Open http://localhost:5173

## Login
- **Email:** cara@citywideboston.com
- **Password:** demo1234

## What's Built

- **150+ real City Wide Boston accounts** loaded from key inventory seed data
- **10 staff members** with hundreds of key assignments across accounts
- **AES-256-GCM encrypted code vault** — alarm codes and door codes encrypted at rest, reveal button with 5-second auto-hide, every reveal audit logged
- **Claude AI assistant** (claude-sonnet-4-6) with full registry context — ask natural language questions about keys, staff, codes
- **Contractor magic link portal** — email invite, 48hr TTL token, HTML5 canvas e-signature, SHA-256 signature hash, PDF receipt generated with pdf-lib
- **Key custody workflow inside the registry** — multi-key check-out (several key types and quantities in one transaction), per-client availability that blocks over-checkout, self-service *or* on-behalf recording (the audit trail names both the actor and the holder), CW-branded check-out/check-in emails to the holder **and** Cara, and a 48hr magic-link sign-off with an e-signature + branded PDF receipt
- **Bulk manager reassignment** — transfer a manager's clients and key responsibility to another manager in one atomic action, with per-client checkboxes for partial transfers, an audit entry per client plus a summary, a 30-day undo, an optional CW-branded key-handover email, and an amber "Handover pending" pill that keeps registry truth and physical truth separate
- **Signature accountability** — the signed PDF goes to the signer, Cara, and the counterparty on a transfer; a holder with no email blocks the check-out at entry with two ways forward (add the address permanently, or record a written reason); records released unsigned are flagged **red** as `signature_unavailable`, never amber, and any unsigned record can be signed on-device at handover with the witness recorded
- **M365 integrations:** Outlook SMTP, Teams adaptive card webhook, OneDrive folder sync
- **Full audit trail** — every action timestamped, attributed, and paginated
- **Excel export** — 4-sheet workbook: Key Registry, Active Assignments, Overdue, Staff Holdings

## Screens
1. **Login** — CW branded
2. **Dashboard** — 4 metrics, overdue panel, recent activity
3. **Key Registry** — searchable/paginated table of all accounts
4. **Key Custody** — Check Out / In lives *inside* the Key Registry (header buttons + **Checked Out** / **Checked In** tabs), with a multi-key checkbox dropdown, availability guardrails, CW-branded emails, and a magic-link sign-off
5. **Code Vault** — encrypted codes table, reveal button (5s auto-hide), audit logged
6. **AI Assistant** — chat panel, full registry passed as context
7. **Audit Log** — immutable table, filterable, Excel export
8. **Reports** — Excel / Outlook / Teams / OneDrive
9. **Contractor Portal** — magic link table, PDF download; public `/contractor/:token` route
10. **Settings** — M365 config reference

## Verifying a deploy (no dashboard needed)

Both services stamp the commit they were built from, so drift between them is
detectable in two curls:

```bash
curl -s $BACKEND/api/health              # {"commit":"<sha>","commit_source":"env|build-file",...}
curl -s $FRONTEND/ | grep build-commit   # <meta name="build-commit" content="<sha>" />
```

Different hashes = the two services are out of step (the usual cause of "old UI,
new API"). The root `render.yaml` blueprint exists to prevent exactly that by
defining both services together; adopt it via Render → Blueprints → New
Blueprint Instance pointed at this repo.

For deeper schema truth, `GET /api/_diag` (JWT + **admin only**) reports the
resolved `DB_PATH` and whether it is on the mounted disk, which of the 16
holder-grid columns exist, the `staff_managers` row count with its
`role_category` distribution and backfill gap, record counts, and which feature
migrations are live. `POST /api/_diag/backfill-staff` (admin) re-runs the
idempotent staff-roster backfill without waiting for a redeploy.

## Deploy to Railway

### One-time setup
1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select `flyj13-source/citywide-key-mgmt`
3. Add **backend service** → set Root Directory to `/backend`
4. Add **frontend service** → set Root Directory to `/frontend`

### Backend environment variables (Railway → Variables tab)
```
JWT_SECRET=           # openssl rand -hex 32
ENCRYPTION_KEY=       # openssl rand -hex 32  (must be different from JWT_SECRET)
ANTHROPIC_API_KEY=    # from console.anthropic.com
SMTP_USER=            # cara@citywideboston.com
SMTP_PASS=            # Microsoft app password → account.microsoft.com/security → App passwords
TEAMS_WEBHOOK_URL=    # Teams Facilities channel → ··· → Connectors → Incoming Webhook
FRONTEND_URL=         # Railway frontend URL, e.g. https://citywide-frontend.up.railway.app
NODE_ENV=production
PORT=3001
```

### Frontend environment variables
```
VITE_API_URL=         # Railway backend URL, e.g. https://citywide-backend.up.railway.app
```

### After deploy
```bash
# Reset the demo password to something secure
npm run reset-password -- --email cara@citywideboston.com --password [newpassword]
```
- Share the Railway frontend URL with Cara Angeloni
- Add a custom domain in Railway → Settings → Domains (e.g. `keys.citywideboston.com`)

---

## Test / troubleshooting account

A dedicated admin account (separate from Cara's) for troubleshooting, error
correction, and update verification. Its audit entries are badged with a neutral
**TEST** pill in the Audit Log and Dashboard, and sentinel/test records
(`bc_client_number` starting `999`) are excluded from the dashboard Customers
count and Keys-by-Holder sums so real numbers stay truthful. The persistence
gauntlet (`npm run persist:*`) authenticates as this account only — never Cara's.

**Enable** (the account is created only when a password is set):
1. Set two env vars in Render → Environment (and in `backend/.env` for local use):
   ```
   TEST_USER_EMAIL=test@citywideboston.com
   TEST_USER_PASSWORD=<a-password-you-choose>     # never hardcoded; keep it secret
   ```
2. Redeploy / restart. `autoSeedIfEmpty()` inserts the account **only if absent**
   (it never resets an existing password). Login: `test@citywideboston.com` +
   the password you set. If `TEST_USER_PASSWORD` is unset the boot log prints
   `test user skipped, no password set` and no account is created.

**Disable** (soft revoke — keeps audit history):
```bash
cd backend
npm run test-user:disable      # sets a random unknown password hash; row + audit preserved
```
To re-enable, set a fresh `TEST_USER_PASSWORD` and redeploy, or
`npm run reset-password -- --email test@citywideboston.com --password <new>`.

---

## Proving data survives

Three layers guarantee that typed and imported data never disappears across
restarts and deploys.

**Layer 1 — root-cause guard (config).** Seeding runs at *runtime* on boot
(`autoSeedIfEmpty()` in `src/index.ts`), never in Render's `buildCommand`, and
only when the managers table is empty. Every boot prints one grep-able line:

```
BOOT: db=<path> onMount=<true|false> tables=<n> customers=<n> ics=<n>
```

`onMount` must be **true** — the SQLite file must live on the mounted disk
(`DB_PATH=/data/citywide.db`, disk mounted at `/data`). If it is false the boot
log prints a red `DATABASE IS EPHEMERAL` warning; fix the disk/`DB_PATH` in the
Render dashboard before trusting anything else.

**Layer 2 — local integration tests** (`backend/tests/data-survival.test.ts`,
run by CI on every push):

```bash
cd backend && npm test
```

Covers input round-trip (every field byte-identical after the DB file is closed
and reopened, codes encrypted at rest), import round-trip (600-row sheet → 590
inserted / 10 bad rows reported → survives reopen), restart simulation (the full
boot sequence re-runs 3× with counts, rows and the manager password hash
byte-identical), and archive survival.

**Layer 3 — production gauntlet** (`backend/scripts/gauntlet.ts`). Authenticates
as the test account only. Requires `TEST_USER_PASSWORD` in `backend/.env`.

```bash
cd backend
npm run gauntlet:write     # write a sentinel to prod + snapshot counts
#   → trigger a deploy, then:
npm run gauntlet:verify    # sentinel + counts survived? PASS/FAIL, then cleans up

npm run gauntlet:full      # write → trigger the deploy via the Render API
                           # (RENDER_API_KEY) → poll until live → verify, in one shot
```

`gauntlet:full` fails loudly if `onMount=false` on prod (the sentinel vanishes on
the deploy) — which is exactly the failure Layer 1 is meant to prevent.

---

## Configure M365

1. Copy `.env.example` to `backend/.env`
2. Set `SMTP_USER` and `SMTP_PASS` (generate app password in Outlook → account.microsoft.com → Security → App passwords)
3. Set `TEAMS_WEBHOOK_URL` (Teams channel → ··· → Connectors → Incoming Webhook)
4. Set `LOCAL_ONEDRIVE_PATH` to your synced OneDrive folder path
5. Set `ANTHROPIC_API_KEY` from console.anthropic.com

## Stack
- **Frontend:** React 18 + TypeScript + Tailwind CSS + Vite
- **Backend:** Node.js + TypeScript + Express
- **Database:** SQLite (better-sqlite3) — offline-first, zero config
- **Auth:** JWT (8hr expiry)
- **Crypto:** AES-256-GCM (Node.js built-in)
- **PDF:** pdf-lib
- **Excel:** ExcelJS
- **Email:** nodemailer → smtp.office365.com:587
- **AI:** @anthropic-ai/sdk → claude-sonnet-4-6
