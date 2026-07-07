# City Wide Boston — Key Management System
## Installation & User Guide

---

### What is this?

City Wide Boston Key Management System (KMS) is a secure, centralized tool for tracking IC vendor key assignments, access codes, and check-out/check-in activity. It runs as a web app hosted on Render and optionally as an offline-capable Windows desktop app that syncs automatically when internet is available.

---

### Web Access

**URL:** https://citywide-frontend.onrender.com

**Login steps:**
1. Open the URL above in any browser (Chrome or Edge recommended).
2. Enter your email: `cara@citywideboston.com`
3. Enter your password (see Credentials sheet).
4. Click **Sign In**.

> **Note:** The first page load after a period of inactivity may take 20–30 seconds — Render spins down the free-tier service. Subsequent loads are instant.

---

### Desktop App — Windows Install

1. Copy `CityWideKMS-Setup-x.x.x.exe` to your Windows PC.
2. Double-click the installer.

**Windows SmartScreen warning — this is expected and safe:**

> *"Windows protected your PC — Microsoft Defender SmartScreen prevented an unrecognized app from starting."*

This appears because the installer is not yet code-signed (no paid certificate). The software is safe. To proceed:

1. Click **More info** (blue link under the warning text).
2. Click **Run anyway**.
3. Follow the installer — choose your install folder, then click **Install**.

A **City Wide KMS** shortcut will appear on your Desktop and Start Menu.

---

### First Launch

1. Open **City Wide KMS** from your Desktop.
2. On first launch the app copies the seed database and starts the embedded server — this takes about 5 seconds.
3. Enter your web credentials (same email and password as the web app).
4. The app will **automatically sync** the latest registry data from the server — an internet connection is required for this first sync.

---

### Offline Use

The desktop app keeps a full local copy of the registry. If you lose Wi-Fi or go to a job site without internet:

- All key check-out/check-in, vault lookups, and registry edits work normally.
- Changes are queued locally and **automatically uploaded** the next time the app connects to the internet.
- AI Assistant questions asked offline are also queued and answered when connectivity is restored.

**To sync manually:** Look at the bottom-left corner of the sidebar. You will see a **"Sync now"** button — click it any time to push queued changes and pull the latest data from the server.

---

### Support

For technical support or questions about this system, contact:

**Tye Jordan** — 978-493-9118 · tye.jordan@cinchit.com

---

*City Wide Facility Solutions — Boston*
