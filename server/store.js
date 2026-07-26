import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { getDataDir } from './paths.js';

export const DATA_DIR = getDataDir();
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const PROMPTS_PATH = path.join(DATA_DIR, 'prompts.json');

const DEFAULT_CONFIG = {
  activeProviderId: null,
  providers: [],
  autoSaveImages: false,
};

export async function ensureDataDirs() {
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  try {
    await fs.access(CONFIG_PATH);
  } catch {
    await writeConfig(DEFAULT_CONFIG);
  }
  try {
    await fs.access(PROMPTS_PATH);
  } catch {
    await writePrompts([]);
  }
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

export async function readConfig() {
  const cfg = await readJson(CONFIG_PATH, DEFAULT_CONFIG);
  return {
    activeProviderId: cfg.activeProviderId ?? null,
    providers: Array.isArray(cfg.providers) ? cfg.providers : [],
    autoSaveImages: Boolean(cfg.autoSaveImages),
  };
}

export async function writeConfig(config) {
  const next = {
    activeProviderId: config.activeProviderId ?? null,
    providers: Array.isArray(config.providers) ? config.providers : [],
    autoSaveImages: Boolean(config.autoSaveImages),
  };
  await writeJson(CONFIG_PATH, next);
  return next;
}

export async function getActiveProvider() {
  const cfg = await readConfig();
  if (!cfg.activeProviderId) return null;
  return cfg.providers.find((p) => p.id === cfg.activeProviderId) || null;
}

export function createProvider({ name, baseUrl, apiKey }) {
  return {
    id: randomUUID(),
    name: String(name || '未命名').trim() || '未命名',
    baseUrl: String(baseUrl || '').trim(),
    apiKey: String(apiKey || '').trim(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export async function readPrompts() {
  const list = await readJson(PROMPTS_PATH, []);
  return Array.isArray(list) ? list : [];
}

export async function writePrompts(list) {
  const next = (Array.isArray(list) ? list : [])
    .map((p) => (typeof p === 'string' ? p : p?.text))
    .filter((t) => typeof t === 'string' && t.trim())
    .map((t) => t.trim())
    .slice(0, 50);
  await writeJson(PROMPTS_PATH, next);
  return next;
}

export async function pushPrompt(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return readPrompts();
  const list = await readPrompts();
  const next = [trimmed, ...list.filter((p) => p !== trimmed)].slice(0, 50);
  return writePrompts(next);
}

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('bmp')) return 'bmp';
  return 'png';
}

/**
 * Save an image from url or base64 into data/images.
 * Returns local file metadata.
 */
export async function saveImageBuffer({ buffer, mime, meta = {} }) {
  await ensureDataDirs();
  const id = randomUUID();
  const ext = extFromMime(mime);
  const filename = `${id}.${ext}`;
  const absPath = path.join(IMAGES_DIR, filename);
  await fs.writeFile(absPath, buffer);

  const record = {
    id,
    filename,
    mime: mime || `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    size: buffer.length,
    createdAt: Date.now(),
    meta,
  };
  await writeJson(path.join(IMAGES_DIR, `${id}.json`), record);
  return {
    ...record,
    localUrl: `/api/images/local/${id}`,
    downloadUrl: `/api/images/local/${id}?download=1`,
  };
}

/**
 * Download a remote image. Many CDNs (e.g. imgen.x.ai) block bare/browserless
 * fetches or browser hotlinks — use browser-like headers and optional API key.
 */
export async function downloadRemoteImage(url, { apiKey } = {}) {
  if (!url || typeof url !== 'string') {
    throw new Error('url is required');
  }
  if (url.startsWith('data:')) {
    let mime = 'image/png';
    let raw = url;
    const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
    if (match) {
      mime = match[1] || mime;
      raw = match[2];
    } else {
      raw = url.replace(/^data:[^,]*,/, '');
    }
    return { buffer: Buffer.from(raw, 'base64'), mime, finalUrl: url };
  }

  let origin = '';
  let host = '';
  try {
    const u = new URL(url);
    origin = u.origin;
    host = u.hostname.toLowerCase();
  } catch {
    /* ignore */
  }

  const ua =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  const accept = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';

  const refererCandidates = [];
  if (origin) refererCandidates.push(`${origin}/`);
  // x.ai temp CDN often expects product-site referrers, not bare bots.
  if (host.endsWith('x.ai') || host.includes('xai')) {
    refererCandidates.push('https://x.ai/', 'https://console.x.ai/', 'https://grok.x.ai/');
  }
  refererCandidates.push(''); // no referer

  const attempts = [];
  for (const referer of refererCandidates) {
    const base = {
      Accept: accept,
      'User-Agent': ua,
    };
    if (referer) {
      base.Referer = referer;
      try {
        base.Origin = new URL(referer).origin;
      } catch {
        /* ignore */
      }
    }
    if (apiKey) {
      attempts.push({ ...base, Authorization: `Bearer ${apiKey}` });
    }
    attempts.push({ ...base });
  }
  // last resort: minimal headers
  attempts.push({ Accept: '*/*', 'User-Agent': ua });
  if (apiKey) {
    attempts.push({ Accept: '*/*', 'User-Agent': ua, Authorization: `Bearer ${apiKey}` });
  }

  let lastErr = null;
  for (const headers of attempts) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
      });
      if (!res.ok) {
        lastErr = new Error(`Failed to download image: HTTP ${res.status}`);
        // try next header strategy on auth/forbidden
        if (res.status === 401 || res.status === 403 || res.status === 429) continue;
        throw lastErr;
      }
      const mime = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (!buffer.length) {
        lastErr = new Error('Downloaded image is empty');
        continue;
      }
      return {
        buffer,
        mime: mime.startsWith('image/') || mime.includes('octet-stream') ? (mime.startsWith('image/') ? mime : 'image/png') : 'image/png',
        finalUrl: url,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Failed to download image');
}

export async function saveImageFromSource({ url, b64_json, meta = {}, apiKey } = {}) {
  if (b64_json) {
    let mime = 'image/png';
    let b64 = b64_json;
    if (b64.startsWith('data:')) {
      const match = /^data:([^;]+);base64,(.+)$/s.exec(b64);
      if (match) {
        mime = match[1] || mime;
        b64 = match[2];
      } else {
        b64 = b64.replace(/^data:[^,]*,/, '');
      }
    }
    const buffer = Buffer.from(b64, 'base64');
    return saveImageBuffer({ buffer, mime, meta });
  }

  if (url) {
    if (url.startsWith('data:')) {
      return saveImageFromSource({ b64_json: url, meta });
    }
    const { buffer, mime } = await downloadRemoteImage(url, { apiKey });
    return saveImageBuffer({ buffer, mime, meta: { ...meta, remoteUrl: url } });
  }

  throw new Error('url or b64_json is required to save image');
}

export async function getLocalImage(id) {
  const metaPath = path.join(IMAGES_DIR, `${id}.json`);
  const meta = await readJson(metaPath, null);
  if (!meta?.filename) return null;
  const absPath = path.join(IMAGES_DIR, meta.filename);
  try {
    await fs.access(absPath);
  } catch {
    return null;
  }
  return { ...meta, absPath, localUrl: `/api/images/local/${id}` };
}
