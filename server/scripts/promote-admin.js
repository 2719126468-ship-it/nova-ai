import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(rootDir, '.env') });
const { db } = await import('../src/db.js');
const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run admin:promote -- user@example.com');
  db.close();
  process.exit(1);
}
const result = db.prepare("UPDATE users SET role='admin',updated_at=CURRENT_TIMESTAMP WHERE email=?").run(email);
if (!result.changes) {
  console.error(`No account found for ${email}. The user must register first.`);
  db.close();
  process.exit(1);
}
console.log(`Granted admin role to ${email}. Existing sessions may need to sign in again.`);
db.close();
