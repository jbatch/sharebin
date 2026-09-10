import fs from "node:fs";
import path from "node:path";
import { lookup } from "mime-types";
import type { FileDto, PublicFileStatus, UserDto } from "../shared/types.js";
import type { FileRow, UserRow } from "./db.js";

const textExtensions = new Set([
  ".txt",
  ".md",
  ".json",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".css",
  ".html",
  ".xml",
  ".csv",
  ".log",
  ".yaml",
  ".yml"
]);

export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename || "file");
  const normalized = base
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  const safe = normalized.replace(/^\.+/, "").slice(0, 140);
  return safe || "file";
}

export function storagePathFor(filesDir: string, fileId: string): string {
  const clean = fileId.replace(/[^A-Za-z0-9_-]/g, "");
  return path.join(filesDir, clean.slice(0, 2), clean.slice(2, 4), clean);
}

export function isExpired(file: Pick<FileRow, "expires_at">, at = new Date()): boolean {
  return Boolean(file.expires_at && new Date(file.expires_at).getTime() <= at.getTime());
}

export function canOwnFile(user: UserRow | null, file: FileRow): boolean {
  return Boolean(user && (user.role === "admin" || user.id === file.owner_user_id));
}

export function safeInlineMime(mimeType: string, filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  if (mimeType === "image/svg+xml" || ext === ".svg") return false;
  if (mimeType.startsWith("image/")) return true;
  if (mimeType.startsWith("audio/")) return true;
  if (mimeType.startsWith("video/")) return true;
  if (mimeType === "application/pdf") return true;
  if (mimeType.startsWith("text/")) return true;
  return textExtensions.has(ext);
}

export function fallbackMime(filename: string): string {
  const mime = lookup(filename);
  if (!mime || mime === "image/svg+xml") return "application/octet-stream";
  return mime;
}

export function toFileDto(file: FileRow, baseUrl: string): FileDto {
  const directPath = `/f/${encodeURIComponent(file.id)}/${encodeURIComponent(file.safe_filename)}`;
  const previewPath = `/p/${encodeURIComponent(file.id)}/${encodeURIComponent(file.safe_filename)}`;
  const viewPath = `/v/${encodeURIComponent(file.id)}`;
  return {
    id: file.id,
    originalFilename: file.original_filename,
    safeFilename: file.safe_filename,
    mimeType: file.mime_type,
    detectedType: file.detected_type,
    sizeBytes: file.size_bytes,
    sha256: file.sha256,
    viewCount: file.view_count,
    downloadCount: file.download_count,
    visibility: file.visibility,
    expiresAt: file.expires_at,
    createdAt: file.created_at,
    updatedAt: file.updated_at,
    ownerUsername: file.owner_username,
    directUrl: new URL(directPath, baseUrl).toString(),
    previewUrl: new URL(previewPath, baseUrl).toString(),
    viewUrl: new URL(viewPath, baseUrl).toString()
  };
}

export function publicStatus(file: FileRow | null, user: UserRow | null, hasPasswordToken: boolean): PublicFileStatus {
  if (!file || file.deleted_at || !fs.existsSync(file.storage_path)) return "not_found";
  if (isExpired(file) && !canOwnFile(user, file)) return "expired";
  if (file.visibility === "private" && !canOwnFile(user, file)) return "private";
  if (file.visibility === "password" && !canOwnFile(user, file) && !hasPasswordToken) return "password_required";
  return "available";
}

export function userDto(user: UserRow): UserDto {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role
  };
}
