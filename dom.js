/**
 * utils/dom.js
 * Tiny helpers for DOM construction without a framework.
 */

/**
 * Create an element with attributes and children.
 * Children can be: strings, Nodes, arrays of either, falsy values (skipped).
 *
 *   h('div', { class: 'card' }, 'hello')
 *   h('button', { onClick: () => ... }, 'Click')
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const v = attrs[key];
      if (v === false || v === null || v === undefined) continue;
      if (key === 'class' || key === 'className') {
        el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      } else if (key === 'style' && typeof v === 'object') {
        Object.assign(el.style, v);
      } else if (key === 'dataset' && typeof v === 'object') {
        Object.assign(el.dataset, v);
      } else if (key.startsWith('on') && typeof v === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), v);
      } else if (key === 'html') {
        el.innerHTML = v;
      } else if (typeof v === 'boolean') {
        if (v) el.setAttribute(key, '');
      } else {
        el.setAttribute(key, v);
      }
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(parent, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) {
      appendChildren(parent, c);
    } else if (c instanceof Node) {
      parent.appendChild(c);
    } else {
      parent.appendChild(document.createTextNode(String(c)));
    }
  }
}

/** Replace the contents of `parent` with the given child(ren). */
export function mount(parent, ...children) {
  parent.innerHTML = '';
  appendChildren(parent, children);
}

/** Convenience query. */
export function $(sel, root = document) {
  return root.querySelector(sel);
}

/** Escape text for safe insertion into innerHTML. */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Debounce — leading=false, trailing=true. */
export function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, ms);
  };
}
