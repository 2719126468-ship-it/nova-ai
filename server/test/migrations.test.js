import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/migrations.js';

function createLegacySchema(database) {
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);
    CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_projects_user_updated ON projects(user_id, updated_at DESC);
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '新对话',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_conversations_user_updated ON conversations(user_id, updated_at DESC);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_messages_conversation ON messages(conversation_id, id);
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '观点',
      summary TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published')),
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_articles_status_published ON articles(status, published_at DESC);
  `);

  database.prepare('INSERT INTO users (id,email,password_hash,name) VALUES (?,?,?,?)')
    .run(41, 'legacy@example.com', 'legacy-password-hash', 'Legacy User');
  database.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)')
    .run(71, 41, 'legacy-session-hash', '2099-01-01T00:00:00.000Z');
  database.prepare('INSERT INTO projects (id,user_id,title,description,content) VALUES (?,?,?,?,?)')
    .run(51, 41, 'Legacy project', 'kept during migration', 'legacy project content');
  database.prepare('INSERT INTO conversations (id,user_id,title) VALUES (?,?,?)')
    .run(61, 41, 'Legacy conversation');
  database.prepare('INSERT INTO messages (id,conversation_id,role,content) VALUES (?,?,?,?)')
    .run(81, 61, 'user', 'legacy user message');
  database.prepare('INSERT INTO messages (id,conversation_id,role,content) VALUES (?,?,?,?)')
    .run(82, 61, 'assistant', 'legacy assistant reply');
  database.prepare(`INSERT INTO articles (id,slug,title,category,summary,body,status,author_id,published_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(91, 'legacy-research', 'Legacy research', '研究', 'legacy summary', 'legacy article body', 'published', 41, '2026-01-01T00:00:00.000Z');
}

test('legacy SQLite databases upgrade through every migration without losing user data', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-legacy-migration-'));
  const databaseFile = path.join(directory, 'legacy.sqlite');
  const database = new Database(databaseFile);
  context.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  createLegacySchema(database);

  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get().count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 2);

  runMigrations(database);

  const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(versions.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

  assert.equal(database.prepare('SELECT email FROM users WHERE id=41').get().email, 'legacy@example.com');
  assert.equal(database.prepare('SELECT token_hash FROM sessions WHERE id=71').get().token_hash, 'legacy-session-hash');
  assert.equal(database.prepare("SELECT title || ':' || content AS value FROM projects WHERE id=51").get().value,
    'Legacy project:legacy project content');
  assert.equal(database.prepare('SELECT title FROM conversations WHERE id=61').get().title, 'Legacy conversation');
  assert.deepEqual(database.prepare('SELECT id,role,content,status,error_code FROM messages ORDER BY id').all(), [
    { id: 81, role: 'user', content: 'legacy user message', status: 'complete', error_code: null },
    { id: 82, role: 'assistant', content: 'legacy assistant reply', status: 'complete', error_code: null },
  ]);
  assert.equal(database.prepare('SELECT body FROM articles WHERE id=91').get().body, 'legacy article body');

  const project = database.prepare('SELECT instructions,instructions_version FROM projects WHERE id=51').get();
  assert.deepEqual(project, { instructions: '', instructions_version: 1 });
  assert.equal(database.prepare('SELECT archived_at FROM documents').all().length, 0);

  const expectedTables = [
    'project_conversations', 'ai_usage', 'message_versions', 'ai_providers', 'ai_settings',
    'model_context_windows', 'documents', 'project_files', 'admin_audit_logs', 'model_health_snapshots',
  ];
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const table of expectedTables) assert.ok(tables.has(table), `missing migrated table: ${table}`);

  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(Object.values(database.prepare('PRAGMA integrity_check').get())[0], 'ok');

  runMigrations(database);
  assert.deepEqual(
    database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM articles').get().count, 1);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});
