import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { timingSafeEqual } from 'crypto';
import multer from 'multer';
import {
  ensureDataDirs,
  readConfig,
  writeConfig,
  getActiveProvider,
  createProvider,
  readPrompts,
  writePrompts,
  pushPrompt,
  saveImageFromSource,
  downloadRemoteImage,
  getLocalImage,
  listLocalImages,
  deleteLocalImage,
  promoteLocalImage,
  cleanupTempImages,
  DATA_DIR,
} from './store.js';
import { getPublicDir, getAppHome, isPackaged } from './paths.js';

const app = express();
// PORT=0 → OS-assigned port (desktop shell mode); real port is printed on ready.
const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 3000;
// Loopback by default: this server holds API keys and must not face the LAN.
const HOST = process.env.HOST || '127.0.0.1';
const AUTH_TOKEN = process.env.ATELIER_TOKEN || '';
const TOKEN_COOKIE = 'atelier_token';
const PUBLIC_DIR = getPublicDir();

const UPSTREAM_TIMEOUT_MS = Number(process.env.ATELIER_UPSTREAM_TIMEOUT_MS) || 180_000;
const MODELS_TIMEOUT_MS = 30_000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 8 },
});

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/**
 * Token gate for the desktop shell. When ATELIER_TOKEN is set, every request
 * must carry the token via header, cookie, or one-time ?token= query (the
 * shell opens /?token=xxx; we convert it to a cookie so <img> and static
 * loads work without headers). Without ATELIER_TOKEN (plain web/dev mode)
 * this middleware is a no-op.
 */
app.use((req, res, next) => {
  if (!AUTH_TOKEN) return next();

  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  if (queryToken && safeEqual(queryToken, AUTH_TOKEN)) {
    res.cookie
      ? res.cookie(TOKEN_COOKIE, AUTH_TOKEN, { httpOnly: true, sameSite: 'strict' })
      : res.setHeader(
          'Set-Cookie',
          `${TOKEN_COOKIE}=${encodeURIComponent(AUTH_TOKEN)}; HttpOnly; SameSite=Strict; Path=/`,
        );
    return next();
  }

  const headerToken = String(req.headers['x-atelier-token'] || '');
  if (headerToken && safeEqual(headerToken, AUTH_TOKEN)) return next();

  const cookieToken = parseCookies(req.headers.cookie)[TOKEN_COOKIE] || '';
  if (cookieToken && safeEqual(cookieToken, AUTH_TOKEN)) return next();

  return res.status(401).json({ error: { message: 'Unauthorized: missing or invalid token' } });
});

app.use(express.json({ limit: '40mb' }));
app.use(express.static(PUBLIC_DIR));

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw Object.assign(new Error('BaseURL is required'), { status: 400 });
  }
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url;
}

function buildEndpoint(baseUrl, route) {
  const base = normalizeBaseUrl(baseUrl);
  if (/\/v1$/i.test(base)) {
    return `${base}${route.replace(/^\/v1/, '')}`;
  }
  return `${base}${route.startsWith('/') ? route : `/${route}`}`;
}

async function resolveUpstream(req) {
  // Prefer explicit headers for one-off overrides; otherwise use active provider.
  const headerBase = req.headers['x-base-url'];
  const headerKey =
    req.headers['x-api-key'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (headerBase && headerKey) {
    return {
      baseUrl: String(headerBase),
      apiKey: String(headerKey),
      authOrigin: originOf(headerBase),
      source: 'header',
    };
  }

  const provider = await getActiveProvider();
  if (!provider) {
    throw Object.assign(new Error('未配置生效的 Provider，请先在设置中添加并启用'), {
      status: 400,
    });
  }
  if (!provider.baseUrl || !provider.apiKey) {
    throw Object.assign(new Error(`Provider「${provider.name}」缺少 BaseURL 或 API Key`), {
      status: 400,
    });
  }
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    authOrigin: originOf(provider.baseUrl),
    source: 'active',
    provider,
  };
}

function originOf(baseUrl) {
  try {
    return new URL(normalizeBaseUrl(baseUrl)).origin;
  } catch {
    return '';
  }
}

/** Loopback / private / link-local hosts the image proxy must never touch. */
function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === 'metadata.google.internal') return true;
  // IPv6
  if (host.includes(':')) {
    const h = host.replace(/^\[|\]$/g, '');
    return (
      h === '::' ||
      h === '::1' ||
      h.startsWith('fe80:') ||
      h.startsWith('fc') ||
      h.startsWith('fd') ||
      h.startsWith('::ffff:')
    );
  }
  // IPv4 literals
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
  }
  return false;
}

async function readUpstreamBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function isImageGenerationModel(model) {
  const id = String(model?.id || model?.name || model || '').toLowerCase();
  if (!id) return false;

  const exclude = ['tts', 'whisper', 'embedding', 'moderation', 'text-embedding', 'audio'];
  if (exclude.some((k) => id.includes(k))) return false;

  const imageHints = [
    'dall-e',
    'dalle',
    'gpt-image',
    'image',
    'imagen',
    'flux',
    'stable-diffusion',
    'sdxl',
    'sd3',
    'midjourney',
    'grok-imagine',
    'gemini-.*image',
    'banana',
    'recraft',
    'ideogram',
    'kandinsky',
    'playground',
  ];

  return imageHints.some((hint) => {
    if (hint.includes('.*')) return new RegExp(hint).test(id);
    return id.includes(hint);
  });
}

function normalizeImageResponse(data) {
  const items = [];
  const candidates =
    data?.data ||
    data?.images ||
    data?.result?.data ||
    data?.result?.images ||
    (Array.isArray(data) ? data : null);

  if (Array.isArray(candidates)) {
    for (const item of candidates) {
      const one = normalizeOneImage(item);
      if (one) items.push(one);
    }
    return items;
  }

  if (data && typeof data === 'object') {
    const one = normalizeOneImage(data);
    if (one) return [one];
  }
  return [];
}

function normalizeOneImage(item) {
  if (!item) return null;
  if (typeof item === 'string') {
    if (item.startsWith('http') || item.startsWith('data:')) return { url: item };
    return { b64_json: item };
  }
  if (typeof item !== 'object') return null;

  // image_url may be a string or an object like { url: "..." }
  const imageUrlField =
    typeof item.image_url === 'object' && item.image_url
      ? item.image_url.url
      : item.image_url;
  const url = item.url || imageUrlField || item.imageUrl || item.image || item.src;

  const b64 =
    item.b64_json ||
    item.b64 ||
    item.base64 ||
    item.image_base64 ||
    item.imageBase64 ||
    item.image_data ||
    item.imageData ||
    (typeof item.data === 'string' ? item.data : undefined);

  let b64_json = typeof b64 === 'string' ? b64 : undefined;
  // Some gateways wrap base64 in { data: "...." } / arrays
  if (!b64_json && b64 && typeof b64 === 'object' && typeof b64.data === 'string') {
    b64_json = b64.data;
  }
  const finalUrl = typeof url === 'string' ? url : undefined;

  if (!finalUrl && !b64_json) {
    return { raw: item, revised_prompt: item.revised_prompt };
  }

  return {
    url: finalUrl,
    b64_json,
    revised_prompt: item.revised_prompt || item.revisedPrompt,
    raw: item,
  };
}

function publicConfig(cfg) {
  return {
    activeProviderId: cfg.activeProviderId,
    autoSaveImages: cfg.autoSaveImages,
    providers: (cfg.providers || []).map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      // return full key for local single-user tool editing; not multi-tenant
      apiKey: p.apiKey || '',
      hasKey: Boolean(p.apiKey),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
    dataDir: DATA_DIR,
  };
}

// ---------- Health / config ----------

app.get('/api/health', async (_req, res) => {
  const cfg = await readConfig();
  res.json({
    ok: true,
    dataDir: DATA_DIR,
    providerCount: cfg.providers.length,
    activeProviderId: cfg.activeProviderId,
    autoSaveImages: cfg.autoSaveImages,
  });
});

app.get('/api/config', async (_req, res) => {
  try {
    const cfg = await readConfig();
    res.json(publicConfig(cfg));
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * PUT /api/config
 * Body: { providers?, activeProviderId?, autoSaveImages? }
 */
app.put('/api/config', async (req, res) => {
  try {
    const current = await readConfig();
    const body = req.body || {};

    let providers = current.providers;
    if (Array.isArray(body.providers)) {
      providers = body.providers.map((p) => ({
        id: p.id || createProvider({}).id,
        name: String(p.name || '未命名').trim() || '未命名',
        baseUrl: String(p.baseUrl || '').trim(),
        apiKey: String(p.apiKey || '').trim(),
        createdAt: p.createdAt || Date.now(),
        updatedAt: Date.now(),
      }));
    }

    let activeProviderId =
      body.activeProviderId !== undefined ? body.activeProviderId : current.activeProviderId;

    if (activeProviderId && !providers.some((p) => p.id === activeProviderId)) {
      activeProviderId = providers[0]?.id || null;
    }
    if (!activeProviderId && providers.length) {
      activeProviderId = providers[0].id;
    }

    const autoSaveImages =
      body.autoSaveImages !== undefined
        ? Boolean(body.autoSaveImages)
        : current.autoSaveImages;

    const saved = await writeConfig({
      providers,
      activeProviderId,
      autoSaveImages,
    });
    res.json(publicConfig(saved));
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.post('/api/providers', async (req, res) => {
  try {
    const cfg = await readConfig();
    const provider = createProvider(req.body || {});
    const providers = [...cfg.providers, provider];
    const activeProviderId = cfg.activeProviderId || provider.id;
    const saved = await writeConfig({
      ...cfg,
      providers,
      activeProviderId,
    });
    res.status(201).json({ provider, config: publicConfig(saved) });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.put('/api/providers/:id', async (req, res) => {
  try {
    const cfg = await readConfig();
    const idx = cfg.providers.findIndex((p) => p.id === req.params.id);
    if (idx < 0) {
      return res.status(404).json({ error: { message: 'Provider not found' } });
    }
    const prev = cfg.providers[idx];
    const body = req.body || {};
    const next = {
      ...prev,
      name: body.name !== undefined ? String(body.name).trim() || '未命名' : prev.name,
      baseUrl: body.baseUrl !== undefined ? String(body.baseUrl).trim() : prev.baseUrl,
      apiKey: body.apiKey !== undefined ? String(body.apiKey).trim() : prev.apiKey,
      updatedAt: Date.now(),
    };
    const providers = [...cfg.providers];
    providers[idx] = next;
    const saved = await writeConfig({ ...cfg, providers });
    res.json({ provider: next, config: publicConfig(saved) });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.delete('/api/providers/:id', async (req, res) => {
  try {
    const cfg = await readConfig();
    const providers = cfg.providers.filter((p) => p.id !== req.params.id);
    let activeProviderId = cfg.activeProviderId;
    if (activeProviderId === req.params.id) {
      activeProviderId = providers[0]?.id || null;
    }
    const saved = await writeConfig({ ...cfg, providers, activeProviderId });
    res.json(publicConfig(saved));
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.post('/api/providers/:id/activate', async (req, res) => {
  try {
    const cfg = await readConfig();
    const exists = cfg.providers.some((p) => p.id === req.params.id);
    if (!exists) {
      return res.status(404).json({ error: { message: 'Provider not found' } });
    }
    const saved = await writeConfig({ ...cfg, activeProviderId: req.params.id });
    res.json(publicConfig(saved));
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ---------- Prompts ----------

app.get('/api/prompts', async (_req, res) => {
  try {
    res.json({ data: await readPrompts() });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.put('/api/prompts', async (req, res) => {
  try {
    const list = Array.isArray(req.body?.data) ? req.body.data : req.body;
    res.json({ data: await writePrompts(list) });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.post('/api/prompts', async (req, res) => {
  try {
    const text = req.body?.text ?? req.body?.prompt ?? '';
    res.json({ data: await pushPrompt(text) });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ---------- Models / generations ----------

app.get('/api/models', async (req, res) => {
  try {
    const upstream = await resolveUpstream(req);
    const endpoint = buildEndpoint(upstream.baseUrl, '/v1/models');

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${upstream.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });

    const data = await readUpstreamBody(response);
    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error || data || { message: 'Upstream models request failed' },
      });
    }

    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    const enriched = list.map((m) => {
      const id = m.id || m.name || String(m);
      return { ...m, id, isImageModel: isImageGenerationModel(m) };
    });

    const imageOnly = String(req.query.imageOnly || '').toLowerCase() === 'true';
    const models = imageOnly ? enriched.filter((m) => m.isImageModel) : enriched;

    res.json({
      object: 'list',
      data: models,
      total: models.length,
      imageModelCount: enriched.filter((m) => m.isImageModel).length,
      rawCount: list.length,
      provider: upstream.provider
        ? { id: upstream.provider.id, name: upstream.provider.name }
        : null,
    });
  } catch (err) {
    res.status(err.status || 500).json({
      error: { message: err.message || 'Failed to fetch models' },
    });
  }
});

app.post('/api/images/generations', async (req, res) => {
  try {
    const upstream = await resolveUpstream(req);
    const endpoint = buildEndpoint(upstream.baseUrl, '/v1/images/generations');
    const cfg = await readConfig();

    const { baseUrl: _b, apiKey: _k, save: saveFlag, ...payload } = req.body || {};

    if (!payload.prompt || !String(payload.prompt).trim()) {
      return res.status(400).json({ error: { message: 'prompt is required' } });
    }

    const body = {
      ...payload,
      model: payload.model || 'dall-e-3',
      prompt: String(payload.prompt).trim(),
      n: payload.n ?? 1,
    };
    Object.keys(body).forEach((key) => {
      if (body[key] === undefined || body[key] === '') delete body[key];
    });

    // imgen.x.ai (and similar) temp CDN urls 403 both browser and server download.
    // Prefer base64 payload so bytes arrive inside the API response.
    const forcedB64 = !body.response_format;
    if (forcedB64) {
      body.response_format = 'b64_json';
    }

    let response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${upstream.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    // Some gateways reject b64_json — fall back once without it / with url.
    if (!response.ok && forcedB64) {
      const errBody = await readUpstreamBody(response);
      const msg = JSON.stringify(errBody?.error || errBody || '').toLowerCase();
      if (
        response.status === 400 ||
        msg.includes('response_format') ||
        msg.includes('b64') ||
        msg.includes('base64')
      ) {
        const retryBody = { ...body };
        delete retryBody.response_format;
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${upstream.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(retryBody),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        // keep body.response_format for echo as what we actually use
        if (response.ok) delete body.response_format;
        else {
          // return original b64 error if retry also fails — handled below
        }
      } else {
        // re-wrap non-format errors by synthesizing a fake failed response path
        return res.status(response.status).json({
          error: errBody?.error || errBody || { message: 'Image generation failed' },
          status: response.status,
        });
      }
    }

    const data = await readUpstreamBody(response);
    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error || data || { message: 'Image generation failed' },
        status: response.status,
      });
    }

    let images = normalizeImageResponse(data);
    const shouldSave = saveFlag === true || (saveFlag !== false && cfg.autoSaveImages);

    images = await materializeImages(images, {
      shouldSave,
      apiKey: upstream.apiKey,
      authOrigin: upstream.authOrigin,
      meta: {
        mode: 'generate',
        model: body.model,
        prompt: body.prompt,
        size: body.size,
        providerId: upstream.provider?.id,
        providerName: upstream.provider?.name,
      },
    });

    // Persist prompt history server-side
    try {
      await pushPrompt(body.prompt);
    } catch {
      /* ignore */
    }

    res.json({
      created: data?.created || Math.floor(Date.now() / 1000),
      images,
      autoSaveImages: cfg.autoSaveImages,
      saved: shouldSave,
      upstream: data,
      requestEcho: {
        model: body.model,
        n: body.n,
        size: body.size,
        quality: body.quality,
        response_format: body.response_format,
      },
      provider: upstream.provider
        ? { id: upstream.provider.id, name: upstream.provider.name }
        : null,
    });
  } catch (err) {
    res.status(err.status || 500).json({
      error: { message: err.message || 'Image generation request failed' },
    });
  }
});


async function bufferFromDataUrlOrB64(b64) {
  let mime = 'image/png';
  let raw = String(b64 || '');
  if (raw.startsWith('data:')) {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(raw);
    if (m) {
      mime = m[1] || mime;
      raw = m[2];
    } else {
      raw = raw.replace(/^data:[^,]*,/, '');
    }
  }
  return { buffer: Buffer.from(raw, 'base64'), mime };
}

function isRemoteHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function proxyUrlForRemote(remoteUrl) {
  return `/api/images/proxy?url=${encodeURIComponent(remoteUrl)}`;
}

/**
 * Always materialize returned image bytes onto local disk so the browser never
 * depends on short-lived / hotlink-protected CDNs (e.g. imgen.x.ai → 403).
 * When shouldSave is false the file is written with temp=true — still
 * displayable via /api/images/local/:id, but promotable/sweepable later —
 * which is how autoSaveImages=false is honored without losing the bytes.
 *
 * Client-facing `url` is NEVER a third-party CDN link:
 *   local file → /api/images/local/:id
 *   fallback   → /api/images/proxy?url=...
 */
async function materializeImages(images, { shouldSave = false, meta = {}, apiKey, authOrigin } = {}) {
  if (!Array.isArray(images) || !images.length) return [];

  return Promise.all(
    images.map(async (img) => {
      const remoteUrl = isRemoteHttpUrl(img.url)
        ? img.url
        : isRemoteHttpUrl(img.remoteUrl)
          ? img.remoteUrl
          : undefined;
      const hasB64 = Boolean(img.b64_json);
      // Always persist returned image bytes when possible:
      // - b64 is reliable
      // - remote CDN (imgen.x.ai) often cannot be re-fetched (403) → prefer upstream b64_json
      const needsMaterialize = hasB64 || Boolean(remoteUrl) || (shouldSave && img.url);

      if (!needsMaterialize) {
        const safeUrl =
          (typeof img.url === 'string' && img.url.startsWith('/api/')) ? img.url : undefined;
        return {
          ...img,
          url: safeUrl,
          remoteUrl: undefined,
          local: img.local || { saved: false },
        };
      }

      try {
        const local = await saveImageFromSource({
          // Prefer base64 when present — avoids a second CDN hop that often 403s.
          url: hasB64 ? undefined : img.url || remoteUrl,
          b64_json: img.b64_json,
          meta: {
            ...meta,
            ...(remoteUrl ? { remoteUrl } : {}),
          },
          apiKey,
          authOrigin,
          temp: !shouldSave,
        });

        return {
          ...img,
          remoteUrl: undefined,
          url: local.localUrl,
          // Drop huge b64 from client payload after local save (src uses localUrl).
          b64_json: undefined,
          local: {
            id: local.id,
            filename: local.filename,
            localUrl: local.localUrl,
            downloadUrl: local.downloadUrl,
            saved: shouldSave,
            temp: !shouldSave,
            materialized: true,
          },
        };
      } catch (err) {
        const message = err.message || '物化图片失败';
        // Do NOT fall back to /api/images/proxy for hosts that already 403 server-side
        // (e.g. imgen.x.ai) — that only produces another 502 and UI flicker.
        const canProxy =
          remoteUrl &&
          !/imgen\.x\.ai|xai-tmp|xai-imgen/i.test(remoteUrl) &&
          !/Failed to download image: HTTP 403/i.test(message);

        if (canProxy) {
          return {
            ...img,
            remoteUrl: undefined,
            url: proxyUrlForRemote(remoteUrl),
            b64_json: hasB64 ? img.b64_json : undefined,
            local: {
              saved: false,
              error: message,
              proxy: true,
            },
          };
        }

        return {
          ...img,
          remoteUrl: undefined,
          url: undefined,
          b64_json: hasB64 ? img.b64_json : undefined,
          local: {
            saved: false,
            error: hasB64
              ? message
              : `${message}。上游返回了临时 CDN 链接且无法下载；请将 response_format 设为 b64_json 后重试`,
          },
        };
      }
    }),
  );
}

async function resolveEditImageSources({ files = [], refs = [], apiKey, authOrigin } = {}) {
  const out = [];

  for (const f of files) {
    if (!f?.buffer?.length) continue;
    out.push({
      buffer: f.buffer,
      mime: f.mimetype || 'image/png',
      filename: f.originalname || `image-${out.length + 1}.png`,
    });
  }

  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') continue;
    if (ref.localId) {
      const local = await getLocalImage(String(ref.localId));
      if (!local) {
        throw Object.assign(new Error(`本地图片不存在: ${ref.localId}`), { status: 400 });
      }
      const buffer = await fs.readFile(local.absPath);
      out.push({
        buffer,
        mime: local.mime || 'image/png',
        filename: local.filename || `${local.id}.png`,
      });
      continue;
    }
    if (ref.b64_json || ref.b64) {
      const { buffer, mime } = await bufferFromDataUrlOrB64(ref.b64_json || ref.b64);
      out.push({ buffer, mime, filename: `image-${out.length + 1}.png` });
      continue;
    }
    if (ref.url) {
      const url = String(ref.url);
      if (url.startsWith('data:')) {
        const { buffer, mime } = await bufferFromDataUrlOrB64(url);
        out.push({ buffer, mime, filename: `image-${out.length + 1}.png` });
        continue;
      }
      // local relative API path
      const localMatch = url.match(/\/api\/images\/local\/([^/?#]+)/);
      if (localMatch) {
        const local = await getLocalImage(localMatch[1]);
        if (!local) {
          throw Object.assign(new Error(`本地图片不存在: ${localMatch[1]}`), { status: 400 });
        }
        const buffer = await fs.readFile(local.absPath);
        out.push({
          buffer,
          mime: local.mime || 'image/png',
          filename: local.filename || `${local.id}.png`,
        });
        continue;
      }
      try {
        const { buffer, mime } = await downloadRemoteImage(url, { apiKey, authOrigin });
        out.push({
          buffer,
          mime: mime || 'image/png',
          filename: `image-${out.length + 1}.png`,
        });
      } catch (err) {
        throw Object.assign(
          new Error(`下载参考图失败: ${err.message || err}`),
          { status: 400 },
        );
      }
    }
  }

  return out;
}

/**
 * POST /api/images/edits
 * Accepts:
 *  - multipart/form-data: prompt, model, n, size, quality, response_format, image files, optional mask
 *  - application/json: { prompt, model, ..., images: [{localId|url|b64_json}], mask?: {..} }
 */
async function handleImageEdits(req, res) {
  try {
    const upstream = await resolveUpstream(req);
    const endpoint = buildEndpoint(upstream.baseUrl, '/v1/images/edits');
    const cfg = await readConfig();

    const isMultipart = Boolean(req.is('multipart/form-data'));
    const body = isMultipart ? req.body || {} : req.body || {};

    const prompt = String(body.prompt || '').trim();
    if (!prompt) {
      return res.status(400).json({ error: { message: 'prompt is required' } });
    }

    let refs = [];
    if (!isMultipart) {
      if (Array.isArray(body.images)) refs = body.images;
      else if (body.image && typeof body.image === 'object') refs = [body.image];
    } else if (body.images) {
      // JSON string field in multipart
      try {
        const parsed = typeof body.images === 'string' ? JSON.parse(body.images) : body.images;
        if (Array.isArray(parsed)) refs = parsed;
      } catch {
        /* ignore */
      }
    }

    const files = [];
    if (req.files) {
      if (Array.isArray(req.files)) files.push(...req.files);
      else {
        if (Array.isArray(req.files.image)) files.push(...req.files.image);
        else if (req.files.image) files.push(req.files.image);
        if (Array.isArray(req.files.images)) files.push(...req.files.images);
      }
    }

    const sources = await resolveEditImageSources({
      files,
      refs,
      apiKey: upstream.apiKey,
      authOrigin: upstream.authOrigin,
    });
    if (!sources.length) {
      return res.status(400).json({
        error: { message: '至少需要一张编辑参考图（上传或 images[]）' },
      });
    }

    // Optional mask
    let maskSource = null;
    const maskFile = req.files?.mask
      ? Array.isArray(req.files.mask)
        ? req.files.mask[0]
        : req.files.mask
      : null;
    if (maskFile?.buffer) {
      maskSource = {
        buffer: maskFile.buffer,
        mime: maskFile.mimetype || 'image/png',
        filename: maskFile.originalname || 'mask.png',
      };
    } else if (body.mask && typeof body.mask === 'object') {
      const maskList = await resolveEditImageSources({
        files: [],
        refs: [body.mask],
        apiKey: upstream.apiKey,
        authOrigin: upstream.authOrigin,
      });
      maskSource = maskList[0] || null;
    }

    const model = String(body.model || '').trim();
    // Prefer b64 — CDN urls from x.ai cannot be re-downloaded (403).
    const forcedB64 = !body.response_format;
    let editResponseFormat = body.response_format ? String(body.response_format) : 'b64_json';

    const buildForm = (responseFormat) => {
      const form = new FormData();
      form.append('prompt', prompt);
      if (model) form.append('model', model);
      if (body.n != null && body.n !== '') form.append('n', String(body.n));
      if (body.size) form.append('size', String(body.size));
      if (body.quality) form.append('quality', String(body.quality));
      if (responseFormat) form.append('response_format', responseFormat);
      if (body.user) form.append('user', String(body.user));

      // Extra scalar fields (ignore known complex keys)
      const reserved = new Set([
        'prompt',
        'model',
        'n',
        'size',
        'quality',
        'response_format',
        'user',
        'images',
        'image',
        'mask',
        'baseUrl',
        'apiKey',
        'save',
      ]);
      for (const [k, v] of Object.entries(body)) {
        if (reserved.has(k)) continue;
        if (v == null || v === '') continue;
        if (typeof v === 'object') continue;
        form.append(k, String(v));
      }

      for (const src of sources) {
        const blob = new Blob([src.buffer], { type: src.mime });
        form.append('image', blob, src.filename);
      }
      if (maskSource) {
        const blob = new Blob([maskSource.buffer], { type: maskSource.mime });
        form.append('mask', blob, maskSource.filename);
      }
      return form;
    };

    const postEdit = (responseFormat) =>
      fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${upstream.apiKey}`,
        },
        body: buildForm(responseFormat),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

    let response = await postEdit(editResponseFormat);

    // Mirror generations: some models (e.g. gpt-image-1) reject response_format.
    if (!response.ok && forcedB64) {
      const errBody = await readUpstreamBody(response);
      const msg = JSON.stringify(errBody?.error || errBody || '').toLowerCase();
      if (
        response.status === 400 ||
        msg.includes('response_format') ||
        msg.includes('b64') ||
        msg.includes('base64')
      ) {
        response = await postEdit('');
        if (response.ok) editResponseFormat = '';
      } else {
        return res.status(response.status).json({
          error: errBody?.error || errBody || { message: 'Image edit failed' },
          status: response.status,
        });
      }
    }

    const data = await readUpstreamBody(response);
    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error || data || { message: 'Image edit failed' },
        status: response.status,
      });
    }

    let images = normalizeImageResponse(data);
    const saveFlag = body.save;
    const shouldSave =
      saveFlag === true ||
      saveFlag === 'true' ||
      (saveFlag !== false && saveFlag !== 'false' && cfg.autoSaveImages);

    images = await materializeImages(images, {
      shouldSave,
      apiKey: upstream.apiKey,
      authOrigin: upstream.authOrigin,
      meta: {
        mode: 'edit',
        model,
        prompt,
        size: body.size,
        providerId: upstream.provider?.id,
        providerName: upstream.provider?.name,
        sourceCount: sources.length,
      },
    });

    try {
      await pushPrompt(prompt);
    } catch {
      /* ignore */
    }

    res.json({
      created: data?.created || Math.floor(Date.now() / 1000),
      images,
      autoSaveImages: cfg.autoSaveImages,
      saved: shouldSave,
      mode: 'edit',
      sourceCount: sources.length,
      upstream: data,
      requestEcho: {
        model,
        n: body.n,
        size: body.size,
        quality: body.quality,
        response_format: editResponseFormat,
      },
      provider: upstream.provider
        ? { id: upstream.provider.id, name: upstream.provider.name }
        : null,
    });
  } catch (err) {
    res.status(err.status || 500).json({
      error: { message: err.message || 'Image edit request failed' },
    });
  }
}

app.post(
  '/api/images/edits',
  (req, res, next) => {
    // Only run multer for multipart
    const ct = req.headers['content-type'] || '';
    if (ct.includes('multipart/form-data')) {
      return upload.fields([
        { name: 'image', maxCount: 8 },
        { name: 'images', maxCount: 8 },
        { name: 'mask', maxCount: 1 },
      ])(req, res, next);
    }
    return next();
  },
  handleImageEdits,
);

/**
 * Manual save of an image to local data/images.
 * Body: { localId? } to promote a temp materialized image, or { url?, b64_json?, meta? }.
 */
app.post('/api/images/save', async (req, res) => {
  try {
    const { localId, url, b64_json, meta } = req.body || {};

    if (localId) {
      const local = await promoteLocalImage(String(localId));
      if (!local) {
        return res.status(404).json({ error: { message: 'Local image not found' } });
      }
      return res.json({
        local: {
          id: local.id,
          filename: local.filename,
          localUrl: local.localUrl,
          downloadUrl: local.downloadUrl,
          saved: true,
          temp: false,
          size: local.size,
          mime: local.mime,
        },
      });
    }

    if (!url && !b64_json) {
      return res.status(400).json({ error: { message: 'localId, url or b64_json required' } });
    }
    const active = await getActiveProvider();
    const local = await saveImageFromSource({
      url,
      b64_json,
      meta: meta || {},
      apiKey: active?.apiKey,
      authOrigin: originOf(active?.baseUrl || ''),
    });
    res.status(201).json({
      local: {
        id: local.id,
        filename: local.filename,
        localUrl: local.localUrl,
        downloadUrl: local.downloadUrl,
        saved: true,
        temp: false,
        size: local.size,
        mime: local.mime,
      },
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message || 'Save failed' } });
  }
});

/**
 * Library: list materialized images (newest first).
 * Query: offset, limit, includeTemp (default true), tempOnly
 */
app.get('/api/images', async (req, res) => {
  try {
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const includeTemp = String(req.query.includeTemp || 'true').toLowerCase() !== 'false';
    const { items, total } = await listLocalImages({ offset, limit, includeTemp });
    res.json({ data: items, total, offset, limit });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.delete('/api/images/local/:id', async (req, res) => {
  try {
    const removed = await deleteLocalImage(String(req.params.id));
    if (!removed) {
      return res.status(404).json({ error: { message: 'Local image not found' } });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.get('/api/images/local/:id', async (req, res) => {
  try {
    const file = await getLocalImage(req.params.id);
    if (!file) {
      return res.status(404).json({ error: { message: 'Local image not found' } });
    }
    const download = String(req.query.download || '') === '1';
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    if (download) {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${file.filename || `${file.id}.png`}"`,
      );
    } else {
      res.setHeader('Content-Disposition', `inline; filename="${file.filename || `${file.id}.png`}"`);
    }
    res.sendFile(file.absPath);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.get('/api/images/local/:id/meta', async (req, res) => {
  try {
    const file = await getLocalImage(req.params.id);
    if (!file) {
      return res.status(404).json({ error: { message: 'Local image not found' } });
    }
    const { absPath, ...meta } = file;
    res.json(meta);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

/**
 * Same-origin proxy for upstream temp CDNs (imgen.x.ai etc.).
 * Browser must never request those hosts directly — they 403 hotlinks.
 */
app.get('/api/images/proxy', async (req, res) => {
  try {
    const raw = String(req.query.url || '').trim();
    if (!raw || !/^https?:\/\//i.test(raw)) {
      return res.status(400).json({ error: { message: 'valid url query required' } });
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return res.status(400).json({ error: { message: 'invalid url' } });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: { message: 'only http(s) allowed' } });
    }
    if (isPrivateHost(parsed.hostname)) {
      return res.status(400).json({ error: { message: 'private/internal hosts are not allowed' } });
    }

    const active = await getActiveProvider();
    const { buffer, mime } = await downloadRemoteImage(raw, {
      apiKey: active?.apiKey,
      authOrigin: originOf(active?.baseUrl || ''),
    });
    res.setHeader('Content-Type', mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Image-Proxy', '1');
    res.send(buffer);
  } catch (err) {
    res.status(502).json({
      error: { message: err.message || 'Proxy download failed' },
    });
  }
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

async function main() {
  await ensureDataDirs();
  cleanupTempImages().then(
    (n) => n && console.log(`Cleaned ${n} expired temp image(s)`),
    () => {},
  );
  const server = app.listen(PORT, HOST, () => {
    const actualPort = server.address().port;
    console.log(`Image Generations server running at http://${HOST}:${actualPort}`);
    console.log(`App home: ${getAppHome()}`);
    console.log(`Data directory: ${DATA_DIR}`);
    console.log(`Public directory: ${PUBLIC_DIR}`);
    console.log(`Packaged: ${isPackaged()}`);
    console.log(`Auth: ${AUTH_TOKEN ? 'token required' : 'open (local dev)'}`);
    console.log(`ATELIER_READY port=${actualPort}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
