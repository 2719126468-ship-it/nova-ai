import { createServer } from 'node:http';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-research-'));
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.SESSION_SECRET = 'research-test-session-secret-with-more-than-32-characters';
process.env.PROVIDER_ENCRYPTION_KEY = 'research-test-provider-encryption-key-with-32-characters';
process.env.DB_PATH = path.join(tempDir, 'research.sqlite');
process.env.AI_BASE_URL = '';
process.env.AI_API_KEY = '';
process.env.AI_MODEL = '';
process.env.RESEARCH_SEARCH_PROVIDER = '';
process.env.RESEARCH_SEARCH_URL = '';
process.env.BRAVE_SEARCH_API_KEY = '';

let app;
let db;
let config;
let upstream;

const originHeaders = { Origin: 'http://localhost:5173', 'X-Requested-With': 'NOVA-Web' };

before(async () => {
  const [{ createApp }, database, appConfig] = await Promise.all([
    import('../src/app.js'),
    import('../src/db.js'),
    import('../src/config.js'),
  ]);
  app = createApp();
  db = database.db;
  config = appConfig.config;
});

after(async () => {
  if (upstream?.listening) await new Promise((resolve) => upstream.close(resolve));
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function registerUser(email) {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/register').set(originHeaders).send({
    email,
    name: 'Research Tester',
    password: 'research-test-password-strong',
  }).expect(201);
  return agent;
}

test('Research search requires a session and reports missing provider configuration honestly', async () => {
  config.researchSearchProvider = '';
  config.researchSearchUrl = '';
  config.braveSearchApiKey = '';

  await request(app).post('/api/v1/research/search')
    .set(originHeaders).send({ query: 'NOVA Research' }).expect(401);

  const user = await registerUser('research-unconfigured@example.com');
  const response = await user.post('/api/v1/research/search')
    .set(originHeaders).send({ query: 'NOVA Research' }).expect(503);
  assert.equal(response.body.error, 'RESEARCH_SEARCH_NOT_CONFIGURED');
  assert.match(response.body.message, /尚未配置真实搜索服务/);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('SearXNG search normalizes real upstream results, filters unsafe URLs, and keeps sources', async () => {
  upstream = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url, 'http://127.0.0.1');
    assert.equal(url.pathname, '/search');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(url.searchParams.get('safesearch'), '2');
    assert.equal(url.searchParams.get('q'), 'NOVA real search');
    outgoing.writeHead(200, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({
      query: { more_results_available: true },
      results: [
        {
          title: 'NOVA primary source',
          url: 'https://example.org/research/nova',
          content: 'Snippet from the configured search service.',
          publishedDate: '2026-11-07',
          engines: ['engine-a', 'engine-b'],
        },
        {
          title: 'Duplicate source',
          url: 'https://example.org/research/nova',
          content: 'Duplicate result.',
        },
        { title: 'Unsafe URL', url: 'javascript:alert(1)', content: 'Must be filtered.' },
        { title: 'Credential URL', url: 'https://user:pass@example.org/private', content: 'Must be filtered.' },
        { title: 'Missing title', url: 'https://example.org/no-title', content: 'Must be filtered.' },
      ],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  config.researchSearchProvider = 'searxng';
  config.researchSearchUrl = 'http://127.0.0.1:' + upstream.address().port;
  config.braveSearchApiKey = '';

  const user = await registerUser('research-searxng@example.com');
  const response = await user.post('/api/v1/research/search')
    .set(originHeaders).send({ query: 'NOVA real search', count: 5 }).expect(200);

  assert.equal(response.body.provider, 'searxng');
  assert.equal(response.body.query, 'NOVA real search');
  assert.equal(response.body.moreResultsAvailable, true);
  assert.equal(response.body.sources.length, 1);
  assert.equal(response.body.sources[0].title, 'NOVA primary source');
  assert.equal(response.body.sources[0].url, 'https://example.org/research/nova');
  assert.equal(response.body.sources[0].domain, 'example.org');
  assert.equal(response.body.sources[0].snippet, 'Snippet from the configured search service.');
  assert.deepEqual(response.body.sources[0].engines, ['engine-a', 'engine-b']);
  assert.match(response.body.sources[0].id, /^[a-f0-9]{16}$/);
  assert.ok(response.body.retrievedAt);
});

test('Brave Search keeps its credential in the server request and never returns it to the client', async () => {
  const previousFetch = globalThis.fetch;
  const secret = 'brave-search-server-only-test-secret';
  let requestedUrl = '';
  let requestedToken = '';
  globalThis.fetch = async (input, options = {}) => {
    requestedUrl = String(input);
    requestedToken = new Headers(options.headers || {}).get('X-Subscription-Token') || '';
    return new Response(JSON.stringify({
      query: { more_results_available: false },
      web: {
        results: [{
          title: 'Brave result',
          url: 'https://docs.example.org/topic',
          description: 'A result returned by Brave Search.',
          page_age: '2 days ago',
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    config.researchSearchProvider = 'brave';
    config.braveSearchApiKey = secret;
    const user = await registerUser('research-brave@example.com');
    const response = await user.post('/api/v1/research/search')
      .set(originHeaders).send({ query: 'NOVA provider adapters', count: 4 }).expect(200);

    assert.ok(requestedUrl.startsWith('https://api.search.brave.com/res/v1/web/search?'));
    assert.equal(new URL(requestedUrl).searchParams.get('q'), 'NOVA provider adapters');
    assert.equal(requestedToken, secret);
    assert.equal(response.body.provider, 'brave');
    assert.equal(response.body.sources.length, 1);
    assert.equal(response.body.sources[0].title, 'Brave result');
    assert.equal(response.body.sources[0].publishedAt, '2 days ago');
    assert.equal(response.text.includes(secret), false);
  } finally {
    globalThis.fetch = previousFetch;
    config.braveSearchApiKey = '';
    config.researchSearchProvider = '';
  }
});

test('Research search returns a sanitized upstream error instead of raw provider response content', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('private upstream diagnostic with api-secret-do-not-return', { status: 503 });
  try {
    config.researchSearchProvider = 'brave';
    config.braveSearchApiKey = 'another-server-side-secret';
    const user = await registerUser('research-upstream-error@example.com');
    const response = await user.post('/api/v1/research/search')
      .set(originHeaders).send({ query: 'NOVA provider outage' }).expect(502);
    assert.equal(response.body.error, 'RESEARCH_SEARCH_UPSTREAM_UNAVAILABLE');
    assert.equal(response.text.includes('api-secret-do-not-return'), false);
    assert.equal(response.text.includes('another-server-side-secret'), false);
  } finally {
    globalThis.fetch = previousFetch;
    config.braveSearchApiKey = '';
    config.researchSearchProvider = '';
  }
});

test('Research articles remain public-read and administrator-write only', async () => {
  const regular = await registerUser('research-cms-regular@example.com');
  const article = {
    slug: 'admin-only-research-record',
    title: 'Administrator Only Research',
    category: 'Security',
    summary: 'A published source-backed editorial entry.',
    body: 'This is a sufficiently long body for the published research article.',
    status: 'published',
  };
  await regular.post('/api/v1/research').set(originHeaders).send(article).expect(403);

  const admin = await registerUser('research-cms-admin@example.com');
  const adminUser = db.prepare('SELECT id FROM users WHERE email=?').get('research-cms-admin@example.com');
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(adminUser.id);
  await admin.post('/api/v1/research').set(originHeaders).send(article).expect(201);
  await admin.post('/api/v1/research').set(originHeaders).send({
    ...article,
    slug: 'admin-only-research-draft',
    status: 'draft',
  }).expect(201);

  const publicList = await request(app).get('/api/v1/research').expect(200);
  assert.equal(publicList.body.articles.some((item) => item.slug === article.slug), true);
  assert.equal(publicList.body.articles.some((item) => item.slug === 'admin-only-research-draft'), false);
  await request(app).get('/api/v1/research/admin-only-research-draft').expect(404);
  await request(app).get('/api/v1/research/admin-only-research-record').expect(200);
  await regular.delete('/api/v1/research/1').set(originHeaders).expect(403);
});
