/**
 * visibility.test.js
 * Which inspections an inspector may see and touch.
 *
 * Before this, "signed in as staff" and "allowed to open this inspection" were
 * the same question: any account could read, edit, lock and finalise anything
 * in the workbook. The Users screen decided *whether* someone could work, never
 * *on what*.
 *
 * The rule is one line — an admin sees everything, an inspector sees what is
 * assigned to them — and almost all of the risk is in the call sites. A handler
 * that forgets to ask is not a weaker check, it is no check, so the list below
 * walks every action that names an inspection rather than only the obvious
 * reads.
 *
 * The other thing under test is what an inspector is *told*. Inspection ids run
 * in sequence, so answering FORBIDDEN for someone else's inspection and
 * NOT_FOUND for a made-up one would let any account walk the range and count
 * the firm's work. Both answer the same way.
 */

const fs = require('fs');
const path = require('path');
const { createEnvironment, section, check, assert, expectError } = require('./appsscript-stubs');

const GAS_DIR = path.join(__dirname, '..', 'gas');

/**
 * The body of a named function in a .gs file, from its `function` line to the
 * next one at the same indent. Every service here is an IIFE of two-space
 * indented functions, which is what makes this crude split reliable enough.
 */
function bodyOf(file, name) {
  const source = fs.readFileSync(path.join(GAS_DIR, file), 'utf8');
  const start = source.indexOf(`\n  function ${name}(`);
  assert(start >= 0, `${file} has no function ${name}`);
  const rest = source.slice(start + 1);
  const end = rest.indexOf('\n  function ');
  return end < 0 ? rest : rest.slice(0, end);
}

module.exports = function run() {

  /**
   * An admin, two inspectors, and four inspections: one for each inspector, one
   * belonging to the admin, and one nobody has been given yet.
   */
  function fixture() {
    const env = createEnvironment();

    const admin = { role: 'admin', isAdmin: true, email: 'ana@firma.rs', actorString: 'user:ana@firma.rs' };
    const mina = { role: 'inspector', isAdmin: false, email: 'mina@firma.rs', actorString: 'user:mina@firma.rs' };
    const petar = { role: 'inspector', isAdmin: false, email: 'petar@firma.rs', actorString: 'user:petar@firma.rs' };
    const tenant = { role: 'tenant', isAdmin: false, inspectionId: 'INS-MINA' };

    [
      { inspectionId: 'INS-MINA', assignedTo: 'mina@firma.rs' },
      { inspectionId: 'INS-PETAR', assignedTo: 'petar@firma.rs' },
      { inspectionId: 'INS-ANA', assignedTo: 'ana@firma.rs' },
      { inspectionId: 'INS-NOBODY', assignedTo: '' },
    ].forEach(i => env.db.inspections.push(Object.assign({ status: 'draft' }, i)));

    return { env, admin, mina, petar, tenant };
  }

  const refused = (env, fn, note) => {
    const e = expectError(env.HandoverError, fn, note);
    assert(e.code === 'NOT_FOUND',
      `answered ${e.code}; an inspector must not be able to tell "someone else's" from "does not exist"`);
  };

  section('Every handler that names an inspection asks:');

  /**
   * Read against the sources rather than exercised through the services,
   * because the failure this guards against is an omission. A handler that
   * never calls the check cannot be caught by calling the check.
   *
   * Two answers count. requireInspectionAccess is the rule; requireAdmin is
   * stricter than the rule and so also fine — an admin sees everything anyway.
   */
  [
    ['InspectionService.gs', 'getInspection'],
    ['InspectionService.gs', 'saveSection'],
    ['InspectionService.gs', 'lockInspection'],
    ['InspectionService.gs', 'unlockInspection'],
    ['InspectionService.gs', 'regenerateTenantToken'],
    ['AttachmentService.gs', 'uploadAttachment'],
    ['AttachmentService.gs', 'deleteAttachment'],
    ['SignatureService.gs', 'saveSignature'],
    ['PdfService.gs', 'finalizeInspection'],
    ['AuditService.gs', 'getEventsForInspection'],
  ].forEach(([file, name]) => {
    check(`${name} does`, () => {
      const body = bodyOf(file, name);
      assert(
        body.includes('requireInspectionAccess') || body.includes('requireAdmin'),
        `${name} takes an inspectionId and never checks who is asking for it`);
    });
  });

  check('and the old check is gone from all of them', () => {
    // requireMatchingInspection only ever asked the tenant question. Leaving a
    // call to it at a handler that also serves staff would read like a check
    // and let every inspector through.
    const stale = ['InspectionService.gs', 'AttachmentService.gs', 'SignatureService.gs',
      'PdfService.gs', 'AuditService.gs']
      .filter(f => fs.readFileSync(path.join(GAS_DIR, f), 'utf8')
        .includes('requireMatchingInspection'));
    assert(stale.length === 0, `still calling requireMatchingInspection: ${stale.join(', ')}`);
  });

  section('The rule itself:');

  check('an inspector reaches their own inspection', () => {
    const { env, mina } = fixture();
    env.AuthService.requireInspectionAccess(mina, 'INS-MINA');
  });

  check("and not someone else's", () => {
    const { env, mina } = fixture();
    refused(env, () => env.AuthService.requireInspectionAccess(mina, 'INS-PETAR'),
      'an inspector opened work belonging to another inspector');
  });

  check('an unassigned inspection stays with the admins', () => {
    const { env, mina } = fixture();
    refused(env, () => env.AuthService.requireInspectionAccess(mina, 'INS-NOBODY'),
      'an inspection with no owner was treated as everyone\'s');
  });

  check('an admin reaches all of them', () => {
    const { env, admin } = fixture();
    ['INS-MINA', 'INS-PETAR', 'INS-ANA', 'INS-NOBODY'].forEach(id =>
      env.AuthService.requireInspectionAccess(admin, id));
  });

  check('a tenant link still reaches only its own inspection', () => {
    const { env, tenant } = fixture();
    env.AuthService.requireInspectionAccess(tenant, 'INS-MINA');
    expectError(env.HandoverError,
      () => env.AuthService.requireInspectionAccess(tenant, 'INS-PETAR'),
      'a tenant link opened a different inspection');
  });

  check('no auth context reaches nothing', () => {
    const { env } = fixture();
    expectError(env.HandoverError,
      () => env.AuthService.requireInspectionAccess(null, 'INS-MINA'),
      'an unauthenticated caller was let through');
  });

  section('An inspector cannot tell one refusal from another:');

  check('a real inspection and an invented one answer identically', () => {
    const { env, mina } = fixture();
    const other = expectError(env.HandoverError,
      () => env.AuthService.requireInspectionAccess(mina, 'INS-PETAR'));
    const invented = expectError(env.HandoverError,
      () => env.AuthService.requireInspectionAccess(mina, 'INS-DOES-NOT-EXIST'));

    assert(other.code === invented.code && other.message === invented.message,
      `"${other.code}: ${other.message}" vs "${invented.code}: ${invented.message}" — ` +
      'the difference is enough to enumerate the workbook');
  });

  section('Matching a case or a stray space is still matching:');

  check('the stored address is compared case-insensitively', () => {
    const { env, mina } = fixture();
    env.db.inspections[0].assignedTo = '  Mina@Firma.RS ';
    env.AuthService.requireInspectionAccess(mina, 'INS-MINA');
  });

  check('an account with no address matches nothing', () => {
    const { env } = fixture();
    const nameless = { role: 'inspector', isAdmin: false, email: '' };
    refused(env, () => env.AuthService.requireInspectionAccess(nameless, 'INS-NOBODY'),
      'an empty address matched an empty assignedTo');
  });

  section('The list is narrowed the same way:');

  check('an inspector sees only their own rows', () => {
    const { env, mina } = fixture();
    const seen = env.AuthService.visibleInspections(mina, env.db.inspections);
    assert(seen.length === 1 && seen[0].inspectionId === 'INS-MINA',
      `saw ${seen.map(i => i.inspectionId).join(', ')}`);
  });

  check('an admin sees all of them', () => {
    const { env, admin } = fixture();
    assert(env.AuthService.visibleInspections(admin, env.db.inspections).length === 4,
      'the admin list was narrowed');
  });

  check('an unassigned row is in nobody\'s list', () => {
    const { env, mina, petar } = fixture();
    const forInspectors = []
      .concat(env.AuthService.visibleInspections(mina, env.db.inspections))
      .concat(env.AuthService.visibleInspections(petar, env.db.inspections));
    assert(!forInspectors.some(i => i.inspectionId === 'INS-NOBODY'),
      'an inspection with no owner appeared in an inspector\'s list');
  });
};
