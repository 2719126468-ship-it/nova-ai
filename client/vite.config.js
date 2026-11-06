import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  envDir: workspaceRoot,
  plugins: [react()],
  server: { host: '0.0.0.0', port: 5173, strictPort: true },
});
