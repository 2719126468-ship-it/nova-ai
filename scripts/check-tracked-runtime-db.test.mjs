import assert from 'node:assert/strict';
import test from 'node:test';
import { findTrackedRuntimeDatabaseArtifacts } from './check-tracked-runtime-db.mjs';

test('detects SQLite databases, sidecars, backups, and restore snapshots', () => {
  const paths = [
    'server/data/nova.sqlite',
    'server/data/nova.sqlite-wal',
    'server/data/nova.sqlite-shm',
    'server/data/nova.sqlite-journal',
    'server/data/nova.sqlite.pre-restore-2026-11-07T15-39-30-264Z',
    'server/data/nova.sqlite.backup',
    'server/data/archive/legacy.DB-wal',
  ];

  assert.deepEqual(findTrackedRuntimeDatabaseArtifacts(paths), paths);
});

test('does not flag source files, manifests, or databases outside the runtime directory', () => {
  const paths = [
    'server/data/README.md',
    'server/data/backup-manifest.json',
    'server/src/db.js',
    'docs/examples/demo.sqlite',
    'client/src/data/model.db',
  ];

  assert.deepEqual(findTrackedRuntimeDatabaseArtifacts(paths), []);
});
