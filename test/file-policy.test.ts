import { describe, expect, it } from "vitest";
import type { FileRow, UserRow } from "../src/server/db.js";
import { canOwnFile, isExpired, publicStatus, safeInlineMime, sanitizeFilename } from "../src/server/file-policy.js";

const existingStoragePath = new URL(import.meta.url).pathname;

function file(overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: "file1",
    owner_user_id: "user1",
    storage_path: existingStoragePath,
    original_filename: "report.pdf",
    safe_filename: "report.pdf",
    mime_type: "application/pdf",
    detected_type: "application/pdf",
    size_bytes: 100,
    sha256: "abc",
    view_count: 0,
    download_count: 0,
    visibility: "public",
    password_hash: null,
    expires_at: null,
    deleted_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

function user(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "user1",
    username: "you",
    email: null,
    password_hash: "hash",
    role: "user",
    disabled_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

describe("file policy", () => {
  it("sanitizes URL filenames without preserving traversal", () => {
    expect(sanitizeFilename("../../summer plan?.svg")).toBe("summer-plan.svg");
    expect(sanitizeFilename("   ")).toBe("file");
  });

  it("detects expiry decisions", () => {
    expect(isExpired(file({ expires_at: new Date(Date.now() - 1000).toISOString() }))).toBe(true);
    expect(isExpired(file({ expires_at: new Date(Date.now() + 100000).toISOString() }))).toBe(false);
  });

  it("allows owners and admins to manage private files", () => {
    const row = file({ visibility: "private" });
    expect(canOwnFile(user(), row)).toBe(true);
    expect(canOwnFile(user({ id: "admin", role: "admin" }), row)).toBe(true);
    expect(canOwnFile(user({ id: "other" }), row)).toBe(false);
  });

  it("forces SVG and unknown files to attachment handling", () => {
    expect(safeInlineMime("image/png", "screen.png")).toBe(true);
    expect(safeInlineMime("image/svg+xml", "icon.svg")).toBe(false);
    expect(safeInlineMime("application/octet-stream", "archive.bin")).toBe(false);
  });

  it("maps deleted rows to not_found before visibility checks", () => {
    expect(publicStatus(file({ deleted_at: new Date().toISOString(), visibility: "password" }), null, false)).toBe("not_found");
  });

  it("lets owners inspect expired archived files while public users see expired", () => {
    const row = file({ expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(publicStatus(row, null, false)).toBe("expired");
    expect(publicStatus(row, user(), false)).toBe("available");
    expect(publicStatus(row, user({ id: "admin", role: "admin" }), false)).toBe("available");
  });
});
