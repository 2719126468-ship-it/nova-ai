#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(rootDir, '.env') });

const { config } = await import('../src/config.js');
const { backupDatabase } = await import('../src/services/backup.js');

const outDir = process.env.BACKUP_DIR
  ? path.resolve(process.cwd(), process.env.BACKUP_DIR)
  : path.join(rootDir, 'backups');
const keep = Number(process.env.BACKUP_KEEP || 7);

try {
  const result = await backupDatabase({ dbPath: config.dbPath, outDir, keep });
  console.log(JSON.stringify({
    ok: true,
    file: result.file,
    bytes: result.bytes,
    sha256: result.sha256,
    integrity: result.integrity,
    schemaVersion: result.schemaVersion,
    keep,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
}
