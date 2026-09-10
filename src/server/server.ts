import cookie from "@fastify/cookie";
import multipart, { type MultipartFile } from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { fileTypeFromFile } from "file-type";
import crypto from "node:crypto";
import fs from "node:fs";
import { rm, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileVisibility, UploadResponse } from "../shared/types.js";
import type { AppConfig } from "./config.js";
import type { Db, FileRow, InviteRow, UserRow } from "./db.js";
import { nowIso, openDatabase } from "./db.js";
import {
  canOwnFile,
  fallbackMime,
  isExpired,
  normalizeVanityPath,
  publicStatus,
  safeInlineMime,
  sanitizeFilename,
  storagePathFor,
  toFileDto,
  userDto
} from "./file-policy.js";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  getUserFromRequest,
  hashPassword,
  publicId,
  randomToken,
  requireOrigin,
  setSessionCookie,
  sha256,
  verifyPassword
} from "./security.js";

type ServerOptions = {
  config: AppConfig;
  db?: Db;
};

type AuthContext = {
  user: UserRow | null;
};

const passwordCookiePrefix = "sharebin_file_";

export async function buildServer({ config, db = openDatabase(config.databasePath) }: ServerOptions): Promise<FastifyInstance> {
  fs.mkdirSync(config.filesDir, { recursive: true });
  fs.mkdirSync(config.tmpDir, { recursive: true });

  const app = Fastify({
    logger: true,
    trustProxy: config.trustProxy
  });

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute"
  });
  await app.register(multipart, {
    limits: {
      fileSize: config.maxFileSizeBytes,
      files: 20
    }
  });

  app.addHook("onRequest", async (request) => {
    if (request.method !== "POST" || (request.url.split("?")[0] !== "/api/files" && request.url.split("?")[0] !== "/share")) return;
    request.log.info(
      {
        contentLength: request.headers["content-length"] ?? null,
        contentType: request.headers["content-type"] ?? null,
        expect: request.headers.expect ?? null,
        maxFileSizeBytes: config.maxFileSizeBytes
      },
      "upload request reached server"
    );
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!requireOrigin(request, config.appBaseUrl)) {
      return reply.code(403).send({ error: "Bad origin" });
    }
  });

  app.addHook("onClose", async () => {
    db.close();
  });

  function auth(request: FastifyRequest): AuthContext {
    return { user: getUserFromRequest(db, request) };
  }

  function requireUser(request: FastifyRequest, reply: FastifyReply): UserRow | null {
    const user = getUserFromRequest(db, request);
    if (!user) {
      reply.code(401).send({ error: "Authentication required" });
      return null;
    }
    return user;
  }

  function requireAdmin(request: FastifyRequest, reply: FastifyReply): UserRow | null {
    const user = requireUser(request, reply);
    if (!user) return null;
    if (user.role !== "admin") {
      reply.code(403).send({ error: "Admin required" });
      return null;
    }
    return user;
  }

  function audit(
    request: FastifyRequest,
    eventType: string,
    targetType: string | null,
    targetId: string | null,
    actorUserId: string | null,
    metadata: Record<string, unknown> = {}
  ): void {
    db.prepare(
      `INSERT INTO audit_events
       (id, actor_user_id, event_type, target_type, target_id, ip_address, user_agent, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      publicId(),
      actorUserId,
      eventType,
      targetType,
      targetId,
      request.ip,
      request.headers["user-agent"] ?? null,
      JSON.stringify(metadata),
      nowIso()
    );
  }

  function cookieSecure(): boolean {
    return config.nodeEnv === "production";
  }

  function passwordCookieName(fileId: string): string {
    return `${passwordCookiePrefix}${fileId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  }

  function hasPasswordToken(request: FastifyRequest, fileId: string): boolean {
    const token = request.cookies[passwordCookieName(fileId)];
    if (!token) return false;
    const found = db
      .prepare("SELECT id FROM file_access_tokens WHERE file_id = ? AND token_hash = ? AND expires_at > ?")
      .get(fileId, sha256(token), nowIso());
    return Boolean(found);
  }

  function getFile(fileId: string): FileRow | null {
    return (
      (db
        .prepare(
          `SELECT files.*, users.username AS owner_username
           FROM files JOIN users ON users.id = files.owner_user_id
           WHERE files.id = ?`
        )
        .get(fileId) as FileRow | undefined) ?? null
    );
  }

  function getFileByVanity(vanityPath: string): FileRow | null {
    return (
      (db
        .prepare(
          `SELECT files.*, users.username AS owner_username
           FROM files JOIN users ON users.id = files.owner_user_id
           WHERE files.vanity_path = ?`
        )
        .get(vanityPath) as FileRow | undefined) ?? null
    );
  }

  function canManageFile(user: UserRow, file: FileRow): boolean {
    return user.role === "admin" || user.id === file.owner_user_id;
  }

  function incrementViewCount(fileId: string): void {
    db.prepare("UPDATE files SET view_count = view_count + 1 WHERE id = ?").run(fileId);
  }

  function incrementDownloadCount(fileId: string): void {
    db.prepare("UPDATE files SET download_count = download_count + 1 WHERE id = ?").run(fileId);
  }

  function publicFileResponse(request: FastifyRequest, file: FileRow | null) {
    const user = auth(request).user;
    const status = publicStatus(file, user, file ? hasPasswordToken(request, file.id) : false);
    if (!file) return { status };
    if (!canOwnFile(user, file) && (status === "available" || status === "expired")) {
      incrementViewCount(file.id);
    }
    const countedFile = getFile(file.id) ?? file;
    return {
      status,
      file: status === "not_found" ? undefined : toFileDto(countedFile, config.appBaseUrl)
    };
  }

  function parseExpiry(input: unknown): string | null {
    if (!input || input === "never") return null;
    if (input === "now") return nowIso();
    if (input === "1d") return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    if (input === "7d") return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    if (input === "30d") return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    if (typeof input === "string") {
      const parsed = new Date(input);
      if (Number.isFinite(parsed.getTime()) && parsed.getTime() > Date.now()) return parsed.toISOString();
    }
    return null;
  }

  async function createStoredFile(
    user: UserRow,
    input: {
      originalFilename: string;
      tmpPath: string;
      sizeBytes: number;
      sha256: string;
      visibility: FileVisibility;
      expiry: unknown;
      password?: string;
      forcedMimeType?: string;
      forcedDetectedType?: string;
    }
  ): Promise<FileRow> {
    if (input.sizeBytes > config.maxFileSizeBytes) {
      await rm(input.tmpPath, { force: true });
      const error = new Error(`File is too large (${input.sizeBytes} bytes, max ${config.maxFileSizeBytes} bytes)`);
      Object.assign(error, {
        code: "FILE_TOO_LARGE",
        sizeBytes: input.sizeBytes,
        maxFileSizeBytes: config.maxFileSizeBytes
      });
      throw error;
    }

    const usedBytes = db
      .prepare("SELECT COALESCE(SUM(size_bytes), 0) AS used FROM files WHERE owner_user_id = ? AND deleted_at IS NULL")
      .get(user.id) as { used: number };
    if (usedBytes.used + input.sizeBytes > config.defaultUserQuotaBytes) {
      await rm(input.tmpPath, { force: true });
      throw new Error("Storage quota exceeded");
    }

    if (input.visibility === "password" && !input.password) {
      await rm(input.tmpPath, { force: true });
      throw new Error("Password uploads require a password");
    }

    const originalFilename = input.originalFilename || "file";
    const safeFilename = sanitizeFilename(originalFilename);
    const id = publicId();
    const finalPath = storagePathFor(config.filesDir, id);
    const detected = input.forcedMimeType ? null : await fileTypeFromFile(input.tmpPath);
    const detectedType = input.forcedDetectedType ?? detected?.mime ?? fallbackMime(originalFilename);
    const mimeType = input.forcedMimeType ?? detectedType;
    const passwordHash = input.visibility === "password" && input.password ? await hashPassword(input.password) : null;
    const now = nowIso();
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    await rename(input.tmpPath, finalPath);

    db.prepare(
      `INSERT INTO files
       (id, owner_user_id, storage_path, original_filename, safe_filename, mime_type, detected_type,
        size_bytes, sha256, visibility, password_hash, expires_at, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
    ).run(
      id,
      user.id,
      finalPath,
      originalFilename,
      safeFilename,
      mimeType,
      detectedType,
      input.sizeBytes,
      input.sha256,
      input.visibility,
      passwordHash,
      parseExpiry(input.expiry),
      now,
      now
    );

    return getFile(id)!;
  }

  async function saveUpload(part: MultipartFile, user: UserRow, fields: Record<string, string>, request: FastifyRequest, uploadId: string): Promise<FileRow> {
    const originalFilename = part.filename || "file";
    const tmpPath = path.join(config.tmpDir, `${publicId()}.upload`);
    const hash = crypto.createHash("sha256");
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      }
    });

    request.log.info(
      {
        uploadId,
        filename: originalFilename,
        fieldname: part.fieldname,
        mimetype: part.mimetype,
        encoding: part.encoding
      },
      "upload file stream started"
    );

    try {
      await pipeline(part.file, meter, fs.createWriteStream(tmpPath));
      request.log.info(
        {
          uploadId,
          filename: originalFilename,
          sizeBytes,
          truncated: Boolean((part.file as typeof part.file & { truncated?: boolean }).truncated)
        },
        "upload file stream completed"
      );
    } catch (error) {
      await rm(tmpPath, { force: true });
      request.log.warn(
        {
          err: error,
          uploadId,
          filename: originalFilename,
          sizeBytes,
          contentLength: request.headers["content-length"] ?? null,
          aborted: request.raw.aborted,
          socketDestroyed: request.socket.destroyed
        },
        "upload file stream failed"
      );
      throw error;
    }

    const visibility = normalizeVisibility(fields.visibility, fields.password);
    return createStoredFile(user, {
      originalFilename,
      tmpPath,
      sizeBytes,
      sha256: hash.digest("hex"),
      visibility,
      expiry: fields.expiry,
      password: fields.password
    });
  }

  async function savePaste(user: UserRow, body: { filename?: string; content?: string; visibility?: FileVisibility; expiry?: unknown; password?: string }) {
    const content = body.content ?? "";
    if (!content.trim()) throw new Error("Text is required");
    const rawFilename = body.filename?.trim() || "paste.txt";
    const originalFilename = path.extname(rawFilename) ? rawFilename : `${rawFilename}.txt`;
    const bytes = Buffer.from(content, "utf8");
    const tmpPath = path.join(config.tmpDir, `${publicId()}.paste`);
    await writeFile(tmpPath, bytes);
    return createStoredFile(user, {
      originalFilename,
      tmpPath,
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      visibility: normalizeVisibility(body.visibility, body.password),
      expiry: body.expiry,
      password: body.password,
      forcedMimeType: "text/plain; charset=utf-8",
      forcedDetectedType: "text/plain"
    });
  }

  async function handleUpload(request: FastifyRequest, reply: FastifyReply, redirectAfter = false) {
    const user = requireUser(request, reply);
    if (!user) return;

    const uploadId = publicId();
    const startedAt = Date.now();
    let aborted = false;
    request.raw.once("aborted", () => {
      aborted = true;
      request.log.warn(
        {
          uploadId,
          contentLength: request.headers["content-length"] ?? null,
          bytesRead: request.socket.bytesRead,
          maxFileSizeBytes: config.maxFileSizeBytes
        },
        "upload request aborted by client or proxy"
      );
    });
    request.log.info(
      {
        uploadId,
        contentLength: request.headers["content-length"] ?? null,
        contentType: request.headers["content-type"] ?? null,
        maxFileSizeBytes: config.maxFileSizeBytes,
        route: request.url
      },
      "upload request started"
    );

    const fields: Record<string, string> = {};
    const files: FileRow[] = [];

    try {
      for await (const part of request.parts()) {
        if (part.type === "field") {
          fields[part.fieldname] = String(part.value ?? "");
          continue;
        }
        if (part.type === "file" && part.fieldname === "files") {
          const row = await saveUpload(part, user, fields, request, uploadId);
          files.push(row);
          audit(request, "file.upload", "file", row.id, user.id, {
            filename: row.original_filename,
            sizeBytes: row.size_bytes
          });
        }
      }
    } catch (error) {
      request.log.warn(
        {
          err: error,
          errorCode: typeof error === "object" && error && "code" in error ? error.code : undefined,
          sizeBytes: typeof error === "object" && error && "sizeBytes" in error ? error.sizeBytes : undefined,
          uploadId,
          aborted,
          contentLength: request.headers["content-length"] ?? null,
          bytesRead: request.socket.bytesRead,
          filesCompleted: files.length,
          elapsedMs: Date.now() - startedAt,
          maxFileSizeBytes: config.maxFileSizeBytes
        },
        "upload failed"
      );
      const errorPayload =
        typeof error === "object" && error && "code" in error && error.code === "FILE_TOO_LARGE"
          ? {
              error: error instanceof Error ? error.message : "File is too large",
              code: "FILE_TOO_LARGE",
              sizeBytes: "sizeBytes" in error ? error.sizeBytes : undefined,
              maxFileSizeBytes: config.maxFileSizeBytes
            }
          : { error: error instanceof Error ? error.message : "Upload failed" };
      return reply.code(400).send(errorPayload);
    }

    if (!files.length) return reply.code(400).send({ error: "No files uploaded" });

    request.log.info(
      {
        uploadId,
        filesCompleted: files.length,
        totalSizeBytes: files.reduce((sum, file) => sum + file.size_bytes, 0),
        elapsedMs: Date.now() - startedAt
      },
      "upload request completed"
    );

    if (redirectAfter) return reply.redirect(`/v/${encodeURIComponent(files[0].id)}`);

    const response: UploadResponse = {
      files: files.map((file) => toFileDto(file, config.appBaseUrl))
    };
    return reply.send(response);
  }

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_request, reply) => {
    try {
      db.prepare("SELECT 1").get();
      fs.accessSync(config.filesDir, fs.constants.W_OK);
      return { ok: true };
    } catch (error) {
      return reply.code(503).send({ ok: false });
    }
  });

  app.get("/api/me", async (request) => {
    const user = auth(request).user;
    const count = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
    return {
      setupRequired: count.count === 0,
      user: user ? userDto(user) : null,
      maxFileSizeBytes: config.maxFileSizeBytes
    };
  });

  app.post("/api/setup", async (request, reply) => {
    const count = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
    if (count.count > 0) return reply.code(409).send({ error: "Setup already completed" });
    const body = request.body as { username?: string; email?: string; password?: string };
    if (!body?.username || !body.password || body.password.length < 8) {
      return reply.code(400).send({ error: "Username and an 8 character password are required" });
    }
    const now = nowIso();
    const userId = publicId();
    db.prepare(
      `INSERT INTO users (id, username, email, password_hash, role, disabled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'admin', NULL, ?, ?)`
    ).run(userId, body.username.trim(), body.email?.trim() || null, await hashPassword(body.password), now, now);
    const token = createSession(db, userId);
    setSessionCookie(reply, token, cookieSecure());
    audit(request, "setup.create_admin", "user", userId, userId);
    return { user: userDto(getUserFromRequest(db, request) ?? (db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow)) };
  });

  app.post("/api/login", { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } }, async (request, reply) => {
    const body = request.body as { username?: string; password?: string };
    const username = body?.username?.trim();
    if (!username || !body.password) return reply.code(400).send({ error: "Username and password are required" });
    const user = db
      .prepare("SELECT * FROM users WHERE (username = ? OR email = ?) AND disabled_at IS NULL")
      .get(username, username) as UserRow | undefined;
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      audit(request, "auth.login_failed", "user", null, null, { username });
      return reply.code(401).send({ error: "Invalid username or password" });
    }
    const token = createSession(db, user.id);
    setSessionCookie(reply, token, cookieSecure());
    return { user: userDto(user) };
  });

  app.post("/api/logout", async (request, reply) => {
    deleteSession(db, request);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/invites", async (request, reply) => {
    const user = requireAdmin(request, reply);
    if (!user) return;
    const rows = db.prepare("SELECT * FROM invites ORDER BY created_at DESC").all() as InviteRow[];
    return {
      invites: rows.map((row) => ({
        id: row.id,
        maxUses: row.max_uses,
        uses: row.uses,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        createdAt: row.created_at
      }))
    };
  });

  app.post("/api/invites", async (request, reply) => {
    const user = requireAdmin(request, reply);
    if (!user) return;
    const body = request.body as { maxUses?: number; expiresAt?: string };
    const code = randomToken(18);
    const now = nowIso();
    const id = publicId();
    db.prepare(
      `INSERT INTO invites (id, code_hash, created_by_user_id, max_uses, uses, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, 0, ?, NULL, ?)`
    ).run(id, sha256(code), user.id, body.maxUses || null, parseExpiry(body.expiresAt), now);
    audit(request, "invite.create", "invite", id, user.id);
    return {
      invite: { id, maxUses: body.maxUses || null, uses: 0, expiresAt: parseExpiry(body.expiresAt), revokedAt: null, createdAt: now },
      code,
      url: new URL(`/invite/${encodeURIComponent(code)}`, config.appBaseUrl).toString()
    };
  });

  app.delete("/api/invites/:id", async (request, reply) => {
    const user = requireAdmin(request, reply);
    if (!user) return;
    const { id } = request.params as { id: string };
    db.prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(), id);
    audit(request, "invite.revoke", "invite", id, user.id);
    return { ok: true };
  });

  app.post("/api/invites/:code/accept", async (request, reply) => {
    const { code } = request.params as { code: string };
    const body = request.body as { username?: string; email?: string; password?: string };
    if (!body?.username || !body.password || body.password.length < 8) {
      return reply.code(400).send({ error: "Username and an 8 character password are required" });
    }
    const invite = db.prepare("SELECT * FROM invites WHERE code_hash = ?").get(sha256(code)) as InviteRow | undefined;
    if (!invite || invite.revoked_at || (invite.expires_at && invite.expires_at <= nowIso())) {
      return reply.code(404).send({ error: "Invite is not available" });
    }
    if (invite.max_uses !== null && invite.uses >= invite.max_uses) {
      return reply.code(409).send({ error: "Invite has already been used" });
    }
    const now = nowIso();
    const userId = publicId();
    const passwordHash = await hashPassword(body.password);
    db.transaction(() => {
      db.prepare(
        `INSERT INTO users (id, username, email, password_hash, role, disabled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'user', NULL, ?, ?)`
      ).run(userId, body.username!.trim(), body.email?.trim() || null, passwordHash, now, now);
      db.prepare("UPDATE invites SET uses = uses + 1 WHERE id = ?").run(invite.id);
    })();
    const token = createSession(db, userId);
    setSessionCookie(reply, token, cookieSecure());
    audit(request, "invite.accept", "invite", invite.id, userId);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow;
    return { user: userDto(user) };
  });

  app.post(
    "/api/files",
    { config: { rateLimit: { max: config.uploadRateLimit, timeWindow: "1 minute" } } },
    async (request, reply) => handleUpload(request, reply)
  );
  app.post(
    "/api/pastes",
    { config: { rateLimit: { max: config.uploadRateLimit, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = requireUser(request, reply);
      if (!user) return;
      try {
        const row = await savePaste(user, request.body as { filename?: string; content?: string; visibility?: FileVisibility; expiry?: unknown; password?: string });
        audit(request, "file.paste", "file", row.id, user.id, {
          filename: row.original_filename,
          sizeBytes: row.size_bytes
        });
        return { file: toFileDto(row, config.appBaseUrl) };
      } catch (error) {
        request.log.warn({ error }, "paste failed");
        return reply.code(400).send({ error: error instanceof Error ? error.message : "Paste failed" });
      }
    }
  );
  app.post(
    "/share",
    { config: { rateLimit: { max: config.uploadRateLimit, timeWindow: "1 minute" } } },
    async (request, reply) => handleUpload(request, reply, true)
  );

  app.get("/api/files", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const query = request.query as { q?: string; type?: string; visibility?: FileVisibility | "all"; sort?: string; archived?: string };
    const clauses = ["files.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (query.archived === "true") {
      clauses.push("files.expires_at IS NOT NULL AND files.expires_at <= ?");
      params.push(nowIso());
    } else {
      clauses.push("(files.expires_at IS NULL OR files.expires_at > ?)");
      params.push(nowIso());
    }
    if (user.role !== "admin") {
      clauses.push("files.owner_user_id = ?");
      params.push(user.id);
    }
    if (query.q) {
      clauses.push("files.original_filename LIKE ?");
      params.push(`%${query.q}%`);
    }
    if (query.visibility && query.visibility !== "all") {
      clauses.push("files.visibility = ?");
      params.push(query.visibility);
    }
    if (query.type && query.type !== "all") {
      const typeMap: Record<string, string[]> = {
        images: ["image/%"],
        docs: ["application/pdf", "text/%"],
        video: ["video/%"],
        archives: ["application/zip", "application/x-tar", "application/gzip", "application/x-7z-compressed"]
      };
      const patterns = typeMap[query.type] ?? [];
      if (patterns.length) {
        clauses.push(`(${patterns.map(() => "files.mime_type LIKE ?").join(" OR ")})`);
        params.push(...patterns);
      }
    }
    const sortSql =
      query.sort === "name"
        ? "files.original_filename COLLATE NOCASE ASC"
        : query.sort === "size"
          ? "files.size_bytes DESC"
          : "files.created_at DESC";
    const rows = db
      .prepare(
        `SELECT files.*, users.username AS owner_username
         FROM files JOIN users ON users.id = files.owner_user_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY ${sortSql}
         LIMIT 200`
      )
      .all(...params) as FileRow[];
    const usage = db
      .prepare("SELECT COALESCE(SUM(size_bytes), 0) AS used FROM files WHERE owner_user_id = ? AND deleted_at IS NULL")
      .get(user.id) as { used: number };
    return {
      files: rows.map((row) => toFileDto(row, config.appBaseUrl)),
      storage: { usedBytes: usage.used, quotaBytes: config.defaultUserQuotaBytes }
    };
  });

  app.get("/api/files/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = request.params as { id: string };
    const file = getFile(id);
    if (!file || file.deleted_at || !canManageFile(user, file)) return reply.code(404).send({ error: "File not found" });
    return { file: toFileDto(file, config.appBaseUrl) };
  });

  app.patch("/api/files/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = request.params as { id: string };
    const file = getFile(id);
    if (!file || file.deleted_at || !canManageFile(user, file)) return reply.code(404).send({ error: "File not found" });
    const body = request.body as { visibility?: FileVisibility; expiresAt?: string | null; password?: string | null; originalFilename?: string; vanityPath?: string | null };
    const originalFilename = body.originalFilename === undefined ? file.original_filename : body.originalFilename.trim();
    if (!originalFilename) return reply.code(400).send({ error: "Filename is required" });
    const visibility = normalizeVisibility(body.visibility ?? file.visibility, body.password ?? undefined);
    const passwordHash = visibility === "password" && body.password ? await hashPassword(body.password) : file.password_hash;
    if (visibility === "password" && !passwordHash) {
      return reply.code(400).send({ error: "Password visibility requires a password" });
    }
    let vanityPath = file.vanity_path;
    if (body.vanityPath !== undefined) {
      try {
        vanityPath = normalizeVanityPath(body.vanityPath);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid vanity link" });
      }
      if (vanityPath) {
        const existing = db.prepare("SELECT id FROM files WHERE vanity_path = ? AND id != ?").get(vanityPath, id);
        if (existing) return reply.code(409).send({ error: "Vanity link is already in use" });
      }
    }
    db.prepare("UPDATE files SET original_filename = ?, safe_filename = ?, visibility = ?, password_hash = ?, vanity_path = ?, expires_at = ?, updated_at = ? WHERE id = ?").run(
      originalFilename,
      sanitizeFilename(originalFilename),
      visibility,
      visibility === "password" ? passwordHash : null,
      vanityPath,
      body.expiresAt === undefined ? file.expires_at : parseExpiry(body.expiresAt),
      nowIso(),
      id
    );
    audit(request, "file.update", "file", id, user.id);
    return { file: toFileDto(getFile(id)!, config.appBaseUrl) };
  });

  app.delete("/api/files/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = request.params as { id: string };
    const file = getFile(id);
    if (!file || file.deleted_at || !canManageFile(user, file)) return reply.code(404).send({ error: "File not found" });
    db.prepare("DELETE FROM files WHERE id = ?").run(id);
    await rm(file.storage_path, { force: true });
    audit(request, "file.delete", "file", id, user.id);
    return { ok: true };
  });

  app.post("/api/files/:id/password", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = request.params as { id: string };
    const file = getFile(id);
    if (!file || file.deleted_at || !canManageFile(user, file)) return reply.code(404).send({ error: "File not found" });
    const body = request.body as { password?: string | null };
    if (!body.password) {
      db.prepare("UPDATE files SET visibility = 'public', password_hash = NULL, updated_at = ? WHERE id = ?").run(nowIso(), id);
      return { file: toFileDto(getFile(id)!, config.appBaseUrl) };
    }
    db.prepare("UPDATE files SET visibility = 'password', password_hash = ?, updated_at = ? WHERE id = ?").run(
      await hashPassword(body.password),
      nowIso(),
      id
    );
    return { file: toFileDto(getFile(id)!, config.appBaseUrl) };
  });

  app.get("/api/public/files/:id", async (request) => {
    const { id } = request.params as { id: string };
    return publicFileResponse(request, getFile(id));
  });

  app.get("/api/public/vanity/:vanityPath", async (request) => {
    const { vanityPath } = request.params as { vanityPath: string };
    try {
      return publicFileResponse(request, getFileByVanity(normalizeVanityPath(vanityPath) ?? ""));
    } catch {
      return { status: "not_found" };
    }
  });

  app.post(
    "/api/public/files/:id/unlock",
    { config: { rateLimit: { max: 8, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { password?: string };
      const file = getFile(id);
      if (!file || file.deleted_at) return reply.code(404).send({ error: "File not found" });
      if (isExpired(file)) return reply.code(410).send({ error: "Link expired" });
      if (file.visibility !== "password" || !file.password_hash || !body.password) {
        return reply.code(400).send({ error: "Password is required" });
      }
      if (!(await verifyPassword(body.password, file.password_hash))) {
        audit(request, "file.password_failed", "file", id, null);
        return reply.code(401).send({ error: "Incorrect password" });
      }
      const token = randomToken();
      db.prepare(
        "INSERT INTO file_access_tokens (id, file_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(publicId(), id, sha256(token), new Date(Date.now() + 60 * 60 * 1000).toISOString(), nowIso());
      reply.setCookie(passwordCookieName(id), token, {
        httpOnly: true,
        sameSite: "lax",
        secure: cookieSecure(),
        path: "/",
        maxAge: 60 * 60
      });
      return { ok: true };
    }
  );

  async function serveStoredFile(request: FastifyRequest, reply: FastifyReply, countDownload: boolean, forceDownload = false) {
    const { id } = request.params as { id: string; safeFilename: string };
    const file = getFile(id);
    const user = auth(request).user;
    const status = publicStatus(file, user, hasPasswordToken(request, id));
    if (status === "not_found") return reply.code(404).send({ error: "File not found" });
    if (status === "expired") return reply.code(410).send({ error: "Link expired" });
    if (status === "private") return reply.code(401).send({ error: "Authentication required" });
    if (status === "password_required") return reply.code(401).send({ error: "Password required" });
    const row = file!;
    if (countDownload) incrementDownloadCount(id);
    const inline = safeInlineMime(row.mime_type, row.original_filename);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Type", row.mime_type);
    reply.header("Content-Length", row.size_bytes);
    reply.header("Content-Disposition", `${inline && !forceDownload ? "inline" : "attachment"}; filename="${row.safe_filename}"`);
    return reply.send(fs.createReadStream(row.storage_path));
  }

  app.get("/f/:id/:safeFilename", async (request, reply) => {
    return serveStoredFile(request, reply, true);
  });

  app.get("/d/:id/:safeFilename", async (request, reply) => {
    return serveStoredFile(request, reply, true, true);
  });

  app.get("/p/:id/:safeFilename", async (request, reply) => {
    return serveStoredFile(request, reply, false);
  });

  const clientDir = path.resolve("dist/client");
  if (fs.existsSync(clientDir)) {
    await app.register(fastifyStatic, {
      root: clientDir,
      wildcard: false
    });
    app.get("*", async (_request, reply) => reply.sendFile("index.html"));
  }

  setInterval(() => {
    const cutoff = nowIso();
    db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(cutoff);
    db.prepare("DELETE FROM file_access_tokens WHERE expires_at <= ?").run(cutoff);
  }, 60 * 60 * 1000).unref();

  return app;
}

function normalizeVisibility(value: unknown, password?: string): FileVisibility {
  if (value === "private") return "private";
  if (value === "password" || password) return "password";
  return "public";
}
