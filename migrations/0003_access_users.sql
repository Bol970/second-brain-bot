CREATE TABLE IF NOT EXISTS access_users (
  owner_id TEXT NOT NULL,
  telegram_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  added_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_access_users_owner_status
  ON access_users(owner_id, status);
