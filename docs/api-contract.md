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

Every request must include `auth`, except for the sign-in actions listed under
**Public actions** below.

```json
"auth": { "type": "token", "token": "<base64url>.<base64url>" }
```

One shape, three kinds of token behind it.

| Token | Payload | Lifetime |
|---|---|---|
| Session | `{ typ: 's', uid, did, exp, nonce }` | 12 h |
| Device | `{ typ: 'd', uid, did, exp, nonce }` | 60 days |
| Tenant | `{ iid, role: 'tenant', exp, nonce }` | set per link |

For a session the server checks the HMAC and expiry, then the device row
(present, not revoked, nonce matching, not expired) and the user row (present,
`status: active`).

**The user's role is read from the `Users` sheet on every request, never from
the token.** A token names who you are; the sheet says what you may do. That is
what makes revoking admin rights or disabling an account take effect on a
session that is already open.

A device token is never accepted as a session — it is only exchanged for one
through `refreshSession`.

For a tenant token the server checks the HMAC, expiry, and `nonce` against the
inspection's current nonce.

Google login is not available: an Apps Script Web App deployed with "Anyone"
access provides no caller identity. The pre-accounts admin token has been
removed, and tokens of that shape are refused.

### Public actions

`login`, `requestPasswordReset`, `setPassword` and `refreshSession` run before
a session exists and are dispatched with no auth block at all. They are the
only exception to "every request is authenticated"; each is rate limited and
answers identically whether or not the account exists.

### Permission levels

| Level | Who |
|---|---|
| `requireStaff` | any signed-in account — admin or inspector |
| `requireAdmin` | `role: admin` only |
| `requireMatchingInspection` | a tenant token, bound to its own inspection |
| `requireInspectionAccess` | admin: any inspection · inspector: the ones assigned to them · tenant: the one its link was issued for |

`requireStaff` says the caller may work; `requireInspectionAccess` says on
*what*. Every action that names an `inspectionId` calls the second one, and an
action gated only on `requireStaff` is one that names no inspection.

An inspector asking for an inspection that is not theirs is answered
`NOT_FOUND`, identically to one that does not exist. Inspection ids run in
sequence, so a distinguishable refusal would let any account walk the range and
count the work in progress.

An inspection with an empty `assignedTo` belongs to no inspector and is visible
only to admins until someone assigns it.

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

## Endpoints — accounts and sessions

A `user` object anywhere below is the public projection: `userId`, `email`,
`name`, `role`, `status`, `hasPassword`, `lastLoginAt`, `lockedUntil`,
`createdAt`, `createdBy`, `disabledAt`, `disabledBy`, `notes`. It never carries
the password hash.

### `login`
**Auth:** public. **Data:** `email`, `password`, and optionally `remember`
(boolean), `deviceLabel`, `userAgent`.

```json
{ "ok": true, "data": {
  "sessionToken": "<token>", "user": { ... }, "expiresInHours": 12,
  "deviceToken": "<token>", "deviceExpiresInDays": 60
} }
```

`deviceToken` and `deviceExpiresInDays` appear only when `remember` is true.
Without it the device is registered for the session's lifetime and forgotten
after.

Failure is always the same message whether the address is unknown, the account
is disabled, or the password is wrong — and an unknown address costs the same
time as a known one, so the two cannot be told apart by the clock. After
`loginMaxFailures` attempts the account locks for `loginLockMinutes`.

### `refreshSession`
**Auth:** public — the device token is in `data`, not in the auth block, because
a device token is never accepted as a session.

**Data:** `deviceToken`. **Returns:** `sessionToken`, `user`, `expiresInHours`.

### `setPassword`
**Auth:** public — the set-password token *is* the credential.

**Data:** `token`, `password`, optionally `deviceLabel`, `userAgent`. Returns a
session, as `login` does: the link that sets a password also signs you in.

The token is single-use, and nothing has to be stored to make it so — it is
derived from the password hash it is about to replace, so setting the password
invalidates it.

### `requestPasswordReset`
**Auth:** public. **Data:** `email`.

```json
{ "ok": true, "data": { "sent": true, "message": "If that address belongs to an account, a link is on its way." } }
```

Always that answer, whether or not the address belongs to an account.

### `changePassword`
**Auth:** the account holder. **Data:** `oldPassword`, `newPassword`.

**Returns:** `{ "signedOut": true, "devicesRevoked": <n> }` — changing a
password signs out every other device, which is the point of changing it.

### `me`
**Auth:** staff. **Returns:** `{ "user": { ... } }`, read from the sheet, not
from the token.

### `signOut`
**Auth:** staff. Revokes the calling device. **Returns:** `{ "signedOut": true }`.

---

## Endpoints — account administration

All admin only. Each returns the updated `user` where one is affected.

| Action | Data | Returns |
|---|---|---|
| `listUsers` | — | `users[]`, `activeAdmins` |
| `createUser` | `name`, `email`, `role` | `user`, `delivery` |
| `setUserStatus` | `userId`, `status` | `user`, `devicesRevoked` |
| `setUserRole` | `userId`, `role` | `user` |
| `unlockUser` | `userId` | `user` |
| `sendPasswordLink` | `userId` | `delivery` |
| `listUserDevices` | `userId` | `devices[]` |
| `revokeDevice` | `deviceId` | `{ revoked: true }` |
| `revokeAllDevices` | `userId` | `{ revoked: <n> }` |
| `getAuthLog` | `userId`, optional `limit` (default 200) | `events[]` |
| `assignInspection` | `inspectionId`, `assignedTo` | `inspectionId`, `assignedTo` |

`delivery` reports whether the set-password mail actually went out, and
distinguishes a missing scope from a spent quota — a new account whose invitation
never arrived is otherwise indistinguishable from one that was never created.

Disabling an account (`setUserStatus`) revokes its devices, so the sessions it
already had stop working rather than running out on their own.

Two guards refuse rather than let the screen paint itself into a corner. Nobody
can disable their own account or remove their own admin rights, and the last
active administrator cannot be disabled or demoted by anyone — the workbook
would be left with no way back in.

`assignInspection` moves an inspection between inspectors, which takes it away
from whoever had it — see the visibility rules above.

---

## Endpoints — inspections

### `getSchemas`
List all active schemas. Used on inspection creation form.

**Auth:** staff.

**Request:**
```json
{ "action": "getSchemas", "auth": { "type": "token", "token": "<session>" }, "data": {} }
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

**Auth:** staff. It used to accept any valid token, which let a tenant link pull
any schema by id. A tenant already receives the schema for their own inspection
inside `getInspection` and has no use for the others.

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

**Auth:** staff. An inspector may create one, but `assignedTo` is forced to
their own address — only an admin may open a job on someone else's behalf.

**Request:**
```json
{
  "action": "createInspection",
  "auth": { "type": "token", "token": "<session>" },
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

**Auth:** `requireInspectionAccess` — admin, the assigned inspector, or the
tenant token issued for this inspection.

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
      "signedAt": null,
      "assignedTo": "mina@firma.rs",
      "assignedToName": "Mina Ilić"
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

A non-admin caller — inspector or tenant — does not receive
`tenantTokenHash`, `currentNonce` or `createdBy`.

---

### `saveSection`
Upsert answers for one section. Idempotent.

**Auth:** `requireInspectionAccess`, and the status must still allow writes.

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

**Auth:** `requireInspectionAccess`, and the status must still allow writes.

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

**Auth:** staff, plus `requireInspectionAccess`. A tenant cannot delete.

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

**Auth:** staff, plus `requireInspectionAccess`.

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

**Auth:** admin only. Reopening a signed inspection is supervisory.

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

**Auth:** `requireInspectionAccess`, plus `requireMatchingRole` — a tenant token
may only sign as `tenant`.

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

**Auth:** staff, plus `requireInspectionAccess`.

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

**Auth:** staff, plus `requireInspectionAccess`.

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
    "snapshotFileId": "1aB2cD..."
  }
}
```

`pdfFileId` identifies the file; it is not a link. The reply used to carry a
`pdfUrl` pointing at `drive.google.com`, which only resolves for a caller whose
Google account can read the output folder — never the tenant, and only by
opening the folder to everyone. Fetch the report with `downloadPdf` instead.

**Errors:**
- `VALIDATION_FAILED` if not all signatures collected
- `PDF_GENERATION_FAILED` if Doc operation failed (rare)

**Performance note:** synchronous. Expected duration 20–60 sec for typical inspection. Frontend should show progress UI and have a generous fetch timeout (90 sec).

---

### `downloadPdf`
The finished report's bytes, base64-encoded.

**Auth:** any caller, subject to `requireInspectionAccess` — an admin, the
inspector the inspection is assigned to, or the tenant token issued for that
inspection. This is the point of the action: Drive can only authorize by Google
account, which says nothing about `assignedTo` and nothing about tenant tokens,
so serving the file here is what lets `/Inspections` stay private.

**Request:**
```json
{ "action": "downloadPdf", "auth": { ... }, "data": { "inspectionId": "INS-2026-000123" } }
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "inspectionId": "INS-2026-000123",
    "fileName": "INS-2026-000123_final.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 2483102,
    "base64Data": "JVBERi0xLjcK..."
  }
}
```

**Errors:**
- `NOT_FOUND` if the inspection is not visible to this caller, has not been finalized, or its PDF is no longer in Drive
- `PDF_TOO_LARGE` if the file exceeds `maxPdfDownloadMb` (default 20). The whole response is assembled in memory, base64 included.

Each successful call appends a `pdf_downloaded` event to the audit log.

---

### `listInspections`
The main list. Supports filter and pagination.

`assignedTo` is the stored address and is the identity; `assignedToName` rides
alongside it for display, resolved server-side because an inspector cannot look
up who an address belongs to. It is empty when no account matches the address
any more.

**Auth:** staff. An inspector's list, and its `totalCount`, contain only the
inspections assigned to them.

**Request:**
```json
{
  "action": "listInspections",
  "auth": { "type": "token", "token": "<session>" },
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
      {
        "inspectionId": "INS-...", "status": "draft", "inspectionType": "move_in",
        "propertyAddress": "...", "propertyUnit": "4B",
        "landlordName": "...", "tenantName": "...",
        "createdAt": "...", "updatedAt": "...",
        "assignedTo": "mina@firma.rs", "assignedToName": "Mina Ilić"
      }
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

**Auth:** admin only.

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

"Own" below means the same thing in every row: for an inspector, assigned to
them; for a tenant token, the inspection the link was issued for.

| Action | Admin | Inspector | Tenant Token |
|---|---|---|---|
| `login`, `requestPasswordReset`, `setPassword`, `refreshSession` | — public — | — public — | — public — |
| `me`, `signOut`, `changePassword` | ✓ | ✓ | ✗ |
| `listUsers`, `createUser`, `setUserStatus`, `setUserRole` | ✓ | ✗ | ✗ |
| `unlockUser`, `sendPasswordLink` | ✓ | ✗ | ✗ |
| `listUserDevices`, `revokeDevice`, `revokeAllDevices` | ✓ | ✗ | ✗ |
| `getAuthLog`, `assignInspection` | ✓ | ✗ | ✗ |
| `getSchemas` | ✓ | ✓ | ✗ |
| `getSchema` | ✓ | ✓ | ✗ |
| `createInspection` | ✓ | ✓ (always assigned to themselves) | ✗ |
| `listInspections` | ✓ (all) | ✓ (own only) | ✗ |
| `getInspection` | ✓ | ✓ (own) | ✓ (own) |
| `saveSection` | ✓ | ✓ (own) | ✓ (if status allows, own) |
| `uploadAttachment` | ✓ | ✓ (own) | ✓ (if status allows, own) |
| `deleteAttachment` | ✓ | ✓ (own) | ✗ |
| `lockInspection` | ✓ | ✓ (own) | ✗ |
| `unlockInspection` | ✓ | ✗ | ✗ |
| `saveSignature` | ✓ | ✓ (own) | ✓ (only as `tenant`) |
| `regenerateTenantToken` | ✓ | ✓ (own) | ✗ |
| `finalizeInspection` | ✓ | ✓ (own) | ✗ |
| `downloadPdf` | ✓ | ✓ (own) | ✓ (own) |
| `getAuditLog` | ✓ | ✗ | ✗ |

What stays admin-only is supervisory rather than operational: reopening a signed
inspection, reading the audit log, managing accounts, and deciding who an
inspection belongs to. Everything an inspector needs to carry out and finish
the fieldwork they were given, they can do.

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
