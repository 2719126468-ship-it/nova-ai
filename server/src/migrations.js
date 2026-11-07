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

  {
    version: 4,
    name: 'assistant-message-version-history',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS message_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('complete','failed','cancelled')),
          error_code TEXT,
          source TEXT NOT NULL CHECK(source IN ('edit_regeneration','retry','restore')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_message_versions_message_created
          ON message_versions(message_id, created_at DESC, id DESC);
      `);
    },
  },
  {
    version: 5,
    name: 'server-managed-ai-providers',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS ai_providers (
          id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 64),
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
          protocol TEXT NOT NULL CHECK(protocol = 'openai-compatible'),
          base_url TEXT NOT NULL CHECK(length(base_url) BETWEEN 1 AND 500),
          api_key_encrypted TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
          models_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_ai_providers_enabled
          ON ai_providers(enabled, name);
        CREATE TABLE IF NOT EXISTS ai_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },
  {
    version: 6,
    name: 'provider-reported-model-context-windows',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS model_context_windows (
          provider_id TEXT NOT NULL,
          upstream_model_id TEXT NOT NULL,
          context_tokens INTEGER NOT NULL CHECK(context_tokens BETWEEN 1 AND 10000000),
          source TEXT NOT NULL CHECK(source = 'provider_reported'),
          checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(provider_id, upstream_model_id)
        );
        CREATE INDEX IF NOT EXISTS idx_model_context_windows_checked
          ON model_context_windows(checked_at);
      `);
    },
  },
  {
    version: 7,
    name: 'workspace-documents',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
          title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
          content TEXT NOT NULL DEFAULT '' CHECK(length(content) <= 200000),
          version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_documents_user_updated
          ON documents(user_id, updated_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_documents_project_updated
          ON documents(user_id, project_id, updated_at DESC, id DESC);

        CREATE TRIGGER IF NOT EXISTS documents_project_owner_insert
        BEFORE INSERT ON documents
        WHEN NEW.project_id IS NOT NULL
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM projects WHERE id=NEW.project_id AND user_id=NEW.user_id
          ) THEN RAISE(ABORT, 'document_project_owner_mismatch') END;
        END;

        CREATE TRIGGER IF NOT EXISTS documents_project_owner_update
        BEFORE UPDATE OF project_id,user_id ON documents
        WHEN NEW.project_id IS NOT NULL
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM projects WHERE id=NEW.project_id AND user_id=NEW.user_id
          ) THEN RAISE(ABORT, 'document_project_owner_mismatch') END;
        END;
      `);
    },
  },
  {
    version: 8,
    name: 'project-instructions-and-material-files',
    up(database) {
      database.exec(`
        ALTER TABLE projects
          ADD COLUMN instructions TEXT NOT NULL DEFAULT '' CHECK(length(instructions) <= 16000);
        ALTER TABLE projects
          ADD COLUMN instructions_version INTEGER NOT NULL DEFAULT 1 CHECK(instructions_version >= 1);

        CREATE TABLE IF NOT EXISTS project_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          original_name TEXT NOT NULL CHECK(length(original_name) BETWEEN 1 AND 180),
          extension TEXT NOT NULL CHECK(extension IN ('.txt','.md','.csv','.json')),
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 2097152),
          sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
          content BLOB NOT NULL,
          extracted_text TEXT NOT NULL,
          include_in_context INTEGER NOT NULL DEFAULT 0 CHECK(include_in_context IN (0,1)),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(project_id,sha256)
        );
        CREATE INDEX IF NOT EXISTS idx_project_files_project_created
          ON project_files(project_id,created_at DESC,id DESC);

        CREATE TRIGGER IF NOT EXISTS project_files_owner_insert
        BEFORE INSERT ON project_files
        WHEN NOT EXISTS (
          SELECT 1 FROM projects WHERE id=NEW.project_id AND user_id=NEW.user_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'project_file_owner_mismatch');
        END;

        CREATE TRIGGER IF NOT EXISTS project_files_owner_update
        BEFORE UPDATE OF project_id,user_id ON project_files
        WHEN NOT EXISTS (
          SELECT 1 FROM projects WHERE id=NEW.project_id AND user_id=NEW.user_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'project_file_owner_mismatch');
        END;
      `);
    },
  },
  {
    version: 9,
    name: 'admin-audit-logs',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS admin_audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 80),
          target_type TEXT NOT NULL CHECK(length(target_type) BETWEEN 1 AND 60),
          target_id TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created
          ON admin_audit_logs(created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_actor
          ON admin_audit_logs(actor_user_id, created_at DESC);
      `);
    },
  },
  {
    version: 10,
    name: 'document-archive',
    up(database) {
      const columns = new Set(database.prepare('PRAGMA table_info(documents)').all().map((column) => column.name));
      if (!columns.has('archived_at')) {
        database.exec('ALTER TABLE documents ADD COLUMN archived_at TEXT');
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_documents_user_archived_updated
          ON documents(user_id, archived_at, updated_at DESC, id DESC);
      `);
    },
  },
  {
    version: 11,
    name: 'model-health-snapshots',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS model_health_snapshots (
          provider_id TEXT NOT NULL,
          upstream_model_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('healthy','degraded','unavailable','unknown')),
          code TEXT,
          duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
          checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(provider_id, upstream_model_id)
        );
        CREATE INDEX IF NOT EXISTS idx_model_health_checked
          ON model_health_snapshots(checked_at DESC);
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
