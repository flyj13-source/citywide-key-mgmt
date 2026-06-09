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
- **M365 integrations:** Outlook SMTP, Teams adaptive card webhook, OneDrive folder sync
- **Full audit trail** — every action timestamped, attributed, and paginated
- **Excel export** — 4-sheet workbook: Key Registry, Active Assignments, Overdue, Staff Holdings

## Screens
1. **Login** — CW branded
2. **Dashboard** — 4 metrics, overdue panel, recent activity
3. **Key Registry** — searchable/paginated table of all accounts
4. **Check Out / In** — two-panel form with account autocomplete, overdue detection
5. **Code Vault** — encrypted codes table, reveal button (5s auto-hide), audit logged
6. **AI Assistant** — chat panel, full registry passed as context
7. **Audit Log** — immutable table, filterable, Excel export
8. **Reports** — Excel / Outlook / Teams / OneDrive
9. **Contractor Portal** — magic link table, PDF download; public `/contractor/:token` route
10. **Settings** — M365 config reference

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
