export interface Migration { version: number; name: string; sql: string }

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  password_changed_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_admin ON sessions(admin_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  original_name TEXT NOT NULL,
  storage_name TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  extension TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','trashed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  trashed_at TEXT,
  deleted_at TEXT,
  api_key_id TEXT,
  idempotency_key TEXT
);
CREATE INDEX idx_videos_status_created ON videos(status, created_at DESC);
CREATE INDEX idx_videos_name ON videos(original_name);
CREATE INDEX idx_videos_size ON videos(size);
CREATE UNIQUE INDEX idx_videos_idem ON videos(api_key_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  actor TEXT,
  ip TEXT,
  metadata TEXT
);
CREATE INDEX idx_audit_created ON audit_events(created_at DESC);
CREATE INDEX idx_audit_type ON audit_events(type);
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    // Additive only: existing rows keep their data and become media_type='video' with metadata_status='pending' (backfilled in the background).
    version: 2,
    name: 'media libraries and metadata',
    sql: `
ALTER TABLE videos ADD COLUMN media_type TEXT NOT NULL DEFAULT 'video';
ALTER TABLE videos ADD COLUMN category TEXT;
ALTER TABLE videos ADD COLUMN metadata_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE videos ADD COLUMN metadata_source TEXT;
ALTER TABLE videos ADD COLUMN metadata_error TEXT;
ALTER TABLE videos ADD COLUMN metadata_updated_at TEXT;
ALTER TABLE videos ADD COLUMN duration_seconds REAL;
ALTER TABLE videos ADD COLUMN width INTEGER;
ALTER TABLE videos ADD COLUMN height INTEGER;
ALTER TABLE videos ADD COLUMN aspect_ratio TEXT;
ALTER TABLE videos ADD COLUMN aspect_ratio_value REAL;
ALTER TABLE videos ADD COLUMN orientation TEXT;
ALTER TABLE videos ADD COLUMN frame_rate REAL;
ALTER TABLE videos ADD COLUMN video_codec TEXT;
ALTER TABLE videos ADD COLUMN audio_codec TEXT;
ALTER TABLE videos ADD COLUMN image_format TEXT;
ALTER TABLE videos ADD COLUMN has_alpha INTEGER;
ALTER TABLE videos ADD COLUMN color_space TEXT;
CREATE INDEX idx_videos_media_status_created ON videos(media_type, status, created_at DESC);
CREATE INDEX idx_videos_media_ext ON videos(media_type, extension);
CREATE INDEX idx_videos_duration ON videos(duration_seconds);
CREATE INDEX idx_videos_dims ON videos(width, height);
CREATE INDEX idx_videos_meta_status ON videos(metadata_status);
CREATE INDEX idx_videos_category ON videos(category);
`,
  },
];
