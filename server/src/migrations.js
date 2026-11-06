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

  {
    version: 2,
    name: 'project-conversation-links',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS project_conversations (
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (project_id, conversation_id)
        );
        CREATE INDEX IF NOT EXISTS idx_project_conversations_user_project
          ON project_conversations(user_id, project_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_project_conversations_conversation
          ON project_conversations(conversation_id);
      `);
    },
  },

  {
    version: 3,
    name: 'persistent-ai-usage-records',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS ai_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT NOT NULL UNIQUE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          operation TEXT NOT NULL CHECK(operation IN ('chat','stream','edit','retry')),
          status TEXT NOT NULL CHECK(status IN ('in_progress','succeeded','failed','cancelled')),
          error_code TEXT,
          duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
          input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
          output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
          total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens >= 0),
          usage_source TEXT CHECK(usage_source IS NULL OR usage_source = 'provider'),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ai_usage_user_created ON ai_usage(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_usage_status_created ON ai_usage(status, created_at DESC);
      `);
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
