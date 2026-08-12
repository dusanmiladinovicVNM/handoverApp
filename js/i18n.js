/**
 * i18n.js
 * The language the app speaks, and every word it says on its own behalf.
 *
 * Two languages: German and English. German is the default, and it is Swiss
 * German — Swiss Standard German, the written kind — which for this file means
 * two concrete rules:
 *
 *  1. No "ß", ever. Switzerland dropped it; "Strasse", "schliessen", "Grösse",
 *     "muss". A German-from-Germany spelling is not a small blemish here, it is
 *     the thing a Swiss reader notices first. tests/i18n.test.js fails on one.
 *  2. Swiss vocabulary where it differs from Germany's, because this app is
 *     read on site by people who use it: Lavabo, Boiler, Dampfabzug,
 *     Mietzinsdepot, Wohnungsabnahme, Storen.
 *
 * Strings the *server* owns — section titles, question labels, option labels —
 * are not in here. They arrive from the Schemas sheet in English and are
 * translated on the way to the screen by tc(), against the map in
 * i18n-content.js. That keeps this file about the app and that one about the
 * inspection forms, and it means a schema someone edits in the sheet still
 * renders: an unknown string is shown as it came.
 *
 * Nothing here is a security boundary. A language is a preference on a device.
 */

import { CONTENT } from './i18n-content.js';

const LANG_KEY = 'handover.lang';

export const LANGUAGES = [
  { code: 'de', label: 'Deutsch', short: 'DE' },
  { code: 'en', label: 'English', short: 'EN' },
];

export const DEFAULT_LANG = 'de';

const CODES = LANGUAGES.map(l => l.code);

// ============================================================
// Which language
// ============================================================

/**
 * Read once at module load, not on every t() call.
 *
 * localStorage throws in private browsing and when the quota is full — see
 * utils/store.js for the same wrapping — and a language preference is the last
 * thing that should be able to stop the app from drawing.
 */
let _lang = resolveInitialLang();

function stored() {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch (_) {
    return null;
  }
}

/**
 * Stored choice first, then what the browser asks for, then German.
 *
 * The browser list is matched on the primary subtag only: de-CH, de-DE and
 * plain de all mean the same dictionary here. A browser asking for anything
 * this app does not speak — French, Italian, Portuguese, which on a tenant's
 * phone in Switzerland are all likely — lands on German, because German is the
 * language this deployment is in, not merely the first entry in a list.
 *
 * Split out from the reading of localStorage and navigator so it can be checked
 * with inputs rather than with whatever the test runner's environment happens
 * to claim. Node has a navigator, and it says en-US.
 */
export function resolveLang(saved, offered) {
  if (saved && CODES.indexOf(saved) >= 0) return saved;
  for (const tag of (offered || [])) {
    const primary = String(tag).toLowerCase().split('-')[0];
    if (CODES.indexOf(primary) >= 0) return primary;
  }
  return DEFAULT_LANG;
}

function resolveInitialLang() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const offered = (nav && nav.languages) || (nav && nav.language ? [nav.language] : []);
  return resolveLang(stored(), offered);
}

export function getLang() {
  return _lang;
}

const _listeners = new Set();

/** Notified after the language has already changed, so t() is current. */
export function onLangChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function setLang(code) {
  if (CODES.indexOf(code) < 0 || code === _lang) return;
  _lang = code;
  try { localStorage.setItem(LANG_KEY, code); } catch (_) {}
  applyDocumentLang();
  for (const fn of _listeners) {
    try { fn(code); } catch (e) { console.error('[i18n] listener failed', e); }
  }
}

/**
 * Tell the document what it is written in.
 *
 * Not decoration: it is what a screen reader picks a voice from, and what the
 * browser's own translate prompt reads. Called at boot and on every change.
 */
export function applyDocumentLang() {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = _lang;
  }
}

// ============================================================
// Looking a string up
// ============================================================

/**
 * `{name}` is replaced from params. A placeholder with nothing to fill it is
 * left standing rather than blanked, so a missing parameter shows up on the
 * screen instead of silently reading as a finished sentence.
 */
function interpolate(template, params) {
  return template.replace(/\{(\w+)\}/g, (whole, key) =>
    (params && params[key] !== undefined && params[key] !== null)
      ? String(params[key])
      : whole);
}

/**
 * Translate one of this app's own strings.
 *
 * Falls back through German to the key itself. A key that reaches the screen is
 * a bug, but a visible one — better than an empty label that reads as a design
 * choice.
 */
export function t(key, params) {
  const table = UI[_lang] || UI[DEFAULT_LANG];
  let s = table[key];
  if (s === undefined) s = UI[DEFAULT_LANG][key];
  if (s === undefined) s = key;
  return params ? interpolate(s, params) : s;
}

/**
 * The count-dependent form. Both languages here have exactly two, so the keys
 * are `<key>.one` and `<key>.other` and `count` is always available to the
 * template.
 */
export function tn(key, count, params) {
  const suffix = Number(count) === 1 ? '.one' : '.other';
  return t(key + suffix, Object.assign({ count }, params));
}

/**
 * Translate a string the server sent — a section title, a question label, an
 * option label.
 *
 * Unknown text is returned unchanged, which is the whole point: the Schemas
 * sheet is editable, and a question someone adds there must render rather than
 * disappear or show a key. English is the source language, so in English this
 * is the identity function.
 */
export function tc(text) {
  if (_lang === 'en' || !text) return text;
  const table = CONTENT[_lang];
  if (!table) return text;
  const hit = table[String(text).trim()];
  return hit === undefined ? text : hit;
}

/** The language names, for a switcher to render. */
export function languages() {
  return LANGUAGES.slice();
}

// ============================================================
// The app's own words
// ============================================================

const UI = {
  en: {
    // --- Language switcher ---
    'lang.switch': 'Change language',
    'lang.label': 'Language',

    // --- Shared actions ---
    'action.cancel': 'Cancel',
    'action.confirm': 'Confirm',
    'action.close': 'Close',
    'action.done': 'Done',
    'action.back': 'Back',
    'action.remove': 'Remove',
    'action.copy': 'Copy',
    'action.copyLink': 'Copy link',
    'action.change': 'Change',
    'action.saving': 'Saving…',

    // --- Network and image failures the person actually sees ---
    'api.timeout': "The request '{action}' took too long.",
    'api.network': 'The network request failed.',
    'api.invalidResponse': 'The server did not return a valid response.',
    'image.loadFailed': 'The image could not be read.',
    'image.encodeFailed': 'The image could not be converted.',

    // --- Boot / errors / not found ---
    'boot.loading': 'Loading…',
    'boot.failed': 'Boot failed: ',
    'error.title': 'Error',
    'notFound.title': 'Page not found',
    'notFound.body': 'No route for ',
    'notFound.home': 'Back to home',

    // --- Save indicator ---
    'save.idle': 'No changes',
    'save.saving': 'Saving…',
    'save.saved': 'Saved',
    'save.error': 'Save failed',

    // --- Confirm dialog defaults ---
    'modal.confirmTitle': 'Confirm',
    'modal.confirmMessage': 'Are you sure?',

    // --- Question card ---
    'question.required': 'required',
    'question.notePlaceholder': 'Add a note',
    'question.addComment': '+ Add comment',
    'question.hideComment': '− Hide comment',
    'input.choose': '— Choose —',
    'input.unsupported': 'Unsupported type: {type}',

    // --- Photos ---
    'photo.add': 'Add photo',
    'photo.remove': 'Remove photo',
    'photo.removeTitle': 'Remove photo?',
    'photo.removeMessage': 'This cannot be undone.',
    'photo.removed': 'Photo removed',
    'photo.removeFailed': 'Failed to remove photo',
    'photo.uploaded': 'Photo uploaded',
    'photo.uploadFailed': 'Photo upload failed',
    'photo.min.one': 'At least {count} photo required.',
    'photo.min.other': 'At least {count} photos required.',

    // --- Signature pad ---
    'signature.hint': 'Sign here',
    'signature.clear': 'Clear',

    // --- Statuses ---
    'status.draft': 'Draft',
    'status.under_review': 'Under review',
    'status.locked_for_signature': 'Awaiting signature',
    'status.partially_signed': 'Partially signed',
    'status.signed': 'Signed',
    'status.archived': 'Archived',
    'status.cancelled': 'Cancelled',

    // --- Inspection types ---
    'type.move_in': 'Move-in',
    'type.move_out': 'Move-out',
    'type.periodic': 'Periodic',
    'type.damage_report': 'Damage report',
    'type.key_handover': 'Key handover',

    // --- Roles ---
    'role.admin': 'Admin',
    'role.inspector': 'Inspector',
    'role.tenant': 'Tenant',
    'role.landlord': 'Landlord',

    // --- Sign-in ---
    'login.title': 'Sign in',
    'login.intro': 'Use the email address your account was created with.',
    'login.email': 'Email',
    'login.password': 'Password',
    'login.remember': 'Remember this device',
    'login.submit': 'Sign in',
    'login.submitting': 'Signing in…',
    'login.forgot': 'Forgot your password?',
    'login.tenantNote': 'Tenants do not sign in — they receive a direct link for their inspection.',
    'login.missingFields': 'Enter your email address and password.',
    'login.failed': 'Sign-in failed.',
    'login.welcome': 'Signed in as {name}.',
    'login.sessionEnded': 'Your session has ended. Please sign in again.',

    // --- Set password ---
    'setPassword.title': 'Set password',
    'setPassword.incompleteTitle': 'This link is incomplete',
    'setPassword.incompleteBody': 'Open the link from your email exactly as it was sent, or ask for a new one.',
    'setPassword.newLink': 'Send me a new link',
    'setPassword.choose': 'Choose your password',
    'setPassword.advice': 'Four unrelated words make a password that is easy to remember and hard to guess — far better than a short one with symbols in it.',
    'setPassword.new': 'New password',
    'setPassword.repeat': 'Repeat password',
    'setPassword.minLength': 'At least 16 characters.',
    'setPassword.submit': 'Set password and sign in',
    'setPassword.mismatch': 'The two passwords do not match.',
    'setPassword.failed': 'Could not set the password.',
    'setPassword.signsOutOthers': 'Any device already signed in to this account will be signed out.',
    'setPassword.welcome': 'Welcome, {name}.',

    // --- Forgot password ---
    'forgot.title': 'Password reset',
    'forgot.sentTitle': 'Check your inbox',
    'forgot.sentBody': 'If that address belongs to an account, a link is on its way. It is valid for 48 hours and can be used once.',
    'forgot.backToLogin': 'Back to sign in',
    'forgot.formTitle': 'Send a reset link',
    'forgot.formBody': 'We will email you a link on which you can choose a new password.',
    'forgot.submit': 'Send link',
    'forgot.submitting': 'Sending…',
    'forgot.failed': 'Could not send the link.',

    // --- Profile ---
    'profile.title': 'My account',
    'profile.changePassword': 'Change password',
    'profile.changeWarning': 'All signed-in devices will be signed out, including this one.',
    'profile.current': 'Current password',
    'profile.new': 'New password',
    'profile.repeat': 'Repeat new password',
    'profile.mismatch': 'The two new passwords do not match.',
    'profile.failed': 'Could not change the password.',
    'profile.changed': 'Password changed. Please sign in again.',
    'profile.language': 'Language',
    'profile.languageHint': 'Applies to this device only.',

    // --- Users ---
    'users.title': 'Users',
    'users.activeAdmins.one': '{count} active admin',
    'users.activeAdmins.other': '{count} active admins',
    'users.add': '+ Add',
    'users.search': 'Search name or email',
    'users.filter.all': 'All',
    'users.filter.active': 'Active',
    'users.filter.disabled': 'Disabled',
    'users.filter.admin': 'Admins',
    'users.filter.nopassword': 'No password yet',
    'users.filter.locked': 'Locked',
    'users.noneTitle': 'No users match',
    'users.noneBody': 'Try a different search or filter.',
    'users.badge.disabled': 'Disabled',
    'users.badge.locked': 'Locked',
    'users.badge.noPassword': 'No password yet',
    'users.lastSignIn': 'Last sign-in {when}',
    'users.neverSignedIn': 'Never signed in',
    'users.devices.one': '{count} device',
    'users.devices.other': '{count} devices',

    'users.addTitle': 'Add user',
    'users.name': 'Name',
    'users.email': 'Email',
    'users.role': 'Role',
    'users.addNote': 'They will receive a link to choose their own password. No password is ever sent by email.',
    'users.adding': 'Adding…',
    'users.added': '{name} added. Link sent to {email}.',

    'users.mailFailedTitle': 'Email could not be sent',
    'users.mailFailedBody': 'The account for {email} exists and is ready. Only the email failed, so pass this link on yourself:',
    'users.linkCopied': 'Link copied.',
    'users.copyManually': 'Copy it manually.',

    'users.detail.lastSignIn': 'Last sign-in',
    'users.detail.never': 'Never',
    'users.detail.activeDevices': 'Active devices',
    'users.detail.created': 'Created',
    'users.detail.createdBy': 'Created by',
    'users.detail.disabled': 'Disabled',
    'users.detail.disabledBy': '{when} by {who}',
    'users.detail.lockedUntil': 'Locked until',
    'users.detail.actions': 'Actions',

    'users.disable': 'Disable access',
    'users.disableTitle': 'Disable access?',
    'users.disableMessage': '{name} will be signed out of every device immediately and will not be able to sign in again.',
    'users.disableConfirm': 'Disable',
    'users.disabled': '{name} no longer has access.',
    'users.disableSelf': 'You cannot disable your own account.',
    'users.onlyAdmin': 'This is the only active administrator.',

    'users.restore': 'Restore access',
    'users.restoreTitle': 'Restore access?',
    'users.restoreMessage': '{name} will be able to sign in again. Their old devices stay signed out — they will sign in fresh.',
    'users.restoreConfirm': 'Restore',
    'users.restored': '{name} has access again.',

    'users.revokeAdmin': 'Remove admin rights',
    'users.revokeAdminTitle': 'Remove admin rights?',
    'users.revokeAdminMessage': '{name} will keep their account but lose access to account administration.',
    'users.revokeAdminConfirm': 'Remove',
    'users.revokedAdmin': '{name} is now an inspector.',
    'users.revokeAdminSelf': 'You cannot remove your own admin rights.',
    'users.promoteSomeoneFirst': 'Promote someone else first.',

    'users.grantAdmin': 'Grant admin rights',
    'users.grantAdminTitle': 'Grant admin rights?',
    'users.grantAdminMessage': '{name} will be able to add and disable users, and grant admin rights to others.',
    'users.grantAdminConfirm': 'Grant',
    'users.grantedAdmin': '{name} is now an admin.',

    'users.unlock': 'Unlock account',
    'users.unlocked': 'Account unlocked.',
    'users.sendReset': 'Send a password reset link',
    'users.resendInvite': 'Resend the invitation link',
    'users.linkSent': 'Link sent to {email}.',
    'users.devicesButton': 'Devices ({count})',
    'users.history': 'History',

    'users.devicesTitle': '{name} — devices',
    'users.noDevices': 'No devices are signed in.',
    'users.deviceMeta': 'Last used {lastSeen} · expires {expires}',
    'users.signOutDevice': 'Sign out',
    'users.deviceSignedOut': 'Device signed out.',
    'users.signOutAll': 'Sign out all devices',
    'users.allSignedOut': 'All devices signed out.',

    'users.historyTitle': '{name} — history',
    'users.noHistory': 'Nothing recorded yet.',

    // --- Auth log events ---
    'event.login_succeeded': 'Signed in',
    'event.login_failed': 'Failed sign-in',
    'event.account_locked': 'Account locked',
    'event.account_unlocked': 'Account unlocked',
    'event.password_set': 'Password set',
    'event.password_changed': 'Password changed',
    'event.password_reset': 'Password reset',
    'event.password_reset_sent': 'Reset link sent',
    'event.user_created': 'Account created',
    'event.user_disabled': 'Access disabled',
    'event.user_enabled': 'Access restored',
    'event.role_granted': 'Admin rights granted',
    'event.role_revoked': 'Admin rights removed',
    'event.device_registered': 'Device registered',
    'event.device_revoked': 'Device signed out',

    // --- Inspection list ---
    'list.title': 'Inspections',
    'list.new': '+ New',
    'list.refresh': 'Refresh',
    'list.users': 'Users',
    'list.account': 'My account',
    'list.signOut': 'Sign out',
    'list.signOutTitle': 'Sign out?',
    'list.signOutMessage': 'This device will be signed out. You will need your email and password to sign back in.',
    'list.refreshFailed': 'Could not refresh the list.',
    'list.search': 'Search by address, tenant, or ID',
    'list.emptyTitle': 'No inspections yet',
    'list.emptyBody': 'Create your first inspection to get started.',
    'list.emptyAction': '+ New inspection',
    'list.noMatchTitle': 'Nothing matches',
    'list.noMatchBody': 'No inspection in the list matches that search.',
    'list.noAddress': '(no address)',
    'list.noTenant': '(no tenant)',
    'list.assignedTo': 'Assigned to ',

    // --- New inspection ---
    'new.title': 'New inspection',
    'new.type': 'Inspection type',
    'new.property': 'Property',
    'new.address': 'Address',
    'new.addressPlaceholder': 'Street and number',
    'new.city': 'City',
    'new.postalCode': 'Postal code',
    'new.unit': 'Unit / apartment number',
    'new.landlord': 'Landlord',
    'new.tenant': 'Tenant',
    'new.name': 'Name',
    'new.email': 'Email',
    'new.phone': 'Phone',
    'new.assignTo': 'Assign to',
    'new.assignMe': 'Me',
    'new.assignHint': 'Who will carry out this inspection. Can be changed later.',
    'new.notes': 'Internal notes (optional)',
    'new.submit': 'Create inspection',
    'new.submitting': 'Creating…',
    'new.needType': 'Pick an inspection type.',
    'new.needAddress': 'Address required.',
    'new.needParties': 'Both landlord and tenant names are required.',
    'new.created': 'Inspection created.',
    'new.createdTitle': 'Inspection created',
    'new.idLabel': 'ID: ',
    'new.tenantLink': 'Tenant link (share via email or SMS):',
    'new.tenantLinkNote': 'This link is private. The tenant can use it without a Google account. Default expiry: 7 days.',
    'new.open': 'Open inspection',
    'new.copied': 'Copied',

    // --- Inspection home ---
    'inspection.fallbackTitle': 'Inspection',
    'inspection.loading': 'Loading inspection…',
    'inspection.loadFailed': 'Could not load inspection',
    'inspection.requiredCount': ' required',
    'inspection.sections': 'Sections',
    'inspection.unsaved': 'Unsaved',
    'inspection.unsavedHint': 'Typed on this device but not yet saved. Open the section to send it.',
    'inspection.awaitingTitle': 'Awaiting signatures',
    'inspection.awaitingBody': 'The inspection is locked for review. Editing is disabled.',
    'inspection.signedTitle': 'Signed',
    'inspection.signedBody': 'All signatures collected.',
    'inspection.reviewLock': 'Review & lock',
    'inspection.completeMore': 'Complete {count} more required',
    'inspection.goSign': 'Go to signing',
    'inspection.viewReport': 'View final report',

    // --- Section editor ---
    'section.notFound': 'Section not found',
    'section.notFoundBody': "No section with id '{id}'.",
    'section.sections': 'Sections',
    'section.next': 'Next: {title} →',
    'section.done': 'Done with section',
    'section.conflict': 'This section was changed elsewhere. Reopen it to see the current answers; what you typed is still saved on this device.',
    'section.saveFailed': 'Save failed: {code} — {message}',
    'section.restored.one': '{count} answer from this device had not been saved. Restored — sending now.',
    'section.restored.other': '{count} answers from this device had not been saved. Restored — sending now.',

    // --- Review ---
    'review.title': 'Review',
    'review.tenant': 'Tenant: ',
    'review.landlord': 'Landlord: ',
    'review.requiredItems': 'Required items',
    'review.missing.one': '{count} item still missing',
    'review.missing.other': '{count} items still missing',
    'review.photosRequired': ' (photos required)',
    'review.allComplete': 'All required items completed.',
    'review.sectionSummary': 'Section summary',
    'review.sectionRequired': '{done}/{total} required',
    'review.sectionFilled': '{done}/{total} filled',
    'review.lock': 'Lock & request signatures',
    'review.locking': 'Locking…',
    'review.lockTitle': 'Lock inspection?',
    'review.lockMessage': 'Once locked, no further edits are possible. Both parties will sign the report. You can unlock later if corrections are needed (which invalidates any signatures).',
    'review.lockConfirm': 'Lock for signing',
    'review.locked': 'Inspection locked. Ready for signatures.',
    'review.stillMissingOne': 'Still missing: {section} — {label}',
    'review.stillMissingMany': '{count} required items missing, listed above.',

    // --- Signing ---
    'sign.title': 'Sign',
    'sign.signaturesTitle': 'Signatures',
    'sign.cannotTitle': 'Cannot sign',
    'sign.cannotBody': 'No valid signing role.',
    'sign.alreadySigned': 'You have signed. Awaiting other party.',
    'sign.backToAdmin': 'Back to admin',
    'sign.signingAs': 'Signing as',
    'sign.signingAsFixed': 'Signing as ',
    'sign.fullName': 'Full name (printed)',
    'sign.signature': 'Signature',
    'sign.accept': 'I confirm the contents of this inspection are accurate and that I am the named signer.',
    'sign.submit': 'Submit signature',
    'sign.submitting': 'Submitting…',
    'sign.needName': 'Name required.',
    'sign.needAccept': 'You must accept the confirmation.',
    'sign.needSignature': 'Please draw your signature.',
    'sign.saved': 'Signature saved.',
    'sign.failed': 'Signature submission failed',

    // --- Finalize / success ---
    'final.offerTitle': 'Generate final report?',
    'final.offerMessage': 'All signatures collected. Generate the final PDF now? This may take 30–60 seconds.',
    'final.offerConfirm': 'Generate PDF',
    'final.generating': 'Generating PDF…',
    'final.ready': 'Final PDF ready.',
    'final.generated': 'Final PDF generated.',
    'success.title': 'Inspection complete',
    'success.allSigned': 'All signatures collected',
    'success.openPdf': 'Open final PDF',
    'success.generate': 'Generate final PDF',
    'success.generatingShort': 'Generating…',
    'success.waitForLandlord': 'The landlord will finalize the report shortly.',
    'success.backToList': 'Back to inspections',

    // --- Admin detail ---
    'detail.tenant': 'Tenant: ',
    'detail.landlord': 'Landlord: ',
    'detail.created': 'Created: ',
    'detail.createdBy': ' by ',
    'detail.noEmail': 'no email',
    'detail.unknown': 'unknown',
    'detail.assignedTo': 'Assigned to: ',
    'detail.nobody': 'nobody',
    'detail.openEditor': 'Open editor',
    'detail.newTenantLink': 'New tenant link',
    'detail.unlock': 'Unlock',
    'detail.unlockTitle': 'Unlock inspection?',
    'detail.unlockMessage': 'This will invalidate all collected signatures. The tenant link will need to be re-shared.',
    'detail.unlocked': 'Unlocked.',
    'detail.unlockReason': 'admin requested',

    'assign.title': 'Assign inspection',
    'assign.none': 'No active users to assign to.',
    'assign.who': 'Who will carry out this inspection.',
    'assign.current': 'Current',
    'assign.done': 'Assigned to {name}.',

    'tenantLink.title': 'New tenant link',
    'tenantLink.expires': 'Expires: {when}',
    'tenantLink.previousInvalid': 'Note: previous tenant links are now invalid.',
  },

  // ============================================================
  // Deutsch (Schweiz) — kein "ß", Schweizer Wortschatz.
  // ============================================================
  de: {
    'lang.switch': 'Sprache wechseln',
    'lang.label': 'Sprache',

    'action.cancel': 'Abbrechen',
    'action.confirm': 'Bestätigen',
    'action.close': 'Schliessen',
    'action.done': 'Fertig',
    'action.back': 'Zurück',
    'action.remove': 'Entfernen',
    'action.copy': 'Kopieren',
    'action.copyLink': 'Link kopieren',
    'action.change': 'Ändern',
    'action.saving': 'Wird gespeichert…',

    'api.timeout': 'Die Anfrage «{action}» hat zu lange gedauert.',
    'api.network': 'Die Netzwerkanfrage ist fehlgeschlagen.',
    'api.invalidResponse': 'Der Server hat keine gültige Antwort geliefert.',
    'image.loadFailed': 'Das Bild konnte nicht gelesen werden.',
    'image.encodeFailed': 'Das Bild konnte nicht umgewandelt werden.',

    'boot.loading': 'Wird geladen…',
    'boot.failed': 'Start fehlgeschlagen: ',
    'error.title': 'Fehler',
    'notFound.title': 'Seite nicht gefunden',
    'notFound.body': 'Keine Route für ',
    'notFound.home': 'Zurück zum Start',

    'save.idle': 'Keine Änderungen',
    'save.saving': 'Wird gespeichert…',
    'save.saved': 'Gespeichert',
    'save.error': 'Speichern fehlgeschlagen',

    'modal.confirmTitle': 'Bestätigen',
    'modal.confirmMessage': 'Sind Sie sicher?',

    'question.required': 'Pflichtfeld',
    'question.notePlaceholder': 'Bemerkung erfassen',
    'question.addComment': '+ Bemerkung',
    'question.hideComment': '− Bemerkung ausblenden',
    'input.choose': '— Auswählen —',
    'input.unsupported': 'Nicht unterstützter Typ: {type}',

    'photo.add': 'Foto hinzufügen',
    'photo.remove': 'Foto entfernen',
    'photo.removeTitle': 'Foto entfernen?',
    'photo.removeMessage': 'Das kann nicht rückgängig gemacht werden.',
    'photo.removed': 'Foto entfernt',
    'photo.removeFailed': 'Foto konnte nicht entfernt werden',
    'photo.uploaded': 'Foto hochgeladen',
    'photo.uploadFailed': 'Foto konnte nicht hochgeladen werden',
    'photo.min.one': 'Mindestens {count} Foto erforderlich.',
    'photo.min.other': 'Mindestens {count} Fotos erforderlich.',

    'signature.hint': 'Hier unterschreiben',
    'signature.clear': 'Löschen',

    'status.draft': 'Entwurf',
    'status.under_review': 'In Prüfung',
    'status.locked_for_signature': 'Wartet auf Unterschrift',
    'status.partially_signed': 'Teilweise unterschrieben',
    'status.signed': 'Unterschrieben',
    'status.archived': 'Archiviert',
    'status.cancelled': 'Storniert',

    'type.move_in': 'Wohnungsübergabe',
    'type.move_out': 'Wohnungsabnahme',
    'type.periodic': 'Periodische Kontrolle',
    'type.damage_report': 'Schadenmeldung',
    'type.key_handover': 'Schlüsselübergabe',

    'role.admin': 'Administrator',
    'role.inspector': 'Sachbearbeiter',
    'role.tenant': 'Mieterschaft',
    'role.landlord': 'Vermieterschaft',

    'login.title': 'Anmelden',
    'login.intro': 'Verwenden Sie die E-Mail-Adresse, mit der Ihr Konto erstellt wurde.',
    'login.email': 'E-Mail',
    'login.password': 'Passwort',
    'login.remember': 'Dieses Gerät merken',
    'login.submit': 'Anmelden',
    'login.submitting': 'Anmeldung läuft…',
    'login.forgot': 'Passwort vergessen?',
    'login.tenantNote': 'Die Mieterschaft meldet sich nicht an — sie erhält einen direkten Link zum Protokoll.',
    'login.missingFields': 'Geben Sie E-Mail-Adresse und Passwort ein.',
    'login.failed': 'Anmeldung fehlgeschlagen.',
    'login.welcome': 'Angemeldet als {name}.',
    'login.sessionEnded': 'Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.',

    'setPassword.title': 'Passwort festlegen',
    'setPassword.incompleteTitle': 'Dieser Link ist unvollständig',
    'setPassword.incompleteBody': 'Öffnen Sie den Link aus Ihrer E-Mail genau so, wie er versendet wurde, oder fordern Sie einen neuen an.',
    'setPassword.newLink': 'Neuen Link zusenden',
    'setPassword.choose': 'Wählen Sie Ihr Passwort',
    'setPassword.advice': 'Vier voneinander unabhängige Wörter ergeben ein Passwort, das leicht zu merken und schwer zu erraten ist — deutlich besser als ein kurzes mit Sonderzeichen.',
    'setPassword.new': 'Neues Passwort',
    'setPassword.repeat': 'Passwort wiederholen',
    'setPassword.minLength': 'Mindestens 16 Zeichen.',
    'setPassword.submit': 'Passwort festlegen und anmelden',
    'setPassword.mismatch': 'Die beiden Passwörter stimmen nicht überein.',
    'setPassword.failed': 'Das Passwort konnte nicht gesetzt werden.',
    'setPassword.signsOutOthers': 'Alle Geräte, die bei diesem Konto angemeldet sind, werden abgemeldet.',
    'setPassword.welcome': 'Willkommen, {name}.',

    'forgot.title': 'Passwort zurücksetzen',
    'forgot.sentTitle': 'Prüfen Sie Ihren Posteingang',
    'forgot.sentBody': 'Gehört diese Adresse zu einem Konto, ist ein Link unterwegs. Er ist 48 Stunden gültig und einmal verwendbar.',
    'forgot.backToLogin': 'Zurück zur Anmeldung',
    'forgot.formTitle': 'Link zum Zurücksetzen senden',
    'forgot.formBody': 'Wir senden Ihnen per E-Mail einen Link, auf dem Sie ein neues Passwort wählen können.',
    'forgot.submit': 'Link senden',
    'forgot.submitting': 'Wird gesendet…',
    'forgot.failed': 'Der Link konnte nicht gesendet werden.',

    'profile.title': 'Mein Konto',
    'profile.changePassword': 'Passwort ändern',
    'profile.changeWarning': 'Alle angemeldeten Geräte werden abgemeldet, dieses eingeschlossen.',
    'profile.current': 'Aktuelles Passwort',
    'profile.new': 'Neues Passwort',
    'profile.repeat': 'Neues Passwort wiederholen',
    'profile.mismatch': 'Die beiden neuen Passwörter stimmen nicht überein.',
    'profile.failed': 'Das Passwort konnte nicht geändert werden.',
    'profile.changed': 'Passwort geändert. Bitte melden Sie sich erneut an.',
    'profile.language': 'Sprache',
    'profile.languageHint': 'Gilt nur für dieses Gerät.',

    'users.title': 'Benutzer',
    'users.activeAdmins.one': '{count} aktiver Administrator',
    'users.activeAdmins.other': '{count} aktive Administratoren',
    'users.add': '+ Neu',
    'users.search': 'Name oder E-Mail suchen',
    'users.filter.all': 'Alle',
    'users.filter.active': 'Aktiv',
    'users.filter.disabled': 'Gesperrt',
    'users.filter.admin': 'Administratoren',
    'users.filter.nopassword': 'Noch kein Passwort',
    'users.filter.locked': 'Blockiert',
    'users.noneTitle': 'Keine Treffer',
    'users.noneBody': 'Versuchen Sie eine andere Suche oder einen anderen Filter.',
    'users.badge.disabled': 'Gesperrt',
    'users.badge.locked': 'Blockiert',
    'users.badge.noPassword': 'Noch kein Passwort',
    'users.lastSignIn': 'Letzte Anmeldung {when}',
    'users.neverSignedIn': 'Noch nie angemeldet',
    'users.devices.one': '{count} Gerät',
    'users.devices.other': '{count} Geräte',

    'users.addTitle': 'Benutzer hinzufügen',
    'users.name': 'Name',
    'users.email': 'E-Mail',
    'users.role': 'Rolle',
    'users.addNote': 'Die Person erhält einen Link, um ein eigenes Passwort zu wählen. Es wird nie ein Passwort per E-Mail versendet.',
    'users.adding': 'Wird hinzugefügt…',
    'users.added': '{name} hinzugefügt. Link an {email} gesendet.',

    'users.mailFailedTitle': 'E-Mail konnte nicht gesendet werden',
    'users.mailFailedBody': 'Das Konto für {email} besteht und ist bereit. Nur der E-Mail-Versand ist fehlgeschlagen — geben Sie diesen Link selbst weiter:',
    'users.linkCopied': 'Link kopiert.',
    'users.copyManually': 'Bitte manuell kopieren.',

    'users.detail.lastSignIn': 'Letzte Anmeldung',
    'users.detail.never': 'Nie',
    'users.detail.activeDevices': 'Aktive Geräte',
    'users.detail.created': 'Erstellt',
    'users.detail.createdBy': 'Erstellt von',
    'users.detail.disabled': 'Gesperrt',
    'users.detail.disabledBy': '{when} durch {who}',
    'users.detail.lockedUntil': 'Blockiert bis',
    'users.detail.actions': 'Aktionen',

    'users.disable': 'Zugang sperren',
    'users.disableTitle': 'Zugang sperren?',
    'users.disableMessage': '{name} wird sofort auf allen Geräten abgemeldet und kann sich nicht mehr anmelden.',
    'users.disableConfirm': 'Sperren',
    'users.disabled': '{name} hat keinen Zugang mehr.',
    'users.disableSelf': 'Sie können Ihr eigenes Konto nicht sperren.',
    'users.onlyAdmin': 'Das ist der einzige aktive Administrator.',

    'users.restore': 'Zugang wiederherstellen',
    'users.restoreTitle': 'Zugang wiederherstellen?',
    'users.restoreMessage': '{name} kann sich wieder anmelden. Die früheren Geräte bleiben abgemeldet — die Anmeldung erfolgt neu.',
    'users.restoreConfirm': 'Wiederherstellen',
    'users.restored': '{name} hat wieder Zugang.',

    'users.revokeAdmin': 'Administratorrechte entziehen',
    'users.revokeAdminTitle': 'Administratorrechte entziehen?',
    'users.revokeAdminMessage': '{name} behält das Konto, verliert aber den Zugang zur Benutzerverwaltung.',
    'users.revokeAdminConfirm': 'Entziehen',
    'users.revokedAdmin': '{name} ist neu Sachbearbeiter.',
    'users.revokeAdminSelf': 'Sie können sich die eigenen Administratorrechte nicht entziehen.',
    'users.promoteSomeoneFirst': 'Ernennen Sie zuerst jemand anderen.',

    'users.grantAdmin': 'Administratorrechte erteilen',
    'users.grantAdminTitle': 'Administratorrechte erteilen?',
    'users.grantAdminMessage': '{name} kann künftig Benutzer hinzufügen und sperren sowie anderen Administratorrechte erteilen.',
    'users.grantAdminConfirm': 'Erteilen',
    'users.grantedAdmin': '{name} ist neu Administrator.',

    'users.unlock': 'Konto entsperren',
    'users.unlocked': 'Konto entsperrt.',
    'users.sendReset': 'Link zum Zurücksetzen senden',
    'users.resendInvite': 'Einladungslink erneut senden',
    'users.linkSent': 'Link an {email} gesendet.',
    'users.devicesButton': 'Geräte ({count})',
    'users.history': 'Verlauf',

    'users.devicesTitle': '{name} — Geräte',
    'users.noDevices': 'Es ist kein Gerät angemeldet.',
    'users.deviceMeta': 'Zuletzt verwendet {lastSeen} · läuft ab {expires}',
    'users.signOutDevice': 'Abmelden',
    'users.deviceSignedOut': 'Gerät abgemeldet.',
    'users.signOutAll': 'Alle Geräte abmelden',
    'users.allSignedOut': 'Alle Geräte abgemeldet.',

    'users.historyTitle': '{name} — Verlauf',
    'users.noHistory': 'Noch nichts aufgezeichnet.',

    'event.login_succeeded': 'Angemeldet',
    'event.login_failed': 'Fehlgeschlagene Anmeldung',
    'event.account_locked': 'Konto blockiert',
    'event.account_unlocked': 'Konto entsperrt',
    'event.password_set': 'Passwort gesetzt',
    'event.password_changed': 'Passwort geändert',
    'event.password_reset': 'Passwort zurückgesetzt',
    'event.password_reset_sent': 'Link zum Zurücksetzen gesendet',
    'event.user_created': 'Konto erstellt',
    'event.user_disabled': 'Zugang gesperrt',
    'event.user_enabled': 'Zugang wiederhergestellt',
    'event.role_granted': 'Administratorrechte erteilt',
    'event.role_revoked': 'Administratorrechte entzogen',
    'event.device_registered': 'Gerät registriert',
    'event.device_revoked': 'Gerät abgemeldet',

    'list.title': 'Protokolle',
    'list.new': '+ Neu',
    'list.refresh': 'Aktualisieren',
    'list.users': 'Benutzer',
    'list.account': 'Mein Konto',
    'list.signOut': 'Abmelden',
    'list.signOutTitle': 'Abmelden?',
    'list.signOutMessage': 'Dieses Gerät wird abgemeldet. Für die nächste Anmeldung brauchen Sie E-Mail-Adresse und Passwort.',
    'list.refreshFailed': 'Die Liste konnte nicht aktualisiert werden.',
    'list.search': 'Nach Adresse, Mieterschaft oder ID suchen',
    'list.emptyTitle': 'Noch keine Protokolle',
    'list.emptyBody': 'Erstellen Sie Ihr erstes Protokoll, um zu beginnen.',
    'list.emptyAction': '+ Neues Protokoll',
    'list.noMatchTitle': 'Keine Treffer',
    'list.noMatchBody': 'Kein Protokoll in der Liste passt zu dieser Suche.',
    'list.noAddress': '(keine Adresse)',
    'list.noTenant': '(keine Mieterschaft)',
    'list.assignedTo': 'Zugewiesen an ',

    'new.title': 'Neues Protokoll',
    'new.type': 'Art des Protokolls',
    'new.property': 'Objekt',
    'new.address': 'Adresse',
    'new.addressPlaceholder': 'Strasse und Nummer',
    'new.city': 'Ort',
    'new.postalCode': 'PLZ',
    'new.unit': 'Wohnungs-Nr. / Stockwerk',
    'new.landlord': 'Vermieterschaft',
    'new.tenant': 'Mieterschaft',
    'new.name': 'Name',
    'new.email': 'E-Mail',
    'new.phone': 'Telefon',
    'new.assignTo': 'Zuweisen an',
    'new.assignMe': 'Mich',
    'new.assignHint': 'Wer die Abnahme durchführt. Kann später geändert werden.',
    'new.notes': 'Interne Notizen (optional)',
    'new.submit': 'Protokoll erstellen',
    'new.submitting': 'Wird erstellt…',
    'new.needType': 'Wählen Sie eine Protokollart.',
    'new.needAddress': 'Adresse erforderlich.',
    'new.needParties': 'Name von Vermieterschaft und Mieterschaft sind beide erforderlich.',
    'new.created': 'Protokoll erstellt.',
    'new.createdTitle': 'Protokoll erstellt',
    'new.idLabel': 'ID: ',
    'new.tenantLink': 'Link für die Mieterschaft (per E-Mail oder SMS weitergeben):',
    'new.tenantLinkNote': 'Dieser Link ist privat. Die Mieterschaft kann ihn ohne Google-Konto verwenden. Standardgültigkeit: 7 Tage.',
    'new.open': 'Protokoll öffnen',
    'new.copied': 'Kopiert',

    'inspection.fallbackTitle': 'Protokoll',
    'inspection.loading': 'Protokoll wird geladen…',
    'inspection.loadFailed': 'Protokoll konnte nicht geladen werden',
    'inspection.requiredCount': ' Pflichtfelder',
    'inspection.sections': 'Abschnitte',
    'inspection.unsaved': 'Nicht gespeichert',
    'inspection.unsavedHint': 'Auf diesem Gerät erfasst, aber noch nicht gespeichert. Öffnen Sie den Abschnitt, um es zu senden.',
    'inspection.awaitingTitle': 'Wartet auf Unterschriften',
    'inspection.awaitingBody': 'Das Protokoll ist zur Durchsicht gesperrt. Bearbeiten ist nicht möglich.',
    'inspection.signedTitle': 'Unterschrieben',
    'inspection.signedBody': 'Alle Unterschriften liegen vor.',
    'inspection.reviewLock': 'Prüfen & sperren',
    'inspection.completeMore': 'Noch {count} Pflichtfelder ausfüllen',
    'inspection.goSign': 'Zur Unterschrift',
    'inspection.viewReport': 'Schlussprotokoll ansehen',

    'section.notFound': 'Abschnitt nicht gefunden',
    'section.notFoundBody': 'Kein Abschnitt mit der ID «{id}».',
    'section.sections': 'Abschnitte',
    'section.next': 'Weiter: {title} →',
    'section.done': 'Abschnitt abschliessen',
    'section.conflict': 'Dieser Abschnitt wurde anderswo geändert. Öffnen Sie ihn neu, um die aktuellen Antworten zu sehen; Ihre Eingaben bleiben auf diesem Gerät gespeichert.',
    'section.saveFailed': 'Speichern fehlgeschlagen: {code} — {message}',
    'section.restored.one': '{count} Antwort von diesem Gerät war nicht gespeichert. Wiederhergestellt — wird jetzt gesendet.',
    'section.restored.other': '{count} Antworten von diesem Gerät waren nicht gespeichert. Wiederhergestellt — werden jetzt gesendet.',

    'review.title': 'Prüfen',
    'review.tenant': 'Mieterschaft: ',
    'review.landlord': 'Vermieterschaft: ',
    'review.requiredItems': 'Pflichtfelder',
    'review.missing.one': 'Noch {count} Position offen',
    'review.missing.other': 'Noch {count} Positionen offen',
    'review.photosRequired': ' (Fotos erforderlich)',
    'review.allComplete': 'Alle Pflichtfelder sind ausgefüllt.',
    'review.sectionSummary': 'Übersicht der Abschnitte',
    'review.sectionRequired': '{done}/{total} Pflichtfelder',
    'review.sectionFilled': '{done}/{total} ausgefüllt',
    'review.lock': 'Sperren & Unterschriften einholen',
    'review.locking': 'Wird gesperrt…',
    'review.lockTitle': 'Protokoll sperren?',
    'review.lockMessage': 'Nach dem Sperren sind keine Änderungen mehr möglich. Beide Parteien unterschreiben das Protokoll. Sie können es später wieder entsperren, falls Korrekturen nötig sind — dadurch werden alle Unterschriften ungültig.',
    'review.lockConfirm': 'Für Unterschrift sperren',
    'review.locked': 'Protokoll gesperrt. Bereit für die Unterschriften.',
    'review.stillMissingOne': 'Noch offen: {section} — {label}',
    'review.stillMissingMany': '{count} Pflichtfelder fehlen, oben aufgeführt.',

    'sign.title': 'Unterschreiben',
    'sign.signaturesTitle': 'Unterschriften',
    'sign.cannotTitle': 'Unterschrift nicht möglich',
    'sign.cannotBody': 'Keine gültige Rolle zum Unterschreiben.',
    'sign.alreadySigned': 'Sie haben unterschrieben. Wartet auf die Gegenpartei.',
    'sign.backToAdmin': 'Zurück zur Verwaltung',
    'sign.signingAs': 'Unterschrift als',
    'sign.signingAsFixed': 'Unterschrift als ',
    'sign.fullName': 'Vollständiger Name (in Druckschrift)',
    'sign.signature': 'Unterschrift',
    'sign.accept': 'Ich bestätige, dass der Inhalt dieses Protokolls zutrifft und dass ich die genannte unterzeichnende Person bin.',
    'sign.submit': 'Unterschrift übermitteln',
    'sign.submitting': 'Wird übermittelt…',
    'sign.needName': 'Name erforderlich.',
    'sign.needAccept': 'Sie müssen die Bestätigung akzeptieren.',
    'sign.needSignature': 'Bitte unterschreiben Sie im Feld.',
    'sign.saved': 'Unterschrift gespeichert.',
    'sign.failed': 'Die Unterschrift konnte nicht übermittelt werden',

    'final.offerTitle': 'Schlussprotokoll erstellen?',
    'final.offerMessage': 'Alle Unterschriften liegen vor. Das PDF jetzt erstellen? Das kann 30–60 Sekunden dauern.',
    'final.offerConfirm': 'PDF erstellen',
    'final.generating': 'PDF wird erstellt…',
    'final.ready': 'Schluss-PDF bereit.',
    'final.generated': 'Schluss-PDF erstellt.',
    'success.title': 'Protokoll abgeschlossen',
    'success.allSigned': 'Alle Unterschriften liegen vor',
    'success.openPdf': 'Schluss-PDF öffnen',
    'success.generate': 'Schluss-PDF erstellen',
    'success.generatingShort': 'Wird erstellt…',
    'success.waitForLandlord': 'Die Vermieterschaft schliesst das Protokoll in Kürze ab.',
    'success.backToList': 'Zurück zu den Protokollen',

    'detail.tenant': 'Mieterschaft: ',
    'detail.landlord': 'Vermieterschaft: ',
    'detail.created': 'Erstellt: ',
    'detail.createdBy': ' durch ',
    'detail.noEmail': 'keine E-Mail',
    'detail.unknown': 'unbekannt',
    'detail.assignedTo': 'Zugewiesen an: ',
    'detail.nobody': 'niemanden',
    'detail.openEditor': 'Editor öffnen',
    'detail.newTenantLink': 'Neuer Mieter-Link',
    'detail.unlock': 'Entsperren',
    'detail.unlockTitle': 'Protokoll entsperren?',
    'detail.unlockMessage': 'Dadurch werden alle erfassten Unterschriften ungültig. Der Link für die Mieterschaft muss neu verschickt werden.',
    'detail.unlocked': 'Entsperrt.',
    'detail.unlockReason': 'durch Administrator angefordert',

    'assign.title': 'Protokoll zuweisen',
    'assign.none': 'Keine aktiven Benutzer zum Zuweisen vorhanden.',
    'assign.who': 'Wer die Abnahme durchführt.',
    'assign.current': 'Aktuell',
    'assign.done': 'An {name} zugewiesen.',

    'tenantLink.title': 'Neuer Mieter-Link',
    'tenantLink.expires': 'Läuft ab: {when}',
    'tenantLink.previousInvalid': 'Hinweis: Frühere Links für die Mieterschaft sind jetzt ungültig.',
  },
};

/** Read by tests/i18n.test.js, which is the only reason it is exported. */
export { UI as _UI };
