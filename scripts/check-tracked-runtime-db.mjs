import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_DATABASE_PATH = /^server\/data\/.*\.(?:sqlite3?|db)(?:$|[-.])/i;

export function findTrackedRuntimeDatabaseArtifacts(paths) {
  return paths.filter((file) => RUNTIME_DATABASE_PATH.test(file));
}

export function listTrackedRuntimeDatabaseArtifacts(cwd = process.cwd()) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd,
    encoding: 'utf8',
  });

  if (result.error) {
    throw new Error('Unable to list tracked files: ' + result.error.message);
  }
  if (result.status !== 0) {
    throw new Error('git ls-files failed: ' + (result.stderr || result.status));
  }

  return findTrackedRuntimeDatabaseArtifacts(result.stdout.split('\0').filter(Boolean));
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    const artifacts = listTrackedRuntimeDatabaseArtifacts();
    if (artifacts.length > 0) {
      console.error('Runtime SQLite files must not be tracked in Git:');
      for (const file of artifacts) console.error(' - ' + file);
      process.exitCode = 1;
    } else {
      console.log('No tracked SQLite runtime databases, sidecars, or snapshots found.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
