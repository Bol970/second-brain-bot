ALTER TABLE chunks ADD COLUMN vector_id TEXT;
ALTER TABLE chunks ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE chunks ADD COLUMN embedding_model TEXT;
ALTER TABLE chunks ADD COLUMN embedding_index_name TEXT;
ALTER TABLE chunks ADD COLUMN embedded_at TEXT;
ALTER TABLE chunks ADD COLUMN embedding_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_vector_id
  ON chunks(vector_id)
  WHERE vector_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chunks_owner_embedding_status
  ON chunks(owner_id, embedding_status);
