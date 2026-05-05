/**
 * router.js
 * Hash-based router. Routes look like:
 *   #/                                       — home
 *   #/admin                                  — admin list
 *   #/admin/new                              — new inspection form
 *   #/admin/inspection/:id                   — admin detail (read-only)
 *   #/inspection/:id                         — inspection home (sections list)
 *   #/inspection/:id/section/:sectionId      — section editor
 *   #/inspection/:id/review                  — review before lock
 *   #/inspection/:id/sign                    — signing page
 *   #/inspection/:id/success                 — finalized confirmation
 *
 * Query params come after `?` — used for tenant token (?t=...).
 */

const _routes = [];
let _onChange = null;

/**
 * Register a route. Pattern uses :param syntax. Handler receives { params, query }.
 */
export function route(pattern, handler) {
  const keys = [];
  const regex = new RegExp(
    '^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    }).replace(/\//g, '\\/') + '$'
  );
  _routes.push({ regex, keys, handler, pattern });
}

export function navigate(path, replace = false) {
  const target = path.startsWith('#') ? path : '#' + path;
  if (replace) {
    history.replaceState(null, '', target);
    handleHashChange();
  } else {
    location.hash = target;
  }
}

export function back() {
  history.back();
}

function parseHash() {
  let hash = location.hash || '#/';
  if (hash.startsWith('#')) hash = hash.substring(1);

  const queryIdx = hash.indexOf('?');
  let pathPart = hash;
  let queryPart = '';
  if (queryIdx >= 0) {
    pathPart = hash.substring(0, queryIdx);
    queryPart = hash.substring(queryIdx + 1);
  }
  const query = {};
  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      const [k, v] = pair.split('=');
      if (k) query[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
    }
  }
  return { path: pathPart || '/', query };
}

function match(path) {
  for (const r of _routes) {
    const m = path.match(r.regex);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
      return { handler: r.handler, params, pattern: r.pattern };
    }
  }
  return null;
}

function handleHashChange() {
  const { path, query } = parseHash();
  const matched = match(path);
  if (matched) {
    if (_onChange) _onChange({ pattern: matched.pattern, path, query, params: matched.params });
    matched.handler({ params: matched.params, query, path });
  } else {
    if (_onChange) _onChange({ pattern: null, path, query, params: {} });
    notFound(path);
  }
}

let _notFoundHandler = (path) => {
  document.getElementById('app-root').innerHTML =
    `<div class="app-body"><h1 class="page__title">Not found</h1><p class="text-muted">No route for ${path}</p></div>`;
};

export function notFound(path) {
  _notFoundHandler(path);
}

export function setNotFoundHandler(fn) { _notFoundHandler = fn; }

export function onChange(fn) { _onChange = fn; }

export function start() {
  window.addEventListener('hashchange', handleHashChange);
  // Defer initial dispatch to next tick so callers can finish setup
  setTimeout(handleHashChange, 0);
}

export function getCurrentRoute() {
  return parseHash();
}
