import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function verifyDatabase(file) {
  if (!fs.existsSync(file)) throw new Error('DATABASE_NOT_FOUND: ' + file);
  const handle = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = handle.prepare('PRAGMA integrity_check').all();
    const integrity = rows.map((row) => Object.values(row)[0]).join('; ');
    const tables = handle.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get().count;
    const migrations = handle.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get().count
      ? handle.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get().version
      : null;
    return { ok: integrity === 'ok', integrity, tables, schemaVersion: migrations, bytes: fs.statSync(file).size };
  } finally {
    handle.close();
    // Opening a WAL database creates -shm/-wal sidecars; a backup artifact must be a single file.
    for (const suffix of ['-shm', '-wal']) {
      const sidecar = file + suffix;
      if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
    }
  }
}

function pruneOldBackups(outDir, keep) {
  if (!Number.isInteger(keep) || keep < 1) return [];
  const files = fs.readdirSync(outDir)
    .filter((name) => /^nova-.*\.sqlite$/.test(name))
    .map((name) => ({ name, mtime: fs.statSync(path.join(outDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const removed = [];
  for (const file of files.slice(keep)) {
    for (const suffix of ['', '.json', '-shm', '-wal']) {
      const target = path.join(outDir, file.name + suffix);
      if (fs.existsSync(target)) { fs.rmSync(target); removed.push(path.basename(target)); }
    }
  }
  return removed;
}

/** Consistent online backup of the live SQLite database, including WAL contents. */
export async function backupDatabase({ dbPath, outDir, keep = 7 }) {
  if (!dbPath || dbPath === ':memory:') throw new Error('BACKUP_UNSUPPORTED: in-memory database cannot be backed up.');
  if (!fs.existsSync(dbPath)) throw new Error('DATABASE_NOT_FOUND: ' + dbPath);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, 'nova-' + stamp + '.sqlite');
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(file);
  } finally {
    source.close();
  }
  const report = verifyDatabase(file);
  if (!report.ok) {
    fs.rmSync(file, { force: true });
    throw new Error('BACKUP_INTEGRITY_FAILED: ' + report.integrity);
  }
  const manifest = {
    fileName: path.basename(file),
    createdAt: new Date().toISOString(),
    source: path.resolve(dbPath),
    bytes: report.bytes,
    sha256: sha256File(file),
    integrity: report.integrity,
    schemaVersion: report.schemaVersion,
    tables: report.tables,
  };
  fs.writeFileSync(file + '.json', JSON.stringify(manifest, null, 2) + '\n');
  pruneOldBackups(outDir, keep);
  return { ...manifest, file, filePath: file };
}

/**
 * Restore a verified backup over the configured database path. The current file
 * is moved aside (never deleted) so an operator can roll back.
 */
export function restoreDatabase({ backupFile, dbPath, keepCurrent = true }) {
  const report = verifyDatabase(backupFile);
  if (!report.ok) throw new Error('RESTORE_INTEGRITY_FAILED: ' + report.integrity);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let previous = null;
  if (fs.existsSync(dbPath)) {
    if (!keepCurrent) {
      fs.rmSync(dbPath, { force: true });
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      previous = dbPath + '.pre-restore-' + stamp;
      fs.renameSync(dbPath, previous);
    }
  }
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = dbPath + suffix;
    if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
  }
  fs.copyFileSync(backupFile, dbPath);
  const restored = verifyDatabase(dbPath);
  if (!restored.ok) throw new Error('RESTORE_VERIFY_FAILED: ' + restored.integrity);
  return { restoredTo: dbPath, previousFile: previous, ...restored };
}
