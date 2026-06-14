PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'telegram',
  telegram_message_id INTEGER,
  telegram_chat_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  summary TEXT,
  url TEXT,
  domain TEXT,
  canonical_url TEXT,
  raw_content TEXT,
  raw_content_truncated INTEGER NOT NULL DEFAULT 0,
  language TEXT,
  importance INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  search_text TEXT NOT NULL DEFAULT '',
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_owner_created
  ON items(owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_items_owner_type_created
  ON items(owner_id, type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_items_owner_url
  ON items(owner_id, url);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'topic',
  created_at TEXT NOT NULL,
  UNIQUE(owner_id, name)
);

CREATE INDEX IF NOT EXISTS idx_tags_owner_name
  ON tags(owner_id, name);

CREATE TABLE IF NOT EXISTS item_tags (
  item_id TEXT NOT NULL,
  tag_id INTEGER NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT 'auto',
  PRIMARY KEY(item_id, tag_id),
  FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_item_tags_tag
  ON item_tags(tag_id, item_id);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_hint INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_item_index
  ON chunks(item_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_chunks_owner
  ON chunks(owner_id);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  r2_key TEXT NOT NULL,
  mime_type TEXT,
  file_name TEXT,
  width INTEGER,
  height INTEGER,
  bytes_original INTEGER,
  bytes_stored INTEGER,
  compression_json TEXT NOT NULL DEFAULT '{}',
  caption TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_owner_created
  ON attachments(owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_attachments_item
  ON attachments(item_id);

CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  telegram_message_id INTEGER,
  telegram_chat_id TEXT,
  direction TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_interactions_owner_created
  ON interactions(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
