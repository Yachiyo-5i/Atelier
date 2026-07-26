/**
 * Unified button helpers.
 * Variants:
 *   - default  常规
 *   - confirm  确认
 *   - danger   危险
 */

const VARIANTS = new Set(['default', 'confirm', 'danger']);

/**
 * @param {'default'|'confirm'|'danger'} [variant]
 * @param {string} [extraClass]
 */
export function buttonClass(variant = 'default', extraClass = '') {
  const v = VARIANTS.has(variant) ? variant : 'default';
  return ['ui-btn', `ui-btn--${v}`, extraClass].filter(Boolean).join(' ');
}

/**
 * Create a button or anchor with unified styles.
 * @param {object} options
 * @param {'default'|'confirm'|'danger'} [options.variant]
 * @param {string} [options.label]
 * @param {string} [options.html] - raw inner HTML (takes precedence over label)
 * @param {'button'|'submit'|'reset'} [options.type]
 * @param {string} [options.href] - if set, renders <a>
 * @param {string} [options.download]
 * @param {string} [options.target]
 * @param {string} [options.rel]
 * @param {string} [options.title]
 * @param {string} [options.ariaLabel]
 * @param {boolean} [options.disabled]
 * @param {boolean} [options.icon] - square icon button
 * @param {string} [options.className]
 * @param {Record<string,string>} [options.attrs]
 * @param {(e: Event) => void} [options.onClick]
 * @returns {HTMLButtonElement|HTMLAnchorElement}
 */
export function createButton(options = {}) {
  const {
    variant = 'default',
    label = '',
    html,
    type = 'button',
    href,
    download,
    target,
    rel,
    title,
    ariaLabel,
    disabled = false,
    icon = false,
    className = '',
    attrs = {},
    onClick,
  } = options;

  const isLink = typeof href === 'string' && href.length > 0;
  const el = document.createElement(isLink ? 'a' : 'button');
  el.className = buttonClass(variant, [icon ? 'ui-btn--icon' : '', className].filter(Boolean).join(' '));

  if (isLink) {
    el.href = href;
    if (download != null) el.setAttribute('download', download);
    if (target) el.target = target;
    if (rel) el.rel = rel;
  } else {
    el.type = type;
    if (disabled) el.disabled = true;
  }

  if (title) el.title = title;
  if (ariaLabel) el.setAttribute('aria-label', ariaLabel);

  if (html != null) el.innerHTML = html;
  else el.textContent = label;

  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    el.setAttribute(k, String(v));
  }

  if (typeof onClick === 'function') {
    el.addEventListener('click', onClick);
  }

  return el;
}

/** Apply unified classes to an existing element. */
export function applyButton(el, variant = 'default', { icon = false, extraClass = '' } = {}) {
  if (!el) return el;
  el.classList.remove(
    'btn',
    'btn-primary',
    'btn-secondary',
    'btn-ghost',
    'btn-danger',
    'btn-sm',
    'link-btn',
    'icon-btn',
    'shot__btn',
    'shot__btn--danger',
    'shot__btn--ghost',
    'ui-btn',
    'ui-btn--default',
    'ui-btn--confirm',
    'ui-btn--danger',
    'ui-btn--icon',
  );
  el.className = [buttonClass(variant, icon ? 'ui-btn--icon' : ''), el.className, extraClass]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return el;
}
