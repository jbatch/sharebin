import path from "node:path";

export type AppConfig = {
  appBaseUrl: string;
  databasePath: string;
  filesDir: string;
  tmpDir: string;
  sessionSecret: string;
  maxFileSizeBytes: number;
  defaultUserQuotaBytes: number;
  uploadRateLimit: number;
  trustProxy: boolean;
  nodeEnv: "development" | "test" | "production";
  port: number;
};

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  const nodeEnv = (process.env.NODE_ENV ?? "development") as AppConfig["nodeEnv"];
  const dataDir = process.env.DATA_DIR ?? (nodeEnv === "production" ? "/data" : path.resolve(".data"));
  const sessionSecret = process.env.SESSION_SECRET ?? "";

  if (nodeEnv === "production" && sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be set to at least 32 characters in production");
  }

  return {
    appBaseUrl: process.env.APP_BASE_URL ?? "http://localhost:8080",
    databasePath: process.env.DATABASE_PATH ?? path.join(dataDir, "app.db"),
    filesDir: process.env.FILES_DIR ?? path.join(dataDir, "files"),
    tmpDir: process.env.TMP_DIR ?? path.join(dataDir, "tmp"),
    sessionSecret: sessionSecret || "dev-only-sharebin-session-secret",
    maxFileSizeBytes: readInt("MAX_FILE_SIZE_BYTES", 200 * 1024 * 1024),
    defaultUserQuotaBytes: readInt("DEFAULT_USER_QUOTA_BYTES", 10 * 1024 * 1024 * 1024),
    uploadRateLimit: readInt("UPLOAD_RATE_LIMIT", 60),
    trustProxy: process.env.TRUST_PROXY === "true",
    nodeEnv,
    port: readInt("PORT", 8080)
  };
}
