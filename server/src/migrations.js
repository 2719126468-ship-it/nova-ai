const migrations = [
  {
    version: 1,
    name: 'message-generation-status',
    up(database) {
      const columns = new Set(database.prepare('PRAGMA table_info(messages)').all().map((column) => column.name));
      if (!columns.has('status')) {
        database.exec("ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete' CHECK(status IN ('complete','streaming','failed','cancelled'))");
      }
      if (!columns.has('error_code')) {
        database.exec('ALTER TABLE messages ADD COLUMN error_code TEXT');
      }
      database.exec('CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)');
    },
  },
];

export function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
  const record = database.prepare('INSERT INTO schema_migrations(version, name) VALUES(?, ?)');

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const apply = database.transaction(() => {
      migration.up(database);
      record.run(migration.version, migration.name);
    });
    apply();
  }
}
