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
  getState, setState, setInspectionData, patchAnswer
} from './state.js';
import {
  buildAnswersMap, isItemVisible, sectionProgress,
  inspectionProgress, findAllMissingRequired
} from './validator.js';
import { AUTOSAVE_DEBOUNCE_MS } from './config.js';
import { tryAdminToken, clearAdminToken, saveAdminToken } from './auth.js';

const root = () => document.getElementById('app-root');

// ============================================================
// pageHome — entry routing
// ============================================================

export function pageHome() {
  const state = getState();

  if (state.authMode === 'tenant') {
    navigate('/inspection/' + state.tenantInspectionId, true);
    return;
  }

  if (state.authMode === 'admin') {
    navigate('/admin', true);
    return;
  }

  // Not authenticated → admin login
  navigate('/login', true);
}

// ============================================================
// pageAdminLogin — paste admin token
// ============================================================

export function pageAdminLogin() {
  let token = '';
  let trying = false;

  async function submit() {
    if (!token.trim()) {
      toastWarning('Paste a token first.');
      return;
    }
    trying = true; render();
    const ok = await tryAdminToken(token.trim());
    trying = false;
    if (ok) {
      toastSuccess('Signed in.');
      navigate('/admin');
    } else {
      toastError('Token invalid or expired.');
      render();
    }
  }

  function render() {
    const state = getState();
    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({ title: 'Admin Sign-in' }),
        h('main', { class: 'app-body' },
          h('div', { class: 'page' },
            h('div', { class: 'card' },
              h('h2', { class: 'card__title' }, 'Paste admin token'),
              h('p', { class: 'text-muted text-sm mt-2' },
                'Generate a token in the Apps Script editor by running ',
                h('code', null, 'generateAdminTokenForMe()'),
                ', then paste the value here. Token is stored on this device only.'),
              state.authError
                ? h('div', { class: 'banner banner--warning mt-3' },
                    h('div', { class: 'banner__icon' }, '!'),
                    h('div', { class: 'banner__body' }, state.authError))
                : null,
              h('div', { class: 'form-group mt-4' },
                h('label', { class: 'form-label' }, 'Admin token'),
                h('textarea', {
                  class: 'form-textarea text-mono text-sm',
                  rows: '4',
                  placeholder: 'eyJ...',
                  onInput: (e) => { token = e.target.value; },
                  autofocus: true,
                }, ''),
              ),
              h('button', {
                class: 'btn btn--primary btn--block',
                disabled: trying || undefined,
                onClick: submit,
              }, trying ? 'Verifying…' : 'Sign in'),

              h('hr', { style: { border: 'none', borderTop: '1px solid var(--color-border)', margin: '1.5rem 0' }}),
              h('p', { class: 'text-xs text-muted' },
                'If you don\'t have a token, ask the system owner. Tenants do not need to sign in — they receive direct links.'),
            ),
          )
        )
      )
    );
  }
  render();
}

// ============================================================
// pageAdminList
// ============================================================

export function pageAdminList() {
  let inspections = [];
  let loading = true;
  let error = null;
  let filter = { status: [], search: '' };

  async function load() {
    loading = true; render();
    try {
      const res = await api.listInspections(filter, 0, 100, 'updatedAt', 'desc');
      inspections = res.inspections || [];
      error = null;
    } catch (e) {
      error = e.message;
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
          subtitle: getState().adminLabel || 'Admin',
          actions: [
            h('button', {
              class: 'btn btn--sm btn--ghost',
              style: { color: 'white' },
              onClick: () => navigate('/admin/new'),
            }, '+ New'),
            h('button', {
              class: 'btn btn--sm btn--ghost',
              style: { color: 'white' },
              title: 'Sign out',
              onClick: async () => {
                const ok = await confirm({
                  title: 'Sign out?',
                  message: 'This removes the admin token from this device. You will need to paste it again to sign back in.',
                  confirmLabel: 'Sign out',
                });
                if (!ok) return;
                clearAdminToken();
                setAuth(null);
                setState({ authMode: 'none', adminToken: null, adminLabel: null });
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
                  : h('ul', { class: 'list' },
                      inspections.map(i => h('li', {
                        class: 'list-item',
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
                        h('div', { class: 'list-item__meta text-mono' }, i.inspectionId),
                      ))
                    )
          )
        )
      )
    );
  }

  function renderFilterBar() {
    return h('div', { class: 'card' },
      h('input', {
        type: 'search',
        class: 'form-input',
        placeholder: 'Search by address, tenant, or ID',
        value: filter.search,
        onInput: debounce((e) => {
          filter.search = e.target.value;
          load();
        }, 350),
      })
    );
  }

  load();
}

// ============================================================
// pageAdminNew
// ============================================================

export function pageAdminNew() {
  let schemas = [];
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
  };

  async function load() {
    try {
      const res = await api.getSchemas();
      schemas = res.schemas || [];
    } catch (e) {
      toastError(e.message);
    } finally {
      loading = false;
      render();
    }
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
  showSpinner('Loading inspection…');
  try {
    const data = await api.getInspection(inspectionId);
    setInspectionData(data);
  } catch (e) {
    return showError('Could not load inspection', e.message);
  }

  function render() {
    const state = getState();
    const insp = state.inspection;
    const schema = state.schema;
    const progress = inspectionProgress(schema, state.answers);

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
        h('span', { class: 'section-list__progress' },
          sp.totalRequired > 0 ? `${sp.completedRequired}/${sp.totalRequired}` : `${sp.completedVisible}/${sp.totalVisible}`),
        h('span', { class: 'section-list__chevron' }, '›'),
      );
    });

    const isAdmin = state.authMode === 'admin';
    const canEdit = ['draft', 'under_review'].indexOf(insp.status) >= 0;
    const canSign = ['locked_for_signature', 'partially_signed'].indexOf(insp.status) >= 0;

    let actionButton = null;
    if (isAdmin && canEdit) {
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
          onBack: isAdmin ? () => navigate('/admin') : null,
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
  if (!getState().inspection || getState().inspection.inspectionId !== inspectionId) {
    showSpinner('Loading…');
    try {
      const data = await api.getInspection(inspectionId);
      setInspectionData(data);
    } catch (e) {
      return showError('Could not load inspection', e.message);
    }
  }

  const state = getState();
  const section = (state.schema.sections || []).find(s => s.id === sectionId);
  if (!section) {
    return showError('Section not found', `No section with id '${sectionId}'.`);
  }

  // Pending changes buffer (drained by autosave)
  const pendingItems = {};
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
    return api.saveSection(inspectionId, sectionId, itemsToSend)
      .then(() => {
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
        toastError('Save failed: ' + (e.code || 'unknown') + ' — ' + (e.message || ''));
      });
  }

  const debouncedSave = debounce(flushSave, AUTOSAVE_DEBOUNCE_MS);

  function queueChange(itemId, patch) {
    if (!pendingItems[itemId]) {
      const cur = (getState().answers[sectionId] || {})[itemId] || {};
      pendingItems[itemId] = { value: cur.value, comment: cur.comment || '' };
    }
    Object.assign(pendingItems[itemId], patch);
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
          onBack: async () => {
            await flushSave();
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
            onClick: async () => {
              await flushSave();
              navigate('/inspection/' + inspectionId);
            },
          }, 'Sections'),
          nextSection
            ? h('button', {
                class: 'btn btn--primary bottom-bar__primary',
                onClick: async () => {
                  await flushSave();
                  navigate(`/inspection/${inspectionId}/section/${nextSection.id}`);
                },
              }, 'Next: ' + nextSection.title + ' →')
            : h('button', {
                class: 'btn btn--primary bottom-bar__primary',
                onClick: async () => {
                  await flushSave();
                  navigate('/inspection/' + inspectionId);
                },
              }, 'Done with section'),
        ),
      )
    );
  }

  render();

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
    showSpinner('Loading…');
    try {
      const data = await api.getInspection(inspectionId);
      setInspectionData(data);
    } catch (e) {
      return showError('Could not load inspection', e.message);
    }
  }

  const state = getState();
  const insp = state.inspection;
  const schema = state.schema;
  const progress = inspectionProgress(schema, state.answers);
  const missing = findAllMissingRequired(schema, state.answers);

  let locking = false;

  async function doLock() {
    const ok = await confirm({
      title: 'Lock inspection?',
      message: 'Once locked, no further edits are possible. Both parties will sign the report. You can unlock later if corrections are needed (which invalidates any signatures).',
      confirmLabel: 'Lock for signing',
    });
    if (!ok) return;
    locking = true; render();
    try {
      await api.lockInspection(inspectionId);
      // Reload state
      const data = await api.getInspection(inspectionId);
      setInspectionData(data);
      toastSuccess('Inspection locked. Ready for signatures.');
      navigate(`/inspection/${inspectionId}/sign`);
    } catch (e) {
      if (e.code === 'VALIDATION_FAILED' && e.details && e.details.missingItems) {
        toastError(`${e.details.missingItems.length} required items missing.`);
        // Refresh inspection to recompute
        const data = await api.getInspection(inspectionId);
        setInspectionData(data);
      } else {
        toastError(e.message);
      }
    } finally {
      locking = false;
      render();
    }
  }

  function render() {
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

  if (!getState().inspection || getState().inspection.inspectionId !== inspectionId) {
    showSpinner('Loading…');
    try {
      const data = await api.getInspection(inspectionId);
      setInspectionData(data);
    } catch (e) {
      return showError('Could not load inspection', e.message);
    }
  }

  const state = getState();
  const insp = state.inspection;
  const isAdmin = state.authMode === 'admin';
  const isTenant = state.authMode === 'tenant';

  // Determine which role this user can sign as
  // Admin can sign as anyone; tenant can only sign as 'tenant'
  let availableRoles;
  if (isAdmin) {
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
            isAdmin ? h('button', { class: 'btn btn--primary mt-4', onClick: () => navigate('/admin/inspection/' + inspectionId) }, 'Back to admin') : null,
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
      const data = await api.getInspection(inspectionId);
      setInspectionData(data);
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
      if (isAdmin) {
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
    const result = await api.finalizeInspection(inspectionId);
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

export async function pageSuccess({ params }) {
  const inspectionId = params.id;
  showSpinner('Loading…');
  let data;
  try {
    data = await api.getInspection(inspectionId);
    setInspectionData(data);
  } catch (e) {
    return showError('Could not load inspection', e.message);
  }
  const insp = data.inspection;
  const isAdmin = getState().authMode === 'admin';

  let finalizing = false;

  async function doFinalize() {
    finalizing = true; render();
    try {
      await api.finalizeInspection(inspectionId);
      const reloaded = await api.getInspection(inspectionId);
      setInspectionData(reloaded);
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
    const pdfUrl = i.finalPdfFileId ? `https://drive.google.com/file/d/${i.finalPdfFileId}/view` : null;

    mount(root(),
      h('div', { class: 'app-layout' },
        appHeader({
          title: 'Inspection complete',
          onBack: isAdmin ? () => navigate('/admin') : null,
        }),
        h('main', { class: 'app-body' },
          h('div', { class: 'page' },
            h('div', { class: 'card text-center' },
              h('div', { style: { fontSize: '3rem', color: 'var(--color-success)' } }, '✓'),
              h('h2', { class: 'card__title mt-3' }, i.status === 'signed' ? 'All signatures collected' : statusLabel(i.status)),
              h('p', { class: 'card__meta mt-2' }, i.propertyAddress),
              h('p', { class: 'card__meta' }, i.inspectionId),
            ),

            pdfUrl
              ? h('a', {
                  class: 'btn btn--primary btn--block mt-4',
                  href: pdfUrl,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                }, 'Open final PDF')
              : isAdmin
                ? h('button', {
                    class: 'btn btn--primary btn--block mt-4',
                    disabled: finalizing || undefined,
                    onClick: doFinalize,
                  }, finalizing ? 'Generating…' : 'Generate final PDF')
                : h('div', { class: 'banner banner--info mt-4' },
                    h('div', { class: 'banner__icon' }, 'i'),
                    h('div', { class: 'banner__body' }, 'The landlord will finalize the report shortly.')),

            isAdmin
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

export async function pageAdminDetail({ params }) {
  const inspectionId = params.id;
  showSpinner('Loading…');
  try {
    const data = await api.getInspection(inspectionId);
    setInspectionData(data);
  } catch (e) {
    return showError('Could not load inspection', e.message);
  }

  function render() {
    const state = getState();
    const i = state.inspection;
    const progress = inspectionProgress(state.schema, state.answers);

    const canEdit = ['draft', 'under_review'].indexOf(i.status) >= 0;
    const canUnlock = ['locked_for_signature', 'partially_signed'].indexOf(i.status) >= 0;

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
                        await api.unlockInspection(inspectionId, 'admin requested');
                        toastSuccess('Unlocked.');
                        const reloaded = await api.getInspection(inspectionId);
                        setInspectionData(reloaded);
                        render();
                      } catch (e) {
                        toastError(e.message);
                      }
                    },
                  }, 'Unlock')
                : null,
            ),

            i.finalPdfFileId
              ? h('a', {
                  class: 'btn btn--primary btn--block mt-3',
                  href: `https://drive.google.com/file/d/${i.finalPdfFileId}/view`,
                  target: '_blank', rel: 'noopener',
                }, 'Open final PDF')
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
