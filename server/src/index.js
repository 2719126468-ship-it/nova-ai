import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(rootDir, '.env') });

const [{ assertConfig, config }, { createApp }] = await Promise.all([
  import('./config.js'),
  import('./app.js'),
]);
assertConfig();
const app = createApp();
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`NOVA API is listening on http://0.0.0.0:${config.port}`);
});

function shutdown(signal) {
  console.log(`\n${signal}: shutting down NOVA API...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
