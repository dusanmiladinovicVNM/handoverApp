# API Contract

Single Apps Script Web App endpoint. All requests are `POST` with `Content-Type: text/plain;charset=utf-8` (to bypass CORS preflight). Body is JSON-stringified.

**Endpoint:** `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`

**Routing:** every request body has an `action` field. The router dispatches to the right service.

```json
{
  "action": "createInspection",
  "auth": { ... },
  "data": { ... }
}
```

---

## Auth Block

Every request must include `auth`. Two flavors:

### Internal (admin/landlord/agent — Google login)
```json
"auth": { "type": "google" }
```
Server reads `Session.getActiveUser().getEmail()` and checks against `adminEmailAllowlist` in Config.

### Tenant (token link)
```json
"auth": { "type": "token", "token": "<base64url>.<base64url>" }
```
Server validates HMAC, expiry, and `nonce` against current inspection nonce.

### Failure response
```json
{ "ok": false, "error": { "code": "UNAUTHORIZED", "message": "Invalid or expired token." } }
```

---

## Standard Response Shape

**Success:**
```json
{ "ok": true, "data": { ... } }
```

**Error:**
```json
{ "ok": false, "error": { "code": "ERROR_CODE", "message": "Human-readable.", "details": {} } }
```

**Error codes:**
- `UNAUTHORIZED` — auth missing or invalid
- `FORBIDDEN` — authenticated but not allowed for this action
- `NOT_FOUND` — inspectionId does not exist
- `INVALID_REQUEST` — malformed body, missing required fields
- `INVALID_SCHEMA` — schemaId does not exist or is inactive
- `VALIDATION_FAILED` — domain validation (e.g., signature without name)
- `INSPECTION_LOCKED` — write attempted on locked inspection
- `INSPECTION_FINALIZED` — write attempted on finalized inspection
- `UPLOAD_FAILED` — Drive upload error
- `PDF_GENERATION_FAILED` — Doc/PDF export error
- `QUOTA_LIMIT` — Apps Script or Drive quota hit
- `CONFLICT` — concurrent modification detected
- `INTERNAL_ERROR` — uncaught exception

---

## Endpoints

### `getSchemas`
List all active schemas. Used on inspection creation form.

**Auth:** internal only.

**Request:**
```json
{ "action": "getSchemas", "auth": { "type": "google" }, "data": {} }
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "schemas": [
      { "schemaId": "schema_move_in_v1", "inspectionType": "move_in", "title": "Move-in Inspection", "version": 1 },
      { "schemaId": "schema_move_out_v1", "inspectionType": "move_out", "title": "Move-out Inspection", "version": 1 }
    ]
  }
}
```

---

### `getSchema`
Fetch full schema JSON.

**Auth:** any authenticated.

**Request:**
```json
{ "action": "getSchema", "auth": { ... }, "data": { "schemaId": "schema_move_in_v1" } }
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "schemaId": "schema_move_in_v1",
    "schema": { "schemaVersion": 1, "inspectionType": "move_in", "sections": [...] }
  }
}
```

---

### `createInspection`
Create new inspection. Returns inspectionId and tenant token.

**Auth:** internal only.

**Request:**
```json
{
  "action": "createInspection",
  "auth": { "type": "google" },
  "data": {
    "inspectionType": "move_in",
    "schemaId": "schema_move_in_v1",
    "property": {
      "addressLine1": "Knez Mihailova 12",
      "city": "Belgrade",
      "postalCode": "11000",
      "unitNumber": "4B"
    },
    "parties": {
      "landlord": { "name": "Marko Petrović", "email": "marko@firma.rs", "phone": "+381..." },
      "tenant": { "name": "Jelena Jovanović", "email": "jelena@example.com", "phone": "+381..." }
    },
    "notes": "Optional admin note."
  }
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "inspectionId": "INS-2026-000123",
    "status": "draft",
    "driveFolderId": "1aB2cD3eF...",
    "tenantToken": "<full token>",
    "tenantUrl": "https://username.github.io/handover-app/#/inspection/INS-2026-000123?t=<token>"
  }
}
```

**Side effects:** creates Drive folder structure, writes `Inspections` row, logs `inspection_created` event.

---

### `getInspection`
Fetch full inspection state: metadata + answers + attachments + signatures + schema.

**Auth:** any authenticated. Tenant token must match this `inspectionId`.

**Request:**
```json
{ "action": "getInspection", "auth": { ... }, "data": { "inspectionId": "INS-2026-000123" } }
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "inspection": {
      "inspectionId": "INS-2026-000123",
      "status": "draft",
      "inspectionType": "move_in",
      "schemaId": "schema_move_in_v1",
      "property": { ... },
      "parties": { ... },
      "createdAt": "...",
      "updatedAt": "...",
      "lockedAt": null,
      "signedAt": null
    },
    "schema": { "schemaVersion": 1, "sections": [...] },
    "answers": {
      "kitchen": {
        "kitchen_walls": { "value": "minor", "comment": "...", "attachmentCount": 2, "updatedAt": "..." }
      }
    },
    "attachments": [
      { "attachmentId": "ATT-...", "sectionId": "kitchen", "itemId": "kitchen_walls", "fileId": "...", "fileName": "...", "thumbnailUrl": "..." }
    ],
    "signatures": [
      { "signatureId": "SIG-...", "signerRole": "landlord", "signerName": "...", "signedAt": "...", "signatureFileId": "...", "valid": true }
    ]
  }
}
```

---

### `saveSection`
Upsert answers for one section. Idempotent.

**Auth:** internal or tenant token (if write allowed by status).

**Request:**
```json
{
  "action": "saveSection",
  "auth": { ... },
  "data": {
    "inspectionId": "INS-2026-000123",
    "sectionId": "kitchen",
    "items": {
      "kitchen_walls": { "value": "minor", "comment": "Scratch visible" },
      "kitchen_sink":  { "value": true, "comment": "" }
    }
  }
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "savedItems": ["kitchen_walls", "kitchen_sink"],
    "updatedAt": "2026-04-03T10:30:00Z"
  }
}
```

**Errors:** `INSPECTION_LOCKED` if status is `locked_for_signature` or beyond.

---

### `uploadAttachment`
Upload one photo. Image is base64-encoded in body.

**Auth:** internal or tenant (if allowed).

**Request:**
```json
{
  "action": "uploadAttachment",
  "auth": { ... },
  "data": {
    "inspectionId": "INS-2026-000123",
    "sectionId": "kitchen",
    "itemId": "kitchen_walls",
    "fileName": "wall.jpg",
    "mimeType": "image/jpeg",
    "base64Data": "<base64 string, no data: prefix>",
    "caption": "Optional",
    "width": 1600,
    "height": 1200
  }
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "attachmentId": "ATT-2026-04-03-a7f3b2",
    "fileId": "1mN2oP...",
    "fileName": "INS-2026-000123__kitchen__kitchen_walls__003.jpg",
    "thumbnailUrl": "https://drive.google.com/thumbnail?id=1mN2oP..."
  }
}
```

**Validation:** rejects if `attachmentCount` for item exceeds `maxAttachmentsPerItem` (default 5), or total exceeds `maxAttachmentsPerInspection` (default 80).

**Frontend duty:** compress before upload. Server does NOT re-compress. Server enforces max payload size (~10MB safe limit) and rejects oversized.

---

### `deleteAttachment`
Soft delete (sets `deleted = TRUE`, moves file to `_deleted` folder).

**Auth:** internal only (tenant cannot delete).

**Request:**
```json
{ "action": "deleteAttachment", "auth": { ... }, "data": { "inspectionId": "...", "attachmentId": "ATT-..." } }
```

**Response:**
```json
{ "ok": true, "data": { "attachmentId": "ATT-...", "deleted": true } }
```

---

### `lockInspection`
Transition `draft`/`under_review` → `locked_for_signature`. Validates all required fields are answered.

**Auth:** internal only.

**Request:**
```json
{ "action": "lockInspection", "auth": { ... }, "data": { "inspectionId": "INS-2026-000123" } }
```

**Response (success):**
```json
{ "ok": true, "data": { "status": "locked_for_signature", "lockedAt": "..." } }
```

**Response (validation fail):**
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Some required items are missing answers.",
    "details": {
      "missingItems": [
        { "sectionId": "keys", "itemId": "keys_count", "label": "Number of keys handed over" },
        { "sectionId": "meters", "itemId": "electricity_reading", "label": "Electricity meter reading" }
      ]
    }
  }
}
```

---

### `unlockInspection`
Transition `locked_for_signature`/`partially_signed` → `draft`. Invalidates all existing signatures.

**Auth:** internal only.

**Request:**
```json
{ "action": "unlockInspection", "auth": { ... }, "data": { "inspectionId": "INS-2026-000123", "reason": "Tenant requested correction" } }
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "status": "draft",
    "invalidatedSignatures": ["SIG-...", "SIG-..."],
    "newNonce": "x9y8z7"
  }
}
```

**Side effects:** signatures get `valid = FALSE`, current nonce is regenerated, all existing tokens are effectively revoked. Admin must re-issue tenant link.

---

### `saveSignature`
Save one signature. Multiple calls expected (one per signer).

**Auth:** internal or tenant token (only matching role).

**Request:**
```json
{
  "action": "saveSignature",
  "auth": { ... },
  "data": {
    "inspectionId": "INS-2026-000123",
    "signerRole": "tenant",
    "signerName": "Jelena Jovanović",
    "accepted": true,
    "base64Png": "<base64 of signature PNG>"
  }
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "signatureId": "SIG-2026-04-03-1a2b3c",
    "signatureFileId": "1qR2sT...",
    "signedAt": "...",
    "allRequiredSignaturesCollected": false,
    "newStatus": "partially_signed"
  }
}
```

**Note:** if `allRequiredSignaturesCollected = true`, status becomes `signed` BUT pdf is NOT auto-generated. Caller must call `finalizeInspection` separately.

---

### `regenerateTenantToken`
Issue a fresh tenant link (e.g., previous one expired or got compromised). Increments nonce — invalidates old token.

**Auth:** internal only.

**Request:**
```json
{ "action": "regenerateTenantToken", "auth": { ... }, "data": { "inspectionId": "INS-2026-000123", "ttlHours": 168 } }
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "tenantToken": "<new token>",
    "tenantUrl": "https://...",
    "expiresAt": "2026-04-10T10:15:00Z"
  }
}
```

---

### `finalizeInspection`
Generate final PDF. Idempotent — calling twice generates fresh PDF replacing old.

**Auth:** internal only.

**Request:**
```json
{ "action": "finalizeInspection", "auth": { ... }, "data": { "inspectionId": "INS-2026-000123" } }
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "status": "signed",
    "pdfFileId": "1xY2zW...",
    "pdfUrl": "https://drive.google.com/file/d/1xY2zW.../view",
    "snapshotFileId": "1aB2cD..."
  }
}
```

**Errors:**
- `VALIDATION_FAILED` if not all signatures collected
- `PDF_GENERATION_FAILED` if Doc operation failed (rare)

**Performance note:** synchronous. Expected duration 20–60 sec for typical inspection. Frontend should show progress UI and have a generous fetch timeout (90 sec).

---

### `listInspections`
Admin dashboard list. Supports filter and pagination.

**Auth:** internal only.

**Request:**
```json
{
  "action": "listInspections",
  "auth": { "type": "google" },
  "data": {
    "filter": {
      "status": ["draft", "under_review"],
      "inspectionType": null,
      "search": "Petrović",
      "fromDate": "2026-01-01",
      "toDate": null
    },
    "page": 0,
    "pageSize": 50,
    "sortBy": "updatedAt",
    "sortOrder": "desc"
  }
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "inspections": [
      { "inspectionId": "INS-...", "status": "draft", "inspectionType": "move_in", "propertyAddress": "...", "tenantName": "...", "updatedAt": "..." }
    ],
    "totalCount": 142,
    "page": 0,
    "pageSize": 50
  }
}
```

---

### `getAuditLog`
Per-inspection event history.

**Auth:** internal only.

**Request:**
```json
{ "action": "getAuditLog", "auth": { ... }, "data": { "inspectionId": "INS-2026-000123" } }
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "events": [
      { "eventId": "EVT-...", "eventType": "inspection_created", "actor": "admin@firma.rs", "timestamp": "...", "details": {} },
      { "eventId": "EVT-...", "eventType": "section_saved", "actor": "tenant_token:abc12345", "timestamp": "...", "details": { "sectionId": "kitchen" } }
    ]
  }
}
```

---

## Permissions Matrix

| Action | Admin | Internal Staff | Tenant Token |
|---|---|---|---|
| `getSchemas` | ✓ | ✓ | ✗ |
| `getSchema` | ✓ | ✓ | ✓ (only schema of own inspection) |
| `createInspection` | ✓ | ✓ | ✗ |
| `getInspection` | ✓ | ✓ | ✓ (only own) |
| `saveSection` | ✓ | ✓ | ✓ (if status allows, only own) |
| `uploadAttachment` | ✓ | ✓ | ✓ (if status allows, only own) |
| `deleteAttachment` | ✓ | ✓ | ✗ |
| `lockInspection` | ✓ | ✓ | ✗ |
| `unlockInspection` | ✓ | ✓ | ✗ |
| `saveSignature` (own role) | ✓ | ✓ | ✓ (only as `tenant`) |
| `regenerateTenantToken` | ✓ | ✓ | ✗ |
| `finalizeInspection` | ✓ | ✓ | ✗ |
| `listInspections` | ✓ | ✓ | ✗ |
| `getAuditLog` | ✓ | ✓ | ✗ |

For MVP: **all internal staff have admin rights**. Granular roles can be added later by reading per-email roles from Config.

---

## Conditional Logic DSL

Schema fields can include `visibleWhen` and `requiredWhen`. Both use the same condition format:

```json
{
  "field": "kitchen_walls",
  "operator": "in",
  "value": ["minor", "major"]
}
```

**Operators:**
- `equals` — `value` is a primitive
- `notEquals` — `value` is a primitive
- `in` — `value` is array; field value must be in array
- `notIn` — `value` is array
- `truthy` — no `value` needed; field must be truthy (non-empty string, true, non-zero number)
- `falsy` — no `value` needed

**Combining:** wrap multiple conditions in `all` or `any`:

```json
{
  "all": [
    { "field": "has_damage", "operator": "truthy" },
    { "field": "damage_severity", "operator": "in", "value": ["major", "critical"] }
  ]
}
```

**Field reference:** `field` is the `itemId`, scoped to the same inspection. Cross-section references work (e.g., `general_property_age` from `general` section can drive visibility in `kitchen`).
