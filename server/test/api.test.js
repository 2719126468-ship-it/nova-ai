import { createServer } from 'node:http';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-api-'));
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.SESSION_SECRET = 'test-secret-with-more-than-32-characters-long';
process.env.DB_PATH = path.join(tempDir, 'test.sqlite');
process.env.AI_BASE_URL = '';
process.env.AI_API_KEY = '';
process.env.AI_MODEL = '';

let app;
let db;
let config;
let providerServer;
let providerRequest;
let runMigrations;

before(async () => {
  const [{ createApp }, database, appConfig, migrations] = await Promise.all([
    import('../src/app.js'),
    import('../src/db.js'),
    import('../src/config.js'),
    import('../src/migrations.js'),
  ]);
  app = createApp();
  db = database.db;
  config = appConfig.config;
  runMigrations = migrations.runMigrations;
});

after(async () => {
  if (providerServer?.listening) {
    await new Promise((resolve) => providerServer.close(resolve));
  }
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const originHeaders = { Origin: 'http://localhost:5173', 'X-Requested-With': 'NOVA-Web' };

test('health endpoint reports AI adapter as unconfigured without credentials', async () => {
  const response = await request(app).get('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.ai.configured, false);
  assert.equal(response.body.ai.status, 'not_configured');
});

test('registration creates an account and an HttpOnly session cookie', async () => {
  const response = await request(app).post('/api/auth/register').set(originHeaders).send({
    email: 'test@example.com', name: 'NOVA Tester', password: 'a-strong-test-password',
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.user.email, 'test@example.com');
  assert.ok(response.headers['set-cookie']?.some((cookie) => cookie.includes('HttpOnly')));
});

test('authenticated users can create, update and delete their own projects', async () => {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set(originHeaders).send({ email: 'test@example.com', password: 'a-strong-test-password' }).expect(200);
  const created = await agent.post('/api/projects').set(originHeaders).send({ title: 'First project', description: 'A project', content: 'draft' }).expect(201);
  const id = created.body.project.id;
  assert.equal(created.body.project.title, 'First project');
  await agent.put('/api/projects/' + id).set(originHeaders).send({ title: 'Updated project', description: '', content: 'published draft' }).expect(200);
  await agent.delete('/api/projects/' + id).set(originHeaders).expect(200);
  await agent.get('/api/projects/' + id).set(originHeaders).expect(404);
});

test('mutating requests without the application request header are rejected', async () => {
  const response = await request(app).post('/api/auth/login')
    .set('Origin', 'http://localhost:5173')
    .send({ email: 'test@example.com', password: 'a-strong-test-password' });
  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'MISSING_REQUEST_HEADER');
});

test('AI chat does not invent a response when no provider is configured', async () => {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set(originHeaders)
    .send({ email: 'test@example.com', password: 'a-strong-test-password' }).expect(200);
  const conv = await agent.post('/api/conversations').set(originHeaders)
    .send({ title: 'Test chat' }).expect(201);
  const response = await agent.post('/api/conversations/' + conv.body.conversation.id + '/messages')
    .set(originHeaders).send({ content: 'Hello' });
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'AI_PROVIDER_NOT_CONFIGURED');
});

test('database migrations add message lifecycle fields and are idempotent', () => {
  runMigrations(db);
  runMigrations(db);
  const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name));
  assert.ok(columns.has('status'));
  assert.ok(columns.has('error_code'));
  const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(versions.map((row) => row.version), [1]);
});

test('versioned models endpoint does not claim an unconfigured model is connected', async () => {
  const response = await request(app).get('/api/v1/models').expect(200);
  assert.equal(response.body.configured, false);
  assert.deepEqual(response.body.models, []);
});

test('users can rename conversations through the versioned API', async () => {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').set(originHeaders)
    .send({ email: 'test@example.com', password: 'a-strong-test-password' }).expect(200);
  const created = await agent.post('/api/v1/conversations').set(originHeaders)
    .send({ title: '新对话' }).expect(201);
  const id = created.body.conversation.id;
  const updated = await agent.patch('/api/v1/conversations/' + id).set(originHeaders)
    .send({ title: '已重命名的对话' }).expect(200);
  assert.equal(updated.body.conversation.title, '已重命名的对话');
  await agent.get('/api/conversations/' + id).set(originHeaders)
    .expect(200);
});

test('SSE chat streams deltas and persists the completed assistant message', async () => {
  providerRequest = null;
  providerServer = createServer((incoming, outgoing) => {
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => { body += chunk; });
    incoming.on('end', () => {
      providerRequest = JSON.parse(body);
      outgoing.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      outgoing.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
      setTimeout(() => {
        outgoing.write('data: {"choices":[{"delta":{"content":" from NOVA"}}]}\n\n');
        outgoing.end('data: [DONE]\n\n');
      }, 5);
    });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));

  const previous = {
    aiBaseUrl: config.aiBaseUrl,
    aiApiKey: config.aiApiKey,
    aiModel: config.aiModel,
  };
  config.aiBaseUrl = 'http://127.0.0.1:' + providerServer.address().port + '/v1';
  config.aiApiKey = 'test-only-secret-key';
  config.aiModel = 'mock-chat-model';

  try {
    const catalog = await request(app).get('/api/v1/models').expect(200);
    assert.equal(catalog.body.provider.configured, true);
    assert.equal(catalog.body.provider.status, 'configured_unverified');
    assert.equal(catalog.body.provider.health, 'unknown');
    assert.equal(catalog.body.models[0].status, 'unknown');
    assert.equal(catalog.body.models[0].selectable, true);
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').set(originHeaders)
      .send({ email: 'test@example.com', password: 'a-strong-test-password' }).expect(200);
    const created = await agent.post('/api/v1/conversations').set(originHeaders)
      .send({ title: 'Streaming test' }).expect(201);

    const response = await agent.post('/api/v1/conversations/' + created.body.conversation.id + '/messages/stream')
      .set(originHeaders)
      .set('Accept', 'text/event-stream')
      .send({ content: 'Say hello', modelId: 'mock-chat-model' })
      .buffer(true)
      .parse((incoming, callback) => {
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { body += chunk; });
        incoming.on('end', () => callback(null, body));
        incoming.on('error', callback);
      })
      .expect(200);

    assert.match(response.headers['content-type'], /text\/event-stream/);
    assert.match(response.body, /event: message_start/);
    assert.match(response.body, /event: message_delta/);
    assert.match(response.body, /event: message_complete/);
    assert.match(response.body, /Hello from NOVA/);
    assert.equal(response.body.includes('test-only-secret-key'), false);
    assert.equal(providerRequest.stream, true);
    assert.equal(providerRequest.messages.at(-1).content, 'Say hello');

    const messages = db.prepare(
      'SELECT role,content,status,error_code FROM messages WHERE conversation_id=? ORDER BY id',
    ).all(created.body.conversation.id);
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(messages[1].content, 'Hello from NOVA');
    assert.equal(messages[1].status, 'complete');
    assert.equal(messages[1].error_code, null);
  } finally {
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    await new Promise((resolve) => providerServer.close(resolve));
    providerServer = null;
  }
});


test('stream endpoint falls back to a complete JSON response when the provider ignores stream mode', async () => {
  providerServer = createServer((incoming, outgoing) => {
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => { body += chunk; });
    incoming.on('end', () => {
      const payload = JSON.parse(body);
      assert.equal(payload.stream, true);
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ choices: [{ message: { content: 'JSON fallback response' } }] }));
    });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const previous = {
    aiBaseUrl: config.aiBaseUrl,
    aiApiKey: config.aiApiKey,
    aiModel: config.aiModel,
  };
  config.aiBaseUrl = 'http://127.0.0.1:' + providerServer.address().port + '/v1';
  config.aiApiKey = 'test-only-secret-key';
  config.aiModel = 'mock-json-model';

  try {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').set(originHeaders)
      .send({ email: 'test@example.com', password: 'a-strong-test-password' }).expect(200);
    const created = await agent.post('/api/v1/conversations').set(originHeaders)
      .send({ title: 'JSON fallback' }).expect(201);
    const response = await agent.post('/api/v1/conversations/' + created.body.conversation.id + '/messages/stream')
      .set(originHeaders)
      .set('Accept', 'text/event-stream')
      .send({ content: 'Try JSON fallback' })
      .buffer(true)
      .parse((incoming, callback) => {
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { body += chunk; });
        incoming.on('end', () => callback(null, body));
        incoming.on('error', callback);
      })
      .expect(200);

    assert.match(response.body, /event: message_delta/);
    assert.match(response.body, /JSON fallback response/);
    assert.match(response.body, /event: message_complete/);
    const saved = db.prepare(
      "SELECT content,status FROM messages WHERE conversation_id=? AND role='assistant'",
    ).get(created.body.conversation.id);
    assert.deepEqual(saved, { content: 'JSON fallback response', status: 'complete' });
  } finally {
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    await new Promise((resolve) => providerServer.close(resolve));
    providerServer = null;
  }
});


test('Zod 4 validation errors retain structured field details', async () => {
  const response = await request(app).post('/api/v1/auth/register').set(originHeaders)
    .send({ email: 'not-an-email', name: '', password: 'short' })
    .expect(400);
  assert.equal(response.body.error, 'VALIDATION_ERROR');
  assert.ok(Array.isArray(response.body.details.formErrors));
  assert.ok(Array.isArray(response.body.details.fieldErrors.email));
  assert.ok(Array.isArray(response.body.details.fieldErrors.password));
  assert.ok(Array.isArray(response.body.details.fieldErrors.name));
});
