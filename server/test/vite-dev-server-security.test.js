import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('Vite dev and preview servers bind to loopback by default', () => {
  const clientPackage = JSON.parse(readRepoFile('client/package.json'));
  const viteConfig = readRepoFile('client/vite.config.js');

  assert.equal(clientPackage.scripts.dev, 'vite');
  assert.equal(clientPackage.scripts.preview, 'vite preview');
  assert.match(viteConfig, /server:\s*\{\s*host:\s*['"]127\.0\.0\.1['"]/);
  assert.match(viteConfig, /preview:\s*\{\s*host:\s*['"]127\.0\.0\.1['"]/);
  assert.doesNotMatch(viteConfig, /host:\s*['"]0\.0\.0\.0['"]/);
});

test('Vite and Rolldown lockfile entries remain on patched releases', () => {
  const clientPackage = JSON.parse(readRepoFile('client/package.json'));
  const lock = JSON.parse(readRepoFile('package-lock.json'));
  const vite = lock.packages['node_modules/vite'];
  const rolldown = lock.packages['node_modules/rolldown'];

  assert.equal(clientPackage.devDependencies.vite, '^8.3.8');
  assert.equal(lock.packages.client.devDependencies.vite, clientPackage.devDependencies.vite);
  assert.equal(vite.version, '8.3.8');
  assert.equal(vite.dependencies.rolldown, '~1.2.18');
  assert.equal(rolldown.version, '1.2.19');

  for (const [name, version] of Object.entries(rolldown.optionalDependencies)) {
    const binding = lock.packages[`node_modules/${name}`];
    assert.equal(binding?.version, version, `${name} lock entry is missing or out of sync`);
    assert.ok(binding.integrity, `${name} lock entry is missing integrity metadata`);
  }
});
