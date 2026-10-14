/**
 * Minimal in-memory imitation of the Hugging Face Hub endpoints used by
 * HF Organizer. Shapes follow huggingface_hub's client (Collection,
 * CollectionItem, Link-header pagination). Used by tests and for local UI
 * development: `node test/mock-hub.js` then `HF_ENDPOINT=http://127.0.0.1:7860`.
 */
'use strict';
const http = require('http');
const crypto = require('crypto');

const TOKEN = 'hf_mocktoken1234567890abcdefghij';
const USER = 'test-user';

function createMockHub({ models = 150 } = {}) {
  const oid = () => crypto.randomBytes(12).toString('hex');
  const repos = {
    model: Array.from({ length: models }, (_, i) => ({ id: `${USER}/model-${String(i).padStart(3, '0')}`, private: i % 7 === 0, downloads: i * 10, likes: i % 13, lastModified: new Date(Date.now() - i * 3600e3).toISOString(), tags: ['transformers'], pipeline_tag: 'text-generation' })),
    dataset: [{ id: `${USER}/speech-dataset`, private: false, downloads: 5, likes: 1, lastModified: new Date().toISOString(), tags: ['audio'], description: 'Speech' }],
    space: [{ id: `${USER}/demo-space`, private: false, likes: 3, lastModified: new Date().toISOString(), tags: [], sdk: 'gradio', cardData: { short_description: 'A demo' } }],
  };
  const collections = new Map();
  const mk = (title, items = [], extra = {}) => {
    const slug = `${USER}/${title.toLowerCase().replace(/\W+/g, '-')}-${oid()}`;
    collections.set(slug, { slug, title, description: '', owner: { name: USER, type: 'user' }, items: items.map((it, i) => ({ _id: oid(), position: i, ...it })), lastUpdated: new Date().toISOString(), position: collections.size, private: false, theme: 'indigo', upvotes: 0, ...extra });
    return slug;
  };
  mk('LLMs', [{ type: 'model', id: `${USER}/model-000` }, { type: 'model', id: `${USER}/model-001` }, { type: 'paper', id: '2305.18290' }], { description: 'Language models' });
  mk('Audio', [{ type: 'dataset', id: `${USER}/speech-dataset` }]);
  const log = [];

  const touch = (c) => { c.lastUpdated = new Date(Date.now() + log.length).toISOString(); };
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const authed = req.headers.authorization === `Bearer ${TOKEN}`;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      log.push(`${req.method} ${url.pathname}`);
      const p = url.pathname;
      if (p === '/api/whoami-v2') {
        if (!authed) return send(res, 401, { error: 'Invalid credentials in Authorization header' });
        return send(res, 200, { name: USER, fullname: 'Test User', avatarUrl: '/avatars/x.svg', type: 'user', orgs: [{ name: 'test-org' }], auth: { accessToken: { displayName: 'organizer', role: 'fineGrained', fineGrained: { scoped: [{ entity: { type: 'user', name: USER }, permissions: ['repo.content.read', 'collection.read', 'collection.write'] }] } } } });
      }
      const lm = p.match(/^\/api\/(models|datasets|spaces)$/);
      if (lm && req.method === 'GET') {
        const type = lm[1].slice(0, -1);
        const author = url.searchParams.get('author');
        const all = repos[type].filter((r) => (authed || !r.private) && (!author || r.id.startsWith(`${author}/`)));
        const limit = +url.searchParams.get('limit') || 1000;
        const offset = +url.searchParams.get('cursor') || 0;
        const page = all.slice(offset, offset + limit);
        const headers = {};
        if (offset + limit < all.length) {
          const next = new URL(req.url, `http://${req.headers.host}`);
          next.searchParams.set('cursor', offset + limit);
          headers.Link = `<${next.href}>; rel="next"`;
        }
        return send(res, 200, page, headers);
      }
      if (p === '/api/collections' && req.method === 'GET') {
        const owner = url.searchParams.get('owner');
        return send(res, 200, [...collections.values()].filter((c) => c.owner.name === owner && (authed || !c.private)).map((c) => ({ ...c, items: c.items.slice(0, 4) })));
      }
      if (p === '/api/collections' && req.method === 'POST') {
        if (!authed) return send(res, 401, { error: 'Unauthorized' });
        if (json.title === 'FAIL') return send(res, 400, { error: 'Mock failure' });
        const slug = mk(json.title, [], { description: json.description || '', private: !!json.private, owner: { name: json.namespace, type: 'user' } });
        return send(res, 200, collections.get(slug));
      }
      const cm = p.match(/^\/api\/collections\/([^/]+\/[^/]+)(?:\/items(?:\/([^/]+))?)?$/);
      if (cm) {
        const c = collections.get(cm[1]);
        if (!c) return send(res, 404, { error: 'Collection not found' });
        if (req.method !== 'GET' && !authed) return send(res, 401, { error: 'Unauthorized' });
        if (p.endsWith('/items') && req.method === 'POST') {
          if (json.item.id.endsWith('forbidden')) return send(res, 403, { error: 'You do not have write access' });
          if (c.items.some((it) => it.type === json.item.type && it.id === json.item.id)) return send(res, 409, { error: 'Item already in collection' });
          c.items.push({ _id: oid(), position: c.items.length, type: json.item.type, id: json.item.id }); touch(c);
          return send(res, 200, c);
        }
        if (cm[2] && req.method === 'DELETE') {
          const i = c.items.findIndex((it) => it._id === cm[2]);
          if (i < 0) return send(res, 404, { error: 'Item not found' });
          c.items.splice(i, 1); touch(c);
          return send(res, 200, {});
        }
        if (req.method === 'GET') return send(res, 200, c);
        if (req.method === 'PATCH') { Object.assign(c, json); touch(c); return send(res, 200, { success: true, data: c }); }
        if (req.method === 'DELETE') { collections.delete(cm[1]); return send(res, 200, {}); }
      }
      send(res, 404, { error: 'Not found' });
    });
  });
  return { server, collections, repos, log, TOKEN, USER, mk };
}

module.exports = { createMockHub, TOKEN };

if (require.main === module) {
  const port = +process.env.MOCK_PORT || 7860;
  createMockHub().server.listen(port, '127.0.0.1', () => console.log(`Mock Hub on http://127.0.0.1:${port} (token: ${TOKEN})`));
}
