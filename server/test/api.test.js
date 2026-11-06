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
process.env.PROVIDER_ENCRYPTION_KEY = 'test-provider-encryption-key-with-32-plus-characters';
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

test('project context instructions and files enforce owner isolation, versioning, validation and opt-in', async () => {
  const owner = request.agent(app);
  const other = request.agent(app);
  await owner.post('/api/v1/auth/register').set(originHeaders).send({
    email: 'project-files-owner@example.com',
    name: 'Project File Owner',
    password: 'project-files-owner-password-strong',
  }).expect(201);
  await other.post('/api/v1/auth/register').set(originHeaders).send({
    email: 'project-files-other@example.com',
    name: 'Other Project User',
    password: 'project-files-other-password-strong',
  }).expect(201);

  const ownProject = await owner.post('/api/v1/projects').set(originHeaders)
    .send({ title: 'Context project' }).expect(201);
  const foreignProject = await other.post('/api/v1/projects').set(originHeaders)
    .send({ title: 'Foreign project' }).expect(201);
  const projectId = ownProject.body.project.id;

  const context = await owner.get('/api/v1/projects/' + projectId + '/context').expect(200);
  assert.equal(context.body.project.instructions, '');
  assert.equal(context.body.project.instructionsVersion, 1);
  assert.deepEqual(context.body.files, []);

  const savedInstructions = await owner.put('/api/v1/projects/' + projectId + '/context')
    .set(originHeaders).send({ instructions: 'Prefer concise technical answers.', expectedVersion: 1 }).expect(200);
  assert.equal(savedInstructions.body.project.instructionsVersion, 2);
  assert.equal(savedInstructions.body.project.instructions, 'Prefer concise technical answers.');
  await owner.put('/api/v1/projects/' + projectId + '/context').set(originHeaders)
    .send({ instructions: 'A stale edit', expectedVersion: 1 }).expect(409);
  await owner.put('/api/v1/projects/' + projectId + '/context').set(originHeaders)
    .send({ instructions: 'x'.repeat(16001), expectedVersion: 2 }).expect(400);
  await owner.get('/api/v1/projects/' + foreignProject.body.project.id + '/context').expect(404);

  const markdown = Buffer.from('# Project reference\nOnly include this after the owner opts in.', 'utf8');
  const uploaded = await owner.post('/api/v1/projects/' + projectId + '/files')
    .set(originHeaders).set('Content-Type', 'application/octet-stream')
    .set('X-File-Name', encodeURIComponent('project-notes.md')).send(markdown).expect(201);
  const fileId = uploaded.body.file.id;
  assert.equal(uploaded.body.file.includeInContext, false);
  assert.equal(uploaded.body.file.sizeBytes, markdown.length);
  await owner.post('/api/v1/projects/' + projectId + '/files')
    .set(originHeaders).set('Content-Type', 'application/octet-stream')
    .set('X-File-Name', encodeURIComponent('duplicate.md')).send(markdown).expect(409);
  await owner.post('/api/v1/projects/' + projectId + '/files')
    .set(originHeaders).set('Content-Type', 'application/octet-stream')
    .set('X-File-Name', encodeURIComponent('unsafe.pdf')).send(Buffer.from('%PDF-1.7')).expect(415);
  await owner.post('/api/v1/projects/' + projectId + '/files')
    .set(originHeaders).set('Content-Type', 'application/octet-stream')
    .set('X-File-Name', encodeURIComponent('bad.json')).send(Buffer.from('{ invalid }')).expect(400);
  await owner.post('/api/v1/projects/' + projectId + '/files')
    .set(originHeaders).set('Content-Type', 'application/octet-stream')
    .set('X-File-Name', encodeURIComponent('bad-encoding.txt')).send(Buffer.from([0xff, 0xfe])).expect(415);

  const listed = await owner.get('/api/v1/projects/' + projectId + '/files').expect(200);
  assert.equal(listed.body.files.length, 1);
  assert.equal(listed.body.files[0].includeInContext, false);
  assert.equal(Object.hasOwn(listed.body.files[0], 'content'), false);
  const included = await owner.patch('/api/v1/projects/' + projectId + '/files/' + fileId)
    .set(originHeaders).send({ includeInContext: true }).expect(200);
  assert.equal(included.body.files[0].includeInContext, true);
  const stored = db.prepare('SELECT extracted_text,include_in_context FROM project_files WHERE id=?').get(fileId);
  assert.equal(stored.extracted_text, markdown.toString('utf8'));
  assert.equal(stored.include_in_context, 1);
  await owner.patch('/api/v1/projects/' + projectId + '/files/' + fileId)
    .set(originHeaders).send({ includeInContext: false }).expect(200);

  const downloaded = await owner.get('/api/v1/projects/' + projectId + '/files/' + fileId + '/download')
    .buffer(true).parse((incoming, callback) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => callback(null, Buffer.concat(chunks)));
      incoming.on('error', callback);
    }).expect(200);
  assert.equal(downloaded.body.toString('utf8'), markdown.toString('utf8'));
  await other.get('/api/v1/projects/' + projectId + '/files').expect(404);
  await other.get('/api/v1/projects/' + projectId + '/files/' + fileId + '/download').expect(404);
  await other.delete('/api/v1/projects/' + projectId + '/files/' + fileId).set(originHeaders).expect(404);
  await owner.post('/api/v1/projects/' + foreignProject.body.project.id + '/files')
    .set(originHeaders).set('Content-Type', 'application/octet-stream')
    .set('X-File-Name', encodeURIComponent('cross-owner.md')).send(markdown).expect(404);

  await owner.delete('/api/v1/projects/' + projectId).set(originHeaders).expect(200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM project_files WHERE project_id=?').get(projectId).count, 0);
});

test('documents API enforces ownership, project isolation, validation, and optimistic concurrency', async () => {
  const owner = request.agent(app);
  const other = request.agent(app);
  await owner.post('/api/v1/auth/register').set(originHeaders).send({
    email: 'documents-owner@example.com',
    name: 'Document Owner',
    password: 'documents-owner-password-strong',
  }).expect(201);
  await other.post('/api/v1/auth/register').set(originHeaders).send({
    email: 'documents-other@example.com',
    name: 'Other Document User',
    password: 'documents-other-password-strong',
  }).expect(201);

  const ownerProject = await owner.post('/api/v1/projects').set(originHeaders)
    .send({ title: 'Owner project' }).expect(201);
  const otherProject = await other.post('/api/v1/projects').set(originHeaders)
    .send({ title: 'Other project' }).expect(201);
  const ownerId = db.prepare('SELECT id FROM users WHERE email=?').get('documents-owner@example.com').id;

  const created = await owner.post('/api/v1/documents').set(originHeaders).send({
    title: 'Research notes',
    content: '# First draft\nPrivate Markdown content',
    projectId: ownerProject.body.project.id,
  }).expect(201);
  const document = created.body.document;
  await owner.post('/api/v1/documents').set(originHeaders).send({
    title: '   ',
    content: 'invalid title',
  }).expect(400);
  await owner.post('/api/v1/documents').set(originHeaders).send({
    title: 'Oversized document',
    content: 'x'.repeat(200001),
  }).expect(400);
  await owner.put('/api/v1/documents/' + document.id).set(originHeaders).send({
    title: 'Missing version',
  }).expect(400);
  assert.equal(document.title, 'Research notes');
  assert.equal(document.projectId, ownerProject.body.project.id);
  assert.equal(document.version, 1);
  assert.equal(document.content, '# First draft\nPrivate Markdown content');

  await owner.get('/api/v1/documents').expect(200).then((response) => {
    assert.equal(response.body.total, 1);
    assert.equal(response.body.documents[0].contentLength, document.content.length);
    assert.equal(Object.hasOwn(response.body.documents[0], 'content'), false);
  });
  await owner.get('/api/v1/documents?q=research&projectId=' + ownerProject.body.project.id)
    .expect(200).then((response) => assert.equal(response.body.documents.length, 1));
  await owner.get('/api/v1/documents?limit=0').expect(400);
  await owner.get('/api/v1/documents?projectId=' + otherProject.body.project.id).expect(404);

  const detail = await owner.get('/api/v1/documents/' + document.id).expect(200);
  assert.equal(detail.body.document.content, document.content);
  assert.equal(detail.body.document.version, 1);

  const updated = await owner.put('/api/v1/documents/' + document.id).set(originHeaders).send({
    title: 'Research notes edited',
    content: '# Updated draft\nNew content',
    expectedVersion: 1,
  }).expect(200);
  assert.equal(updated.body.document.version, 2);
  assert.equal(updated.body.document.projectId, ownerProject.body.project.id);
  assert.equal(updated.body.document.content, '# Updated draft\nNew content');

  const conflict = await owner.put('/api/v1/documents/' + document.id).set(originHeaders).send({
    content: 'stale editor content',
    expectedVersion: 1,
  }).expect(409);
  assert.equal(conflict.body.error, 'DOCUMENT_VERSION_CONFLICT');
  assert.equal(conflict.body.currentVersion, 2);

  await owner.post('/api/v1/documents').set(originHeaders).send({
    title: 'Cross-project attempt',
    projectId: otherProject.body.project.id,
  }).expect(404);
  await owner.put('/api/v1/documents/' + document.id).set(originHeaders).send({
    projectId: otherProject.body.project.id,
    expectedVersion: 2,
  }).expect(404);
  assert.throws(() => db.prepare(
    'INSERT INTO documents(user_id,project_id,title,content) VALUES(?,?,?,?)',
  ).run(ownerId, otherProject.body.project.id, 'Trigger guard', ''), /document_project_owner_mismatch/);

  await other.get('/api/v1/documents/' + document.id).expect(404);
  await other.put('/api/v1/documents/' + document.id).set(originHeaders).send({
    title: 'Should not be allowed',
    expectedVersion: 2,
  }).expect(404);
  await other.delete('/api/v1/documents/' + document.id).set(originHeaders).expect(404);
  assert.equal(db.prepare('SELECT title FROM documents WHERE id=? AND user_id=?')
    .get(document.id, ownerId).title, 'Research notes edited');

  await owner.delete('/api/v1/projects/' + ownerProject.body.project.id).set(originHeaders).expect(200);
  const unlinked = await owner.get('/api/v1/documents/' + document.id).expect(200);
  assert.equal(unlinked.body.document.projectId, null);

  await owner.delete('/api/v1/documents/' + document.id).set(originHeaders).expect(200);
  await owner.get('/api/v1/documents/' + document.id).expect(404);
  await owner.delete('/api/v1/documents/not-a-number').set(originHeaders).expect(400);
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
  assert.deepEqual(versions.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7, 8]);
  const versionColumns = new Set(db.prepare('PRAGMA table_info(message_versions)').all().map((column) => column.name));
  assert.ok(versionColumns.has('message_id'));
  assert.ok(versionColumns.has('content'));
  assert.ok(versionColumns.has('source'));
  const usageColumns = new Set(db.prepare('PRAGMA table_info(ai_usage)').all().map((column) => column.name));
  assert.ok(usageColumns.has('request_id'));
  assert.ok(usageColumns.has('provider_id'));
  assert.ok(usageColumns.has('input_tokens'));
  assert.ok(usageColumns.has('status'));
  const providerColumns = new Set(db.prepare('PRAGMA table_info(ai_providers)').all().map((column) => column.name));
  assert.ok(providerColumns.has('api_key_encrypted'));
  assert.ok(providerColumns.has('models_json'));
  assert.ok(providerColumns.has('enabled'));
  const settingsColumns = new Set(db.prepare('PRAGMA table_info(ai_settings)').all().map((column) => column.name));
  assert.ok(settingsColumns.has('key'));
  assert.ok(settingsColumns.has('value'));
  const contextColumns = new Set(db.prepare('PRAGMA table_info(model_context_windows)').all().map((column) => column.name));
  assert.ok(contextColumns.has('provider_id'));
  assert.ok(contextColumns.has('upstream_model_id'));
  assert.ok(contextColumns.has('context_tokens'));
  assert.ok(contextColumns.has('source'));
  assert.ok(contextColumns.has('checked_at'));
  const documentColumns = new Set(db.prepare('PRAGMA table_info(documents)').all().map((column) => column.name));
  assert.ok(documentColumns.has('user_id'));
  assert.ok(documentColumns.has('project_id'));
  assert.ok(documentColumns.has('title'));
  assert.ok(documentColumns.has('content'));
  assert.ok(documentColumns.has('version'));
  const documentTriggers = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='documents'").all().map((row) => row.name));
  assert.ok(documentTriggers.has('documents_project_owner_insert'));
  assert.ok(documentTriggers.has('documents_project_owner_update'));
  const projectColumns = new Set(db.prepare('PRAGMA table_info(projects)').all().map((column) => column.name));
  assert.ok(projectColumns.has('instructions'));
  assert.ok(projectColumns.has('instructions_version'));
  const projectFileColumns = new Set(db.prepare('PRAGMA table_info(project_files)').all().map((column) => column.name));
  assert.ok(projectFileColumns.has('project_id'));
  assert.ok(projectFileColumns.has('user_id'));
  assert.ok(projectFileColumns.has('content'));
  assert.ok(projectFileColumns.has('extracted_text'));
  assert.ok(projectFileColumns.has('include_in_context'));
  const projectFileTriggers = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='project_files'").all().map((row) => row.name));
  assert.ok(projectFileTriggers.has('project_files_owner_insert'));
  assert.ok(projectFileTriggers.has('project_files_owner_update'));
});

test('versioned models endpoint does not claim an unconfigured model is connected', async () => {
  const response = await request(app).get('/api/v1/models').expect(200);
  assert.equal(response.body.configured, false);
  assert.deepEqual(response.body.models, []);
  assert.deepEqual(response.body.contextPolicy, { maxMessageContentCharacters: 40000, outputReserveTokens: 2048, safetyMarginPercent: 10, mode: 'per_model', note: '模型上下文上限和输入 Token 数会分别标注来源；字符预算始终作为额外硬限制。' });
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
        outgoing.write('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n');
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
    const usage = db.prepare(
      'SELECT request_id,provider_id,model_id,operation,status,duration_ms,input_tokens,output_tokens,total_tokens,usage_source FROM ai_usage WHERE user_id=(SELECT id FROM users WHERE email=?) ORDER BY id DESC LIMIT 1',
    ).get('test@example.com');
    assert.equal(typeof usage.request_id, 'string');
    assert.equal(usage.provider_id, 'openai-compatible');
    assert.equal(usage.model_id, 'mock-chat-model');
    assert.equal(usage.operation, 'stream');
    assert.equal(usage.status, 'succeeded');
    assert.ok(usage.duration_ms >= 0);
    assert.equal(usage.input_tokens, 7);
    assert.equal(usage.output_tokens, 3);
    assert.equal(usage.total_tokens, 10);
    assert.equal(usage.usage_source, 'provider');
    assert.ok(response.body.includes(usage.request_id));
  } finally {
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    await new Promise((resolve) => providerServer.close(resolve));
    providerServer = null;
  }
});




test('legacy JSON chat stores Provider-reported usage and returns a request reference', async () => {
  providerServer = createServer((incoming, outgoing) => {
    incoming.resume();
    incoming.on('end', () => {
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({
        choices: [{ message: { content: 'Legacy JSON response' } }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
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
  config.aiApiKey = 'json-usage-test-secret';
  config.aiModel = 'mock-json-usage-model';

  try {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/register').set(originHeaders).send({
      email: 'json-usage@example.com',
      name: 'JSON Usage Tester',
      password: 'json-usage-password-strong',
    }).expect(201);
    const created = await agent.post('/api/v1/conversations').set(originHeaders)
      .send({ title: 'JSON Usage' }).expect(201);
    const response = await agent.post('/api/v1/conversations/' + created.body.conversation.id + '/messages')
      .set(originHeaders).send({ content: 'Please return JSON usage' }).expect(201);

    assert.equal(response.body.assistantMessage.content, 'Legacy JSON response');
    assert.equal(typeof response.body.requestId, 'string');
    assert.equal(JSON.stringify(response.body).includes('json-usage-test-secret'), false);
    const usage = db.prepare(
      'SELECT request_id,operation,status,input_tokens,output_tokens,total_tokens,usage_source FROM ai_usage WHERE request_id=?',
    ).get(response.body.requestId);
    assert.deepEqual(usage, {
      request_id: response.body.requestId,
      operation: 'chat',
      status: 'succeeded',
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
      usage_source: 'provider',
    });
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
      } else if (prompt.includes('provider-400')) {
        outgoing.writeHead(400, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({ error: 'invalid provider request detail' }));
      } else if (prompt.includes('provider-invalid-json')) {
        outgoing.writeHead(200, { 'Content-Type': 'application/json' });
        outgoing.end('{ malformed json');
      } else if (prompt.includes('provider-network-error')) {
        incoming.socket.destroy();
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
    const cases = [
      ['provider-401', 'AI_PROVIDER_AUTH_FAILED'],
      ['provider-403', 'AI_PROVIDER_AUTH_FAILED'],
      ['provider-400', 'AI_PROVIDER_REJECTED'],
      ['provider-429', 'AI_PROVIDER_RATE_LIMITED'],
      ['provider-503', 'AI_PROVIDER_UNAVAILABLE'],
      ['provider-empty', 'AI_EMPTY_RESPONSE'],
      ['provider-malformed', 'AI_INVALID_STREAM'],
      ['provider-invalid-json', 'AI_INVALID_RESPONSE'],
      ['provider-network-error', 'AI_PROVIDER_UNREACHABLE'],
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const [prompt, code] = cases[index];
      const email = 'provider-errors-' + index + '@example.com';
      const agent = request.agent(app);
      await agent.post('/api/v1/auth/register').set(originHeaders).send({
        email,
        name: 'Provider Error Tester ' + index,
        password: 'provider-error-password-strong',
      }).expect(201);
      const created = await agent.post('/api/v1/conversations').set(originHeaders)
        .send({ title: 'Provider errors' }).expect(201);
      const id = created.body.conversation.id;
      const url = '/api/v1/conversations/' + id + '/messages/stream';
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
      assert.equal(response.body.includes('invalid provider request detail'), false);

      const saved = db.prepare(
        "SELECT status,error_code FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY id DESC LIMIT 1",
      ).get(id);
      assert.deepEqual(saved, { status: 'failed', error_code: code });
      const usage = db.prepare(
        'SELECT status,error_code,usage_source,input_tokens FROM ai_usage WHERE user_id=(SELECT id FROM users WHERE email=?) ORDER BY id DESC LIMIT 1',
      ).get(email);
      assert.equal(usage.status, 'failed');
      assert.equal(usage.error_code, code);
      assert.equal(usage.usage_source, null);
      assert.equal(usage.input_tokens, null);
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



test('model-aware token estimation labels exact tokenizer and unknown-provider fallbacks', async () => {
  const { countPromptTokens, resolveTokenizer } = await import('../src/services/token-budget.js');
  assert.equal(resolveTokenizer({ upstreamModelId: 'gpt-4o-mini', tokenizer: 'auto' }), 'o200k_base');
  assert.equal(resolveTokenizer({ upstreamModelId: 'gpt-4.1', tokenizer: 'auto' }), 'o200k_base');
  assert.equal(resolveTokenizer({ upstreamModelId: 'gpt-4', tokenizer: 'auto' }), 'cl100k_base');
  assert.equal(resolveTokenizer({ upstreamModelId: 'deepseek-chat', tokenizer: 'auto' }), null);

  const messages = [{ role: 'user', content: 'hello 世界' }];
  const estimated = countPromptTokens(messages, { tokenizer: 'o200k_base' });
  assert.equal(estimated.source, 'tokenizer_estimate');
  assert.equal(estimated.tokenizer, 'o200k_base');
  assert.ok(Number.isSafeInteger(estimated.tokens) && estimated.tokens > 0);

  const unknown = countPromptTokens(messages, { upstreamModelId: 'deepseek-chat', tokenizer: 'auto' });
  assert.equal(unknown.source, 'unknown');
  assert.equal(unknown.tokens, null);

  const upperBound = countPromptTokens(messages, { upstreamModelId: 'deepseek-chat', tokenizer: 'auto' }, {
    allowByteUpperBound: true,
  });
  assert.equal(upperBound.source, 'byte_upper_bound');
  assert.equal(upperBound.confidence, 'conservative');
  assert.ok(upperBound.tokens >= Buffer.byteLength('userhello 世界', 'utf8'));
});

test('model context budget keeps the newest complete turn and preserves current input', async () => {
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
    aiProvidersJson: config.aiProvidersJson,
    aiDefaultModelId: config.aiDefaultModelId,
    aiMaxContextChars: config.aiMaxContextChars,
    aiContextOutputReserve: config.aiContextOutputReserve,
    aiContextSafetyMarginPercent: config.aiContextSafetyMarginPercent,
  };
  config.aiBaseUrl = '';
  config.aiApiKey = '';
  config.aiModel = '';
  config.aiProvidersJson = JSON.stringify([{
    id: 'context-test',
    name: 'Context Test Provider',
    baseUrl: 'http://127.0.0.1:' + providerServer.address().port + '/v1',
    apiKey: 'context-test-secret',
    enabled: true,
    models: [{ id: 'gpt-5-mini', contextLimit: 1024, tokenizer: 'auto' }],
  }]);
  config.aiDefaultModelId = 'context-test:gpt-5-mini';
  config.aiMaxContextChars = 30;
  config.aiContextOutputReserve = 128;
  config.aiContextSafetyMarginPercent = 10;

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
    assert.match(response.body, /"modelContextWindowTokens":1024/);
    assert.match(response.body, /"modelContextWindowSource":"environment_configured"/);
    assert.match(response.body, /"tokenEstimateSource":"tokenizer_estimate"/);
    assert.match(response.body, /"historyTruncated":true/);
    assert.match(response.body, /"currentMessagePreserved":true/);
    assert.match(response.body, /"outputReserveTokens":128/);
    assert.match(response.body, /"outputLimitEnforced":true/);
    assert.equal(providerRequest.max_completion_tokens, 128);
    assert.equal(Object.hasOwn(providerRequest, 'max_tokens'), false);
    assert.equal(Object.hasOwn(providerRequest, 'temperature'), false);
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

    config.aiMaxContextChars = 40000;
    config.aiProvidersJson = JSON.stringify([{
      id: 'context-test',
      name: 'Context Test Provider',
      baseUrl: 'http://127.0.0.1:' + providerServer.address().port + '/v1',
      apiKey: 'context-test-secret',
      enabled: true,
      models: [{ id: 'gpt-5-mini', contextLimit: 256, tokenizer: 'auto' }],
    }]);
    const tokenLimitedContent = '中文'.repeat(100);
    const tokenTooLarge = await agent.post('/api/v1/conversations/' + id + '/messages/stream')
      .set(originHeaders).send({ content: tokenLimitedContent }).expect(413);
    assert.equal(tokenTooLarge.body.error, 'AI_INPUT_TOO_LARGE');
    assert.equal(tokenTooLarge.body.contextPolicy.modelContextWindowTokens, 256);
    assert.equal(tokenTooLarge.body.contextPolicy.currentMessagePreserved, true);
    assert.ok(tokenTooLarge.body.contextPolicy.estimatedInputTokens > tokenTooLarge.body.contextPolicy.inputTokenBudget);
    const savedTokenOversized = db.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE conversation_id=? AND role=\'user\' AND content=?',
    ).get(id, tokenLimitedContent);
    assert.equal(savedTokenOversized.count, 0);

    config.aiProvidersJson = JSON.stringify([{
      id: 'context-test',
      name: 'Context Test Provider',
      baseUrl: 'http://127.0.0.1:' + providerServer.address().port + '/v1',
      apiKey: 'context-test-secret',
      enabled: true,
      models: [{
        id: 'gpt-4o-mini',
        contextLimit: 1024,
        tokenizer: 'o200k_base',
        maxTokensParameter: 'max_tokens',
      }],
    }]);
    config.aiDefaultModelId = 'context-test:gpt-4o-mini';
    const compatibleResponse = await agent.post('/api/v1/conversations/' + id + '/messages/stream')
      .set(originHeaders).send({ content: 'test max tokens parameter' })
      .buffer(true)
      .parse((incoming, callback) => {
        let result = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { result += chunk; });
        incoming.on('end', () => callback(null, result));
        incoming.on('error', callback);
      }).expect(200);
    assert.match(compatibleResponse.body, /"outputLimitEnforced":true/);
    assert.equal(providerRequest.max_tokens, 128);
    assert.equal(Object.hasOwn(providerRequest, 'max_completion_tokens'), false);
    assert.equal(providerRequest.temperature, 0.7);

    config.aiProvidersJson = JSON.stringify([{
      id: 'context-test',
      name: 'Context Test Provider',
      baseUrl: 'http://127.0.0.1:' + providerServer.address().port + '/v1',
      apiKey: 'context-test-secret',
      enabled: true,
      models: [{
        id: 'deepseek-chat',
        contextLimit: 1024,
        tokenizer: 'none',
        maxTokensParameter: 'none',
      }],
    }]);
    config.aiDefaultModelId = 'context-test:deepseek-chat';
    const noOutputCapResponse = await agent.post('/api/v1/conversations/' + id + '/messages/stream')
      .set(originHeaders).send({ content: 'test provider without output cap' })
      .buffer(true)
      .parse((incoming, callback) => {
        let result = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { result += chunk; });
        incoming.on('end', () => callback(null, result));
        incoming.on('error', callback);
      }).expect(200);
    assert.match(noOutputCapResponse.body, /"outputLimitEnforced":false/);
    assert.equal(Object.hasOwn(providerRequest, 'max_tokens'), false);
    assert.equal(Object.hasOwn(providerRequest, 'max_completion_tokens'), false);
    assert.equal(providerRequest.temperature, 0.7);
  } finally {
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    config.aiProvidersJson = previous.aiProvidersJson;
    config.aiDefaultModelId = previous.aiDefaultModelId;
    config.aiMaxContextChars = previous.aiMaxContextChars;
    config.aiContextOutputReserve = previous.aiContextOutputReserve;
    config.aiContextSafetyMarginPercent = previous.aiContextSafetyMarginPercent;
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
    const cancelledUsage = db.prepare(
      "SELECT status,error_code FROM ai_usage WHERE user_id=(SELECT id FROM users WHERE email=?) ORDER BY id DESC LIMIT 1",
    ).get('provider-cancel@example.com');
    assert.deepEqual(cancelledUsage, { status: 'cancelled', error_code: 'AI_REQUEST_CANCELLED' });
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
    const lastAssistant = db.prepare(
      "SELECT id FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY id DESC LIMIT 1",
    ).get(conversationId);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM message_versions WHERE message_id=?').get(lastAssistant.id).count, 0);
    assert.deepEqual(saved, [
      { role: 'user', content: 'original first question', status: 'complete' },
      { role: 'assistant', content: 'original first answer', status: 'complete' },
      { role: 'user', content: 'original later question', status: 'complete' },
      { role: 'assistant', content: 'original later answer', status: 'complete' },
    ]);
    const usage = db.prepare("SELECT operation,status,error_code FROM ai_usage WHERE user_id=(SELECT id FROM users WHERE email=?) ORDER BY id DESC LIMIT 1").get('message-edit-failure@example.com');
    assert.deepEqual(usage, { operation: 'edit', status: 'failed', error_code: 'AI_PROVIDER_UNAVAILABLE' });
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
    const usage = db.prepare("SELECT operation,status,error_code FROM ai_usage WHERE user_id=(SELECT id FROM users WHERE email=?) ORDER BY id DESC LIMIT 1").get('message-edit@example.com');
    assert.deepEqual(usage, { operation: 'edit', status: 'succeeded', error_code: null });
    const currentAssistant = db.prepare(
      "SELECT id FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY id DESC LIMIT 1",
    ).get(conversationId);
    const versionsResponse = await owner.get(
      '/api/v1/conversations/' + conversationId + '/messages/' + currentAssistant.id + '/versions',
    ).set(originHeaders).expect(200);
    assert.equal(versionsResponse.body.versions.length, 1);
    assert.equal(versionsResponse.body.versions[0].content, 'old response');
    assert.equal(versionsResponse.body.versions[0].source, 'edit_regeneration');
    await other.get(
      '/api/v1/conversations/' + conversationId + '/messages/' + currentAssistant.id + '/versions',
    ).set(originHeaders).expect(404);
    await other.post(
      '/api/v1/conversations/' + conversationId + '/messages/' + currentAssistant.id + '/restore',
    ).set(originHeaders).send({ versionId: versionsResponse.body.versions[0].id }).expect(404);

    const restored = await owner.post(
      '/api/v1/conversations/' + conversationId + '/messages/' + currentAssistant.id + '/restore',
    ).set(originHeaders).send({ versionId: versionsResponse.body.versions[0].id }).expect(200);
    assert.equal(restored.body.message.content, 'old response');
    assert.equal(restored.body.message.status, 'complete');
    assert.equal(restored.body.message.version_count, 1);
    assert.equal(restored.body.versions.length, 1);
    assert.equal(restored.body.versions[0].content, 'Rewritten assistant message');
    assert.equal(restored.body.versions[0].source, 'restore');

    await owner.put(
      '/api/v1/conversations/' + conversationId + '/messages/' + target.lastInsertRowid + '/stream',
    ).set(originHeaders).send({ content: 'edited again' })
      .buffer(true)
      .parse((incoming, callback) => {
        let result = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk) => { result += chunk; });
        incoming.on('end', () => callback(null, result));
        incoming.on('error', callback);
      }).expect(200);
    const newestAssistant = db.prepare(
      "SELECT id FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY id DESC LIMIT 1",
    ).get(conversationId);
    const carriedVersions = await owner.get(
      '/api/v1/conversations/' + conversationId + '/messages/' + newestAssistant.id + '/versions',
    ).set(originHeaders).expect(200);
    assert.deepEqual(carriedVersions.body.versions.map((version) => version.content), [
      'old response',
      'Rewritten assistant message',
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
    const usage = db.prepare("SELECT operation,status,error_code FROM ai_usage WHERE user_id=(SELECT id FROM users WHERE email=?) ORDER BY id DESC LIMIT 1").get('message-retry@example.com');
    assert.deepEqual(usage, { operation: 'retry', status: 'succeeded', error_code: null });
    const currentAssistant = db.prepare(
      "SELECT id,version_count FROM (SELECT id,(SELECT COUNT(*) FROM message_versions v WHERE v.message_id=messages.id) AS version_count FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY id DESC LIMIT 1)",
    ).get(id);
    const versions = db.prepare(
      'SELECT content,status,source FROM message_versions WHERE message_id=? ORDER BY id DESC',
    ).all(currentAssistant.id);
    assert.equal(currentAssistant.version_count, 1);
    assert.deepEqual(versions, [{
      content: 'partial broken output',
      status: 'failed',
      source: 'retry',
    }]);
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
    const usage = db.prepare("SELECT operation,status,error_code FROM ai_usage WHERE user_id=(SELECT id FROM users WHERE email=?) ORDER BY id DESC LIMIT 1").get('message-retry-failure@example.com');
    assert.deepEqual(usage, { operation: 'retry', status: 'failed', error_code: 'AI_PROVIDER_UNAVAILABLE' });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM message_versions WHERE message_id=?')
      .get(db.prepare("SELECT id FROM messages WHERE conversation_id=? AND role='assistant'").get(id).id).count, 0);
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


test('account export includes owned work but excludes password and session credentials', async () => {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/register').set(originHeaders).send({
    email: 'account-export@example.com',
    name: 'Account Export Tester',
    password: 'account-export-password-strong',
  }).expect(201);
  const project = await agent.post('/api/v1/projects').set(originHeaders)
    .send({ title: 'Export project', description: 'private description', content: 'project notes' }).expect(201);
  const exportedDocument = await agent.post('/api/v1/documents').set(originHeaders).send({
    title: 'Exported document',
    content: '# Account document',
    projectId: project.body.project.id,
  }).expect(201);
  await agent.put('/api/v1/projects/' + project.body.project.id + '/context').set(originHeaders)
    .send({ instructions: 'Use the exported project instructions.', expectedVersion: 1 }).expect(200);
  const exportedProjectFileBytes = Buffer.from('# Exported project file\n');
  const exportedProjectFile = await agent.post('/api/v1/projects/' + project.body.project.id + '/files')
    .set(originHeaders).set('Content-Type', 'application/octet-stream')
    .set('X-File-Name', encodeURIComponent('exported-reference.md'))
    .send(exportedProjectFileBytes).expect(201);
  const conversation = await agent.post('/api/v1/conversations').set(originHeaders)
    .send({ title: 'Export conversation' }).expect(201);
  const exportedUserMessage = db.prepare('INSERT INTO messages(conversation_id,role,content) VALUES(?,?,?)')
    .run(conversation.body.conversation.id, 'user', 'My private chat message');
  const exportedAssistantMessage = db.prepare('INSERT INTO messages(conversation_id,role,content) VALUES(?,?,?)')
    .run(conversation.body.conversation.id, 'assistant', 'Previous assistant answer');
  db.prepare('INSERT INTO message_versions(message_id,content,status,error_code,source) VALUES(?,?,?,?,?)')
    .run(exportedAssistantMessage.lastInsertRowid, 'An older assistant answer', 'complete', null, 'edit_regeneration');
  await agent.post('/api/v1/projects/' + project.body.project.id + '/conversations')
    .set(originHeaders).send({ conversationId: conversation.body.conversation.id }).expect(201);

  const user = db.prepare('SELECT id FROM users WHERE email=?').get('account-export@example.com');
  db.prepare('INSERT INTO articles(slug,title,body,author_id) VALUES(?,?,?,?)')
    .run('account-export-article', 'My authored article', 'Research content', user.id);
  db.prepare("INSERT INTO ai_usage (request_id,user_id,provider_id,model_id,operation,status,duration_ms,input_tokens,output_tokens,total_tokens,usage_source,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)")
    .run('export-usage-request', user.id, 'deepseek', 'deepseek:chat', 'chat', 'succeeded', 420, 9, 3, 12, 'provider');

  const response = await agent.get('/api/v1/auth/export').expect(200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.account.email, 'account-export@example.com');
  assert.equal(response.body.projects.length, 1);
  assert.equal(response.body.projects[0].content, 'project notes');
  assert.equal(response.body.schemaVersion, 6);
  assert.equal(response.body.projects[0].instructions, 'Use the exported project instructions.');
  assert.equal(response.body.projects[0].instructionsVersion, 2);
  assert.equal(response.body.projectFiles.length, 1);
  assert.equal(response.body.projectFiles[0].id, exportedProjectFile.body.file.id);
  assert.equal(response.body.projectFiles[0].contentBase64, exportedProjectFileBytes.toString('base64'));
  assert.equal(response.body.documents.length, 1);
  assert.equal(response.body.documents[0].id, exportedDocument.body.document.id);
  assert.equal(response.body.documents[0].content, '# Account document');
  assert.equal(response.body.conversations.length, 1);
  assert.equal(response.body.messages[0].content, 'My private chat message');
  assert.equal(response.body.messageVersions.length, 1);
  assert.equal(response.body.messageVersions[0].content, 'An older assistant answer');
  assert.equal(response.body.usage.length, 1);
  assert.equal(response.body.usage[0].request_id, 'export-usage-request');
  assert.equal(response.body.usage[0].total_tokens, 12);
  assert.equal(response.body.projectConversationLinks.length, 1);
  assert.equal(response.body.authoredArticles[0].slug, 'account-export-article');

  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes('password_hash'), false);
  assert.equal(serialized.includes('token_hash'), false);
  assert.equal(serialized.includes('nova_session='), false);
  assert.equal(serialized.includes('SESSION_SECRET'), false);
  assert.equal(serialized.includes('AI_API_KEY'), false);
  assert.ok(response.body.excluded.includes('password hashes'));
});

test('account deletion requires password and email confirmation then cascades private data', async () => {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/register').set(originHeaders).send({
    email: 'account-delete@example.com',
    name: 'Account Delete Tester',
    password: 'account-delete-password-strong',
  }).expect(201);
  const project = await agent.post('/api/v1/projects').set(originHeaders)
    .send({ title: 'Delete project', description: '', content: 'delete me' }).expect(201);
  const deleteProjectFileBytes = Buffer.from('# Delete this project file');
  const deletedProjectFile = await agent.post('/api/v1/projects/' + project.body.project.id + '/files')
    .set(originHeaders).set('Content-Type', 'application/octet-stream')
    .set('X-File-Name', encodeURIComponent('delete-this.md'))
    .send(deleteProjectFileBytes).expect(201);
  const deletedDocument = await agent.post('/api/v1/documents').set(originHeaders).send({
    title: 'Document to delete',
    content: 'Private content',
    projectId: project.body.project.id,
  }).expect(201);
  const conversation = await agent.post('/api/v1/conversations').set(originHeaders)
    .send({ title: 'Delete conversation' }).expect(201);
  const user = db.prepare('SELECT id FROM users WHERE email=?').get('account-delete@example.com');
  const projectId = project.body.project.id;
  const conversationId = conversation.body.conversation.id;
  const deletedUserMessage = db.prepare('INSERT INTO messages(conversation_id,role,content) VALUES(?,?,?)')
    .run(conversationId, 'user', 'delete this message');
  const deletedAssistantMessage = db.prepare('INSERT INTO messages(conversation_id,role,content) VALUES(?,?,?)')
    .run(conversationId, 'assistant', 'delete this answer');
  db.prepare('INSERT INTO message_versions(message_id,content,status,source) VALUES(?,?,?,?)')
    .run(deletedAssistantMessage.lastInsertRowid, 'older answer to delete', 'complete', 'retry');
  await agent.post('/api/v1/projects/' + projectId + '/conversations')
    .set(originHeaders).send({ conversationId }).expect(201);
  db.prepare('INSERT INTO articles(slug,title,body,author_id) VALUES(?,?,?,?)')
    .run('account-delete-article', 'Published article', 'Site content remains', user.id);
  db.prepare("INSERT INTO ai_usage (request_id,user_id,provider_id,model_id,operation,status) VALUES (?,?,?,?,?,?)")
    .run('delete-usage-request', user.id, 'deepseek', 'deepseek:chat', 'chat', 'succeeded');

  await agent.delete('/api/v1/auth/me').set(originHeaders)
    .send({ currentPassword: 'wrong-password', confirmEmail: 'account-delete@example.com' })
    .expect(400);
  await agent.delete('/api/v1/auth/me').set(originHeaders)
    .send({ currentPassword: 'account-delete-password-strong', confirmEmail: 'wrong@example.com' })
    .expect(400);
  assert.ok(db.prepare('SELECT id FROM users WHERE id=?').get(user.id));

  const removed = await agent.delete('/api/v1/auth/me').set(originHeaders)
    .send({ currentPassword: 'account-delete-password-strong', confirmEmail: 'account-delete@example.com' })
    .expect(200);
  assert.equal(removed.body.success, true);
  assert.ok(removed.headers['set-cookie']?.some((cookie) => cookie.includes('nova_session=;')));
  await agent.get('/api/v1/auth/me').expect(401);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE id=?').get(user.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get(user.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM projects WHERE user_id=?').get(user.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents WHERE user_id=?').get(user.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents WHERE id=?').get(deletedDocument.body.document.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM project_files WHERE id=?').get(deletedProjectFile.body.file.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE user_id=?').get(user.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?').get(conversationId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM message_versions WHERE message_id=?').get(deletedAssistantMessage.lastInsertRowid).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM project_conversations WHERE user_id=?').get(user.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_usage WHERE user_id=?').get(user.id).count, 0);
  const retainedArticle = db.prepare('SELECT author_id,body FROM articles WHERE slug=?').get('account-delete-article');
  assert.equal(retainedArticle.author_id, null);
  assert.equal(retainedArticle.body, 'Site content remains');
});

test('non-streaming client disconnect aborts upstream request and releases the generation lock', async () => {
  let signalUpstreamStarted;
  let signalUpstreamClosed;
  const upstreamStarted = new Promise((resolve) => { signalUpstreamStarted = resolve; });
  const upstreamClosed = new Promise((resolve) => { signalUpstreamClosed = resolve; });
  let providerCalls = 0;
  providerServer = createServer((incoming, outgoing) => {
    incoming.resume();
    incoming.on('end', () => {
      providerCalls += 1;
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      if (providerCalls === 1) {
        signalUpstreamStarted();
        outgoing.on('close', signalUpstreamClosed);
        return;
      }
      outgoing.end(JSON.stringify({
        choices: [{ message: { content: 'Request after cancellation succeeded' } }],
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
  config.aiApiKey = 'non-stream-cancel-test-secret';
  config.aiModel = 'mock-non-stream-cancel-model';

  const clientServer = createServer(app);
  try {
    const registration = await request(app).post('/api/v1/auth/register').set(originHeaders).send({
      email: 'non-stream-cancel@example.com',
      name: 'Non-stream Cancel Tester',
      password: 'non-stream-cancel-password-strong',
    }).expect(201);
    const cookie = registration.headers['set-cookie']
      .find((value) => value.startsWith('nova_session='))
      .split(';')[0];
    const created = await request(app).post('/api/v1/conversations')
      .set({ ...originHeaders, Cookie: cookie })
      .send({ title: 'Non-stream cancellation test' }).expect(201);
    const conversationId = created.body.conversation.id;

    await new Promise((resolve) => clientServer.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + clientServer.address().port
      + '/api/v1/conversations/' + conversationId + '/messages';

    const controller = new AbortController();
    const abortedRequest = fetch(url, {
      method: 'POST',
      headers: {
        ...originHeaders,
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Cancel this non-streaming request' }),
      signal: controller.signal,
    }).catch((error) => error);

    await Promise.race([
      upstreamStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Provider request did not start')), 1500)),
    ]);
    controller.abort();
    const abortedResult = await abortedRequest;
    assert.equal(abortedResult?.name, 'AbortError');

    await Promise.race([
      upstreamClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Non-streaming provider request was not aborted')), 1500)),
    ]);

    const beforeRecovery = db.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?',
    ).get(conversationId);
    assert.equal(beforeRecovery.count, 0, 'cancelled non-streaming request must not persist a partial turn');

    await new Promise((resolve) => setTimeout(resolve, 30));
    const recovery = await fetch(url, {
      method: 'POST',
      headers: {
        ...originHeaders,
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Try again after cancellation' }),
    });
    assert.equal(recovery.status, 201, 'generation lock should be released after client disconnect');
    const payload = await recovery.json();
    assert.equal(payload.assistantMessage.content, 'Request after cancellation succeeded');
    const recoveredUsage = db.prepare(
      "SELECT status,error_code FROM ai_usage WHERE user_id=(SELECT id FROM users WHERE email=?) ORDER BY id DESC LIMIT 1",
    ).get('non-stream-cancel@example.com');
    assert.deepEqual(recoveredUsage, { status: 'succeeded', error_code: null });
    assert.equal(providerCalls, 2);
  } finally {
    if (clientServer.listening) await new Promise((resolve) => clientServer.close(resolve));
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    if (providerServer?.listening) await new Promise((resolve) => providerServer.close(resolve));
    providerServer = null;
  }
});

test('administrator usage endpoint returns stored records and provider-reported token totals', async () => {
  const admin = request.agent(app);
  await admin.post('/api/v1/auth/register').set(originHeaders).send({
    email: 'usage-admin@example.com',
    name: 'Usage Admin',
    password: 'usage-admin-password-strong',
  }).expect(201);
  const adminUser = db.prepare('SELECT id FROM users WHERE email=?').get('usage-admin@example.com');
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(adminUser.id);
  const baseline = db.prepare(`
    SELECT COUNT(*) AS requests,
      SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN usage_source='provider' THEN 1 ELSE 0 END) AS providerReportedRequests,
      COALESCE(SUM(input_tokens),0) AS reportedInputTokens,
      COALESCE(SUM(output_tokens),0) AS reportedOutputTokens,
      COALESCE(SUM(total_tokens),0) AS reportedTotalTokens
    FROM ai_usage
  `).get();
  db.prepare("INSERT INTO ai_usage (request_id,user_id,provider_id,model_id,operation,status,duration_ms,input_tokens,output_tokens,total_tokens,usage_source,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)")
    .run('admin-usage-record', adminUser.id, 'provider-a', 'provider-a:model-a', 'stream', 'succeeded', 120, 10, 5, 15, 'provider');
  db.prepare("INSERT INTO ai_usage (request_id,user_id,provider_id,model_id,operation,status,duration_ms) VALUES (?,?,?,?,?,?,?)")
    .run('admin-usage-unknown', adminUser.id, 'provider-b', 'provider-b:model-b', 'chat', 'succeeded', 80);

  await admin.post('/api/v1/auth/login').set(originHeaders)
    .send({ email: 'usage-admin@example.com', password: 'usage-admin-password-strong' }).expect(200);
  const report = await admin.get('/api/v1/admin/usage?limit=10').expect(200);
  assert.equal(report.body.summary.requests, baseline.requests + 2);
  assert.equal(report.body.summary.succeeded, baseline.succeeded + 2);
  assert.equal(report.body.summary.providerReportedRequests, baseline.providerReportedRequests + 1);
  assert.equal(report.body.summary.reportedInputTokens, baseline.reportedInputTokens + 10);
  assert.equal(report.body.summary.reportedOutputTokens, baseline.reportedOutputTokens + 5);
  assert.equal(report.body.summary.reportedTotalTokens, baseline.reportedTotalTokens + 15);
  assert.ok(report.body.records.every((record) => !Object.hasOwn(record, 'content')));
  const unknown = report.body.records.find((record) => record.request_id === 'admin-usage-unknown');
  assert.equal(unknown.total_tokens, null);
  assert.equal(unknown.usage_source, null);

  const regular = request.agent(app);
  await regular.post('/api/v1/auth/register').set(originHeaders).send({
    email: 'usage-regular@example.com',
    name: 'Regular User',
    password: 'usage-regular-password-strong',
  }).expect(201);
  await regular.post('/api/v1/auth/login').set(originHeaders)
    .send({ email: 'usage-regular@example.com', password: 'usage-regular-password-strong' }).expect(200);
  await regular.get('/api/v1/admin/usage').expect(403);
});

test('admin provider management encrypts secrets, enforces role boundaries, and updates the model registry', async () => {
  const previous = {
    aiBaseUrl: config.aiBaseUrl,
    aiApiKey: config.aiApiKey,
    aiModel: config.aiModel,
    aiProvidersJson: config.aiProvidersJson,
    aiDefaultModelId: config.aiDefaultModelId,
    providerEncryptionKey: config.providerEncryptionKey,
  };
  let adminProviderServer;
  let receivedAuthorization = null;

  try {
    config.aiBaseUrl = '';
    config.aiApiKey = '';
    config.aiModel = '';
    config.aiProvidersJson = '';
    config.aiDefaultModelId = '';
    config.providerEncryptionKey = process.env.PROVIDER_ENCRYPTION_KEY;

    const regular = request.agent(app);
    await regular.post('/api/v1/auth/register').set(originHeaders).send({
      email: 'provider-regular@example.com',
      name: 'Regular Provider User',
      password: 'provider-regular-password-strong',
    }).expect(201);
    await regular.post('/api/v1/auth/login').set(originHeaders).send({
      email: 'provider-regular@example.com',
      password: 'provider-regular-password-strong',
    }).expect(200);
    await regular.get('/api/v1/admin/providers').expect(403);

    const admin = request.agent(app);
    await admin.post('/api/v1/auth/register').set(originHeaders).send({
      email: 'provider-admin@example.com',
      name: 'Provider Admin',
      password: 'provider-admin-password-strong',
    }).expect(201);
    const adminUser = db.prepare('SELECT id FROM users WHERE email=?').get('provider-admin@example.com');
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(adminUser.id);
    await admin.post('/api/v1/auth/login').set(originHeaders).send({
      email: 'provider-admin@example.com',
      password: 'provider-admin-password-strong',
    }).expect(200);

    const previousNodeEnv = config.nodeEnv;
    config.nodeEnv = 'production';
    await admin.post('/api/v1/admin/providers').set(originHeaders).send({
      id: 'http-production-blocked',
      name: 'HTTP Must Be Blocked',
      baseUrl: 'http://127.0.0.1:4000/v1',
      apiKey: 'test-secret',
      models: [{ id: 'test-model' }],
    }).expect(400);
    config.nodeEnv = previousNodeEnv;

    adminProviderServer = createServer((incoming, outgoing) => {
      receivedAuthorization = incoming.headers.authorization || null;
      if (incoming.method === 'GET' && incoming.url === '/v1/models') {
        outgoing.writeHead(200, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({ data: [{ id: 'managed-chat', context_length: '98304' }] }));
        return;
      }
      outgoing.writeHead(404, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise((resolve) => adminProviderServer.listen(0, '127.0.0.1', resolve));
    const secret = 'admin-managed-provider-secret';

    const created = await admin.post('/api/v1/admin/providers').set(originHeaders).send({
      id: 'managed-test',
      name: 'Managed Test Provider',
      baseUrl: 'http://127.0.0.1:' + adminProviderServer.address().port + '/v1',
      apiKey: secret,
      enabled: true,
      models: [{ id: 'managed-chat', name: 'Managed Chat', contextLimit: 65536, tokenizer: 'o200k_base', maxTokensParameter: 'max_completion_tokens' }],
    }).expect(201);
    assert.equal(created.body.providers.some((provider) => provider.id === 'managed-test' && provider.hasApiKey), true);

    const stored = db.prepare('SELECT api_key_encrypted FROM ai_providers WHERE id=?').get('managed-test');
    assert.match(stored.api_key_encrypted, /^v1\./);
    assert.equal(stored.api_key_encrypted.includes(secret), false);
    const management = await admin.get('/api/v1/admin/providers').expect(200);
    const managed = management.body.providers.find((provider) => provider.id === 'managed-test');
    assert.equal(managed.readOnly, false);
    assert.equal(managed.hasApiKey, true);
    assert.equal(JSON.stringify(management.body).includes(secret), false);
    assert.equal(JSON.stringify(management.body).includes(stored.api_key_encrypted), false);

    const catalog = await request(app).get('/api/v1/models').expect(200);
    const model = catalog.body.models.find((item) => item.id === 'managed-test:managed-chat');
    assert.equal(model.selectable, true);
    assert.equal(model.contextLimit, 65536);
    assert.equal(model.contextLimitSource, 'admin_configured');
    assert.equal(model.tokenizer, 'o200k_base');
    assert.equal(model.tokenizerSource, 'admin_configured');
    assert.equal(model.maxTokensParameter, 'max_completion_tokens');
    assert.equal(JSON.stringify(catalog.body).includes(secret), false);
    assert.equal(JSON.stringify(catalog.body).includes('api_key_encrypted'), false);

    const health = await admin.post('/api/v1/models/health').set(originHeaders)
      .send({ modelId: 'managed-test:managed-chat' }).expect(200);
    assert.equal(health.body.status, 'healthy');
    assert.deepEqual(health.body.contextWindow, { tokens: 98304, source: 'provider_reported', checkedAt: health.body.contextWindow.checkedAt });
    assert.equal(receivedAuthorization, 'Bearer ' + secret);
    const refreshedCatalog = await request(app).get('/api/v1/models').expect(200);
    const refreshedModel = refreshedCatalog.body.models.find((item) => item.id === 'managed-test:managed-chat');
    assert.equal(refreshedModel.contextLimit, 98304);
    assert.equal(refreshedModel.contextLimitSource, 'provider_reported');
    assert.equal(refreshedModel.maxTokensParameter, 'max_completion_tokens');
    assert.equal(db.prepare('SELECT context_tokens FROM model_context_windows WHERE provider_id=? AND upstream_model_id=?')
      .get('managed-test', 'managed-chat').context_tokens, 98304);

    const defaultModel = await admin.put('/api/v1/admin/model-default').set(originHeaders)
      .send({ defaultModelId: 'managed-test:managed-chat' }).expect(200);
    assert.equal(defaultModel.body.defaultModelId, 'managed-test:managed-chat');
    assert.equal(defaultModel.body.defaultModelSource, 'database');

    const cipherBefore = stored.api_key_encrypted;
    await admin.put('/api/v1/admin/providers/managed-test').set(originHeaders)
      .send({ name: 'Renamed Managed Provider' }).expect(200);
    const cipherAfter = db.prepare('SELECT api_key_encrypted FROM ai_providers WHERE id=?').get('managed-test');
    assert.equal(cipherAfter.api_key_encrypted, cipherBefore);
    assert.equal(db.prepare('SELECT context_tokens FROM model_context_windows WHERE provider_id=? AND upstream_model_id=?')
      .get('managed-test', 'managed-chat').context_tokens, 98304);

    await admin.put('/api/v1/admin/providers/managed-test').set(originHeaders)
      .send({
        models: [{
          id: 'managed-chat',
          name: 'Managed Chat',
          contextLimit: 65536,
          tokenizer: 'o200k_base',
          maxTokensParameter: 'max_completion_tokens',
        }],
      }).expect(200);
    assert.equal(db.prepare('SELECT context_tokens FROM model_context_windows WHERE provider_id=? AND upstream_model_id=?')
      .get('managed-test', 'managed-chat'), undefined);
    const afterModelChange = await request(app).get('/api/v1/models').expect(200);
    const modelAfterChange = afterModelChange.body.models.find((item) => item.id === 'managed-test:managed-chat');
    assert.equal(modelAfterChange.contextLimit, 65536);
    assert.equal(modelAfterChange.contextLimitSource, 'admin_configured');

    await admin.put('/api/v1/admin/providers/managed-test').set(originHeaders)
      .send({ enabled: false }).expect(200);
    const disabledCatalog = await request(app).get('/api/v1/models').expect(200);
    assert.equal(disabledCatalog.body.models.find((item) => item.id === 'managed-test:managed-chat').selectable, false);

    await admin.put('/api/v1/admin/providers/managed-test').set(originHeaders)
      .send({ enabled: true, apiKey: 'replacement-provider-secret' }).expect(200);
    const reencrypted = db.prepare('SELECT api_key_encrypted FROM ai_providers WHERE id=?').get('managed-test');
    assert.notEqual(reencrypted.api_key_encrypted, cipherBefore);
    assert.equal(reencrypted.api_key_encrypted.includes('replacement-provider-secret'), false);

    config.aiProvidersJson = JSON.stringify([{
      id: 'environment-test',
      name: 'Environment Test Provider',
      baseUrl: 'https://environment.example/v1',
      apiKey: 'environment-secret',
      models: [{ id: 'environment-chat' }],
    }]);
    const withEnvironment = await admin.get('/api/v1/admin/providers').expect(200);
    const environmentProvider = withEnvironment.body.providers.find((provider) => provider.id === 'environment-test');
    assert.equal(environmentProvider.readOnly, true);
    assert.equal(environmentProvider.baseUrl, null);
    assert.equal(JSON.stringify(withEnvironment.body).includes('environment-secret'), false);
    await admin.post('/api/v1/admin/providers').set(originHeaders).send({
      id: 'environment-test',
      name: 'Must Not Override',
      baseUrl: 'https://environment.example/v1',
      apiKey: 'another-secret',
      models: [{ id: 'environment-chat' }],
    }).expect(409);

    config.aiProvidersJson = '';
    await admin.delete('/api/v1/admin/providers/managed-test').set(originHeaders).expect(200);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM model_context_windows WHERE provider_id=?').get('managed-test').count, 0);
    assert.equal(db.prepare("SELECT value FROM ai_settings WHERE key='default_model_id'").get(), undefined);
    const finalCatalog = await request(app).get('/api/v1/models').expect(200);
    assert.equal(finalCatalog.body.models.some((item) => item.id.startsWith('managed-test:')), false);
  } finally {
    config.aiBaseUrl = previous.aiBaseUrl;
    config.aiApiKey = previous.aiApiKey;
    config.aiModel = previous.aiModel;
    config.aiProvidersJson = previous.aiProvidersJson;
    config.aiDefaultModelId = previous.aiDefaultModelId;
    config.providerEncryptionKey = previous.providerEncryptionKey;
    if (adminProviderServer?.listening) {
      await new Promise((resolve) => adminProviderServer.close(resolve));
    }
  }
});


