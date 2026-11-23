import { createServer } from 'node:http';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-provider-stream-'));
process.env.NODE_ENV = 'test';
process.env.PORT = '4000';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.SESSION_SECRET = 'provider-stream-test-session-secret-at-least-32-characters';
process.env.PROVIDER_ENCRYPTION_KEY = 'provider-stream-test-encryption-key-at-least-32-characters';
process.env.DB_PATH = path.join(tempDir, 'test.sqlite');
process.env.AI_BASE_URL = '';
process.env.AI_API_KEY = '';
process.env.AI_MODEL = '';
process.env.AI_PROVIDERS_JSON = '';
process.env.AI_DEFAULT_MODEL = '';

let app;
let db;
let config;
let providerServer;

const originHeaders = {
  Origin: 'http://localhost:5173',
  'X-Requested-With': 'NOVA-Web',
};

before(async () => {
  const [{ createApp }, database, appConfig] = await Promise.all([
    import('../src/app.js'),
    import('../src/db.js'),
    import('../src/config.js'),
  ]);
  app = createApp();
  db = database.db;
  config = appConfig.config;

  providerServer = createServer((incoming, outgoing) => {
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => { body += chunk; });
    incoming.on('end', () => {
      const payload = JSON.parse(body);
      const prompt = payload.messages.at(-1).content;
      outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });

      if (prompt.includes('trigger-truncated-stream')) {
        outgoing.end('data: {"choices":[{"delta":{"content":"Partial answer"}}]}\n\n');
        return;
      }

      // The final [DONE] event is intentionally terminated by EOF without a
      // trailing blank line. The adapter must flush this final event correctly.
      outgoing.end('data: {"choices":[{"delta":{"content":"Recovered answer"}}]}\n\ndata: [DONE]');
    });
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));

  config.aiBaseUrl = 'http://127.0.0.1:' + providerServer.address().port + '/v1';
  config.aiApiKey = 'provider-stream-test-server-only-secret';
  config.aiModel = 'mock-stream-model';
  config.aiTimeoutMs = 5000;
});

after(async () => {
  if (providerServer?.listening) {
    await new Promise((resolve) => providerServer.close(resolve));
  }
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function readSseResponse(incoming, callback) {
  let result = '';
  incoming.setEncoding('utf8');
  incoming.on('data', (chunk) => { result += chunk; });
  incoming.on('end', () => callback(null, result));
  incoming.on('error', callback);
}

test('truncated provider SSE is persisted as failed, preserves partial text, and releases the generation lock', async () => {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/register').set(originHeaders).send({
    email: 'provider-stream@example.com',
    name: 'Provider Stream Tester',
    password: 'provider-stream-test-password-strong',
  }).expect(201);

  const created = await agent.post('/api/v1/conversations').set(originHeaders)
    .send({ title: 'Provider stream lifecycle' }).expect(201);
  const conversationId = created.body.conversation.id;
  const streamUrl = '/api/v1/conversations/' + conversationId + '/messages/stream';

  const truncated = await agent.post(streamUrl).set(originHeaders)
    .send({ content: 'trigger-truncated-stream' })
    .buffer(true)
    .parse(readSseResponse)
    .expect(200);

  assert.match(truncated.body, /event: message_delta/);
  assert.match(truncated.body, /Partial answer/);
  assert.match(truncated.body, /event: message_error/);
  assert.match(truncated.body, /"code":"AI_INVALID_STREAM"/);
  assert.equal(truncated.body.includes('provider-stream-test-server-only-secret'), false);

  const failed = db.prepare(
    "SELECT content,status,error_code FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY id DESC LIMIT 1",
  ).get(conversationId);
  assert.deepEqual(failed, {
    content: 'Partial answer',
    status: 'failed',
    error_code: 'AI_INVALID_STREAM',
  });

  // A second request proves the failure path released the per-user generation lock.
  const recovered = await agent.post(streamUrl).set(originHeaders)
    .send({ content: 'continue after truncated stream' })
    .buffer(true)
    .parse(readSseResponse)
    .expect(200);

  assert.match(recovered.body, /event: message_delta/);
  assert.match(recovered.body, /Recovered answer/);
  assert.match(recovered.body, /event: message_complete/);

  const assistants = db.prepare(
    "SELECT content,status,error_code FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY id",
  ).all(conversationId);
  assert.deepEqual(assistants, [
    { content: 'Partial answer', status: 'failed', error_code: 'AI_INVALID_STREAM' },
    { content: 'Recovered answer', status: 'complete', error_code: null },
  ]);
});
