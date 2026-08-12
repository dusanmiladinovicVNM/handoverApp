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
  questionCard, signatureCanvas, langToggle
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
import { t, tn, tc } from './i18n.js';
import { readJson, writeJson, CACHE_KEYS } from './utils/store.js';
import { rememberDraft, forgetDraft, readDraft, draftSectionIds } from './utils/drafts.js';
import { track as trackSave, settled as savesSettled } from './utils/pending-saves.js';
import {
  login as authLogin, setPassword as authSetPassword,
  signOut as authSignOut, suggestDeviceLabel,
} from './auth.js';

const root = () => document.getElementById('app-root');

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

export function pageLogin() {
  let email = '';
  let password = '';
  let remember = true;
  let busy = false;
  let error = null;

  async function submit(e) {
    if (e) e.preventDefault();
    if (!email.trim() || !password) {
      error = t('login.missingFields');
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
      toastSuccess(t('login.welcome', { name: user.name }));
      navigate('/admin');
    } catch (err) {
      // The server answers identically for an unknown address, a wrong
      // password and a disabled account, so that the form cannot be used to
      // find out who works here. Passing its message straight through keeps
      // that property intact.
      error = err.message || t('login.failed');
      password = '';
      busy = false;
      render();
    }
  }

  function render() {
    const state = getState();
    mount(root(), authShell(t('login.title'),
      h('form', { class: 'card', onSubmit: submit },
        h('h2', { class: 'card__title' }, t('login.title')),
        h('p', { class: 'text-muted text-sm mt-2' }, t('login.intro')),

        error || state.authError
          ? h('div', { class: 'banner banner--danger mt-3' },
              h('div', { class: 'banner__icon' }, '!'),
              h('div', { class: 'banner__body' }, error || state.authError))
          : null,

        h('div', { class: 'mt-4' },
          formField(t('login.email'), {
            type: 'email',
            autocomplete: 'username',
            inputmode: 'email',
            value: email,
            autofocus: true,
            onInput: (e) => { email = e.target.value; },
          }),
          formField(t('login.password'), {
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
          h('span', null, t('login.remember')),
        ),

        h('button', {
          type: 'submit',
          class: 'btn btn--primary btn--block mt-4',
          disabled: busy || undefined,
        }, busy ? t('login.submitting') : t('login.submit')),

        h('p', { class: 'text-sm mt-4', style: { textAlign: 'center' } },
          h('a', { href: '#/forgot-password' }, t('login.forgot'))),

        h('hr', { style: { border: 'none', borderTop: '1px solid var(--color-border)', margin: '1.5rem 0' }}),
        h('p', { class: 'text-xs text-muted' }, t('login.tenantNote')),
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
      error = t('setPassword.mismatch');
      render();
      return;
    }
    busy = true; error = null; render();
    try {
      const user = await authSetPassword({
        token, password, remember, deviceLabel: suggestDeviceLabel(),
      });
      toastSuccess(t('setPassword.welcome', { name: user.name }));
      navigate('/admin');
    } catch (err) {
      // Length and common-padding rules are enforced on the server, so its
      // wording is the authoritative one. Repeating the rules here would mean
      // two places to keep in step, and the client copy losing.
      error = err.message || t('setPassword.failed');
      busy = false;
      render();
    }
  }

  function render() {
    if (!token) {
      mount(root(), authShell(t('setPassword.title'),
        h('div', { class: 'card' },
          h('h2', { class: 'card__title' }, t('setPassword.incompleteTitle')),
          h('p', { class: 'text-muted text-sm mt-2' }, t('setPassword.incompleteBody')),
          h('a', { class: 'btn btn--secondary btn--block mt-4', href: '#/forgot-password' },
            t('setPassword.newLink')),
        )
      ));
      return;
    }

    mount(root(), authShell(t('setPassword.title'),
      h('form', { class: 'card', onSubmit: submit },
        h('h2', { class: 'card__title' }, t('setPassword.choose')),
        h('p', { class: 'text-muted text-sm mt-2' }, t('setPassword.advice')),

        error
          ? h('div', { class: 'banner banner--danger mt-3' },
              h('div', { class: 'banner__icon' }, '!'),
              h('div', { class: 'banner__body' }, error))
          : null,

        h('div', { class: 'mt-4' },
          formField(t('setPassword.new'), {
            type: 'password',
            autocomplete: 'new-password',
            autofocus: true,
            onInput: (e) => { password = e.target.value; },
          }, t('setPassword.minLength')),
          formField(t('setPassword.repeat'), {
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
          h('span', null, t('login.remember')),
        ),

        h('button', {
          type: 'submit',
          class: 'btn btn--primary btn--block mt-4',
          disabled: busy || undefined,
        }, busy ? t('action.saving') : t('setPassword.submit')),

        h('p', { class: 'text-xs text-muted mt-3' }, t('setPassword.signsOutOthers')),
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
      error = err.message || t('forgot.failed');
    } finally {
      busy = false;
      render();
    }
  }

  function render() {
    mount(root(), authShell(t('forgot.title'),
      sent
        ? h('div', { class: 'card' },
            h('h2', { class: 'card__title' }, t('forgot.sentTitle')),
            // Deliberately not "we sent you an email": the server answers the
            // same way whether or not the address has an account, and saying
            // more here would give away what it withholds.
            h('p', { class: 'text-muted text-sm mt-2' }, t('forgot.sentBody')),
            h('a', { class: 'btn btn--secondary btn--block mt-4', href: '#/login' },
              t('forgot.backToLogin')))
        : h('form', { class: 'card', onSubmit: submit },
            h('h2', { class: 'card__title' }, t('forgot.formTitle')),
            h('p', { class: 'text-muted text-sm mt-2' }, t('forgot.formBody')),
            error
              ? h('div', { class: 'banner banner--danger mt-3' },
                  h('div', { class: 'banner__icon' }, '!'),
                  h('div', { class: 'banner__body' }, error))
              : null,
            h('div', { class: 'mt-4' },
              formField(t('login.email'), {
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
            }, busy ? t('forgot.submitting') : t('forgot.submit')),
            h('p', { class: 'text-sm mt-4', style: { textAlign: 'center' } },
              h('a', { href: '#/login' }, t('forgot.backToLogin'))),
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
      error = t('profile.mismatch');
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
      toastSuccess(t('profile.changed'));
      navigate('/login');
    } catch (err) {
      error = err.message || t('profile.failed');
      busy = false;
      render();
    }
  }

  function render() {
    const user = getState().user || {};
    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({ title: t('profile.title'), onBack: () => navigate('/admin') }),
        h('main', { class: 'app-body' },
          h('div', { class: 'page' },
            h('div', { class: 'card' },
              h('h2', { class: 'card__title' }, user.name || ''),
              h('p', { class: 'text-muted text-sm mt-1' }, user.email || ''),
              h('p', { class: 'text-sm mt-3' },
                h('span', { class: 'badge' }, t(user.role === 'admin' ? 'role.admin' : 'role.inspector'))),
            ),

            // The switch in the header is a two-letter chip, which is right for
            // a bar someone glances at and wrong for the one screen where they
            // came looking for the setting. Same state, named in full.
            h('div', { class: 'card mt-4' },
              h('h2', { class: 'card__title' }, t('profile.language')),
              h('div', { class: 'mt-3' }, langToggle()),
              h('p', { class: 'form-hint text-xs text-muted mt-2' }, t('profile.languageHint')),
            ),

            h('form', { class: 'card mt-4', onSubmit: submit },
              h('h2', { class: 'card__title' }, t('profile.changePassword')),
              h('p', { class: 'text-muted text-sm mt-2' }, t('profile.changeWarning')),
              error
                ? h('div', { class: 'banner banner--danger mt-3' },
                    h('div', { class: 'banner__icon' }, '!'),
                    h('div', { class: 'banner__body' }, error))
                : null,
              h('div', { class: 'mt-4' },
                formField(t('profile.current'), {
                  type: 'password',
                  autocomplete: 'current-password',
                  onInput: (e) => { oldPassword = e.target.value; },
                }),
                formField(t('profile.new'), {
                  type: 'password',
                  autocomplete: 'new-password',
                  onInput: (e) => { newPassword = e.target.value; },
                }, t('setPassword.minLength')),
                formField(t('profile.repeat'), {
                  type: 'password',
                  autocomplete: 'new-password',
                  onInput: (e) => { confirmValue = e.target.value; },
                }),
              ),
              h('button', {
                type: 'submit',
                class: 'btn btn--primary btn--block mt-2',
                disabled: busy || undefined,
              }, busy ? t('action.saving') : t('profile.changePassword')),
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

  // Keys, not words. The labels are looked up at render time so the chips
  // follow a language change like everything else.
  const FILTERS = ['all', 'active', 'disabled', 'admin', 'nopassword', 'locked'];

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
      t(u.role === 'admin' ? 'role.admin' : 'role.inspector')));
    if (u.status === 'disabled') {
      out.push(h('span', { class: 'badge badge--danger' }, t('users.badge.disabled')));
    }
    if (u.lockedUntil) {
      out.push(h('span', { class: 'badge badge--warning' }, t('users.badge.locked')));
    }
    // Derived rather than stored: a third status would be a third state to
    // keep consistent, and this says the same thing.
    if (!u.hasPassword) {
      out.push(h('span', { class: 'badge badge--warning' }, t('users.badge.noPassword')));
    }
    return out;
  }

  // --- Add user ---

  function openAddUser() {
    let name = '', email = '', role = 'inspector';
    let busy = false;

    const errorSlot = h('div');
    const body = h('div', null,
      formField(t('users.name'), { autofocus: true, onInput: (e) => { name = e.target.value; } }),
      formField(t('users.email'), {
        type: 'email', inputmode: 'email',
        onInput: (e) => { email = e.target.value; },
      }),
      h('div', { class: 'form-group' },
        h('label', { class: 'form-label' }, t('users.role')),
        h('select', {
          class: 'form-select',
          onChange: (e) => { role = e.target.value; },
        },
          h('option', { value: 'inspector' }, t('role.inspector')),
          h('option', { value: 'admin' }, t('role.admin')),
        ),
      ),
      h('p', { class: 'text-xs text-muted' }, t('users.addNote')),
      errorSlot,
    );

    const submitBtn = h('button', { class: 'btn btn--primary', onClick: submit }, t('users.addTitle'));
    const modal = openModal({
      title: t('users.addTitle'),
      body,
      footer: [
        h('button', { class: 'btn btn--secondary', onClick: () => modal.close() }, t('action.cancel')),
        submitBtn,
      ],
    });

    async function submit() {
      if (busy) return;
      busy = true;
      submitBtn.textContent = t('users.adding');
      submitBtn.setAttribute('disabled', '');
      try {
        const res = await api.createUser(name.trim(), email.trim(), role);
        modal.close();
        await load();
        // Creating the account and delivering the link are separate things,
        // and only one of them can fail. Saying which is what lets the admin
        // act: resend, or hand the link over another way.
        if (res.delivery && res.delivery.emailed) {
          toastSuccess(t('users.added', { name: res.user.name, email: res.user.email }));
        } else {
          showLinkFallback(res.user, res.delivery);
        }
      } catch (e) {
        busy = false;
        submitBtn.textContent = t('users.addTitle');
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
      title: t('users.mailFailedTitle'),
      body: h('div', null,
        h('p', { class: 'text-sm' }, t('users.mailFailedBody', { email: user.email })),
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
            try { document.execCommand('copy'); toastSuccess(t('users.linkCopied')); }
            catch (_) { toastWarning(t('users.copyManually')); }
          },
        }, t('action.copyLink')),
        h('button', { class: 'btn btn--primary', onClick: () => modal.close() }, t('action.done')),
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
          detailRow(t('users.detail.lastSignIn'),
            u.lastLoginAt ? formatDateTime(u.lastLoginAt) : t('users.detail.never')),
          detailRow(t('users.detail.activeDevices'), String(u.deviceCount || 0)),
          detailRow(t('users.detail.created'), u.createdAt ? formatDateTime(u.createdAt) : '—'),
          u.createdBy ? detailRow(t('users.detail.createdBy'), u.createdBy) : null,
          u.status === 'disabled' && u.disabledAt
            ? detailRow(t('users.detail.disabled'), t('users.detail.disabledBy', {
                when: formatDateTime(u.disabledAt), who: u.disabledBy || '—',
              }))
            : null,
          u.lockedUntil ? detailRow(t('users.detail.lockedUntil'), formatDateTime(u.lockedUntil)) : null,
        ),

        h('div', { class: 'mt-4' },
          h('h3', { class: 'text-sm text-muted' }, t('users.detail.actions')),

          h('div', { class: 'stack mt-2' },
            // Status
            u.status === 'active'
              ? h('div', null,
                  h('button', {
                    class: 'btn btn--danger btn--block',
                    disabled: (isSelf || isLastAdmin) || undefined,
                    onClick: () => confirmAnd(modal,
                      t('users.disableTitle'),
                      t('users.disableMessage', { name: u.name }),
                      t('users.disableConfirm'), true,
                      () => api.setUserStatus(u.userId, 'disabled'),
                      t('users.disabled', { name: u.name })),
                  }, t('users.disable')),
                  guard(isSelf ? t('users.disableSelf')
                    : isLastAdmin ? t('users.onlyAdmin') : null))
              : h('button', {
                  class: 'btn btn--primary btn--block',
                  onClick: () => confirmAnd(modal,
                    t('users.restoreTitle'),
                    t('users.restoreMessage', { name: u.name }),
                    t('users.restoreConfirm'), false,
                    () => api.setUserStatus(u.userId, 'active'),
                    t('users.restored', { name: u.name })),
                }, t('users.restore')),

            // Role
            u.role === 'admin'
              ? h('div', null,
                  h('button', {
                    class: 'btn btn--secondary btn--block',
                    disabled: (isSelf || isLastAdmin) || undefined,
                    onClick: () => confirmAnd(modal,
                      t('users.revokeAdminTitle'),
                      t('users.revokeAdminMessage', { name: u.name }),
                      t('users.revokeAdminConfirm'), false,
                      () => api.setUserRole(u.userId, 'inspector'),
                      t('users.revokedAdmin', { name: u.name })),
                  }, t('users.revokeAdmin')),
                  guard(isSelf ? t('users.revokeAdminSelf')
                    : isLastAdmin ? t('users.promoteSomeoneFirst') : null))
              : h('button', {
                  class: 'btn btn--secondary btn--block',
                  onClick: () => confirmAnd(modal,
                    t('users.grantAdminTitle'),
                    t('users.grantAdminMessage', { name: u.name }),
                    t('users.grantAdminConfirm'), false,
                    () => api.setUserRole(u.userId, 'admin'),
                    t('users.grantedAdmin', { name: u.name })),
                }, t('users.grantAdmin')),

            u.lockedUntil
              ? h('button', {
                  class: 'btn btn--secondary btn--block',
                  onClick: () => { modal.close(); act(() => api.unlockUser(u.userId), t('users.unlocked')); },
                }, t('users.unlock'))
              : null,

            u.status === 'active'
              ? h('button', {
                  class: 'btn btn--secondary btn--block',
                  onClick: async () => {
                    modal.close();
                    const res = await act(() => api.sendPasswordLink(u.userId), null);
                    if (!res) return;
                    if (res.delivery && res.delivery.emailed) toastSuccess(t('users.linkSent', { email: u.email }));
                    else showLinkFallback(u, res.delivery);
                  },
                }, t(u.hasPassword ? 'users.sendReset' : 'users.resendInvite'))
              : null,

            u.deviceCount > 0
              ? h('button', {
                  class: 'btn btn--secondary btn--block',
                  onClick: () => { modal.close(); openDevices(u); },
                }, t('users.devicesButton', { count: u.deviceCount }))
              : null,

            h('button', {
              class: 'btn btn--ghost btn--block',
              onClick: () => { modal.close(); openHistory(u); },
            }, t('users.history')),
          )
        )
      ),
      footer: [h('button', { class: 'btn btn--secondary', onClick: () => modal.close() }, t('action.close'))],
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
      title: t('users.devicesTitle', { name: u.name }),
      body: slot,
      footer: [h('button', { class: 'btn btn--secondary', onClick: () => modal.close() }, t('action.close'))],
    });

    api.listUserDevices(u.userId).then(res => {
      const devices = res.devices || [];
      mount(slot,
        devices.length === 0
          ? h('p', { class: 'text-muted text-sm' }, t('users.noDevices'))
          : h('ul', { class: 'list' },
              devices.map(d => h('li', { class: 'list-item' },
                h('div', { class: 'list-item__main' },
                  h('div', { class: 'list-item__title' }, d.label),
                  h('div', { class: 'list-item__meta' }, t('users.deviceMeta', {
                    lastSeen: formatDateTime(d.lastSeenAt), expires: formatDate(d.expiresAt),
                  })),
                ),
                h('button', {
                  class: 'btn btn--sm btn--danger',
                  onClick: async () => {
                    modal.close();
                    await act(() => api.revokeDevice(d.deviceId), t('users.deviceSignedOut'));
                  },
                }, t('users.signOutDevice')),
              ))),
        devices.length > 1
          ? h('button', {
              class: 'btn btn--danger btn--block mt-4',
              onClick: async () => {
                modal.close();
                await act(() => api.revokeAllDevices(u.userId), t('users.allSignedOut'));
              },
            }, t('users.signOutAll'))
          : null,
      );
    }).catch(e => {
      mount(slot, h('div', { class: 'banner banner--danger' }, e.message));
    });
  }

  function openHistory(u) {
    const slot = h('div', null, h('div', { class: 'boot-spinner' }));
    const modal = openModal({
      title: t('users.historyTitle', { name: u.name }),
      body: slot,
      footer: [h('button', { class: 'btn btn--secondary', onClick: () => modal.close() }, t('action.close'))],
    });

    api.getAuthLog(u.userId, 100).then(res => {
      const events = res.events || [];
      mount(slot,
        events.length === 0
          ? h('p', { class: 'text-muted text-sm' }, t('users.noHistory'))
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
          title: t('users.title'),
          subtitle: tn('users.activeAdmins', activeAdmins),
          onBack: () => navigate('/admin'),
          actions: [
            h('button', {
              class: 'btn btn--sm btn--ghost',
              style: { color: 'white' },
              onClick: openAddUser,
            }, t('users.add')),
          ],
        }),
        h('main', { class: 'app-body' },
          h('div', { class: 'page' },
            h('div', { class: 'filter-bar' },
              h('input', {
                class: 'form-input',
                type: 'search',
                placeholder: t('users.search'),
                value: search,
                onInput: (e) => { search = e.target.value; renderList(); },
              }),
              h('div', { class: 'chip-row mt-2' },
                FILTERS.map(key => h('button', {
                  class: ['chip', filter === key ? 'chip--active' : ''],
                  onClick: () => { filter = key; render(); },
                }, t('users.filter.' + key)))),
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
        h('h2', { class: 'empty-state__title' }, t('users.noneTitle')),
        h('p', { class: 'empty-state__description' }, t('users.noneBody'))));
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
            u.lastLoginAt
              ? t('users.lastSignIn', { when: formatDateTime(u.lastLoginAt) })
              : t('users.neverSignedIn'),
            u.deviceCount ? ' · ' + tn('users.devices', u.deviceCount) : ''),
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

/**
 * The sheet stores an event type; the screen shows a sentence.
 *
 * event.device_registered is kept although signing in no longer writes it — it
 * fired on exactly the same occasions as login_succeeded, which now carries the
 * device label itself — because rows already in the sheet still say it.
 *
 * An unknown type is shown as it was stored rather than as a missing key: this
 * log is read when something has gone wrong, and a raw event name is worth more
 * then than a blank.
 */
function humanEvent(type) {
  const key = 'event.' + type;
  const label = t(key);
  return label === key ? type : label;
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
      else toastWarning(t('list.refreshFailed'));
    } finally {
      loading = false;
      render();
    }
  }

  function render() {
    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({
          title: t('list.title'),
          subtitle: (getState().user && getState().user.name) || '',
          // The one header with no room. Five actions already fill the bar on a
          // phone, and measured on a 390 px screen the switch took another 74 —
          // enough to clip the title to "Pr…". Everyone who sees this screen is
          // signed in and so has a profile, where the switch is spelled out in
          // full; the tenant screens, which have no profile, keep it.
          lang: false,
          actions: [
            h('button', {
              class: 'btn btn--sm btn--ghost',
              style: { color: 'white' },
              onClick: () => navigate('/admin/new'),
            }, t('list.new')),
            h('button', {
              class: 'btn btn--sm btn--ghost',
              style: { color: 'white' },
              title: t('list.refresh'),
              onClick: () => { invalidateCachedList(); load(); },
            }, '⟳'),
            isAdmin()
              ? h('button', {
                  class: 'btn btn--sm btn--ghost',
                  style: { color: 'white' },
                  title: t('list.users'),
                  onClick: () => navigate('/admin/users'),
                }, '👥')
              : null,
            h('button', {
              class: 'btn btn--sm btn--ghost',
              style: { color: 'white' },
              title: t('list.account'),
              onClick: () => navigate('/profile'),
            }, '⚙'),
            h('button', {
              class: 'btn btn--sm btn--ghost',
              style: { color: 'white' },
              title: t('list.signOut'),
              onClick: async () => {
                const ok = await confirm({
                  title: t('list.signOutTitle'),
                  message: t('list.signOutMessage'),
                  confirmLabel: t('list.signOut'),
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
                      h('h2', { class: 'empty-state__title' }, t('list.emptyTitle')),
                      h('p', { class: 'empty-state__description' }, t('list.emptyBody')),
                      h('button', { class: 'btn btn--primary mt-4', onClick: () => navigate('/admin/new') }, t('list.emptyAction')))
                  : visibleRows().length === 0
                  ? h('div', { class: 'empty-state' },
                      h('div', { class: 'empty-state__icon' }, '○'),
                      h('h2', { class: 'empty-state__title' }, t('list.noMatchTitle')),
                      h('p', { class: 'empty-state__description' }, t('list.noMatchBody')))
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
                          h('div', { class: 'list-item__title' }, i.propertyAddress || t('list.noAddress')),
                          badge(i.status),
                        ),
                        h('div', { class: 'list-item__meta' },
                          inspectionTypeLabel(i.inspectionType), ' · ',
                          i.tenantName || t('list.noTenant'), ' · ',
                          formatDate(i.updatedAt),
                        ),
                        // Shown to admins only. An inspector's list contains
                        // nothing but their own work, where repeating their
                        // name on every row says nothing.
                        isAdmin() && i.assignedTo
                          ? h('div', { class: 'list-item__meta' },
                              t('list.assignedTo'), i.assignedToName || i.assignedTo)
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
        placeholder: t('list.search'),
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
      toastWarning(t('new.needType'));
      return;
    }
    if (!form.property.addressLine1) {
      toastWarning(t('new.needAddress'));
      return;
    }
    if (!form.parties.landlord.name || !form.parties.tenant.name) {
      toastWarning(t('new.needParties'));
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
      toastSuccess(t('new.created'));
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
      title: t('new.createdTitle'),
      body: h('div', null,
        h('p', null, h('strong', null, t('new.idLabel')), h('span', { class: 'text-mono' }, inspectionId)),
        h('p', { class: 'mt-3' }, t('new.tenantLink')),
        linkInput,
        h('p', { class: 'text-xs text-muted mt-3' }, t('new.tenantLinkNote')),
      ),
      footer: [
        h('button', { class: 'btn btn--secondary', onClick: () => {
          navigator.clipboard.writeText(tenantUrl).then(() => toastSuccess(t('new.copied')));
        }}, t('action.copyLink')),
        h('button', { class: 'btn btn--primary', onClick: () => {
          modal.close();
          navigate('/admin/inspection/' + inspectionId);
        }}, t('new.open')),
      ],
    });
  }

  function update() {
    render();
  }

  function render() {
    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({ title: t('new.title'), onBack: () => back() }),
        h('main', { class: 'app-body app-body--has-bottom-bar' },
          h('div', { class: 'page' },
            loading
              ? h('div', { class: 'boot-spinner' })
              : h('div', { class: 'card' },
                  h('div', { class: 'form-group' },
                    h('label', { class: 'form-label' }, t('new.type') + ' ', h('span', { class: 'form-label__required' }, '*')),
                    h('select', {
                      class: 'form-select',
                      onChange: (e) => {
                        const sch = schemas.find(s => s.schemaId === e.target.value);
                        form.schemaId = e.target.value;
                        form.inspectionType = sch ? sch.inspectionType : '';
                      },
                    },
                      h('option', { value: '' }, t('input.choose')),
                      schemas.map(s => h('option', { value: s.schemaId }, tc(s.title))),
                    ),
                  ),
                  h('hr', { style: { border: 'none', borderTop: '1px solid var(--color-border)', margin: '1rem 0' }}),
                  h('h3', { class: 'page__section-title' }, t('new.property')),
                  h('div', { class: 'form-group' },
                    h('label', { class: 'form-label' }, t('new.address') + ' ', h('span', { class: 'form-label__required' }, '*')),
                    h('input', { type: 'text', class: 'form-input', placeholder: t('new.addressPlaceholder'), value: form.property.addressLine1,
                      onInput: (e) => form.property.addressLine1 = e.target.value }),
                  ),
                  h('div', { class: 'form-inline' },
                    h('div', { class: 'form-group' },
                      h('label', { class: 'form-label' }, t('new.city')),
                      h('input', { type: 'text', class: 'form-input', value: form.property.city,
                        onInput: (e) => form.property.city = e.target.value }),
                    ),
                    h('div', { class: 'form-group' },
                      h('label', { class: 'form-label' }, t('new.postalCode')),
                      h('input', { type: 'text', class: 'form-input', value: form.property.postalCode,
                        onInput: (e) => form.property.postalCode = e.target.value }),
                    ),
                  ),
                  h('div', { class: 'form-group' },
                    h('label', { class: 'form-label' }, t('new.unit')),
                    h('input', { type: 'text', class: 'form-input', value: form.property.unitNumber,
                      onInput: (e) => form.property.unitNumber = e.target.value }),
                  ),

                  h('hr', { style: { border: 'none', borderTop: '1px solid var(--color-border)', margin: '1rem 0' }}),
                  h('h3', { class: 'page__section-title' }, t('new.landlord')),
                  partyFields(form.parties.landlord),

                  h('hr', { style: { border: 'none', borderTop: '1px solid var(--color-border)', margin: '1rem 0' }}),
                  h('h3', { class: 'page__section-title' }, t('new.tenant')),
                  partyFields(form.parties.tenant),

                  h('hr', { style: { border: 'none', borderTop: '1px solid var(--color-border)', margin: '1rem 0' }}),

                  // Only admins see this. An inspector creating their own job
                  // is implicitly its owner, and offering them a list of
                  // colleagues to hand it to would be a permission they do not
                  // have.
                  isAdmin()
                    ? h('div', { class: 'form-group' },
                        h('label', { class: 'form-label' }, t('new.assignTo')),
                        h('select', {
                          class: 'form-select',
                          onChange: (e) => { form.assignedTo = e.target.value; },
                        },
                          h('option', { value: '' }, t('new.assignMe')),
                          assignableUsers.map(u => h('option', { value: u.email }, u.name)),
                        ),
                        h('p', { class: 'form-hint text-xs text-muted' }, t('new.assignHint')),
                      )
                    : null,

                  h('div', { class: 'form-group' },
                    h('label', { class: 'form-label' }, t('new.notes')),
                    h('textarea', {
                      class: 'form-textarea',
                      onInput: (e) => form.notes = e.target.value,
                    }, form.notes),
                  ),
                ),
          ),
        ),
        bottomBar(
          h('button', { class: 'btn btn--secondary', onClick: () => back() }, t('action.cancel')),
          h('button', {
            class: 'btn btn--primary bottom-bar__primary',
            disabled: submitting || undefined,
            onClick: submit,
          }, submitting ? t('new.submitting') : t('new.submit')),
        ),
      )
    );
  }

  function partyFields(party) {
    return h('div', null,
      h('div', { class: 'form-group' },
        h('label', { class: 'form-label' }, t('new.name') + ' ', h('span', { class: 'form-label__required' }, '*')),
        h('input', { type: 'text', class: 'form-input', value: party.name,
          onInput: (e) => party.name = e.target.value }),
      ),
      h('div', { class: 'form-inline' },
        h('div', { class: 'form-group' },
          h('label', { class: 'form-label' }, t('new.email')),
          h('input', { type: 'email', class: 'form-input', value: party.email,
            onInput: (e) => party.email = e.target.value }),
        ),
        h('div', { class: 'form-group' },
          h('label', { class: 'form-label' }, t('new.phone')),
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
  if (!getState().inspection || getState().inspection.inspectionId !== inspectionId) {
    showSpinner(t('inspection.loading'));
    try {
      const data = await api.getInspection(inspectionId);
      setInspectionData(data);
    } catch (e) {
      return showError(t('inspection.loadFailed'), e.message);
    }
  }

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
        h('span', { class: 'section-list__title' }, tc(section.title)),
        unsent.has(section.id)
          ? h('span', {
              class: 'badge badge--warning',
              title: t('inspection.unsavedHint'),
            }, t('inspection.unsaved'))
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
          ? t('inspection.reviewLock')
          : t('inspection.completeMore', {
              count: progress.totalRequired - progress.completedRequired,
            }));
    } else if (canSign) {
      actionButton = h('button', {
        class: 'btn btn--primary bottom-bar__primary',
        onClick: () => navigate(`/inspection/${inspectionId}/sign`),
      }, t('inspection.goSign'));
    } else if (insp.status === 'signed') {
      actionButton = h('button', {
        class: 'btn btn--primary bottom-bar__primary',
        onClick: () => navigate(`/inspection/${inspectionId}/success`),
      }, t('inspection.viewReport'));
    }

    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({
          title: insp.propertyAddress || t('inspection.fallbackTitle'),
          subtitle: `${inspectionTypeLabel(insp.inspectionType)} · ${insp.inspectionId}`,
          onBack: isStaff ? () => navigate('/admin') : null,
        }),
        h('main', { class: 'app-body app-body--has-bottom-bar' },
          h('div', { class: 'page' },
            h('div', { class: 'flex justify-between items-center' },
              badge(insp.status),
              h('span', { class: 'text-sm text-muted' },
                progress.completedRequired, '/', progress.totalRequired,
                t('inspection.requiredCount')),
            ),
            progressBar(progress.completedRequired, progress.totalRequired || 1),

            insp.status === 'locked_for_signature' || insp.status === 'partially_signed'
              ? h('div', { class: 'banner banner--info' },
                  h('div', { class: 'banner__icon' }, 'i'),
                  h('div', { class: 'banner__body' },
                    h('div', { class: 'banner__title' }, t('inspection.awaitingTitle')),
                    t('inspection.awaitingBody')))
              : null,

            insp.status === 'signed'
              ? h('div', { class: 'banner banner--success' },
                  h('div', { class: 'banner__icon' }, '✓'),
                  h('div', { class: 'banner__body' },
                    h('div', { class: 'banner__title' }, t('inspection.signedTitle')),
                    t('inspection.signedBody')))
              : null,

            h('h2', { class: 'page__section-title' }, t('inspection.sections')),
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
  if (!getState().inspection || getState().inspection.inspectionId !== inspectionId) {
    showSpinner(t('boot.loading'));
    try {
      const data = await api.getInspection(inspectionId);
      setInspectionData(data);
    } catch (e) {
      return showError(t('inspection.loadFailed'), e.message);
    }
  }

  const state = getState();
  const section = (state.schema.sections || []).find(s => s.id === sectionId);
  if (!section) {
    return showError(t('section.notFound'), t('section.notFoundBody', { id: sectionId }));
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
          toastError(t('section.conflict'));
          return;
        }
        toastError(t('section.saveFailed', {
          code: e.code || 'unknown', message: e.message || '',
        }));
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
          title: tc(section.title),
          subtitle: insp.propertyAddress,
          // The save indicator owns the actions slot here; the language switch
          // is one screen away, on the section list this came from.
          lang: false,
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
            section.description ? h('p', { class: 'text-muted text-sm' }, tc(section.description)) : null,
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
          }, t('section.sections')),
          nextSection
            ? h('button', {
                class: 'btn btn--primary bottom-bar__primary',
                onClick: () => {
                  flushSave();
                  navigate(`/inspection/${inspectionId}/section/${nextSection.id}`);
                },
              }, t('section.next', { title: tc(nextSection.title) }))
            : h('button', {
                class: 'btn btn--primary bottom-bar__primary',
                onClick: () => {
                  flushSave();
                  navigate('/inspection/' + inspectionId);
                },
              }, t('section.done')),
        ),
      )
    );
  }

  render();

  // Said out loud, and sent straight away. Restoring silently would leave
  // someone looking at answers with no way to tell whether they are safe —
  // which is the state this whole mechanism exists to end.
  if (restoredIds.length > 0) {
    toastWarning(tn('section.restored', restoredIds.length));
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

  if (!getState().inspection || getState().inspection.inspectionId !== inspectionId) {
    showSpinner(t('boot.loading'));
    try {
      const data = await api.getInspection(inspectionId);
      setInspectionData(data);
    } catch (e) {
      return showError(t('inspection.loadFailed'), e.message);
    }
  }

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
      return Object.assign({ sectionTitle: (section && tc(section.title)) || m.sectionId }, m);
    });
  }

  async function doLock() {
    const ok = await confirm({
      title: t('review.lockTitle'),
      message: t('review.lockMessage'),
      confirmLabel: t('review.lockConfirm'),
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
      toastSuccess(t('review.locked'));
      navigate(`/inspection/${inspectionId}/sign`);
    } catch (e) {
      if (e.code === 'VALIDATION_FAILED' && e.details && e.details.missingItems) {
        serverMissing = withSectionTitles(e.details.missingItems);
        // Named, not counted. "1 required items missing" on a screen that says
        // everything is complete leaves someone with nowhere to go.
        const first = serverMissing[0];
        toastError(serverMissing.length === 1
          ? t('review.stillMissingOne', { section: first.sectionTitle, label: tc(first.label) })
          : t('review.stillMissingMany', { count: serverMissing.length }));
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
        appHeader({ title: t('review.title'), onBack: () => navigate('/inspection/' + inspectionId) }),
        h('main', { class: 'app-body app-body--has-bottom-bar' },
          h('div', { class: 'page' },
            h('div', { class: 'card' },
              h('h2', { class: 'card__title' }, insp.propertyAddress),
              h('p', { class: 'card__meta' }, inspectionTypeLabel(insp.inspectionType), ' · ', insp.inspectionId),
              h('p', { class: 'card__meta mt-2' },
                h('strong', null, t('review.tenant')), insp.tenantName, ' · ',
                h('strong', null, t('review.landlord')), insp.landlordName,
              ),
            ),

            h('h3', { class: 'page__section-title' }, t('review.requiredItems')),
            missing.length > 0
              ? h('div', { class: 'banner banner--warning' },
                  h('div', { class: 'banner__icon' }, '!'),
                  h('div', { class: 'banner__body' },
                    h('div', { class: 'banner__title' }, tn('review.missing', missing.length)),
                    h('ul', { style: { margin: '0.5rem 0 0 1rem' } },
                      missing.map(m => h('li', null,
                        h('a', {
                          href: '#',
                          onClick: (e) => { e.preventDefault(); navigate(`/inspection/${inspectionId}/section/${m.sectionId}`); },
                        }, tc(m.sectionTitle)), ' — ', tc(m.label),
                        m.reason === 'insufficient_attachments' ? t('review.photosRequired') : '',
                      )),
                    ),
                  ),
                )
              : h('div', { class: 'banner banner--success' },
                  h('div', { class: 'banner__icon' }, '✓'),
                  h('div', { class: 'banner__body' }, t('review.allComplete'))),

            h('h3', { class: 'page__section-title' }, t('review.sectionSummary')),
            h('div', { class: 'list' },
              (schema.sections || []).map(s => {
                const sp = sectionProgress(s, state.answers);
                return h('div', { class: 'list-item', onClick: () => navigate(`/inspection/${inspectionId}/section/${s.id}`) },
                  h('div', { class: 'list-item__row' },
                    h('span', { class: 'list-item__title' }, tc(s.title)),
                    h('span', { class: 'list-item__meta' },
                      sp.totalRequired > 0
                        ? t('review.sectionRequired', { done: sp.completedRequired, total: sp.totalRequired })
                        : t('review.sectionFilled', { done: sp.completedVisible, total: sp.totalVisible })),
                  ),
                );
              }),
            ),
          ),
        ),
        bottomBar(
          h('button', { class: 'btn btn--secondary', onClick: () => navigate('/inspection/' + inspectionId) }, t('action.back')),
          h('button', {
            class: 'btn btn--primary bottom-bar__primary',
            disabled: missing.length > 0 || locking || undefined,
            onClick: doLock,
          }, locking ? t('review.locking') : t('review.lock')),
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

  if (!getState().inspection || getState().inspection.inspectionId !== inspectionId) {
    showSpinner(t('boot.loading'));
    try {
      const data = await api.getInspection(inspectionId);
      setInspectionData(data);
    } catch (e) {
      return showError(t('inspection.loadFailed'), e.message);
    }
  }

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
    return showError(t('sign.cannotTitle'), t('sign.cannotBody'));
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
        appHeader({ title: t('sign.signaturesTitle'), onBack: () => navigate('/inspection/' + inspectionId) }),
        h('main', { class: 'app-body' },
          h('div', { class: 'page' },
            h('div', { class: 'banner banner--success' },
              h('div', { class: 'banner__icon' }, '✓'),
              h('div', { class: 'banner__body' }, t('sign.alreadySigned'))),
            isStaff ? h('button', { class: 'btn btn--primary mt-4', onClick: () => navigate('/admin/inspection/' + inspectionId) }, t('sign.backToAdmin')) : null,
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
        h('label', { class: 'form-label' }, t('sign.signingAs')),
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
            h('span', { class: 'form-check__label' },
              r === 'tenant' ? t('role.tenant') : r === 'landlord' ? t('role.landlord') : r),
          )),
        ),
      );
    }
    return h('div', { class: 'banner banner--info' },
      h('div', { class: 'banner__icon' }, 'i'),
      h('div', { class: 'banner__body' },
        t('sign.signingAsFixed'),
        h('strong', null, t(currentRole === 'tenant' ? 'role.tenant' : 'role.landlord'))));
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
      h('span', { class: 'form-check__label' }, t('sign.accept')),
    );
  }

  function buildSubmitButton() {
    return h('button', {
      class: 'btn btn--primary bottom-bar__primary',
      disabled: submitting || undefined,
      onClick: submit,
    }, submitting ? t('sign.submitting') : t('sign.submit'));
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
        appHeader({ title: t('sign.title'), onBack: () => navigate('/inspection/' + inspectionId) }),
        h('main', { class: 'app-body app-body--has-bottom-bar' },
          h('div', { class: 'page' },
            h('div', { class: 'card' },
              h('h2', { class: 'card__title' }, insp.propertyAddress),
              h('p', { class: 'card__meta' }, inspectionTypeLabel(insp.inspectionType), ' · ', insp.inspectionId),
            ),

            roleSection,

            h('div', { class: 'form-group' },
              h('label', { class: 'form-label' }, t('sign.fullName') + ' ', h('span', { class: 'form-label__required' }, '*')),
              h('input', {
                type: 'text',
                class: 'form-input',
                value: signerName,
                placeholder: currentRole === 'tenant' ? insp.tenantName : insp.landlordName,
                onInput: (e) => { signerName = e.target.value; },
              }),
            ),

            h('div', { class: 'form-group' },
              h('label', { class: 'form-label' }, t('sign.signature') + ' ', h('span', { class: 'form-label__required' }, '*')),
              pad.element,
              h('div', { class: 'signature-pad__actions' },
                h('button', { class: 'btn btn--ghost btn--sm', onClick: () => pad.clear() }, t('signature.clear')),
              ),
            ),

            acceptedRow,
          ),
        ),
        bottomBar(
          h('button', { class: 'btn btn--secondary', onClick: () => navigate('/inspection/' + inspectionId) }, t('action.cancel')),
          submitButton,
        ),
      )
    );
  }

  async function submit() {
    if (!signerName.trim()) { toastWarning(t('sign.needName')); return; }
    if (!accepted) { toastWarning(t('sign.needAccept')); return; }
    if (pad.isEmpty()) { toastWarning(t('sign.needSignature')); return; }

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
      toastSuccess(t('sign.saved'));
      await applyMutationState(result, inspectionId);
    } catch (e) {
      submitting = false;
      updateSubmitButton();
      toastError(e.message || t('sign.failed'));
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
    title: t('final.offerTitle'),
    message: t('final.offerMessage'),
    confirmLabel: t('final.offerConfirm'),
  });
  if (!ok) {
    navigate(`/inspection/${inspectionId}/success`);
    return;
  }
  showSpinner(t('final.generating'));
  try {
    // Applied before navigating, so the success screen — which is where the
    // new PDF's link lives — draws from it instead of fetching it back.
    await applyMutationState(await api.finalizeInspection(inspectionId), inspectionId);
    toastSuccess(t('final.ready'));
    navigate(`/inspection/${inspectionId}/success`);
  } catch (e) {
    toastError(e.message);
    navigate(`/inspection/${inspectionId}/success`);
  }
}

// ============================================================
// pageSuccess
// ============================================================

export async function pageSuccess({ params }) {
  const inspectionId = params.id;

  // Same reuse as the other inspection screens. This one is almost always
  // reached straight after signing or finalising, which have just put the
  // server's own copy into state — fetching it again was a guaranteed round
  // trip for something already in hand.
  if (!getState().inspection || getState().inspection.inspectionId !== inspectionId) {
    showSpinner(t('boot.loading'));
    try {
      setInspectionData(await api.getInspection(inspectionId));
    } catch (e) {
      return showError(t('inspection.loadFailed'), e.message);
    }
  }
  const isStaff = getState().authMode === 'user';

  let finalizing = false;

  async function doFinalize() {
    finalizing = true; render();
    try {
      await applyMutationState(await api.finalizeInspection(inspectionId), inspectionId);
      toastSuccess(t('final.generated'));
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
    const pdfUrl = i.finalPdfFileId ? `https://drive.google.com/file/d/${i.finalPdfFileId}/view` : null;

    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({
          title: t('success.title'),
          onBack: isStaff ? () => navigate('/admin') : null,
        }),
        h('main', { class: 'app-body' },
          h('div', { class: 'page' },
            h('div', { class: 'card text-center' },
              h('div', { style: { fontSize: '3rem', color: 'var(--color-success)' } }, '✓'),
              h('h2', { class: 'card__title mt-3' }, i.status === 'signed' ? t('success.allSigned') : statusLabel(i.status)),
              h('p', { class: 'card__meta mt-2' }, i.propertyAddress),
              h('p', { class: 'card__meta' }, i.inspectionId),
            ),

            pdfUrl
              ? h('a', {
                  class: 'btn btn--primary btn--block mt-4',
                  href: pdfUrl,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                }, t('success.openPdf'))
              : isStaff
                ? h('button', {
                    class: 'btn btn--primary btn--block mt-4',
                    disabled: finalizing || undefined,
                    onClick: doFinalize,
                  }, finalizing ? t('success.generatingShort') : t('success.generate'))
                : h('div', { class: 'banner banner--info mt-4' },
                    h('div', { class: 'banner__icon' }, 'i'),
                    h('div', { class: 'banner__body' }, t('success.waitForLandlord'))),

            isStaff
              ? h('button', { class: 'btn btn--secondary btn--block mt-3', onClick: () => navigate('/admin') },
                  t('success.backToList'))
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
    title: t('assign.title'),
    body: slot,
    footer: [h('button', { class: 'btn btn--secondary', onClick: () => modal.close() }, t('action.cancel'))],
  });

  api.listUsers().then(res => {
    const users = (res.users || []).filter(u => u.status === 'active');
    if (users.length === 0) {
      mount(slot, h('p', { class: 'text-muted text-sm' }, t('assign.none')));
      return;
    }
    mount(slot,
      h('p', { class: 'text-muted text-sm' }, t('assign.who')),
      h('ul', { class: 'list mt-3' },
        users.map(u => h('li', {
          class: 'list-item list-item--clickable',
          onClick: async () => {
            modal.close();
            try {
              const res = await api.assignInspection(inspectionId, u.email);
              invalidateCachedList();
              toastSuccess(t('assign.done', { name: u.name }));
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
            ? h('span', { class: 'badge badge--info' }, t('assign.current'))
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
  if (!getState().inspection || getState().inspection.inspectionId !== inspectionId) {
    showSpinner(t('boot.loading'));
    try {
      const data = await api.getInspection(inspectionId);
      setInspectionData(data);
    } catch (e) {
      return showError(t('inspection.loadFailed'), e.message);
    }
  }

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
          title: i.propertyAddress || t('inspection.fallbackTitle'),
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
                h('div', null, h('strong', null, t('detail.tenant')), i.tenantName, ' (', i.tenantEmail || t('detail.noEmail'), ')'),
                h('div', null, h('strong', null, t('detail.landlord')), i.landlordName),
                h('div', null, h('strong', null, t('detail.created')), formatDate(i.createdAt),
                  t('detail.createdBy'), i.createdBy || t('detail.unknown')),
                h('div', null,
                  h('strong', null, t('detail.assignedTo')),
                  // Falls back to the address when no account matches it any
                  // more — a deleted user should show as something, not blank.
                  i.assignedToName || i.assignedTo
                    || h('span', { class: 'text-muted' }, t('detail.nobody')),
                  isAdmin()
                    ? h('button', {
                        class: 'btn btn--sm btn--ghost',
                        style: { marginLeft: 'var(--space-2)' },
                        onClick: () => openAssign(inspectionId, i.assignedTo),
                      }, t('action.change'))
                    : null,
                ),
              ),
            ),

            h('div', { class: 'flex gap-3 items-center' },
              h('div', { style: { flex: 1 } },
                progressBar(progress.completedRequired, progress.totalRequired || 1)),
              h('span', { class: 'text-xs text-muted' },
                progress.completedRequired, '/', progress.totalRequired,
                t('inspection.requiredCount')),
            ),

            h('div', { class: 'flex gap-3 mt-3' },
              h('button', { class: 'btn btn--primary', onClick: () => navigate('/inspection/' + inspectionId) }, t('detail.openEditor')),
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
              }, t('detail.newTenantLink')),
              canUnlock
                ? h('button', {
                    class: 'btn btn--secondary',
                    onClick: async () => {
                      const ok = await confirm({
                        title: t('detail.unlockTitle'),
                        message: t('detail.unlockMessage'),
                        confirmLabel: t('detail.unlock'),
                        danger: true,
                      });
                      if (!ok) return;
                      try {
                        const res = await api.unlockInspection(inspectionId, t('detail.unlockReason'));
                        toastSuccess(t('detail.unlocked'));
                        await applyMutationState(res, inspectionId);
                        render();
                      } catch (e) {
                        toastError(e.message);
                      }
                    },
                  }, t('detail.unlock'))
                : null,
            ),

            i.finalPdfFileId
              ? h('a', {
                  class: 'btn btn--primary btn--block mt-3',
                  href: `https://drive.google.com/file/d/${i.finalPdfFileId}/view`,
                  target: '_blank', rel: 'noopener',
                }, t('success.openPdf'))
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
    title: t('tenantLink.title'),
    body: h('div', null,
      linkInput,
      h('p', { class: 'text-xs text-muted mt-2' }, t('tenantLink.expires', { when: formatDateTime(expiresAt) })),
      h('p', { class: 'text-xs text-muted mt-2' }, t('tenantLink.previousInvalid')),
    ),
    footer: [
      h('button', { class: 'btn btn--secondary', onClick: () => {
        navigator.clipboard.writeText(url).then(() => toastSuccess(t('new.copied')));
      }}, t('action.copy')),
      h('button', { class: 'btn btn--primary', onClick: () => m.close() }, t('action.done')),
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
      h('p', null, label || t('boot.loading')),
    )
  );
}

function showError(title, message) {
  mount(root(),
    h('div', { class: 'app-layout' },
      appHeader({ title: t('error.title'), onBack: () => navigate('/') }),
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
