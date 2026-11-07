import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(rootDir, '.env') });

const [{ assertConfig, config }, { createApp, attachClientBuild }, { purgeExpiredSessions }] = await Promise.all([
  import('./config.js'),
  import('./app.js'),
  import('./services/sessions.js'),
]);
assertConfig();
const app = createApp();
const servesClient = attachClientBuild(app);
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`NOVA API is listening on http://0.0.0.0:${config.port}`);
  console.log(servesClient ? 'NOVA web client build is served from client/dist' : 'No client/dist build found; API only');
});

// Housekeeping: drop expired sessions so the table cannot grow unbounded.
const housekeeping = setInterval(() => {
  try {
    const removed = purgeExpiredSessions();
    if (removed) console.log(`[NOVA] purged ${removed} expired session(s)`);
  } catch (error) {
    console.error('[NOVA] session purge failed', error?.message);
  }
}, 6 * 60 * 60 * 1000);
housekeeping.unref();
try { purgeExpiredSessions(); } catch (error) { console.error('[NOVA] session purge failed', error?.message); }

function shutdown(signal) {
  console.log(`\n${signal}: shutting down NOVA API...`);
  clearInterval(housekeeping);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
