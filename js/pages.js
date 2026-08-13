/**
 * pages.js
 * All page renderers. Each `pageX(ctx)` writes its content into #app-root.
 *
 * Pages:
 *  - pageHome              — landing / dispatcher based on auth
 *  - pageAdminList         — admin dashboard
 *  - pageAdminNew          — new inspection form
 *  - pageAdminDetail       — admin view of one inspection
 *  - pageInspectionHome    — sections list (tenant or admin entry into editing)
 *  - pageInspectionSection — single-section editor (the big one)
 *  - pageReview            — pre-lock review
 *  - pageSign              — signature collection
 *  - pageSuccess           — final confirmation with PDF link
 */

import { h, mount, debounce } from './utils/dom.js';
import { formatDate, formatDateTime, statusLabel, inspectionTypeLabel } from './utils/format.js';
import { api, ApiError, setAuth } from './api.js';
import { navigate, back } from './router.js';
import {
  appHeader, bottomBar, badge, progressBar, saveIndicator,
  questionCard, signatureCanvas
} from './components.js';
import { toastSuccess, toastError, toastWarning, confirm, openModal } from './ui.js';
import {
  getState, setState, setInspectionData, patchAnswer, isAdmin,
  setSectionRevision
} from './state.js';
import {
  buildAnswersMap, isItemVisible, sectionProgress,
  inspectionProgress, findAllMissingRequired
} from './validator.js';
import { AUTOSAVE_DEBOUNCE_MS } from './config.js';
import { readJson, writeJson, CACHE_KEYS } from './utils/store.js';
import { rememberDraft, forgetDraft, readDraft, draftSectionIds } from './utils/drafts.js';
import {
  track as trackSave, settled as savesSettled, outstanding as outstandingSaves,
} from './utils/pending-saves.js';
import * as thumbs from './utils/thumbs.js';
import * as inspectionCache from './utils/inspection-cache.js';
import { base64ToBlob, saveBlob } from './utils/download.js';
import {
  login as authLogin, setPassword as authSetPassword,
  signOut as authSignOut, suggestDeviceLabel, readLastRestore, storageUsable,
} from './auth.js';

const root = () => document.getElementById('app-root');


/**
 * Have the inspection on screen, from the device if it is there.
 *
 * Opening one was measured at 3 329 ms, of which about 2 900 is transport — the
 * /exec redirect, a body from another host, a cold script — against 448 ms of
 * server work. No amount of backend work gets this under three seconds. The
 * only way past it is to draw before asking.
 *
 * So: a remembered copy is drawn immediately and a fresh one is fetched behind
 * it. Nothing is *decided* from the remembered copy. Every write still goes to
 * the server, which re-reads the row — a save sends the revision it read and is
 * refused with CONFLICT if the section moved on, locking re-validates every
 * required item, signing and unlocking check the status. The machinery that
 * catches a stale screen was built before this and is not being invented to
 * excuse it.
 *
 * The one thing worth interrupting for is a status change. Answers arriving
 * quietly is fine; discovering that what you are about to edit has been locked,
 * or signed, is not — so that says so out loud and redraws.
 *
 * @returns true when there is something to draw, false when the caller has
 *          already been shown an error and should stop.
 */
async function ensureInspection(inspectionId, onRefreshed) {
  const held = getState().inspection;
  if (held && held.inspectionId === inspectionId) return true;

  const remembered = await inspectionCache.read(inspectionId);
  if (remembered && remembered.inspection) {
    setInspectionData(remembered);
    _revalidate(inspectionId, remembered.inspection.status, onRefreshed);
    return true;
  }

  showSpinner('Loading inspection…');
  try {
    const data = await api.getInspection(inspectionId);
    setInspectionData(data);
    inspectionCache.write(inspectionId, data);
    return true;
  } catch (e) {
    showError('Could not load inspection', e.message);
    return false;
  }
}

/** Fetch behind a screen that is already drawn, and correct it if it was wrong. */
function _revalidate(inspectionId, shownStatus, onRefreshed) {
  api.getInspection(inspectionId)
    .then((fresh) => {
      inspectionCache.write(inspectionId, fresh);
      // Only if the person is still looking at this inspection. They may have
      // gone back to the list, or into another one, in the seconds this took.
      const current = getState().inspection;
      if (!current || current.inspectionId !== inspectionId) return;

      // And only if nothing is outstanding. setInspectionData replaces the
      // answers wholesale, so applying a reply that left the server before
      // someone started typing would overwrite what they typed — with an older
      // copy, silently, while they were looking at it. The cache is still
      // updated above; the screen picks it up the next time it opens clean.
      if (draftSectionIds(inspectionId).length > 0 || outstandingSaves() > 0) return;

      setInspectionData(fresh);
      if (onRefreshed) onRefreshed(fresh);

      if (fresh.inspection && fresh.inspection.status !== shownStatus) {
        // Said out loud because it changes what may be done here, and the
        // screen was drawn on the old answer a moment ago.
        toastWarning(`This inspection is now ${statusLabel(fresh.inspection.status)}.`);
      }
    })
    .catch(() => {
      // Left as it is. The screen shows the last thing the server said, which
      // is the best available answer when the server cannot be reached — and
      // every write from here still has to get past it.
    });
}

/**
 * Put the inspection a mutation just changed back into state.
 *
 * Locking, unlocking, signing, finalising, assigning and creating all change
 * what these screens show, so each was followed by getInspection to redraw
 * from. That second call costs two to four seconds here — an Apps Script /exec
 * answers 302 and serves the body from another host, so one call is two HTTP
 * round trips and a fresh execution — all to fetch what the server had just
 * finished writing.
 *
 * The server now attaches it as `state`. The fetch is kept as a fallback and
 * is not dead code: the server drops the attachment rather than fail a write
 * that already succeeded, and a browser running against an older deployment
 * will not be sent one at all.
 */
async function applyMutationState(result, inspectionId) {
  const data = (result && result.state) || await api.getInspection(inspectionId);
  setInspectionData(data);
  // Remembered too, so the next open draws the inspection as it is now rather
  // than as it was before it was locked, signed or reassigned.
  inspectionCache.write(inspectionId, data);
  return data;
}

// ============================================================
// pageHome — entry routing
// ============================================================

export function pageHome() {
  const state = getState();

  if (state.authMode === 'tenant') {
    navigate('/inspection/' + state.tenantInspectionId, true);
    return;
  }

  if (state.authMode === 'user') {
    navigate('/admin', true);
    return;
  }

  // Not signed in
  navigate('/login', true);
}

// ============================================================
// Sign-in
// ============================================================

/** Shared shell for the four screens that render before anyone is signed in. */
/**
 * The signed-out screens: sign in, set password, forgot password.
 *
 * The logo sits here rather than on each of them, so someone arriving from a
 * mailed link lands on something that identifies itself before it asks for a
 * password. Width and height are set to stop the card jumping down the page
 * when the image loads.
 */
function authShell(title, ...children) {
  return h('div', { class: 'app-layout' },
    appHeader({ title }),
    h('main', { class: 'app-body' },
      h('div', { class: 'page' },
        h('div', { class: 'auth-logo' },
          h('img', {
            src: './assets/logo/cpmh-real-estate.svg',
            alt: 'CPMH Real Estate',
            width: 260,
            height: 95,
          })),
        ...children)
    )
  );
}

function formField(label, attrs, hint) {
  return h('div', { class: 'form-group' },
    h('label', { class: 'form-label' }, label),
    h('input', Object.assign({ class: 'form-input' }, attrs)),
    hint ? h('p', { class: 'form-hint text-xs text-muted' }, hint) : null,
  );
}

/**
 * One line saying why this screen is being shown, from what the last boot
 * recorded. Absent when the app has nothing to explain.
 *
 * It exists because the place this goes wrong is a phone, and a phone has no
 * console: an iPhone that signed in four times in eighty seconds looks the same
 * from the outside whether the saved sign-in was thrown away by the app,
 * refused by the server, or never written to storage in the first place — and
 * those are three different faults.
 */
function lastRestoreNote() {
  // Asked first, and not from the record: a device that cannot store anything
  // cannot store the note saying so either, so this is the one case history
  // could never report on itself.
  if (!storageUsable()) {
    return h('p', { class: 'text-xs text-muted mt-3' },
      'This device is not saving data, so it cannot stay signed in. ' +
      'Private browsing or full storage will do that.');
  }

  const last = readLastRestore();
  if (!last) return null;

  const text =
    last.outcome === 'empty'
      ? (last.detail === 'device_token_did_not_persist'
          ? 'This device could not save your sign-in — storage is unavailable or full.'
          : 'No saved sign-in was found on this device.')
    : last.outcome === 'refused'
      ? 'The saved sign-in was refused. It may have been revoked, or a password was changed.'
    : last.outcome === 'unreachable'
      ? 'The server could not be reached. Your saved sign-in is still on this device.'
    : last.outcome === 'signed_in' && last.detail === 'device_token_did_not_persist'
      ? 'This device could not save your sign-in — storage is unavailable or full.'
    : last.outcome === 'signed_in' && !last.hadDevice
      ? 'The last sign-in was not remembered on this device.'
      : null;

  if (!text) return null;
  return h('p', { class: 'text-xs text-muted mt-3' }, text);
}

export function pageLogin() {
  // Already signed in. An iPhone home-screen icon opens the URL it was created
  // from, so one added while this screen was showing comes back here every
  // launch — and the form would ask for a password the app does not need.
  if (getState().authMode === 'user') {
    navigate('/admin', true);
    return;
  }

  let email = '';
  let password = '';
  let remember = true;
  let busy = false;
  let error = null;

  async function submit(e) {
    if (e) e.preventDefault();
    if (!email.trim() || !password) {
      error = 'Enter your email address and password.';
      render();
      return;
    }
    busy = true; error = null; render();
    try {
      const user = await authLogin({
        email: email.trim(),
        password,
        remember,
        deviceLabel: suggestDeviceLabel(),
      });
      toastSuccess(`Signed in as ${user.name}.`);
      navigate('/admin');
    } catch (err) {
      // The server answers identically for an unknown address, a wrong
      // password and a disabled account, so that the form cannot be used to
      // find out who works here. Passing its message straight through keeps
      // that property intact.
      error = err.message || 'Sign-in failed.';
      password = '';
      busy = false;
      render();
    }
  }

  function render() {
    const state = getState();
    mount(root(), authShell('Sign in',
      h('form', { class: 'card', onSubmit: submit },
        h('h2', { class: 'card__title' }, 'Sign in'),
        h('p', { class: 'text-muted text-sm mt-2' },
          'Use the email address your account was created with.'),

        error || state.authError
          ? h('div', { class: 'banner banner--danger mt-3' },
              h('div', { class: 'banner__icon' }, '!'),
              h('div', { class: 'banner__body' }, error || state.authError))
          : null,

        h('div', { class: 'mt-4' },
          formField('Email', {
            type: 'email',
            autocomplete: 'username',
            inputmode: 'email',
            value: email,
            autofocus: true,
            onInput: (e) => { email = e.target.value; },
          }),
          formField('Password', {
            type: 'password',
            autocomplete: 'current-password',
            onInput: (e) => { password = e.target.value; },
          }),
        ),

        h('label', { class: 'form-check' },
          h('input', {
            type: 'checkbox',
            checked: remember,
            onChange: (e) => { remember = e.target.checked; },
          }),
          h('span', null, 'Remember this device'),
        ),

        h('button', {
          type: 'submit',
          class: 'btn btn--primary btn--block mt-4',
          disabled: busy || undefined,
        }, busy ? 'Signing in…' : 'Sign in'),

        h('p', { class: 'text-sm mt-4', style: { textAlign: 'center' } },
          h('a', { href: '#/forgot-password' }, 'Forgot your password?')),

        h('hr', { style: { border: 'none', borderTop: '1px solid var(--color-border)', margin: '1.5rem 0' }}),
        h('p', { class: 'text-xs text-muted' },
          'Tenants do not sign in — they receive a direct link for their inspection.'),
        lastRestoreNote(),
      )
    ));
  }
  render();
}

// ============================================================
// pageSetPassword — arrived here from a link in an email
// ============================================================

export function pageSetPassword(ctx) {
  const token = (ctx && ctx.query && ctx.query.k) || '';
  let password = '';
  let confirmValue = '';
  let remember = true;
  let busy = false;
  let error = null;

  async function submit(e) {
    if (e) e.preventDefault();
    if (password !== confirmValue) {
      error = 'The two passwords do not match.';
      render();
      return;
    }
    busy = true; error = null; render();
    try {
      const user = await authSetPassword({
        token, password, remember, deviceLabel: suggestDeviceLabel(),
      });
      toastSuccess(`Welcome, ${user.name}.`);
      navigate('/admin');
    } catch (err) {
      // Length and common-padding rules are enforced on the server, so its
      // wording is the authoritative one. Repeating the rules here would mean
      // two places to keep in step, and the client copy losing.
      error = err.message || 'Could not set the password.';
      busy = false;
      render();
    }
  }

  function render() {
    if (!token) {
      mount(root(), authShell('Set password',
        h('div', { class: 'card' },
          h('h2', { class: 'card__title' }, 'This link is incomplete'),
          h('p', { class: 'text-muted text-sm mt-2' },
            'Open the link from your email exactly as it was sent, or ask for a new one.'),
          h('a', { class: 'btn btn--secondary btn--block mt-4', href: '#/forgot-password' },
            'Send me a new link'),
        )
      ));
      return;
    }

    mount(root(), authShell('Set password',
      h('form', { class: 'card', onSubmit: submit },
        h('h2', { class: 'card__title' }, 'Choose your password'),
        h('p', { class: 'text-muted text-sm mt-2' },
          'Four unrelated words make a password that is easy to remember and ' +
          'hard to guess — far better than a short one with symbols in it.'),

        error
          ? h('div', { class: 'banner banner--danger mt-3' },
              h('div', { class: 'banner__icon' }, '!'),
              h('div', { class: 'banner__body' }, error))
          : null,

        h('div', { class: 'mt-4' },
          formField('New password', {
            type: 'password',
            autocomplete: 'new-password',
            autofocus: true,
            onInput: (e) => { password = e.target.value; },
          }, 'At least 16 characters.'),
          formField('Repeat password', {
            type: 'password',
            autocomplete: 'new-password',
            onInput: (e) => { confirmValue = e.target.value; },
          }),
        ),

        h('label', { class: 'form-check' },
          h('input', {
            type: 'checkbox',
            checked: remember,
            onChange: (e) => { remember = e.target.checked; },
          }),
          h('span', null, 'Remember this device'),
        ),

        h('button', {
          type: 'submit',
          class: 'btn btn--primary btn--block mt-4',
          disabled: busy || undefined,
        }, busy ? 'Saving…' : 'Set password and sign in'),

        h('p', { class: 'text-xs text-muted mt-3' },
          'Any device already signed in to this account will be signed out.'),
      )
    ));
  }
  render();
}

// ============================================================
// pageForgotPassword
// ============================================================

export function pageForgotPassword() {
  let email = '';
  let busy = false;
  let sent = false;
  let error = null;

  async function submit(e) {
    if (e) e.preventDefault();
    busy = true; error = null; render();
    try {
      await api.requestPasswordReset(email.trim());
      sent = true;
    } catch (err) {
      error = err.message || 'Could not send the link.';
    } finally {
      busy = false;
      render();
    }
  }

  function render() {
    mount(root(), authShell('Password reset',
      sent
        ? h('div', { class: 'card' },
            h('h2', { class: 'card__title' }, 'Check your inbox'),
            // Deliberately not "we sent you an email": the server answers the
            // same way whether or not the address has an account, and saying
            // more here would give away what it withholds.
            h('p', { class: 'text-muted text-sm mt-2' },
              'If that address belongs to an account, a link is on its way. ' +
              'It is valid for 48 hours and can be used once.'),
            h('a', { class: 'btn btn--secondary btn--block mt-4', href: '#/login' },
              'Back to sign in'))
        : h('form', { class: 'card', onSubmit: submit },
            h('h2', { class: 'card__title' }, 'Send a reset link'),
            h('p', { class: 'text-muted text-sm mt-2' },
              'We will email you a link on which you can choose a new password.'),
            error
              ? h('div', { class: 'banner banner--danger mt-3' },
                  h('div', { class: 'banner__icon' }, '!'),
                  h('div', { class: 'banner__body' }, error))
              : null,
            h('div', { class: 'mt-4' },
              formField('Email', {
                type: 'email',
                autocomplete: 'username',
                inputmode: 'email',
                autofocus: true,
                onInput: (e) => { email = e.target.value; },
              })),
            h('button', {
              type: 'submit',
              class: 'btn btn--primary btn--block mt-4',
              disabled: busy || undefined,
            }, busy ? 'Sending…' : 'Send link'),
            h('p', { class: 'text-sm mt-4', style: { textAlign: 'center' } },
              h('a', { href: '#/login' }, 'Back to sign in')),
          )
    ));
  }
  render();
}

// ============================================================
// pageProfile — own account
// ============================================================

export function pageProfile() {
  let oldPassword = '';
  let newPassword = '';
  let confirmValue = '';
  let busy = false;
  let error = null;

  async function submit(e) {
    if (e) e.preventDefault();
    if (newPassword !== confirmValue) {
      error = 'The two new passwords do not match.';
      render();
      return;
    }
    busy = true; error = null; render();
    try {
      await api.changePassword(oldPassword, newPassword);
      // Changing a password revokes every device, this one included. Signing
      // out locally keeps the app honest about that rather than leaving it
      // holding a token the server has already stopped accepting.
      await authSignOut();
      toastSuccess('Password changed. Please sign in again.');
      navigate('/login');
    } catch (err) {
      error = err.message || 'Could not change the password.';
      busy = false;
      render();
    }
  }

  function render() {
    const user = getState().user || {};
    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({ title: 'My account', onBack: () => navigate('/admin') }),
        h('main', { class: 'app-body' },
          h('div', { class: 'page' },
            h('div', { class: 'card' },
              h('h2', { class: 'card__title' }, user.name || ''),
              h('p', { class: 'text-muted text-sm mt-1' }, user.email || ''),
              h('p', { class: 'text-sm mt-3' },
                h('span', { class: 'badge' }, user.role === 'admin' ? 'Admin' : 'Inspector')),
            ),

            h('form', { class: 'card mt-4', onSubmit: submit },
              h('h2', { class: 'card__title' }, 'Change password'),
              h('p', { class: 'text-muted text-sm mt-2' },
                'All signed-in devices will be signed out, including this one.'),
              error
                ? h('div', { class: 'banner banner--danger mt-3' },
                    h('div', { class: 'banner__icon' }, '!'),
                    h('div', { class: 'banner__body' }, error))
                : null,
              h('div', { class: 'mt-4' },
                formField('Current password', {
                  type: 'password',
                  autocomplete: 'current-password',
                  onInput: (e) => { oldPassword = e.target.value; },
                }),
                formField('New password', {
                  type: 'password',
                  autocomplete: 'new-password',
                  onInput: (e) => { newPassword = e.target.value; },
                }, 'At least 16 characters.'),
                formField('Repeat new password', {
                  type: 'password',
                  autocomplete: 'new-password',
                  onInput: (e) => { confirmValue = e.target.value; },
                }),
              ),
              h('button', {
                type: 'submit',
                class: 'btn btn--primary btn--block mt-2',
                disabled: busy || undefined,
              }, busy ? 'Saving…' : 'Change password'),
            ),
          )
        )
      )
    );
  }
  render();
}

// ============================================================
// pageAdminUsers — account administration
// ============================================================

export function pageAdminUsers() {
  let users = [];
  let activeAdmins = 0;
  let loading = true;
  let error = null;
  let search = '';
  let filter = 'all';

  const FILTERS = [
    ['all', 'All'],
    ['active', 'Active'],
    ['disabled', 'Disabled'],
    ['admin', 'Admins'],
    ['nopassword', 'No password yet'],
    ['locked', 'Locked'],
  ];

  async function load() {
    loading = true; render();
    try {
      const res = await api.listUsers();
      users = res.users || [];
      activeAdmins = res.activeAdmins || 0;
      error = null;
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
      render();
    }
  }

  /** Wrap a mutation so every one of them reports and reloads the same way. */
  async function act(fn, successMessage) {
    try {
      const result = await fn();
      if (successMessage) toastSuccess(successMessage);
      await load();
      return result;
    } catch (e) {
      // Guardrail refusals (last admin, own account) arrive as FORBIDDEN with a
      // message written for a person. Showing it verbatim is the whole point.
      toastError(e.message);
      return null;
    }
  }

  function visibleUsers() {
    const q = search.trim().toLowerCase();
    return users.filter(u => {
      if (q && String(u.name).toLowerCase().indexOf(q) < 0
            && String(u.email).toLowerCase().indexOf(q) < 0) return false;
      if (filter === 'active') return u.status === 'active';
      if (filter === 'disabled') return u.status === 'disabled';
      if (filter === 'admin') return u.role === 'admin';
      if (filter === 'nopassword') return !u.hasPassword;
      if (filter === 'locked') return !!u.lockedUntil;
      return true;
    });
  }

  // --- Badges ---

  function userBadges(u) {
    const out = [];
    out.push(h('span', { class: ['badge', u.role === 'admin' ? 'badge--info' : ''] },
      u.role === 'admin' ? 'Admin' : 'Inspector'));
    if (u.status === 'disabled') {
      out.push(h('span', { class: 'badge badge--danger' }, 'Disabled'));
    }
    if (u.lockedUntil) {
      out.push(h('span', { class: 'badge badge--warning' }, 'Locked'));
    }
    // Derived rather than stored: a third status would be a third state to
    // keep consistent, and this says the same thing.
    if (!u.hasPassword) {
      out.push(h('span', { class: 'badge badge--warning' }, 'No password yet'));
    }
    return out;
  }

  // --- Add user ---

  function openAddUser() {
    let name = '', email = '', role = 'inspector';
    let busy = false;

    const errorSlot = h('div');
    const body = h('div', null,
      formField('Name', { autofocus: true, onInput: (e) => { name = e.target.value; } }),
      formField('Email', {
        type: 'email', inputmode: 'email',
        onInput: (e) => { email = e.target.value; },
      }),
      h('div', { class: 'form-group' },
        h('label', { class: 'form-label' }, 'Role'),
        h('select', {
          class: 'form-select',
          onChange: (e) => { role = e.target.value; },
        },
          h('option', { value: 'inspector' }, 'Inspector'),
          h('option', { value: 'admin' }, 'Admin'),
        ),
      ),
      h('p', { class: 'text-xs text-muted' },
        'They will receive a link to choose their own password. No password is ' +
        'ever sent by email.'),
      errorSlot,
    );

    const submitBtn = h('button', { class: 'btn btn--primary', onClick: submit }, 'Add user');
    const modal = openModal({
      title: 'Add user',
      body,
      footer: [
        h('button', { class: 'btn btn--secondary', onClick: () => modal.close() }, 'Cancel'),
        submitBtn,
      ],
    });

    async function submit() {
      if (busy) return;
      busy = true;
      submitBtn.textContent = 'Adding…';
      submitBtn.setAttribute('disabled', '');
      try {
        const res = await api.createUser(name.trim(), email.trim(), role);
        modal.close();
        await load();
        // Creating the account and delivering the link are separate things,
        // and only one of them can fail. Saying which is what lets the admin
        // act: resend, or hand the link over another way.
        if (res.delivery && res.delivery.emailed) {
          toastSuccess(`${res.user.name} added. Link sent to ${res.user.email}.`);
        } else {
          showLinkFallback(res.user, res.delivery);
        }
      } catch (e) {
        busy = false;
        submitBtn.textContent = 'Add user';
        submitBtn.removeAttribute('disabled');
        mount(errorSlot, h('div', { class: 'banner banner--danger mt-3' },
          h('div', { class: 'banner__icon' }, '!'),
          h('div', { class: 'banner__body' }, e.message)));
      }
    }
  }

  /** Mail failed — offer the link itself rather than leaving the admin stuck. */
  function showLinkFallback(user, delivery) {
    const field = h('textarea', {
      class: 'form-textarea text-mono text-xs',
      rows: '4',
      readonly: true,
    }, (delivery && delivery.url) || '');

    const modal = openModal({
      title: 'Email could not be sent',
      body: h('div', null,
        h('p', { class: 'text-sm' },
          `The account for ${user.email} exists and is ready. Only the email ` +
          'failed, so pass this link on yourself:'),
        h('div', { class: 'form-group mt-3' }, field),
        delivery && delivery.error
          ? h('p', { class: 'text-xs text-muted' }, delivery.error)
          : null,
      ),
      footer: [
        h('button', {
          class: 'btn btn--secondary',
          onClick: () => {
            field.select();
            try { document.execCommand('copy'); toastSuccess('Link copied.'); }
            catch (_) { toastWarning('Copy it manually.'); }
          },
        }, 'Copy link'),
        h('button', { class: 'btn btn--primary', onClick: () => modal.close() }, 'Done'),
      ],
    });
  }

  // --- One user ---

  function openUser(u) {
    const me = getState().user || {};
    const isSelf = !!me.userId && me.userId === u.userId;
    const isLastAdmin = u.role === 'admin' && u.status === 'active' && activeAdmins <= 1;

    // Explaining why a button is missing beats silently omitting it — the admin
    // is otherwise left wondering whether the screen is broken.
    function guard(reason) {
      return reason ? h('p', { class: 'text-xs text-muted mt-1' }, reason) : null;
    }

    const modal = openModal({
      title: u.name,
      body: h('div', null,
        h('p', { class: 'text-muted text-sm' }, u.email),
        h('div', { class: 'badge-row mt-2' }, userBadges(u)),

        h('dl', { class: 'detail-list mt-4' },
          detailRow('Last sign-in', u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never'),
          detailRow('Active devices', String(u.deviceCount || 0)),
          detailRow('Created', u.createdAt ? formatDateTime(u.createdAt) : '—'),
          u.createdBy ? detailRow('Created by', u.createdBy) : null,
          u.status === 'disabled' && u.disabledAt
            ? detailRow('Disabled', `${formatDateTime(u.disabledAt)} by ${u.disabledBy || '—'}`)
            : null,
          u.lockedUntil ? detailRow('Locked until', formatDateTime(u.lockedUntil)) : null,
        ),

        h('div', { class: 'mt-4' },
          h('h3', { class: 'text-sm text-muted' }, 'Actions'),

          h('div', { class: 'stack mt-2' },
            // Status
            u.status === 'active'
              ? h('div', null,
                  h('button', {
                    class: 'btn btn--danger btn--block',
                    disabled: (isSelf || isLastAdmin) || undefined,
                    onClick: () => confirmAnd(modal,
                      'Disable access?',
                      `${u.name} will be signed out of every device immediately and ` +
                      'will not be able to sign in again.',
                      'Disable', true,
                      () => api.setUserStatus(u.userId, 'disabled'),
                      `${u.name} no longer has access.`),
                  }, 'Disable access'),
                  guard(isSelf ? 'You cannot disable your own account.'
                    : isLastAdmin ? 'This is the only active administrator.' : null))
              : h('button', {
                  class: 'btn btn--primary btn--block',
                  onClick: () => confirmAnd(modal,
                    'Restore access?',
                    `${u.name} will be able to sign in again. Their old devices stay ` +
                    'signed out — they will sign in fresh.',
                    'Restore', false,
                    () => api.setUserStatus(u.userId, 'active'),
                    `${u.name} has access again.`),
                }, 'Restore access'),

            // Role
            u.role === 'admin'
              ? h('div', null,
                  h('button', {
                    class: 'btn btn--secondary btn--block',
                    disabled: (isSelf || isLastAdmin) || undefined,
                    onClick: () => confirmAnd(modal,
                      'Remove admin rights?',
                      `${u.name} will keep their account but lose access to account ` +
                      'administration.',
                      'Remove', false,
                      () => api.setUserRole(u.userId, 'inspector'),
                      `${u.name} is now an inspector.`),
                  }, 'Remove admin rights'),
                  guard(isSelf ? 'You cannot remove your own admin rights.'
                    : isLastAdmin ? 'Promote someone else first.' : null))
              : h('button', {
                  class: 'btn btn--secondary btn--block',
                  onClick: () => confirmAnd(modal,
                    'Grant admin rights?',
                    `${u.name} will be able to add and disable users, and grant admin ` +
                    'rights to others.',
                    'Grant', false,
                    () => api.setUserRole(u.userId, 'admin'),
                    `${u.name} is now an admin.`),
                }, 'Grant admin rights'),

            u.lockedUntil
              ? h('button', {
                  class: 'btn btn--secondary btn--block',
                  onClick: () => { modal.close(); act(() => api.unlockUser(u.userId), 'Account unlocked.'); },
                }, 'Unlock account')
              : null,

            u.status === 'active'
              ? h('button', {
                  class: 'btn btn--secondary btn--block',
                  onClick: async () => {
                    modal.close();
                    const res = await act(() => api.sendPasswordLink(u.userId), null);
                    if (!res) return;
                    if (res.delivery && res.delivery.emailed) toastSuccess(`Link sent to ${u.email}.`);
                    else showLinkFallback(u, res.delivery);
                  },
                }, u.hasPassword ? 'Send a password reset link' : 'Resend the invitation link')
              : null,

            u.deviceCount > 0
              ? h('button', {
                  class: 'btn btn--secondary btn--block',
                  onClick: () => { modal.close(); openDevices(u); },
                }, `Devices (${u.deviceCount})`)
              : null,

            h('button', {
              class: 'btn btn--ghost btn--block',
              onClick: () => { modal.close(); openHistory(u); },
            }, 'History'),
          )
        )
      ),
      footer: [h('button', { class: 'btn btn--secondary', onClick: () => modal.close() }, 'Close')],
    });
  }

  async function confirmAnd(modal, title, message, confirmLabel, danger, fn, success) {
    modal.close();
    const ok = await confirm({ title, message, confirmLabel, danger });
    if (!ok) return;
    await act(fn, success);
  }

  function openDevices(u) {
    const slot = h('div', null, h('div', { class: 'boot-spinner' }));
    const modal = openModal({
      title: `${u.name} — devices`,
      body: slot,
      footer: [h('button', { class: 'btn btn--secondary', onClick: () => modal.close() }, 'Close')],
    });

    api.listUserDevices(u.userId).then(res => {
      const devices = res.devices || [];
      mount(slot,
        devices.length === 0
          ? h('p', { class: 'text-muted text-sm' }, 'No devices are signed in.')
          : h('ul', { class: 'list' },
              devices.map(d => h('li', { class: 'list-item' },
                h('div', { class: 'list-item__main' },
                  h('div', { class: 'list-item__title' }, d.label),
                  h('div', { class: 'list-item__meta' },
                    `Last used ${formatDateTime(d.lastSeenAt)} · expires ${formatDate(d.expiresAt)}`),
                ),
                h('button', {
                  class: 'btn btn--sm btn--danger',
                  onClick: async () => {
                    modal.close();
                    await act(() => api.revokeDevice(d.deviceId), 'Device signed out.');
                  },
                }, 'Sign out'),
              ))),
        devices.length > 1
          ? h('button', {
              class: 'btn btn--danger btn--block mt-4',
              onClick: async () => {
                modal.close();
                await act(() => api.revokeAllDevices(u.userId), 'All devices signed out.');
              },
            }, 'Sign out all devices')
          : null,
      );
    }).catch(e => {
      mount(slot, h('div', { class: 'banner banner--danger' }, e.message));
    });
  }

  function openHistory(u) {
    const slot = h('div', null, h('div', { class: 'boot-spinner' }));
    const modal = openModal({
      title: `${u.name} — history`,
      body: slot,
      footer: [h('button', { class: 'btn btn--secondary', onClick: () => modal.close() }, 'Close')],
    });

    api.getAuthLog(u.userId, 100).then(res => {
      const events = res.events || [];
      mount(slot,
        events.length === 0
          ? h('p', { class: 'text-muted text-sm' }, 'Nothing recorded yet.')
          : h('ul', { class: 'list' },
              events.map(e => h('li', { class: 'list-item' },
                h('div', { class: 'list-item__main' },
                  h('div', { class: 'list-item__title' }, humanEvent(e.eventType)),
                  h('div', { class: 'list-item__meta' },
                    `${formatDateTime(e.timestamp)} · ${e.actor}`),
                )))));
    }).catch(e => {
      mount(slot, h('div', { class: 'banner banner--danger' }, e.message));
    });
  }

  function render() {
    const list = visibleUsers();
    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({
          title: 'Users',
          subtitle: `${activeAdmins} active admin${activeAdmins === 1 ? '' : 's'}`,
          onBack: () => navigate('/admin'),
          actions: [
            h('button', {
              class: 'btn btn--sm btn--ghost',
              style: { color: 'white' },
              onClick: openAddUser,
            }, '+ Add'),
          ],
        }),
        h('main', { class: 'app-body' },
          h('div', { class: 'page' },
            h('div', { class: 'filter-bar' },
              h('input', {
                class: 'form-input',
                type: 'search',
                placeholder: 'Search name or email',
                value: search,
                onInput: (e) => { search = e.target.value; renderList(); },
              }),
              h('div', { class: 'chip-row mt-2' },
                FILTERS.map(([key, label]) => h('button', {
                  class: ['chip', filter === key ? 'chip--active' : ''],
                  onClick: () => { filter = key; render(); },
                }, label))),
            ),
            listSlot(list),
          )
        )
      )
    );
  }

  // Re-rendering the whole page on every keystroke would move focus out of the
  // search box, so typing only replaces the list.
  let _listSlot = null;
  function listSlot(list) {
    _listSlot = h('div', { class: 'mt-3' });
    fillList(_listSlot, list);
    return _listSlot;
  }
  function renderList() {
    if (_listSlot) fillList(_listSlot, visibleUsers());
  }

  function fillList(slot, list) {
    if (loading) {
      mount(slot, h('div', { class: 'empty-state' }, h('div', { class: 'boot-spinner' })));
      return;
    }
    if (error) {
      mount(slot, h('div', { class: 'banner banner--danger' }, error));
      return;
    }
    if (list.length === 0) {
      mount(slot, h('div', { class: 'empty-state' },
        h('div', { class: 'empty-state__icon' }, '○'),
        h('h2', { class: 'empty-state__title' }, 'No users match'),
        h('p', { class: 'empty-state__description' }, 'Try a different search or filter.')));
      return;
    }
    mount(slot, h('ul', { class: 'list' },
      list.map(u => h('li', {
        class: 'list-item list-item--clickable',
        onClick: () => openUser(u),
      },
        h('div', { class: 'list-item__main' },
          h('div', { class: 'list-item__title' }, u.name),
          h('div', { class: 'list-item__meta' }, u.email),
          h('div', { class: 'badge-row mt-1' }, userBadges(u)),
          h('div', { class: 'list-item__meta mt-1' },
            u.lastLoginAt ? `Last sign-in ${formatDateTime(u.lastLoginAt)}` : 'Never signed in',
            u.deviceCount ? ` · ${u.deviceCount} device${u.deviceCount === 1 ? '' : 's'}` : ''),
        ),
        h('span', { class: 'list-item__chevron' }, '›'),
      ))));
  }

  render();
  load();
}

function detailRow(label, value) {
  return h('div', { class: 'detail-row' },
    h('dt', { class: 'detail-row__label' }, label),
    h('dd', { class: 'detail-row__value' }, value),
  );
}

const EVENT_LABELS = {
  login_succeeded: 'Signed in',
  login_failed: 'Failed sign-in',
  account_locked: 'Account locked',
  account_unlocked: 'Account unlocked',
  password_set: 'Password set',
  password_changed: 'Password changed',
  password_reset: 'Password reset',
  password_reset_sent: 'Reset link sent',
  user_created: 'Account created',
  user_disabled: 'Access disabled',
  user_enabled: 'Access restored',
  role_granted: 'Admin rights granted',
  role_revoked: 'Admin rights removed',
  // Kept for rows already in the sheet. Signing in no longer writes it — it
  // fired on exactly the same occasions as login_succeeded, which now carries
  // the device label itself.
  device_registered: 'Device registered',
  device_revoked: 'Device signed out',
};

function humanEvent(type) {
  return EVENT_LABELS[type] || type;
}

// ============================================================
// pageAdminList
// ============================================================

/**
 * How long the remembered list is trusted without asking the server.
 *
 * Showing the cached list instantly but still fetching on every arrival was
 * only half a fix: the request went out each time the screen was opened, which
 * on this backend is a second or two of work to confirm that nothing had
 * changed since the user left it a moment earlier.
 *
 * Within this window the screen opens with no request at all. Outside it, the
 * cached rows are shown immediately and refreshed behind them. Anything that
 * actually changes the list clears the stamp, so a new or reassigned
 * inspection appears at once rather than after the window expires.
 */
const LIST_FRESH_MS = 60 * 1000;

function readCachedList() {
  const cached = readJson(CACHE_KEYS.inspectionList);
  // An array is the older shape, from before staleness was tracked. Usable for
  // display, but treated as expired so it gets replaced on first use.
  if (Array.isArray(cached)) return { rows: cached, fetchedAt: 0 };
  return cached && Array.isArray(cached.rows) ? cached : null;
}

/** Called wherever something changes what the list should say. */
function invalidateCachedList() {
  writeJson(CACHE_KEYS.inspectionList, null);
}

/**
 * What the New Inspection form needs, fetched before it is asked for.
 *
 * A request costs about three seconds here whatever it asks — /exec answers
 * 302, the body comes from another host, and every call is its own execution
 * with its own cold start. Measured, opening + New was 3 847 ms of which 2 489
 * was exactly that, for two short lists that change perhaps monthly.
 *
 * The list screen is where someone reads before deciding, so it is a stretch of
 * idle network. Warming it there means the form has its options by the time it
 * is opened, and it is not wasted when they never press the button: the same
 * two lists are what the form would have asked for on any later visit too.
 *
 * A promise rather than the resolved value, so a click landing mid-flight
 * awaits the request already running instead of starting a second one.
 */
let newInspectionOptions = null;

function prefetchNewInspectionOptions() {
  if (newInspectionOptions) return;
  // The rejection is swallowed here and re-observed by whoever awaits it.
  // Without this, a failed prefetch nobody is waiting on yet is an unhandled
  // rejection in the console — noise that looks like a bug and is not one.
  newInspectionOptions = api.getNewInspectionOptions();
  newInspectionOptions.catch(() => {});
}

/** The warmed options, or a fresh request when there are none to reuse. */
function takeNewInspectionOptions() {
  const pending = newInspectionOptions || api.getNewInspectionOptions();
  // Dropped either way: a form opened twice should see a second answer, and a
  // failed one must not be handed out again.
  newInspectionOptions = null;
  return pending;
}

export function pageAdminList() {
  const remembered = readCachedList();
  let inspections = remembered ? remembered.rows : [];
  let loading = !remembered;
  let error = null;
  let filter = { status: [], search: '' };

  const isFresh = !!remembered && (Date.now() - remembered.fetchedAt) < LIST_FRESH_MS;

  async function load() {
    // Only show the spinner when there is nothing to show instead. Replacing a
    // usable list with a spinner is a step backwards, however briefly.
    if (inspections.length === 0) { loading = true; render(); }
    try {
      const res = await api.listInspections(filter, 0, 100, 'updatedAt', 'desc');
      inspections = res.inspections || [];
      // Only the unfiltered list is worth remembering: a filtered one would
      // reopen looking like the whole set while showing a subset.
      if (!filter.search && (!filter.status || filter.status.length === 0)) {
        writeJson(CACHE_KEYS.inspectionList, {
          rows: inspections,
          fetchedAt: Date.now(),
        });
      }
      error = null;
    } catch (e) {
      // A failed refresh must not wipe a list that is already readable.
      if (inspections.length === 0) error = e.message;
      else toastWarning('Could not refresh the list.');
    } finally {
      loading = false;
      render();
    }
  }

  function render() {
    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({
          title: 'Inspections',
          subtitle: (getState().user && getState().user.name) || '',
          actions: [
            h('button', {
              class: 'btn btn--sm btn--ghost',
              style: { color: 'white' },
              onClick: () => navigate('/admin/new'),
            }, '+ New'),
            h('button', {
              class: 'btn btn--sm btn--ghost',
              style: { color: 'white' },
              title: 'Refresh',
              onClick: () => { invalidateCachedList(); load(); },
            }, '⟳'),
            isAdmin()
              ? h('button', {
                  class: 'btn btn--sm btn--ghost',
                  style: { color: 'white' },
                  title: 'Users',
                  onClick: () => navigate('/admin/users'),
                }, '👥')
              : null,
            h('button', {
              class: 'btn btn--sm btn--ghost',
              style: { color: 'white' },
              title: 'My account',
              onClick: () => navigate('/profile'),
            }, '⚙'),
            h('button', {
              class: 'btn btn--sm btn--ghost',
              style: { color: 'white' },
              title: 'Sign out',
              onClick: async () => {
                const ok = await confirm({
                  title: 'Sign out?',
                  message: 'This device will be signed out. You will need your email and password to sign back in.',
                  confirmLabel: 'Sign out',
                });
                if (!ok) return;
                await authSignOut();
                navigate('/login');
              },
            }, '⎋'),
          ],
        }),
        h('main', { class: 'app-body' },
          h('div', { class: 'page' },
            renderFilterBar(),
            loading
              ? h('div', { class: 'empty-state' }, h('div', { class: 'boot-spinner' }))
              : error
                ? h('div', { class: 'banner banner--danger' }, error)
                : inspections.length === 0
                  ? h('div', { class: 'empty-state' },
                      h('div', { class: 'empty-state__icon' }, '○'),
                      h('h2', { class: 'empty-state__title' }, 'No inspections yet'),
                      h('p', { class: 'empty-state__description' }, 'Create your first inspection to get started.'),
                      h('button', { class: 'btn btn--primary mt-4', onClick: () => navigate('/admin/new') }, '+ New Inspection'))
                  : visibleRows().length === 0
                  ? h('div', { class: 'empty-state' },
                      h('div', { class: 'empty-state__icon' }, '○'),
                      h('h2', { class: 'empty-state__title' }, 'Nothing matches'),
                      h('p', { class: 'empty-state__description' },
                        'No inspection in the list matches that search.'))
                  : h('ul', { class: 'list' },
                      visibleRows().map(i => h('li', {
                        class: 'list-item',
                        // For the performance walk, which has to pick a row it
                        // can actually type into. It used to click the first
                        // one and fail on a locked inspection with a disabled
                        // input — a harness that depends on what happens to be
                        // at the top of the workbook does not measure the same
                        // thing twice. An attribute rather than the badge text,
                        // which is written for people and will be translated.
                        'data-status': i.status,
                        onClick: () => navigate('/admin/inspection/' + i.inspectionId),
                      },
                        h('div', { class: 'list-item__row' },
                          h('div', { class: 'list-item__title' }, i.propertyAddress || '(no address)'),
                          badge(i.status),
                        ),
                        h('div', { class: 'list-item__meta' },
                          inspectionTypeLabel(i.inspectionType), ' · ',
                          i.tenantName || '(no tenant)', ' · ',
                          formatDate(i.updatedAt),
                        ),
                        // Shown to admins only. An inspector's list contains
                        // nothing but their own work, where repeating their
                        // name on every row says nothing.
                        isAdmin() && i.assignedTo
                          ? h('div', { class: 'list-item__meta' },
                              'Assigned to ', i.assignedToName || i.assignedTo)
                          : null,
                        h('div', { class: 'list-item__meta text-mono' }, i.inspectionId),
                      ))
                    )
          )
        )
      )
    );
  }

  /** Typed into the search box; never sent to the server. See renderFilterBar. */
  let searchText = '';

  function visibleRows() {
    const q = searchText.trim().toLowerCase();
    if (!q) return inspections;
    return inspections.filter(i =>
      String(i.propertyAddress || '').toLowerCase().includes(q) ||
      String(i.tenantName || '').toLowerCase().includes(q) ||
      String(i.landlordName || '').toLowerCase().includes(q) ||
      String(i.inspectionId || '').toLowerCase().includes(q));
  }

  function renderFilterBar() {
    return h('div', { class: 'card' },
      h('input', {
        type: 'search',
        class: 'form-input',
        placeholder: 'Search by address, tenant, or ID',
        value: searchText,
        // Filters the list already in hand rather than asking the server.
        //
        // It used to fire a request 350 ms after each keystroke, with no
        // cancellation and no sequence number — so the answer to "a" could
        // land after the answer to "apart" and replace it with the wrong
        // rows. Searching locally removes the race by removing the request.
        //
        // This holds while the whole list fits in one page, which it does at
        // 100 rows. Past that the server has to search again, and then it
        // needs a sequence guard.
        onInput: (e) => {
          searchText = e.target.value;
          render();
        },
      })
    );
  }

  // Inside the freshness window the screen simply opens. The user asked for a
  // refresh button rather than a silent request every time, and that is the
  // honest trade: no hidden work, one obvious way to force it.
  if (isFresh) render();
  else load();

  // Started after the screen is drawn, and only for the people who have a
  // + New button to press. This is the one stretch where the network is idle
  // and someone is reading, which is what makes it the right place to spend it.
  if (getState().authMode === 'user') prefetchNewInspectionOptions();
}

// ============================================================
// pageAdminNew
// ============================================================

export function pageAdminNew() {
  let schemas = [];
  let assignableUsers = [];
  let loading = true;
  let submitting = false;
  let form = {
    inspectionType: '',
    schemaId: '',
    property: { addressLine1: '', city: '', postalCode: '', unitNumber: '' },
    parties: {
      landlord: { name: '', email: '', phone: '' },
      tenant: { name: '', email: '', phone: '' },
    },
    notes: '',
    assignedTo: '',
  };

  /**
   * One request, not two in sequence.
   *
   * This used to fetch the schema list, wait, and then fetch the user list —
   * two Apps Script executions, two cold starts, two auth resolutions and two
   * redirects, for a form that needs both at once and neither before the
   * other. Running them in parallel would have halved the wait; asking once
   * removes an execution.
   *
   * The server sends assignableUsers only to an admin, so no branch is needed
   * here: for an inspector it arrives empty and the dropdown is not rendered.
   */
  async function load() {
    try {
      // Usually already in flight, or already finished, because the list screen
      // this was opened from warmed it — see prefetchNewInspectionOptions.
      const res = await takeNewInspectionOptions();
      schemas = res.schemas || [];
      assignableUsers = res.assignableUsers || [];
    } catch (e) {
      toastError(e.message);
    }
    loading = false;
    render();
  }

  async function submit() {
    if (!form.inspectionType || !form.schemaId) {
      toastWarning('Pick an inspection type.');
      return;
    }
    if (!form.property.addressLine1) {
      toastWarning('Address required.');
      return;
    }
    if (!form.parties.landlord.name || !form.parties.tenant.name) {
      toastWarning('Both landlord and tenant names are required.');
      return;
    }
    submitting = true; render();
    try {
      const res = await api.createInspection(form);
      invalidateCachedList();
      // Into state before the modal, because its "Start inspection" button
      // leads to a screen that would otherwise fetch back the inspection this
      // request just created and returned. No fallback fetch here: this flow
      // never had one, and adding one against an older deployment would make
      // creating slower rather than faster.
      if (res.state) setInspectionData(res.state);
      toastSuccess('Inspection created.');
      // Show the tenant URL in a modal
      showTenantLinkModal(res.inspectionId, res.tenantUrl);
    } catch (e) {
      toastError(e.message);
    } finally {
      submitting = false;
      render();
    }
  }

  function showTenantLinkModal(inspectionId, tenantUrl) {
    const linkInput = h('input', {
      type: 'text',
      class: 'form-input text-mono text-sm',
      value: tenantUrl,
      readonly: true,
      onClick: (e) => e.target.select(),
    });
    const modal = openModal({
      title: 'Inspection created',
      body: h('div', null,
        h('p', null, h('strong', null, 'ID: '), h('span', { class: 'text-mono' }, inspectionId)),
        h('p', { class: 'mt-3' }, 'Tenant link (share via email or SMS):'),
        linkInput,
        h('p', { class: 'text-xs text-muted mt-3' }, 'This link is private. The tenant can use it without a Google account. Default expiry: 7 days.'),
      ),
      footer: [
        h('button', { class: 'btn btn--secondary', onClick: () => {
          navigator.clipboard.writeText(tenantUrl).then(() => toastSuccess('Copied'));
        }}, 'Copy link'),
        h('button', { class: 'btn btn--primary', onClick: () => {
          modal.close();
          navigate('/admin/inspection/' + inspectionId);
        }}, 'Open inspection'),
      ],
    });
  }

  function update() {
    render();
  }

  function render() {
    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({ title: 'New Inspection', onBack: () => back() }),
        h('main', { class: 'app-body app-body--has-bottom-bar' },
          h('div', { class: 'page' },
            loading
              ? h('div', { class: 'boot-spinner' })
              : h('div', { class: 'card' },
                  h('div', { class: 'form-group' },
                    h('label', { class: 'form-label' }, 'Inspection type ', h('span', { class: 'form-label__required' }, '*')),
                    h('select', {
                      class: 'form-select',
                      onChange: (e) => {
                        const sch = schemas.find(s => s.schemaId === e.target.value);
                        form.schemaId = e.target.value;
                        form.inspectionType = sch ? sch.inspectionType : '';
                      },
                    },
                      h('option', { value: '' }, '— Choose —'),
                      schemas.map(s => h('option', { value: s.schemaId }, s.title)),
                    ),
                  ),
                  h('hr', { style: { border: 'none', borderTop: '1px solid var(--color-border)', margin: '1rem 0' }}),
                  h('h3', { class: 'page__section-title' }, 'Property'),
                  h('div', { class: 'form-group' },
                    h('label', { class: 'form-label' }, 'Address ', h('span', { class: 'form-label__required' }, '*')),
                    h('input', { type: 'text', class: 'form-input', placeholder: 'Street and number', value: form.property.addressLine1,
                      onInput: (e) => form.property.addressLine1 = e.target.value }),
                  ),
                  h('div', { class: 'form-inline' },
                    h('div', { class: 'form-group' },
                      h('label', { class: 'form-label' }, 'City'),
                      h('input', { type: 'text', class: 'form-input', value: form.property.city,
                        onInput: (e) => form.property.city = e.target.value }),
                    ),
                    h('div', { class: 'form-group' },
                      h('label', { class: 'form-label' }, 'Postal code'),
                      h('input', { type: 'text', class: 'form-input', value: form.property.postalCode,
                        onInput: (e) => form.property.postalCode = e.target.value }),
                    ),
                  ),
                  h('div', { class: 'form-group' },
                    h('label', { class: 'form-label' }, 'Unit / Apartment number'),
                    h('input', { type: 'text', class: 'form-input', value: form.property.unitNumber,
                      onInput: (e) => form.property.unitNumber = e.target.value }),
                  ),

                  h('hr', { style: { border: 'none', borderTop: '1px solid var(--color-border)', margin: '1rem 0' }}),
                  h('h3', { class: 'page__section-title' }, 'Landlord'),
                  partyFields(form.parties.landlord),

                  h('hr', { style: { border: 'none', borderTop: '1px solid var(--color-border)', margin: '1rem 0' }}),
                  h('h3', { class: 'page__section-title' }, 'Tenant'),
                  partyFields(form.parties.tenant),

                  h('hr', { style: { border: 'none', borderTop: '1px solid var(--color-border)', margin: '1rem 0' }}),

                  // Only admins see this. An inspector creating their own job
                  // is implicitly its owner, and offering them a list of
                  // colleagues to hand it to would be a permission they do not
                  // have.
                  isAdmin()
                    ? h('div', { class: 'form-group' },
                        h('label', { class: 'form-label' }, 'Assign to'),
                        h('select', {
                          class: 'form-select',
                          onChange: (e) => { form.assignedTo = e.target.value; },
                        },
                          h('option', { value: '' }, 'Me'),
                          assignableUsers.map(u => h('option', { value: u.email }, u.name)),
                        ),
                        h('p', { class: 'form-hint text-xs text-muted' },
                          'Who will carry out this inspection. Can be changed later.'),
                      )
                    : null,

                  h('div', { class: 'form-group' },
                    h('label', { class: 'form-label' }, 'Internal notes (optional)'),
                    h('textarea', {
                      class: 'form-textarea',
                      onInput: (e) => form.notes = e.target.value,
                    }, form.notes),
                  ),
                ),
          ),
        ),
        bottomBar(
          h('button', { class: 'btn btn--secondary', onClick: () => back() }, 'Cancel'),
          h('button', {
            class: 'btn btn--primary bottom-bar__primary',
            disabled: submitting || undefined,
            onClick: submit,
          }, submitting ? 'Creating…' : 'Create inspection'),
        ),
      )
    );
  }

  function partyFields(party) {
    return h('div', null,
      h('div', { class: 'form-group' },
        h('label', { class: 'form-label' }, 'Name ', h('span', { class: 'form-label__required' }, '*')),
        h('input', { type: 'text', class: 'form-input', value: party.name,
          onInput: (e) => party.name = e.target.value }),
      ),
      h('div', { class: 'form-inline' },
        h('div', { class: 'form-group' },
          h('label', { class: 'form-label' }, 'Email'),
          h('input', { type: 'email', class: 'form-input', value: party.email,
            onInput: (e) => party.email = e.target.value }),
        ),
        h('div', { class: 'form-group' },
          h('label', { class: 'form-label' }, 'Phone'),
          h('input', { type: 'tel', class: 'form-input', value: party.phone,
            onInput: (e) => party.phone = e.target.value }),
        ),
      ),
    );
  }

  load();
}

// ============================================================
// pageInspectionHome — section list, also used for tenant entry
// ============================================================

export async function pageInspectionHome({ params }) {
  const inspectionId = params.id;

  // Reuse what is already loaded, as pageInspectionSection has always done.
  // Without this, walking list → inspection → section → back → back costs a
  // round trip at every step, and a round trip here is two to four seconds —
  // so the app spends most of its time re-fetching what it just had.
  //
  // Safe because the pages that change an inspection refresh it themselves:
  // saving, locking, unlocking, signing and finalising all call
  // setInspectionData with the server's reply.
  if (!await ensureInspection(inspectionId, () => render())) return;

  function render() {
    const state = getState();
    const insp = state.inspection;
    const schema = state.schema;
    const progress = inspectionProgress(schema, state.answers);

    // Sections holding answers that never reached the server. Shown here
    // because this is the screen someone lands on after the app was killed —
    // without it they would have to open every section to find their work.
    const unsent = new Set(draftSectionIds(inspectionId));

    const sectionRows = (schema.sections || []).map(section => {
      const sp = sectionProgress(section, state.answers);
      const indicatorClass = sp.totalRequired === 0 ? 'section-list__indicator--empty'
        : sp.completedRequired === sp.totalRequired ? 'section-list__indicator--complete'
        : sp.completedRequired > 0 ? 'section-list__indicator--partial'
        : 'section-list__indicator--empty';

      return h('button', {
        class: 'section-list__item',
        onClick: () => navigate(`/inspection/${inspectionId}/section/${section.id}`),
      },
        h('span', { class: ['section-list__indicator', indicatorClass] }),
        h('span', { class: 'section-list__title' }, section.title),
        unsent.has(section.id)
          ? h('span', {
              class: 'badge badge--warning',
              title: 'Typed on this device but not yet saved. Open the section to send it.',
            }, 'Unsaved')
          : null,
        h('span', { class: 'section-list__progress' },
          sp.totalRequired > 0 ? `${sp.completedRequired}/${sp.totalRequired}` : `${sp.completedVisible}/${sp.totalVisible}`),
        h('span', { class: 'section-list__chevron' }, '›'),
      );
    });

    const isStaff = state.authMode === 'user';
    const canEdit = ['draft', 'under_review'].indexOf(insp.status) >= 0;
    const canSign = ['locked_for_signature', 'partially_signed'].indexOf(insp.status) >= 0;

    let actionButton = null;
    if (isStaff && canEdit) {
      actionButton = h('button', {
        class: 'btn btn--primary bottom-bar__primary',
        disabled: !progress.isReadyForLock || undefined,
        onClick: () => navigate(`/inspection/${inspectionId}/review`),
      }, progress.isReadyForLock
          ? 'Review & lock'
          : `Complete ${progress.totalRequired - progress.completedRequired} more required`);
    } else if (canSign) {
      actionButton = h('button', {
        class: 'btn btn--primary bottom-bar__primary',
        onClick: () => navigate(`/inspection/${inspectionId}/sign`),
      }, 'Go to signing');
    } else if (insp.status === 'signed') {
      actionButton = h('button', {
        class: 'btn btn--primary bottom-bar__primary',
        onClick: () => navigate(`/inspection/${inspectionId}/success`),
      }, 'View final report');
    }

    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({
          title: insp.propertyAddress || 'Inspection',
          subtitle: `${inspectionTypeLabel(insp.inspectionType)} · ${insp.inspectionId}`,
          onBack: isStaff ? () => navigate('/admin') : null,
        }),
        h('main', { class: 'app-body app-body--has-bottom-bar' },
          h('div', { class: 'page' },
            h('div', { class: 'flex justify-between items-center' },
              badge(insp.status),
              h('span', { class: 'text-sm text-muted' },
                progress.completedRequired, '/', progress.totalRequired, ' required'),
            ),
            progressBar(progress.completedRequired, progress.totalRequired || 1),

            insp.status === 'locked_for_signature' || insp.status === 'partially_signed'
              ? h('div', { class: 'banner banner--info' },
                  h('div', { class: 'banner__icon' }, 'i'),
                  h('div', { class: 'banner__body' },
                    h('div', { class: 'banner__title' }, 'Awaiting signatures'),
                    'The inspection is locked for review. Editing is disabled.'))
              : null,

            insp.status === 'signed'
              ? h('div', { class: 'banner banner--success' },
                  h('div', { class: 'banner__icon' }, '✓'),
                  h('div', { class: 'banner__body' },
                    h('div', { class: 'banner__title' }, 'Signed'),
                    'All signatures collected.'))
              : null,

            h('h2', { class: 'page__section-title' }, 'Sections'),
            h('div', { class: 'section-list' }, sectionRows),
          )
        ),
        actionButton ? bottomBar(actionButton) : null,
      )
    );
  }

  render();
}

// ============================================================
// pageInspectionSection — the big editor
// ============================================================

export async function pageInspectionSection({ params }) {
  const inspectionId = params.id;
  const sectionId = params.sectionId;

  // Ensure inspection is loaded (after refresh on this URL)
  if (!await ensureInspection(inspectionId, () => render())) return;

  const state = getState();
  const section = (state.schema.sections || []).find(s => s.id === sectionId);
  if (!section) {
    return showError('Section not found', `No section with id '${sectionId}'.`);
  }

  // Pending changes buffer (drained by autosave)
  const pendingItems = {};

  // Anything typed on a previous visit that never reached the server — a lost
  // tab, a dead battery, or no signal. It is put back into state so the screen
  // shows what was typed, and back into the buffer so it is actually sent;
  // restoring only one of the two would show work that silently never saves.
  const restored = readDraft(inspectionId, sectionId);
  const restoredIds = Object.keys(restored);
  if (restoredIds.length > 0) {
    restoredIds.forEach(itemId => {
      patchAnswer(sectionId, itemId, restored[itemId]);
      pendingItems[itemId] = { ...restored[itemId] };
    });
  }
  // Reference to the save indicator element, updated in place (not via re-render)
  let saveIndicatorEl = null;
  // Reference to the cards container, so we can re-render only that part
  let cardsContainer = null;
  // Reference to the section progress display
  let progressContainer = null;

  // Pre-compute which itemIds are referenced by any visibleWhen/requiredWhen
  // in the entire schema (cross-section refs are allowed). Only changes to
  // these fields trigger a content re-render.
  const triggerItemIds = collectTriggerFieldIds(getState().schema);

  function updateSaveIndicator() {
    if (!saveIndicatorEl) return;
    // The save now outlives the screen that started it, so this can run after
    // the indicator has been unmounted. replaceWith on a parentless node is a
    // no-op, but swapping in a fresh detached node every time would keep a
    // finished screen's furniture alive for no reason.
    if (!saveIndicatorEl.parentNode) return;
    const cur = getState();
    const fresh = saveIndicator(cur.saveStatus, cur.saveError);
    saveIndicatorEl.replaceWith(fresh);
    saveIndicatorEl = fresh;
  }

  function flushSave() {
    if (Object.keys(pendingItems).length === 0) return Promise.resolve();
    const itemsToSend = { ...pendingItems };
    Object.keys(pendingItems).forEach(k => delete pendingItems[k]);
    setState({ saveStatus: 'saving' });
    updateSaveIndicator();
    // Tracked, so that locking — the one action whose correctness depends on
    // the server being current — can wait for it. Nothing else does any more.
    return trackSave(api.saveSection(inspectionId, sectionId, itemsToSend,
        getState().revisions[sectionId])
      .then((res) => {
        // Only now is the local copy redundant. A failure leaves it in place,
        // which is what makes the offline case work without any extra code.
        forgetDraft(inspectionId, sectionId, Object.keys(itemsToSend));
        // The next save must claim the revision this one produced, or it would
        // look stale to the server and be refused.
        if (res && typeof res.revision === 'number') {
          setSectionRevision(sectionId, res.revision);
        }
        setState({ saveStatus: 'saved', saveError: null });
        updateSaveIndicator();
      })
      .catch((e) => {
        console.error('[saveSection] failed', {
          code: e.code,
          message: e.message,
          details: e.details,
          itemsSent: itemsToSend,
        });
        setState({ saveStatus: 'error', saveError: e.message });
        updateSaveIndicator();
        // Re-add pending items if save failed
        Object.assign(pendingItems, itemsToSend);

        if (e.code === 'CONFLICT') {
          // Someone else saved this section while it was open. Retrying would
          // overwrite their work, which is the thing the revision exists to
          // stop — so the person is told, and the draft stays on the device so
          // nothing they typed is lost either way.
          toastError('This section was changed elsewhere. Reopen it to see the '
            + 'current answers; what you typed is still saved on this device.');
          return;
        }
        toastError('Save failed: ' + (e.code || 'unknown') + ' — ' + (e.message || ''));
      }));
  }

  const debouncedSave = debounce(flushSave, AUTOSAVE_DEBOUNCE_MS);

  function queueChange(itemId, patch) {
    if (!pendingItems[itemId]) {
      const cur = (getState().answers[sectionId] || {})[itemId] || {};
      pendingItems[itemId] = { value: cur.value, comment: cur.comment || '' };
    }
    Object.assign(pendingItems[itemId], patch);
    // Written now, not on the debounce. The debounce exists to spare the
    // network; the disk is not what we are economising on, and the whole point
    // is to survive the moment between typing and sending.
    rememberDraft(inspectionId, sectionId, { [itemId]: pendingItems[itemId] });
    debouncedSave();
  }

  // Save on navigation away
  const onBeforeUnload = (e) => {
    if (Object.keys(pendingItems).length > 0) {
      flushSave();
    }
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  /** Build the list of question cards + progress bar for current state. */
  function buildContent() {
    const cur = getState();
    const insp = cur.inspection;
    const sectionAnswers = cur.answers[sectionId] || {};
    const answersMap = buildAnswersMap(cur.answers);

    const isLocked = ['locked_for_signature', 'partially_signed', 'signed', 'archived', 'cancelled'].indexOf(insp.status) >= 0;
    const canEdit = !isLocked;

    const visibleItems = (section.items || []).filter(it => isItemVisible(it, answersMap));
    const sp = sectionProgress(section, cur.answers);

    const cards = visibleItems.map(item => {
      const a = sectionAnswers[item.id] || {};
      return questionCard(item, a.value, a.comment, cur.attachments, {
        disabled: !canEdit,
        inspectionId,
        sectionId,
        onChange: (newValue) => {
          patchAnswer(sectionId, item.id, { value: newValue });
          queueChange(item.id, { value: newValue });
          // Only re-render content if this field is referenced by some condition.
          // Plain text fields are never triggers → no re-render → input keeps focus.
          if (triggerItemIds.has(item.id)) {
            rebuildContent();
          }
        },
        onCommentChange: (comment) => {
          patchAnswer(sectionId, item.id, { comment });
          queueChange(item.id, { comment });
          // Comments are never triggers; no re-render.
        },
      });
    });

    return { cards, progress: sp };
  }

  /** Replace cards container and progress with fresh content. Keeps header/footer. */
  function rebuildContent() {
    if (!cardsContainer || !progressContainer) return;
    const { cards, progress: sp } = buildContent();

    // Replace cards
    const newCards = h('div', { class: 'cards-wrapper' }, cards);
    cardsContainer.replaceWith(newCards);
    cardsContainer = newCards;

    // Replace progress bar (it's inside the same wrapper)
    const newProgress = h('div', { class: 'flex items-center gap-3' },
      h('div', { style: { flex: '1' } },
        progressBar(sp.completedVisible, sp.totalVisible || 1)),
      h('span', { class: 'text-xs text-muted' },
        sp.completedVisible, '/', sp.totalVisible),
    );
    progressContainer.replaceWith(newProgress);
    progressContainer = newProgress;
  }

  function render() {
    const cur = getState();
    const insp = cur.inspection;
    const { cards, progress: sp } = buildContent();

    // Find next section for "Next" navigation
    const sections = cur.schema.sections || [];
    const idx = sections.findIndex(s => s.id === sectionId);
    const nextSection = idx >= 0 && idx < sections.length - 1 ? sections[idx + 1] : null;

    saveIndicatorEl = saveIndicator(cur.saveStatus, cur.saveError);
    progressContainer = h('div', { class: 'flex items-center gap-3' },
      h('div', { style: { flex: '1' } },
        progressBar(sp.completedVisible, sp.totalVisible || 1)),
      h('span', { class: 'text-xs text-muted' },
        sp.completedVisible, '/', sp.totalVisible),
    );
    cardsContainer = h('div', { class: 'cards-wrapper' }, cards);

    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({
          title: section.title,
          subtitle: insp.propertyAddress,
          // Started, not waited for. What was typed is already in local state
          // and on the device, and a failure reports itself wherever the person
          // has got to — so the five seconds this used to spend were spent
          // making the save look finished, not making it safe. Fifteen sections
          // to an inspection, and this was most of the time filling one in.
          onBack: () => {
            flushSave();
            navigate('/inspection/' + inspectionId);
          },
          actions: [saveIndicatorEl],
        }),
        h('main', { class: 'app-body app-body--has-bottom-bar' },
          h('div', { class: 'page' },
            section.description ? h('p', { class: 'text-muted text-sm' }, section.description) : null,
            progressContainer,
            cardsContainer,
          ),
        ),
        bottomBar(
          h('button', {
            class: 'btn btn--secondary',
            onClick: () => {
              flushSave();
              navigate('/inspection/' + inspectionId);
            },
          }, 'Sections'),
          nextSection
            ? h('button', {
                class: 'btn btn--primary bottom-bar__primary',
                onClick: () => {
                  flushSave();
                  navigate(`/inspection/${inspectionId}/section/${nextSection.id}`);
                },
              }, 'Next: ' + nextSection.title + ' →')
            : h('button', {
                class: 'btn btn--primary bottom-bar__primary',
                onClick: () => {
                  flushSave();
                  navigate('/inspection/' + inspectionId);
                },
              }, 'Done with section'),
        ),
      )
    );
  }

  render();

  // Photo previews for this section, once, in the background.
  //
  // Not awaited: the section is usable without them, and a request here costs
  // about three seconds. Asked for the whole section rather than per photo for
  // the same reason — five images would otherwise be five round trips.
  //
  // Only when something is actually missing. A section whose photos were all
  // taken on this device already has them, and re-fetching would be three
  // seconds spent replacing a picture with a copy of itself.
  (function loadThumbs() {
    const ids = (getState().attachments || [])
      .filter(a => a.sectionId === sectionId)
      .map(a => a.attachmentId);
    if (ids.length === 0 || !thumbs.needsLoading(ids)) return;

    thumbs.loadSection(inspectionId, sectionId, api.getSectionThumbs)
      .then(() => { if (cardsContainer && cardsContainer.parentNode) rebuildContent(); })
      .catch(() => {
        // Left as they are — "loading" rather than "no preview" — because a
        // failed request says nothing about whether a preview exists, and
        // reopening the section should try again.
      });
  })();

  // Said out loud, and sent straight away. Restoring silently would leave
  // someone looking at answers with no way to tell whether they are safe —
  // which is the state this whole mechanism exists to end.
  if (restoredIds.length > 0) {
    toastWarning(
      `${restoredIds.length} answer${restoredIds.length === 1 ? '' : 's'} ` +
      'from this device had not been saved. Restored — sending now.');
    flushSave();
  }

  // Cleanup on next route
  if (window._currentPageCleanup) window._currentPageCleanup();
  window._currentPageCleanup = () => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    flushSave();
  };
}

/**
 * Walk the schema and collect every itemId referenced inside any
 * visibleWhen / requiredWhen condition. These are the "trigger" fields
 * whose change must cause a content re-render.
 */
function collectTriggerFieldIds(schema) {
  const triggers = new Set();
  function walk(condition) {
    if (!condition) return;
    if (condition.all) condition.all.forEach(walk);
    if (condition.any) condition.any.forEach(walk);
    if (condition.field) triggers.add(condition.field);
  }
  for (const section of (schema.sections || [])) {
    for (const item of (section.items || [])) {
      walk(item.visibleWhen);
      walk(item.requiredWhen);
    }
  }
  return triggers;
}

// ============================================================
// pageReview — pre-lock summary
// ============================================================

export async function pageReview({ params }) {
  const inspectionId = params.id;

  if (!await ensureInspection(inspectionId, () => render())) return;

  const schema = getState().schema;

  let locking = false;

  /**
   * What the server said was missing, when it disagreed with us.
   *
   * The list on this screen is computed by validator.js, a mirror of
   * ValidationService that can drift from it — and did: the screen said every
   * required item was complete while the lock came back refusing one. Once the
   * two disagree the server is the answer, because the server is the one
   * deciding, so its list replaces ours until something is edited.
   *
   * It also carries which item, which the screen used to receive and discard in
   * favour of printing a count. A refusal that knows the answer and will not
   * say it is worse than no refusal at all — there is nothing to act on, and
   * the screen goes on insisting nothing is wrong.
   */
  let serverMissing = null;

  /** The server names the item; the section's title has to come from the schema. */
  function withSectionTitles(items) {
    return items.map(m => {
      const section = (schema.sections || []).find(s => s.id === m.sectionId);
      return Object.assign({ sectionTitle: (section && section.title) || m.sectionId }, m);
    });
  }

  async function doLock() {
    const ok = await confirm({
      title: 'Lock inspection?',
      message: 'Once locked, no further edits are possible. Both parties will sign the report. You can unlock later if corrections are needed (which invalidates any signatures).',
      confirmLabel: 'Lock for signing',
    });
    if (!ok) return;
    locking = true; render();
    try {
      // Leaving a section no longer waits for its save, so one may still be in
      // flight. Locking asks the server whether every required item is
      // answered, and an answer still on its way is one the server does not
      // have — the lock would be refused over something visible on this very
      // screen. This is the only place that waits, and only while something is
      // actually outstanding.
      await savesSettled();
      await applyMutationState(await api.lockInspection(inspectionId), inspectionId);
      serverMissing = null;
      toastSuccess('Inspection locked. Ready for signatures.');
      navigate(`/inspection/${inspectionId}/sign`);
    } catch (e) {
      if (e.code === 'VALIDATION_FAILED' && e.details && e.details.missingItems) {
        serverMissing = withSectionTitles(e.details.missingItems);
        // Named, not counted. "1 required items missing" on a screen that says
        // everything is complete leaves someone with nowhere to go.
        const first = serverMissing[0];
        toastError(serverMissing.length === 1
          ? `Still missing: ${first.sectionTitle} — ${first.label}`
          : `${serverMissing.length} required items missing, listed above.`);
        // The lock was refused, so nothing came back to redraw from — this one
        // really does have to ask.
        setInspectionData(await api.getInspection(inspectionId));
      } else {
        toastError(e.message);
      }
    } finally {
      locking = false;
      render();
    }
  }

  function render() {
    // Read at render time, not captured when the page opened. A refused lock
    // re-fetches the inspection and calls render again, and the snapshot this
    // used to close over meant the redraw showed the state from before the
    // refusal — the banner kept saying every required item was complete.
    const state = getState();
    const insp = state.inspection;
    const missing = serverMissing || findAllMissingRequired(schema, state.answers);

    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({ title: 'Review', onBack: () => navigate('/inspection/' + inspectionId) }),
        h('main', { class: 'app-body app-body--has-bottom-bar' },
          h('div', { class: 'page' },
            h('div', { class: 'card' },
              h('h2', { class: 'card__title' }, insp.propertyAddress),
              h('p', { class: 'card__meta' }, inspectionTypeLabel(insp.inspectionType), ' · ', insp.inspectionId),
              h('p', { class: 'card__meta mt-2' },
                h('strong', null, 'Tenant: '), insp.tenantName, ' · ',
                h('strong', null, 'Landlord: '), insp.landlordName,
              ),
            ),

            h('h3', { class: 'page__section-title' }, 'Required items'),
            missing.length > 0
              ? h('div', { class: 'banner banner--warning' },
                  h('div', { class: 'banner__icon' }, '!'),
                  h('div', { class: 'banner__body' },
                    h('div', { class: 'banner__title' }, `${missing.length} item${missing.length > 1 ? 's' : ''} still missing`),
                    h('ul', { style: { margin: '0.5rem 0 0 1rem' } },
                      missing.map(m => h('li', null,
                        h('a', {
                          href: '#',
                          onClick: (e) => { e.preventDefault(); navigate(`/inspection/${inspectionId}/section/${m.sectionId}`); },
                        }, m.sectionTitle), ' — ', m.label,
                        m.reason === 'insufficient_attachments' ? ' (photos required)' : '',
                      )),
                    ),
                  ),
                )
              : h('div', { class: 'banner banner--success' },
                  h('div', { class: 'banner__icon' }, '✓'),
                  h('div', { class: 'banner__body' }, 'All required items completed.')),

            h('h3', { class: 'page__section-title' }, 'Section summary'),
            h('div', { class: 'list' },
              (schema.sections || []).map(s => {
                const sp = sectionProgress(s, state.answers);
                return h('div', { class: 'list-item', onClick: () => navigate(`/inspection/${inspectionId}/section/${s.id}`) },
                  h('div', { class: 'list-item__row' },
                    h('span', { class: 'list-item__title' }, s.title),
                    h('span', { class: 'list-item__meta' },
                      sp.totalRequired > 0 ? `${sp.completedRequired}/${sp.totalRequired} required` : `${sp.completedVisible}/${sp.totalVisible} filled`),
                  ),
                );
              }),
            ),
          ),
        ),
        bottomBar(
          h('button', { class: 'btn btn--secondary', onClick: () => navigate('/inspection/' + inspectionId) }, 'Back'),
          h('button', {
            class: 'btn btn--primary bottom-bar__primary',
            disabled: missing.length > 0 || locking || undefined,
            onClick: doLock,
          }, locking ? 'Locking…' : 'Lock & request signatures'),
        ),
      )
    );
  }
  render();
}

// ============================================================
// pageSign — signature collection
// ============================================================

export async function pageSign({ params }) {
  const inspectionId = params.id;

  if (!await ensureInspection(inspectionId, () => render())) return;

  const state = getState();
  const insp = state.inspection;
  const isStaff = state.authMode === 'user';
  const isTenant = state.authMode === 'tenant';

  // Determine which role this user can sign as
  // Admin can sign as anyone; tenant can only sign as 'tenant'
  let availableRoles;
  if (isStaff) {
    availableRoles = ['landlord', 'tenant'];
  } else if (isTenant) {
    availableRoles = ['tenant'];
  } else {
    return showError('Cannot sign', 'No valid signing role.');
  }

  const validSignatures = (state.signatures || []).filter(s => s.valid === true);
  const signedRoles = validSignatures.map(s => s.signerRole);
  const remainingRoles = availableRoles.filter(r => signedRoles.indexOf(r) < 0);

  if (insp.status === 'signed') {
    navigate(`/inspection/${inspectionId}/success`, true);
    return;
  }

  if (remainingRoles.length === 0) {
    // All this user's roles already signed
    return mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({ title: 'Signatures', onBack: () => navigate('/inspection/' + inspectionId) }),
        h('main', { class: 'app-body' },
          h('div', { class: 'page' },
            h('div', { class: 'banner banner--success' },
              h('div', { class: 'banner__icon' }, '✓'),
              h('div', { class: 'banner__body' }, 'You have signed. Awaiting other party.')),
            isStaff ? h('button', { class: 'btn btn--primary mt-4', onClick: () => navigate('/admin/inspection/' + inspectionId) }, 'Back to admin') : null,
          )
        )
      )
    );
  }

  let currentRole = remainingRoles[0];
  let signerName = '';
  let accepted = false;
  let submitting = false;

  // Create signature pad ONCE — it must survive checkbox/role re-renders
  const pad = signatureCanvas();

  // Refs to elements that may need re-rendering
  let roleSection = null;
  let acceptedRow = null;
  let submitButton = null;

  function buildRoleSection() {
    if (availableRoles.length > 1) {
      return h('div', { class: 'form-group' },
        h('label', { class: 'form-label' }, 'Signing as'),
        h('div', { class: 'form-options' },
          remainingRoles.map(r => h('div', {
            class: ['form-check', 'form-check--radio', currentRole === r ? 'form-check--checked' : null],
            role: 'radio',
            tabindex: '0',
            'aria-checked': currentRole === r ? 'true' : 'false',
            onClick: () => {
              currentRole = r;
              const fresh = buildRoleSection();
              roleSection.replaceWith(fresh);
              roleSection = fresh;
            },
          },
            h('span', { class: 'form-check__indicator', 'aria-hidden': 'true' }),
            h('span', { class: 'form-check__label' }, r === 'tenant' ? 'Tenant' : r === 'landlord' ? 'Landlord' : r),
          )),
        ),
      );
    }
    return h('div', { class: 'banner banner--info' },
      h('div', { class: 'banner__icon' }, 'i'),
      h('div', { class: 'banner__body' },
        'Signing as ', h('strong', null, currentRole === 'tenant' ? 'Tenant' : 'Landlord')));
  }

  function buildAcceptedRow() {
    return h('div', {
      class: ['form-check', accepted ? 'form-check--checked' : null],
      role: 'checkbox',
      tabindex: '0',
      'aria-checked': accepted ? 'true' : 'false',
      onClick: () => {
        accepted = !accepted;
        const fresh = buildAcceptedRow();
        acceptedRow.replaceWith(fresh);
        acceptedRow = fresh;
      },
    },
      h('span', { class: 'form-check__indicator', 'aria-hidden': 'true' }),
      h('span', { class: 'form-check__label' },
        'I confirm the contents of this inspection are accurate and that I am the named signer.',
      ),
    );
  }

  function buildSubmitButton() {
    return h('button', {
      class: 'btn btn--primary bottom-bar__primary',
      disabled: submitting || undefined,
      onClick: submit,
    }, submitting ? 'Submitting…' : 'Submit signature');
  }

  function updateSubmitButton() {
    if (!submitButton) return;
    const fresh = buildSubmitButton();
    submitButton.replaceWith(fresh);
    submitButton = fresh;
  }

  function render() {
    roleSection = buildRoleSection();
    acceptedRow = buildAcceptedRow();
    submitButton = buildSubmitButton();

    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({ title: 'Sign', onBack: () => navigate('/inspection/' + inspectionId) }),
        h('main', { class: 'app-body app-body--has-bottom-bar' },
          h('div', { class: 'page' },
            h('div', { class: 'card' },
              h('h2', { class: 'card__title' }, insp.propertyAddress),
              h('p', { class: 'card__meta' }, inspectionTypeLabel(insp.inspectionType), ' · ', insp.inspectionId),
            ),

            roleSection,

            h('div', { class: 'form-group' },
              h('label', { class: 'form-label' }, 'Full name (printed) ', h('span', { class: 'form-label__required' }, '*')),
              h('input', {
                type: 'text',
                class: 'form-input',
                value: signerName,
                placeholder: currentRole === 'tenant' ? insp.tenantName : insp.landlordName,
                onInput: (e) => { signerName = e.target.value; },
              }),
            ),

            h('div', { class: 'form-group' },
              h('label', { class: 'form-label' }, 'Signature ', h('span', { class: 'form-label__required' }, '*')),
              pad.element,
              h('div', { class: 'signature-pad__actions' },
                h('button', { class: 'btn btn--ghost btn--sm', onClick: () => pad.clear() }, 'Clear'),
              ),
            ),

            acceptedRow,
          ),
        ),
        bottomBar(
          h('button', { class: 'btn btn--secondary', onClick: () => navigate('/inspection/' + inspectionId) }, 'Cancel'),
          submitButton,
        ),
      )
    );
  }

  async function submit() {
    if (!signerName.trim()) { toastWarning('Name required.'); return; }
    if (!accepted) { toastWarning('You must accept the confirmation.'); return; }
    if (pad.isEmpty()) { toastWarning('Please draw your signature.'); return; }

    // Capture signature data IMMEDIATELY before any other state changes,
    // since the canvas is the source of truth and must not be modified during submit.
    const signatureBase64 = pad.getBase64();

    submitting = true;
    updateSubmitButton();

    let result;
    try {
      result = await api.saveSignature({
        inspectionId,
        signerRole: currentRole,
        signerName: signerName.trim(),
        accepted: true,
        base64Png: signatureBase64,
        userAgent: navigator.userAgent,
      });
      toastSuccess('Signature saved.');
      await applyMutationState(result, inspectionId);
    } catch (e) {
      submitting = false;
      updateSubmitButton();
      toastError(e.message || 'Signature submission failed');
      return;
    }

    // Always reset submitting before next step
    submitting = false;

    // Determine next step based on FRESH state (not stale result flag)
    const freshState = getState();
    const newStatus = freshState.inspection.status;

    if (newStatus === 'signed') {
      // All signatures collected
      if (isStaff) {
        await offerFinalize(inspectionId);
      } else {
        navigate(`/inspection/${inspectionId}/success`);
      }
      return;
    }

    if (newStatus === 'partially_signed') {
      // More signatures still needed
      if (isTenant) {
        navigate(`/inspection/${inspectionId}/success`);
      } else {
        // Admin: prepare UI for next role
        const fresh = getState();
        const validSigsNow = (fresh.signatures || []).filter(s => s.valid === true);
        const signedRolesNow = validSigsNow.map(s => s.signerRole);
        const remainingNow = availableRoles.filter(r => signedRolesNow.indexOf(r) < 0);
        if (remainingNow.length === 0) {
          navigate(`/inspection/${inspectionId}/success`);
          return;
        }
        // Mutate captured remainingRoles so role section reflects new state
        remainingRoles.length = 0;
        remainingRoles.push(...remainingNow);
        currentRole = remainingNow[0];
        signerName = '';
        accepted = false;
        pad.clear();
        // Full re-render is safe here — pad survives because it lives in outer closure
        render();
      }
      return;
    }

    // Defensive fallback — unexpected status, just go to inspection home
    navigate(`/inspection/${inspectionId}`);
  }

  render();
}

async function offerFinalize(inspectionId) {
  const ok = await confirm({
    title: 'Generate final report?',
    message: 'All signatures collected. Generate the final PDF now? This may take 30–60 seconds.',
    confirmLabel: 'Generate PDF',
  });
  if (!ok) {
    navigate(`/inspection/${inspectionId}/success`);
    return;
  }
  showSpinner('Generating PDF…');
  try {
    // Applied before navigating, so the success screen — which is where the
    // new PDF's link lives — draws from it instead of fetching it back.
    await applyMutationState(await api.finalizeInspection(inspectionId), inspectionId);
    toastSuccess('Final PDF ready.');
    navigate(`/inspection/${inspectionId}/success`);
  } catch (e) {
    toastError(e.message);
    navigate(`/inspection/${inspectionId}/success`);
  }
}

// ============================================================
// pageSuccess
// ============================================================

/**
 * Fetch the final report through the API and hand it to the browser.
 *
 * Both screens that offer the report used to build
 * `https://drive.google.com/file/d/${i.finalPdfFileId}/view` out of the
 * inspection row and put it in an anchor. Following that link asks Drive, not
 * this app, who may read the file — and Drive knows only the Google account in
 * the browser, which for a tenant holding a link token is nobody. Sharing the
 * folder widely enough for them to read it makes the file id the only thing
 * between a stranger and a signed report.
 *
 * `busy` is called with true and then false around the request, so each caller
 * redraws its own button without this needing to know how.
 */
async function downloadFinalPdf(inspectionId, busy) {
  busy(true);
  try {
    const res = await api.downloadPdf(inspectionId);
    saveBlob(base64ToBlob(res.base64Data, res.mimeType), res.fileName);
  } catch (e) {
    toastError(e.message);
  } finally {
    busy(false);
  }
}

export async function pageSuccess({ params }) {
  const inspectionId = params.id;

  // Same reuse as the other inspection screens. This one is almost always
  // reached straight after signing or finalising, which have just put the
  // server's own copy into state — fetching it again was a guaranteed round
  // trip for something already in hand.
  if (!await ensureInspection(inspectionId, () => render())) return;
  const isStaff = getState().authMode === 'user';

  let finalizing = false;
  let downloading = false;
  const setDownloading = (v) => { downloading = v; render(); };

  async function doFinalize() {
    finalizing = true; render();
    try {
      await applyMutationState(await api.finalizeInspection(inspectionId), inspectionId);
      toastSuccess('Final PDF generated.');
    } catch (e) {
      toastError(e.message);
    } finally {
      finalizing = false;
      render();
    }
  }

  function render() {
    const cur = getState();
    const i = cur.inspection;

    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({
          title: 'Inspection complete',
          onBack: isStaff ? () => navigate('/admin') : null,
        }),
        h('main', { class: 'app-body' },
          h('div', { class: 'page' },
            h('div', { class: 'card text-center' },
              h('div', { style: { fontSize: '3rem', color: 'var(--color-success)' } }, '✓'),
              h('h2', { class: 'card__title mt-3' }, i.status === 'signed' ? 'All signatures collected' : statusLabel(i.status)),
              h('p', { class: 'card__meta mt-2' }, i.propertyAddress),
              h('p', { class: 'card__meta' }, i.inspectionId),
            ),

            i.finalPdfFileId
              ? h('button', {
                  class: 'btn btn--primary btn--block mt-4',
                  disabled: downloading || undefined,
                  onClick: () => downloadFinalPdf(i.inspectionId, setDownloading),
                }, downloading ? 'Preparing…' : 'Download final PDF')
              : isStaff
                ? h('button', {
                    class: 'btn btn--primary btn--block mt-4',
                    disabled: finalizing || undefined,
                    onClick: doFinalize,
                  }, finalizing ? 'Generating…' : 'Generate final PDF')
                : h('div', { class: 'banner banner--info mt-4' },
                    h('div', { class: 'banner__icon' }, 'i'),
                    h('div', { class: 'banner__body' }, 'The landlord will finalize the report shortly.')),

            isStaff
              ? h('button', { class: 'btn btn--secondary btn--block mt-3', onClick: () => navigate('/admin') },
                  'Back to inspections')
              : null,
          ),
        ),
      )
    );
  }
  render();
}

// ============================================================
// pageAdminDetail — admin view of one inspection (read-only summary + actions)
// ============================================================

/**
 * Hand an inspection to someone else.
 *
 * This is what makes ownership editable at all. `createdBy` records who typed
 * the inspection in, which is routinely not the person who goes out to do it —
 * so without a way to set `assignedTo` afterwards, an inspection opened by the
 * office would be stranded the moment visibility starts following that column.
 */
function openAssign(inspectionId, currentEmail) {
  const slot = h('div', null, h('div', { class: 'boot-spinner' }));
  const modal = openModal({
    title: 'Assign inspection',
    body: slot,
    footer: [h('button', { class: 'btn btn--secondary', onClick: () => modal.close() }, 'Cancel')],
  });

  api.listUsers().then(res => {
    const users = (res.users || []).filter(u => u.status === 'active');
    if (users.length === 0) {
      mount(slot, h('p', { class: 'text-muted text-sm' }, 'No active users to assign to.'));
      return;
    }
    mount(slot,
      h('p', { class: 'text-muted text-sm' }, 'Who will carry out this inspection.'),
      h('ul', { class: 'list mt-3' },
        users.map(u => h('li', {
          class: 'list-item list-item--clickable',
          onClick: async () => {
            modal.close();
            try {
              const res = await api.assignInspection(inspectionId, u.email);
              invalidateCachedList();
              toastSuccess(`Assigned to ${u.name}.`);
              // The server's own copy rather than a local patch: it normalises
              // the address and resolves the assignee's name, and showing
              // anything else would be a small lie about what was stored.
              await applyMutationState(res, inspectionId);
              navigate('/admin/inspection/' + inspectionId, true);
            } catch (e) {
              toastError(e.message);
            }
          },
        },
          h('div', { class: 'list-item__main' },
            h('div', { class: 'list-item__title' }, u.name),
            h('div', { class: 'list-item__meta' }, u.email),
          ),
          u.email === currentEmail
            ? h('span', { class: 'badge badge--info' }, 'Current')
            : h('span', { class: 'list-item__chevron' }, '›'),
        ))));
  }).catch(e => {
    mount(slot, h('div', { class: 'banner banner--danger' }, e.message));
  });
}

export async function pageAdminDetail({ params }) {
  const inspectionId = params.id;

  // Same reuse as pageInspectionHome. This page is most often reached from the
  // list and left again immediately, which is exactly the pattern that made
  // every click cost a fetch.
  if (!await ensureInspection(inspectionId, () => render())) return;

  let downloading = false;
  const setDownloading = (v) => { downloading = v; render(); };

  function render() {
    const state = getState();
    const i = state.inspection;
    const progress = inspectionProgress(state.schema, state.answers);

    const canEdit = ['draft', 'under_review'].indexOf(i.status) >= 0;
    // Reopening a signed inspection is supervisory, so unlockInspection is one
    // of the few things that stayed admin-only. Showing the button to an
    // inspector would only produce a refusal they can do nothing about.
    const canUnlock = isAdmin()
      && ['locked_for_signature', 'partially_signed'].indexOf(i.status) >= 0;

    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({
          title: i.propertyAddress || 'Inspection',
          subtitle: i.inspectionId,
          onBack: () => navigate('/admin'),
        }),
        h('main', { class: 'app-body app-body--has-bottom-bar' },
          h('div', { class: 'page' },
            h('div', { class: 'card' },
              h('div', { class: 'flex justify-between items-center' },
                badge(i.status),
                h('span', { class: 'text-xs text-muted' }, formatDateTime(i.updatedAt)),
              ),
              h('h2', { class: 'card__title mt-3' }, i.propertyAddress),
              h('p', { class: 'card__meta' }, inspectionTypeLabel(i.inspectionType)),
              h('div', { class: 'mt-3 text-sm' },
                h('div', null, h('strong', null, 'Tenant: '), i.tenantName, ' (', i.tenantEmail || 'no email', ')'),
                h('div', null, h('strong', null, 'Landlord: '), i.landlordName),
                h('div', null, h('strong', null, 'Created: '), formatDate(i.createdAt), ' by ', i.createdBy || 'unknown'),
                h('div', null,
                  h('strong', null, 'Assigned to: '),
                  // Falls back to the address when no account matches it any
                  // more — a deleted user should show as something, not blank.
                  i.assignedToName || i.assignedTo
                    || h('span', { class: 'text-muted' }, 'nobody'),
                  isAdmin()
                    ? h('button', {
                        class: 'btn btn--sm btn--ghost',
                        style: { marginLeft: 'var(--space-2)' },
                        onClick: () => openAssign(inspectionId, i.assignedTo),
                      }, 'Change')
                    : null,
                ),
              ),
            ),

            h('div', { class: 'flex gap-3 items-center' },
              h('div', { style: { flex: 1 } },
                progressBar(progress.completedRequired, progress.totalRequired || 1)),
              h('span', { class: 'text-xs text-muted' },
                progress.completedRequired, '/', progress.totalRequired, ' required'),
            ),

            h('div', { class: 'flex gap-3 mt-3' },
              h('button', { class: 'btn btn--primary', onClick: () => navigate('/inspection/' + inspectionId) }, 'Open editor'),
              h('button', {
                class: 'btn btn--secondary',
                onClick: async () => {
                  try {
                    const res = await api.regenerateTenantToken(inspectionId);
                    showTenantLinkInModal(res.tenantUrl, res.expiresAt);
                  } catch (e) {
                    toastError(e.message);
                  }
                }
              }, 'New tenant link'),
              canUnlock
                ? h('button', {
                    class: 'btn btn--secondary',
                    onClick: async () => {
                      const ok = await confirm({
                        title: 'Unlock inspection?',
                        message: 'This will invalidate all collected signatures. The tenant link will need to be re-shared.',
                        confirmLabel: 'Unlock',
                        danger: true,
                      });
                      if (!ok) return;
                      try {
                        const res = await api.unlockInspection(inspectionId, 'admin requested');
                        toastSuccess('Unlocked.');
                        await applyMutationState(res, inspectionId);
                        render();
                      } catch (e) {
                        toastError(e.message);
                      }
                    },
                  }, 'Unlock')
                : null,
            ),

            i.finalPdfFileId
              ? h('button', {
                  class: 'btn btn--primary btn--block mt-3',
                  disabled: downloading || undefined,
                  onClick: () => downloadFinalPdf(inspectionId, setDownloading),
                }, downloading ? 'Preparing…' : 'Download final PDF')
              : null,
          )
        )
      )
    );
  }

  render();
}

function showTenantLinkInModal(url, expiresAt) {
  const linkInput = h('input', {
    type: 'text', class: 'form-input text-mono text-sm', value: url, readonly: true,
    onClick: (e) => e.target.select(),
  });
  const m = openModal({
    title: 'New tenant link',
    body: h('div', null,
      linkInput,
      h('p', { class: 'text-xs text-muted mt-2' }, 'Expires: ' + formatDateTime(expiresAt)),
      h('p', { class: 'text-xs text-muted mt-2' }, 'Note: previous tenant links are now invalid.'),
    ),
    footer: [
      h('button', { class: 'btn btn--secondary', onClick: () => {
        navigator.clipboard.writeText(url).then(() => toastSuccess('Copied'));
      }}, 'Copy'),
      h('button', { class: 'btn btn--primary', onClick: () => m.close() }, 'Done'),
    ],
  });
}

// ============================================================
// Shared spinners / errors
// ============================================================

function showSpinner(label) {
  mount(root(),
    h('div', { class: 'boot-screen', 'aria-busy': 'true' },
      h('div', { class: 'boot-spinner' }),
      h('p', null, label || 'Loading…'),
    )
  );
}

function showError(title, message) {
  mount(root(),
    h('div', { class: 'app-layout' },
      appHeader({ title: 'Error', onBack: () => navigate('/') }),
      h('main', { class: 'app-body' },
        h('div', { class: 'page' },
          h('div', { class: 'banner banner--danger' },
            h('div', { class: 'banner__icon' }, '!'),
            h('div', { class: 'banner__body' },
              h('div', { class: 'banner__title' }, title),
              message)),
        )
      )
    )
  );
}
