#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(rootDir, '.env') });

const backupFile = process.argv[2];
if (!backupFile) {
  console.error('Usage: npm run db:restore -w server -- <backup-file.sqlite>');
  process.exit(1);
}

const { config } = await import('../src/config.js');
const { restoreDatabase } = await import('../src/services/backup.js');

try {
  const result = restoreDatabase({
    // Resolve like DB_PATH: relative to the repository root, not process.cwd(),
    // so `npm run db:restore -w server` and root-level runs address the same file.
    backupFile: path.isAbsolute(backupFile) ? backupFile : path.resolve(rootDir, backupFile),
    dbPath: config.dbPath,
    keepCurrent: true,
  });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
}
