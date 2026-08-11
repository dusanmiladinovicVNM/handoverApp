/**
 * A backend that answers instantly and always the same way.
 *
 * The point is not to simulate Apps Script. It is to take the server out of
 * the measurement entirely, so that what is left is the number of requests a
 * screen makes and the work the browser does — both of which are properties of
 * this codebase, and neither of which survives being measured through a
 * platform whose latency varies by a factor of two between runs.
 *
 * Every call is recorded, so a scenario can assert "this screen asks once".
 */

const SCHEMA = {
  schemaVersion: 1,
  inspectionType: 'move_in',
  sections: [
    {
      id: 'kitchen',
      title: 'Kitchen',
      items: [
        { id: 'walls', type: 'condition', label: 'Walls', required: true },
        { id: 'floor', type: 'condition', label: 'Floor', required: true },
        { id: 'notes', type: 'text', label: 'Notes' },
      ],
    },
    {
      id: 'bathroom',
      title: 'Bathroom',
      items: [{ id: 'tiles', type: 'condition', label: 'Tiles', required: true }],
    },
  ],
};

function inspectionRow(n) {
  return {
    inspectionId: `INS-2026-00000${n}`,
    status: 'draft',
    inspectionType: 'move_in',
    propertyAddress: `Bahnhofstrasse ${n}, Zürich`,
    propertyUnit: `${n}A`,
    landlordName: 'M. Petrović',
    tenantName: `Tenant ${n}`,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-05T10:00:00.000Z',
    assignedTo: 'perf@firma.rs',
    assignedToName: 'Perf Tester',
  };
}

const USER = {
  userId: 'USR-2026-000001',
  email: 'perf@firma.rs',
  name: 'Perf Tester',
  role: 'admin',
  status: 'active',
  hasPassword: true,
};

/** @param calls  an array every request is appended to */
function respond(action, calls) {
  calls.push(action);

  switch (action) {
    case 'login':
    case 'refreshSession':
      return { sessionToken: 'stub.session', user: USER, expiresInHours: 12 };

    case 'me':
      return { user: USER };

    case 'listInspections': {
      const rows = [];
      for (let i = 1; i <= 8; i++) rows.push(inspectionRow(i));
      return { inspections: rows, totalCount: rows.length, page: 0, pageSize: 100 };
    }

    // The one endpoint that replaced getSchemas + listUsers. Both of the old
    // ones still answer, so a scenario can measure the shape this replaced.
    case 'getNewInspectionOptions':
      return {
        schemas: [{ schemaId: 'schema_move_in_v1', inspectionType: 'move_in', title: 'Move-in', version: 1 }],
        assignableUsers: [{ name: 'Perf Tester', email: 'perf@firma.rs' }],
      };
    case 'getSchemas':
      return { schemas: [{ schemaId: 'schema_move_in_v1', inspectionType: 'move_in', title: 'Move-in', version: 1 }] };
    case 'listUsers':
      return { users: [USER], activeAdmins: 1 };

    case 'getInspection':
      return {
        inspection: inspectionRow(1),
        schema: SCHEMA,
        answers: { kitchen: { walls: { value: 'good', comment: '', attachmentCount: 0 } } },
        attachments: [],
        signatures: [],
      };

    case 'saveSection':
      return { savedItems: ['walls'], updatedAt: new Date().toISOString() };

    case 'createInspection':
      return {
        inspectionId: 'INS-2026-000099', status: 'draft',
        driveFolderId: 'fld', tenantToken: 't', tenantUrl: 'https://example.test/#/x',
      };

    default:
      return {};
  }
}

/**
 * Attach to a page. Returns the list of actions requested, in order.
 *
 * @param latencyMs  delay before answering, to model a slow link. At 0 the
 *                   measurement is the browser's own work; raise it and a
 *                   screen that serialises its requests shows the sum.
 * @param calls      appended to, so the caller keeps one array either way
 */
async function install(page, latencyMs, calls) {
  await page.route('**/macros/s/**', async (route) => {
    let action = '(unparsed)';
    try {
      action = JSON.parse(route.request().postData() || '{}').action || '(none)';
    } catch (_) {}

    const body = JSON.stringify({ ok: true, data: respond(action, calls) });
    if (latencyMs > 0) await new Promise(r => setTimeout(r, latencyMs));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body,
    });
  });
}

module.exports = { install };
