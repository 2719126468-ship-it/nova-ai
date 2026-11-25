import { spawnSync } from 'node:child_process';

const candidates = [
  'server/data/nova.sqlite',
  'server/data/nova.sqlite-wal',
  'server/data/nova.sqlite-shm',
  'server/data/nova.sqlite-journal',
  'server/data/nova.sqlite.pre-restore-2026-11-25T12-00-00-000Z',
  'server/data/nova.sqlite.backup',
];

const failures = [];
for (const file of candidates) {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', '--', file], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    failures.push(file);
  }
}

if (failures.length) {
  console.error('Runtime SQLite artifacts must be ignored by Git:');
  for (const file of failures) console.error(' - ' + file);
  process.exitCode = 1;
} else {
  console.log('SQLite database, sidecar, backup, and pre-restore paths are ignored.');
}
