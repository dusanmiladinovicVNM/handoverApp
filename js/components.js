/**
 * components.js
 * Reusable UI components built with the h() helper.
 *
 * Components:
 *  - appHeader(title, opts)     — sticky top bar
 *  - bottomBar(...children)     — sticky bottom action bar
 *  - badge(status)              — status pill
 *  - statusIndicator(...)       — saving/saved/error indicator
 *  - progressBar(value, max)    — thin bar
 *  - questionCard(item, ...)    — full question with input, comment, attachments
 *  - imageUploader(...)         — file picker + thumbnail grid
 *  - signatureCanvas(...)       — signature pad (returns { canvas, getDataUrl, clear, isEmpty })
 */

import { h, escapeHtml, debounce } from './utils/dom.js';
import { statusLabel, statusBadgeClass } from './utils/format.js';
import { t, tn, tc, getLang, setLang, languages } from './i18n.js';
import { compressImage } from './utils/image.js';
import { api } from './api.js';
import { toastError, toastSuccess, confirm } from './ui.js';
import { addAttachmentLocally, removeAttachmentLocally, getState, patchAnswer } from './state.js';
import { MAX_ATTACHMENTS_PER_ITEM, AUTOSAVE_DEBOUNCE_MS } from './config.js';

// ============================================================
// App header / bottom bar
// ============================================================

/**
 * The bar every screen wears.
 *
 * The language switch lives here rather than in a settings screen because the
 * people who most need it never reach one: a tenant arrives from a link, signs,
 * and leaves. Pass `lang: false` where the actions slot is already spoken for —
 * the section editor keeps its save indicator there.
 */
export function appHeader({ title, subtitle, onBack, actions, lang }) {
  const trailing = [];
  if (actions) trailing.push(actions);
  if (lang !== false) trailing.push(langToggle());

  return h('header', { class: 'app-header' },
    onBack
      ? h('button', { class: 'app-header__back', onClick: onBack, 'aria-label': t('action.back') }, '←')
      : null,
    h('div', { style: { flex: '1', minWidth: '0' } },
      h('h1', { class: 'app-header__title' }, title),
      subtitle ? h('p', { class: 'app-header__subtitle' }, subtitle) : null,
    ),
    trailing.length ? h('div', { class: 'app-header__actions' }, trailing) : null,
  );
}

/**
 * DE | EN.
 *
 * Both options are always shown rather than a single button that toggles,
 * because a toggle labelled with the other language is ambiguous — half of
 * everyone reads "EN" as "you are in English" and the other half as "switch to
 * English". Two buttons with one of them marked cannot be misread.
 *
 * Setting the language redraws the current route; see app.js.
 */
export function langToggle() {
  const current = getLang();
  return h('div', { class: 'lang-toggle', role: 'group', 'aria-label': t('lang.switch') },
    languages().map(l => h('button', {
      class: ['lang-toggle__option', l.code === current ? 'lang-toggle__option--active' : null],
      type: 'button',
      lang: l.code,
      title: l.label,
      'aria-pressed': l.code === current ? 'true' : 'false',
      onClick: () => setLang(l.code),
    }, l.short)),
  );
}

export function bottomBar(...children) {
  return h('div', { class: 'bottom-bar' }, ...children);
}

// ============================================================
// Status badge / progress bar / save indicator
// ============================================================

export function badge(status) {
  return h('span', { class: ['badge', statusBadgeClass(status)] }, statusLabel(status));
}

export function progressBar(value, max) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
    h('div', { class: 'progress__fill', style: { width: pct + '%' } })
  );
}

export function saveIndicator(status, errorText) {
  const labels = {
    idle:   { text: t('save.idle'), cls: '' },
    saving: { text: t('save.saving'), cls: 'save-indicator--saving' },
    saved:  { text: t('save.saved'), cls: 'save-indicator--saved' },
    error:  { text: errorText || t('save.error'), cls: 'save-indicator--error' },
  };
  const cur = labels[status] || labels.idle;
  return h('div', { class: ['save-indicator', cur.cls] },
    h('span', { class: 'save-indicator__dot' }),
    h('span', null, cur.text)
  );
}

// ============================================================
// Question card
// ============================================================

/**
 * Render one question with appropriate input control.
 *
 * @param item         Schema item
 * @param value        Current value
 * @param comment      Current comment
 * @param attachments  Array of attachments for this item
 * @param opts.disabled        Disable inputs (for review/locked)
 * @param opts.onChange        (newValue) => void
 * @param opts.onCommentChange (newComment) => void
 * @param opts.inspectionId    For uploads
 * @param opts.sectionId       For uploads
 * @param opts.onAttachmentAdd Called after successful upload
 * @param opts.onAttachmentRemove
 */
export function questionCard(item, value, comment, attachments, opts) {
  const disabled = opts.disabled === true;

  // Track current value/comment locally so input rebuilds reflect them.
  let currentValue = value;
  let currentComment = comment;

  // Wrapper that holds the input — we replace its contents when value changes.
  const inputSlot = h('div', { class: 'question__input-slot' });

  function rebuildInput() {
    const fresh = renderInput(item, currentValue, handleValueChange, disabled);
    inputSlot.innerHTML = '';
    inputSlot.appendChild(fresh);
  }

  // Text-like inputs update natively in DOM as user types — rebuilding would
  // destroy the element and lose focus mid-typing. Only structural controls
  // (checkbox/radio/select/multiselect) need a manual rebuild to reflect state.
  const TEXT_TYPES = new Set(['text', 'textarea', 'number', 'date']);
  const needsRebuildOnChange = !TEXT_TYPES.has(item.type);

  function handleValueChange(newValue) {
    currentValue = newValue;
    if (opts.onChange) opts.onChange(newValue);
    if (needsRebuildOnChange) {
      rebuildInput();
    }
    // Update missing-required visual indicator on the card.
    const isMissingNow = item.required && (newValue === undefined || newValue === '' || newValue === null);
    cardEl.classList.toggle('question--required-missing', !!isMissingNow);
  }

  function handleCommentChange(newComment) {
    currentComment = newComment;
    if (opts.onCommentChange) opts.onCommentChange(newComment);
  }

  rebuildInput();

  const isMissing = item.required && (value === undefined || value === '' || value === null);

  // Comment toggle (collapsed by default unless comment exists)
  let commentVisible = !!comment;
  let commentNode;
  let toggleNode;

  function buildCommentArea() {
    if (commentVisible) {
      commentNode = h('textarea', {
        class: 'form-textarea',
        placeholder: t('question.notePlaceholder'),
        disabled: disabled || undefined,
        onInput: (e) => handleCommentChange(e.target.value),
      }, currentComment || '');
      return commentNode;
    }
    return null;
  }

  let commentSlot = h('div', null, buildCommentArea());

  if (!disabled) {
    toggleNode = h('button', {
      class: 'question__comment-toggle',
      onClick: () => {
        commentVisible = !commentVisible;
        commentSlot.innerHTML = '';
        const built = buildCommentArea();
        if (built) commentSlot.appendChild(built);
        toggleNode.textContent = commentVisible ? t('question.hideComment') : t('question.addComment');
      },
    }, comment ? t('question.hideComment') : t('question.addComment'));
  }

  // Attachments
  const attachmentsForItem = (attachments || []).filter(a =>
    a.sectionId === opts.sectionId && a.itemId === item.id
  );
  const attachmentsEnabled = item.attachments && item.attachments.enabled;

  const cardEl = h('div', { class: ['question', isMissing ? 'question--required-missing' : null] },
    // Label
    h('div', { class: 'question__label' },
      h('span', null, tc(item.label)),
      item.required ? h('span', { class: 'question__required-mark', 'aria-label': t('question.required') }, '*') : null,
    ),
    item.help ? h('p', { class: 'question__help' }, tc(item.help)) : null,

    // Input
    inputSlot,

    // Comment
    toggleNode,
    commentSlot,

    // Attachments
    attachmentsEnabled
      ? imageUploader({
          inspectionId: opts.inspectionId,
          sectionId: opts.sectionId,
          itemId: item.id,
          attachments: attachmentsForItem,
          maxCount: (item.attachments && item.attachments.max) || MAX_ATTACHMENTS_PER_ITEM,
          minCount: (item.attachments && item.attachments.min) || 0,
          disabled,
          onAdd: opts.onAttachmentAdd,
          onRemove: opts.onAttachmentRemove,
        })
      : null,
  );

  return cardEl;
}

function renderInput(item, value, onChange, disabled) {
  const handleChange = (newValue) => {
    if (onChange) onChange(newValue);
  };

  if (item.type === 'text') {
    return h('input', {
      type: 'text',
      class: 'form-input',
      value: value || '',
      disabled: disabled || undefined,
      onInput: (e) => handleChange(e.target.value),
    });
  }

  if (item.type === 'number') {
    return h('input', {
      type: 'number',
      inputmode: 'decimal',
      class: 'form-input',
      value: value === undefined || value === null ? '' : value,
      disabled: disabled || undefined,
      onInput: (e) => handleChange(e.target.value),
    });
  }

  if (item.type === 'date') {
    return h('input', {
      type: 'date',
      class: 'form-input',
      value: value || '',
      disabled: disabled || undefined,
      onInput: (e) => handleChange(e.target.value),
    });
  }

  if (item.type === 'textarea') {
    return h('textarea', {
      class: 'form-textarea',
      disabled: disabled || undefined,
      onInput: (e) => handleChange(e.target.value),
    }, value || '');
  }

  if (item.type === 'checkbox') {
    const checked = value === true || value === 'true';
    return h('div', {
      class: ['form-check', checked ? 'form-check--checked' : null],
      role: 'checkbox',
      tabindex: disabled ? '-1' : '0',
      'aria-checked': checked ? 'true' : 'false',
      'aria-disabled': disabled ? 'true' : 'false',
      onClick: () => {
        if (disabled) return;
        handleChange(!checked);
      },
      onKeydown: (e) => {
        if (disabled) return;
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          handleChange(!checked);
        }
      },
    },
      h('span', { class: 'form-check__indicator', 'aria-hidden': 'true' }),
      h('span', { class: 'form-check__label' }, tc(item.label)),
    );
  }

  if (item.type === 'select') {
    return h('select', {
      class: 'form-select',
      disabled: disabled || undefined,
      onChange: (e) => handleChange(e.target.value),
    },
      h('option', { value: '' }, t('input.choose')),
      (item.options || []).map(opt =>
        h('option', { value: opt.value, selected: value === opt.value }, tc(opt.label))
      ),
    );
  }

  if (item.type === 'radio') {
    return h('div', { class: 'form-options' },
      (item.options || []).map(opt => {
        const checked = value === opt.value;
        return h('div', {
          class: ['form-check', 'form-check--radio', checked ? 'form-check--checked' : null],
          role: 'radio',
          tabindex: disabled ? '-1' : '0',
          'aria-checked': checked ? 'true' : 'false',
          'aria-disabled': disabled ? 'true' : 'false',
          onClick: () => {
            if (disabled) return;
            handleChange(opt.value);
          },
          onKeydown: (e) => {
            if (disabled) return;
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              handleChange(opt.value);
            }
          },
        },
          h('span', { class: 'form-check__indicator', 'aria-hidden': 'true' }),
          h('span', { class: 'form-check__label' }, tc(opt.label)),
        );
      })
    );
  }

  if (item.type === 'multiselect') {
    let arr = [];
    try {
      arr = Array.isArray(value) ? value : (value ? JSON.parse(value) : []);
    } catch (_) { arr = []; }

    return h('div', { class: 'form-options' },
      (item.options || []).map(opt => {
        const checked = arr.indexOf(opt.value) >= 0;
        return h('div', {
          class: ['form-check', checked ? 'form-check--checked' : null],
          role: 'checkbox',
          tabindex: disabled ? '-1' : '0',
          'aria-checked': checked ? 'true' : 'false',
          'aria-disabled': disabled ? 'true' : 'false',
          onClick: () => {
            if (disabled) return;
            const next = checked ? arr.filter(x => x !== opt.value) : [...arr, opt.value];
            handleChange(next);
          },
          onKeydown: (e) => {
            if (disabled) return;
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              const next = checked ? arr.filter(x => x !== opt.value) : [...arr, opt.value];
              handleChange(next);
            }
          },
        },
          h('span', { class: 'form-check__indicator', 'aria-hidden': 'true' }),
          h('span', { class: 'form-check__label' }, tc(opt.label)),
        );
      })
    );
  }

  // Fallback
  return h('div', { class: 'text-muted' }, t('input.unsupported', { type: item.type }));
}

// ============================================================
// Image uploader
// ============================================================

export function imageUploader({ inspectionId, sectionId, itemId, attachments, maxCount, minCount, disabled, onAdd, onRemove }) {
  const container = h('div', { class: 'image-grid' });

  function rebuild() {
    container.innerHTML = '';
    const live = (getState().attachments || []).filter(a => a.sectionId === sectionId && a.itemId === itemId);

    for (const att of live) {
      const item = h('div', { class: 'image-grid__item' },
        h('img', { src: att.thumbnailUrl, alt: att.caption || '', loading: 'lazy' }),
        disabled ? null : h('button', {
          class: 'image-grid__item-remove',
          onClick: async () => {
            const ok = await confirm({
              title: t('photo.removeTitle'),
              message: t('photo.removeMessage'),
              confirmLabel: t('action.remove'),
              danger: true,
            });
            if (!ok) return;
            try {
              await api.deleteAttachment(inspectionId, att.attachmentId);
              removeAttachmentLocally(att.attachmentId);
              if (onRemove) onRemove(att);
              rebuild();
              toastSuccess(t('photo.removed'));
            } catch (e) {
              toastError(e.message || t('photo.removeFailed'));
            }
          },
          'aria-label': t('photo.remove'),
        }, '×'),
      );
      container.appendChild(item);
    }

    if (!disabled && live.length < maxCount) {
      const fileInput = h('input', {
        type: 'file',
        accept: 'image/*',
        capture: 'environment',
        style: { display: 'none' },
        onChange: async (e) => {
          const file = e.target.files && e.target.files[0];
          if (!file) return;
          await handleUpload(file);
          fileInput.value = ''; // reset for next pick
        },
      });
      const addBtn = h('button', {
        class: 'image-grid__add',
        onClick: () => fileInput.click(),
        'aria-label': t('photo.add'),
      }, '＋');
      container.appendChild(addBtn);
      container.appendChild(fileInput);
    }
  }

  async function handleUpload(file) {
    let busyEl;
    try {
      busyEl = h('div', { class: 'image-grid__item', style: { display: 'flex', alignItems: 'center', justifyContent: 'center' } },
        h('div', { class: 'boot-spinner', style: { width: '20px', height: '20px', borderWidth: '2px' } })
      );
      container.appendChild(busyEl);

      const compressed = await compressImage(file);
      const result = await api.uploadAttachment({
        inspectionId, sectionId, itemId,
        fileName: file.name || `photo-${Date.now()}.jpg`,
        mimeType: 'image/jpeg',
        base64Data: compressed.base64Data,
        width: compressed.width,
        height: compressed.height,
      });
      const attachment = {
        attachmentId: result.attachmentId,
        sectionId, itemId,
        fileId: result.fileId,
        fileName: result.fileName,
        thumbnailUrl: result.thumbnailUrl,
      };
      addAttachmentLocally(attachment);
      if (onAdd) onAdd(attachment);
      rebuild();
      toastSuccess(t('photo.uploaded'));
    } catch (e) {
      toastError(e.message || t('photo.uploadFailed'));
      if (busyEl && busyEl.parentNode) busyEl.parentNode.removeChild(busyEl);
    }
  }

  rebuild();
  const wrapper = h('div', null,
    container,
    minCount > 0 ? h('p', { class: 'form-help mt-2' }, tn('photo.min', minCount)) : null,
  );
  return wrapper;
}

// ============================================================
// Signature canvas
// ============================================================

/**
 * Returns { element, getDataUrl(), getBase64(), clear(), isEmpty() }
 */
export function signatureCanvas() {
  const canvas = document.createElement('canvas');
  canvas.className = 'signature-pad__canvas';

  const hint = h('div', { class: 'signature-pad__hint' }, t('signature.hint'));
  const pad = h('div', { class: 'signature-pad' }, canvas, hint);

  let drawing = false;
  let lastPoint = null;
  let hasDrawn = false;
  let isSetUp = false;
  let dpr = window.devicePixelRatio || 1;

  function setupCanvas() {
    const rect = pad.getBoundingClientRect();
    if (rect.width === 0) {
      // Pad not yet in layout — try again next frame
      return false;
    }
    const cssWidth = rect.width;
    const cssHeight = 240;
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';

    const ctx = canvas.getContext('2d');
    // Fill with white so the resulting PNG has visible background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Now scale so all subsequent drawing uses CSS coordinates
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 2.5;
    isSetUp = true;
    return true;
  }

  function ensureSetup() {
    if (isSetUp) return;
    if (!setupCanvas()) {
      // Schedule retry — keep trying until pad has dimensions
      requestAnimationFrame(ensureSetup);
    }
  }

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }

  function onStart(e) {
    e.preventDefault();
    if (!isSetUp) setupCanvas();
    drawing = true;
    hasDrawn = true;
    hint.style.display = 'none';
    lastPoint = getPos(e);
    // Draw a single dot in case user just taps without moving
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.arc(lastPoint.x, lastPoint.y, 1.25, 0, Math.PI * 2);
    ctx.fillStyle = '#111111';
    ctx.fill();
  }

  function onMove(e) {
    if (!drawing) return;
    e.preventDefault();
    const ctx = canvas.getContext('2d');
    const p = getPos(e);
    ctx.beginPath();
    ctx.moveTo(lastPoint.x, lastPoint.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastPoint = p;
  }

  function onEnd() {
    drawing = false;
    lastPoint = null;
  }

  canvas.addEventListener('mousedown', onStart);
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseup', onEnd);
  canvas.addEventListener('mouseleave', onEnd);
  canvas.addEventListener('touchstart', onStart, { passive: false });
  canvas.addEventListener('touchmove', onMove, { passive: false });
  canvas.addEventListener('touchend', onEnd);

  // Schedule initial setup after element enters DOM
  requestAnimationFrame(ensureSetup);

  return {
    element: pad,
    getDataUrl: () => canvas.toDataURL('image/png'),
    getBase64: () => {
      // If canvas was never set up, force setup with white background
      if (!isSetUp) setupCanvas();
      const u = canvas.toDataURL('image/png');
      return u.substring(u.indexOf(',') + 1);
    },
    clear: () => {
      const ctx = canvas.getContext('2d');
      // Reset transform before clearing, then re-fill white and re-apply scale
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#111111';
      ctx.lineWidth = 2.5;
      hasDrawn = false;
      hint.style.display = '';
    },
    isEmpty: () => !hasDrawn,
  };
}
