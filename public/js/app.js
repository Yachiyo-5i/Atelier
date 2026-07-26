import { FancySelect } from './select.js';
import { buttonClass } from './button.js';

const MAX_GALLERY = 24;

const MAX_EDIT_ASSETS = 8;

const state = {
  config: {
    providers: [],
    activeProviderId: null,
    autoSaveImages: false,
    dataDir: '',
  },
  editingProviderId: null,
  models: [],
  showAllModels: false,
  generating: false,
  gallery: [],
  promptHistory: [],
  selectedPromptText: '',
  mode: 'generate', // generate | edit
  editAssets: [],
};

const $ = (sel) => document.querySelector(sel);

const els = {
  connectionPill: $('#connection-pill'),
  btnSettings: $('#btn-settings'),
  settingsModal: $('#settings-modal'),
  providerList: $('#provider-list'),
  providerName: $('#provider-name'),
  baseUrl: $('#base-url'),
  apiKey: $('#api-key'),
  btnToggleKey: $('#btn-toggle-key'),
  btnAddProvider: $('#btn-add-provider'),
  btnSaveProvider: $('#btn-save-provider'),
  btnActivateProvider: $('#btn-activate-provider'),
  btnDeleteProvider: $('#btn-delete-provider'),
  autoSaveImages: $('#auto-save-images'),
  btnFetchModels: $('#btn-fetch-models'),
  settingsStatus: $('#settings-status'),
  dataDirHint: $('#data-dir-hint'),
  providerForm: $('#provider-form'),
  providerEditorTitle: $('#provider-editor-title'),
  providerEditorHint: $('#provider-editor-hint'),
  providerEditorBadge: $('#provider-editor-badge'),
  activeProviderHint: $('#active-provider-hint'),
  modelsList: $('#models-list'),
  modelsSummary: $('#models-summary'),
  showAllModels: $('#show-all-models'),
  modelMount: $('#model-select'),
  sizeMount: $('#size-select'),
  qualityMount: $('#quality-select'),
  responseFormatMount: $('#response-format-select'),
  styleMount: $('#style-select'),
  btnRefreshModels: $('#btn-refresh-models'),
  modeToggle: $('#mode-toggle'),
  modeHint: $('#mode-hint'),
  editAssetsPanel: $('#edit-assets-panel'),
  editAssetsList: $('#edit-assets-list'),
  editAssetsCount: $('#edit-assets-count'),
  btnEditUpload: $('#btn-edit-upload'),
  btnEditClear: $('#btn-edit-clear'),
  editFileInput: $('#edit-file-input'),
  panelNote: $('#panel-note'),
  form: $('#gen-form'),
  prompt: $('#prompt'),
  btnPromptHistory: $('#btn-prompt-history'),
  promptModal: $('#prompt-modal'),
  promptHistoryList: $('#prompt-history-list'),
  promptEmpty: $('#prompt-empty'),
  promptCount: $('#prompt-count'),
  btnClearPrompts: $('#btn-clear-prompts'),
  promptDetailModal: $('#prompt-detail-modal'),
  promptDetailText: $('#prompt-detail-text'),
  btnPromptDetailUse: $('#btn-prompt-detail-use'),
  btnPromptDetailDelete: $('#btn-prompt-detail-delete'),
  n: $('#n'),
  extraJson: $('#extra-json'),
  btnGenerate: $('#btn-generate'),
  btnClearGallery: $('#btn-clear-gallery'),
  formError: $('#form-error'),
  formToast: $('#form-toast'),
  gallery: $('#gallery'),
  emptyState: $('#empty-state'),
  btnEmptySettings: $('#btn-empty-settings'),
  statusBar: $('#status-bar'),
  statusText: $('#status-text'),
  resultMeta: $('#result-meta'),
  lightbox: $('#lightbox'),
  lightboxImg: $('#lightbox-img'),
  confirmModal: $('#confirm-modal'),
  confirmTitle: $('#confirm-title'),
  confirmMessage: $('#confirm-message'),
  btnConfirmOk: $('#btn-confirm-ok'),
  btnConfirmCancel: $('#btn-confirm-cancel'),
};

const selects = {
  model: null,
  size: null,
  quality: null,
  responseFormat: null,
  style: null,
};

let toastTimer = null;
let statusTimer = null;
let statusStartedAt = 0;

// ---------- Server-backed gallery (data/images is the source of truth) ----------

function libraryRecordToItem(rec) {
  const meta = rec.meta || {};
  const params = meta.params && typeof meta.params === 'object' ? meta.params : null;
  return {
    id: rec.id,
    src: rec.localUrl,
    originalSrc: rec.localUrl,
    remoteUrl: '',
    b64_json: '',
    kind: 'local',
    mode: meta.mode || params?.mode || 'generate',
    model: meta.model || params?.model || '',
    size: meta.size || params?.size || '',
    prompt: meta.prompt || params?.prompt || '',
    revisedPrompt: meta.revisedPrompt || '',
    createdAt: rec.createdAt || 0,
    params: params || {
      prompt: meta.prompt || '',
      model: meta.model || '',
      size: meta.size || '',
      mode: meta.mode || 'generate',
    },
    local: {
      id: rec.id,
      filename: rec.filename,
      localUrl: rec.localUrl,
      downloadUrl: rec.downloadUrl,
      saved: !rec.temp,
      temp: Boolean(rec.temp),
      materialized: true,
    },
  };
}

async function loadGallery() {
  try {
    const res = await fetch(`/api/images?limit=${MAX_GALLERY}`);
    const data = await res.json();
    if (res.ok && Array.isArray(data.data)) {
      // Keep transient (non-materialized) items from this session on top.
      const transient = state.gallery.filter((item) => !item.local?.id);
      state.gallery = [...transient, ...data.data.map(libraryRecordToItem)].slice(
        0,
        MAX_GALLERY,
      );
      return;
    }
  } catch (err) {
    console.warn('load gallery failed', err);
  }
}

function isLocalApiSrc(src) {
  return typeof src === 'string' && (
    src.includes('/api/images/local/') || src.includes('/api/images/proxy')
  );
}

function isEphemeralImageUrl(src) {
  if (!src || typeof src !== 'string') return false;
  if (src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('/')) return false;
  try {
    const host = new URL(src, window.location.origin).hostname.toLowerCase();
    // x.ai temp CDN and similar short-lived hosts block browser hotlinks (403).
    if (host === 'imgen.x.ai' || host.endsWith('.x.ai')) return true;
    if (host.includes('xai-tmp') || host.includes('xai-imgen')) return true;
    if (host.includes('oaidalleapiprodscus') || host.includes('blob.core.windows.net')) return true;
    if (host.includes('openai.com') && host.includes('blob')) return true;
    return false;
  } catch {
    return false;
  }
}

/** Only same-origin / data / blob are safe for <img> in this app. */
function isBrowserSafeImageSrc(src) {
  if (!src || typeof src !== 'string') return false;
  if (src.startsWith('data:') || src.startsWith('blob:')) return true;
  if (src.startsWith('/')) return true;
  try {
    const u = new URL(src, window.location.origin);
    return u.origin === window.location.origin;
  } catch {
    return false;
  }
}

function toDataUrl(b64) {
  if (!b64) return '';
  return b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
}

function durableSrcCandidates(item) {
  const list = [];
  if (item?.local?.saved && item?.local?.id && !item.local?.missing) {
    list.push(item.local.localUrl || `/api/images/local/${item.local.id}`);
  }
  if (item?.local?.localUrl) list.push(item.local.localUrl);
  if (item?.b64_json) list.push(toDataUrl(item.b64_json));
  for (const src of [item?.src, item?.originalSrc]) {
    if (src && isBrowserSafeImageSrc(src)) list.push(src);
  }
  // Absolute ban: never return third-party CDN urls (imgen.x.ai etc.)
  return [...new Set(list.filter((s) => s && isBrowserSafeImageSrc(s)))];
}

function scrubGalleryItem(item) {
  if (!item || typeof item !== 'object') return item;
  const durable = durableSrcCandidates(item);
  const safeSrc = durable[0] || '';

  if (item.src && !isBrowserSafeImageSrc(item.src)) {
    if (item.remoteUrl == null && /^https?:\/\//i.test(item.src)) {
      item.remoteUrl = item.src; // keep for manual server-side save only
    }
    item.src = safeSrc;
    if (!safeSrc) {
      item.note = item.note || '远程临时链接不可用，请重新生成';
    }
  }
  if (item.originalSrc && !isBrowserSafeImageSrc(item.originalSrc)) {
    item.originalSrc = safeSrc;
  }
  // Never keep CDN as display fields
  if (item.remoteUrl && isEphemeralImageUrl(item.remoteUrl)) {
    // retain remoteUrl only as opaque metadata for server save; not for <img>
  }
  return item;
}

function markLocalMissing(item, nextSrc = '') {
  const prevId = item.local?.id;
  item.local = { saved: false, missing: true, ...(prevId ? { lostId: prevId } : {}) };
  if (nextSrc) {
    item.src = nextSrc;
    item.note = '';
  } else {
    item.src = '';
    item.note = '本地文件已删除，且无可回退预览';
  }
}

function attachImageWithFallback(shot, item) {
  const img = document.createElement('img');
  img.alt = item.params?.prompt || item.prompt || 'generated';
  img.loading = 'lazy';
  img.draggable = false;
  img.referrerPolicy = 'no-referrer';

  // Strict same-origin / data only — never put imgen.x.ai into <img>.
  const chain = durableSrcCandidates(item);
  if (item.src && isBrowserSafeImageSrc(item.src) && !chain.includes(item.src)) {
    chain.unshift(item.src);
  }

  let index = 0;
  let settled = false;
  const use = (src) => {
    if (!isBrowserSafeImageSrc(src)) return false;
    img.src = src;
    return true;
  };

  img.addEventListener('error', () => {
    if (settled) return;
    const failed = chain[index];

    if (failed && isLocalApiSrc(failed) && failed.includes('/api/images/local/') && (item.local?.saved || item.local?.id)) {
      // Local file missing — clear saved flag, but do NOT jump to CDN.
      const nextSafe = chain.slice(index + 1).find((s) => isBrowserSafeImageSrc(s)) || '';
      markLocalMissing(item, nextSafe);
      updateShotLocalStatus(shot, item);
    }

    index += 1;
    while (index < chain.length) {
      if (use(chain[index])) {
        item.src = chain[index];
        return;
      }
      index += 1;
    }

    // Exhausted durable sources — placeholder once, no re-render loop.
    settled = true;
    if (!item.note) {
      item.note = item.local?.error
        ? `图片不可用: ${item.local.error}`
        : '图片不可用';
    }
    if (!item.local?.missing) {
      markLocalMissing(item, '');
    }
    const placeholder = createMissingEl(item.note || '图片不可用');
    img.replaceWith(placeholder);
    updateShotLocalStatus(shot, item);
    // Update menus without full gallery remount (avoids flicker).
    const veil = shot.querySelector('.shot__veil');
    if (veil) {
      // soft refresh status only
    }
  });

  if (chain.length && use(chain[0])) {
    item.src = chain[0];
    return img;
  }
  return createMissingEl(item.note || '无法预览');
}

function createMissingEl(text) {
  const placeholder = document.createElement('div');
  placeholder.className = 'shot__missing';
  placeholder.textContent = text || '无法预览';
  return placeholder;
}

function formatLocalStatusText(item) {
  const saved = Boolean(item?.local?.saved && item?.local?.id);
  const missing = Boolean(item?.local?.missing);
  if (saved) return '已保存';
  if (missing) return '已失效';
  return '未保存';
}

function updateShotLocalStatus(shot, item) {
  const saved = Boolean(item.local?.saved && item.local?.id);
  const missing = Boolean(item.local?.missing);
  const status = shot.querySelector('.shot__status');
  if (status) {
    status.className = `shot__status ${saved ? 'is-saved' : 'is-unsaved'}${missing ? ' is-lost' : ''}`;
    status.textContent = formatLocalStatusText(item);
  }
}

// ---------- Config / providers ----------

function activeProvider() {
  return (
    state.config.providers.find((p) => p.id === state.config.activeProviderId) || null
  );
}

function hasActiveProvider() {
  const p = activeProvider();
  return Boolean(p?.baseUrl && p?.apiKey);
}

function updateConnectionPill() {
  const p = activeProvider();
  if (!p) {
    els.connectionPill.textContent = '未配置 Provider';
    els.connectionPill.className = 'pill pill-muted';
    return;
  }
  const imageCount = state.models.filter((m) => m.isImageModel).length;
  if (state.models.length) {
    els.connectionPill.textContent = `${p.name} · ${imageCount} 文生图`;
    els.connectionPill.className = 'pill pill-ok';
  } else {
    els.connectionPill.textContent = `${p.name} · 待拉取模型`;
    els.connectionPill.className = 'pill pill-warn';
  }
}

async function loadConfig() {
  const res = await fetch('/api/config');
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || '加载配置失败');
  state.config = {
    providers: data.providers || [],
    activeProviderId: data.activeProviderId || null,
    autoSaveImages: Boolean(data.autoSaveImages),
    dataDir: data.dataDir || '',
  };
  if (!state.editingProviderId && state.config.providers.length) {
    state.editingProviderId =
      state.config.activeProviderId || state.config.providers[0].id;
  }
  syncSettingsForm();
  renderProviderList();
  updateConnectionPill();
}

async function saveConfig(partial = {}) {
  const body = {
    providers: partial.providers ?? state.config.providers,
    activeProviderId: partial.activeProviderId ?? state.config.activeProviderId,
    autoSaveImages:
      partial.autoSaveImages !== undefined
        ? partial.autoSaveImages
        : state.config.autoSaveImages,
  };
  const res = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || '保存配置失败');
  state.config = {
    providers: data.providers || [],
    activeProviderId: data.activeProviderId || null,
    autoSaveImages: Boolean(data.autoSaveImages),
    dataDir: data.dataDir || state.config.dataDir,
  };

  // Never clobber the in-progress editor just because unrelated settings changed.
  if (els.autoSaveImages) {
    els.autoSaveImages.checked = Boolean(state.config.autoSaveImages);
  }
  if (els.dataDirHint) {
    els.dataDirHint.textContent = state.config.dataDir
      ? `本地目录：${state.config.dataDir}`
      : '本地目录：-';
  }
  renderProviderList();
  updateConnectionPill();
  updateProviderEditorChrome();
  return data;
}

function getEditingProvider() {
  if (!state.editingProviderId) return null;
  return state.config.providers.find((p) => p.id === state.editingProviderId) || null;
}

function isCreatingProvider() {
  return !state.editingProviderId;
}

function readEditorProvider() {
  return {
    name: els.providerName.value.trim() || '未命名',
    baseUrl: els.baseUrl.value.trim(),
    apiKey: els.apiKey.value.trim(),
  };
}

function isProviderFormDirty() {
  const draft = {
    name: els.providerName.value.trim(),
    baseUrl: els.baseUrl.value.trim(),
    apiKey: els.apiKey.value.trim(),
  };

  if (isCreatingProvider()) {
    return Boolean(draft.name || draft.baseUrl || draft.apiKey);
  }

  const current = getEditingProvider();
  if (!current) return Boolean(draft.name || draft.baseUrl || draft.apiKey);

  return (
    draft.name !== (current.name || '') ||
    draft.baseUrl !== (current.baseUrl || '') ||
    draft.apiKey !== (current.apiKey || '')
  );
}

function updateProviderEditorChrome() {
  const creating = isCreatingProvider();
  const editing = getEditingProvider();
  const active = activeProvider();
  const isActive = Boolean(editing && editing.id === state.config.activeProviderId);

  if (els.providerEditorTitle) {
    els.providerEditorTitle.textContent = creating ? '新建 Provider' : '编辑 Provider';
  }
  if (els.providerEditorHint) {
    if (creating) {
      els.providerEditorHint.textContent = '填写后点「保存」。若还没有生效项，保存后会自动设为生效。';
    } else if (isActive) {
      els.providerEditorHint.textContent = '当前正在编辑生效中的 Provider。';
    } else {
      els.providerEditorHint.textContent = '编辑后点「保存」。需要切换时再用「设为生效」。';
    }
  }
  if (els.providerEditorBadge) {
    els.providerEditorBadge.classList.toggle('hidden', !creating);
    els.providerEditorBadge.textContent = '新建中';
    els.providerEditorBadge.classList.toggle('badge-image', false);
    els.providerEditorBadge.classList.toggle('badge-other', true);
  }

  if (els.btnDeleteProvider) {
    els.btnDeleteProvider.disabled = creating;
    els.btnDeleteProvider.title = creating ? '新建中的草稿还不能删除' : '删除这个 Provider';
  }
  if (els.btnActivateProvider) {
    els.btnActivateProvider.disabled = creating || isActive;
    if (creating) {
      els.btnActivateProvider.textContent = '设为生效';
      els.btnActivateProvider.title = '请先保存这个 Provider';
    } else if (isActive) {
      els.btnActivateProvider.textContent = '生效中';
      els.btnActivateProvider.title = '这已经是当前生效 Provider';
    } else {
      els.btnActivateProvider.textContent = '设为生效';
      els.btnActivateProvider.title = '把这个 Provider 设为生效';
    }
  }
  if (els.btnSaveProvider) {
    els.btnSaveProvider.textContent = creating ? '保存并启用' : '保存';
  }
  if (els.activeProviderHint) {
    els.activeProviderHint.textContent = active
      ? `生效 Provider：${active.name || '未命名'}`
      : '生效 Provider：未设置';
  }
}

function syncSettingsForm() {
  els.autoSaveImages.checked = Boolean(state.config.autoSaveImages);
  els.dataDirHint.textContent = state.config.dataDir
    ? `本地目录：${state.config.dataDir}`
    : '本地目录：-';

  const editing = getEditingProvider();
  if (editing) {
    els.providerName.value = editing.name || '';
    els.baseUrl.value = editing.baseUrl || '';
    els.apiKey.value = editing.apiKey || '';
  } else if (!isCreatingProvider()) {
    // stale id
    state.editingProviderId = null;
    els.providerName.value = '';
    els.baseUrl.value = '';
    els.apiKey.value = '';
  }
  // creating: keep whatever is currently typed unless caller cleared it

  updateProviderEditorChrome();
}

function renderProviderList() {
  els.providerList.innerHTML = '';

  const providers = state.config.providers || [];
  const creating = isCreatingProvider();

  if (!providers.length && !creating) {
    const li = document.createElement('li');
    li.className = 'provider-item provider-item--empty';
    li.innerHTML =
      '还没有 Provider。<button type="button" class="linkish" data-act="add-provider">点这里新增</button>';
    li.querySelector('[data-act="add-provider"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      startCreateProvider();
    });
    els.providerList.appendChild(li);
    updateProviderEditorChrome();
    return;
  }

  if (creating) {
    const draft = document.createElement('li');
    draft.className = 'provider-item is-editing is-draft';
    draft.innerHTML = `
      <div class="provider-item__main">
        <strong>新建 Provider</strong>
        <span class="provider-item__url">填写右侧表单后保存</span>
      </div>
      <div class="provider-item__badges">
        <span class="badge badge-other">草稿</span>
      </div>
    `;
    els.providerList.appendChild(draft);
  }

  for (const p of providers) {
    const li = document.createElement('li');
    const active = p.id === state.config.activeProviderId;
    const editing = p.id === state.editingProviderId;
    li.className = `provider-item${active ? ' is-active' : ''}${editing ? ' is-editing' : ''}`;
    li.innerHTML = `
      <div class="provider-item__main">
        <strong>${escapeHtml(p.name || '未命名')}</strong>
        <span class="provider-item__url">${escapeHtml(p.baseUrl || '未填 BaseURL')}</span>
      </div>
      <div class="provider-item__badges">
        ${active ? '<span class="badge badge-image">生效中</span>' : ''}
      </div>
    `;
    li.addEventListener('click', () => {
      void selectProvider(p.id);
    });
    els.providerList.appendChild(li);
  }

  updateProviderEditorChrome();
}

async function selectProvider(id) {
  if (state.editingProviderId === id) return;

  if (isProviderFormDirty()) {
    const ok = await askConfirm({
      title: '放弃未保存的修改？',
      message: '当前表单有未保存内容，切换后会丢失。',
      confirmLabel: '放弃并切换',
      cancelLabel: '继续编辑',
    });
    if (!ok) return;
  }

  state.editingProviderId = id;
  // load selected provider fields
  const editing = getEditingProvider();
  els.providerName.value = editing?.name || '';
  els.baseUrl.value = editing?.baseUrl || '';
  els.apiKey.value = editing?.apiKey || '';
  els.apiKey.type = 'password';
  els.btnToggleKey.textContent = '显示';
  hideSettingsBanner();
  renderProviderList();
}

function startCreateProvider({ force = false } = {}) {
  if (!force && isCreatingProvider() && !isProviderFormDirty()) {
    els.providerName.focus();
    updateProviderEditorChrome();
    return;
  }

  const begin = () => {
    state.editingProviderId = null;
    els.providerName.value = '';
    els.baseUrl.value = '';
    els.apiKey.value = '';
    els.apiKey.type = 'password';
    els.btnToggleKey.textContent = '显示';
    hideSettingsBanner();
    renderProviderList();
    showSettingsBanner('info', '填写名称、BaseURL 和 API Key，然后点「保存并启用」。');
    els.providerName.focus();
  };

  if (isProviderFormDirty()) {
    void askConfirm({
      title: '放弃未保存的修改？',
      message: '当前表单有未保存内容，开始新建会清空表单。',
      confirmLabel: '放弃并新建',
      cancelLabel: '继续编辑',
    }).then((ok) => {
      if (ok) begin();
    });
    return;
  }

  begin();
}

async function saveCurrentProvider({ activate = false } = {}) {
  const draft = readEditorProvider();
  if (!draft.baseUrl) throw new Error('BaseURL 不能为空');
  if (!draft.apiKey) throw new Error('API Key 不能为空');

  const providers = [...state.config.providers];
  const creating = isCreatingProvider();
  let targetId = state.editingProviderId;

  if (!creating) {
    const idx = providers.findIndex((p) => p.id === state.editingProviderId);
    if (idx >= 0) {
      providers[idx] = {
        ...providers[idx],
        ...draft,
        updatedAt: Date.now(),
      };
      targetId = providers[idx].id;
    } else {
      // stale id -> create
      targetId = crypto.randomUUID();
      providers.push({ id: targetId, ...draft, createdAt: Date.now(), updatedAt: Date.now() });
    }
  } else {
    targetId = crypto.randomUUID();
    providers.push({ id: targetId, ...draft, createdAt: Date.now(), updatedAt: Date.now() });
  }

  state.editingProviderId = targetId;

  // Activate when requested, when creating first provider, or when no active remains.
  const hasActive =
    state.config.activeProviderId &&
    providers.some((p) => p.id === state.config.activeProviderId);
  const shouldActivate = activate || creating || !hasActive;
  const activeProviderId = shouldActivate
    ? targetId
    : state.config.activeProviderId;

  await saveConfig({
    providers,
    activeProviderId,
    autoSaveImages: els.autoSaveImages.checked,
  });

  // Reflect persisted values (trim/default name etc.)
  const saved = state.config.providers.find((p) => p.id === targetId);
  if (saved) {
    els.providerName.value = saved.name || '';
    els.baseUrl.value = saved.baseUrl || '';
    els.apiKey.value = saved.apiKey || '';
  }
  updateProviderEditorChrome();

  return { created: creating, activated: shouldActivate, id: targetId };
}

// ---------- UI helpers ----------

function showSettingsBanner(type, message) {
  els.settingsStatus.classList.remove('hidden', 'banner-error', 'banner-ok', 'banner-info');
  els.settingsStatus.classList.add(
    type === 'error' ? 'banner-error' : type === 'ok' ? 'banner-ok' : 'banner-info',
  );
  els.settingsStatus.textContent = message;
}

function hideSettingsBanner() {
  els.settingsStatus.classList.add('hidden');
  els.settingsStatus.textContent = '';
}

function showFormError(message) {
  if (!message) {
    els.formError.classList.add('hidden');
    els.formError.textContent = '';
    return;
  }
  hideFormToast();
  els.formError.classList.remove('hidden');
  els.formError.textContent = message;
}

function showFormToast(message) {
  if (!message) return hideFormToast();
  showFormError('');
  els.formToast.classList.remove('hidden');
  els.formToast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hideFormToast(), 2600);
}

function hideFormToast() {
  els.formToast.classList.add('hidden');
  els.formToast.textContent = '';
}

function openSettings() {
  hideSettingsBanner();
  els.apiKey.type = 'password';
  els.btnToggleKey.textContent = '显示';

  if (!state.config.providers.length) {
    state.editingProviderId = null;
    els.providerName.value = '';
    els.baseUrl.value = '';
    els.apiKey.value = '';
  } else if (
    !state.editingProviderId ||
    !state.config.providers.some((p) => p.id === state.editingProviderId)
  ) {
    state.editingProviderId =
      state.config.activeProviderId || state.config.providers[0].id;
  }

  syncSettingsForm();
  renderProviderList();
  els.settingsModal.classList.remove('hidden');
  document.body.classList.add('modal-open');

  if (!state.config.providers.length) {
    showSettingsBanner('info', '先新增一个 Provider，才能生成图片。');
    queueMicrotask(() => els.providerName?.focus());
  }
}

function closeSettings() {
  els.settingsModal.classList.add('hidden');
  if (
    els.promptModal.classList.contains('hidden') &&
    els.promptDetailModal.classList.contains('hidden') &&
    els.lightbox.classList.contains('hidden') &&
    els.confirmModal.classList.contains('hidden')
  ) {
    document.body.classList.remove('modal-open');
  }
}

function openPromptModal() {
  renderPromptHistory();
  els.promptModal.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closePromptModal() {
  els.promptModal.classList.add('hidden');
  if (
    els.settingsModal.classList.contains('hidden') &&
    els.lightbox.classList.contains('hidden') &&
    els.confirmModal.classList.contains('hidden') &&
    els.promptDetailModal.classList.contains('hidden')
  ) {
    document.body.classList.remove('modal-open');
  }
}

function openPromptDetail(text) {
  state.selectedPromptText = String(text || '');
  els.promptDetailText.textContent = state.selectedPromptText;
  els.promptDetailModal.classList.remove('hidden');
  document.body.classList.add('modal-open');
  // scroll detail to top
  els.promptDetailText.scrollTop = 0;
}

function closePromptDetail() {
  els.promptDetailModal.classList.add('hidden');
  state.selectedPromptText = '';
  if (
    els.settingsModal.classList.contains('hidden') &&
    els.lightbox.classList.contains('hidden') &&
    els.confirmModal.classList.contains('hidden') &&
    els.promptModal.classList.contains('hidden')
  ) {
    document.body.classList.remove('modal-open');
  }
}

function useSelectedPrompt() {
  const text = state.selectedPromptText;
  if (!text) return;
  els.prompt.value = text;
  closePromptDetail();
  closePromptModal();
  els.prompt.focus();
  showFormToast('已填入历史 Prompt');
}

async function deleteSelectedPrompt() {
  const text = state.selectedPromptText;
  if (!text) return;
  state.promptHistory = state.promptHistory.filter((p) => p !== text);
  await persistPromptHistory();
  closePromptDetail();
  renderPromptHistory();
  showFormToast('已删除该历史 Prompt');
}

function formatElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${sec}s`;
}

function updateStatusElapsed() {
  const elapsed = formatElapsed(Date.now() - statusStartedAt);
  const prefix = state.mode === 'edit' ? '正在请求编辑接口…' : '正在请求上游…';
  els.statusText.innerHTML = `${prefix} <span class="status-elapsed">${elapsed}</span>`;
}

function stopStatusTimer() {
  if (statusTimer != null) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  statusStartedAt = 0;
}

function startStatusTimer() {
  stopStatusTimer();
  statusStartedAt = Date.now();
  updateStatusElapsed();
  statusTimer = setInterval(updateStatusElapsed, 250);
}

function primaryActionLabel({ loading = false } = {}) {
  if (state.mode === 'edit') return loading ? '编辑中…' : '编辑生成';
  return loading ? '生成中…' : '生成图片';
}

function setGenerating(loading) {
  state.generating = loading;
  els.btnGenerate.disabled = loading;
  els.btnGenerate.querySelector('.btn-label').textContent = primaryActionLabel({ loading });
  els.statusBar.classList.toggle('hidden', !loading);
  if (loading) {
    startStatusTimer();
  } else {
    stopStatusTimer();
    els.statusText.textContent =
      state.mode === 'edit' ? '正在请求编辑接口…' : '正在请求上游…';
  }
}

// ---------- Mode / edit assets ----------

function setMode(mode, { silent = false } = {}) {
  const next = mode === 'edit' ? 'edit' : 'generate';
  state.mode = next;

  if (els.modeToggle) {
    els.modeToggle.querySelectorAll('[data-mode]').forEach((btn) => {
      const active = btn.dataset.mode === next;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  if (els.editAssetsPanel) {
    els.editAssetsPanel.classList.toggle('hidden', next !== 'edit');
  }

  if (els.modeHint) {
    els.modeHint.textContent =
      next === 'edit'
        ? 'Edits · 拖拽/粘贴/上传参考图后按 Prompt 改图'
        : 'Generations · 纯文生图';
  }

  if (els.panelNote) {
    els.panelNote.textContent =
      next === 'edit'
        ? '编辑模式 · 从结果区可快速加入参考图'
        : '点击图片预览 · 操作区可回填 / 加入编辑 / 保存 / 删除';
  }

  if (!state.generating) {
    els.btnGenerate.querySelector('.btn-label').textContent = primaryActionLabel();
  }

  if (!silent && next === 'edit') {
    renderEditAssets();
  }
}

function revokeAssetPreview(asset) {
  if (asset?.kind === 'file' && asset.previewUrl?.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(asset.previewUrl);
    } catch {
      /* ignore */
    }
  }
}

function clearEditAssets() {
  for (const asset of state.editAssets) revokeAssetPreview(asset);
  state.editAssets = [];
  renderEditAssets();
}

function removeEditAsset(id) {
  const idx = state.editAssets.findIndex((a) => a.id === id);
  if (idx < 0) return;
  revokeAssetPreview(state.editAssets[idx]);
  state.editAssets.splice(idx, 1);
  renderEditAssets();
}

function renderEditAssets() {
  if (!els.editAssetsList) return;
  const list = state.editAssets;
  els.editAssetsCount.textContent = `${list.length} / ${MAX_EDIT_ASSETS}`;
  els.editAssetsList.innerHTML = '';

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'edit-assets__empty';
    empty.innerHTML =
      '<div class="edit-assets__empty-title">暂无参考图</div>' +
      '<div class="edit-assets__empty-sub">拖拽 / 粘贴图片到此处，或点击上传 · 也可从结果加入</div>';
    els.editAssetsList.appendChild(empty);
    return;
  }

  for (const asset of list) {
    const chip = document.createElement('div');
    chip.className = 'edit-chip';
    chip.title = asset.name || '参考图';

    if (asset.previewUrl) {
      const img = document.createElement('img');
      img.src = asset.previewUrl;
      img.alt = asset.name || 'edit asset';
      img.draggable = false;
      chip.appendChild(img);
    } else {
      const miss = document.createElement('div');
      miss.className = 'shot__missing';
      miss.textContent = '无预览';
      chip.appendChild(miss);
    }

    const badge = document.createElement('span');
    badge.className = 'edit-chip__badge';
    badge.textContent =
      asset.kind === 'file'
        ? asset.source === 'paste'
          ? '粘贴'
          : asset.source === 'drop'
            ? '拖入'
            : '上传'
        : asset.localId
          ? '本地'
          : '结果';
    chip.appendChild(badge);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'edit-chip__remove';
    remove.setAttribute('aria-label', '移除参考图');
    remove.textContent = '×';
    remove.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeEditAsset(asset.id);
    });
    chip.appendChild(remove);

    els.editAssetsList.appendChild(chip);
  }
}

function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('image/')) return true;
  // Some OS/browser pastes omit MIME; fall back to extension.
  return /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|svg)$/i.test(file.name || '');
}

function dedupeFiles(files) {
  const out = [];
  const seen = new Set();
  for (const f of files) {
    if (!f) continue;
    const key = `${f.name || ''}|${f.size || 0}|${f.type || ''}|${f.lastModified || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** Collect image files from a DataTransfer / clipboard DataTransfer. */
function extractImageFilesFromDataTransfer(dt) {
  if (!dt) return [];
  const found = [];

  if (dt.files && dt.files.length) {
    for (const f of dt.files) {
      if (isImageFile(f)) found.push(f);
    }
  }

  if (dt.items && dt.items.length) {
    for (const item of dt.items) {
      if (item.kind === 'file' && (item.type?.startsWith('image/') || !item.type)) {
        const f = item.getAsFile?.();
        if (f && isImageFile(f)) found.push(f);
      }
    }
  }

  return dedupeFiles(found);
}

/**
 * @param {FileList|File[]|null|undefined} fileList
 * @param {{ source?: string, silentEmpty?: boolean }} [opts]
 * @returns {number} added count
 */
function addFilesToEdit(fileList, opts = {}) {
  const source = opts.source || 'upload';
  const files = dedupeFiles(Array.from(fileList || []).filter(isImageFile));
  if (!files.length) {
    if (!opts.silentEmpty) showFormError('请选择图片文件');
    return 0;
  }

  let added = 0;
  for (const file of files) {
    if (state.editAssets.length >= MAX_EDIT_ASSETS) break;
    const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fallbackName =
      source === 'paste'
        ? `paste-${Date.now()}.png`
        : source === 'drop'
          ? `drop-${Date.now()}.png`
          : 'upload.png';
    state.editAssets.push({
      id,
      kind: 'file',
      source,
      name: file.name || fallbackName,
      previewUrl: URL.createObjectURL(file),
      file,
    });
    added += 1;
  }

  if (!added) {
    showFormError(`参考图最多 ${MAX_EDIT_ASSETS} 张`);
    return 0;
  }

  setMode('edit', { silent: true });
  renderEditAssets();
  const label =
    source === 'paste' ? '粘贴' : source === 'drop' ? '拖入' : '上传';
  showFormToast(`已${label} ${added} 张参考图`);
  if (files.length > added) {
    showFormError(`已达上限 ${MAX_EDIT_ASSETS} 张，部分文件未加入`);
  }
  return added;
}

function isEditAssetsHotzoneActive() {
  return (
    state.mode === 'edit' &&
    els.editAssetsPanel &&
    !els.editAssetsPanel.classList.contains('hidden')
  );
}

function extractLocalIdFromSrc(src) {
  if (!src) return '';
  const m = String(src).match(/\/api\/images\/local\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function addGalleryItemToEdit(item) {
  if (!item) return;
  if (state.editAssets.length >= MAX_EDIT_ASSETS) {
    showFormError(`参考图最多 ${MAX_EDIT_ASSETS} 张`);
    return;
  }

  const already = state.editAssets.some(
    (a) => a.sourceItemId && a.sourceItemId === item.id,
  );
  if (already) {
    setMode('edit');
    showFormToast('该结果已在编辑资源中');
    return;
  }

  const localId =
    (item.local?.saved && item.local?.id && !item.local?.missing
      ? item.local.id
      : '') || extractLocalIdFromSrc(item.src) || extractLocalIdFromSrc(item.local?.localUrl);

  let b64 = item.b64_json || '';
  if (!b64 && item.originalSrc?.startsWith('data:')) b64 = item.originalSrc;
  if (!b64 && item.src?.startsWith('data:')) b64 = item.src;

  // Prefer local paths only — never hand ephemeral CDN urls to edits.
  let url = '';
  if (item.local?.localUrl) url = item.local.localUrl;
  else if (item.src && isLocalApiSrc(item.src)) url = item.src;
  else if (item.originalSrc && isLocalApiSrc(item.originalSrc)) url = item.originalSrc;
  else if (item.src && isBrowserSafeImageSrc(item.src)) url = item.src;
  else if (item.originalSrc && isBrowserSafeImageSrc(item.originalSrc)) url = item.originalSrc;

  if (!localId && !b64 && !url) {
    showFormError('该结果没有可用的图片数据，无法加入编辑');
    return;
  }

  const previewUrl =
    (item.src && !isEphemeralImageUrl(item.src) ? item.src : '') ||
    (item.local?.localUrl || '') ||
    (b64 ? toDataUrl(b64) : '') ||
    item.originalSrc ||
    '';

  state.editAssets.push({
    id: `gallery-${item.id}-${Date.now()}`,
    kind: 'gallery',
    sourceItemId: item.id,
    name: truncate(item.params?.prompt || item.prompt || item.model || 'gallery', 28),
    previewUrl,
    localId: localId || null,
    url: url || null,
    b64_json: b64 || null,
  });

  setMode('edit');
  renderEditAssets();
  showFormToast('已加入编辑参考图');
}

function assetToImageRef(asset) {
  if (!asset) return null;
  if (asset.localId) return { localId: String(asset.localId) };
  if (asset.b64_json) return { b64_json: asset.b64_json };
  if (asset.url) return { url: asset.url };
  return null;
}

async function submitImageRequest({ body, params }) {
  if (state.mode === 'edit') {
    if (!state.editAssets.length) {
      throw new Error('请至少添加一张编辑参考图（上传或从结果区加入）');
    }

    const fileAssets = state.editAssets.filter((a) => a.kind === 'file' && a.file);
    const refAssets = state.editAssets.filter((a) => !(a.kind === 'file' && a.file));

    let res;
    if (fileAssets.length) {
      const fd = new FormData();
      for (const [key, value] of Object.entries(body)) {
        if (value == null || value === '') continue;
        if (typeof value === 'object') fd.append(key, JSON.stringify(value));
        else fd.append(key, String(value));
      }
      for (const asset of fileAssets) {
        fd.append('image', asset.file, asset.name || 'image.png');
      }
      const refs = refAssets.map(assetToImageRef).filter(Boolean);
      if (refs.length) fd.append('images', JSON.stringify(refs));
      res = await fetch('/api/images/edits', { method: 'POST', body: fd });
    } else {
      const images = state.editAssets.map(assetToImageRef).filter(Boolean);
      if (!images.length) throw new Error('参考图数据无效');
      res = await fetch('/api/images/edits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, images }),
      });
    }

    const data = await res.json();
    if (!res.ok) {
      const msg =
        data?.error?.message ||
        (typeof data?.error === 'string' ? data.error : null) ||
        JSON.stringify(data?.error || data) ||
        `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  const res = await fetch('/api/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg =
      data?.error?.message ||
      (typeof data?.error === 'string' ? data.error : null) ||
      JSON.stringify(data?.error || data) ||
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function truncate(str, n = 96) {
  const s = String(str || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function imageSrcFromNormalized(img) {
  // Prefer local materialization, then base64, then same-origin proxy/url.
  // Absolute ban on third-party CDNs (imgen.x.ai etc.).
  if (img?.local?.localUrl && isBrowserSafeImageSrc(img.local.localUrl)) {
    return img.local.localUrl;
  }
  if (img?.local?.saved && img?.local?.id) {
    return `/api/images/local/${img.local.id}`;
  }
  if (img?.b64_json) return toDataUrl(img.b64_json);
  if (img?.url && isBrowserSafeImageSrc(img.url)) return img.url;
  return '';
}

// ---------- Models ----------

function ensureModelOption(modelId) {
  if (!modelId) return;
  const current = selects.model.options || [];
  if (!current.some((o) => o.value === modelId)) {
    selects.model.setOptions([{ value: modelId, label: modelId }, ...current], {
      keepValue: false,
    });
  }
  selects.model.setValue(modelId, { silent: true });
}

function renderModelSelect() {
  const imageModels = state.models.filter((m) => m.isImageModel);
  const options = imageModels.map((m) => ({ value: m.id, label: m.id }));
  selects.model.setOptions(options, { keepValue: true });
  if (!options.length) {
    selects.model.setPlaceholder(
      hasActiveProvider() ? '未识别到文生图模型' : '请先配置并启用 Provider',
    );
    if (!selects.model.getValue()) selects.model.setValue('', { silent: true });
  } else {
    selects.model.setPlaceholder('选择文生图模型');
    if (!selects.model.getValue()) {
      selects.model.setValue(options[0].value, { silent: true });
    }
  }
}

function renderModelsList() {
  const list = state.showAllModels
    ? state.models
    : state.models.filter((m) => m.isImageModel);
  const imageCount = state.models.filter((m) => m.isImageModel).length;
  els.modelsSummary.textContent = state.models.length
    ? `共 ${state.models.length} 个模型，文生图 ${imageCount} 个`
    : '尚未拉取';

  els.modelsList.innerHTML = '';
  if (!list.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="mid">暂无数据</span>';
    els.modelsList.appendChild(li);
    return;
  }

  for (const m of list) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="mid">${escapeHtml(m.id)}</span>
      <span class="badge ${m.isImageModel ? 'badge-image' : 'badge-other'}">
        ${m.isImageModel ? '文生图' : '其他'}
      </span>
    `;
    if (m.isImageModel) {
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => {
        ensureModelOption(m.id);
        showSettingsBanner('ok', `已选择模型：${m.id}`);
      });
    }
    els.modelsList.appendChild(li);
  }
}

async function fetchModels({ silent = false } = {}) {
  if (!hasActiveProvider()) {
    if (!silent) showSettingsBanner('error', '请先添加并启用一个 Provider');
    return;
  }
  if (!silent) {
    els.btnFetchModels.disabled = true;
    els.btnFetchModels.textContent = '拉取中…';
    showSettingsBanner('info', '正在请求上游 /v1/models …');
  }
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
    state.models = Array.isArray(data.data) ? data.data : [];
    renderModelSelect();
    renderModelsList();
    updateConnectionPill();
    if (!silent) {
      showSettingsBanner(
        'ok',
        `拉取成功：${data.rawCount ?? state.models.length} 个模型，文生图 ${data.imageModelCount ?? 0} 个`,
      );
    }
  } catch (err) {
    if (!silent) showSettingsBanner('error', `拉取失败：${err.message}`);
    else console.warn(err);
  } finally {
    if (!silent) {
      els.btnFetchModels.disabled = false;
      els.btnFetchModels.textContent = '用当前 Provider 拉取模型';
    }
  }
}

// ---------- Prompts ----------

async function loadPromptHistory() {
  try {
    const res = await fetch('/api/prompts');
    const data = await res.json();
    if (res.ok && Array.isArray(data.data)) {
      state.promptHistory = data.data;
    }
  } catch (err) {
    console.warn('load prompts failed', err);
  }
}

async function persistPromptHistory(list = state.promptHistory) {
  try {
    const res = await fetch('/api/prompts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: list }),
    });
    const data = await res.json();
    if (res.ok && Array.isArray(data.data)) state.promptHistory = data.data;
  } catch (err) {
    console.warn('persist prompts failed', err);
  }
}

function renderPromptHistory() {
  const items = state.promptHistory;
  els.promptHistoryList.innerHTML = '';
  els.promptCount.textContent = `${items.length} 条`;
  els.promptEmpty.classList.toggle('hidden', items.length > 0);

  for (const text of items) {
    const li = document.createElement('li');
    li.className = 'prompt-list__item';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'prompt-list__pick';
    btn.title = '点击查看完整内容';
    btn.innerHTML = `<span>${escapeHtml(truncate(text, 160))}</span>`;
    btn.addEventListener('click', () => openPromptDetail(text));
    li.appendChild(btn);
    els.promptHistoryList.appendChild(li);
  }
}

// ---------- Params / generate ----------

function captureParams() {
  return {
    mode: state.mode,
    prompt: els.prompt.value.trim(),
    model: selects.model.getValue(),
    size: selects.size.getValue(),
    n: Number(els.n.value) || 1,
    quality: selects.quality.getValue(),
    response_format: selects.responseFormat.getValue(),
    style: selects.style.getValue(),
    extraJson: els.extraJson.value.trim(),
  };
}

function applyParams(params, { scrollToForm = true } = {}) {
  if (!params || typeof params !== 'object') return;
  if (params.mode === 'edit' || params.mode === 'generate') {
    setMode(params.mode, { silent: true });
    renderEditAssets();
  }
  if (typeof params.prompt === 'string') els.prompt.value = params.prompt;
  if (params.model) ensureModelOption(params.model);
  if ('size' in params) selects.size.setValue(params.size ?? '', { silent: true });
  if ('n' in params) els.n.value = String(params.n ?? 1);
  if ('quality' in params) selects.quality.setValue(params.quality ?? '', { silent: true });
  if ('response_format' in params) {
    selects.responseFormat.setValue(params.response_format ?? '', { silent: true });
  }
  if ('style' in params) selects.style.setValue(params.style ?? '', { silent: true });
  if ('extraJson' in params) els.extraJson.value = params.extraJson || '';
  if (scrollToForm) els.prompt.scrollIntoView({ behavior: 'smooth', block: 'center' });
  showFormToast(
    params.mode === 'edit'
      ? '已回填编辑参数（参考图请重新添加）'
      : '已完整回填 Prompt / 模型 / 参数',
  );
}

function buildRequestBody() {
  const params = captureParams();
  const body = {
    prompt: params.prompt,
    model: params.model,
    n: params.n,
  };
  if (!body.prompt) throw new Error('请填写 prompt');
  if (!body.model) throw new Error('请选择模型（需先拉取文生图模型列表）');
  if (params.size) body.size = params.size;
  if (params.quality) body.quality = params.quality;
  if (params.response_format) body.response_format = params.response_format;
  if (params.style) body.style = params.style;
  if (params.extraJson) {
    let extra;
    try {
      extra = JSON.parse(params.extraJson);
    } catch {
      throw new Error('额外 JSON 不是合法 JSON');
    }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
      throw new Error('额外 JSON 需要是对象');
    }
    Object.assign(body, extra);
  }
  return { body, params };
}

let confirmResolver = null;

function closeConfirmModal() {
  els.confirmModal.classList.add('hidden');
  if (
    els.settingsModal.classList.contains('hidden') &&
    els.promptModal.classList.contains('hidden') &&
    els.promptDetailModal.classList.contains('hidden') &&
    els.lightbox.classList.contains('hidden')
  ) {
    document.body.classList.remove('modal-open');
  }
  if (confirmResolver) {
    const resolve = confirmResolver;
    confirmResolver = null;
    resolve(false);
  }
}

function openConfirmDialog({
  title = '确认操作',
  message = '确定继续？',
  confirmText = '确定',
} = {}) {
  return new Promise((resolve) => {
    // close any pending confirm without resolving true
    if (confirmResolver) {
      const prev = confirmResolver;
      confirmResolver = null;
      prev(false);
    }
    confirmResolver = resolve;
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.btnConfirmOk.textContent = confirmText;
    els.confirmModal.classList.remove('hidden');
    document.body.classList.add('modal-open');
    els.btnConfirmOk.focus();
  });
}

/** Convenience wrapper used by settings flow. */
function askConfirm({
  title = '确认操作',
  message = '确定继续？',
  confirmLabel = '确定',
  cancelLabel = '取消',
} = {}) {
  if (els.btnConfirmCancel) els.btnConfirmCancel.textContent = cancelLabel;
  return openConfirmDialog({ title, message, confirmText: confirmLabel });
}

async function removeGalleryItem(id) {
  const item = state.gallery.find((it) => it.id === id);
  if (!item) return;

  if (item.local?.id) {
    try {
      const res = await fetch(`/api/images/local/${encodeURIComponent(item.local.id)}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || `删除失败 (HTTP ${res.status})`);
      }
    } catch (err) {
      showFormError(err.message || '删除失败');
      return;
    }
  }

  state.gallery = state.gallery.filter((it) => it.id !== id);
  renderGallery();
  showFormToast('已删除该结果');
}

/** Delete every temp (unsaved) image server-side. Returns removed count. */
async function clearUnsavedImages() {
  let removed = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    const res = await fetch('/api/images?limit=200');
    const data = await res.json();
    if (!res.ok || !Array.isArray(data.data)) break;
    const temps = data.data.filter((r) => r.temp);
    if (!temps.length) break;
    for (const rec of temps) {
      const del = await fetch(`/api/images/local/${encodeURIComponent(rec.id)}`, {
        method: 'DELETE',
      });
      if (del.ok) removed += 1;
    }
  }
  return removed;
}

async function requestDeleteGalleryItem(id) {
  const item = state.gallery.find((it) => it.id === id);
  const ok = await openConfirmDialog({
    title: '确认删除',
    message: item?.local?.id
      ? '将同时删除本地文件，删除后不可恢复，确定继续？'
      : '删除后将从结果区移除，确定继续？',
    confirmText: '删除',
  });
  if (ok) await removeGalleryItem(id);
}

async function saveItemLocally(item) {
  if (item.local?.saved && item.local?.id) {
    showFormToast('已保存在本地');
    return;
  }

  // Temp-materialized file → just promote server-side, no re-upload.
  if (item.local?.id && item.local?.temp && !item.local?.missing) {
    const res = await fetch('/api/images/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ localId: item.local.id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || '保存失败');
    item.local = { ...item.local, ...data.local };
    renderGallery();
    showFormToast('已保存到本地目录');
    return;
  }

  const payload = {};
  if (item.originalSrc?.startsWith('data:') || item.kind === 'b64_json') {
    // prefer raw base64 if we kept it
    if (item.b64_json) payload.b64_json = item.b64_json;
    else if (item.originalSrc?.startsWith('data:')) payload.b64_json = item.originalSrc;
    else if (item.src?.startsWith('data:')) payload.b64_json = item.src;
  }
  if (!payload.b64_json) {
    // Prefer already-local files: nothing to re-download.
    if (item.local?.id && item.local?.saved && !item.local?.missing) {
      showFormToast('已保存在本地');
      return;
    }
    // Only absolute remote urls (if any were retained for server-side save).
    if (item.remoteUrl && /^https?:\/\//i.test(item.remoteUrl) && !isLocalApiSrc(item.remoteUrl)) {
      payload.url = item.remoteUrl;
    }
  }
  if (!payload.url && !payload.b64_json) {
    throw new Error('当前结果缺少可保存的原图数据（临时链接不会在浏览器侧保留）');
  }

  const res = await fetch('/api/images/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      meta: {
        model: item.model,
        prompt: item.prompt,
        size: item.size,
        params: item.params,
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || '保存失败');

  item.local = data.local;
  // Prefer local path for display/download afterwards
  if (data.local?.localUrl) {
    item.src = data.local.localUrl;
  }
  renderGallery();
  showFormToast('已保存到本地目录');
}

function renderGallery() {
  const items = state.gallery;
  els.gallery.querySelectorAll('.shot').forEach((n) => n.remove());

  if (!items.length) {
    els.emptyState.classList.remove('hidden');
    els.resultMeta.textContent = '等待生成';
    return;
  }

  els.emptyState.classList.add('hidden');
  const savedCount = items.filter((i) => i.local?.saved).length;
  els.resultMeta.textContent = `${items.length} 张 · 本地 ${savedCount}`;

  for (const item of items) {
    const shot = document.createElement('article');
    shot.className = 'shot';
    shot.tabIndex = 0;
    shot.title = item.src ? '点击预览' : '';
    if (item.src) shot.setAttribute('role', 'button');

    shot.appendChild(attachImageWithFallback(shot, item));

    const saved = Boolean(item.local?.saved && item.local?.id);
    const missing = Boolean(item.local?.missing);
    const itemMode = item.mode || item.params?.mode || 'generate';

    const badges = document.createElement('div');
    badges.className = 'shot__badges';

    const status = document.createElement('div');
    status.className = `shot__status ${saved ? 'is-saved' : 'is-unsaved'}${missing ? ' is-lost' : ''}`;
    status.textContent = formatLocalStatusText(item);
    badges.appendChild(status);

    if (itemMode === 'edit') {
      const modeBadge = document.createElement('div');
      modeBadge.className = 'shot__mode-badge';
      modeBadge.textContent = '编辑';
      badges.appendChild(modeBadge);
    }

    shot.appendChild(badges);

    const params = item.params || {
      prompt: item.prompt || '',
      model: item.model || '',
      size: item.size || '',
      mode: item.mode || 'generate',
    };
    if (!params.mode) params.mode = itemMode;

    // Always-visible kebab menu (mobile-friendly, no hover needed)
    const menu = document.createElement('div');
    menu.className = 'shot__menu';
    menu.innerHTML = `
      <button type="button" class="shot__menu-toggle" data-act="menu" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false">
        <span class="shot__menu-dots" aria-hidden="true">
          <i></i><i></i><i></i>
        </span>
      </button>
      <div class="shot__menu-panel" role="menu" hidden>
        ${
          saved
            ? `<a class="shot__menu-item" role="menuitem" data-act="download" href="${item.local.downloadUrl || `${item.local.localUrl}?download=1`}">下载</a>`
            : item.src
              ? `<button type="button" class="shot__menu-item" role="menuitem" data-act="save">保存到本地</button>`
              : ''
        }
        <button type="button" class="shot__menu-item" role="menuitem" data-act="add-edit">加入编辑</button>
        <button type="button" class="shot__menu-item" role="menuitem" data-act="reuse">回填全部</button>
        <button type="button" class="shot__menu-item shot__menu-item--danger" role="menuitem" data-act="delete">删除</button>
      </div>
    `;
    shot.appendChild(menu);

    const menuToggle = menu.querySelector('.shot__menu-toggle');
    const menuPanel = menu.querySelector('.shot__menu-panel');

    const closeMenu = () => {
      menu.classList.remove('is-open');
      menuPanel.hidden = true;
      menuToggle.setAttribute('aria-expanded', 'false');
    };
    const openMenu = () => {
      // close other open shot menus
      els.gallery.querySelectorAll('.shot__menu.is-open').forEach((m) => {
        if (m !== menu) {
          m.classList.remove('is-open');
          const p = m.querySelector('.shot__menu-panel');
          const t = m.querySelector('.shot__menu-toggle');
          if (p) p.hidden = true;
          if (t) t.setAttribute('aria-expanded', 'false');
        }
      });
      menu.classList.add('is-open');
      menuPanel.hidden = false;
      menuToggle.setAttribute('aria-expanded', 'true');
    };

    menuToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (menu.classList.contains('is-open')) closeMenu();
      else openMenu();
    });

    const veil = document.createElement('div');
    veil.className = 'shot__veil';
    veil.innerHTML = `
      <div class="shot__meta">
        <span class="shot__model">${escapeHtml(params.model || item.model || 'model')}</span>
        ${params.size || item.size ? `<span class="shot__size">${escapeHtml(params.size || item.size)}</span>` : ''}
        <span class="shot__size">${saved ? 'local' : 'remote'}</span>
      </div>
      <p class="shot__prompt">${escapeHtml(item.revisedPrompt || params.prompt || item.prompt || '')}</p>
      <div class="shot__actions">
        ${
          saved
            ? `<a class="${buttonClass('default')}" data-act="download" href="${item.local.downloadUrl || item.local.localUrl + '?download=1'}">下载</a>`
            : item.src
              ? `<button type="button" class="${buttonClass('default')}" data-act="save">保存到本地</button>`
              : ''
        }
        <button type="button" class="${buttonClass('default')}" data-act="add-edit">加入编辑</button>
        <button type="button" class="${buttonClass('confirm')}" data-act="reuse">回填全部</button>
        <button type="button" class="${buttonClass('danger')}" data-act="delete">删除</button>
      </div>
    `;

    // Default click = preview only (ignore menu / action controls)
    shot.addEventListener('click', (e) => {
      if (e.target.closest('[data-act], .shot__menu')) return;
      if (item.src) openLightbox(item.src);
    });
    shot.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && item.src) {
        if (e.target.closest('.shot__menu')) return;
        e.preventDefault();
        openLightbox(item.src);
      }
    });

    const bindDownload = (el) => {
      el?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
      });
    };
    const bindSave = (el) => {
      el?.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeMenu();
        try {
          await saveItemLocally(item);
        } catch (err) {
          showFormError(err.message || '保存失败');
        }
      });
    };
    const bindReuse = (el) => {
      el?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        applyParams(params);
      });
    };
    const bindAddEdit = (el) => {
      el?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        closeMenu();
        addGalleryItemToEdit(item);
      });
    };
    const bindDelete = (el) => {
      el?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        closeMenu();
        void requestDeleteGalleryItem(item.id);
      });
    };

    // Hover veil actions (desktop)
    bindDownload(veil.querySelector('[data-act="download"]'));
    bindSave(veil.querySelector('[data-act="save"]'));
    bindAddEdit(veil.querySelector('[data-act="add-edit"]'));
    bindReuse(veil.querySelector('[data-act="reuse"]'));
    bindDelete(veil.querySelector('[data-act="delete"]'));

    // Kebab menu actions (mobile + desktop)
    bindDownload(menu.querySelector('[data-act="download"]'));
    bindSave(menu.querySelector('[data-act="save"]'));
    bindAddEdit(menu.querySelector('[data-act="add-edit"]'));
    bindReuse(menu.querySelector('[data-act="reuse"]'));
    bindDelete(menu.querySelector('[data-act="delete"]'));

    shot.appendChild(veil);
    els.gallery.appendChild(shot);
  }
}

function closeAllShotMenus() {
  document.querySelectorAll('.shot__menu.is-open').forEach((m) => {
    m.classList.remove('is-open');
    const p = m.querySelector('.shot__menu-panel');
    const t = m.querySelector('.shot__menu-toggle');
    if (p) p.hidden = true;
    if (t) t.setAttribute('aria-expanded', 'false');
  });
}

function openLightbox(src) {
  if (!src || !isBrowserSafeImageSrc(src)) return;
  els.lightboxImg.referrerPolicy = 'no-referrer';
  els.lightboxImg.src = src;
  els.lightbox.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeLightbox() {
  els.lightbox.classList.add('hidden');
  els.lightboxImg.removeAttribute('src');
  if (
    els.settingsModal.classList.contains('hidden') &&
    els.promptModal.classList.contains('hidden') &&
    els.promptDetailModal.classList.contains('hidden') &&
    els.confirmModal.classList.contains('hidden')
  ) {
    document.body.classList.remove('modal-open');
  }
}

async function onGenerate(event) {
  event.preventDefault();
  showFormError('');
  hideFormToast();

  if (!hasActiveProvider()) {
    showFormError('请先在设置中配置并启用一个 Provider');
    openSettings();
    return;
  }

  let body;
  let params;
  try {
    ({ body, params } = buildRequestBody());
    if (state.mode === 'edit' && !state.editAssets.length) {
      throw new Error('编辑模式需要至少一张参考图');
    }
  } catch (err) {
    showFormError(err.message);
    return;
  }

  setGenerating(true);
  try {
    const data = await submitImageRequest({ body, params });

    const images = Array.isArray(data.images) ? data.images : [];
    if (!images.length) {
      throw new Error('上游返回成功，但未能解析出图片');
    }

    // refresh server prompt history
    await loadPromptHistory();

    const now = Date.now();
    const mode = state.mode;
    const newItems = images.map((img, index) => {
      // Server should already rewrite CDN → local/proxy. Still hard-filter here.
      const b64Src = img.b64_json ? toDataUrl(img.b64_json) : '';
      let displaySrc = imageSrcFromNormalized(img) || '';
      if (displaySrc && !isBrowserSafeImageSrc(displaySrc)) displaySrc = '';
      if (!displaySrc && b64Src) displaySrc = b64Src;
      if (!displaySrc && img.url && isBrowserSafeImageSrc(img.url)) displaySrc = img.url;

      const originalSrc = displaySrc || b64Src || '';
      const kind = img.local?.localUrl || (img.url && isLocalApiSrc(img.url))
        ? 'local'
        : img.b64_json
          ? 'b64_json'
          : displaySrc
            ? 'url'
            : 'raw';

      const item = {
        id: `${now}-${index}`,
        src: originalSrc,
        originalSrc,
        // Do not store third-party CDN on the client item for display.
        remoteUrl: '',
        b64_json: img.b64_json || '',
        kind,
        mode,
        model: params.model,
        size: params.size || '',
        prompt: params.prompt,
        revisedPrompt: img.revised_prompt || '',
        createdAt: now,
        params: { ...params, mode },
        local: img.local || { saved: false },
        sourceCount: data.sourceCount || (mode === 'edit' ? state.editAssets.length : 0),
        note: !originalSrc
          ? (img.local?.error ? `图片不可用: ${img.local.error}` : '图片不可用')
          : img.local?.error && !img.local?.saved
            ? `已走代理预览（落盘失败: ${img.local.error}）`
            : '',
      };
      return scrubGalleryItem(item);
    });

    // Materialized results live server-side; refresh from library. Items that
    // failed to materialize (b64/error only) are kept as session-transient.
    const transientItems = newItems.filter((i) => !i.local?.id);
    state.gallery = [...transientItems, ...state.gallery].slice(0, MAX_GALLERY);
    await loadGallery();
    renderGallery();
    const savedN = newItems.filter((i) => i.local?.saved).length;
    const verb = mode === 'edit' ? '编辑' : '生成';
    els.resultMeta.textContent = `本次${verb} ${newItems.length} · 本地保存 ${savedN}`;
    if (state.config.autoSaveImages && savedN) {
      showFormToast(`已自动保存 ${savedN} 张到本地`);
    } else {
      showFormToast(mode === 'edit' ? `编辑完成，${newItems.length} 张` : `生成完成，${newItems.length} 张`);
    }
  } catch (err) {
    showFormError(err.message || (state.mode === 'edit' ? '编辑失败' : '生成失败'));
  } finally {
    setGenerating(false);
  }
}

function initSelects() {
  selects.model = new FancySelect(els.modelMount, {
    placeholder: '请先配置并拉取模型',
    searchable: true,
    options: [],
  });
  selects.size = new FancySelect(els.sizeMount, {
    value: '1024x1024',
    options: [
      { value: '1024x1024', label: '1024 × 1024' },
      { value: '1792x1024', label: '1792 × 1024' },
      { value: '1024x1792', label: '1024 × 1792' },
      { value: '512x512', label: '512 × 512' },
      { value: '256x256', label: '256 × 256' },
      { value: '', label: '不传 size' },
    ],
  });
  selects.quality = new FancySelect(els.qualityMount, {
    value: '',
    options: [
      { value: '', label: '默认 / 不传' },
      { value: 'standard', label: 'standard' },
      { value: 'hd', label: 'hd' },
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
      { value: 'auto', label: 'auto' },
    ],
  });
  selects.responseFormat = new FancySelect(els.responseFormatMount, {
    value: 'b64_json',
    options: [
      { value: 'b64_json', label: 'b64_json', hint: '推荐 · 避免 CDN 403' },
      { value: '', label: '默认', hint: '由服务端决定' },
      { value: 'url', label: 'url', hint: '不推荐 · 临时链易 403' },
    ],
  });
  selects.style = new FancySelect(els.styleMount, {
    value: '',
    options: [
      { value: '', label: '默认 / 不传' },
      { value: 'vivid', label: 'vivid' },
      { value: 'natural', label: 'natural' },
    ],
  });
}

function bindEvents() {
  els.btnSettings.addEventListener('click', openSettings);
  els.btnEmptySettings?.addEventListener('click', openSettings);
  els.settingsModal.querySelectorAll('[data-close-modal]').forEach((el) => {
    el.addEventListener('click', closeSettings);
  });

  els.modeToggle?.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  els.btnEditUpload?.addEventListener('click', () => {
    els.editFileInput?.click();
  });
  els.editFileInput?.addEventListener('change', () => {
    addFilesToEdit(els.editFileInput.files, { source: 'upload' });
    els.editFileInput.value = '';
  });
  els.btnEditClear?.addEventListener('click', () => {
    if (!state.editAssets.length) return;
    clearEditAssets();
    showFormToast('已清空参考图');
  });

  // Empty tray click → file picker
  els.editAssetsList?.addEventListener('click', (e) => {
    if (e.target.closest('.edit-chip') || e.target.closest('.edit-chip__remove')) return;
    if (state.editAssets.length) return;
    els.editFileInput?.click();
  });

  // Drag & drop image files into the edit-assets panel
  const panel = els.editAssetsPanel;
  if (panel) {
    let dragDepth = 0;

    const hasImagePayload = (dt) => {
      if (!dt) return false;
      if (dt.types) {
        const types = Array.from(dt.types);
        if (types.includes('Files') || types.includes('application/x-moz-file')) return true;
        if (types.some((t) => String(t).startsWith('image/'))) return true;
      }
      return Boolean(dt.files && dt.files.length);
    };

    panel.addEventListener('dragenter', (e) => {
      if (!isEditAssetsHotzoneActive()) return;
      if (!hasImagePayload(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth += 1;
      panel.classList.add('is-dragover');
    });

    panel.addEventListener('dragover', (e) => {
      if (!isEditAssetsHotzoneActive()) return;
      if (!hasImagePayload(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      panel.classList.add('is-dragover');
    });

    panel.addEventListener('dragleave', (e) => {
      if (!panel.classList.contains('is-dragover')) return;
      e.preventDefault();
      e.stopPropagation();
      // relatedTarget can be null when leaving window
      if (e.relatedTarget && panel.contains(e.relatedTarget)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) panel.classList.remove('is-dragover');
    });

    panel.addEventListener('drop', (e) => {
      if (!isEditAssetsHotzoneActive()) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      panel.classList.remove('is-dragover');
      const files = extractImageFilesFromDataTransfer(e.dataTransfer);
      if (!files.length) {
        showFormError('请拖入图片文件');
        return;
      }
      addFilesToEdit(files, { source: 'drop' });
    });

    // Reset drag state if drag ends outside
    window.addEventListener('dragend', () => {
      dragDepth = 0;
      panel.classList.remove('is-dragover');
    });
  }

  // Paste images (Cmd/Ctrl+V) while in edit mode
  document.addEventListener('paste', (e) => {
    if (!isEditAssetsHotzoneActive()) return;
    // Don't steal paste inside modals / non-form dialogs
    if (document.body.classList.contains('modal-open')) return;

    const files = extractImageFilesFromDataTransfer(e.clipboardData);
    if (!files.length) return; // pure text paste → let textarea handle it

    e.preventDefault();
    addFilesToEdit(files, { source: 'paste' });
  });

  els.btnPromptHistory.addEventListener('click', openPromptModal);
  els.promptModal.querySelectorAll('[data-close-prompt-modal]').forEach((el) => {
    el.addEventListener('click', closePromptModal);
  });
  els.promptDetailModal.querySelectorAll('[data-close-prompt-detail]').forEach((el) => {
    el.addEventListener('click', closePromptDetail);
  });
  els.btnPromptDetailUse.addEventListener('click', useSelectedPrompt);
  els.btnPromptDetailDelete.addEventListener('click', () => {
    void deleteSelectedPrompt();
  });

  els.btnToggleKey.addEventListener('click', () => {
    const isHidden = els.apiKey.type === 'password';
    els.apiKey.type = isHidden ? 'text' : 'password';
    els.btnToggleKey.textContent = isHidden ? '隐藏' : '显示';
  });

  els.btnAddProvider.addEventListener('click', () => {
    startCreateProvider();
  });

  const onSaveProvider = async (ev) => {
    ev?.preventDefault?.();
    try {
      const result = await saveCurrentProvider({ activate: isCreatingProvider() });
      if (result.created && result.activated) {
        showSettingsBanner('ok', 'Provider 已保存，并设为生效');
        // first-time / create path: try model fetch quietly later
        void fetchModels({ silent: true });
      } else if (result.activated && !result.created) {
        showSettingsBanner('ok', 'Provider 已保存，并设为生效');
      } else {
        showSettingsBanner('ok', 'Provider 已保存');
      }
      updateConnectionPill();
    } catch (err) {
      showSettingsBanner('error', err.message);
    }
  };

  // submit button is type=submit; only listen on form to avoid double-save
  els.providerForm?.addEventListener('submit', onSaveProvider);

  els.btnActivateProvider.addEventListener('click', async () => {
    try {
      if (isCreatingProvider()) {
        showSettingsBanner('error', '请先保存这个 Provider');
        return;
      }
      if (state.editingProviderId === state.config.activeProviderId) {
        showSettingsBanner('info', '这已经是生效 Provider');
        updateProviderEditorChrome();
        return;
      }

      // Persist latest field values before switching active.
      if (isProviderFormDirty()) {
        await saveCurrentProvider({ activate: true });
        state.models = [];
        renderModelSelect();
        renderModelsList();
        showSettingsBanner('ok', '已保存并切换为生效 Provider');
      } else {
        await saveConfig({
          activeProviderId: state.editingProviderId,
          autoSaveImages: els.autoSaveImages.checked,
        });
        state.models = [];
        renderModelSelect();
        renderModelsList();
        showSettingsBanner('ok', '已切换生效 Provider');
      }
      updateConnectionPill();
      updateProviderEditorChrome();
      renderProviderList();
      void fetchModels({ silent: true });
    } catch (err) {
      showSettingsBanner('error', err.message);
    }
  });

  els.btnDeleteProvider.addEventListener('click', async () => {
    if (isCreatingProvider() || !state.editingProviderId) {
      showSettingsBanner('error', '没有可删除的 Provider');
      return;
    }

    const current = getEditingProvider();
    const ok = await askConfirm({
      title: '删除 Provider？',
      message: `确定删除「${current?.name || '未命名'}」吗？删除后不可恢复。`,
      confirmLabel: '删除',
      cancelLabel: '取消',
    });
    if (!ok) return;

    const id = state.editingProviderId;
    const wasActive = state.config.activeProviderId === id;
    const providers = state.config.providers.filter((p) => p.id !== id);
    let activeProviderId = state.config.activeProviderId;
    if (wasActive) activeProviderId = providers[0]?.id || null;

    try {
      await saveConfig({
        providers,
        activeProviderId,
        autoSaveImages: els.autoSaveImages.checked,
      });

      if (providers.length) {
        state.editingProviderId = activeProviderId || providers[0].id;
        const next = getEditingProvider();
        els.providerName.value = next?.name || '';
        els.baseUrl.value = next?.baseUrl || '';
        els.apiKey.value = next?.apiKey || '';
      } else {
        state.editingProviderId = null;
        els.providerName.value = '';
        els.baseUrl.value = '';
        els.apiKey.value = '';
      }

      if (wasActive) {
        state.models = [];
        renderModelSelect();
        renderModelsList();
      }

      showSettingsBanner('ok', 'Provider 已删除');
      updateConnectionPill();
      renderProviderList();
      updateProviderEditorChrome();
    } catch (err) {
      showSettingsBanner('error', err.message);
    }
  });

  els.autoSaveImages.addEventListener('change', async () => {
    try {
      await saveConfig({ autoSaveImages: els.autoSaveImages.checked });
      showSettingsBanner(
        'ok',
        els.autoSaveImages.checked ? '已开启自动保存图片' : '已关闭自动保存图片',
      );
    } catch (err) {
      showSettingsBanner('error', err.message);
    }
  });

  els.btnFetchModels.addEventListener('click', () => fetchModels({ silent: false }));
  els.btnRefreshModels.addEventListener('click', async () => {
    if (!hasActiveProvider()) {
      openSettings();
      showSettingsBanner('error', '请先配置并启用 Provider');
      return;
    }
    await fetchModels({ silent: false });
  });

  els.showAllModels.addEventListener('change', () => {
    state.showAllModels = els.showAllModels.checked;
    renderModelsList();
  });

  els.form.addEventListener('submit', onGenerate);

  els.btnClearGallery.addEventListener('click', async () => {
    const ok = await openConfirmDialog({
      title: '清理未保存图片？',
      message: '将删除所有「未保存」的临时图片文件；已保存的图片会保留在本地目录。',
      confirmText: '清理',
    });
    if (!ok) return;
    try {
      const removed = await clearUnsavedImages();
      state.gallery = state.gallery.filter((i) => i.local?.id && !i.local?.temp);
      await loadGallery();
      renderGallery();
      showFormError('');
      showFormToast(removed ? `已清理 ${removed} 张未保存图片` : '没有需要清理的图片');
    } catch (err) {
      showFormError(err.message || '清理失败');
    }
  });

  els.btnClearPrompts.addEventListener('click', async () => {
    state.promptHistory = [];
    await persistPromptHistory([]);
    renderPromptHistory();
  });

  els.lightbox.querySelectorAll('[data-close-lightbox]').forEach((el) => {
    el.addEventListener('click', closeLightbox);
  });

  els.confirmModal.querySelectorAll('[data-close-confirm]').forEach((el) => {
    el.addEventListener('click', () => closeConfirmModal());
  });
  els.btnConfirmOk.addEventListener('click', () => {
    const resolve = confirmResolver;
    confirmResolver = null;
    els.confirmModal.classList.add('hidden');
    if (
      els.settingsModal.classList.contains('hidden') &&
      els.promptModal.classList.contains('hidden') &&
      els.promptDetailModal.classList.contains('hidden') &&
      els.lightbox.classList.contains('hidden')
    ) {
      document.body.classList.remove('modal-open');
    }
    if (resolve) resolve(true);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.shot__menu')) closeAllShotMenus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.querySelector('.shot__menu.is-open')) {
        closeAllShotMenus();
        return;
      }
      if (!els.confirmModal.classList.contains('hidden')) closeConfirmModal();
      else if (!els.lightbox.classList.contains('hidden')) closeLightbox();
      else if (!els.promptDetailModal.classList.contains('hidden')) closePromptDetail();
      else if (!els.promptModal.classList.contains('hidden')) closePromptModal();
      else if (!els.settingsModal.classList.contains('hidden')) closeSettings();
    }
  });
}

async function init() {
  initSelects();
  bindEvents();
  setMode('generate', { silent: true });
  renderEditAssets();
  renderModelSelect();
  renderGallery();

  try {
    await loadConfig();
  } catch (err) {
    console.warn(err);
    showFormError(`加载配置失败：${err.message}`);
  }

  await loadPromptHistory();
  await loadGallery();
  renderGallery();
  updateConnectionPill();

  if (hasActiveProvider()) {
    fetchModels({ silent: true });
  }

  if (location.hash === '#settings') {
    openSettings();
  }
}

init();
