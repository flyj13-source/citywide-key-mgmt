# City Wide KMS — Offline Windows Desktop

Electron wrapper around the existing React frontend + Express backend, with a
local SQLite mirror, an offline write/sync engine, and a queued AI assistant.

## Architecture

- **Electron main process** (`main.ts`) boots the compiled Express backend
  (`backend/dist`) in-process on `localhost:3001` and loads the packaged
  frontend via `loadFile` (no dev server).
- **Local SQLite** at `%APPDATA%/CityWideKMS/citywide.db` — full offline
  operation. On first launch the bundled seed DB is copied in.
- **Sync engine** (`sync/engine.ts`) polls Render `/api/health` every 30s +
  Electron `net` online events. When online it pulls accounts/assignments/
  audit/contractors (server wins) and pushes the local `sync_queue`
  (last-write-wins; conflicts audit-logged as `sync_conflict`). Every local
  mutation is written to SQLite immediately **and** appended to `sync_queue`
  by a backend middleware — the UI never blocks.
- **Queued AI** — online, `/api/claude` answers normally. Offline, the question
  is saved to `ai_queue` (HTTP 202) and shown with an amber “Queued” pill; on
  reconnect the engine flushes the queue and the pill flips to Answered.

## Build

From the repo root:

```bash
npm run desktop:dev      # build backend + desktop frontend + launch Electron
npm run desktop:build    # → desktop/release/CityWideKMS-Setup-1.0.0.exe
```

Produces an unsigned NSIS x64 installer. Building the Windows `.exe` from macOS
requires Rosetta 2 on Apple Silicon (`softwareupdate --install-rosetta`) because
electron-builder stamps the exe via an x86 `wine`/`rcedit`.

The packaged seed template is `backend/database/citywide.db` (git-ignored
runtime data). The `desktop:build`/`desktop:dev` pipeline runs `ensure:seed`
first, which auto-generates it via `npm --prefix backend run seed` **only if
missing** — so a clean clone builds without manual steps, and an existing local
DB with real data is never clobbered.

## Configuration (env)

| Var                        | Purpose                                              |
|----------------------------|------------------------------------------------------|
| `ANTHROPIC_API_KEY`        | AI answers (online + queue flush)                    |
| `CITYWIDE_SYNC_EMAIL`      | Render manager login used by the sync engine         |
| `CITYWIDE_SYNC_PASSWORD`   | …password (defaults to the demo creds)               |
| `JWT_SECRET`, `ENCRYPTION_KEY` | fall back to project defaults if unset           |

> The sync engine authenticates to Render with `CITYWIDE_SYNC_EMAIL/PASSWORD`.
> Production Render uses a different seed password than the local demo, so set
> these for pull/push to succeed; without valid creds the engine stays offline-
> only and retries.
