/**
 * FancySelect — lightweight custom dropdown (no native <select>)
 *
 * Usage:
 *   const sel = new FancySelect(mountEl, {
 *     options: [{ value, label, hint? }],
 *     value: '',
 *     placeholder: '请选择',
 *     searchable: false,
 *     onChange: (value, option) => {},
 *   });
 */

let openInstance = null;

function closeOpenInstance(except = null) {
  if (openInstance && openInstance !== except) {
    openInstance.close();
  }
}

export class FancySelect {
  constructor(root, options = {}) {
    if (!root) throw new Error('FancySelect: root element required');

    this.root = root;
    this.options = [];
    this.value = options.value ?? '';
    this.placeholder = options.placeholder ?? '请选择';
    this.searchable = Boolean(options.searchable);
    this.onChange = typeof options.onChange === 'function' ? options.onChange : null;
    this.disabled = Boolean(options.disabled);
    this.open = false;
    this._filter = '';
    this._portal = false;
    this._boundDocPointer = (e) => this._onDocPointer(e);
    this._boundKeydown = (e) => this._onKeydown(e);
    this._boundReposition = () => this._positionPanel();

    this.root.classList.add('fancy-select');
    this.root.innerHTML = `
      <button type="button" class="fancy-select__trigger" aria-haspopup="listbox" aria-expanded="false">
        <span class="fancy-select__value"></span>
        <span class="fancy-select__chevron" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="m6 9 6 6 6-6"/>
          </svg>
        </span>
      </button>
      <div class="fancy-select__panel" hidden>
        ${
          this.searchable
            ? `<div class="fancy-select__search"><input type="text" placeholder="搜索…" autocomplete="off" /></div>`
            : ''
        }
        <ul class="fancy-select__list" role="listbox"></ul>
      </div>
    `;

    this.trigger = this.root.querySelector('.fancy-select__trigger');
    this.valueEl = this.root.querySelector('.fancy-select__value');
    this.panel = this.root.querySelector('.fancy-select__panel');
    this.list = this.root.querySelector('.fancy-select__list');
    this.searchInput = this.root.querySelector('.fancy-select__search input');

    this.trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.disabled) return;
      this.toggle();
    });

    if (this.searchInput) {
      this.searchInput.addEventListener('input', () => {
        this._filter = this.searchInput.value.trim().toLowerCase();
        this._renderOptions();
      });
      this.searchInput.addEventListener('click', (e) => e.stopPropagation());
      this.searchInput.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    // Prevent option mousedown from being treated as outside click before click fires
    this.panel.addEventListener('mousedown', (e) => e.stopPropagation());

    if (options.options) this.setOptions(options.options, { keepValue: true });
    else this._syncTrigger();
  }

  setOptions(options, { keepValue = true } = {}) {
    this.options = (options || []).map((o) =>
      typeof o === 'string'
        ? { value: o, label: o }
        : {
            value: String(o.value ?? ''),
            label: String(o.label ?? o.value ?? ''),
            hint: o.hint ? String(o.hint) : '',
            disabled: Boolean(o.disabled),
          },
    );

    if (keepValue && this.options.some((o) => o.value === this.value)) {
      // keep
    } else if (this.value && !this.options.some((o) => o.value === this.value)) {
      this.value = '';
    }

    this._renderOptions();
    this._syncTrigger();
  }

  setValue(value, { silent = false } = {}) {
    const next = value == null ? '' : String(value);
    if (next === this.value) {
      this._syncTrigger();
      return;
    }
    this.value = next;
    this._syncTrigger();
    this._renderOptions();
    if (!silent && this.onChange) {
      const opt = this.options.find((o) => o.value === this.value) || null;
      this.onChange(this.value, opt);
    }
  }

  getValue() {
    return this.value;
  }

  getSelected() {
    return this.options.find((o) => o.value === this.value) || null;
  }

  setDisabled(disabled) {
    this.disabled = Boolean(disabled);
    this.root.classList.toggle('is-disabled', this.disabled);
    this.trigger.disabled = this.disabled;
    if (this.disabled) this.close();
  }

  setPlaceholder(text) {
    this.placeholder = text;
    this._syncTrigger();
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    if (this.disabled || this.open) return;
    closeOpenInstance(this);

    this.open = true;
    openInstance = this;
    this.root.classList.add('is-open');
    this.trigger.setAttribute('aria-expanded', 'true');
    this._filter = '';
    if (this.searchInput) this.searchInput.value = '';

    // Portal to body so fixed positioning is not trapped by overflow/backdrop-filter ancestors
    if (this.panel.parentElement !== document.body) {
      document.body.appendChild(this.panel);
      this._portal = true;
    }

    this.panel.hidden = false;
    this.panel.classList.add('is-open');
    this._renderOptions();
    this._positionPanel();
    requestAnimationFrame(() => {
      if (!this.open) return;
      this._positionPanel();
      if (this.searchInput) this.searchInput.focus();
    });

    // Defer outside-dismiss so the opening click cannot immediately close us
    window.setTimeout(() => {
      if (!this.open) return;
      document.addEventListener('mousedown', this._boundDocPointer, true);
      document.addEventListener('keydown', this._boundKeydown, true);
      window.addEventListener('resize', this._boundReposition);
      window.addEventListener('scroll', this._boundReposition, true);
    }, 0);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    if (openInstance === this) openInstance = null;

    this.root.classList.remove('is-open');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.panel.hidden = true;
    this.panel.classList.remove('is-open');
    this._clearPanelPosition();

    // Move panel back under root
    if (this._portal || this.panel.parentElement !== this.root) {
      this.root.appendChild(this.panel);
      this._portal = false;
    }

    document.removeEventListener('mousedown', this._boundDocPointer, true);
    document.removeEventListener('keydown', this._boundKeydown, true);
    window.removeEventListener('resize', this._boundReposition);
    window.removeEventListener('scroll', this._boundReposition, true);
  }

  _clearPanelPosition() {
    const p = this.panel;
    if (!p) return;
    p.style.position = '';
    p.style.left = '';
    p.style.top = '';
    p.style.right = '';
    p.style.width = '';
    p.style.minWidth = '';
    p.style.maxWidth = '';
    p.style.zIndex = '';
  }

  /**
   * Fixed-position menu relative to the trigger.
   * Panel is portaled to document.body while open.
   */
  _positionPanel() {
    if (!this.open || !this.panel || this.panel.hidden) return;

    const rect = this.trigger.getBoundingClientRect();
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const gap = 6;
    const pad = 8;

    const minW = Math.max(rect.width || 0, 160);
    const maxW = Math.max(160, Math.min(300, vw - pad * 2));
    const width = Math.min(maxW, Math.max(minW, Math.min(240, maxW)));

    let left = rect.left;
    if (left + width > vw - pad) left = Math.max(pad, vw - pad - width);
    if (left < pad) left = pad;

    const panel = this.panel;
    panel.style.position = 'fixed';
    panel.style.right = 'auto';
    panel.style.zIndex = '4000';
    panel.style.minWidth = `${Math.round(minW)}px`;
    panel.style.width = `${Math.round(width)}px`;
    panel.style.maxWidth = `${Math.round(maxW)}px`;
    panel.style.left = `${Math.round(left)}px`;

    let top = rect.bottom + gap;
    panel.style.top = `${Math.round(top)}px`;

    const ph = panel.offsetHeight || 0;
    if (ph && top + ph > vh - pad) {
      const up = rect.top - gap - ph;
      if (up >= pad) top = up;
      else top = Math.max(pad, vh - pad - ph);
    }
    panel.style.top = `${Math.round(top)}px`;
  }

  destroy() {
    this.close();
    this.root.innerHTML = '';
    this.root.classList.remove('fancy-select', 'is-open', 'is-disabled');
  }

  _onDocPointer(e) {
    if (!this.open) return;
    const t = e.target;
    if (this.root.contains(t) || this.panel.contains(t)) return;
    this.close();
  }

  _onKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      this.trigger.focus();
    }
  }

  _syncTrigger() {
    const selected = this.options.find((o) => o.value === this.value);
    if (selected) {
      this.valueEl.textContent = selected.label;
      this.valueEl.classList.remove('is-placeholder');
    } else {
      this.valueEl.textContent = this.placeholder;
      this.valueEl.classList.add('is-placeholder');
    }
  }

  _renderOptions() {
    const filter = this._filter;
    const filtered = this.options.filter((o) => {
      if (!filter) return true;
      return (
        o.label.toLowerCase().includes(filter) ||
        o.value.toLowerCase().includes(filter) ||
        (o.hint && o.hint.toLowerCase().includes(filter))
      );
    });

    this.list.innerHTML = '';

    if (!filtered.length) {
      const empty = document.createElement('li');
      empty.className = 'fancy-select__empty';
      empty.textContent = this.options.length ? '无匹配项' : '暂无选项';
      this.list.appendChild(empty);
      if (this.open) requestAnimationFrame(() => this._positionPanel());
      return;
    }

    for (const opt of filtered) {
      const li = document.createElement('li');
      li.className = 'fancy-select__option';
      li.setAttribute('role', 'option');
      li.dataset.value = opt.value;
      if (opt.value === this.value) li.classList.add('is-selected');
      if (opt.disabled) {
        li.classList.add('is-disabled');
        li.setAttribute('aria-disabled', 'true');
      }

      li.innerHTML = `
        <div class="fancy-select__option-main">
          <span class="fancy-select__option-label"></span>
          ${opt.hint ? '<span class="fancy-select__option-hint"></span>' : ''}
        </div>
        <span class="fancy-select__check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
            <path d="M20 6 9 17l-5-5"/>
          </svg>
        </span>
      `;
      li.querySelector('.fancy-select__option-label').textContent = opt.label;
      if (opt.hint) {
        li.querySelector('.fancy-select__option-hint').textContent = opt.hint;
      }

      if (!opt.disabled) {
        li.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.setValue(opt.value);
          this.close();
          this.trigger.focus();
        });
      }

      this.list.appendChild(li);
    }

    if (this.open) {
      requestAnimationFrame(() => this._positionPanel());
    }
  }
}
