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
before(async () => {
  const [{ createApp }, database] = await Promise.all([import('../src/app.js'), import('../src/db.js')]);
  app = createApp();
  db = database.db;
});
after(() => {
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const originHeaders = { Origin: 'http://localhost:5173', 'X-Requested-With': 'NOVA-Web' };

test('health endpoint reports AI adapter as unconfigured without credentials', async () => {
  const response = await request(app).get('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.ai.configured, false);
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
  await agent.put(`/api/projects/${id}`).set(originHeaders).send({ title: 'Updated project', description: '', content: 'published draft' }).expect(200);
  await agent.delete(`/api/projects/${id}`).set(originHeaders).expect(200);
  await agent.get(`/api/projects/${id}`).set(originHeaders).expect(404);
});

test('mutating requests without the application request header are rejected', async () => {
  const response = await request(app).post('/api/auth/login').set('Origin', 'http://localhost:5173').send({ email: 'test@example.com', password: 'a-strong-test-password' });
  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'MISSING_REQUEST_HEADER');
});

test('AI chat does not invent a response when no provider is configured', async () => {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set(originHeaders).send({ email: 'test@example.com', password: 'a-strong-test-password' }).expect(200);
  const conv = await agent.post('/api/conversations').set(originHeaders).send({ title: 'Test chat' }).expect(201);
  const response = await agent.post(`/api/conversations/${conv.body.conversation.id}/messages`).set(originHeaders).send({ content: 'Hello' });
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'AI_PROVIDER_NOT_CONFIGURED');
});
