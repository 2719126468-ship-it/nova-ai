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
  assert.deepEqual(versions.map((row) => row.version), [1, 2]);
});

test('versioned models endpoint does not claim an unconfigured model is connected', async () => {
  const response = await request(app).get('/api/v1/models').expect(200);
  assert.equal(response.body.configured, false);
  assert.deepEqual(response.body.models, []);
  assert.deepEqual(response.body.contextPolicy, { unit: 'characters', maxMessageContentCharacters: 40000, tokenLimit: null });
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


test('stream endpoint enforces one active generation per authenticated user', async () => {
  let signalStarted;
  const providerStarted = new Promise((resolve) => { signalStarted = resolve; });
  providerServer = createServer((incoming, outgoing) => {
    incoming.resume();
    incoming.on('end', () => {
      signalStarted();
      outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });
      setTimeout(() => {
        outgoing.end('data: {"choices":[{"delta":{"content":"Concurrent test complete"}}]}\n\ndata: [DONE]\n\n');
      }, 150);
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
  config.aiModel = 'mock-concurrency-model';

  try {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').set(originHeaders)
      .send({ email: 'test@example.com', password: 'a-strong-test-password' }).expect(200);
    const created = await agent.post('/api/v1/conversations').set(originHeaders)
      .send({ title: 'Concurrency test' }).expect(201);
    const url = '/api/v1/conversations/' + created.body.conversation.id + '/messages/stream';
    const firstPromise = (async () => agent.post(url).set(originHeaders)
      .send({ content: 'First generation' })
      .buffer(true)
      .parse((incoming, callback) => {
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { body += chunk; });
        incoming.on('end', () => callback(null, body));
        incoming.on('error', callback);
      }))();
    await providerStarted;
    const second = await agent.post(url.replace('/messages/stream', '/messages')).set(originHeaders)
      .send({ content: 'Second generation' }).expect(409);
    assert.equal(second.body.error, 'AI_GENERATION_IN_PROGRESS');

    const first = await firstPromise;
    assert.equal(first.status, 200);
    assert.match(first.body, /Concurrent test complete/);
    const saved = db.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE conversation_id=? AND role='user'",
    ).get(created.body.conversation.id);
    assert.equal(saved.count, 1);
  } finally {
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    await new Promise((resolve) => providerServer.close(resolve));
    providerServer = null;
  }
});


test('AI generation requests are rate-limited per authenticated user', async () => {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/register').set(originHeaders).send({
    email: 'rate-limit@example.com',
    name: 'Rate Limit Tester',
    password: 'another-strong-test-password',
  }).expect(201);
  const created = await agent.post('/api/v1/conversations').set(originHeaders)
    .send({ title: 'Rate limit test' }).expect(201);
  const url = '/api/v1/conversations/' + created.body.conversation.id + '/messages/stream';

  for (let index = 1; index <= 6; index += 1) {
    const response = await agent.post(url).set(originHeaders)
      .send({ content: '' });
    assert.equal(response.status, 400, 'request ' + index + ' should reach message validation');
  }

  const limited = await agent.post(url).set(originHeaders).send({ content: '' }).expect(429);
  assert.equal(limited.body.error, 'AI_RATE_LIMITED');
  assert.equal(limited.body.message, '发送过于频繁，请稍后再试。');
});


test('users cannot read, change, message, or delete another account resources', async () => {
  const owner = request.agent(app);
  await owner.post('/api/v1/auth/login').set(originHeaders)
    .send({ email: 'test@example.com', password: 'a-strong-test-password' }).expect(200);
  const project = await owner.post('/api/v1/projects').set(originHeaders)
    .send({ title: 'Private project', description: 'owner only', content: 'private data' }).expect(201);
  const conversation = await owner.post('/api/v1/conversations').set(originHeaders)
    .send({ title: 'Private conversation' }).expect(201);

  const other = request.agent(app);
  await other.post('/api/v1/auth/register').set(originHeaders).send({
    email: 'isolation@example.com',
    name: 'Isolation Tester',
    password: 'isolation-test-password-strong',
  }).expect(201);

  await other.get('/api/v1/projects/' + project.body.project.id).set(originHeaders).expect(404);
  await other.put('/api/v1/projects/' + project.body.project.id).set(originHeaders)
    .send({ title: 'Take over', description: '', content: '' }).expect(404);
  await other.delete('/api/v1/projects/' + project.body.project.id).set(originHeaders).expect(404);

  await other.get('/api/v1/conversations/' + conversation.body.conversation.id).set(originHeaders).expect(404);
  await other.patch('/api/v1/conversations/' + conversation.body.conversation.id).set(originHeaders)
    .send({ title: 'Take over conversation' }).expect(404);
  await other.post('/api/v1/conversations/' + conversation.body.conversation.id + '/messages/stream')
    .set(originHeaders).send({ content: 'Should never be stored' }).expect(404);
  await other.delete('/api/v1/conversations/' + conversation.body.conversation.id).set(originHeaders).expect(404);

  const ownerProject = await owner.get('/api/v1/projects/' + project.body.project.id).set(originHeaders).expect(200);
  const ownerConversation = await owner.get('/api/v1/conversations/' + conversation.body.conversation.id)
    .set(originHeaders).expect(200);
  assert.equal(ownerProject.body.project.content, 'private data');
  assert.deepEqual(ownerConversation.body.messages, []);
});

test('upstream authentication, rate-limit, server, and empty-stream failures are classified and saved', async () => {
  providerServer = createServer((incoming, outgoing) => {
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => { body += chunk; });
    incoming.on('end', () => {
      const payload = JSON.parse(body);
      const prompt = payload.messages.at(-1).content;
      if (prompt.includes('provider-401')) {
        outgoing.writeHead(401, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({ error: 'invalid upstream key' }));
      } else if (prompt.includes('provider-403')) {
        outgoing.writeHead(403, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({ error: 'upstream permission detail' }));
      } else if (prompt.includes('provider-429')) {
        outgoing.writeHead(429, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({ error: 'upstream quota detail' }));
      } else if (prompt.includes('provider-503')) {
        outgoing.writeHead(503, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({ error: 'private upstream detail' }));
      } else if (prompt.includes('provider-malformed')) {
        outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });
        outgoing.end('data: {not valid json}\n\n');
      } else {
        outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });
        outgoing.end('data: [DONE]\n\n');
      }
    });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const previous = {
    aiBaseUrl: config.aiBaseUrl,
    aiApiKey: config.aiApiKey,
    aiModel: config.aiModel,
  };
  config.aiBaseUrl = 'http://127.0.0.1:' + providerServer.address().port + '/v1';
  config.aiApiKey = 'provider-test-secret';
  config.aiModel = 'mock-error-model';

  try {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/register').set(originHeaders).send({
      email: 'provider-errors@example.com',
      name: 'Provider Error Tester',
      password: 'provider-error-password-strong',
    }).expect(201);
    const created = await agent.post('/api/v1/conversations').set(originHeaders)
      .send({ title: 'Provider errors' }).expect(201);
    const id = created.body.conversation.id;
    const url = '/api/v1/conversations/' + id + '/messages/stream';
    const cases = [
      ['provider-401', 'AI_PROVIDER_ERROR'],
      ['provider-403', 'AI_PROVIDER_ERROR'],
      ['provider-429', 'AI_PROVIDER_RATE_LIMITED'],
      ['provider-503', 'AI_PROVIDER_UNAVAILABLE'],
      ['provider-empty', 'AI_EMPTY_RESPONSE'],
      ['provider-malformed', 'AI_INVALID_STREAM'],
    ];

    for (const [prompt, code] of cases) {
      const response = await agent.post(url).set(originHeaders)
        .send({ content: prompt })
        .buffer(true)
        .parse((incoming, callback) => {
          let result = '';
          incoming.setEncoding('utf8');
          incoming.on('data', (chunk) => { result += chunk; });
          incoming.on('end', () => callback(null, result));
          incoming.on('error', callback);
        }).expect(200);

      assert.match(response.body, /event: message_error/);
      assert.match(response.body, new RegExp('"code":"' + code + '"'));
      assert.equal(response.body.includes('provider-test-secret'), false);
      assert.equal(response.body.includes('private upstream detail'), false);
      assert.equal(response.body.includes('upstream quota detail'), false);
      assert.equal(response.body.includes('upstream permission detail'), false);

      const saved = db.prepare(
        "SELECT status,error_code FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY id DESC LIMIT 1",
      ).get(id);
      assert.deepEqual(saved, { status: 'failed', error_code: code });
    }
  } finally {
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    await new Promise((resolve) => providerServer.close(resolve));
    providerServer = null;
  }
});

test('provider timeout is classified and saved as a failed message', async () => {
  providerServer = createServer((incoming, outgoing) => {
    incoming.resume();
    incoming.on('end', () => {
      setTimeout(() => {
        if (!outgoing.destroyed) {
          outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });
          outgoing.end('data: {"choices":[{"delta":{"content":"Too late"}}]}\n\ndata: [DONE]\n\n');
        }
      }, 100);
    });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const previous = {
    aiBaseUrl: config.aiBaseUrl,
    aiApiKey: config.aiApiKey,
    aiModel: config.aiModel,
    aiTimeoutMs: config.aiTimeoutMs,
  };
  config.aiBaseUrl = 'http://127.0.0.1:' + providerServer.address().port + '/v1';
  config.aiApiKey = 'timeout-test-secret';
  config.aiModel = 'mock-timeout-model';
  config.aiTimeoutMs = 20;

  try {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/register').set(originHeaders).send({
      email: 'provider-timeout@example.com',
      name: 'Provider Timeout Tester',
      password: 'provider-timeout-password-strong',
    }).expect(201);
    const created = await agent.post('/api/v1/conversations').set(originHeaders)
      .send({ title: 'Provider timeout' }).expect(201);
    const id = created.body.conversation.id;
    const url = '/api/v1/conversations/' + id + '/messages/stream';

    const response = await agent.post(url).set(originHeaders).send({ content: 'Trigger timeout' })
      .buffer(true)
      .parse((incoming, callback) => {
        let result = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { result += chunk; });
        incoming.on('end', () => callback(null, result));
        incoming.on('error', callback);
      }).expect(200);

    assert.match(response.body, /event: message_error/);
    assert.match(response.body, /"code":"AI_TIMEOUT"/);
    const saved = db.prepare(
      "SELECT status,error_code FROM messages WHERE conversation_id=? AND role='assistant'",
    ).get(id);
    assert.deepEqual(saved, { status: 'failed', error_code: 'AI_TIMEOUT' });
  } finally {
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    config.aiTimeoutMs = previous.aiTimeoutMs;
    await new Promise((resolve) => providerServer.close(resolve));
    providerServer = null;
  }
});


test('context character budget keeps the newest complete turn and preserves current input', async () => {
  providerServer = createServer((incoming, outgoing) => {
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => { body += chunk; });
    incoming.on('end', () => {
      providerRequest = JSON.parse(body);
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ choices: [{ message: { content: 'Context window response' } }] }));
    });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const previous = {
    aiBaseUrl: config.aiBaseUrl,
    aiApiKey: config.aiApiKey,
    aiModel: config.aiModel,
    aiMaxContextChars: config.aiMaxContextChars,
  };
  config.aiBaseUrl = 'http://127.0.0.1:' + providerServer.address().port + '/v1';
  config.aiApiKey = 'context-test-secret';
  config.aiModel = 'mock-context-model';
  config.aiMaxContextChars = 30;

  try {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/register').set(originHeaders).send({
      email: 'context-budget@example.com',
      name: 'Context Budget Tester',
      password: 'context-budget-password-strong',
    }).expect(201);
    const created = await agent.post('/api/v1/conversations').set(originHeaders)
      .send({ title: 'Context budget' }).expect(201);
    const id = created.body.conversation.id;
    const insert = db.prepare('INSERT INTO messages(conversation_id,role,content) VALUES(?,?,?)');
    insert.run(id, 'user', 'old-user');
    insert.run(id, 'assistant', 'old-answer');
    insert.run(id, 'user', 'recent-user');
    insert.run(id, 'assistant', 'recent-answer');
    // Simulate a user turn whose assistant generation previously failed.
    insert.run(id, 'user', 'abandoned-user');

    const response = await agent.post('/api/v1/conversations/' + id + '/messages/stream')
      .set(originHeaders).send({ content: 'now' })
      .buffer(true)
      .parse((incoming, callback) => {
        let result = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { result += chunk; });
        incoming.on('end', () => callback(null, result));
        incoming.on('error', callback);
      }).expect(200);
    assert.match(response.body, /event: message_complete/);
    assert.match(response.body, /Context window response/);
    assert.deepEqual(
      providerRequest.messages.map((message) => [message.role, message.content]),
      [['user', 'recent-user'], ['assistant', 'recent-answer'], ['user', 'now']],
    );

    config.aiMaxContextChars = 2;
    const tooLarge = await agent.post('/api/v1/conversations/' + id + '/messages/stream')
      .set(originHeaders).send({ content: 'too long' }).expect(413);
    assert.equal(tooLarge.body.error, 'AI_INPUT_TOO_LARGE');
    const savedOversized = db.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE conversation_id=? AND role='user' AND content='too long'",
    ).get(id);
    assert.equal(savedOversized.count, 0);
  } finally {
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    config.aiMaxContextChars = previous.aiMaxContextChars;
    await new Promise((resolve) => providerServer.close(resolve));
    providerServer = null;
  }
});


test('client disconnect aborts upstream generation and persists cancelled status', async () => {
  let signalUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => { signalUpstreamClosed = resolve; });
  providerServer = createServer((incoming, outgoing) => {
    incoming.resume();
    incoming.on('end', () => {
      outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });
      outgoing.write('data: {"choices":[{"delta":{"content":"partial-content"}}]}\n\n');
      outgoing.on('close', signalUpstreamClosed);
    });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));

  const previous = {
    aiBaseUrl: config.aiBaseUrl,
    aiApiKey: config.aiApiKey,
    aiModel: config.aiModel,
  };
  config.aiBaseUrl = 'http://127.0.0.1:' + providerServer.address().port + '/v1';
  config.aiApiKey = 'cancel-test-secret';
  config.aiModel = 'mock-cancel-model';

  const clientServer = createServer(app);
  try {
    const registration = await request(app).post('/api/v1/auth/register').set(originHeaders).send({
      email: 'provider-cancel@example.com',
      name: 'Provider Cancel Tester',
      password: 'provider-cancel-password-strong',
    }).expect(201);
    const cookie = registration.headers['set-cookie']
      .find((value) => value.startsWith('nova_session='))
      .split(';')[0];
    const created = await request(app).post('/api/v1/conversations')
      .set({ ...originHeaders, Cookie: cookie })
      .send({ title: 'Cancellation test' }).expect(201);
    const conversationId = created.body.conversation.id;

    await new Promise((resolve) => clientServer.listen(0, '127.0.0.1', resolve));
    const controller = new AbortController();
    const response = await fetch(
      'http://127.0.0.1:' + clientServer.address().port + '/api/v1/conversations/' + conversationId + '/messages/stream',
      {
        method: 'POST',
        headers: {
          ...originHeaders,
          Cookie: cookie,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ content: 'Stop this generation' }),
        signal: controller.signal,
      },
    );
    assert.equal(response.status, 200);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let streamed = '';
    let aborted = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        streamed += decoder.decode(value, { stream: true });
        if (streamed.includes('partial-content')) {
          aborted = true;
          controller.abort();
          break;
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
    assert.equal(aborted, true);
    assert.match(streamed, /event: message_delta/);

    await Promise.race([
      upstreamClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Upstream request was not aborted')), 1500)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const saved = db.prepare(
      "SELECT status,error_code,content FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY id DESC LIMIT 1",
    ).get(conversationId);
    assert.deepEqual(saved, {
      status: 'cancelled',
      error_code: 'AI_REQUEST_CANCELLED',
      content: 'partial-content',
    });
  } finally {
    if (clientServer.listening) await new Promise((resolve) => clientServer.close(resolve));
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    if (providerServer?.listening) await new Promise((resolve) => providerServer.close(resolve));
    providerServer = null;
  }
});





test('failed edit regeneration preserves the original conversation branch', async () => {
  providerServer = createServer((incoming, outgoing) => {
    incoming.resume();
    incoming.on('end', () => {
      outgoing.writeHead(503, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'private provider failure detail' }));
    });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));

  const previous = {
    aiBaseUrl: config.aiBaseUrl,
    aiApiKey: config.aiApiKey,
    aiModel: config.aiModel,
  };
  config.aiBaseUrl = 'http://127.0.0.1:' + providerServer.address().port + '/v1';
  config.aiApiKey = 'edit-failure-secret';
  config.aiModel = 'mock-edit-failure-model';

  try {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/register').set(originHeaders).send({
      email: 'message-edit-failure@example.com',
      name: 'Edit Failure Tester',
      password: 'edit-failure-password-strong',
    }).expect(201);
    const created = await agent.post('/api/v1/conversations').set(originHeaders)
      .send({ title: 'Edit failure' }).expect(201);
    const conversationId = created.body.conversation.id;
    const insert = db.prepare('INSERT INTO messages(conversation_id,role,content) VALUES(?,?,?)');
    const firstUser = insert.run(conversationId, 'user', 'original first question');
    insert.run(conversationId, 'assistant', 'original first answer');
    insert.run(conversationId, 'user', 'original later question');
    insert.run(conversationId, 'assistant', 'original later answer');

    const response = await agent.put(
      '/api/v1/conversations/' + conversationId + '/messages/' + firstUser.lastInsertRowid + '/stream',
    ).set(originHeaders).send({ content: 'edited but not committed' })
      .buffer(true)
      .parse((incoming, callback) => {
        let result = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { result += chunk; });
        incoming.on('end', () => callback(null, result));
        incoming.on('error', callback);
      }).expect(200);

    assert.match(response.body, /event: message_start/);
    assert.match(response.body, /event: message_error/);
    assert.equal(response.body.includes('private provider failure detail'), false);

    const saved = db.prepare(
      'SELECT role,content,status FROM messages WHERE conversation_id=? ORDER BY id',
    ).all(conversationId);
    assert.deepEqual(saved, [
      { role: 'user', content: 'original first question', status: 'complete' },
      { role: 'assistant', content: 'original first answer', status: 'complete' },
      { role: 'user', content: 'original later question', status: 'complete' },
      { role: 'assistant', content: 'original later answer', status: 'complete' },
    ]);
  } finally {
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    await new Promise((resolve) => providerServer.close(resolve));
    providerServer = null;
  }
});


test('editing a user message replaces that turn and deletes later conversation history', async () => {
  providerServer = createServer((incoming, outgoing) => {
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => { body += chunk; });
    incoming.on('end', () => {
      providerRequest = JSON.parse(body);
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ choices: [{ message: { content: 'Rewritten assistant message' } }] }));
    });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));

  const previous = {
    aiBaseUrl: config.aiBaseUrl,
    aiApiKey: config.aiApiKey,
    aiModel: config.aiModel,
  };
  config.aiBaseUrl = 'http://127.0.0.1:' + providerServer.address().port + '/v1';
  config.aiApiKey = 'edit-test-secret';
  config.aiModel = 'mock-edit-model';

  try {
    const owner = request.agent(app);
    await owner.post('/api/v1/auth/register').set(originHeaders).send({
      email: 'message-edit@example.com',
      name: 'Message Edit Tester',
      password: 'message-edit-password-strong',
    }).expect(201);

    const created = await owner.post('/api/v1/conversations').set(originHeaders)
      .send({ title: 'Message editing' }).expect(201);
    const conversationId = created.body.conversation.id;
    const insert = db.prepare('INSERT INTO messages(conversation_id,role,content) VALUES(?,?,?)');
    insert.run(conversationId, 'user', 'first question');
    insert.run(conversationId, 'assistant', 'first answer');
    const target = insert.run(conversationId, 'user', 'old follow-up');
    insert.run(conversationId, 'assistant', 'old response');
    insert.run(conversationId, 'user', 'later follow-up');
    insert.run(conversationId, 'assistant', 'later response');

    const other = request.agent(app);
    await other.post('/api/v1/auth/register').set(originHeaders).send({
      email: 'message-edit-other@example.com',
      name: 'Other User',
      password: 'message-edit-other-password',
    }).expect(201);
    await other.put('/api/v1/conversations/' + conversationId + '/messages/' + target.lastInsertRowid + '/stream')
      .set(originHeaders).send({ content: 'unauthorized edit' }).expect(404);

    const response = await owner.put(
      '/api/v1/conversations/' + conversationId + '/messages/' + target.lastInsertRowid + '/stream',
    ).set(originHeaders).send({ content: 'edited follow-up' })
      .buffer(true)
      .parse((incoming, callback) => {
        let result = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { result += chunk; });
        incoming.on('end', () => callback(null, result));
        incoming.on('error', callback);
      }).expect(200);

    assert.match(response.body, /event: message_start/);
    assert.match(response.body, /event: message_delta/);
    assert.match(response.body, /event: message_complete/);
    assert.match(response.body, /Rewritten assistant message/);
    assert.equal(providerRequest.stream, true);
    assert.deepEqual(
      providerRequest.messages.map((message) => [message.role, message.content]),
      [['user', 'first question'], ['assistant', 'first answer'], ['user', 'edited follow-up']],
    );

    const saved = db.prepare(
      'SELECT role,content,status FROM messages WHERE conversation_id=? ORDER BY id',
    ).all(conversationId);
    assert.deepEqual(saved, [
      { role: 'user', content: 'first question', status: 'complete' },
      { role: 'assistant', content: 'first answer', status: 'complete' },
      { role: 'user', content: 'edited follow-up', status: 'complete' },
      { role: 'assistant', content: 'Rewritten assistant message', status: 'complete' },
    ]);
  } finally {
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    await new Promise((resolve) => providerServer.close(resolve));
    providerServer = null;
  }
});

test('retrying a failed assistant message replaces it only after a successful response', async () => {
  providerServer = createServer((incoming, outgoing) => {
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => { body += chunk; });
    incoming.on('end', () => {
      providerRequest = JSON.parse(body);
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ choices: [{ message: { content: 'Recovered assistant response' } }] }));
    });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const previous = {
    aiBaseUrl: config.aiBaseUrl,
    aiApiKey: config.aiApiKey,
    aiModel: config.aiModel,
  };
  config.aiBaseUrl = 'http://127.0.0.1:' + providerServer.address().port + '/v1';
  config.aiApiKey = 'retry-test-secret';
  config.aiModel = 'mock-retry-model';

  try {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/register').set(originHeaders).send({
      email: 'message-retry@example.com',
      name: 'Message Retry Tester',
      password: 'message-retry-password-strong',
    }).expect(201);
    const created = await agent.post('/api/v1/conversations').set(originHeaders)
      .send({ title: 'Retry response' }).expect(201);
    const id = created.body.conversation.id;
    const insert = db.prepare('INSERT INTO messages(conversation_id,role,content,status,error_code) VALUES(?,?,?,?,?)');
    insert.run(id, 'user', 'original question', 'complete', null);
    const failed = insert.run(id, 'assistant', 'partial broken output', 'failed', 'AI_PROVIDER_UNAVAILABLE');

    const response = await agent.post(
      '/api/v1/conversations/' + id + '/messages/' + failed.lastInsertRowid + '/retry/stream',
    ).set(originHeaders).send({})
      .buffer(true)
      .parse((incoming, callback) => {
        let result = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { result += chunk; });
        incoming.on('end', () => callback(null, result));
        incoming.on('error', callback);
      }).expect(200);

    assert.match(response.body, /event: message_start/);
    assert.match(response.body, /event: message_complete/);
    assert.match(response.body, /Recovered assistant response/);
    assert.deepEqual(
      providerRequest.messages.map((message) => [message.role, message.content]),
      [['user', 'original question']],
    );
    const saved = db.prepare(
      'SELECT role,content,status,error_code FROM messages WHERE conversation_id=? ORDER BY id',
    ).all(id);
    assert.deepEqual(saved, [
      { role: 'user', content: 'original question', status: 'complete', error_code: null },
      { role: 'assistant', content: 'Recovered assistant response', status: 'complete', error_code: null },
    ]);
  } finally {
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    await new Promise((resolve) => providerServer.close(resolve));
    providerServer = null;
  }
});

test('failed assistant retry preserves the previous failed response', async () => {
  providerServer = createServer((incoming, outgoing) => {
    incoming.resume();
    incoming.on('end', () => {
      outgoing.writeHead(503, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'private retry failure details' }));
    });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const previous = {
    aiBaseUrl: config.aiBaseUrl,
    aiApiKey: config.aiApiKey,
    aiModel: config.aiModel,
  };
  config.aiBaseUrl = 'http://127.0.0.1:' + providerServer.address().port + '/v1';
  config.aiApiKey = 'retry-failure-secret';
  config.aiModel = 'mock-retry-failure-model';

  try {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/register').set(originHeaders).send({
      email: 'message-retry-failure@example.com',
      name: 'Retry Failure Tester',
      password: 'retry-failure-password-strong',
    }).expect(201);
    const created = await agent.post('/api/v1/conversations').set(originHeaders)
      .send({ title: 'Retry failure' }).expect(201);
    const id = created.body.conversation.id;
    const insert = db.prepare('INSERT INTO messages(conversation_id,role,content,status,error_code) VALUES(?,?,?,?,?)');
    insert.run(id, 'user', 'question to retry', 'complete', null);
    const failed = insert.run(id, 'assistant', 'keep this failed response', 'failed', 'AI_TIMEOUT');

    const response = await agent.post(
      '/api/v1/conversations/' + id + '/messages/' + failed.lastInsertRowid + '/retry/stream',
    ).set(originHeaders).send({})
      .buffer(true)
      .parse((incoming, callback) => {
        let result = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { result += chunk; });
        incoming.on('end', () => callback(null, result));
        incoming.on('error', callback);
      }).expect(200);

    assert.match(response.body, /event: message_error/);
    assert.equal(response.body.includes('private retry failure details'), false);
    const saved = db.prepare(
      'SELECT role,content,status,error_code FROM messages WHERE conversation_id=? ORDER BY id',
    ).all(id);
    assert.deepEqual(saved, [
      { role: 'user', content: 'question to retry', status: 'complete', error_code: null },
      { role: 'assistant', content: 'keep this failed response', status: 'failed', error_code: 'AI_TIMEOUT' },
    ]);
  } finally {
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    await new Promise((resolve) => providerServer.close(resolve));
    providerServer = null;
  }
});


test('users can link their own conversations to projects but cannot cross-link accounts', async () => {
  const owner = request.agent(app);
  await owner.post('/api/v1/auth/register').set(originHeaders).send({
    email: 'project-links@example.com',
    name: 'Project Link Owner',
    password: 'project-link-owner-password',
  }).expect(201);
  const ownerProject = await owner.post('/api/v1/projects').set(originHeaders)
    .send({ title: 'Owner project', description: '', content: '' }).expect(201);
  const ownerConversation = await owner.post('/api/v1/conversations').set(originHeaders)
    .send({ title: 'Owner conversation' }).expect(201);

  const linked = await owner.post('/api/v1/projects/' + ownerProject.body.project.id + '/conversations')
    .set(originHeaders).send({ conversationId: ownerConversation.body.conversation.id }).expect(201);
  assert.equal(linked.body.success, true);
  assert.equal(linked.body.alreadyLinked, false);

  const duplicate = await owner.post('/api/v1/projects/' + ownerProject.body.project.id + '/conversations')
    .set(originHeaders).send({ conversationId: ownerConversation.body.conversation.id }).expect(200);
  assert.equal(duplicate.body.alreadyLinked, true);

  const list = await owner.get('/api/v1/projects/' + ownerProject.body.project.id + '/conversations')
    .set(originHeaders).expect(200);
  assert.equal(list.body.conversations.length, 1);
  assert.equal(list.body.conversations[0].id, ownerConversation.body.conversation.id);
  assert.equal(list.body.conversations[0].title, 'Owner conversation');

  const other = request.agent(app);
  await other.post('/api/v1/auth/register').set(originHeaders).send({
    email: 'project-links-other@example.com',
    name: 'Other Project Owner',
    password: 'project-link-other-password',
  }).expect(201);
  const otherProject = await other.post('/api/v1/projects').set(originHeaders)
    .send({ title: 'Other project', description: '', content: '' }).expect(201);
  const otherConversation = await other.post('/api/v1/conversations').set(originHeaders)
    .send({ title: 'Other conversation' }).expect(201);

  await other.get('/api/v1/projects/' + ownerProject.body.project.id + '/conversations')
    .set(originHeaders).expect(404);
  await other.post('/api/v1/projects/' + ownerProject.body.project.id + '/conversations')
    .set(originHeaders).send({ conversationId: otherConversation.body.conversation.id }).expect(404);
  await other.post('/api/v1/projects/' + otherProject.body.project.id + '/conversations')
    .set(originHeaders).send({ conversationId: ownerConversation.body.conversation.id }).expect(404);
  await owner.get('/api/v1/projects/' + otherProject.body.project.id + '/conversations')
    .set(originHeaders).expect(404);

  await owner.delete(
    '/api/v1/projects/' + ownerProject.body.project.id + '/conversations/' + ownerConversation.body.conversation.id,
  ).set(originHeaders).expect(200);
  const empty = await owner.get('/api/v1/projects/' + ownerProject.body.project.id + '/conversations')
    .set(originHeaders).expect(200);
  assert.deepEqual(empty.body.conversations, []);
  await owner.get('/api/v1/conversations/' + ownerConversation.body.conversation.id)
    .set(originHeaders).expect(200);
});


test('multi-provider model registry keeps API keys private and routes the selected model upstream', async () => {
  let capturedRequest = null;
  let capturedAuthorization = null;
  let capturedSecondRequest = null;
  let capturedSecondAuthorization = null;
  let secondProviderServer;
  providerServer = createServer((incoming, outgoing) => {
    let body = '';
    capturedAuthorization = incoming.headers.authorization;
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => { body += chunk; });
    incoming.on('end', () => {
      if (incoming.method === 'GET') {
        outgoing.writeHead(200, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({ data: [{ id: 'upstream-chat-v2' }, { id: 'disabled-model' }] }));
        return;
      }
      capturedRequest = JSON.parse(body);
      outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });
      outgoing.end('data: {"choices":[{"delta":{"content":"Model selected correctly"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  secondProviderServer = createServer((incoming, outgoing) => {
    let body = '';
    capturedSecondAuthorization = incoming.headers.authorization;
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => { body += chunk; });
    incoming.on('end', () => {
      if (incoming.method === 'GET') {
        outgoing.writeHead(200, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({ data: [{ id: 'remote-chat' }] }));
        return;
      }
      capturedSecondRequest = JSON.parse(body);
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ choices: [{ message: { content: 'Second provider selected correctly' } }] }));
    });
  });
  await new Promise((resolve) => secondProviderServer.listen(0, '127.0.0.1', resolve));

  const previous = {
    aiBaseUrl: config.aiBaseUrl,
    aiApiKey: config.aiApiKey,
    aiModel: config.aiModel,
    aiProvidersJson: config.aiProvidersJson,
    aiDefaultModelId: config.aiDefaultModelId,
  };
  config.aiBaseUrl = '';
  config.aiApiKey = '';
  config.aiModel = '';
  config.aiProvidersJson = JSON.stringify([
    {
      id: 'local-test',
      name: 'Local Test Provider',
      baseUrl: 'http://127.0.0.1:' + providerServer.address().port + '/v1',
      apiKey: 'private-local-provider-key',
      models: [
        { id: 'upstream-chat-v2', name: 'Local Chat V2', capabilities: ['chat', 'text'], contextLimit: 32768 },
        { id: 'disabled-model', name: 'Disabled Model', enabled: false },
      ],
    },
    {
      id: 'remote-test',
      name: 'Remote Test Provider',
      baseUrl: 'http://127.0.0.1:' + secondProviderServer.address().port + '/v1',
      apiKey: 'private-remote-provider-key',
      models: [{ id: 'remote-chat', name: 'Remote Chat' }],
    },
  ]);
  config.aiDefaultModelId = 'local-test:upstream-chat-v2';

  try {
    const catalog = await request(app).get('/api/v1/models').expect(200);
    assert.equal(catalog.body.configured, true);
    assert.equal(catalog.body.defaultModelId, 'local-test:upstream-chat-v2');
    assert.equal(catalog.body.models.length, 3);
    assert.equal(catalog.body.models.find((model) => model.id === 'local-test:disabled-model').selectable, false);
    assert.equal(catalog.body.models.find((model) => model.id === 'remote-test:remote-chat').selectable, true);
    const publicCatalog = JSON.stringify(catalog.body);
    assert.equal(publicCatalog.includes('private-local-provider-key'), false);
    assert.equal(publicCatalog.includes('private-remote-provider-key'), false);
    assert.equal(JSON.stringify(await (await request(app).get('/api/v1/health').expect(200)).body).includes('private-local-provider-key'), false);

    const agent = request.agent(app);
    await agent.post('/api/v1/auth/register').set(originHeaders).send({
      email: 'model-registry@example.com',
      name: 'Model Registry Tester',
      password: 'model-registry-test-password',
    }).expect(201);
    const firstHealth = await agent.post('/api/v1/models/health').set(originHeaders)
      .send({ modelId: 'local-test:upstream-chat-v2' }).expect(200);
    assert.equal(firstHealth.body.status, 'healthy');
    assert.equal(firstHealth.body.code, 'MODEL_LIST_CONFIRMED');
    const secondHealth = await agent.post('/api/v1/models/health').set(originHeaders)
      .send({ modelId: 'remote-test:remote-chat' }).expect(200);
    assert.equal(secondHealth.body.status, 'healthy');
    assert.equal(secondHealth.body.modelId, 'remote-test:remote-chat');
    const created = await agent.post('/api/v1/conversations').set(originHeaders)
      .send({ title: 'Selected model test' }).expect(201);

    const response = await agent.post('/api/v1/conversations/' + created.body.conversation.id + '/messages/stream')
      .set(originHeaders)
      .send({ content: 'Use the selected model', modelId: 'local-test:upstream-chat-v2' })
      .buffer(true)
      .parse((incoming, callback) => {
        let result = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { result += chunk; });
        incoming.on('end', () => callback(null, result));
        incoming.on('error', callback);
      }).expect(200);

    assert.match(response.body, /Model selected correctly/);
    assert.equal(capturedAuthorization, 'Bearer private-local-provider-key');
    assert.equal(capturedRequest.model, 'upstream-chat-v2');


    const secondResponse = await agent.post('/api/v1/conversations/' + created.body.conversation.id + '/messages/stream')
      .set(originHeaders)
      .send({ content: 'Use the second provider', modelId: 'remote-test:remote-chat' })
      .buffer(true)
      .parse((incoming, callback) => {
        let result = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { result += chunk; });
        incoming.on('end', () => callback(null, result));
        incoming.on('error', callback);
      }).expect(200);
    assert.match(secondResponse.body, /Second provider selected correctly/);
    assert.equal(capturedSecondAuthorization, 'Bearer private-remote-provider-key');
    assert.equal(capturedSecondRequest.model, 'remote-chat');

    await agent.post('/api/v1/conversations/' + created.body.conversation.id + '/messages/stream')
      .set(originHeaders)
      .send({ content: 'Disabled models must not run', modelId: 'local-test:disabled-model' })
      .expect(404);
  } finally {
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    config.aiProvidersJson = previous.aiProvidersJson;
    config.aiDefaultModelId = previous.aiDefaultModelId;
    await new Promise((resolve) => providerServer.close(resolve));
    await new Promise((resolve) => secondProviderServer.close(resolve));
    providerServer = null;
    secondProviderServer = null;
  }
});
