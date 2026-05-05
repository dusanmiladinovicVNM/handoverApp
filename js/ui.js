/**
 * ui.js
 * Toast notifications and modal dialogs.
 */

import { h } from './utils/dom.js';

// ============================================================
// Toasts
// ============================================================

let _toastContainer = null;

function getToastContainer() {
  if (!_toastContainer) {
    _toastContainer = document.getElementById('toast-container');
  }
  return _toastContainer;
}

export function toast(message, kind = 'info', durationMs = 3500) {
  const container = getToastContainer();
  if (!container) return;
  const node = h('div', { class: ['toast', `toast--${kind}`] }, message);
  container.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity 200ms';
    setTimeout(() => node.remove(), 220);
  }, durationMs);
}

export const toastSuccess = (msg) => toast(msg, 'success');
export const toastWarning = (msg) => toast(msg, 'warning');
export const toastError = (msg) => toast(msg, 'danger', 5000);

// ============================================================
// Modal
// ============================================================

let _activeModal = null;

/**
 * Open a confirm dialog. Returns a Promise<boolean>.
 *   await confirm({ title: '...', message: '...', confirmLabel: 'Delete', danger: true })
 */
export function confirm(opts) {
  return new Promise((resolve) => {
    const onConfirm = () => { close(); resolve(true); };
    const onCancel  = () => { close(); resolve(false); };

    const backdrop = h('div', { class: 'modal-backdrop', onClick: (e) => {
      if (e.target === backdrop) onCancel();
    }},
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'modal__header' },
          h('h2', { class: 'modal__title' }, opts.title || 'Confirm')
        ),
        h('div', { class: 'modal__body' },
          h('p', null, opts.message || 'Are you sure?')
        ),
        h('div', { class: 'modal__footer' },
          h('button', { class: 'btn btn--secondary', onClick: onCancel }, opts.cancelLabel || 'Cancel'),
          h('button', {
            class: ['btn', opts.danger ? 'btn--danger' : 'btn--primary'],
            onClick: onConfirm,
          }, opts.confirmLabel || 'Confirm')
        )
      )
    );

    function close() {
      backdrop.remove();
      if (_activeModal === backdrop) _activeModal = null;
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    }
    document.addEventListener('keydown', onKey);

    document.getElementById('modal-root').appendChild(backdrop);
    _activeModal = backdrop;
  });
}

/**
 * Open a custom modal with arbitrary body. Returns { close } so caller can close manually.
 *   const m = openModal({ title: 'Share link', body: someElement, footer: [btn1, btn2] });
 *   m.close();
 */
export function openModal(opts) {
  let backdrop;
  function close() { if (backdrop) backdrop.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }

  backdrop = h('div', { class: 'modal-backdrop', onClick: (e) => { if (e.target === backdrop) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal__header' },
        h('h2', { class: 'modal__title' }, opts.title || '')
      ),
      h('div', { class: 'modal__body' }, opts.body || ''),
      opts.footer ? h('div', { class: 'modal__footer' }, opts.footer) : null
    )
  );

  document.addEventListener('keydown', onKey);
  document.getElementById('modal-root').appendChild(backdrop);
  return { close };
}
