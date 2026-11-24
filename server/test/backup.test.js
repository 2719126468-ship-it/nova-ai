import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { backupDatabase, verifyDatabase } from '../src/services/backup.js';

test('verifyDatabase preserves WAL sidecars belonging to a live database', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-live-wal-verify-'));
  const file = path.join(directory, 'live.sqlite');
  const database = new Database(file);
  context.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  database.pragma('journal_mode = WAL');
  database.exec('CREATE TABLE records (value TEXT NOT NULL)');
  database.prepare('INSERT INTO records(value) VALUES (?)').run('committed-wal-record');

  const walFile = file + '-wal';
  const shmFile = file + '-shm';
  assert.ok(fs.existsSync(walFile), 'test requires an active WAL file');
  assert.ok(fs.existsSync(shmFile), 'test requires an active shared-memory file');

  const report = verifyDatabase(file);
  assert.equal(report.ok, true);
  assert.ok(fs.existsSync(walFile), 'verification must not delete the live WAL');
  assert.ok(fs.existsSync(shmFile), 'verification must not delete the live shared-memory file');
  assert.deepEqual(database.prepare('SELECT value FROM records').all(), [
    { value: 'committed-wal-record' },
  ]);

  const reopened = new Database(file, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(reopened.prepare('SELECT value FROM records').all(), [
      { value: 'committed-wal-record' },
    ]);
  } finally {
    reopened.close();
  }
});

test('backupDatabase removes only sidecars created while verifying its private backup artifact', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-backup-wal-verify-'));
  const sourceFile = path.join(directory, 'source.sqlite');
  const outDir = path.join(directory, 'backups');
  const source = new Database(sourceFile);
  context.after(() => {
    source.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  source.pragma('journal_mode = WAL');
  source.exec('CREATE TABLE records (value TEXT NOT NULL)');
  source.prepare('INSERT INTO records(value) VALUES (?)').run('backup-wal-record');

  const result = await backupDatabase({ dbPath: sourceFile, outDir, keep: 3 });
  assert.equal(result.integrity, 'ok');
  assert.ok(fs.existsSync(result.file));
  assert.ok(fs.existsSync(result.file + '.json'));
  assert.equal(fs.existsSync(result.file + '-wal'), false);
  assert.equal(fs.existsSync(result.file + '-shm'), false);

  const restored = new Database(result.file, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(restored.prepare('SELECT value FROM records').all(), [
      { value: 'backup-wal-record' },
    ]);
  } finally {
    restored.close();
  }
});
