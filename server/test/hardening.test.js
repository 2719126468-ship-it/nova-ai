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


test('alert webhook fires once per threshold/cooldown and carries metadata only', async () => {
  const { createServer } = await import('node:http');
  const alerts = await import('../src/services/alerts.js');
  const monitoring = await import('../src/services/monitoring.js');
  const previous = {
    url: config.alertWebhookUrl,
    threshold: config.alertErrorThreshold,
    cooldown: config.alertCooldownMs,
  };
  const received = [];
  const hook = createServer((incoming, outgoing) => {
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => { body += chunk; });
    incoming.on('end', () => {
      received.push({ url: incoming.url, body: JSON.parse(body || '{}'), contentType: incoming.headers['content-type'] });
      outgoing.writeHead(204);
      outgoing.end();
    });
  });
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  try {
    monitoring.resetMonitoring();
    alerts.resetAlertState();
    config.alertWebhookUrl = 'http://127.0.0.1:' + hook.address().port + '/hook';
    config.alertErrorThreshold = 3;
    config.alertCooldownMs = 60000;

    monitoring.recordError({ code: 'AI_PROVIDER_UNAVAILABLE', status: 502, route: '/api/v1/conversations/1/messages/stream', requestId: 'req-1' });
    monitoring.recordError({ code: 'AI_PROVIDER_UNAVAILABLE', status: 502, route: '/api/v1/conversations/1/messages/stream', requestId: 'req-2' });
    assert.equal(alerts.maybeAlert('AI_PROVIDER_UNAVAILABLE'), null, 'must stay quiet below the threshold');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(received.length, 0);

    monitoring.recordError({ code: 'AI_PROVIDER_UNAVAILABLE', status: 502, route: '/api/v1/conversations/1/messages/stream', requestId: 'req-3' });
    const payload = alerts.maybeAlert('AI_PROVIDER_UNAVAILABLE');
    assert.ok(payload, 'threshold reached should produce a payload');
    assert.equal(payload.code, 'AI_PROVIDER_UNAVAILABLE');
    assert.equal(payload.count, 3);
    assert.equal(payload.lastStatus, 502);
    assert.equal(payload.severity, 'error');
    assert.ok(Array.isArray(payload.routes) && payload.routes.length === 1);

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/hook');
    assert.match(received[0].contentType, /application\/json/);
    const body = received[0].body;
    assert.equal(body.code, 'AI_PROVIDER_UNAVAILABLE');
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('Bearer'), false);
    assert.equal(serialized.includes('sk-'), false);
    // The payload's own disclaimer mentions prompts; what matters is that no
    // user content or credential shape is present.
    assert.equal(serialized.includes('req-'), false, 'request ids must not be forwarded');
    assert.equal(serialized.includes('Bearer'), false);
    assert.equal(serialized.includes('sk-'), false);

    // Cooldown suppresses the next alert for the same code.
    monitoring.recordError({ code: 'AI_PROVIDER_UNAVAILABLE', status: 502, route: '/api/v1/x', requestId: 'req-4' });
    assert.equal(alerts.maybeAlert('AI_PROVIDER_UNAVAILABLE'), null, 'cooldown must suppress repeats');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(received.length, 1);

    const state = alerts.alertState();
    assert.equal(state.configured, true);
    assert.equal(state.threshold, 3);
    assert.equal(state.recent.length, 1);
    assert.equal(state.recent[0].ok, true);

    // Unconfigured webhook must not throw and must not deliver anything.
    config.alertWebhookUrl = '';
    monitoring.recordError({ code: 'INTERNAL_ERROR', status: 500, route: '/api/v1/x', requestId: 'req-5' });
    assert.equal(alerts.maybeAlert('INTERNAL_ERROR'), null);
    assert.equal(alerts.alertState().configured, false);
    await assert.rejects(() => alerts.sendTestAlert(), (error) => error.code === 'ALERT_WEBHOOK_NOT_CONFIGURED');
  } finally {
    config.alertWebhookUrl = previous.url;
    config.alertErrorThreshold = previous.threshold;
    config.alertCooldownMs = previous.cooldown;
    alerts.resetAlertState();
    monitoring.resetMonitoring();
    await new Promise((resolve) => hook.close(resolve));
  }
});

test('administrator can trigger a test alert and only admins can read alert state', async () => {
  const { createServer } = await import('node:http');
  const alerts = await import('../src/services/alerts.js');
  const previous = { url: config.alertWebhookUrl };
  const received = [];
  const hook = createServer((incoming, outgoing) => {
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => { body += chunk; });
    incoming.on('end', () => {
      received.push(JSON.parse(body || '{}'));
      outgoing.writeHead(200, { 'Content-Type': 'application/json' });
      outgoing.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  try {
    alerts.resetAlertState();
    config.alertWebhookUrl = 'http://127.0.0.1:' + hook.address().port + '/hook';

    const admin = request.agent(app);
    await admin.post('/api/v1/auth/register').set(originHeaders).send({
      email: 'alert-admin@example.com', name: 'Alert Admin', password: 'alert-admin-password-strong',
    }).expect(201);
    db.prepare("UPDATE users SET role='admin' WHERE email='alert-admin@example.com'").run();
    await admin.post('/api/v1/auth/login').set(originHeaders).send({
      email: 'alert-admin@example.com', password: 'alert-admin-password-strong',
    }).expect(200);

    const monitoringReport = await admin.get('/api/v1/admin/monitoring').expect(200);
    assert.equal(monitoringReport.body.alerts.configured, true);

    const test = await admin.post('/api/v1/admin/alerts/test').set(originHeaders).expect(200);
    assert.equal(test.body.delivered, true);
    assert.equal(test.body.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(received.length, 1);
    assert.equal(received[0].code, 'ALERT_TEST');

    const auditLogs = await admin.get('/api/v1/admin/audit-logs?limit=10').expect(200);
    assert.ok(auditLogs.body.logs.some((entry) => entry.action === 'alert.test_sent'));

    const regular = request.agent(app);
    await regular.post('/api/v1/auth/register').set(originHeaders).send({
      email: 'alert-regular@example.com', name: 'Alert Regular', password: 'alert-regular-password-strong',
    }).expect(201);
    await regular.post('/api/v1/admin/alerts/test').set(originHeaders).expect(403);
    await regular.get('/api/v1/admin/monitoring').expect(403);
  } finally {
    config.alertWebhookUrl = previous.url;
    alerts.resetAlertState();
    await new Promise((resolve) => hook.close(resolve));
  }
});


test('relative DB_PATH resolves against the repository root from any working directory', async () => {
  const { execFileSync } = await import('node:child_process');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const configUrl = new URL('../src/config.js', import.meta.url).href;
  const script = "process.env.DB_PATH='./server/data/nova.sqlite';import(" + JSON.stringify(configUrl) + ").then((m)=>console.log(m.config.dbPath))";
  const expected = path.join(repoRoot, 'server/data/nova.sqlite');
  for (const cwd of [repoRoot, path.join(repoRoot, 'server')]) {
    const output = execFileSync(process.execPath, ['-e', script], {
      cwd: cwd === repoRoot ? repoRoot : path.join(repoRoot, 'server'),
      encoding: 'utf8',
      env: { ...process.env, DB_PATH: './server/data/nova.sqlite' },
    }).trim();
    assert.equal(output, expected, 'cwd=' + cwd);
  }
});


test('restore-db script resolves a relative backup path against the repository root', async () => {
  const { execFileSync } = await import('node:child_process');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const fs = await import('node:fs');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const script = path.join(repoRoot, 'server/scripts/restore-db.js');
  let output = '';
  try {
    output = execFileSync(process.execPath, [script, 'backups/does-not-exist.sqlite'], {
      cwd: path.join(repoRoot, 'server'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    output = String(error.stdout || '') + String(error.stderr || '');
  }
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  assert.ok(start >= 0 && end > start, 'restore script should print a JSON report: ' + output.slice(0, 200));
  const parsed = JSON.parse(output.slice(start, end + 1));
  assert.equal(parsed.ok, false);
  // The failure must be about the file, not about a duplicated "server/server" path.
  assert.match(parsed.error, /DATABASE_NOT_FOUND/);
  assert.equal(parsed.error.includes('server/server'), false, parsed.error);
  assert.ok(fs.existsSync(path.join(repoRoot, 'backups')), 'backups dir should exist at the repo root');
});

