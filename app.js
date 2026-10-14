/* =====================================================================
   HF Organizer — client application (vanilla JS)

   Model
   -----
   baseline : collections exactly as last imported from Hugging Face (or the
              demo seed). Never edited by the UI.
   working  : the user's staged view of collections. Every drag, bulk action
              or edit mutates `working` only.
   plan     : computePlan(baseline, working) — the list of API operations
              that would turn the remote state into the staged state. This is
              what the Sync modal reviews and executes, what is persisted as a
              draft, and what is replayed after a refresh or a partial sync.
   ===================================================================== */
(() => {
  'use strict';

  // -------------------------------------------------------------------
  // Constants & tiny utilities
  // -------------------------------------------------------------------
  // Namespace for fictional demo repos when no HF_USERNAME is configured on the server.
  const DEMO_OWNER = 'demo-user';
  const HF = 'https://huggingface.co';
  const RECENT_DAYS = 30;
  const UNDO_LIMIT = 100;
  const DESC_MAX = 150;
  const TYPE_META = {
    model: { label: 'Model', plural: 'Models', icon: 'brain', path: '' },
    dataset: { label: 'Dataset', plural: 'Datasets', icon: 'database', path: 'datasets/' },
    space: { label: 'Space', plural: 'Spaces', icon: 'rocket', path: 'spaces/' },
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const repoKey = (type, id) => `${type}:${id}`;
  const plural = (n, w, p) => `${n} ${n === 1 ? w : p || w + 's'}`;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fmtNum(n) {
    if (n == null) return '—';
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'K';
    return (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '') + 'M';
  }
  function relTime(iso) {
    if (!iso) return 'unknown';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    const units = [[60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
    let v = s / 60;
    for (const [n, u] of units) {
      if (v < n) { const r = Math.floor(v); return `${r} ${u}${r === 1 ? '' : 's'} ago`; }
      v /= n;
    }
    return '';
  }
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const repoUrl = (r) => `${HF}/${TYPE_META[r.type].path}${r.id}`;
  const collectionUrl = (slug) => `${HF}/collections/${slug}`;

  // Lucide icons rendered to cached SVG strings (fast for hundreds of cards).
  const iconCache = new Map();
  function icon(name, cls = '') {
    const k = name + '|' + cls;
    if (iconCache.has(k)) return iconCache.get(k);
    let svg = '';
    const L = window.lucide;
    if (L && L.icons) {
      const pascal = name.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
      const node = L.icons[pascal];
      if (node) {
        const children = node[0] === 'svg' ? node[2] : node;
        const attrs = (a) => Object.entries(a).map(([x, y]) => `${x}="${esc(y)}"`).join(' ');
        svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-${name} ${cls}" aria-hidden="true">${children.map(([t, a]) => `<${t} ${attrs(a)}/>`).join('')}</svg>`;
      }
    }
    iconCache.set(k, svg);
    return svg;
  }
  function hydrateIcons(root = document) {
    $$('[data-icon]', root).forEach((el) => { if (!el.firstChild) el.innerHTML = icon(el.dataset.icon); });
  }

  const safeStorage = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // -------------------------------------------------------------------
  // Backend API client (the token never passes through here)
  // -------------------------------------------------------------------
  class ApiError extends Error {
    constructor(status, message, code) { super(message); this.status = status; this.code = code; }
  }
  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: { 'X-HF-Organizer': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
      });
    } catch {
      throw new ApiError(0, 'Could not reach the local HF Organizer server. Is `npm start` running?', 'offline');
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new ApiError(res.status, data?.error?.message || `Request failed (HTTP ${res.status})`, data?.error?.code);
    return data;
  }
  const slugPath = (slug) => slug.split('/').map(encodeURIComponent).join('/');

  // -------------------------------------------------------------------
  // Demo data (fictional)
  // -------------------------------------------------------------------
  function buildDemo(owner) {
    const day = 86400000;
    const now = Date.now();
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const R = (type, name, o = {}) => ({
      type, id: `${owner}/${name}`, name, author: owner,
      private: !!o.private,
      lastModified: new Date(now - (o.days ?? Math.floor(rnd() * 400)) * day - Math.floor(rnd() * day)).toISOString(),
      downloads: type === 'space' ? null : (o.dl ?? Math.floor(rnd() ** 3 * 40000)),
      likes: o.likes ?? Math.floor(rnd() ** 2 * 120),
      tags: o.tags || [],
      pipelineTag: o.task || null,
      library: o.lib || null,
      sdk: o.sdk || null,
      description: o.desc || null,
      demo: true,
    });
    const repos = [
      R('model', 'llama-finetune', { days: 2, dl: 12400, likes: 42, task: 'text-generation', lib: 'transformers', tags: ['llama', 'lora', 'sft', 'en'], desc: 'Llama fine-tuned with LoRA on an instruction mix.' }),
      R('model', 'qwen-experiment', { days: 5, dl: 3100, likes: 17, task: 'text-generation', lib: 'transformers', tags: ['qwen2', 'dpo', 'experimental'], private: true }),
      R('model', 'yolo-detection', { days: 11, dl: 8800, likes: 31, task: 'object-detection', lib: 'ultralytics', tags: ['yolov8', 'detection', 'coco'] }),
      R('model', 'sam2-segmentation', { days: 1, dl: 2400, likes: 26, task: 'mask-generation', lib: 'transformers', tags: ['sam2', 'segmentation'] }),
      R('model', 'whisper-asr', { days: 19, dl: 15800, likes: 58, task: 'automatic-speech-recognition', lib: 'transformers', tags: ['whisper', 'asr', 'ko', 'en'] }),
      R('dataset', 'speech-dataset', { days: 40, dl: 920, likes: 12, tags: ['audio', 'asr', 'ko'], desc: '120 hours of transcribed conversational speech.' }),
      R('model', 'image-classifier', { days: 63, dl: 5100, likes: 9, task: 'image-classification', lib: 'timm', tags: ['vit', 'imagenet'] }),
      R('space', 'stable-diffusion-demo', { days: 8, likes: 87, sdk: 'gradio', tags: ['diffusers', 'text-to-image'], desc: 'Interactive SDXL demo with prompt presets.' }),
      R('model', 'mistral-7b-dpo', { task: 'text-generation', lib: 'transformers', tags: ['mistral', 'dpo'] }),
      R('model', 'phi-3-mini-lora', { task: 'text-generation', lib: 'peft', tags: ['phi3', 'lora', 'adapter'] }),
      R('model', 'gemma-2b-instruct-sft', { task: 'text-generation', lib: 'transformers', tags: ['gemma', 'sft'], private: true }),
      R('model', 'tinyllama-chat-gguf', { task: 'text-generation', lib: 'gguf', tags: ['gguf', 'llama.cpp', 'q4_k_m'] }),
      R('model', 'bert-base-ner-ko', { task: 'token-classification', lib: 'transformers', tags: ['bert', 'ner', 'ko'] }),
      R('model', 'e5-embeddings-ft', { task: 'sentence-similarity', lib: 'sentence-transformers', tags: ['embeddings', 'retrieval'] }),
      R('model', 'reward-model-v2', { task: 'text-classification', lib: 'transformers', tags: ['rlhf', 'reward-model'], private: true }),
      R('model', 'clip-vit-retrieval', { task: 'zero-shot-image-classification', lib: 'open_clip', tags: ['clip', 'retrieval'] }),
      R('model', 'detr-traffic-signs', { task: 'object-detection', lib: 'transformers', tags: ['detr', 'traffic'] }),
      R('model', 'vit-food101', { task: 'image-classification', lib: 'transformers', tags: ['vit', 'food101'] }),
      R('model', 'dinov2-features', { task: 'image-feature-extraction', lib: 'transformers', tags: ['dinov2', 'ssl'] }),
      R('model', 'controlnet-sketch', { task: 'text-to-image', lib: 'diffusers', tags: ['controlnet', 'sdxl'] }),
      R('model', 'depth-anything-ft', { task: 'depth-estimation', lib: 'transformers', tags: ['depth'], private: true }),
      R('model', 'wav2vec2-korean', { task: 'automatic-speech-recognition', lib: 'transformers', tags: ['wav2vec2', 'ko'] }),
      R('model', 'musicgen-small-ft', { task: 'text-to-audio', lib: 'transformers', tags: ['musicgen', 'music'] }),
      R('model', 'vits-tts-ljspeech', { task: 'text-to-speech', lib: 'transformers', tags: ['tts', 'vits'] }),
      R('model', 'speaker-diarization', { task: 'voice-activity-detection', lib: 'pyannote', tags: ['diarization'], private: true }),
      R('model', 'ppo-cartpole', { task: 'reinforcement-learning', lib: 'stable-baselines3', tags: ['rl', 'ppo'] }),
      R('model', 'scratch-model-01', { days: 3, tags: ['test'], private: true }),
      R('model', 'scratch-model-02', { days: 4, tags: ['test'], private: true }),
      R('model', 'tokenizer-ko-32k', { tags: ['tokenizer', 'ko'] }),
      R('model', 'distil-classifier', { task: 'text-classification', lib: 'transformers', tags: ['distilbert'] }),
      R('model', 'merge-experiment-slerp', { days: 6, task: 'text-generation', lib: 'transformers', tags: ['mergekit', 'slerp'] }),
      R('dataset', 'alpaca-ko', { tags: ['instruction', 'ko'] }),
      R('dataset', 'instruct-mix-50k', { tags: ['instruction', 'sft'] }),
      R('dataset', 'preference-pairs-dpo', { days: 9, tags: ['dpo', 'preference'], private: true }),
      R('dataset', 'coco-mini', { tags: ['image', 'detection'] }),
      R('dataset', 'traffic-signs-yolo', { tags: ['image', 'detection', 'yolo'] }),
      R('dataset', 'food-images-small', { tags: ['image', 'classification'] }),
      R('dataset', 'podcast-transcripts', { tags: ['audio', 'text'] }),
      R('dataset', 'eval-results-2024', { tags: ['evaluation'], private: true }),
      R('dataset', 'web-crawl-sample', { tags: ['text', 'pretraining'] }),
      R('space', 'whisper-live-demo', { sdk: 'gradio', tags: ['asr'] }),
      R('space', 'chat-arena-lite', { sdk: 'gradio', tags: ['chat', 'leaderboard'] }),
      R('space', 'sam2-playground', { days: 1, sdk: 'gradio', tags: ['segmentation'] }),
      R('space', 'leaderboard-viewer', { sdk: 'streamlit', tags: ['leaderboard'] }),
      R('space', 'gradio-sandbox', { sdk: 'gradio', tags: ['test'], private: true }),
      R('space', 'docs-chatbot', { sdk: 'docker', tags: ['rag', 'chat'] }),
    ];
    const ids = (type, names) => names.map((n) => ({ type, id: `${owner}/${n}`, objectId: null }));
    const t0 = new Date(now - 3 * day).toISOString();
    const C = (title, desc, items, extra = {}) => ({
      key: demoSlug(owner, title),
      title, description: desc, private: false, lastUpdated: t0, items, ...extra,
    });
    const collections = [
      C('LLMs', 'Language models I trained, tuned or merged.', [
        ...ids('model', ['llama-finetune', 'qwen-experiment', 'mistral-7b-dpo', 'phi-3-mini-lora', 'gemma-2b-instruct-sft', 'tinyllama-chat-gguf', 'merge-experiment-slerp', 'reward-model-v2']),
        ...ids('space', ['chat-arena-lite']),
        { type: 'paper', id: '2305.18290', objectId: null, title: 'Direct Preference Optimization' },
      ]),
      C('Computer Vision', 'Detection, segmentation and classification.', [
        ...ids('model', ['yolo-detection', 'sam2-segmentation', 'image-classifier', 'clip-vit-retrieval', 'detr-traffic-signs', 'vit-food101']),
        ...ids('space', ['sam2-playground']),
      ]),
      C('Audio', 'Speech recognition, TTS and music.', [
        ...ids('model', ['whisper-asr', 'wav2vec2-korean', 'vits-tts-ljspeech']),
        ...ids('dataset', ['speech-dataset']),
        ...ids('space', ['whisper-live-demo']),
      ]),
      C('Datasets', 'Training and evaluation data.', [
        ...ids('dataset', ['speech-dataset', 'alpaca-ko', 'instruct-mix-50k', 'coco-mini', 'traffic-signs-yolo']),
      ]),
      C('Experiments', 'Work in progress — not production ready.', [
        ...ids('model', ['qwen-experiment', 'scratch-model-01', 'merge-experiment-slerp']),
        ...ids('space', ['gradio-sandbox']),
      ], { private: true }),
    ];
    collections.forEach((c) => { c.slug = c.key; c.items.forEach((it) => { it.objectId = fakeObjectId(); }); });
    return { repos, collections };
  }
  const demoSlug = (owner, title) => `${owner}/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-demo${uid().slice(0, 6)}`;
  function fakeObjectId() { let s = ''; for (let i = 0; i < 24; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)]; return s; }

  // -------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------
  const S = {
    mode: 'loading', // 'demo' | 'connected'
    backend: false,
    status: null, // /api/status payload
    owner: null, // repositories owner: HF_USERNAME, else the token's account, else DEMO_OWNER in demo mode
    repos: [],
    repoByKey: new Map(),
    repoErrors: [],
    baseline: [],
    working: [],
    memberOf: new Map(), // repoKey -> [collectionKey]
    planCache: null,
    undo: [],
    view: { kind: 'all' },
    q: '', localQ: '', type: 'all', vis: 'all', sort: 'updated-desc', layout: 'grid',
    colFilter: 'any', // 'any' | 'none' | 'in:<collectionKey>' | 'not:<collectionKey>'
    selection: new Set(),
    anchor: null,
    visible: [],
    loading: true,
    loadError: null,
    refreshing: false,
    detailsKey: null,
    drag: null,
  };

  const viewPrefs = safeStorage.get('hforg:prefs') || {};
  Object.assign(S, { sort: viewPrefs.sort || S.sort, layout: viewPrefs.layout || S.layout });
  const savePrefs = () => safeStorage.set('hforg:prefs', { sort: S.sort, layout: S.layout, theme: document.documentElement.dataset.theme || 'light' });

  const draftKey = () => (S.mode === 'demo' ? 'hforg:draft:demo' : `hforg:draft:${S.status?.user?.name || S.owner}`);

  // -------------------------------------------------------------------
  // Collections: lookups, membership & plan
  // -------------------------------------------------------------------
  const colByKey = (key, list = S.working) => list.find((c) => c.key === key);
  const itemIndex = (col, type, id) => col.items.findIndex((it) => it.type === type && it.id === id);
  const isRepoItem = (it) => it.type === 'model' || it.type === 'dataset' || it.type === 'space';

  function recompute() {
    const m = new Map();
    for (const col of S.working) {
      if (col.deleted) continue;
      for (const it of col.items) {
        if (!isRepoItem(it)) continue;
        const k = repoKey(it.type, it.id);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(col.key);
      }
    }
    S.memberOf = m;
    S.planCache = null;
  }

  /** Diff baseline → working into API operations. */
  function computePlan() {
    if (S.planCache) return S.planCache;
    const ops = [];
    const base = new Map(S.baseline.map((c) => [c.key, c]));
    for (const col of S.working) {
      const b = base.get(col.key);
      if (!b) {
        if (col.deleted) continue;
        ops.push({ id: `create|${col.key}`, kind: 'create', colKey: col.key, colTitle: col.title, fields: { title: col.title, description: col.description || '', private: !!col.private } });
        col.items.filter(isRepoItem).forEach((it) => ops.push({ id: `add|${col.key}|${repoKey(it.type, it.id)}`, kind: 'add', colKey: col.key, colTitle: col.title, item: { type: it.type, id: it.id } }));
        continue;
      }
      if (col.deleted) {
        ops.push({ id: `delete|${col.key}`, kind: 'delete', colKey: col.key, colTitle: b.title, slug: b.slug, itemCount: b.items.length });
        continue;
      }
      const fields = {};
      const baseFields = {};
      for (const f of ['title', 'description', 'private']) {
        const a = f === 'description' ? b[f] || '' : b[f];
        const w = f === 'description' ? col[f] || '' : col[f];
        if (a !== w) { fields[f] = w; baseFields[f] = a; }
      }
      if (Object.keys(fields).length) ops.push({ id: `update|${col.key}`, kind: 'update', colKey: col.key, colTitle: col.title, slug: b.slug, fields, baseFields });
      const bset = new Set(b.items.map((it) => repoKey(it.type, it.id)));
      const wset = new Set(col.items.map((it) => repoKey(it.type, it.id)));
      col.items.forEach((it) => { if (!bset.has(repoKey(it.type, it.id))) ops.push({ id: `add|${col.key}|${repoKey(it.type, it.id)}`, kind: 'add', colKey: col.key, colTitle: col.title, slug: b.slug, item: { type: it.type, id: it.id } }); });
      b.items.forEach((it) => { if (!wset.has(repoKey(it.type, it.id))) ops.push({ id: `remove|${col.key}|${repoKey(it.type, it.id)}`, kind: 'remove', colKey: col.key, colTitle: col.title, slug: b.slug, item: { type: it.type, id: it.id }, objectId: it.objectId }); });
    }
    S.planCache = ops;
    return ops;
  }

  /**
   * Replay intent operations onto a collections list (used to restore drafts,
   * rebase after a refresh, and keep failed operations after a sync).
   * keyMap maps local "new:" keys to slugs created during a sync.
   */
  function applyOps(cols, ops, keyMap = new Map()) {
    const find = (k) => cols.find((c) => c.key === (keyMap.get(k) || k));
    for (const op of ops) {
      if (op.kind === 'create') {
        if (find(op.colKey)) continue;
        const slug = keyMap.get(op.colKey);
        cols.push({ key: slug || op.colKey, slug: slug || null, title: op.fields.title, description: op.fields.description, private: op.fields.private, items: [], lastUpdated: null });
      } else if (op.kind === 'update') {
        const c = find(op.colKey);
        if (c) Object.assign(c, op.fields);
      } else if (op.kind === 'add') {
        const c = find(op.colKey);
        if (c && itemIndex(c, op.item.type, op.item.id) < 0) c.items.push({ ...op.item, objectId: null });
      } else if (op.kind === 'remove') {
        const c = find(op.colKey);
        if (c) { const i = itemIndex(c, op.item.type, op.item.id); if (i >= 0) c.items.splice(i, 1); }
      } else if (op.kind === 'delete') {
        const c = find(op.colKey);
        if (c) c.deleted = true;
      }
    }
    return cols;
  }

  const pendingFor = (colKey) => computePlan().filter((op) => op.colKey === colKey);

  function persistDraft() {
    const ops = computePlan();
    if (S.mode === 'demo') {
      safeStorage.set('hforg:draft:demo', { v: 1, owner: S.owner, baseline: S.baseline, repos: S.repos, ops });
    } else if (S.mode === 'connected') {
      if (ops.length) safeStorage.set(draftKey(), { v: 1, ops, savedAt: Date.now() });
      else safeStorage.del(draftKey());
    }
  }

  // -------------------------------------------------------------------
  // Mutations (all staged locally, all undoable)
  // -------------------------------------------------------------------
  function mutate(label, fn) {
    const snapshot = clone(S.working);
    const result = fn();
    if (result === false) return false;
    S.undo.push({ label, working: snapshot });
    if (S.undo.length > UNDO_LIMIT) S.undo.shift();
    afterChange();
    return result;
  }
  function afterChange({ full = true } = {}) {
    recompute();
    persistDraft();
    renderSidebar();
    renderSyncState();
    if (full) renderMain();
    renderDetails();
  }
  function undo() {
    const last = S.undo.pop();
    if (!last) { toast('Nothing to undo', 'info'); return; }
    S.working = last.working;
    afterChange();
    toast(`Undid: ${last.label}`, 'info');
  }

  function addToCollection(keys, colKey, { silent = false } = {}) {
    const col = colByKey(colKey);
    if (!col || col.deleted) return 0;
    const baseCol = colByKey(colKey, S.baseline);
    const toAdd = keys.map((k) => S.repoByKey.get(k)).filter((r) => r && itemIndex(col, r.type, r.id) < 0);
    if (!toAdd.length) {
      if (!silent) toast(keys.length === 1 ? `Already in “${col.title}”` : `All ${keys.length} are already in “${col.title}”`, 'info');
      return 0;
    }
    mutate(`add ${plural(toAdd.length, 'repository', 'repositories')} to ${col.title}`, () => {
      const c = colByKey(colKey);
      for (const r of toAdd) {
        const prev = baseCol && baseCol.items.find((it) => it.type === r.type && it.id === r.id);
        c.items.push(prev ? clone(prev) : { type: r.type, id: r.id, objectId: null });
      }
    });
    if (!silent) {
      const skipped = keys.length - toAdd.length;
      toast(`Added ${plural(toAdd.length, 'repository', 'repositories')} to “${col.title}”${skipped ? ` (${skipped} already there)` : ''}`, 'success', { action: 'Undo', onAction: undo });
    }
    return toAdd.length;
  }

  function removeFromCollection(keys, colKey, { silent = false } = {}) {
    const col = colByKey(colKey);
    if (!col || col.deleted) return 0;
    const toRemove = keys.map((k) => S.repoByKey.get(k)).filter((r) => r && itemIndex(col, r.type, r.id) >= 0);
    if (!toRemove.length) { if (!silent) toast(`None of the selected repositories are in “${col.title}”`, 'info'); return 0; }
    mutate(`remove ${plural(toRemove.length, 'repository', 'repositories')} from ${col.title}`, () => {
      const c = colByKey(colKey);
      for (const r of toRemove) c.items.splice(itemIndex(c, r.type, r.id), 1);
    });
    if (!silent) toast(`Removed ${plural(toRemove.length, 'repository', 'repositories')} from “${col.title}”`, 'success', { action: 'Undo', onAction: undo });
    return toRemove.length;
  }

  function createCollection(fields) {
    const key = `new:${uid()}`;
    mutate(`create ${fields.title}`, () => {
      S.working.push({ key, slug: null, title: fields.title, description: fields.description || '', private: !!fields.private, items: [], lastUpdated: null });
    });
    return key;
  }

  function updateCollection(colKey, fields) {
    const col = colByKey(colKey);
    if (!col) return;
    const changed = Object.keys(fields).filter((f) => (col[f] || '') !== (fields[f] || ''));
    if (!changed.length) return;
    mutate(`edit ${col.title}`, () => Object.assign(colByKey(colKey), fields));
    toast(`Updated “${fields.title || col.title}” — staged for sync`, 'success', { action: 'Undo', onAction: undo });
  }

  async function deleteCollection(colKey) {
    const col = colByKey(colKey);
    if (!col) return;
    const isNew = !colByKey(colKey, S.baseline);
    const n = col.items.length;
    const ok = await confirmDialog({
      title: `Delete “${col.title}”?`,
      message: isNew
        ? 'This collection has not been synced yet, so it will simply be discarded.'
        : `The collection and its ${plural(n, 'item')} will be permanently deleted from Hugging Face when you sync. The repositories themselves are not affected. Hugging Face cannot restore deleted collections.`,
      confirmLabel: isNew ? 'Discard collection' : 'Stage deletion',
      danger: true,
    });
    if (!ok) return;
    mutate(`delete ${col.title}`, () => {
      if (isNew) S.working = S.working.filter((c) => c.key !== colKey);
      else colByKey(colKey).deleted = true;
    });
    if (S.view.kind === 'collection' && S.view.key === colKey && isNew) setView({ kind: 'all' });
    toast(isNew ? `Discarded “${col.title}”` : `“${col.title}” will be deleted on sync`, 'warning', { action: 'Undo', onAction: undo });
  }

  function restoreCollection(colKey) {
    const col = colByKey(colKey);
    if (!col || !col.deleted) return;
    mutate(`restore ${col.title}`, () => { colByKey(colKey).deleted = false; });
    toast(`Restored “${col.title}”`, 'success');
  }

  // -------------------------------------------------------------------
  // Filtering / visible list
  // -------------------------------------------------------------------
  function matchQuery(r, q) {
    if (!q) return true;
    const hay = `${r.id} ${r.pipelineTag || ''} ${r.library || ''} ${r.sdk || ''} ${(r.tags || []).join(' ')} ${r.description || ''}`.toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
  }
  const isRecent = (r) => r.lastModified && Date.now() - new Date(r.lastModified).getTime() < RECENT_DAYS * 86400000;

  /** Resolve S.colFilter; collection keys may themselves contain ':' (e.g. "new:abc"). */
  function parseColFilter() {
    const f = S.colFilter;
    if (f === 'any' || f === 'none') return { mode: f };
    const i = f.indexOf(':');
    const col = colByKey(f.slice(i + 1));
    return col && !col.deleted ? { mode: f.slice(0, i), col } : { mode: 'any' };
  }

  /** Rebuild the collection filter options; drop a selection whose collection is gone. */
  function renderCollectionFilter() {
    const sel = $('#collection-filter');
    if (parseColFilter().mode === 'any') S.colFilter = 'any';
    const cols = S.working.filter((c) => !c.deleted);
    const opt = (value, label) => `<option value="${esc(value)}">${esc(label)}</option>`;
    sel.innerHTML = opt('any', 'Any collection') + opt('none', 'Not in any collection')
      + (cols.length ? `<optgroup label="Not in…">${cols.map((c) => opt(`not:${c.key}`, `Not in “${c.title}”`)).join('')}</optgroup>`
        + `<optgroup label="In…">${cols.map((c) => opt(`in:${c.key}`, `In “${c.title}”`)).join('')}</optgroup>` : '');
    sel.value = S.colFilter;
    sel.classList.toggle('active', S.colFilter !== 'any');
  }

  function computeVisible() {
    const v = S.view;
    let list = S.repos;
    if (v.kind === 'uncategorized') list = list.filter((r) => !S.memberOf.has(repoKey(r.type, r.id)));
    else if (v.kind === 'recent') list = list.filter(isRecent);
    else if (v.kind === 'private') list = list.filter((r) => r.private);
    else if (v.kind === 'collection') {
      const col = colByKey(v.key);
      const keys = new Set(col ? col.items.filter(isRepoItem).map((it) => repoKey(it.type, it.id)) : []);
      list = list.filter((r) => keys.has(repoKey(r.type, r.id)) !== !!v.invert);
    }
    const cf = parseColFilter();
    if (cf.mode === 'none') list = list.filter((r) => !S.memberOf.has(repoKey(r.type, r.id)));
    else if (cf.col) {
      const keys = new Set(cf.col.items.filter(isRepoItem).map((it) => repoKey(it.type, it.id)));
      list = list.filter((r) => keys.has(repoKey(r.type, r.id)) === (cf.mode === 'in'));
    }
    if (S.type !== 'all') list = list.filter((r) => r.type === S.type);
    if (S.vis !== 'all') list = list.filter((r) => (S.vis === 'private' ? r.private : !r.private));
    if (S.q) list = list.filter((r) => matchQuery(r, S.q));
    if (S.localQ) list = list.filter((r) => matchQuery(r, S.localQ));
    const t = (r) => (r.lastModified ? new Date(r.lastModified).getTime() : 0);
    const by = {
      'name-asc': (a, b) => a.name.localeCompare(b.name),
      'name-desc': (a, b) => b.name.localeCompare(a.name),
      'updated-desc': (a, b) => t(b) - t(a),
      'updated-asc': (a, b) => t(a) - t(b),
      'downloads-desc': (a, b) => (b.downloads ?? -1) - (a.downloads ?? -1),
      'likes-desc': (a, b) => (b.likes ?? -1) - (a.likes ?? -1),
    }[S.sort];
    return [...list].sort(by);
  }

  // -------------------------------------------------------------------
  // Rendering: top bar, sidebar
  // -------------------------------------------------------------------
  function renderChrome() {
    const pill = $('#mode-pill');
    const banner = $('#mode-banner');
    const user = S.status?.user;
    $('#owner-name').textContent = S.owner || '';
    $('#user-chip').hidden = !S.owner || S.owner === DEMO_OWNER;
    if (S.mode === 'connected') {
      pill.textContent = 'Connected';
      pill.className = 'mode-pill connected';
      const av = $('#avatar');
      av.textContent = (user?.name || S.owner || '?')[0].toUpperCase();
      if (user?.avatarUrl) {
        const url = user.avatarUrl.startsWith('http') ? user.avatarUrl : HF + user.avatarUrl;
        // The initial stays underneath and shows through if the image fails to load.
        av.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
      }
      const notes = S.status?.permissions?.notes || [];
      const errs = S.repoErrors.map((e) => e.message);
      if (notes.length || errs.length) {
        banner.className = 'mode-banner show error';
        banner.innerHTML = `${icon('alert-triangle')}<span class="grow">${esc([...notes, ...errs].join(' '))}</span><button class="btn btn-sm" data-act="account">Connection details</button>`;
      } else {
        banner.className = 'mode-banner';
        banner.innerHTML = '';
      }
    } else {
      pill.textContent = 'Demo';
      pill.className = 'mode-pill';
      const av = $('#avatar');
      av.style.backgroundImage = '';
      av.textContent = (S.owner || '?')[0].toUpperCase();
      banner.className = 'mode-banner show';
      banner.innerHTML = `${icon('flask-conical')}<span class="grow"><span class="banner-short"><strong>Demo mode</strong> — fictional sample data. Nothing is sent to Hugging Face.</span><span class="banner-long"><strong>Demo mode</strong> — these repositories and collections are <strong>fictional sample data</strong>, not real repositories${S.owner && S.owner !== DEMO_OWNER ? ` of “${esc(S.owner)}”` : ''}. Nothing is ever sent to Hugging Face.${S.backend ? '' : ' Start the local server (<code>npm start</code>) to connect your account.'}</span></span>${S.backend ? '<button class="btn btn-sm btn-primary" data-act="connect">Connect Hugging Face</button>' : ''}<button class="btn btn-sm" data-act="reset-demo" title="Reset demo data">Reset demo</button>`;
    }
    $('#repo-total').textContent = S.loading ? 'Loading…' : plural(S.repos.length, 'repo');
    const foot = $('#sidebar-footer');
    if (S.mode === 'connected') {
      foot.innerHTML = `<div class="row"><span class="status-dot ok"></span>Connected as <strong>${esc(user?.name || '')}</strong></div>`;
    } else {
      foot.innerHTML = `<div class="row"><span class="status-dot"></span>Demo data · ${S.backend ? 'server available' : 'no server'}</div>`;
    }
  }

  function renderSidebar() {
    const counts = {
      all: S.repos.length,
      uncategorized: S.repos.filter((r) => !S.memberOf.has(repoKey(r.type, r.id))).length,
      recent: S.repos.filter(isRecent).length,
      private: S.repos.filter((r) => r.private).length,
    };
    const ws = [
      ['all', 'All Repositories', 'layout-grid'],
      ['uncategorized', 'Uncategorized', 'inbox'],
      ['recent', 'Recently Updated', 'clock'],
      ['private', 'Private', 'lock'],
    ];
    $('#nav-workspace').innerHTML = ws.map(([k, label, ic]) => `
      <li><button class="nav-item ${S.view.kind === k ? 'active' : ''}" data-view="${k}" ${S.view.kind === k ? 'aria-current="page"' : ''}>
        ${icon(ic)}<span class="nav-label">${label}</span><span class="nav-count">${S.loading ? '' : counts[k]}</span>
      </button></li>`).join('');

    const dirty = new Set(computePlan().map((op) => op.colKey));
    const baseKeys = new Set(S.baseline.map((c) => c.key));
    const ownedCount = (col) => col.items.filter((it) => S.repoByKey.has(repoKey(it.type, it.id))).length;
    $('#nav-collections').innerHTML = S.working.length
      ? S.working.map((col) => {
        const active = S.view.kind === 'collection' && S.view.key === col.key;
        const other = col.items.length - ownedCount(col);
        const tip = `${col.title}${col.description ? ' — ' + col.description : ''}${other ? ` (+${other} other item${other === 1 ? '' : 's'} preserved)` : ''}`;
        return `<li><div class="nav-item nav-collection ${active ? 'active' : ''} ${baseKeys.has(col.key) ? '' : 'is-new'} ${col.deleted ? 'is-deleted' : ''} ${col.private ? 'is-private' : ''}"
            role="button" tabindex="0" data-col="${esc(col.key)}" title="${esc(tip)}" ${active ? 'aria-current="page"' : ''} aria-label="${esc(col.title)} collection, ${ownedCount(col)} repositories${col.deleted ? ', staged for deletion' : ''}">
          ${icon(active ? 'folder-open' : 'folder')}<span class="nav-label">${esc(col.title)}</span>
          ${col.private ? `<span class="lock" title="Private collection">${icon('lock')}</span>` : ''}
          ${dirty.has(col.key) ? '<span class="nav-dirty" title="Unsynced changes"></span>' : ''}
          <span class="nav-count">${ownedCount(col)}</span>
          <button class="icon-btn tiny nav-more" data-col-menu="${esc(col.key)}" aria-label="Options for ${esc(col.title)}">${icon('more-horizontal')}</button>
        </div></li>`;
      }).join('')
      : `<li class="muted" style="padding:6px 10px;font-size:13px">${S.loading ? 'Loading…' : 'No collections yet.'}</li>`;
  }

  function renderSyncState() {
    const n = computePlan().length;
    const badge = $('#sync-badge');
    badge.hidden = n === 0;
    badge.textContent = n;
    $('#btn-sync').classList.toggle('has-changes', n > 0);
    $('#btn-sync').title = n ? `${plural(n, 'unsynced change')} — review and sync` : 'Everything is in sync';
    document.title = n ? `(${n}) HF Organizer` : 'HF Organizer';
  }

  // -------------------------------------------------------------------
  // Rendering: main grid
  // -------------------------------------------------------------------
  function viewMeta() {
    const v = S.view;
    if (v.kind === 'collection') {
      const col = colByKey(v.key);
      if (!col) return { title: 'Collection not found', desc: '' };
      const other = col.items.filter((it) => !S.repoByKey.has(repoKey(it.type, it.id))).length;
      let desc = col.description || '';
      if (other) desc += `${desc ? ' · ' : ''}+${other} item${other === 1 ? '' : 's'} not owned by ${S.owner} (papers, other repos) — preserved, not shown.`;
      if (col.deleted) desc = 'Staged for deletion. Restore it from the ⋯ menu, or undo.';
      else if (v.invert) return { title: `Not in “${col.title}”`, desc: 'Repositories that are not in this collection yet. Select some, then drag them onto it in the sidebar or use the Add button in the selection bar.', col };
      return { title: col.title, desc, col };
    }
    return {
      all: { title: 'All Repositories', desc: '' },
      uncategorized: { title: 'Uncategorized', desc: 'Repositories that are not in any of your collections.' },
      recent: { title: 'Recently Updated', desc: `Updated in the last ${RECENT_DAYS} days.` },
      private: { title: 'Private Repositories', desc: '' },
    }[v.kind];
  }

  function chipHtml(colKey, repo, removable) {
    const col = colByKey(colKey);
    const base = colByKey(colKey, S.baseline);
    const staged = !base || itemIndex(base, repo.type, repo.id) < 0;
    return `<span class="chip ${staged ? 'staged-add' : ''}" title="${esc(col.title)}${staged ? ' (staged, not yet synced)' : ''}"><span>${esc(col.title)}</span>${removable ? `<button data-chip-remove="${esc(colKey)}" aria-label="Remove from ${esc(col.title)}">${icon('x')}</button>` : ''}</span>`;
  }

  function cardHtml(r) {
    const k = repoKey(r.type, r.id);
    const sel = S.selection.has(k);
    const m = TYPE_META[r.type];
    const cols = S.memberOf.get(k) || [];
    const task = r.pipelineTag ? r.pipelineTag.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : r.sdk ? `${r.sdk[0].toUpperCase()}${r.sdk.slice(1)} app` : r.library || '';
    const tags = (r.tags || []).filter((t) => !t.includes(':')).slice(0, 4);
    return `<div class="card ${sel ? 'selected' : ''}" data-key="${esc(k)}" role="option" aria-selected="${sel}" tabindex="0" aria-label="${esc(r.id)}, ${m.label}${r.private ? ', private' : ''}">
      <div class="card-top">
        <button class="checkbox" tabindex="-1" aria-hidden="true" data-check>${icon('check')}</button>
        <span class="type-badge type-${r.type}">${icon(m.icon)}${m.label}</span>
        <span class="vis-badge ${r.private ? 'private' : ''}">${icon(r.private ? 'lock' : 'globe')}${r.private ? 'Private' : 'Public'}</span>
        <button class="icon-btn tiny card-quick" data-quick aria-label="Add ${esc(r.name)} to a collection">${icon('folder-plus')}</button>
        <button class="icon-btn tiny card-info" data-info aria-label="Details for ${esc(r.name)}" title="Details">${icon('info')}</button>
      </div>
      <div class="card-name" title="${esc(r.name)}">${esc(r.name)}</div>
      <div class="card-id">${esc(r.id)}</div>
      <div class="card-meta">${task ? `<span class="task">${esc(task)}</span>` : ''}<span>Updated ${esc(relTime(r.lastModified))}</span></div>
      <div class="card-stats">${r.downloads != null ? `<span title="Downloads (last 30 days)">${icon('download')}${fmtNum(r.downloads)}</span>` : ''}${r.likes != null ? `<span title="Likes">${icon('heart')}${fmtNum(r.likes)}</span>` : ''}</div>
      ${tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="chips">${cols.length ? cols.map((c) => chipHtml(c, r, true)).join('') : '<span class="chip empty">No collection</span>'}</div>
    </div>`;
  }

  function rowHtml(r) {
    const k = repoKey(r.type, r.id);
    const sel = S.selection.has(k);
    const m = TYPE_META[r.type];
    const cols = S.memberOf.get(k) || [];
    return `<div class="row ${sel ? 'selected' : ''}" data-key="${esc(k)}" role="option" aria-selected="${sel}" tabindex="0" aria-label="${esc(r.id)}, ${m.label}">
      <button class="checkbox" tabindex="-1" aria-hidden="true" data-check>${icon('check')}</button>
      <div class="name-cell"><span class="card-name">${esc(r.name)}</span><span class="card-id">${esc(r.id)}</span></div>
      <span class="cell"><span class="type-badge type-${r.type}">${icon(m.icon)}${m.label}</span></span>
      <span class="cell vis-badge ${r.private ? 'private' : ''}" style="margin:0">${icon(r.private ? 'lock' : 'globe')}${r.private ? 'Private' : 'Public'}</span>
      <span class="cell" title="${esc(fmtDate(r.lastModified))}">${esc(relTime(r.lastModified))}</span>
      <span class="cell col-dl">${r.downloads != null ? fmtNum(r.downloads) : '—'}</span>
      <span class="cell col-likes">${r.likes != null ? fmtNum(r.likes) : '—'}</span>
      <div class="chips">${cols.map((c) => chipHtml(c, r, false)).join('') || '<span class="chip empty">—</span>'}</div>
      <button class="icon-btn tiny card-info" style="opacity:1" data-info aria-label="Details for ${esc(r.name)}">${icon('info')}</button>
    </div>`;
  }

  function skeletonHtml(n = 12) {
    return Array.from({ length: n }, () => `<div class="card skeleton"><div class="sk" style="width:40%"></div><div class="sk" style="width:70%;height:14px"></div><div class="sk" style="width:55%"></div><div class="sk" style="width:35%"></div><div class="sk" style="width:60%"></div></div>`).join('');
  }

  function renderMain() {
    const grid = $('#repo-grid');
    const state = $('#repo-state');
    const meta = viewMeta();
    $('#view-title').textContent = meta.title;
    $('#view-desc').textContent = meta.desc || '';
    $('#btn-view-menu').hidden = !meta.col;
    $('#membership-toggle').hidden = !meta.col || !!meta.col.deleted;
    $$('#membership-toggle button').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.value === 'out') === !!S.view.invert)));
    renderCollectionFilter();
    grid.classList.toggle('list', S.layout === 'list');

    if (S.loading) {
      grid.innerHTML = skeletonHtml();
      state.hidden = true;
      $('#view-count').textContent = '…';
      return;
    }
    if (S.loadError) {
      grid.innerHTML = '';
      state.hidden = false;
      state.className = 'state error';
      state.innerHTML = `<div class="state-icon">${icon('wifi-off')}</div><h2>Couldn’t load repositories</h2><p>${esc(S.loadError)}</p><div style="display:flex;gap:8px"><button class="btn btn-primary" data-act="retry-load">Try again</button><button class="btn" data-act="account">Connection settings</button></div>`;
      $('#view-count').textContent = '0';
      return;
    }

    S.visible = computeVisible().map((r) => repoKey(r.type, r.id));
    // Drop selections that are no longer visible so bulk actions respect filters.
    for (const k of [...S.selection]) if (!S.visible.includes(k)) S.selection.delete(k);
    $('#view-count').textContent = S.visible.length;

    if (!S.visible.length) {
      grid.innerHTML = '';
      state.hidden = false;
      const filtered = S.q || S.localQ || S.type !== 'all' || S.vis !== 'all' || S.colFilter !== 'any';
      if (filtered) {
        state.className = 'state';
        state.innerHTML = `<div class="state-icon">${icon('search-x')}</div><h2>No matching repositories</h2><p>Try a different search or clear the filters.</p><button class="btn" data-act="clear-filters">Clear filters</button>`;
      } else if (S.view.kind === 'uncategorized' && S.repos.length) {
        state.className = 'state success';
        state.innerHTML = `<div class="state-icon">${icon('party-popper')}</div><h2>Everything is organized!</h2><p>All your repositories belong to at least one collection.</p>`;
      } else if (S.view.kind === 'collection' && S.view.invert && S.repos.length) {
        state.className = 'state success';
        state.innerHTML = `<div class="state-icon">${icon('check-circle-2')}</div><h2>Everything is already in “${esc(meta.col?.title || '')}”</h2><p>There are no repositories left to add to this collection.</p>`;
      } else if (S.view.kind === 'collection') {
        state.className = 'state';
        state.innerHTML = `<div class="state-icon">${icon('folder-open')}</div><h2>This collection is empty</h2><p>Drag repositories onto it in the sidebar, or select some and use “Add to Collection”.</p><button class="btn" data-act="go-uncategorized">Browse uncategorized</button>`;
      } else {
        state.className = 'state';
        state.innerHTML = `<div class="state-icon">${icon('inbox')}</div><h2>No repositories here</h2><p>${S.repos.length ? 'Nothing matches this view.' : `No repositories were found for “${esc(S.owner || '')}”.`}</p>`;
      }
    } else {
      state.hidden = true;
      const items = S.visible.map((k) => S.repoByKey.get(k));
      grid.innerHTML = S.layout === 'list'
        ? `<div class="row row-head" aria-hidden="true"><span></span><span>Repository</span><span class="cell">Type</span><span class="cell">Visibility</span><span class="cell">Updated</span><span class="cell col-dl">Downloads</span><span class="cell col-likes">Likes</span><span>Collections</span><span></span></div>${items.map(rowHtml).join('')}`
        : items.map(cardHtml).join('');
    }
    renderBulkBar();
  }

  function renderSelection() {
    $$('#repo-grid [data-key]').forEach((el) => {
      const on = S.selection.has(el.dataset.key);
      el.classList.toggle('selected', on);
      el.setAttribute('aria-selected', on);
    });
    renderBulkBar();
  }

  function renderBulkBar() {
    const n = S.selection.size;
    $('#bulk-bar').hidden = n === 0;
    $('#bulk-count').textContent = n;
    $('#bulk-remove').hidden = !S.working.some((c) => !c.deleted);
    const target = invertedTarget();
    $('#bulk-add span:last-child').textContent = target ? `Add to “${target.title}”` : 'Add to Collection';
  }

  /** In a collection's "Not in collection" view, the collection that bulk/menu adds go straight to. */
  function invertedTarget() {
    if (S.view.kind !== 'collection' || !S.view.invert) return null;
    const col = colByKey(S.view.key);
    return col && !col.deleted ? col : null;
  }

  // -------------------------------------------------------------------
  // Details panel
  // -------------------------------------------------------------------
  function renderDetails() {
    const el = $('#details');
    const r = S.detailsKey && S.repoByKey.get(S.detailsKey);
    if (!r) { el.hidden = true; el.innerHTML = ''; return; }
    const k = repoKey(r.type, r.id);
    const m = TYPE_META[r.type];
    const mine = new Set(S.memberOf.get(k) || []);
    el.hidden = false;
    el.innerHTML = `
      <div class="details-head">
        <div style="flex:1;min-width:0">
          <span class="type-badge type-${r.type}">${icon(m.icon)}${m.label}</span>
          <h2>${esc(r.name)}</h2>
          <div class="card-id" style="margin:0">${esc(r.id)}</div>
        </div>
        <button class="icon-btn" data-act="close-details" aria-label="Close details">${icon('x')}</button>
      </div>
      <div class="details-body">
        ${r.demo ? `<div class="callout warn" style="margin:0">${icon('flask-conical')}<span>Fictional demo repository — it does not exist on Hugging Face.</span></div>` : ''}
        <div class="details-section">
          <h3>Description</h3>
          <p style="margin:0;color:${r.description ? 'var(--text)' : 'var(--text-3)'}">${esc(r.description || 'No description available from the Hub listing.')}</p>
        </div>
        <div class="details-section">
          <h3>Overview</h3>
          <dl class="kv">
            <dt>Type</dt><dd>${m.label}${r.pipelineTag ? ` · ${esc(r.pipelineTag)}` : ''}${r.sdk ? ` · ${esc(r.sdk)}` : ''}</dd>
            <dt>Visibility</dt><dd>${r.private ? `${icon('lock')} Private` : `${icon('globe')} Public`}${r.gated ? ' · Gated' : ''}</dd>
            <dt>Last updated</dt><dd title="${esc(r.lastModified || '')}">${esc(fmtDate(r.lastModified))}<br><span class="muted">${esc(relTime(r.lastModified))}</span></dd>
            <dt>Downloads</dt><dd>${r.downloads != null ? r.downloads.toLocaleString() : '—'}</dd>
            <dt>Likes</dt><dd>${r.likes != null ? r.likes.toLocaleString() : '—'}</dd>
            ${r.library ? `<dt>Library</dt><dd>${esc(r.library)}</dd>` : ''}
            <dt>Link</dt><dd><a href="${esc(repoUrl(r))}" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">${esc(repoUrl(r).replace('https://', ''))}</a></dd>
          </dl>
        </div>
        ${(r.tags || []).length ? `<div class="details-section"><h3>Tags</h3><div class="tags">${r.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>` : ''}
        <div class="details-section">
          <h3>Collections</h3>
          <div class="member-list">
            ${S.working.filter((c) => !c.deleted).map((c) => {
              const base = colByKey(c.key, S.baseline);
              const was = !!base && itemIndex(base, r.type, r.id) >= 0;
              const is = mine.has(c.key);
              return `<label class="member-row"><input type="checkbox" data-member="${esc(c.key)}" ${is ? 'checked' : ''}><span>${esc(c.title)}</span>${was !== is ? `<span class="staged">${is ? 'staged add' : 'staged removal'}</span>` : ''}</label>`;
            }).join('') || '<p class="muted" style="margin:0">No collections yet.</p>'}
          </div>
          <button class="btn btn-sm" style="margin-top:8px" data-act="new-collection-for-detail">${icon('plus')}New collection with this repo</button>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm" data-act="open-hf">${icon('external-link')}Open on Hugging Face</button>
          <button class="btn btn-sm" data-act="copy-url">${icon('link')}Copy URL</button>
        </div>
      </div>`;
  }

  function openDetails(key) {
    S.detailsKey = key;
    renderDetails();
    $('#details button')?.focus();
  }

  // -------------------------------------------------------------------
  // Toasts
  // -------------------------------------------------------------------
  function toast(message, kind = 'info', { action, onAction, timeout = 4500 } = {}) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const ic = { success: 'check-circle-2', error: 'alert-circle', warning: 'alert-triangle', info: 'info' }[kind] || 'info';
    el.innerHTML = `<span class="t-icon">${icon(ic)}</span><span class="t-msg">${esc(message)}</span>${action ? `<button class="t-action">${esc(action)}</button>` : ''}<button class="icon-btn tiny" aria-label="Dismiss">${icon('x')}</button>`;
    const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
    el.querySelector('.icon-btn').onclick = close;
    if (action) el.querySelector('.t-action').onclick = () => { close(); onAction(); };
    $('#toasts').appendChild(el);
    while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
    if (timeout) setTimeout(close, kind === 'error' ? timeout * 2 : timeout);
  }

  // -------------------------------------------------------------------
  // Modals
  // -------------------------------------------------------------------
  const modalStack = [];
  function openModal({ title, desc = '', body = '', foot = '', wide = false, onClose, dismissable = true }) {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="m-title-${modalStack.length}">
      <div class="modal-head"><div><h2 id="m-title-${modalStack.length}">${title}</h2>${desc ? `<p>${desc}</p>` : ''}</div>${dismissable ? `<button class="icon-btn" data-close aria-label="Close">${icon('x')}</button>` : ''}</div>
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
    </div>`;
    const prevFocus = document.activeElement;
    const m = {
      el: back.firstElementChild,
      dismissable,
      close(result) {
        if (m.closed) return;
        m.closed = true;
        back.remove();
        modalStack.splice(modalStack.indexOf(m), 1);
        onClose && onClose(result);
        prevFocus && prevFocus.focus && prevFocus.focus();
      },
      setBody(html) { $('.modal-body', back).innerHTML = html; },
      setFoot(html) {
        let f = $('.modal-foot', back);
        if (!f) { f = document.createElement('div'); f.className = 'modal-foot'; back.firstElementChild.appendChild(f); }
        f.innerHTML = html;
      },
    };
    back.addEventListener('mousedown', (e) => { if (e.target === back && m.dismissable) m.close(); });
    back.addEventListener('click', (e) => { if (e.target.closest('[data-close]') && m.dismissable) m.close(); });
    back.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = $$('button:not([disabled]), input:not([disabled]), textarea, select, a[href], [tabindex="0"]', back).filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });
    $('#modal-root').appendChild(back);
    modalStack.push(m);
    setTimeout(() => ($('[autofocus]', back) || $('input, textarea, .btn-primary, button', $('.modal-body', back)) || $('.btn-primary', back) || $('button', back))?.focus(), 0);
    return m;
  }

  function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      let result = false;
      const m = openModal({
        title: esc(title),
        body: `<p style="margin:0;color:var(--text-2)">${esc(message)}</p>`,
        foot: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok autofocus>${esc(confirmLabel)}</button>`,
        onClose: () => resolve(result),
      });
      $('[data-ok]', m.el.parentElement).onclick = () => { result = true; m.close(); };
    });
  }

  /** Create / edit collection form. Resolves with fields or null. */
  function collectionForm({ heading, fields = {}, submitLabel, extraNote = '' }) {
    return new Promise((resolve) => {
      let result = null;
      const m = openModal({
        title: esc(heading),
        desc: extraNote,
        body: `
          <form id="col-form" novalidate>
            <div class="field"><label for="cf-title">Title</label><input type="text" id="cf-title" maxlength="200" required value="${esc(fields.title || '')}" placeholder="e.g. Computer Vision" autofocus><span class="hint error" id="cf-title-err" hidden>A title is required.</span></div>
            <div class="field"><label for="cf-desc">Description <span class="muted">(optional)</span></label><textarea id="cf-desc" maxlength="${DESC_MAX}" placeholder="What belongs in this collection?">${esc(fields.description || '')}</textarea><span class="hint"><span id="cf-count">0</span>/${DESC_MAX} characters — Hugging Face limits descriptions to ${DESC_MAX}.</span></div>
            <label class="check-row"><input type="checkbox" id="cf-private" ${fields.private ? 'checked' : ''}><span>Private collection <span class="muted">— only visible to you on Hugging Face.</span></span></label>
          </form>`,
        foot: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-ok>${esc(submitLabel)}</button>`,
        onClose: () => resolve(result),
      });
      const root = m.el;
      const desc = $('#cf-desc', root);
      const count = () => { $('#cf-count', root).textContent = desc.value.length; };
      desc.addEventListener('input', count); count();
      const submit = () => {
        const title = $('#cf-title', root).value.trim();
        if (!title) { $('#cf-title-err', root).hidden = false; $('#cf-title', root).focus(); return; }
        const dup = S.working.find((c) => !c.deleted && c.title.toLowerCase() === title.toLowerCase() && c.title !== fields.title);
        if (dup) { const e = $('#cf-title-err', root); e.textContent = 'You already have a collection with this title.'; e.hidden = false; return; }
        result = { title, description: desc.value.trim().slice(0, DESC_MAX), private: $('#cf-private', root).checked };
        m.close();
      };
      $('[data-ok]', root).onclick = submit;
      $('#col-form', root).addEventListener('submit', (e) => { e.preventDefault(); submit(); });
      $('#cf-title', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    });
  }

  async function newCollectionFlow(withKeys = []) {
    const fields = await collectionForm({
      heading: 'New collection',
      submitLabel: withKeys.length ? `Create & add ${withKeys.length}` : 'Create collection',
      extraNote: S.mode === 'demo' ? 'Demo mode — staged locally only.' : 'Staged locally. It is created on Hugging Face when you sync.',
    });
    if (!fields) return null;
    const key = createCollection(fields);
    if (withKeys.length) addToCollection(withKeys, key, { silent: true });
    toast(`Created “${fields.title}”${withKeys.length ? ` with ${plural(withKeys.length, 'repository', 'repositories')}` : ''} — staged for sync`, 'success', { action: 'Undo', onAction: undo });
    return key;
  }

  async function editCollectionFlow(colKey) {
    const col = colByKey(colKey);
    if (!col) return;
    const fields = await collectionForm({ heading: `Edit “${col.title}”`, fields: col, submitLabel: 'Save changes' });
    if (fields) updateCollection(colKey, fields);
  }

  /** Collection picker — also the touch-friendly alternative to drag-and-drop. */
  function pickCollection(keys, mode = 'add') {
    const n = keys.length;
    const cols = S.working.filter((c) => !c.deleted);
    const inCount = (c) => keys.filter((k) => { const r = S.repoByKey.get(k); return r && itemIndex(c, r.type, r.id) >= 0; }).length;
    const list = mode === 'remove' ? cols.filter((c) => inCount(c) > 0) : cols;
    const m = openModal({
      title: mode === 'add' ? `Add ${plural(n, 'repository', 'repositories')} to…` : `Remove ${plural(n, 'repository', 'repositories')} from…`,
      desc: mode === 'add' ? 'Repositories keep their existing collections — a repository can belong to several.' : 'Only the collection membership is removed; repositories are not affected.',
      body: `
        ${cols.length > 6 ? '<div class="field"><input type="text" id="pick-filter" placeholder="Filter collections…" aria-label="Filter collections"></div>' : ''}
        <div class="picker-list" role="listbox" aria-label="Collections">
          ${list.map((c) => {
            const k = inCount(c);
            const all = k === n;
            const disabled = mode === 'add' && all;
            const sub = mode === 'add' ? (all ? 'All already in this collection' : k ? `${k} of ${n} already in` : c.description || '') : `${k} of ${n} in this collection`;
            return `<button class="picker-item ${disabled ? 'disabled' : ''}" data-pick="${esc(c.key)}" data-title="${esc(c.title.toLowerCase())}" ${disabled ? 'aria-disabled="true"' : ''}>
              ${icon('folder')}<span class="grow"><span>${esc(c.title)}</span><br><span class="sub">${esc(sub)}</span></span>${all && mode === 'add' ? icon('check') : ''}</button>`;
          }).join('') || `<p class="muted" style="padding:0 6px">${mode === 'remove' ? 'None of the selected repositories are in a collection.' : 'No collections yet.'}</p>`}
          ${mode === 'add' ? `<button class="picker-item" data-pick-new>${icon('folder-plus')}<span class="grow"><span>New collection…</span><br><span class="sub">Create one and add ${plural(n, 'repository', 'repositories')}</span></span></button>` : ''}
        </div>`,
    });
    const root = m.el;
    const filter = $('#pick-filter', root);
    if (filter) filter.addEventListener('input', () => { const q = filter.value.toLowerCase(); $$('[data-pick]', root).forEach((b) => { b.hidden = !b.dataset.title.includes(q); }); });
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick], [data-pick-new]');
      if (!b || b.classList.contains('disabled')) return;
      m.close();
      if (b.hasAttribute('data-pick-new')) newCollectionFlow(keys);
      else if (mode === 'add') addToCollection(keys, b.dataset.pick);
      else removeFromCollection(keys, b.dataset.pick);
    });
  }

  // -------------------------------------------------------------------
  // Context menus
  // -------------------------------------------------------------------
  function showMenu(x, y, items) {
    const menu = $('#context-menu');
    menu.innerHTML = items.map((it, i) => {
      if (it === '-') return '<div class="menu-sep" role="separator"></div>';
      if (it.label && it.header) return `<div class="menu-label">${esc(it.label)}</div>`;
      return `<button class="menu-item ${it.danger ? 'danger' : ''}" role="menuitem" data-mi="${i}" ${it.disabled ? 'disabled' : ''} ${it.title ? `title="${esc(it.title)}"` : ''}>${icon(it.icon || 'dot')}<span>${esc(it.label)}</span>${it.kbd ? `<span class="kbd">${esc(it.kbd)}</span>` : ''}</button>`;
    }).join('');
    menu.hidden = false;
    const { innerWidth: W, innerHeight: H } = window;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, W - r.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, H - r.height - 8))}px`;
    menu.onclick = (e) => {
      const b = e.target.closest('[data-mi]');
      if (!b) return;
      hideMenu();
      items[+b.dataset.mi].run();
    };
    menu.onkeydown = (e) => {
      const btns = $$('.menu-item:not([disabled])', menu);
      const i = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
      if (e.key === 'Escape') { e.stopPropagation(); hideMenu(); }
    };
    $('.menu-item:not([disabled])', menu)?.focus();
  }
  function hideMenu() { $('#context-menu').hidden = true; }

  function repoMenu(x, y, key) {
    if (!S.selection.has(key)) { S.selection = new Set([key]); S.anchor = key; renderSelection(); }
    const keys = [...S.selection];
    const r = S.repoByKey.get(key);
    const n = keys.length;
    const inView = S.view.kind === 'collection' && !S.view.invert ? colByKey(S.view.key) : null;
    const target = invertedTarget();
    const items = [];
    if (n > 1) items.push({ header: true, label: `${n} repositories selected` });
    items.push({ icon: 'external-link', label: 'Open on Hugging Face', run: () => openOnHf(r), kbd: 'dbl-click' });
    items.push({ icon: 'info', label: 'Show details', run: () => openDetails(key) });
    items.push('-');
    if (target) items.push({ icon: 'folder-plus', label: `Add to “${target.title}”`, run: () => addToCollection(keys, target.key) });
    items.push({ icon: 'folder-plus', label: n > 1 ? `Add ${n} to Collection…` : 'Add to Collection…', run: () => pickCollection(keys, 'add') });
    if (inView && !inView.deleted) items.push({ icon: 'folder-minus', label: `Remove from “${inView.title}”`, run: () => removeFromCollection(keys, inView.key) });
    items.push({ icon: 'folder-minus', label: 'Remove from Collection…', disabled: !keys.some((k) => S.memberOf.has(k)), run: () => pickCollection(keys, 'remove') });
    items.push('-');
    items.push({ icon: 'link', label: n > 1 ? `Copy ${n} Repository URLs` : 'Copy Repository URL', run: () => copyUrls(keys) });
    items.push({ icon: 'check-square', label: 'Select all visible', kbd: isMac ? '⌘A' : 'Ctrl+A', run: selectAllVisible });
    showMenu(x, y, items);
  }

  function collectionMenu(x, y, colKey) {
    const col = colByKey(colKey);
    if (!col) return;
    const isNew = !colByKey(colKey, S.baseline);
    const items = [{ header: true, label: col.title }];
    if (col.deleted) {
      items.push({ icon: 'rotate-ccw', label: 'Restore collection', run: () => restoreCollection(colKey) });
    } else {
      items.push({ icon: 'pencil', label: 'Rename / edit description…', run: () => editCollectionFlow(colKey) });
      items.push({ icon: col.private ? 'globe' : 'lock', label: col.private ? 'Make public' : 'Make private', run: () => updateCollection(colKey, { private: !col.private }) });
      if (!isNew && S.mode === 'connected') {
        items.push({ icon: 'external-link', label: 'Open on Hugging Face', run: () => window.open(collectionUrl(col.slug), '_blank', 'noopener') });
        items.push({ icon: 'link', label: 'Copy collection URL', run: () => copyText(collectionUrl(col.slug)) });
      }
      items.push('-');
      items.push({ icon: 'trash-2', label: isNew ? 'Discard collection' : 'Delete collection…', danger: true, run: () => deleteCollection(colKey) });
    }
    showMenu(x, y, items);
  }

  // -------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------
  function handleSelectClick(key, e) {
    const additive = e.metaKey || e.ctrlKey;
    if (e.shiftKey && S.anchor && S.visible.includes(S.anchor)) {
      const a = S.visible.indexOf(S.anchor);
      const b = S.visible.indexOf(key);
      const range = S.visible.slice(Math.min(a, b), Math.max(a, b) + 1);
      if (!additive) S.selection = new Set();
      range.forEach((k) => S.selection.add(k));
    } else if (additive || e.forceToggle) {
      S.selection.has(key) ? S.selection.delete(key) : S.selection.add(key);
      S.anchor = key;
    } else {
      S.selection = S.selection.size === 1 && S.selection.has(key) ? new Set() : new Set([key]);
      S.anchor = key;
    }
    renderSelection();
  }
  function selectAllVisible() {
    S.selection = new Set(S.visible);
    renderSelection();
    if (S.visible.length) toast(`Selected ${plural(S.visible.length, 'visible repository', 'visible repositories')}`, 'info', { timeout: 2000 });
  }
  function clearSelection() { S.selection.clear(); renderSelection(); }

  // -------------------------------------------------------------------
  // Misc actions
  // -------------------------------------------------------------------
  function openOnHf(r) {
    if (r.demo) { toast('This is a fictional demo repository, so there is nothing to open on Hugging Face.', 'info'); return; }
    window.open(repoUrl(r), '_blank', 'noopener,noreferrer');
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'success', { timeout: 2000 }); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copied to clipboard', 'success', { timeout: 2000 }); } catch { toast('Could not access the clipboard', 'error'); }
      ta.remove();
    }
  }
  function copyUrls(keys) {
    const urls = keys.map((k) => S.repoByKey.get(k)).filter(Boolean).map(repoUrl);
    copyText(urls.join('\n'));
    if (keys.some((k) => S.repoByKey.get(k)?.demo)) toast('Note: demo repositories are fictional', 'info', { timeout: 2500 });
  }

  function setView(v) {
    S.view = v;
    S.selection.clear();
    S.localQ = '';
    $('#local-search').value = '';
    closeDrawer();
    renderSidebar();
    renderMain();
    $('.repo-area').scrollTop = 0;
  }

  // -------------------------------------------------------------------
  // Drag and drop (SortableJS source → sidebar collection targets)
  // -------------------------------------------------------------------
  let sortable = null;
  function setupDragAndDrop() {
    const grid = $('#repo-grid');
    const fine = window.matchMedia('(pointer: fine)');
    const init = () => {
      if (sortable) { sortable.destroy(); sortable = null; }
      if (!window.Sortable || !fine.matches) return; // touch: use the collection picker instead
      sortable = window.Sortable.create(grid, {
        group: { name: 'repos', pull: 'clone', put: false },
        sort: false,
        draggable: '.card:not(.skeleton), .row:not(.row-head)',
        filter: 'button, a, input',
        preventOnFilter: false,
        forceFallback: false,
        animation: 0,
        setData(dt, dragEl) {
          const key = dragEl.dataset.key;
          if (!S.selection.has(key)) { S.selection = new Set([key]); S.anchor = key; renderSelection(); }
          const keys = [...S.selection];
          S.drag = { keys };
          const ghost = $('#drag-ghost');
          const first = S.repoByKey.get(keys[0]);
          ghost.innerHTML = `${icon('folder-input')}<span>${keys.length === 1 ? esc(first.name) : 'Repositories'}</span><span class="n">${keys.length}</span>`;
          dt.setData('text/plain', keys.map((k) => S.repoByKey.get(k).id).join('\n'));
          dt.effectAllowed = 'copy';
          try { dt.setDragImage(ghost, 16, 16); } catch { /* older browsers */ }
        },
        onStart() {
          document.body.classList.add('dragging');
          (S.drag?.keys || []).forEach((k) => $(`#repo-grid [data-key="${CSS.escape(k)}"]`)?.classList.add('drag-source'));
        },
        onEnd() {
          document.body.classList.remove('dragging');
          $$('.drag-source').forEach((el) => el.classList.remove('drag-source'));
          $$('.drop-over').forEach((el) => el.classList.remove('drop-over'));
          const drag = S.drag;
          S.drag = null;
          if (drag && drag.dropCol) setTimeout(() => addToCollection(drag.keys, drag.dropCol), 0);
        },
      });
    };
    init();
    fine.addEventListener?.('change', init);

    const nav = $('#nav-collections');
    const target = (e) => {
      const el = e.target.closest('.nav-collection');
      return el && !el.classList.contains('is-deleted') ? el : null;
    };
    nav.addEventListener('dragenter', (e) => { const t = target(e); if (t && S.drag) { e.preventDefault(); t.classList.add('drop-over'); } });
    nav.addEventListener('dragover', (e) => {
      const t = target(e);
      if (t && S.drag) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        $$('.drop-over', nav).forEach((x) => x !== t && x.classList.remove('drop-over'));
        t.classList.add('drop-over');
      }
    });
    nav.addEventListener('dragleave', (e) => { const t = target(e); if (t && !t.contains(e.relatedTarget)) t.classList.remove('drop-over'); });
    nav.addEventListener('drop', (e) => {
      const t = target(e);
      if (!t || !S.drag) return;
      e.preventDefault();
      e.stopPropagation();
      t.classList.remove('drop-over');
      // Apply after SortableJS has finished its own drop handling (onEnd),
      // so re-rendering the grid cannot interfere with the drag teardown.
      S.drag.dropCol = t.dataset.col;
    });
  }

  // -------------------------------------------------------------------
  // Loading data
  // -------------------------------------------------------------------
  function setRepos(repos) {
    S.repos = repos;
    S.repoByKey = new Map(repos.map((r) => [repoKey(r.type, r.id), r]));
  }
  function fromRemoteCollection(c) {
    return { key: c.slug, slug: c.slug, title: c.title, description: c.description || '', private: !!c.private, lastUpdated: c.lastUpdated, theme: c.theme, items: c.items.map((it) => ({ type: it.type, id: it.id, objectId: it.objectId, note: it.note, title: it.title })) };
  }

  function startDemo({ reset = false } = {}) {
    S.mode = 'demo';
    S.owner = S.status?.owner || DEMO_OWNER;
    S.loadError = null;
    S.repoErrors = [];
    let saved = reset ? null : safeStorage.get('hforg:draft:demo');
    // Regenerate the demo if its data was built for a different username.
    if (saved && (!Array.isArray(saved.baseline) || !Array.isArray(saved.repos) || saved.owner !== S.owner)) saved = null;
    if (saved) {
      setRepos(saved.repos);
      S.baseline = saved.baseline;
    } else {
      const demo = buildDemo(S.owner);
      setRepos(demo.repos);
      S.baseline = demo.collections;
    }
    S.working = applyOps(clone(S.baseline), saved?.ops || []);
    S.undo = [];
    S.loading = false;
    S.selection.clear();
    if (S.view.kind === 'collection' && !colByKey(S.view.key)) S.view = { kind: 'all' };
    recompute();
    if (reset) safeStorage.del('hforg:draft:demo');
    persistDraft();
    renderAll();
    if (saved?.ops?.length) toast(`Restored ${plural(saved.ops.length, 'staged demo change')}`, 'info');
  }

  async function loadConnected({ initial = false } = {}) {
    const keepOps = initial ? (safeStorage.get(draftKey())?.ops || []) : computePlan();
    if (initial) { S.loading = true; renderAll(); }
    S.refreshing = true;
    $('#btn-refresh').classList.add('spinning');
    try {
      const [reposRes, colsRes] = await Promise.all([
        api(S.owner ? `/api/repos?author=${encodeURIComponent(S.owner)}` : '/api/repos'),
        api('/api/collections'),
      ]);
      setRepos(reposRes.repos);
      S.repoErrors = reposRes.errors || [];
      S.baseline = colsRes.collections.map(fromRemoteCollection);
      S.working = applyOps(clone(S.baseline), keepOps);
      S.loadError = null;
      if (S.view.kind === 'collection' && !colByKey(S.view.key)) S.view = { kind: 'all' };
      recompute();
      const remaining = computePlan().length;
      if (initial && remaining) toast(`Restored ${plural(remaining, 'unsynced change')} from your last session`, 'info', { timeout: 6000 });
      else if (!initial) toast(remaining ? `Refreshed from Hugging Face — ${plural(remaining, 'staged change')} kept` : 'Refreshed from Hugging Face', 'success', { timeout: 2500 });
      persistDraft();
      S.undo = [];
    } catch (err) {
      if (initial || !S.repos.length) S.loadError = err.message;
      toast(err.message, 'error');
      if (err.status === 401) await refreshStatus();
    } finally {
      S.loading = false;
      S.refreshing = false;
      $('#btn-refresh').classList.remove('spinning');
      renderAll();
    }
  }

  async function refreshStatus() {
    try { S.status = await api('/api/status'); S.backend = true; }
    catch { S.status = null; S.backend = false; }
    return S.status;
  }

  async function boot() {
    const st = location.protocol === 'file:' ? null : await refreshStatus();
    if (st && st.connected) {
      S.owner = st.owner || st.user?.name || null;
      S.mode = 'connected';
      renderChrome();
      await loadConnected({ initial: true });
    } else {
      startDemo();
      if (st && st.error) toast(`Configured token could not be used: ${st.error.message}`, 'error');
      if (st && !st.connected && !safeStorage.get('hforg:skipConnect')) openConnectModal();
    }
  }

  function renderAll() {
    renderChrome();
    renderSidebar();
    renderSyncState();
    renderMain();
    renderDetails();
  }

  // -------------------------------------------------------------------
  // Connection screen / account
  // -------------------------------------------------------------------
  function permissionRows(p) {
    if (!p) return '';
    const row = (ok, label) => `<li>${ok === true ? `<span class="perm-ok">${icon('check-circle-2')}</span>` : ok === false ? `<span class="perm-no">${icon('x-circle')}</span>` : `<span class="perm-unk">${icon('help-circle')}</span>`}${esc(label)}${ok == null ? ' <span class="muted">(could not be determined)</span>' : ''}</li>`;
    return `<ul class="perm-list">${row(p.canReadPrivateRepos, 'Read your repositories (including private)')}${row(p.canWriteCollections, 'Write collections (create, edit, add/remove items, delete)')}</ul>
      <p class="muted" style="font-size:12px;margin:6px 0 0">Token type: ${esc(p.role)}. Permission detection is best-effort; the Hub has the final say and errors are reported per operation.</p>`;
  }

  function openConnectModal() {
    if (!S.backend) {
      openModal({
        title: 'Connect to Hugging Face',
        body: `<div class="callout warn">${icon('server-off')}<div>The local HF Organizer server is not running, so the app is in demo mode. Tokens are only ever handled by that local server — never by this page directly.</div></div>
          <ol class="connect-steps"><li>Install dependencies: <code>npm install</code></li><li>Start the server: <code>npm start</code></li><li>Open <code>http://localhost:5173</code></li></ol>`,
        foot: '<button class="btn btn-primary" data-close>Continue in demo mode</button>',
      });
      return;
    }
    const st = S.status;
    if (st?.connected) return openAccountModal();
    const m = openModal({
      title: 'Connect to Hugging Face',
      desc: S.status?.owner ? `Import <strong>${esc(S.status.owner)}</strong>’s repositories and your real Hugging Face Collections.` : 'Import your repositories and your real Hugging Face Collections.',
      wide: true,
      body: `
        <ol class="connect-steps">
          <li>Open <a href="https://huggingface.co/settings/tokens/new?tokenType=fineGrained" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">huggingface.co/settings/tokens</a> and create a <strong>fine-grained</strong> token.</li>
          <li>Under <em>User permissions</em> enable <strong>Collections → Write access to all collections</strong> and <strong>Repositories → Read access to contents of all repos</strong> (for private repositories).</li>
          <li>Paste it below. For a permanent setup, put it in <code>.env</code> as <code>HF_TOKEN</code> instead.</li>
        </ol>
        <form id="connect-form" novalidate>
          <div class="field"><label for="token">Access token</label>
            <input type="password" id="token" autocomplete="off" spellcheck="false" placeholder="hf_…" autofocus>
            <span class="hint">${icon('shield-check')} Sent only to this local server (<code>${esc(location.host)}</code>) and kept in its memory. It is never stored in the browser, logged, or returned to the page.</span>
          </div>
          <div id="connect-error"></div>
        </form>`,
      foot: `<label class="check-row grow"><input type="checkbox" id="skip-connect">Don’t show on startup</label><button class="btn" data-demo>Use demo mode</button><button class="btn btn-primary" data-ok>Connect</button>`,
    });
    const root = m.el;
    const submit = async () => {
      const token = $('#token', root).value.trim();
      const errBox = $('#connect-error', root);
      if (!token) { errBox.innerHTML = `<div class="callout err">${icon('alert-circle')}<span>Paste a token first.</span></div>`; return; }
      const btn = $('[data-ok]', root);
      btn.disabled = true; btn.textContent = 'Connecting…';
      try {
        const st2 = await api('/api/connect', { method: 'POST', body: { token } });
        $('#token', root).value = '';
        S.status = st2;
        S.owner = st2.owner || st2.user?.name || null;
        m.close();
        await switchToConnected();
        toast(`Connected as ${st2.user.name}`, 'success');
      } catch (err) {
        errBox.innerHTML = `<div class="callout err">${icon('alert-circle')}<span>${esc(err.message)}</span></div>`;
        btn.disabled = false; btn.textContent = 'Connect';
      }
    };
    $('[data-ok]', root).onclick = submit;
    $('#connect-form', root).addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    $('[data-demo]', root).onclick = () => { if ($('#skip-connect', root).checked) safeStorage.set('hforg:skipConnect', true); m.close(); };
    $('#skip-connect', root).onchange = (e) => { if (e.target.checked) safeStorage.set('hforg:skipConnect', true); else safeStorage.del('hforg:skipConnect'); };
  }

  async function switchToConnected() {
    S.mode = 'connected';
    S.view = { kind: 'all' };
    S.selection.clear();
    S.detailsKey = null;
    S.undo = [];
    S.baseline = []; S.working = []; setRepos([]);
    await loadConnected({ initial: true });
  }

  function openAccountModal() {
    const st = S.status;
    const connected = S.mode === 'connected' && st?.connected;
    const m = openModal({
      title: connected ? 'Hugging Face connection' : 'Demo mode',
      body: connected
        ? `<div class="callout ok">${icon('check-circle-2')}<div>Connected as <strong>${esc(st.user.name)}</strong>${st.user.fullname && st.user.fullname !== st.user.name ? ` (${esc(st.user.fullname)})` : ''}. Token source: ${st.tokenSource === 'env' ? '<code>HF_TOKEN</code> in <code>.env</code>' : 'this session (server memory)'}.</div></div>
           <p style="margin:0 0 4px"><strong>Repositories owner:</strong> ${esc(S.owner)} · <strong>Collections owner:</strong> ${esc(st.user.name)}</p>
           ${permissionRows(st.permissions)}
           ${(st.permissions?.notes || []).map((n) => `<div class="callout warn" style="margin-top:10px">${icon('alert-triangle')}<span>${esc(n)}</span></div>`).join('')}`
        : `<div class="callout warn">${icon('flask-conical')}<div>You are viewing <strong>fictional demo data</strong>. Changes stay in this browser and are never sent to Hugging Face.</div></div>`,
      foot: connected
        ? `${st.tokenSource === 'session' ? '<button class="btn" data-disconnect>Disconnect</button>' : ''}<button class="btn" data-demo>Switch to demo</button><button class="btn btn-primary" data-close>Done</button>`
        : `<button class="btn" data-close>Close</button>${S.backend ? '<button class="btn btn-primary" data-connect>Connect Hugging Face</button>' : ''}`,
    });
    const root = m.el;
    $('[data-connect]', root)?.addEventListener('click', async () => {
      m.close();
      await refreshStatus();
      if (S.status?.connected) await switchToConnected(); else openConnectModal();
    });
    $('[data-demo]', root)?.addEventListener('click', async () => {
      if (computePlan().length) toast('Your staged changes are saved and will be restored when you reconnect.', 'info');
      m.close(); S.view = { kind: 'all' }; S.detailsKey = null; startDemo();
    });
    $('[data-disconnect]', root)?.addEventListener('click', async () => {
      const pending = computePlan().length;
      if (pending && !(await confirmDialog({ title: 'Disconnect?', message: `You have ${plural(pending, 'unsynced change')}. They stay saved in this browser and come back when you reconnect with the same account.`, confirmLabel: 'Disconnect' }))) return;
      try { S.status = await api('/api/disconnect', { method: 'POST' }); } catch (err) { toast(err.message, 'error'); return; }
      m.close(); S.view = { kind: 'all' }; S.detailsKey = null; startDemo();
      toast('Disconnected. The token was removed from server memory.', 'success');
    });
  }

  // -------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------
  const OP_ORDER = { create: 0, update: 1, add: 2, remove: 3, delete: 4 };
  const OP_LABEL = { create: '+ Create', update: '~ Update', add: '+ Add', remove: '− Remove', delete: '× Delete' };

  function opText(op) {
    if (op.kind === 'create') return `${op.fields.title}${op.fields.private ? ' (private)' : ''}`;
    if (op.kind === 'update') {
      return Object.keys(op.fields).map((f) => f === 'private' ? (op.fields.private ? 'make private' : 'make public') : f === 'title' ? `title “${op.baseFields.title}” → “${op.fields.title}”` : 'description').join(', ');
    }
    if (op.kind === 'delete') return `${op.colTitle} (${plural(op.itemCount, 'item')})`;
    return `${op.item.type === 'model' ? '' : op.item.type + 's/'}${op.item.id}`;
  }

  function changeRow(op) {
    const st = op.status || 'ready';
    const statusHtml = {
      ready: '',
      noop: `${icon('check')}<span>already on Hub — skip</span>`,
      conflict: `${icon('alert-triangle')}<span>conflict — skipped</span>`,
      pending: `${icon('loader')}<span>queued</span>`,
      running: `${icon('loader-2')}<span>working…</span>`,
      ok: `${icon('check-circle-2')}<span>${op.note ? esc(op.note) : 'done'}</span>`,
      fail: `${icon('x-circle')}<span>failed</span>`,
      skipped: `${icon('minus-circle')}<span>skipped</span>`,
      held: `${icon('pause-circle')}<span>not confirmed</span>`,
    }[st];
    const msg = op.error || op.conflict;
    return `<li class="change ${st}" data-op="${esc(op.id)}"><span class="op ${op.kind}">${OP_LABEL[op.kind]}</span><span class="what" title="${esc(opText(op))}">${esc(opText(op))}${msg ? `<span class="err-msg">${esc(msg)}</span>` : ''}</span><span class="status">${statusHtml}</span></li>`;
  }

  function groupHtml(ops, notes) {
    const groups = new Map();
    for (const op of [...ops].sort((a, b) => OP_ORDER[a.kind] - OP_ORDER[b.kind])) {
      if (!groups.has(op.colKey)) groups.set(op.colKey, []);
      groups.get(op.colKey).push(op);
    }
    return [...groups.entries()].map(([k, list]) => {
      const col = colByKey(k) || colByKey(k, S.baseline);
      const note = notes?.get(k);
      return `<div class="change-group"><h4>${icon('folder')}${esc(col?.title || list[0].colTitle)} <span class="muted">· ${plural(list.length, 'change')}</span></h4>
        ${note ? `<div class="callout warn" style="margin-bottom:6px;padding:6px 10px">${icon('alert-triangle')}<span>${esc(note)}</span></div>` : ''}
        <ul class="change-list">${list.map(changeRow).join('')}</ul></div>`;
    }).join('');
  }

  /** Re-read each touched collection from the Hub and classify every op. */
  async function preflight(ops) {
    const notes = new Map();
    const slugs = [...new Set(ops.filter((o) => o.slug).map((o) => o.slug))];
    const fresh = new Map();
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(4, slugs.length) }, async () => {
      while (i < slugs.length) {
        const slug = slugs[i++];
        try { fresh.set(slug, (await api(`/api/collections/${slugPath(slug)}`)).collection); }
        catch (err) { fresh.set(slug, err.status === 404 ? { missing: true } : { error: err.message }); }
      }
    }));
    for (const op of ops) {
      op.status = 'ready'; op.conflict = null; op.error = null; op.note = null;
      if (!op.slug) continue;
      const f = fresh.get(op.slug);
      const base = colByKey(op.colKey, S.baseline);
      if (f.missing) { op.status = 'conflict'; op.conflict = 'This collection no longer exists on Hugging Face. Refresh to rebase your changes.'; continue; }
      if (f.error) { op.status = 'conflict'; op.conflict = `Could not verify remote state: ${f.error}`; continue; }
      const changed = base && f.lastUpdated !== base.lastUpdated;
      if (changed) notes.set(op.colKey, 'Changed on Hugging Face since you loaded it. Each change below was re-checked against the latest version.');
      const has = (it) => f.items.find((x) => x.type === it.type && x.id === it.id);
      if (op.kind === 'add' && has(op.item)) { op.status = 'noop'; }
      else if (op.kind === 'remove') {
        const remote = has(op.item);
        if (!remote) op.status = 'noop';
        else op.objectId = remote.objectId;
      } else if (op.kind === 'update') {
        const clashes = Object.keys(op.fields).filter((k) => {
          const remote = k === 'description' ? f[k] || '' : f[k];
          return remote !== op.baseFields[k] && remote !== op.fields[k];
        });
        if (clashes.length) { op.status = 'conflict'; op.conflict = `${clashes.join(' and ')} also changed on Hugging Face (now “${f[clashes[0]]}”). Refresh to review before overwriting.`; }
        else if (Object.keys(op.fields).every((k) => (k === 'description' ? f[k] || '' : f[k]) === op.fields[k])) op.status = 'noop';
      } else if (op.kind === 'delete' && changed) {
        op.status = 'conflict';
        op.conflict = 'Collection was modified on Hugging Face after you loaded it. Deletion blocked to protect those changes — refresh and review first.';
      }
    }
    return notes;
  }

  async function openSyncModal() {
    hideMenu();
    const ops = clone(computePlan());
    if (!ops.length) {
      openModal({
        title: 'Sync Changes to Hugging Face',
        body: `<div class="state success" style="padding:24px 0"><div class="state-icon">${icon('check-circle-2')}</div><h2>Everything is in sync</h2><p>There are no staged changes. Drag repositories onto collections, or use bulk actions, to stage some.</p></div>`,
        foot: '<button class="btn btn-primary" data-close>Close</button>',
      });
      return;
    }
    const demo = S.mode === 'demo';
    const deletes = ops.filter((o) => o.kind === 'delete');
    const m = openModal({
      title: 'Sync Changes to Hugging Face',
      desc: demo ? 'Demo mode — review only. Nothing will be sent to Hugging Face.' : `Review every change before it is applied to <strong>${esc(S.status?.user?.name || '')}</strong>’s collections.`,
      wide: true,
      body: `<div id="sync-body"></div>`,
      foot: '',
    });
    const root = m.el;
    const body = $('#sync-body', root);
    let notes = new Map();

    const renderReview = (checking) => {
      const ready = ops.filter((o) => o.status === 'ready' || !o.status);
      const noop = ops.filter((o) => o.status === 'noop').length;
      const conflicts = ops.filter((o) => o.status === 'conflict').length;
      body.innerHTML = `
        ${demo ? `<div class="callout warn">${icon('flask-conical')}<span><strong>Demo mode:</strong> “Apply in demo” only marks these changes as synced in this browser. No request is made to Hugging Face.</span></div>` : ''}
        ${checking ? `<div class="callout info">${icon('loader-2')}<span>Checking Hugging Face for remote changes and duplicates…</span></div>` : ''}
        ${conflicts ? `<div class="callout warn">${icon('alert-triangle')}<div><strong>${plural(conflicts, 'conflict')}</strong> detected. Conflicting changes will be skipped and kept staged. <button class="link-btn" data-rebase>Refresh from Hugging Face and rebase</button></div></div>` : ''}
        <div class="summary-row"><span><b>${ops.length}</b> pending</span>${!demo && !checking ? `<span><b>${ready.length}</b> to apply</span><span><b>${noop}</b> already on Hub</span><span><b>${conflicts}</b> conflicts</span>` : ''}</div>
        ${groupHtml(ops, notes)}
        ${deletes.length ? `<div class="callout err">${icon('trash-2')}<div><strong>${plural(deletes.length, 'collection')} will be permanently deleted:</strong> ${deletes.map((d) => esc(d.colTitle)).join(', ')}. Hugging Face cannot restore deleted collections.
          <label class="check-row" style="margin-top:6px"><input type="checkbox" id="confirm-delete">I understand — delete ${deletes.length === 1 ? 'this collection' : 'these collections'}.</label></div></div>` : ''}`;
      const runnable = ready.length;
      m.setFoot(`<span class="grow">${plural(ops.length, 'change')} pending${deletes.length ? ' · deletions need confirmation' : ''}</span><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-run ${checking || !runnable ? 'disabled' : ''}>${demo ? 'Apply in demo' : `Sync ${runnable ? plural(runnable, 'change') : 'changes'}`}</button>`);
      $('[data-run]', root)?.addEventListener('click', run);
      $('[data-rebase]', root)?.addEventListener('click', async () => { m.close(); await loadConnected(); openSyncModal(); });
      hydrateIcons(root);
    };

    const run = async () => {
      const confirmDel = !!$('#confirm-delete', root)?.checked;
      const runnable = ops.filter((o) => o.status === 'ready' && (o.kind !== 'delete' || confirmDel));
      if (!runnable.length) {
        toast('Tick the deletion confirmation, or undo the deletion, to continue.', 'warning'); return;
      }
      // Unconfirmed deletions are never executed; they stay staged.
      for (const op of ops) if (op.kind === 'delete' && op.status === 'ready' && !confirmDel) op.status = 'held';
      m.dismissable = false;
      if (demo) await runDemo(ops, body, m); else await runReal(ops, body, m);
      m.dismissable = true;
    };

    renderReview(!demo);
    if (!demo) {
      try { notes = await preflight(ops); }
      catch (err) { toast(`Pre-sync check failed: ${err.message}`, 'error'); }
      if (!m.closed) renderReview(false);
    } else {
      ops.forEach((o) => { o.status = 'ready'; });
      renderReview(false);
    }
  }

  function renderProgress(body, ops, done, total, title) {
    body.innerHTML = `<p style="margin:0 0 4px;font-weight:500">${esc(title)} <span class="muted">${done}/${total}</span></p>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><div style="width:${total ? (done / total) * 100 : 100}%"></div></div>
      ${groupHtml(ops)}`;
  }

  async function runDemo(ops, body, m) {
    const todo = ops.filter((o) => o.status === 'ready');
    const keyMap = new Map();
    m.setFoot('<span class="grow">Applying locally…</span>');
    for (let i = 0; i < todo.length; i++) {
      const op = todo[i];
      if (op.kind === 'create') keyMap.set(op.colKey, demoSlug(S.owner, op.fields.title));
      op.status = 'ok';
      op.note = 'applied locally (demo)';
      if (i % 4 === 0) { renderProgress(body, ops, i + 1, todo.length, 'Applying in demo (nothing is sent)'); await sleep(30); }
    }
    finishSync(ops, keyMap);
    const kept = ops.filter((o) => o.status !== 'ok').length;
    body.innerHTML = `<div class="callout ok">${icon('check-circle-2')}<span>Applied ${plural(todo.length, 'change')} to the demo data. <strong>Nothing was sent to Hugging Face.</strong>${kept ? ` ${plural(kept, 'change')} kept staged.` : ''}</span></div>${groupHtml(ops)}`;
    m.setFoot('<button class="btn btn-primary" data-close>Done</button>');
  }

  async function runReal(ops, body, m) {
    const todo = ops.filter((o) => o.status === 'ready').sort((a, b) => OP_ORDER[a.kind] - OP_ORDER[b.kind]);
    todo.forEach((o) => { o.status = 'pending'; });
    const total = todo.length;
    let done = 0;
    const keyMap = new Map();
    const failedCreates = new Set();
    const tick = () => { renderProgress(body, ops, done, total, 'Syncing to Hugging Face…'); hydrateIcons(body); };
    m.setFoot('<span class="grow">Please keep this window open while syncing.</span>');
    tick();

    const exec = async (op) => {
      op.status = 'running';
      try {
        if (op.kind === 'create') {
          const r = await api('/api/collections', { method: 'POST', body: op.fields });
          keyMap.set(op.colKey, r.collection.slug);
          op.note = 'created';
        } else if (op.kind === 'update') {
          await api(`/api/collections/${slugPath(op.slug)}`, { method: 'PATCH', body: op.fields });
        } else if (op.kind === 'add') {
          const slug = op.slug || keyMap.get(op.colKey);
          if (!slug) { op.status = 'skipped'; op.error = failedCreates.has(op.colKey) ? 'Collection was not created, so nothing could be added.' : 'Collection is not available.'; return; }
          try { await api(`/api/collections/${slugPath(slug)}/items`, { method: 'POST', body: op.item }); }
          catch (err) { if (err.status === 409) op.note = 'already present'; else throw err; }
        } else if (op.kind === 'remove') {
          if (!op.objectId) throw new Error('Missing item reference — refresh and try again.');
          try { await api(`/api/collections/${slugPath(op.slug)}/items/${encodeURIComponent(op.objectId)}`, { method: 'DELETE' }); }
          catch (err) { if (err.status === 404) op.note = 'already removed'; else throw err; }
        } else if (op.kind === 'delete') {
          await api(`/api/collections/${slugPath(op.slug)}`, { method: 'DELETE' });
          op.note = 'deleted';
        }
        op.status = 'ok';
      } catch (err) {
        op.status = 'fail';
        op.error = err.message;
        if (op.kind === 'create') failedCreates.add(op.colKey);
      } finally {
        done++;
        tick();
      }
    };

    // Phases run in order; items within the add/remove phases run with a small concurrency.
    for (const kind of ['create', 'update', 'add', 'remove', 'delete']) {
      const batch = todo.filter((o) => o.kind === kind);
      const conc = kind === 'add' || kind === 'remove' ? 3 : 1;
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(conc, batch.length) }, async () => { while (i < batch.length) await exec(batch[i++]); }));
    }

    const ok = ops.filter((o) => o.status === 'ok');
    const failed = ops.filter((o) => o.status === 'fail' || o.status === 'skipped');
    const kept = ops.filter((o) => ['conflict', 'held'].includes(o.status));
    const noop = ops.filter((o) => o.status === 'noop');

    body.innerHTML = `<div class="callout info">${icon('loader-2')}<span>Refreshing collections from Hugging Face…</span></div>`;
    let refreshError = null;
    try {
      const colsRes = await api('/api/collections');
      finishSync(ops, keyMap, colsRes.collections.map(fromRemoteCollection));
    } catch (err) {
      refreshError = err.message;
      finishSync(ops, keyMap);
    }

    body.innerHTML = `
      <div class="summary-row"><span style="color:var(--success)"><b>${ok.length}</b> succeeded</span><span style="color:var(--error)"><b>${failed.length}</b> failed</span><span><b>${noop.length}</b> already on Hub</span><span><b>${kept.length}</b> kept staged</span></div>
      ${failed.length ? `<div class="callout err">${icon('alert-circle')}<div><strong>${plural(failed.length, 'operation')} failed.</strong> They are preserved as staged changes so you can retry.</div></div>` : `<div class="callout ok">${icon('check-circle-2')}<span>All selected changes were applied to Hugging Face.</span></div>`}
      ${refreshError ? `<div class="callout warn">${icon('alert-triangle')}<span>Synced, but refreshing collections failed (${esc(refreshError)}). Use Refresh to reload.</span></div>` : ''}
      ${failed.length ? `<h4 style="margin:12px 0 6px">Failed</h4><ul class="change-list">${failed.map(changeRow).join('')}</ul>` : ''}
      ${ok.length ? `<h4 style="margin:12px 0 6px">Succeeded</h4><ul class="change-list">${ok.map(changeRow).join('')}</ul>` : ''}
      ${kept.length ? `<h4 style="margin:12px 0 6px">Kept staged</h4><ul class="change-list">${kept.map(changeRow).join('')}</ul>` : ''}`;
    m.setFoot(`${failed.length ? '<button class="btn" data-retry>Retry failed</button>' : ''}<button class="btn btn-primary" data-close>Done</button>`);
    $('[data-retry]', m.el)?.addEventListener('click', () => { m.close(); openSyncModal(); });
    toast(failed.length ? `Sync finished: ${ok.length} succeeded, ${failed.length} failed` : `Synced ${plural(ok.length, 'change')} to Hugging Face`, failed.length ? 'warning' : 'success');
  }

  /**
   * After a sync: adopt the new remote state as baseline and replay whatever
   * did not succeed (failed, skipped, conflicting, unconfirmed) on top of it.
   */
  function finishSync(ops, keyMap, freshBaseline) {
    const succeeded = ops.filter((o) => o.status === 'ok' || o.status === 'noop');
    const keep = ops.filter((o) => !(o.status === 'ok' || o.status === 'noop'));
    let baseline;
    if (freshBaseline) baseline = freshBaseline;
    else {
      // Best effort when the refresh fails: apply what succeeded to the old baseline.
      baseline = applyOps(clone(S.baseline), succeeded, keyMap).filter((c) => !c.deleted);
      baseline.forEach((c) => { if (!c.slug) { c.slug = c.key; } });
    }
    if (S.mode === 'demo') {
      baseline.forEach((c) => {
        c.lastUpdated = c.lastUpdated || new Date().toISOString();
        c.items.forEach((it) => { if (!it.objectId) it.objectId = fakeObjectId(); });
      });
    }
    S.baseline = baseline;
    // Keep collections that were created locally but never reached the Hub.
    S.working = applyOps(clone(baseline), keep, keyMap);
    if (S.view.kind === 'collection') {
      const mapped = keyMap.get(S.view.key);
      if (mapped) S.view = { ...S.view, key: mapped };
      else if (!colByKey(S.view.key)) S.view = { kind: 'all' };
    }
    const fi = S.colFilter.indexOf(':');
    if (fi > 0 && keyMap.has(S.colFilter.slice(fi + 1))) S.colFilter = `${S.colFilter.slice(0, fi)}:${keyMap.get(S.colFilter.slice(fi + 1))}`;
    S.undo = [];
    recompute();
    persistDraft();
    renderAll();
  }

  // -------------------------------------------------------------------
  // Theme & drawer
  // -------------------------------------------------------------------
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    $('#btn-theme').innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
    savePrefs();
  }
  function openDrawer() { $('#sidebar').classList.add('open'); $('#drawer-scrim').hidden = false; $('#btn-drawer').setAttribute('aria-expanded', 'true'); }
  function closeDrawer() { $('#sidebar').classList.remove('open'); $('#drawer-scrim').hidden = true; $('#btn-drawer').setAttribute('aria-expanded', 'false'); }

  // -------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------
  function wire() {
    const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
    $('#global-search').addEventListener('input', debounce((e) => { S.q = e.target.value.trim(); renderMain(); }, 120));
    $('#local-search').addEventListener('input', debounce((e) => { S.localQ = e.target.value.trim(); renderMain(); }, 120));
    $('#visibility-filter').addEventListener('change', (e) => { S.vis = e.target.value; renderMain(); });
    $('#collection-filter').addEventListener('change', (e) => { S.colFilter = e.target.value; renderMain(); });
    $('#membership-toggle').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b || S.view.kind !== 'collection') return;
      S.view = { ...S.view, invert: b.dataset.value === 'out' };
      S.selection.clear();
      renderMain();
    });
    $('#sort-select').value = S.sort;
    $('#sort-select').addEventListener('change', (e) => { S.sort = e.target.value; savePrefs(); renderMain(); });
    const seg = (id, apply) => $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b) return;
      $$('button', $(id)).forEach((x) => x.setAttribute('aria-checked', x === b));
      apply(b.dataset.value);
    });
    seg('#type-filter', (v) => { S.type = v; renderMain(); });
    seg('#layout-toggle', (v) => { S.layout = v; savePrefs(); renderMain(); });
    $$('#layout-toggle button').forEach((x) => x.setAttribute('aria-checked', x.dataset.value === S.layout));

    $('#btn-refresh').addEventListener('click', () => {
      if (S.mode === 'connected') loadConnected();
      else toast('Demo mode uses built-in sample data. Use “Reset demo” to start over.', 'info');
    });
    $('#btn-theme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    $('#btn-sync').addEventListener('click', openSyncModal);
    $('#btn-avatar').addEventListener('click', openAccountModal);
    $('#btn-new-collection').addEventListener('click', () => newCollectionFlow());
    $('#btn-new-collection-mini').addEventListener('click', () => newCollectionFlow());
    $('#btn-drawer').addEventListener('click', openDrawer);
    $('#drawer-scrim').addEventListener('click', closeDrawer);
    $('#btn-select-all').addEventListener('click', selectAllVisible);
    $('#btn-view-menu').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); collectionMenu(r.left, r.bottom + 4, S.view.key); });

    // Bulk bar
    $('#bulk-add').addEventListener('click', () => {
      const target = invertedTarget();
      if (target) addToCollection([...S.selection], target.key);
      else pickCollection([...S.selection], 'add');
    });
    $('#bulk-remove').addEventListener('click', () => {
      const keys = [...S.selection];
      const inView = S.view.kind === 'collection' && !S.view.invert && colByKey(S.view.key);
      if (inView && !inView.deleted) removeFromCollection(keys, inView.key);
      else pickCollection(keys, 'remove');
    });
    $('#bulk-select-all').addEventListener('click', selectAllVisible);
    $('#bulk-clear').addEventListener('click', clearSelection);

    // Sidebar navigation
    $('#nav-workspace').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) setView({ kind: b.dataset.view }); });
    const nav = $('#nav-collections');
    nav.addEventListener('click', (e) => {
      const more = e.target.closest('[data-col-menu]');
      if (more) { e.stopPropagation(); const r = more.getBoundingClientRect(); collectionMenu(r.right - 200, r.bottom + 4, more.dataset.colMenu); return; }
      const item = e.target.closest('[data-col]');
      if (item) setView({ kind: 'collection', key: item.dataset.col });
    });
    nav.addEventListener('keydown', (e) => {
      const item = e.target.closest('[data-col]');
      if (!item || e.target !== item) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView({ kind: 'collection', key: item.dataset.col }); }
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10') || e.key === 'F2') { e.preventDefault(); const r = item.getBoundingClientRect(); if (e.key === 'F2') editCollectionFlow(item.dataset.col); else collectionMenu(r.left + 20, r.bottom, item.dataset.col); }
      if (e.key === 'Delete') { e.preventDefault(); deleteCollection(item.dataset.col); }
    });
    nav.addEventListener('contextmenu', (e) => { const item = e.target.closest('[data-col]'); if (item) { e.preventDefault(); collectionMenu(e.clientX, e.clientY, item.dataset.col); } });

    // Grid interactions
    const grid = $('#repo-grid');
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('[data-key]');
      if (!card) { if (e.target === grid && !e.metaKey && !e.ctrlKey) clearSelection(); return; }
      const key = card.dataset.key;
      const chipRm = e.target.closest('[data-chip-remove]');
      if (chipRm) { removeFromCollection([key], chipRm.dataset.chipRemove); return; }
      if (e.target.closest('[data-info]')) { openDetails(key); return; }
      if (e.target.closest('[data-quick]')) { pickCollection(S.selection.has(key) ? [...S.selection] : [key], 'add'); return; }
      if (e.target.closest('[data-check]')) { handleSelectClick(key, { ...e, forceToggle: true, metaKey: true }); return; }
      handleSelectClick(key, e);
    });
    $('.repo-area').addEventListener('click', (e) => { if (e.target.classList.contains('repo-area')) clearSelection(); });
    grid.addEventListener('dblclick', (e) => {
      const card = e.target.closest('[data-key]');
      if (!card || e.target.closest('button')) return;
      openOnHf(S.repoByKey.get(card.dataset.key));
    });
    grid.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('[data-key]');
      if (!card) return;
      e.preventDefault();
      repoMenu(e.clientX, e.clientY, card.dataset.key);
    });
    grid.addEventListener('keydown', (e) => {
      const card = e.target.closest('[data-key]');
      if (!card || e.target !== card) return;
      const key = card.dataset.key;
      const idx = S.visible.indexOf(key);
      const cols = S.layout === 'list' ? 1 : Math.max(1, Math.round(grid.clientWidth / (card.offsetWidth + 12)));
      const move = (d) => {
        const next = S.visible[Math.max(0, Math.min(S.visible.length - 1, idx + d))];
        const el = $(`[data-key="${CSS.escape(next)}"]`, grid);
        if (!el) return;
        el.focus();
        if (e.shiftKey) handleSelectClick(next, { shiftKey: true });
      };
      if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); move(cols); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-cols); }
      else if (e.key === ' ') { e.preventDefault(); handleSelectClick(key, { metaKey: true }); }
      else if (e.key === 'Enter') { e.preventDefault(); if (e.metaKey || e.ctrlKey) openOnHf(S.repoByKey.get(key)); else openDetails(key); }
      else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = card.getBoundingClientRect(); repoMenu(r.left + 24, r.top + 24, key); }
    });

    // Details panel
    $('#details').addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const r = S.repoByKey.get(S.detailsKey);
      if (act === 'close-details') { S.detailsKey = null; renderDetails(); }
      else if (act === 'open-hf' && r) openOnHf(r);
      else if (act === 'copy-url' && r) copyUrls([S.detailsKey]);
      else if (act === 'new-collection-for-detail' && r) newCollectionFlow([S.detailsKey]);
    });
    $('#details').addEventListener('change', (e) => {
      const cb = e.target.closest('[data-member]');
      if (!cb) return;
      if (cb.checked) addToCollection([S.detailsKey], cb.dataset.member);
      else removeFromCollection([S.detailsKey], cb.dataset.member);
    });

    // Global action buttons rendered into banners / states
    document.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'connect') openConnectModal();
      else if (act === 'account') openAccountModal();
      else if (act === 'retry-load') loadConnected({ initial: true });
      else if (act === 'clear-filters') clearFilters();
      else if (act === 'go-uncategorized') setView({ kind: 'uncategorized' });
      else if (act === 'reset-demo') {
        confirmDialog({ title: 'Reset demo data?', message: 'This discards all demo changes in this browser and reloads the sample repositories.', confirmLabel: 'Reset demo', danger: true })
          .then((ok) => { if (ok) { S.view = { kind: 'all' }; S.detailsKey = null; startDemo({ reset: true }); toast('Demo data reset', 'success'); } });
      }
    });

    // Close context menu
    document.addEventListener('mousedown', (e) => { if (!e.target.closest('#context-menu')) hideMenu(); });
    window.addEventListener('blur', hideMenu);
    $('.repo-area').addEventListener('scroll', hideMenu, { passive: true });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        if (!$('#context-menu').hidden) { hideMenu(); return; }
        const top = modalStack[modalStack.length - 1];
        if (top) { if (top.dismissable) top.close(); return; }
        if ($('#sidebar').classList.contains('open')) { closeDrawer(); return; }
        if (typing && e.target.value) { e.target.value = ''; e.target.dispatchEvent(new Event('input')); return; }
        if (S.detailsKey) { S.detailsKey = null; renderDetails(); return; }
        if (S.selection.size) { clearSelection(); return; }
        if (typing) e.target.blur();
        return;
      }
      if (modalStack.length) return;
      if (e.key === '/' && !typing) { e.preventDefault(); $('#global-search').focus(); $('#global-search').select(); return; }
      if (mod && e.key.toLowerCase() === 'a' && !typing) { e.preventDefault(); selectAllVisible(); return; }
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey && !typing) { e.preventDefault(); undo(); return; }
    });

    window.addEventListener('beforeunload', (e) => {
      if (S.mode === 'connected' && computePlan().length) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function clearFilters() {
    S.q = ''; S.localQ = ''; S.type = 'all'; S.vis = 'all'; S.colFilter = 'any';
    $('#global-search').value = ''; $('#local-search').value = ''; $('#visibility-filter').value = 'all';
    $$('#type-filter button').forEach((b) => b.setAttribute('aria-checked', b.dataset.value === 'all'));
    renderMain();
  }

  // -------------------------------------------------------------------
  // Startup: load vendor fallbacks if a CDN was blocked, then boot.
  // -------------------------------------------------------------------
  function loadScript(src) {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = resolve;
      document.head.appendChild(s);
    });
  }

  async function start() {
    if (location.protocol !== 'file:') {
      const pending = [];
      if (!window.lucide) pending.push(loadScript('vendor/lucide.min.js'));
      if (!window.Sortable) pending.push(loadScript('vendor/Sortable.min.js'));
      await Promise.all(pending);
    }
    const prefs = safeStorage.get('hforg:prefs') || {};
    setTheme(prefs.theme === 'dark' ? 'dark' : 'light');
    hydrateIcons();
    wire();
    setupDragAndDrop();
    renderAll();
    if (!window.Sortable) toast('Drag-and-drop library failed to load — use “Add to Collection” instead.', 'warning');
    await boot();
  }

  // Expose a tiny surface for debugging/tests (no secrets live in the client).
  window.HFOrganizer = { state: S, computePlan, applyOps };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
