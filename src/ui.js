/**
 * Small DOM helpers.
 *
 * Deliberately not a framework. This app has a handful of screens and needs to
 * still build and run in five years without a toolchain to maintain, so it uses
 * the platform directly. `el` and `html` cover almost everything.
 */

/** Creates an element. Attributes and children in one call. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') node.innerHTML = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }

  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * Filters a child list the way `el` does, for use with the DOM's own
 * `append` / `replaceChildren`.
 *
 * Those methods stringify anything that is not a Node, so the common
 * conditional-child idiom
 *
 *     node.replaceChildren(a, someCondition && b)
 *
 * renders the literal text "false" on screen when the condition is false.
 * Always wrap conditional children: `node.replaceChildren(...children(a, cond && b))`.
 */
export function children(...nodes) {
  return nodes.flat(Infinity).filter((child) => child != null && child !== false);
}

/** Escapes text destined for innerHTML. */
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

let toastTimer = null;

export function toast(message, { error = false, duration = 3200 } = {}) {
  let node = document.getElementById('toast');
  if (!node) {
    node = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.toggle('toast--error', error);
  node.classList.add('toast--visible');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('toast--visible'), duration);
}

export function spinner(label = 'Loading…') {
  return el('div', { class: 'spinner' }, el('div', { class: 'spinner__dot' }), el('span', {}, label));
}

/**
 * A heading for a screen that is not in the bottom navigation.
 *
 * Those screens - importing photo tags, the setup checklist - are reached from
 * somewhere else and have no tab of their own, so without a Back button the
 * only way out is the browser's own, which a home-screen PWA does not show.
 * On iOS there is no system back gesture inside a standalone web app either,
 * which makes a screen with no way out genuinely a dead end.
 *
 * @param {string} title
 * @param {{subtitle?: string, onBack?: Function, backLabel?: string}} options
 */
export function pageHeader(title, { subtitle = null, onBack = null, backLabel = 'Back' } = {}) {
  const back = onBack && el('button', {
    class: 'back', type: 'button', 'aria-label': backLabel, onClick: onBack,
  }, el('span', { class: 'back__chevron', 'aria-hidden': 'true' }, '‹'), backLabel);

  return el('header', { class: 'view__header' },
    back,
    el('h1', {}, title),
    subtitle && el('p', { class: 'muted small' }, subtitle),
  );
}

/** A friendly empty state, used instead of a blank screen anywhere data is missing. */
export function emptyState(icon, title, message, action = null) {
  return el('div', { class: 'empty' },
    el('div', { class: 'empty__icon' }, icon),
    el('h2', {}, title),
    el('p', {}, message),
    action,
  );
}

export function errorState(message, onRetry) {
  return el('div', { class: 'empty' },
    el('div', { class: 'empty__icon' }, '⚠️'),
    el('h2', {}, 'Something went wrong'),
    el('p', {}, message),
    onRetry && el('button', { class: 'btn', onClick: onRetry }, 'Try again'),
  );
}

// ---------------------------------------------------------------------------
// Dates, written the way a person would say them
// ---------------------------------------------------------------------------

export function formatDate(value, { withYear = true } = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}),
  });
}

export function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "just now" / "2h ago" / "12 Mar" - what a feed should say. */
export function relativeTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const seconds = (Date.now() - date.getTime()) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;
  return formatDate(date, { withYear: date.getFullYear() !== new Date().getFullYear() });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const THEME_KEY = 'fd.theme';

export function getTheme() {
  return localStorage.getItem(THEME_KEY) ?? 'system';
}

export function applyTheme(theme = getTheme()) {
  localStorage.setItem(THEME_KEY, theme);
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);

  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // Keeps the iOS status bar and Android address bar matching the app.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#14161a' : '#f7f7f9');
}

/** Follows the system setting live, but only while the user has chosen "system". */
export function watchSystemTheme() {
  window.matchMedia?.('(prefers-color-scheme: dark)')
    .addEventListener?.('change', () => {
      if (getTheme() === 'system') applyTheme('system');
    });
}
