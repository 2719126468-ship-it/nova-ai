import { createServer } from 'node:http';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-legacy-chat-failure-'));
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.SESSION_SECRET = 'legacy-chat-test-session-secret-long-enough';
process.env.PROVIDER_ENCRYPTION_KEY = 'legacy-chat-provider-encryption-key-long';
process.env.DB_PATH = path.join(tempDir, 'test.sqlite');
process.env.AI_BASE_URL = '';
process.env.AI_API_KEY = '';
process.env.AI_MODEL = '';
process.env.AI_PROVIDERS_JSON = '';
process.env.AI_DEFAULT_MODEL = '';
process.env.AI_TIMEOUT_MS = '5000';

let app;
let db;
let config;
let providerServer;

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
  if (providerServer?.listening) {
    providerServer.closeAllConnections?.();
    await new Promise((resolve) => providerServer.close(resolve));
  }
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const originHeaders = { Origin: 'http://localhost:5173', 'X-Requested-With': 'NOVA-Web' };

test('legacy JSON Provider failures persist a retryable turn without leaking upstream details', async () => {
  const seenRequests = [];
  providerServer = createServer((incoming, outgoing) => {
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => { body += chunk; });
    incoming.on('end', () => {
      const payload = JSON.parse(body);
      seenRequests.push({
        authorization: incoming.headers.authorization || null,
        stream: payload.stream,
      });

      if (payload.stream === false) {
        outgoing.writeHead(403, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({
          error: 'private upstream permission detail',
          credential: 'legacy-json-provider-secret',
        }));
        return;
      }

      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({
        choices: [{ message: { content: 'Recovered legacy answer' } }],
        usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
      }));
    });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));

  const previous = {
    aiBaseUrl: config.aiBaseUrl,
    aiApiKey: config.aiApiKey,
    aiModel: config.aiModel,
  };
  config.aiBaseUrl = 'http://127.0.0.1:' + providerServer.address().port + '/v1';
  config.aiApiKey = 'legacy-json-provider-secret';
  config.aiModel = 'legacy-json-provider-model';

  try {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/register').set(originHeaders).send({
      email: 'legacy-json-failure@example.com',
      name: 'Legacy JSON Failure Tester',
      password: 'legacy-json-failure-password-strong',
    }).expect(201);
    const created = await agent.post('/api/v1/conversations').set(originHeaders)
      .send({ title: '新对话' }).expect(201);
    const conversationId = created.body.conversation.id;
    const prompt = 'Preserve this prompt after a legacy Provider 403';

    const failed = await agent.post('/api/v1/conversations/' + conversationId + '/messages')
      .set(originHeaders).send({ content: prompt }).expect(502);
    assert.equal(failed.body.error, 'AI_PROVIDER_AUTH_FAILED');
    assert.equal(typeof failed.body.requestId, 'string');
    assert.equal(failed.body.message.includes('private upstream permission detail'), false);
    assert.equal(JSON.stringify(failed.body).includes('legacy-json-provider-secret'), false);

    const afterFailure = await agent.get('/api/v1/conversations/' + conversationId)
      .set(originHeaders).expect(200);
    assert.deepEqual(afterFailure.body.messages.map((message) => ({
      role: message.role,
      content: message.content,
      status: message.status,
      error_code: message.error_code,
    })), [
      { role: 'user', content: prompt, status: 'complete', error_code: null },
      { role: 'assistant', content: '', status: 'failed', error_code: 'AI_PROVIDER_AUTH_FAILED' },
    ]);

    const failedUsage = db.prepare(
      'SELECT status,error_code FROM ai_usage WHERE request_id=?',
    ).get(failed.body.requestId);
    assert.deepEqual(failedUsage, { status: 'failed', error_code: 'AI_PROVIDER_AUTH_FAILED' });

    const failedAssistant = afterFailure.body.messages[1];
    const retry = await agent.post(
      '/api/v1/conversations/' + conversationId + '/messages/' + failedAssistant.id + '/retry/stream',
    ).set(originHeaders).send({}).buffer(true).parse((incoming, callback) => {
      let result = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => { result += chunk; });
      incoming.on('end', () => callback(null, result));
      incoming.on('error', callback);
    }).expect(200);

    assert.match(retry.body, /event: message_complete/);
    assert.match(retry.body, /Recovered legacy answer/);
    assert.equal(JSON.stringify(seenRequests), JSON.stringify([
      { authorization: 'Bearer legacy-json-provider-secret', stream: false },
      { authorization: 'Bearer legacy-json-provider-secret', stream: true },
    ]));

    const recovered = await agent.get('/api/v1/conversations/' + conversationId)
      .set(originHeaders).expect(200);
    assert.deepEqual(recovered.body.messages.map((message) => ({
      role: message.role,
      content: message.content,
      status: message.status,
      error_code: message.error_code,
    })), [
      { role: 'user', content: prompt, status: 'complete', error_code: null },
      { role: 'assistant', content: 'Recovered legacy answer', status: 'complete', error_code: null },
    ]);

    const recoveredAssistant = recovered.body.messages[1];
    const archivedFailure = db.prepare(
      'SELECT content,status,error_code,source FROM message_versions WHERE message_id=?',
    ).get(recoveredAssistant.id);
    assert.deepEqual(archivedFailure, {
      content: '',
      status: 'failed',
      error_code: 'AI_PROVIDER_AUTH_FAILED',
      source: 'retry',
    });

    const usage = db.prepare(
      'SELECT operation,status,error_code FROM ai_usage WHERE user_id=(SELECT id FROM users WHERE email=?) ORDER BY id',
    ).all('legacy-json-failure@example.com');
    assert.deepEqual(usage, [
      { operation: 'chat', status: 'failed', error_code: 'AI_PROVIDER_AUTH_FAILED' },
      { operation: 'retry', status: 'succeeded', error_code: null },
    ]);
  } finally {
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    if (providerServer?.listening) {
      providerServer.closeAllConnections?.();
      await new Promise((resolve) => providerServer.close(resolve));
      providerServer = null;
    }
  }
});
