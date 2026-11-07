#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(rootDir, '.env') });

const target = process.argv[2];
const { config } = await import('../src/config.js');
const { verifyDatabase } = await import('../src/services/backup.js');

try {
  const file = target ? path.resolve(process.cwd(), target) : config.dbPath;
  console.log(JSON.stringify({ ok: true, file, ...verifyDatabase(file) }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
}
