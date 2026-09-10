import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { FileVisibility, UserRole } from "../shared/types.js";

export type Db = Database.Database;

export type UserRow = {
  id: string;
  username: string;
  email: string | null;
  password_hash: string;
  role: UserRole;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type InviteRow = {
  id: string;
  code_hash: string;
  created_by_user_id: string;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type FileRow = {
  id: string;
  owner_user_id: string;
  storage_path: string;
  original_filename: string;
  safe_filename: string;
  mime_type: string;
  detected_type: string;
  size_bytes: number;
  sha256: string;
  view_count: number;
  download_count: number;
  visibility: FileVisibility;
  password_hash: string | null;
  expires_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  owner_username?: string;
};

export type SessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
};

export function openDatabase(databasePath: string): Db {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      disabled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      created_by_user_id TEXT NOT NULL REFERENCES users(id),
      max_uses INTEGER,
      uses INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      storage_path TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      safe_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      detected_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      view_count INTEGER NOT NULL DEFAULT 0,
      download_count INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL CHECK(visibility IN ('public', 'private', 'password')),
      password_hash TEXT,
      expires_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS files_owner_created_idx ON files(owner_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS files_created_idx ON files(created_at DESC);
    CREATE INDEX IF NOT EXISTS files_deleted_idx ON files(deleted_at);

    CREATE TABLE IF NOT EXISTS file_access_tokens (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS web_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT REFERENCES users(id),
      event_type TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      ip_address TEXT,
      user_agent TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, "files", "view_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "files", "download_count", "INTEGER NOT NULL DEFAULT 0");
}

function ensureColumn(db: Db, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function userCount(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  return row.count;
}
