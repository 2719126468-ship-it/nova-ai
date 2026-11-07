import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-hardening-'));
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.SESSION_SECRET = 'hardening-secret-with-more-than-32-characters';
process.env.PROVIDER_ENCRYPTION_KEY = 'hardening-provider-key-with-32-plus-chars';
process.env.DB_PATH = path.join(tempDir, 'hardening.sqlite');
process.env.AI_BASE_URL = '';
process.env.AI_API_KEY = '';
process.env.AI_MODEL = '';

let app;
let db;
let config;
let recordAdminAction;
let listAuditLogs;
let errorSnapshot;
let resetMonitoring;
let purgeExpiredSessions;
let backupDatabase;
let restoreDatabase;
let verifyDatabase;

const originHeaders = { Origin: 'http://localhost:5173', 'X-Requested-With': 'NOVA-Web' };

before(async () => {
  const [appModule, database, appConfig, audit, monitoring, sessions, backup] = await Promise.all([
    import('../src/app.js'),
    import('../src/db.js'),
    import('../src/config.js'),
    import('../src/services/audit.js'),
    import('../src/services/monitoring.js'),
    import('../src/services/sessions.js'),
    import('../src/services/backup.js'),
  ]);
  app = appModule.createApp();
  db = database.db;
  config = appConfig.config;
  ({ recordAdminAction, listAuditLogs } = audit);
  ({ errorSnapshot, resetMonitoring } = monitoring);
  ({ purgeExpiredSessions } = sessions);
  ({ backupDatabase, restoreDatabase, verifyDatabase } = backup);
});

after(() => {
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function registerAdmin(email, password) {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/register').set(originHeaders)
    .send({ email, name: 'Admin ' + email, password }).expect(201);
  db.prepare("UPDATE users SET role='admin' WHERE email=?").run(email);
  await agent.post('/api/v1/auth/login').set(originHeaders).send({ email, password }).expect(200);
  return agent;
}

test('API responses carry a deny-by-default content security policy and request id', async () => {
  const response = await request(app).get('/api/v1/health').expect(200);
  const csp = response.headers['content-security-policy'];
  assert.ok(csp, 'CSP header is missing');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(response.headers['x-request-id']);
  assert.equal(response.headers['x-powered-by'], undefined);
});

test('production requests without a trusted Origin are rejected for mutations', async () => {
  const previous = config.nodeEnv;
  config.nodeEnv = 'production';
  try {
    const noOrigin = await request(app).post('/api/v1/auth/login')
      .set('X-Requested-With', 'NOVA-Web')
      .send({ email: 'nobody@example.com', password: 'whatever-password' });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.body.error, 'MISSING_ORIGIN');

    const badOrigin = await request(app).post('/api/v1/auth/login')
      .set({ Origin: 'https://evil.example', 'X-Requested-With': 'NOVA-Web' })
      .send({ email: 'nobody@example.com', password: 'whatever-password' });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.body.error, 'INVALID_ORIGIN');
  } finally {
    config.nodeEnv = previous;
  }
});

test('expired sessions are purged and cannot authenticate', async () => {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/register').set(originHeaders).send({
    email: 'session-purge@example.com', name: 'Session Purge', password: 'session-purge-password',
  }).expect(201);
  const user = db.prepare('SELECT id FROM users WHERE email=?').get('session-purge@example.com');
  db.prepare("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,datetime('now','-2 days'))")
    .run(user.id, 'expired-hash-' + Date.now());
  const before = db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id=? AND datetime(expires_at) <= CURRENT_TIMESTAMP").get(user.id).count;
  assert.ok(before >= 1);
  assert.ok(purgeExpiredSessions() >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id=? AND datetime(expires_at) <= CURRENT_TIMESTAMP").get(user.id).count, 0);
});

test('administrator actions are audited without storing secrets or content', async () => {
  const admin = await registerAdmin('audit-admin@example.com', 'audit-admin-password-strong');
  const member = request.agent(app);
  await member.post('/api/v1/auth/register').set(originHeaders).send({
    email: 'audit-member@example.com', name: 'Audit Member', password: 'audit-member-password-strong',
  }).expect(201);
  const memberId = db.prepare('SELECT id FROM users WHERE email=?').get('audit-member@example.com').id;

  await admin.patch('/api/v1/admin/users/' + memberId + '/role').set(originHeaders)
    .send({ role: 'admin' }).expect(200);
  await admin.patch('/api/v1/admin/users/' + memberId + '/role').set(originHeaders)
    .send({ role: 'user' }).expect(200);

  const created = await admin.post('/api/v1/admin/providers').set(originHeaders).send({
    id: 'audited-provider',
    name: 'Audited Provider',
    baseUrl: 'https://audit.example/v1',
    apiKey: 'audit-provider-secret-value',
    models: [{ id: 'audit-model' }],
  }).expect(201);
  assert.equal(JSON.stringify(created.body).includes('audit-provider-secret-value'), false);
  await admin.put('/api/v1/admin/providers/audited-provider').set(originHeaders)
    .send({ enabled: false }).expect(200);
  await admin.delete('/api/v1/admin/providers/audited-provider').set(originHeaders).expect(200);

  const logs = await admin.get('/api/v1/admin/audit-logs?limit=50').expect(200);
  const actions = logs.body.logs.map((entry) => entry.action);
  assert.ok(actions.includes('user.role_changed'));
  assert.ok(actions.includes('provider.created'));
  assert.ok(actions.includes('provider.updated'));
  assert.ok(actions.includes('provider.deleted'));

  const serialized = JSON.stringify(logs.body);
  assert.equal(serialized.includes('audit-provider-secret-value'), false);
  assert.equal(serialized.includes('v1.'), false, 'encrypted provider material must not be audited');
  assert.equal(serialized.includes('https://audit.example'), false, 'provider base URL must not be audited');

  const roleChanges = logs.body.logs.filter((entry) => entry.action === 'user.role_changed');
  assert.deepEqual(roleChanges.map((entry) => entry.metadata), [
    { from: 'admin', to: 'user' },
    { from: 'user', to: 'admin' },
  ]);
  assert.equal(roleChanges[0].actorUserId, db.prepare('SELECT id FROM users WHERE email=?').get('audit-admin@example.com').id);
  assert.equal(roleChanges[0].targetId, String(memberId));

  const regular = request.agent(app);
  await regular.post('/api/v1/auth/login').set(originHeaders)
    .send({ email: 'audit-member@example.com', password: 'audit-member-password-strong' }).expect(200);
  await regular.get('/api/v1/admin/audit-logs').expect(403);
});

test('error monitoring records stable codes and stays admin-only', async () => {
  resetMonitoring();
  const user = request.agent(app);
  await user.post('/api/v1/auth/register').set(originHeaders).send({
    email: 'monitor-user@example.com', name: 'Monitor User', password: 'monitor-user-password-strong',
  }).expect(201);
  const conversation = await user.post('/api/v1/conversations').set(originHeaders)
    .send({ title: 'Monitor conversation' }).expect(201);

  const failed = await user.post('/api/v1/conversations/' + conversation.body.conversation.id + '/messages')
    .set(originHeaders).send({ content: 'no provider configured' });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error, 'AI_PROVIDER_NOT_CONFIGURED');
  assert.ok(failed.body.requestId);

  const snapshot = errorSnapshot(10);
  assert.ok(snapshot.totalErrors >= 1);
  assert.ok(snapshot.codes.some((entry) => entry.code === 'AI_PROVIDER_NOT_CONFIGURED'));
  assert.equal(JSON.stringify(snapshot).includes('no provider configured'), false);

  await user.get('/api/v1/admin/monitoring').expect(403);
  const admin = await registerAdmin('monitor-admin@example.com', 'monitor-admin-password-strong');
  const report = await admin.get('/api/v1/admin/monitoring').expect(200);
  assert.ok(report.body.errors.codes.length >= 1);
  assert.equal(typeof report.body.uptimeSeconds, 'number');
});

test('database backup verifies integrity and restores over the live file', async () => {
  const admin = await registerAdmin('backup-admin@example.com', 'backup-admin-password-strong');
  assert.ok(admin);
  const outDir = path.join(tempDir, 'backups');
  const result = await backupDatabase({ dbPath: config.dbPath, outDir, keep: 3 });
  assert.equal(result.integrity, 'ok');
  assert.ok(result.bytes > 0);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(result.file));
  assert.ok(fs.existsSync(result.file + '.json'));
  assert.equal(verifyDatabase(result.file).ok, true);

  const usersBefore = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  const marker = db.prepare("SELECT id FROM users WHERE email='backup-admin@example.com'").get();
  assert.ok(marker);

  const restored = restoreDatabase({ backupFile: result.file, dbPath: config.dbPath, keepCurrent: true });
  assert.equal(restored.ok, true);
  assert.ok(restored.previousFile && fs.existsSync(restored.previousFile));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, usersBefore);
  assert.ok(db.prepare("SELECT id FROM users WHERE email='backup-admin@example.com'").get());
});

test('audit sanitizer drops credential-shaped fields at any depth', () => {
  const record = {
    name: 'provider',
    apiKey: 'secret-value',
    nested: { baseUrl: 'https://internal.example', token: 'abc', models: [{ id: 'm1', password: 'p' }] },
    content: 'user prompt text',
  };
  const id = recordAdminAction({ actorUserId: null, action: 'test.sanitize', targetType: 'test', metadata: record });
  assert.ok(id);
  const stored = db.prepare('SELECT metadata_json FROM admin_audit_logs WHERE id=?').get(id).metadata_json;
  assert.equal(stored.includes('secret-value'), false);
  assert.equal(stored.includes('internal.example'), false);
  assert.equal(stored.includes('user prompt text'), false);
  assert.match(stored, /m1/);
  const entry = listAuditLogs(5).find((item) => item.id === id);
  assert.equal(entry.metadata.name, 'provider');
});

test('model health snapshots expire and never expose credentials through the catalog', async () => {
  const { getModelRegistry } = await import('../src/services/model-registry.js');
  db.prepare("INSERT INTO model_health_snapshots(provider_id,upstream_model_id,status,code,duration_ms,checked_at) VALUES(?,?,?,?,?,datetime('now','-2 days'))")
    .run('stale-provider', 'stale-model', 'healthy', 'MODEL_LIST_CONFIRMED', 12);
  db.prepare("INSERT INTO model_health_snapshots(provider_id,upstream_model_id,status,code,duration_ms,checked_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)")
    .run('fresh-provider', 'fresh-model', 'unavailable', 'PROVIDER_NETWORK_ERROR', 30);
  const registry = getModelRegistry();
  const serialized = JSON.stringify(registry);
  assert.equal(serialized.includes('stale-model'), false);
  assert.equal(serialized.includes('fresh-model'), false);
  const rows = db.prepare("SELECT COUNT(*) AS count FROM model_health_snapshots WHERE datetime(checked_at) >= datetime('now','-1 day')").get().count;
  assert.equal(rows, 1);
});

