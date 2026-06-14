CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  owner_id TEXT NOT NULL,
  telegram_chat_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  text TEXT NOT NULL,
  due_at TEXT,
  sent_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_owner_status_due
  ON reminders(owner_id, status, due_at);

CREATE INDEX IF NOT EXISTS idx_reminders_item
  ON reminders(item_id);
