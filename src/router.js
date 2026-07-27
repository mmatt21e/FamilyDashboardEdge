/**
 * Hash-based router.
 *
 * Hash routing rather than the History API because GitHub Pages serves static
 * files only: a deep link to /photos would 404 since there is no server to
 * rewrite it. #/photos always resolves to index.html, which is exactly what a
 * PWA reopening on its last screen needs.
 */

const routes = new Map();
let notFound = null;
let current = null;
let onNavigate = null;

export function route(path, render) {
  routes.set(path, render);
}

export function setNotFound(render) {
  notFound = render;
}

export function setNavigationListener(callback) {
  onNavigate = callback;
}

export function currentPath() {
  const hash = location.hash.replace(/^#/, '');
  // Strip a setup payload so arriving on a setup link does not look like a route.
  const path = hash.split('&')[0];
  return path.startsWith('/') ? path : '/';
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (location.hash === target) return render();
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
  if (replace) render();
}

/** Splits "/photos/abc" into ["photos", "abc"]. */
function segments(path) {
  return path.split('/').filter(Boolean);
}

/**
 * Resolves a path to a handler, supporting one level of `:param`.
 * Exact matches win over parameterised ones.
 */
function resolve(path) {
  if (routes.has(path)) return { render: routes.get(path), params: {} };

  const parts = segments(path);
  for (const [pattern, render] of routes) {
    const patternParts = segments(pattern);
    if (patternParts.length !== parts.length) continue;

    const params = {};
    let matched = true;
    for (let i = 0; i < patternParts.length; i += 1) {
      if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (patternParts[i] !== parts[i]) { matched = false; break; }
    }
    if (matched) return { render, params };
  }
  return null;
}

let outlet = null;

export function mount(node) {
  outlet = node;
  window.addEventListener('hashchange', render);
}

/**
 * How many screens deep this visit is.
 *
 * Counted rather than read from `history.length`, which includes everything the
 * tab did before the app was opened and so cannot tell "came here from
 * Settings" from "opened this link cold". A Back button that leaves the app
 * entirely is worse than no Back button at all.
 */
let visited = 0;

export function canGoBack() {
  return visited > 1;
}

/** Back where they came from, or to a sensible screen if they arrived cold. */
export function goBack(fallback = '/') {
  if (canGoBack()) history.back();
  else navigate(fallback, { replace: true });
}

export async function render() {
  if (!outlet) return;
  const path = currentPath();
  const match = resolve(path);
  current = path;
  visited += 1;

  outlet.scrollTop = 0;
  const view = match ? match.render : notFound;
  if (!view) return;

  // Give the outgoing view its teardown on EVERY navigation, not only into
  // gated routes: leaving Photos for Settings must release its listeners just
  // as surely as leaving it for the calendar. A view cannot know which route
  // comes next, so the router owns this.
  outlet.firstElementChild?.dispatchEvent(new CustomEvent('fd:teardown'));

  try {
    const result = await view(match?.params ?? {}, outlet);
    // A view may either render into the outlet itself or return a node.
    if (result instanceof Node) {
      outlet.replaceChildren(result);
    }
  } catch (error) {
    outlet.replaceChildren(
      Object.assign(document.createElement('p'), {
        className: 'error-text',
        textContent: error?.message ?? 'Something went wrong.',
      }),
    );
  }

  onNavigate?.(path);
}

export function activePath() {
  return current;
}
