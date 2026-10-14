'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createMockHub, TOKEN } = require('./mock-hub');

let hub, base, srv;
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

test.before(async () => {
  hub = createMockHub();
  const hubPort = await listen(hub.server);
  process.env.HF_ENDPOINT = `http://127.0.0.1:${hubPort}`;
  delete process.env.HF_TOKEN;
  ({ server: srv } = require('../server.js'));
  base = `http://127.0.0.1:${await listen(srv)}`;
});
test.after(() => { hub.server.close(); srv.close(); });

const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'X-HF-Organizer': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  assert.ok(!text.includes(TOKEN), `token leaked in response to ${method} ${path}`);
  return { status: res.status, data: JSON.parse(text || 'null') };
};

test('requires the CSRF header and same origin', async () => {
  const r = await fetch(base + '/api/status');
  assert.strictEqual(r.status, 403);
  const r2 = await fetch(base + '/api/status', { headers: { 'X-HF-Organizer': '1', Origin: 'https://evil.example' } });
  assert.strictEqual(r2.status, 403);
});

test('refuses non-local Host headers (DNS rebinding)', async () => {
  const http = require('http');
  const status = await new Promise((resolve) => {
    http.get(base + '/', { headers: { Host: 'attacker.example' } }, (res) => resolve(res.statusCode));
  });
  assert.strictEqual(status, 421);
});

test('status before connecting', async () => {
  const { data } = await call('/api/status');
  assert.strictEqual(data.connected, false);
  assert.strictEqual(data.owner, 'chomeed');
});

test('collections require a token', async () => {
  const { status } = await call('/api/collections');
  assert.strictEqual(status, 401);
});

test('rejects malformed and invalid tokens', async () => {
  assert.strictEqual((await call('/api/connect', { method: 'POST', body: { token: 'nope' } })).status, 400);
  const bad = await call('/api/connect', { method: 'POST', body: { token: 'hf_wrongwrongwrongwrongwrong123' } });
  assert.strictEqual(bad.status, 401);
  assert.ok(!JSON.stringify(bad.data).includes('hf_wrong'), 'token echoed back in error');
});

test('connects and reports permissions without exposing the token', async () => {
  const { status, data } = await call('/api/connect', { method: 'POST', body: { token: TOKEN } });
  assert.strictEqual(status, 200);
  assert.strictEqual(data.connected, true);
  assert.strictEqual(data.user.name, 'chomeed');
  assert.strictEqual(data.permissions.canWriteCollections, true);
});

test('lists all repositories across pages, including private ones', async () => {
  const { data } = await call('/api/repos?author=chomeed');
  const models = data.repos.filter((r) => r.type === 'model');
  assert.strictEqual(models.length, 150);
  assert.ok(models.some((r) => r.private));
  assert.strictEqual(data.repos.find((r) => r.type === 'space').description, 'A demo');
});

test('imports collections with full item lists', async () => {
  const { data } = await call('/api/collections');
  const llms = data.collections.find((c) => c.title === 'LLMs');
  assert.strictEqual(llms.items.length, 3);
  assert.ok(llms.items.every((it) => /^[a-f0-9]{24}$/.test(it.objectId)));
  assert.strictEqual(llms.description, 'Language models');
});

test('collection lifecycle: create, update, add, duplicate add, remove, delete', async () => {
  const created = await call('/api/collections', { method: 'POST', body: { title: 'Vision', description: 'cv', private: true } });
  assert.strictEqual(created.status, 200);
  const slug = created.data.collection.slug;
  assert.ok(slug.startsWith('chomeed/'));
  const path = `/api/collections/${slug}`;
  assert.strictEqual((await call(path, { method: 'PATCH', body: { title: 'Computer Vision' } })).data.collection.title, 'Computer Vision');
  assert.strictEqual((await call(`${path}/items`, { method: 'POST', body: { type: 'model', id: 'chomeed/model-005' } })).status, 200);
  assert.strictEqual((await call(`${path}/items`, { method: 'POST', body: { type: 'model', id: 'chomeed/model-005' } })).status, 409);
  const forb = await call(`${path}/items`, { method: 'POST', body: { type: 'model', id: 'chomeed/forbidden' } });
  assert.strictEqual(forb.status, 403);
  assert.match(forb.data.error.message, /permission/i);
  const full = (await call(path)).data.collection;
  assert.strictEqual(full.items.length, 1);
  assert.strictEqual((await call(`${path}/items/${full.items[0].objectId}`, { method: 'DELETE' })).status, 200);
  assert.strictEqual((await call(path, { method: 'DELETE' })).status, 200);
  assert.strictEqual((await call(path)).status, 404);
});

test('validates input and namespaces', async () => {
  assert.strictEqual((await call('/api/collections', { method: 'POST', body: { title: '' } })).status, 400);
  assert.strictEqual((await call('/api/collections', { method: 'POST', body: { title: 'x', namespace: 'someone-else' } })).status, 403);
  const slug = [...hub.collections.keys()][0];
  assert.strictEqual((await call(`/api/collections/${slug}/items`, { method: 'POST', body: { type: 'paper', id: 'x/y' } })).status, 400);
  assert.strictEqual((await call(`/api/collections/${slug}/items/not-an-id`, { method: 'DELETE' })).status, 400);
  assert.strictEqual((await call('/api/collections/someone-else/abc/items', { method: 'POST', body: { type: 'model', id: 'a/b' } })).status, 403);
});

test('disconnect clears the session token', async () => {
  const { data } = await call('/api/disconnect', { method: 'POST' });
  assert.strictEqual(data.connected, false);
  assert.strictEqual((await call('/api/collections')).status, 401);
});

test('serves only whitelisted static files with security headers', async () => {
  const r = await fetch(base + '/');
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers.get('content-security-policy').includes("connect-src 'self'"));
  assert.strictEqual((await fetch(base + '/server.js')).status, 404);
  assert.strictEqual((await fetch(base + '/.env')).status, 404);
  assert.strictEqual((await fetch(base + '/vendor/Sortable.min.js')).status, 200);
});
