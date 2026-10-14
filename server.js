#!/usr/bin/env node
/**
 * HF Organizer — local backend proxy.
 *
 * - Serves the static frontend (index.html, styles.css, app.js, vendor libs).
 * - Holds the Hugging Face access token in server memory only (from HF_TOKEN in
 *   .env, or supplied once through the connection screen). The token is never
 *   returned to the browser, never logged, and is redacted from error messages.
 * - Proxies a small, validated subset of the Hugging Face Hub API:
 *   repository listing and collection CRUD.
 *
 * No third-party runtime dependencies: Node 18+ (built-in fetch) is enough.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Only the real server reads .env; tests that require() this module stay hermetic.
if (require.main === module) loadDotEnv(path.join(__dirname, '.env'));

const PORT = parseInt(process.env.PORT || '5173', 10);
const HOST = process.env.HOST || '127.0.0.1';
const HF_ENDPOINT = (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
const MAX_BODY = 64 * 1024;
const PAGE_LIMIT = 100;

/** Token state lives only in this closure. */
const auth = {
  token: process.env.HF_TOKEN ? process.env.HF_TOKEN.trim() : null,
  source: process.env.HF_TOKEN ? 'env' : null,
  whoami: null,
};

function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code || 'error';
    this.details = details;
  }
}

/** Remove anything that looks like a credential from a string. */
function redact(value) {
  let s = String(value == null ? '' : value);
  if (auth.token) s = s.split(auth.token).join('[redacted]');
  return s.replace(/hf_[A-Za-z0-9]{8,}/g, 'hf_[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

function log(...args) {
  console.log(new Date().toISOString(), ...args.map(redact));
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request body too large', 'body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON body', 'bad_json')); }
    });
    req.on('error', reject);
  });
}

const RE_USERNAME = /^[A-Za-z0-9][\w.-]{0,95}$/;
const RE_REPO_ID = /^[A-Za-z0-9][\w.-]{0,95}\/[\w.-]{1,96}$/;
const RE_SLUG = /^[A-Za-z0-9][\w.-]{0,95}\/[\w.-]{1,200}$/;
const RE_OBJECT_ID = /^[a-f0-9]{24}$/i;
const REPO_TYPES = new Set(['model', 'dataset', 'space']);

function requireToken() {
  if (!auth.token) throw new HttpError(401, 'Not connected to Hugging Face. Add a token on the connection screen or set HF_TOKEN in .env.', 'not_connected');
}

/** Map a Hub error response to a friendly, credential-free message. */
function hubErrorMessage(status, bodyText, action) {
  let hubMsg = '';
  try { hubMsg = JSON.parse(bodyText).error || ''; } catch { hubMsg = (bodyText || '').slice(0, 300); }
  hubMsg = redact(hubMsg);
  const prefix = action ? `${action}: ` : '';
  switch (status) {
    case 401: return { code: 'unauthorized', message: `${prefix}the token was rejected by Hugging Face (invalid or expired).${hubMsg ? ' ' + hubMsg : ''}` };
    case 403: return { code: 'forbidden', message: `${prefix}permission denied. Make sure the token has write access to collections${hubMsg ? ' (' + hubMsg + ')' : ''}.` };
    case 404: return { code: 'not_found', message: `${prefix}not found on Hugging Face.${hubMsg ? ' ' + hubMsg : ''}` };
    case 409: return { code: 'conflict', message: `${prefix}conflict.${hubMsg ? ' ' + hubMsg : ''}` };
    case 429: return { code: 'rate_limited', message: `${prefix}rate limited by Hugging Face. Wait a moment and retry.` };
    default: return { code: 'hub_error', message: `${prefix}Hugging Face returned HTTP ${status}.${hubMsg ? ' ' + hubMsg : ''}` };
  }
}

async function hub(method, urlPath, { body, query, action, raw } = {}) {
  const url = new URL(urlPath.startsWith('http') ? urlPath : HF_ENDPOINT + urlPath);
  if (!url.href.startsWith(HF_ENDPOINT + '/')) throw new HttpError(400, 'Refusing to call a non-Hub URL', 'bad_url');
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }
  const headers = { Accept: 'application/json', 'User-Agent': 'hf-organizer/1.0' };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      if (attempt < 2 && method === 'GET') { await sleep(500 * 2 ** attempt); continue; }
      throw new HttpError(502, `Could not reach Hugging Face (${redact(err.cause?.code || err.message)}).`, 'network');
    }
    // Retry idempotent reads on rate-limit / transient server errors.
    if (method === 'GET' && (res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
      await sleep(Math.max(retryAfter * 1000, 600 * 2 ** attempt));
      continue;
    }
    break;
  }
  if (raw) return res;
  const text = await res.text();
  if (!res.ok) {
    const { code, message } = hubErrorMessage(res.status, text, action);
    throw new HttpError(res.status === 401 ? 401 : res.status === 403 ? 403 : res.status === 404 ? 404 : res.status === 409 ? 409 : res.status === 429 ? 429 : 502, message, code);
  }
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nextLink(res) {
  const link = res.headers.get('link');
  if (!link) return null;
  const m = link.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

/** Follow GitHub-style Link pagination, as huggingface_hub's `paginate` does. */
async function paginate(urlPath, query, action) {
  const out = [];
  let res = await hub('GET', urlPath, { query, action, raw: true });
  for (let page = 0; page < 200; page++) {
    const text = await res.text();
    if (!res.ok) {
      const { code, message } = hubErrorMessage(res.status, text, action);
      throw new HttpError(res.status === 401 || res.status === 403 ? res.status : 502, message, code);
    }
    out.push(...JSON.parse(text));
    const next = nextLink(res);
    if (!next) break;
    res = await hub('GET', next, { action, raw: true });
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Hub data normalisation
// ---------------------------------------------------------------------------

function normalizeRepo(raw, type) {
  const id = raw.id || raw.modelId;
  const card = raw.cardData || {};
  return {
    type,
    id,
    name: id.split('/').pop(),
    author: raw.author || id.split('/')[0],
    private: !!raw.private,
    gated: raw.gated || false,
    lastModified: raw.lastModified || raw.createdAt || null,
    createdAt: raw.createdAt || null,
    downloads: typeof raw.downloads === 'number' ? raw.downloads : null,
    likes: typeof raw.likes === 'number' ? raw.likes : null,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string').slice(0, 40) : [],
    pipelineTag: raw.pipeline_tag || null,
    library: raw.library_name || null,
    sdk: raw.sdk || card.sdk || null,
    description: (type === 'dataset' ? raw.description : card.short_description || card.description) || null,
  };
}

function normalizeCollection(raw) {
  return {
    slug: raw.slug,
    title: raw.title,
    description: raw.description || '',
    private: !!raw.private,
    theme: raw.theme || null,
    upvotes: raw.upvotes || 0,
    position: raw.position,
    lastUpdated: raw.lastUpdated || null,
    owner: raw.owner ? { name: raw.owner.name, type: raw.owner.type } : null,
    items: (raw.items || []).map((it) => ({
      objectId: it._id,
      type: it.type,
      id: it.type === 'collection' ? it.slug || it.id : it.id,
      position: it.position,
      note: it.note && typeof it.note === 'object' ? it.note.text || '' : typeof it.note === 'string' ? it.note : '',
      title: it.title || it.name || null,
    })),
  };
}

function summarizePermissions(who) {
  const tok = who?.auth?.accessToken || {};
  const role = tok.role || 'unknown';
  const result = { role, fineGrained: role === 'fineGrained', canWriteCollections: null, canReadPrivateRepos: null, notes: [] };
  if (role === 'write' || role === 'admin') {
    result.canWriteCollections = true;
    result.canReadPrivateRepos = true;
  } else if (role === 'read') {
    result.canWriteCollections = false;
    result.canReadPrivateRepos = true;
    result.notes.push('Read-only token: collections can be imported but changes cannot be synced.');
  } else if (role === 'fineGrained') {
    const fg = tok.fineGrained || {};
    const perms = new Set();
    for (const p of fg.global || []) perms.add(p);
    for (const s of fg.scoped || []) {
      if (!s.entity || s.entity.type === 'user' || s.entity.name === who.name) (s.permissions || []).forEach((p) => perms.add(p));
    }
    const list = [...perms];
    result.canWriteCollections = list.some((p) => /collection.*write/i.test(p)) ? true : list.length ? false : null;
    result.canReadPrivateRepos = list.some((p) => /repo.*(read|write)/i.test(p)) ? true : list.length ? false : null;
    if (result.canWriteCollections === false) result.notes.push('This fine-grained token does not appear to include "Write access to collections". Sync will fail with 403 until it is added.');
    if (result.canReadPrivateRepos === false) result.notes.push('This token does not appear to grant read access to your repositories, so private repositories may be missing.');
  }
  return result;
}

/** HF_USERNAME from the environment (read on each call), or null when unset. */
function configuredOwner() {
  return (process.env.HF_USERNAME || '').trim() || null;
}

/** Whose repositories to import: HF_USERNAME, else the connected token's account. */
function effectiveOwner() {
  return configuredOwner() || auth.whoami?.name || null;
}

function publicStatus() {
  const w = auth.whoami;
  return {
    connected: !!(auth.token && w),
    tokenConfigured: !!auth.token,
    tokenSource: auth.source,
    owner: effectiveOwner(),
    // HF_USERNAME alone (no token fallback): demo mode names its fictional repos after this.
    configuredOwner: configuredOwner(),
    hfEndpoint: HF_ENDPOINT,
    user: w ? { name: w.name, fullname: w.fullname || w.name, avatarUrl: w.avatarUrl || null, type: w.type, orgs: (w.orgs || []).map((o) => o.name) } : null,
    permissions: w ? summarizePermissions(w) : null,
  };
}

async function validateToken() {
  if (!auth.token) { auth.whoami = null; return; }
  auth.whoami = await hub('GET', '/api/whoami-v2', { action: 'Validating token' });
}

/** Collections may only be written in namespaces the token owner controls. */
function assertWritableNamespace(ns) {
  const w = auth.whoami;
  if (!w) throw new HttpError(401, 'Not connected.', 'not_connected');
  const allowed = new Set([w.name, ...(w.orgs || []).map((o) => o.name)]);
  if (!allowed.has(ns)) throw new HttpError(403, `The connected account cannot modify collections in "${ns}".`, 'forbidden_namespace');
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

async function routeApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/status' && m === 'GET') {
    if (auth.token && !auth.whoami) {
      try { await validateToken(); }
      catch (err) { return sendJson(res, 200, { ...publicStatus(), error: { code: err.code, message: err.message } }); }
    }
    return sendJson(res, 200, publicStatus());
  }

  if (p === '/api/connect' && m === 'POST') {
    const body = await readJsonBody(req);
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!/^hf_[A-Za-z0-9]{20,}$/.test(token)) throw new HttpError(400, 'That does not look like a Hugging Face access token (expected "hf_…").', 'bad_token');
    const previous = { ...auth };
    auth.token = token; auth.source = 'session'; auth.whoami = null;
    try {
      await validateToken();
    } catch (err) {
      Object.assign(auth, previous);
      throw err;
    }
    log(`Connected as ${auth.whoami.name} (token held in memory only)`);
    return sendJson(res, 200, publicStatus());
  }

  if (p === '/api/disconnect' && m === 'POST') {
    if (auth.source === 'env') throw new HttpError(400, 'The token comes from HF_TOKEN in .env. Remove it there and restart the server to disconnect.', 'env_token');
    auth.token = null; auth.source = null; auth.whoami = null;
    return sendJson(res, 200, publicStatus());
  }

  if (p === '/api/repos' && m === 'GET') {
    const author = url.searchParams.get('author') || effectiveOwner();
    if (!author) throw new HttpError(400, 'No Hugging Face username configured. Set HF_USERNAME in .env, or connect a token to import that account’s repositories.', 'no_owner');
    if (!RE_USERNAME.test(author)) throw new HttpError(400, `“${author}” is not a valid Hugging Face username. Check HF_USERNAME in .env.`, 'bad_author');
    const common = { author, limit: PAGE_LIMIT };
    const specs = [
      ['model', '/api/models', ['author', 'private', 'downloads', 'likes', 'lastModified', 'createdAt', 'tags', 'pipeline_tag', 'library_name', 'gated']],
      ['dataset', '/api/datasets', ['author', 'private', 'downloads', 'likes', 'lastModified', 'createdAt', 'tags', 'description', 'gated']],
      ['space', '/api/spaces', ['author', 'private', 'likes', 'lastModified', 'createdAt', 'tags', 'sdk', 'cardData']],
    ];
    const errors = [];
    const lists = await Promise.all(specs.map(async ([type, ep, expand]) => {
      try {
        const raw = await paginate(ep, { ...common, expand }, `Listing ${type}s`);
        return raw.map((r) => normalizeRepo(r, type));
      } catch (err) {
        errors.push({ type, message: err.message, code: err.code });
        return [];
      }
    }));
    if (errors.length === 3) throw new HttpError(502, errors[0].message, errors[0].code);
    return sendJson(res, 200, { author, repos: lists.flat(), errors });
  }

  if (p === '/api/collections' && m === 'GET') {
    requireToken();
    if (!auth.whoami) await validateToken();
    const owner = auth.whoami.name;
    const list = await paginate('/api/collections', { owner, limit: PAGE_LIMIT }, 'Listing collections');
    // Listing truncates items to 4 per collection: fetch each one in full.
    const full = await mapLimit(list, 4, (c) => hub('GET', `/api/collections/${c.slug}`, { action: `Loading collection "${c.title}"` }));
    return sendJson(res, 200, { owner, collections: full.map(normalizeCollection) });
  }

  if (p === '/api/collections' && m === 'POST') {
    requireToken();
    const body = await readJsonBody(req);
    const title = String(body.title || '').trim();
    if (!title || title.length > 200) throw new HttpError(400, 'Title is required (max 200 characters).', 'bad_title');
    const namespace = body.namespace || auth.whoami?.name;
    assertWritableNamespace(namespace);
    const payload = { title, namespace, private: !!body.private };
    if (body.description) payload.description = String(body.description).slice(0, 150);
    const created = await hub('POST', '/api/collections', { body: payload, action: `Creating "${title}"` });
    log(`Created collection ${created.slug}`);
    return sendJson(res, 200, { collection: normalizeCollection(created) });
  }

  const cm = p.match(/^\/api\/collections\/([^/]+)\/([^/]+)(\/items(?:\/([^/]+))?)?$/);
  if (cm) {
    requireToken();
    const ns = decodeURIComponent(cm[1]);
    const slug = `${ns}/${decodeURIComponent(cm[2])}`;
    if (!RE_SLUG.test(slug)) throw new HttpError(400, 'Invalid collection slug', 'bad_slug');
    const enc = slug.split('/').map(encodeURIComponent).join('/');

    if (!cm[3]) {
      if (m === 'GET') {
        const c = await hub('GET', `/api/collections/${enc}`, { action: 'Loading collection' });
        return sendJson(res, 200, { collection: normalizeCollection(c) });
      }
      if (m === 'PATCH') {
        assertWritableNamespace(ns);
        const body = await readJsonBody(req);
        const payload = {};
        if (typeof body.title === 'string') {
          const t = body.title.trim();
          if (!t || t.length > 200) throw new HttpError(400, 'Title must be 1–200 characters.', 'bad_title');
          payload.title = t;
        }
        if (typeof body.description === 'string') payload.description = body.description.slice(0, 150);
        if (typeof body.private === 'boolean') payload.private = body.private;
        if (!Object.keys(payload).length) throw new HttpError(400, 'Nothing to update', 'empty_update');
        const r = await hub('PATCH', `/api/collections/${enc}`, { body: payload, action: 'Updating collection' });
        const data = r && r.data ? r.data : r;
        return sendJson(res, 200, { collection: data && data.slug ? normalizeCollection(data) : null });
      }
      if (m === 'DELETE') {
        assertWritableNamespace(ns);
        await hub('DELETE', `/api/collections/${enc}`, { action: 'Deleting collection' });
        log(`Deleted collection ${slug}`);
        return sendJson(res, 200, { ok: true });
      }
    } else if (!cm[4] && m === 'POST') {
      assertWritableNamespace(ns);
      const body = await readJsonBody(req);
      if (!REPO_TYPES.has(body.type) || !RE_REPO_ID.test(body.id || '')) throw new HttpError(400, 'Invalid item', 'bad_item');
      const payload = { item: { type: body.type, id: body.id } };
      if (body.note) payload.note = String(body.note).slice(0, 500);
      const r = await hub('POST', `/api/collections/${enc}/items`, { body: payload, action: `Adding ${body.id}` });
      return sendJson(res, 200, { collection: r && r.slug ? normalizeCollection(r) : null });
    } else if (cm[4] && m === 'DELETE') {
      assertWritableNamespace(ns);
      const objectId = decodeURIComponent(cm[4]);
      if (!RE_OBJECT_ID.test(objectId)) throw new HttpError(400, 'Invalid item object id', 'bad_item');
      await hub('DELETE', `/api/collections/${enc}/items/${objectId}`, { action: 'Removing item' });
      return sendJson(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, 'Unknown API route', 'not_found');
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/vendor/lucide.min.js': ['node_modules/lucide/dist/umd/lucide.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/Sortable.min.js': ['node_modules/sortablejs/Sortable.min.js', 'text/javascript; charset=utf-8'],
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function serveStatic(req, res, url) {
  const entry = STATIC[url.pathname];
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  fs.readFile(path.join(__dirname, entry[0]), (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': entry[1],
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostAllowed(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  const extra = (process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return LOCAL_HOSTS.has(host) || extra.includes(host);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // DNS-rebinding protection: only answer requests addressed to a local host name.
  if (!hostAllowed(req)) {
    res.writeHead(421, { 'Content-Type': 'text/plain' });
    return res.end('Misdirected request');
  }
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);

  try {
    // CSRF protection: a custom header cannot be sent cross-origin without a
    // CORS preflight, which this server never approves.
    if (req.headers['x-hf-organizer'] !== '1') throw new HttpError(403, 'Missing X-HF-Organizer header', 'csrf');
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      const oh = new URL(origin).host;
      if (oh !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused', 'csrf');
    }
    await routeApi(req, res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : 'Internal server error';
    if (!(err instanceof HttpError)) log('Unhandled error:', err && err.stack);
    sendJson(res, status, { error: { code: err.code || 'internal', message: redact(message) } });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, async () => {
    log(`HF Organizer running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (auth.token) {
      try { await validateToken(); log(`Token from .env is valid for user "${auth.whoami.name}".`); }
      catch (err) { log(`Token from .env could not be validated: ${err.message}`); }
    } else {
      log('No HF_TOKEN set: open the app to use demo mode or connect with a token.');
    }
    const owner = configuredOwner();
    if (!owner) log('HF_USERNAME not set: the connected token\'s account will be used as the repositories owner.');
    else if (!RE_USERNAME.test(owner)) log(`Warning: HF_USERNAME "${owner}" is not a valid Hugging Face username.`);
  });
}

module.exports = { server, normalizeCollection, normalizeRepo, summarizePermissions, redact };
