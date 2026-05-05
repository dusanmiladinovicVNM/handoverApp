# Sheet Schema — Canonical Store

The Google Sheet workbook is the **canonical store** for all inspection metadata. Drive holds binary assets (photos, signature PNGs, final PDF). Per-row writes guarantee atomicity, no race conditions.

Workbook name: **HandoverSystem**
Workbook lives in Drive at: `/Apartment-Handover/HandoverSystem` (Sheet)

---

## Sheet 1: `Inspections`

One row per inspection. The master metadata table.

| Column | Type | Example | Notes |
|---|---|---|---|
| `inspectionId` | string | `INS-2026-000123` | Primary key. Format `INS-YYYY-NNNNNN`. Auto-generated. |
| `status` | string | `draft` | Enum: `draft`, `under_review`, `locked_for_signature`, `partially_signed`, `signed`, `archived`, `cancelled`. |
| `inspectionType` | string | `move_in` | Enum: `move_in`, `move_out`, `periodic`, `damage_report`, `key_handover`. |
| `schemaId` | string | `schema_move_in_v1` | Which schema was active at creation. Snapshot — never updated. |
| `schemaVersion` | number | `1` | For migration logic. |
| `propertyAddress` | string | `Knez Mihailova 12, Belgrade, 11000` | Free-form combined address for display. |
| `propertyUnit` | string | `4B` | Apartment/unit number. |
| `landlordName` | string | `Marko Petrović` | |
| `landlordEmail` | string | `marko@firma.rs` | |
| `landlordPhone` | string | `+381 64 1234567` | |
| `tenantName` | string | `Jelena Jovanović` | |
| `tenantEmail` | string | `jelena@example.com` | |
| `tenantPhone` | string | `+381 65 7654321` | |
| `notes` | string | `Tenant requested early move-in.` | Free-form admin notes. |
| `createdAt` | ISO datetime | `2026-04-03T10:15:00Z` | UTC. |
| `updatedAt` | ISO datetime | `2026-04-03T10:25:00Z` | UTC. Updated on every write. |
| `createdBy` | string | `admin@firma.rs` | Email of internal staff. |
| `driveFolderId` | string | `1aB2cD3eF...` | Drive folder for this inspection. |
| `finalPdfFileId` | string | `1xY2zW...` | Set on finalize. Empty until then. |
| `currentNonce` | string | `a7f3b2c1` | Used for token revocation. Regenerated on reopen. |
| `tenantTokenHash` | string | `sha256:...` | SHA-256 of last issued tenant token, for audit only. |
| `lockedAt` | ISO datetime | `` | When transitioned to `locked_for_signature`. |
| `signedAt` | ISO datetime | `` | When all required signatures collected. |

**Indexing:** `inspectionId` is column A and used as primary lookup key. Use `Sheet.createTextFinder()` for fast lookup by ID.

---

## Sheet 2: `Answers`

One row per answered item. Composite key: `inspectionId + sectionId + itemId`.

| Column | Type | Example | Notes |
|---|---|---|---|
| `inspectionId` | string | `INS-2026-000123` | FK to Inspections. |
| `sectionId` | string | `kitchen` | From schema. |
| `itemId` | string | `kitchen_walls` | From schema. |
| `valueType` | string | `select` | Echoed from schema for safety. |
| `value` | string | `minor` | Stringified. For multi-select, JSON array string `["a","b"]`. For numbers, parseFloat on read. |
| `comment` | string | `Scratches near window` | Free-form per-item comment. |
| `attachmentCount` | number | `3` | Denormalized. Computed from Attachments sheet on every save. |
| `updatedAt` | ISO datetime | `2026-04-03T10:30:00Z` | |
| `updatedBy` | string | `admin@firma.rs` or `tenant_token` | Who last wrote. |

**Lookup pattern:** all answers for inspection X = filter by `inspectionId === 'INS-2026-...'`. For frontend rendering, this returns answers in arbitrary order; frontend re-orders by schema.

**Write pattern:** upsert by composite key. If row with same `(inspectionId, sectionId, itemId)` exists, update; else append.

---

## Sheet 3: `Attachments`

One row per uploaded photo.

| Column | Type | Example | Notes |
|---|---|---|---|
| `attachmentId` | string | `ATT-2026-04-03-a7f3b2` | Format `ATT-YYYY-MM-DD-<6char>`. |
| `inspectionId` | string | `INS-2026-000123` | |
| `sectionId` | string | `kitchen` | |
| `itemId` | string | `kitchen_walls` | |
| `driveFileId` | string | `1mN2oP...` | The actual photo on Drive. |
| `fileName` | string | `INS-2026-000123__kitchen__kitchen_walls__001.jpg` | |
| `mimeType` | string | `image/jpeg` | |
| `sizeBytes` | number | `240320` | |
| `width` | number | `1600` | Optional, if frontend reports it. |
| `height` | number | `1200` | Optional. |
| `caption` | string | `North wall` | Optional user caption. |
| `uploadedAt` | ISO datetime | `2026-04-03T10:32:00Z` | |
| `uploadedBy` | string | `admin@firma.rs` | |
| `deleted` | boolean | `FALSE` | Soft delete flag. Set to TRUE instead of removing row, for audit. |

**Cleanup:** When `deleted = TRUE`, the actual Drive file should also be moved to a `_deleted` subfolder (not permanently removed for 30 days, in case of accidental deletion).

---

## Sheet 4: `Signatures`

One row per collected signature.

| Column | Type | Example | Notes |
|---|---|---|---|
| `signatureId` | string | `SIG-2026-04-03-1a2b3c` | |
| `inspectionId` | string | `INS-2026-000123` | |
| `signerRole` | string | `tenant` | Enum: `landlord`, `tenant`, `witness`, `agent`. |
| `signerName` | string | `Jelena Jovanović` | Typed by signer. |
| `accepted` | boolean | `TRUE` | Consent checkbox. Required true. |
| `signatureFileId` | string | `1qR2sT...` | PNG on Drive. |
| `signedAt` | ISO datetime | `2026-04-03T11:02:00Z` | |
| `ipAddress` | string | `93.87.x.x` | If available from Apps Script (limited support). |
| `userAgent` | string | `Mozilla/5.0...` | From request header for audit. |
| `nonce` | string | `a7f3b2c1` | The nonce active at time of signing. Used to invalidate if reopened. |
| `valid` | boolean | `TRUE` | Set FALSE if inspection is reopened — signature snapshot persists for audit but no longer counts. |

---

## Sheet 5: `AuditLog`

Append-only event log. Never updated, never deleted.

| Column | Type | Example | Notes |
|---|---|---|---|
| `eventId` | string | `EVT-2026-04-03-x9y8z7` | |
| `inspectionId` | string | `INS-2026-000123` | |
| `actor` | string | `admin@firma.rs` or `tenant_token:abc123...` | Who did the action. For tokens, log first 8 chars of payload. |
| `eventType` | string | `inspection_created` | See enum below. |
| `timestamp` | ISO datetime | `2026-04-03T10:15:00Z` | |
| `detailsJson` | string | `{"sectionId":"kitchen","itemCount":5}` | Free-form JSON payload. |

**Event type enum:**
- `inspection_created`
- `section_saved`
- `attachment_uploaded`
- `attachment_deleted`
- `inspection_locked`
- `inspection_unlocked`
- `signature_saved`
- `signature_invalidated`
- `inspection_finalized`
- `pdf_generated`
- `pdf_regenerated`
- `inspection_reopened`
- `tenant_token_generated`
- `tenant_token_used`
- `auth_failed`

---

## Sheet 6: `Schemas`

Stores schema JSON as raw text in a single cell per schema. Lightweight, no separate Drive lookup needed.

| Column | Type | Example | Notes |
|---|---|---|---|
| `schemaId` | string | `schema_move_in_v1` | Primary key. |
| `inspectionType` | string | `move_in` | |
| `version` | number | `1` | |
| `active` | boolean | `TRUE` | Only active schemas can be selected for new inspections. |
| `title` | string | `Move-in Inspection` | |
| `schemaJson` | string | `{"schemaVersion":1,...}` | The full schema. Cell limit is 50000 chars, more than enough. |
| `createdAt` | ISO datetime | | |
| `updatedAt` | ISO datetime | | |

---

## Sheet 7: `Config`

Key-value store for runtime config. Editable by admin without code change.

| Column | Type | Example | Notes |
|---|---|---|---|
| `key` | string | `defaultTokenTtlHours` | |
| `value` | string | `168` | Stringified. |
| `description` | string | `Default tenant link expiry in hours (7 days).` | |
| `updatedAt` | ISO datetime | | |

**Initial config rows:**
- `defaultTokenTtlHours = 168`
- `maxAttachmentsPerItem = 5`
- `maxAttachmentsPerInspection = 80`
- `imageMaxDimPx = 1600`
- `imageJpegQuality = 0.75`
- `adminEmailAllowlist = admin@firma.rs,manager@firma.rs` (comma-separated)
- `templateDocId = <Google Doc template ID>`
- `inspectionsRootFolderId = <Drive folder ID>`

---

## Drive Folder Layout (binary assets only)

```
/Apartment-Handover                        (root, set inspectionsRootFolderId to this)
  /HandoverSystem.xlsx                     (the canonical Sheet — but actually a Sheet, not xlsx)
  /Templates
    /HandoverReport_v1                     (Google Doc template — set templateDocId to this)
  /Inspections
    /2026
      /INS-2026-000123
        /photos
          INS-2026-000123__kitchen__kitchen_walls__001.jpg
          INS-2026-000123__kitchen__kitchen_walls__002.jpg
          ...
        /signatures
          landlord-signature.png
          tenant-signature.png
        /output
          INS-2026-000123_final.pdf
          INS-2026-000123_snapshot.json    (full inspection state at finalize, archival)
        /_deleted                          (soft-deleted attachments, 30-day retention)
```

**Why JSON snapshot at finalize:** for archival, portability, and disaster recovery. If Sheet ever corrupts, the JSON has everything. But we don't read from JSON during normal operation — Sheet is canonical.

---

## ID Generation Rules

- **Inspection ID**: `INS-YYYY-NNNNNN` where NNNNNN is zero-padded sequential counter, scoped per year. Counter stored in `Config` sheet as `nextInspectionCounter_2026`. Atomic increment via `LockService.getScriptLock()`.
- **Attachment ID**: `ATT-YYYY-MM-DD-XXXXXX` where XXXXXX is 6-char random hex.
- **Signature ID**: `SIG-YYYY-MM-DD-XXXXXX`.
- **Event ID**: `EVT-YYYY-MM-DD-XXXXXX`.

UUIDs would be safer but are visually noisy in the Sheet. The above format is human-readable and collision-resistant enough for this scale.
