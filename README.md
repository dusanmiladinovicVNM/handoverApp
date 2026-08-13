# Apartment Handover App

Web app for landlord/tenant apartment inspections (move-in, move-out, periodic, damage report, key handover) with photos, signatures, and PDF reports.

**Stack**
- Frontend: vanilla JS PWA, hosted on GitHub Pages
- Backend: Google Apps Script (Web App)
- Storage: Google Sheet (canonical metadata) + Google Drive (photos, signatures, PDFs)
- PDF generation: Google Doc template → PDF export

**Working language**: English only.

---

## Project Structure

```
handover-app/
  README.md                  ← you are here
  docs/
    sheet-schema.md          ← all sheet tab columns
    api-contract.md          ← all API endpoints
    setup-guide.md           ← step-by-step setup (READ THIS FIRST)
  backend-gas/               ← copy-paste into Apps Script editor
    appsscript.json
    Code.gs                  ← entry point (doPost / doGet)
    Router.gs
    Config.gs
    Utils.gs
    AuthService.gs           ← HMAC token logic
    SheetService.gs          ← canonical store
    DriveService.gs          ← folders, photo/signature uploads
    SchemaService.gs
    ValidationService.gs     ← conditional logic engine
    InspectionService.gs     ← create/get/lock/unlock
    AttachmentService.gs
    SignatureService.gs
    PdfService.gs            ← PDF generation
    AuditService.gs
    ResponseService.gs
    BootstrapService.gs      ← run once after setup
    SchemaSeed.gs            ← all 5 inspection schemas
  frontend/                  ← deploy to GitHub Pages
    index.html
    manifest.webmanifest
    sw.js                    ← service worker
    css/
      tokens.css
      layout.css
      components.css
      forms.css
    js/
      app.js                 ← entry, boot, route registration
      router.js
      api.js                 ← fetch wrapper with auth
      state.js               ← pub/sub store
      config.js              ← EDIT after backend deploy
      validator.js           ← client mirror of server validation
      ui.js                  ← toasts, modals
      components.js          ← question card, image uploader, signature pad
      pages.js               ← all page renderers
      utils/
        dom.js               ← h() helper
        image.js             ← canvas-based compression
        format.js            ← date / status formatting
    assets/
      icons/
        icon.svg             ← placeholder, replace with branding
```

---

## Quickstart

1. **Read** `docs/setup-guide.md`. Follow Steps 1–11 in order.
2. After Apps Script deploy (Step 8), copy the Web App URL.
3. After GitHub Pages deploy (Step 10), edit `frontend/js/config.js`:
   ```js
   export const BACKEND_URL = 'https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec';
   export const FRONTEND_BASE_PATH = '/handover-app/';
   ```
4. Push to GitHub. GitHub Pages picks it up automatically.
5. Visit `https://<username>.github.io/handover-app/` and create a test inspection.

---

## How It Works

### Two auth modes
- **Internal staff (admin)** — Google login. Email must be in `ADMIN_EMAILS` allowlist (Script Property).
- **Tenant** — opens a private link `…/#/inspection/INS-…?t=<token>`. Token is HMAC-SHA256 signed; expires after 7 days; can be revoked by issuing a new one.

### Inspection lifecycle
```
draft → under_review → locked_for_signature → partially_signed → signed → archived
                                  ↑                         |
                                  └── unlock invalidates ────┘
                                       all signatures
```

- Admin creates inspection, fills sections, locks for signature.
- Tenant opens link, reviews, signs.
- Landlord signs.
- When both signed, admin generates final PDF.

### Storage model
- **Google Sheet** is the canonical store: `Inspections`, `Answers`, `Attachments`, `Signatures`, `AuditLog`, `Schemas`, `Config` tabs.
- **Drive** holds binary assets only: photos in `/Inspections/<year>/<inspection-id>/photos/`, signatures in `signatures/`, final PDF + JSON snapshot in `output/`.
- **No** offline-first / IndexedDB sync. App requires connection. Autosave debounces writes by 1.5s.

### Conditional logic
Schema items can have `visibleWhen` and `requiredWhen` clauses with operators `equals`, `notEquals`, `in`, `notIn`, `truthy`, `falsy` plus `all`/`any` combinators. See `docs/api-contract.md` for examples.

---

## Customizing Schemas

Schemas live in `backend-gas/SchemaSeed.gs`. To add fields:
1. Edit `SchemaSeed.gs` in Apps Script editor.
2. Bump the version (e.g., `schema_move_in_v2`).
3. Run `loadInitialSchemas()` to update the Schemas sheet.

Existing inspections keep their original schema (snapshot at creation). New inspections get the latest active schema.

---

## Operational Notes

**Re-deploying backend code**: in Apps Script, Deploy → Manage deployments → Edit (pencil) → New version → Deploy. **Do NOT** create a new deployment — that gives a new URL and breaks all outstanding tenant links.

**Backups**: Drive auto-versions Sheets. Each finalized inspection also has a JSON snapshot in its output folder.

**Drive sharing**: `/Inspections` cannot be made private yet, and it is worth
being exact about why, because the temptation is to close it as soon as the
report stops being a Drive link.

The final report is fetched through the `downloadPdf` action now, which applies
the same access rule as every other inspection handler — admin, the assigned
inspector, or the tenant token issued for that one inspection. So the app no
longer *hands out* a Drive URL for it.

But photo thumbnails still come straight from Drive: `getThumbnailUrl` returns
`drive.google.com/thumbnail?id=…`, and the browser fetches that with whatever
Google account it happens to have. A tenant has none. Close the folder and every
photograph in every inspection stops rendering — for the tenant certainly, and
for staff not signed into an account with access.

Photos and the report are siblings under the same inspection folder, and Drive
sharing is inherited, so there is no closing one without the other:

```
/Inspections/<year>/<inspectionId>/photos/   ← thumbnails, fetched by the browser
/Inspections/<year>/<inspectionId>/output/   ← the report, fetched through the API
```

**So the sequence is: move thumbnails through the API first, then close the
folder.** Until then the file id remains the only protection on anything in
there, which is what the `downloadPdf` work exists to end — it has removed the
app as a source of those ids, not the exposure itself.

**Quota**: free Google account has Apps Script daily limits. At ~50 inspections/month, you're nowhere near them.

**Monitoring**: Apps Script Executions tab shows all incoming requests, errors, and durations.

---

## Known Limitations / Out of MVP Scope

- **No offline mode**: edits require active connection. Autosave covers spotty connections, but a totally offline session would lose data.
- **Single tenant per inspection**: only one tenant signs. No multi-tenant or co-signers.
- **No email notifications**: tenant link must be shared manually (copied + pasted into email/SMS).
- **No witness / agent roles in MVP**: schema supports them but signature flow expects only `landlord` + `tenant`.
- **No granular admin roles**: any email in `ADMIN_EMAILS` is full admin.
- **Photo thumbnails still come straight from Drive**: `getThumbnailUrl` returns a `drive.google.com/thumbnail?id=…` URL, so photos only render while `/Inspections` is readable without signing in. The final report no longer works this way — it goes through `downloadPdf` — but the folder cannot be closed until the thumbnails follow, because both live under it. See **Drive sharing** in Operational Notes for the order this has to happen in.

These are deliberate scope cuts. Adding them later requires additive changes only — no schema migration.

---

## Files Created in This Build

- 17 backend `.gs` files
- 4 CSS files
- 12 frontend JS files (modular ES modules)
- HTML, manifest, service worker, icon
- 3 documentation files
- This README

42 files total.
