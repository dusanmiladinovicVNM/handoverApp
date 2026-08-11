/**
 * mutation-state.test.js
 * A mutation carries the new state back, and never fails because of it.
 *
 * Locking, unlocking, signing, finalising, assigning and creating all change
 * what the inspection screen shows, so the client used to follow every one of
 * them with getInspection. On this platform that is not a cheap call: /exec
 * answers 302 and the body comes from another host, so a single call is two
 * HTTP round trips plus an execution with its own auth and its own workbook
 * open — measured at two to four seconds, spent fetching state the server had
 * just finished writing.
 *
 * The router attaches it now, and two things have to hold.
 *
 * It has to be attached to those actions and to nothing else. A read attaching
 * its own state to itself would nest the payload inside a copy of itself, and
 * an action with no inspection to speak of has nothing to attach.
 *
 * And it must never turn a successful write into an error. The mutation has
 * already happened by the time the projection is built, so if that projection
 * throws — a schema that will not load, a Sheets hiccup, a quota — the caller
 * has to still be told the write succeeded. Reporting an error for a write that
 * landed is the worst outcome available here: the client cannot tell which
 * happened, and a retry writes twice.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { section, check, assert } = require('./appsscript-stubs');

const GAS_DIR = path.join(__dirname, '..', 'gas');

/**
 * The real Router over stub services, so the question asked is "what came back
 * from dispatch", not "does the source mention getInspection".
 *
 * getInspection is counted and can be told to throw, because those are the two
 * behaviours under test.
 */
function loadRouter(options) {
  const opts = options || {};
  const calls = { getInspection: 0, handlers: [] };

  const stubHandler = (name, result) => (authCtx, data) => {
    calls.handlers.push(name);
    return result;
  };

  const inspectionService = {
    getInspection(authCtx, data) {
      calls.getInspection++;
      if (opts.projectionThrows) throw new Error('schema would not load');
      return { inspection: { inspectionId: data.inspectionId }, schema: {},
               answers: {}, revisions: {}, attachments: [], signatures: [] };
    },
    createInspection: stubHandler('createInspection',
      { inspectionId: 'INS-NEW', tenantUrl: 'https://example.test/t/abc' }),
    saveSection: stubHandler('saveSection', { revision: 3, savedItems: ['a'] }),
    lockInspection: stubHandler('lockInspection',
      { status: 'locked_for_signature', lockedAt: 'now' }),
    unlockInspection: stubHandler('unlockInspection', { status: 'draft' }),
    regenerateTenantToken: stubHandler('regenerateTenantToken', { tenantUrl: 'x' }),
    listInspections: stubHandler('listInspections', { inspections: [], totalCount: 0 }),
  };

  const ctx = vm.createContext({
    console: { log: () => {}, warn: () => {}, error: () => {} },
    InspectionService: inspectionService,
    AccountService: {},
    UserAdminService: {
      assignInspection: stubHandler('assignInspection', { assignedTo: 'a@b.test' }),
    },
    SignatureService: {
      saveSignature: stubHandler('saveSignature', { signatureId: 'SIG-1', status: 'signed' }),
    },
    PdfService: {
      finalizeInspection: stubHandler('finalizeInspection', { finalPdfFileId: 'FILE-1' }),
    },
    AttachmentService: {
      uploadAttachment: stubHandler('uploadAttachment', { attachmentId: 'ATT-1' }),
      deleteAttachment: stubHandler('deleteAttachment', { deleted: true }),
    },
    AuditService: {
      getEventsForInspection: stubHandler('getAuditLog', { events: [] }),
    },
    SchemaService: { listActiveSchemas: () => [], getSchemaJson: () => ({}) },
    UserService: { listAssignable: () => [] },
    AuthService: { requireStaff() {}, requireAdmin() {}, requireInspectionAccess() {} },
    Date, Math, JSON, Array, Object, String, Number, Boolean,
    parseInt, parseFloat, isNaN, RegExp, Error,
  });

  const code = ['Utils.gs', 'Router.gs']
    .map(f => fs.readFileSync(path.join(GAS_DIR, f), 'utf8')).join('\n')
    + '\nglobalThis.__exports = { Router, HandoverError };';
  vm.runInContext(code, ctx);
  return { Router: ctx.__exports.Router, calls };
}

const ADMIN = { isAdmin: true, userId: 'U1', actorString: 'user:a@b.test' };

/** The actions the client used to follow with a second call. */
const CARRY_STATE = [
  ['createInspection', {}],
  ['lockInspection', { inspectionId: 'INS-1' }],
  ['unlockInspection', { inspectionId: 'INS-1' }],
  ['assignInspection', { inspectionId: 'INS-1', assignedTo: 'a@b.test' }],
  ['saveSignature', { inspectionId: 'INS-1' }],
  ['finalizeInspection', { inspectionId: 'INS-1' }],
];

module.exports = function run() {

  section('The mutations the client used to chase with getInspection:');

  CARRY_STATE.forEach(([action, data]) => {
    check(`${action} carries the new state`, () => {
      const { Router } = loadRouter();
      const result = Router.dispatch(action, ADMIN, data);
      assert(result.state && result.state.inspection,
        `${action} came back without state, so the client has to fetch`);
      assert(result.state.schema !== undefined && result.state.answers !== undefined
        && result.state.revisions !== undefined,
        `${action}'s state is not the shape getInspection returns`);
    });
  });

  check('createInspection is looked up by the id it just minted', () => {
    // It is the one action nobody could have named an inspection in the
    // request, because the inspection did not exist yet.
    const { Router } = loadRouter();
    const result = Router.dispatch('createInspection', ADMIN, {});
    assert(result.state.inspection.inspectionId === 'INS-NEW',
      `state was built for ${result.state.inspection.inspectionId}`);
    assert(result.inspectionId === 'INS-NEW', 'the original reply was disturbed');
  });

  check('the mutation keeps everything it already returned', () => {
    const { Router } = loadRouter();
    const result = Router.dispatch('lockInspection', ADMIN, { inspectionId: 'INS-1' });
    assert(result.status === 'locked_for_signature' && result.lockedAt === 'now',
      'attaching state overwrote the reply');
  });

  section('Nothing else is given state:');

  [
    ['getInspection', { inspectionId: 'INS-1' }],
    ['saveSection', { inspectionId: 'INS-1', sectionId: 'k', items: {} }],
    ['listInspections', {}],
    ['uploadAttachment', { inspectionId: 'INS-1' }],
    ['deleteAttachment', { inspectionId: 'INS-1' }],
    ['getAuditLog', { inspectionId: 'INS-1' }],
    ['regenerateTenantToken', { inspectionId: 'INS-1' }],
  ].forEach(([action, data]) => {
    check(`${action} does not`, () => {
      const { Router, calls } = loadRouter();
      const result = Router.dispatch(action, ADMIN, data);
      assert(!result.state, `${action} attached state it was not asked for`);
      // getInspection is itself the projection; every other one here should
      // not have paid for a projection at all.
      const expected = action === 'getInspection' ? 1 : 0;
      assert(calls.getInspection === expected,
        `${action} built ${calls.getInspection} projection(s), expected ${expected}`);
    });
  });

  check('getInspection is not nested inside a copy of itself', () => {
    const { Router } = loadRouter();
    const result = Router.dispatch('getInspection', ADMIN, { inspectionId: 'INS-1' });
    assert(result.inspection && !result.state, 'the read wrapped its own payload');
  });

  section('The state costs exactly one projection, not one per screen:');

  check('a mutation builds it once', () => {
    const { Router, calls } = loadRouter();
    Router.dispatch('lockInspection', ADMIN, { inspectionId: 'INS-1' });
    assert(calls.getInspection === 1,
      `${calls.getInspection} projections for one mutation`);
  });

  section('A projection that fails does not fail the write:');

  CARRY_STATE.forEach(([action, data]) => {
    check(`${action} still reports success`, () => {
      // The write has already landed by the time the projection is built. An
      // error here would report a completed write as a failure, and a client
      // that retries would write twice.
      const { Router } = loadRouter({ projectionThrows: true });
      let threw = null;
      let result = null;
      try {
        result = Router.dispatch(action, ADMIN, data);
      } catch (e) { threw = e; }

      assert(!threw, `${action} threw ${threw && threw.message} after writing`);
      assert(result && !result.state,
        'state was attached despite the projection failing');
    });
  });

  check('and the reply is still whole, so the client can fall back', () => {
    const { Router } = loadRouter({ projectionThrows: true });
    const result = Router.dispatch('createInspection', ADMIN, {});
    assert(result.inspectionId === 'INS-NEW' && result.tenantUrl,
      'the reply lost the fields the client needs to recover');
  });

  section('An unknown action is still an error:');

  check('dispatch refuses it rather than attaching state to nothing', () => {
    const { Router, HandoverError } = loadRouter();
    let threw = null;
    try { Router.dispatch('notAnAction', ADMIN, {}); } catch (e) { threw = e; }
    assert(threw && threw.code === 'INVALID_REQUEST',
      `threw ${threw && threw.code}`);
  });
};
