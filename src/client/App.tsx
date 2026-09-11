import {
  Archive,
  Check,
  Clock,
  Copy,
  Download,
  Eye,
  File as FileIcon,
  FileText,
  Lock,
  LogOut,
  Search,
  Shield,
  Trash2,
  Upload,
  User,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChunkedUploadCompleteResponse,
  ChunkedUploadSessionResponse,
  FileDto,
  FileVisibility,
  InviteDto,
  MeResponse,
  PublicFileResponse,
  UserDto
} from "../shared/types.js";

type UploadItem = {
  id: string;
  file: File;
  progress: number;
  status: "queued" | "uploading" | "assembling" | "done" | "error";
  error?: string;
  result?: FileDto;
};
type ErrorPayload = {
  error?: string;
  code?: string;
  sizeBytes?: number;
  maxFileSizeBytes?: number;
};

type TabName = "upload" | "files" | "admin";
type ExpiryPreset = "never" | "1d" | "7d" | "30d";
type UploadMode = "file" | "text";
type FileSettingsPatch = {
  originalFilename?: string;
  visibility?: FileVisibility;
  expiresAt?: string | null;
  password?: string;
  vanityPath?: string | null;
};
type PublicLookup = { kind: "id" | "vanity"; value: string };

const fallbackMaxFileSizeBytes = 200 * 1024 * 1024;
const chunkedUploadThresholdBytes = 50 * 1024 * 1024;

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = init.body instanceof FormData ? init.headers : init.body ? { "Content-Type": "application/json", ...init.headers } : init.headers;
  const response = await fetch(path, {
    credentials: "include",
    headers,
    ...init
  });
  const payload = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(payload?.error ?? "Request failed");
  return payload as T;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatDate(date: string): string {
  const delta = Date.now() - new Date(date).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (delta < day) return "today";
  if (delta < day * 2) return "1 day ago";
  return `${Math.floor(delta / day)} days ago`;
}

function plural(value: number, singular: string, pluralLabel = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralLabel}`;
}

function expiryLabel(expiresAt: string | null): { text: string; tone: "sky" | "amber" | "red" } | null {
  if (!expiresAt) return null;
  const hours = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (60 * 60 * 1000));
  if (hours <= 0) return { text: "Expired", tone: "red" };
  if (hours < 48) return { text: `Expires in ${hours}h`, tone: "amber" };
  return { text: `Expires in ${Math.ceil(hours / 24)} days`, tone: "sky" };
}

function formatLocalTimestamp(date: string): string {
  return new Date(date).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function expiryControlValue(expiresAt: string | null): string {
  if (!expiresAt) return "never";
  if (new Date(expiresAt).getTime() <= Date.now()) return "archived";
  return "custom";
}

function fileKind(file: FileDto): string {
  if (file.mimeType.startsWith("image/")) return "PNG";
  if (file.mimeType.startsWith("video/")) return "VID";
  if (file.mimeType.startsWith("audio/")) return "AUD";
  if (file.mimeType.includes("pdf")) return "PDF";
  if (file.mimeType.includes("zip") || file.mimeType.includes("tar") || file.mimeType.includes("gzip")) return "ZIP";
  if (file.mimeType.startsWith("text/")) return "TXT";
  return file.safeFilename.split(".").pop()?.slice(0, 4).toUpperCase() || "FILE";
}

function fileExtension(file: FileDto): string {
  const filename = file.originalFilename || file.safeFilename;
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

function textDisplayKind(file: FileDto): "json" | "markdown" | "text" | null {
  const ext = fileExtension(file);
  if (ext === ".json" || file.mimeType.includes("json")) return "json";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (file.mimeType.startsWith("text/")) return "text";
  if ([".csv", ".log", ".yaml", ".yml", ".xml", ".html", ".css", ".js", ".jsx", ".ts", ".tsx"].includes(ext)) return "text";
  return null;
}

function prettyText(kind: "json" | "markdown" | "text", text: string): string {
  if (kind !== "json") return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function AppMark({ small = false }: { small?: boolean }) {
  const size = small ? 24 : 34;
  return (
    <span className="mark" aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 28 28" fill="none">
        <path d="M14 2v7m-4-3.5 4 4 4-4" stroke="#7098C6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="5" y1="10" x2="23" y2="10" stroke="#313131" strokeWidth="2" strokeLinecap="round" />
        <path d="M6.5 10 9 25h10l2.5-15" stroke="#313131" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function Pill({
  active,
  children,
  onClick
}: {
  active?: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button className={`pill ${active ? "active" : ""}`} onClick={onClick} type="button">
      {children}
    </button>
  );
}

function Badge({ visibility, expiresAt }: { visibility?: FileVisibility; expiresAt?: string | null }) {
  if (visibility) {
    const cfg =
      visibility === "password"
        ? { tone: "amber", icon: Lock, text: "Password" }
        : visibility === "private"
          ? { tone: "neutral", icon: User, text: "Private" }
          : { tone: "sky", icon: Eye, text: "Public" };
    const Icon = cfg.icon;
    return (
      <span className={`badge ${cfg.tone}`}>
        <Icon size={12} />
        {cfg.text}
      </span>
    );
  }
  const expiry = expiryLabel(expiresAt ?? null);
  if (!expiry) return null;
  return (
    <span className={`badge ${expiry.tone}`} title={formatLocalTimestamp(expiresAt!)}>
      <Clock size={12} />
      {expiry.text}
    </span>
  );
}

function AuthCard({
  setup,
  inviteCode,
  onDone
}: {
  setup: boolean;
  inviteCode: string | null;
  onDone: (user: UserDto) => void;
}) {
  const [username, setUsername] = useState("you");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const submitInFlightRef = useRef(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setLoading(true);
    setError("");
    try {
      const path = setup ? "/api/setup" : inviteCode ? `/api/invites/${encodeURIComponent(inviteCode)}/accept` : "/api/login";
      const data = await api<{ user: UserDto }>(path, {
        method: "POST",
        body: JSON.stringify({ username, email: email || undefined, password })
      });
      onDone(data.user);
      window.history.replaceState(null, "", "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      submitInFlightRef.current = false;
      setLoading(false);
    }
  }

  return (
    <main className="center-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-stack">
          <AppMark />
          <div className="wordmark">Sharebin</div>
        </div>
        <h1>{setup ? "Create admin account" : inviteCode ? "Accept invite" : "Sign in"}</h1>
        <p>{setup ? "Finish first run setup." : inviteCode ? "Create your account." : "Upload files and share links."}</p>
        {error && <div className="error-box">{error}</div>}
        <label>
          Username
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
        </label>
        {(setup || inviteCode) && (
          <label>
            Email
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" />
          </label>
        )}
        <label>
          Password
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete={setup || inviteCode ? "new-password" : "current-password"}
            placeholder="Password"
          />
        </label>
        <button className="button primary" type="submit" disabled={loading}>
          {loading ? "Working..." : setup ? "Create admin" : inviteCode ? "Create account" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

function UploadScreen({ maxFileSizeBytes, onUploaded }: { maxFileSizeBytes: number; onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<UploadMode>("file");
  const [visibility, setVisibility] = useState<FileVisibility>("public");
  const [expiry, setExpiry] = useState<ExpiryPreset>("never");
  const [password, setPassword] = useState("");
  const [pasteFilename, setPasteFilename] = useState("paste.txt");
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [pasteLoading, setPasteLoading] = useState(false);
  const [pasteResult, setPasteResult] = useState<FileDto | null>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [uploadError, setUploadError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState("");
  const pasteInFlightRef = useRef(false);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const selected = Array.from(files);
      const accepted = selected.filter((file) => file.size <= maxFileSizeBytes);
      const rejected = selected.filter((file) => file.size > maxFileSizeBytes);
      if (rejected.length) {
        const names = rejected
          .slice(0, 3)
          .map((file) => file.name)
          .join(", ");
        const extra = rejected.length > 3 ? ` and ${rejected.length - 3} more` : "";
        setUploadError(`${rejected.length === 1 ? "File is" : "Files are"} too large. Max size is ${formatBytes(maxFileSizeBytes)}: ${names}${extra}`);
      } else {
        setUploadError("");
      }
      if (!accepted.length) return;
      const incoming = accepted.map((file) => ({
        id: crypto.randomUUID(),
        file,
        progress: 0,
        status: "queued" as const
      }));
      setItems((current) => [...incoming, ...current]);
    },
    [maxFileSizeBytes]
  );

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length) addFiles(files);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles]);

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setToast("Copied");
    window.setTimeout(() => setToast(""), 1600);
  }

  async function submitPaste(event: React.FormEvent) {
    event.preventDefault();
    if (pasteInFlightRef.current) return;
    pasteInFlightRef.current = true;
    const pasteSizeBytes = new Blob([pasteText]).size;
    if (pasteSizeBytes > maxFileSizeBytes) {
      setPasteError(`Text file is too large. Max size is ${formatBytes(maxFileSizeBytes)}.`);
      pasteInFlightRef.current = false;
      return;
    }
    setPasteLoading(true);
    setPasteError("");
    setPasteResult(null);
    try {
      const data = await api<{ file: FileDto }>("/api/pastes", {
        method: "POST",
        body: JSON.stringify({
          filename: pasteFilename,
          content: pasteText,
          visibility,
          expiry,
          password: visibility === "password" ? password : undefined
        })
      });
      setPasteResult(data.file);
      onUploaded();
    } catch (err) {
      setPasteError(err instanceof Error ? err.message : "Paste failed");
    } finally {
      pasteInFlightRef.current = false;
      setPasteLoading(false);
    }
  }

  function openPrimaryPicker() {
    if (window.matchMedia("(pointer: coarse)").matches) {
      mediaInputRef.current?.click();
      return;
    }
    inputRef.current?.click();
  }

  function startUploads() {
    items
      .filter((item) => item.status === "queued" || item.status === "error")
      .forEach((item) => uploadOne(item, visibility, expiry, password, setItems, onUploaded));
  }

  const uploadableCount = items.filter((item) => item.status === "queued" || item.status === "error").length;
  const uploadingCount = items.filter((item) => item.status === "uploading" || item.status === "assembling").length;
  const uploadButtonLabel = uploadingCount ? "Uploading..." : uploadableCount ? `Upload ${uploadableCount} ${uploadableCount === 1 ? "file" : "files"}` : "Uploaded";

  return (
    <section>
      <div className="mode-row" role="tablist" aria-label="Upload type">
        <button className={mode === "file" ? "selected" : ""} onClick={() => setMode("file")} type="button">
          <Upload size={14} />
          Files
        </button>
        <button className={mode === "text" ? "selected" : ""} onClick={() => setMode("text")} type="button">
          <FileText size={14} />
          Text
        </button>
      </div>
      <div className="control-row">
        <Pill active={visibility === "public"} onClick={() => setVisibility("public")}>
          Public link
        </Pill>
        <Pill active={visibility === "private"} onClick={() => setVisibility("private")}>
          Private
        </Pill>
        <Pill active={visibility === "password"} onClick={() => setVisibility("password")}>
          Password
        </Pill>
        <span className="divider" />
        {(["never", "1d", "7d", "30d"] as ExpiryPreset[]).map((preset) => (
          <Pill key={preset} active={expiry === preset} onClick={() => setExpiry(preset)}>
            {preset === "never" ? "Never" : preset === "1d" ? "1 day" : preset === "7d" ? "7 days" : "30 days"}
          </Pill>
        ))}
      </div>
      {visibility === "password" && (
        <div className="password-strip">
          <Lock size={14} />
          <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password for new uploads" />
        </div>
      )}
      <input
        ref={mediaInputRef}
        className="hidden-input"
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={(event) => {
          if (event.target.files) addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={inputRef}
        className="hidden-input"
        type="file"
        multiple
        onChange={(event) => {
          if (event.target.files) addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      {mode === "file" ? (
        <>
          <div
            className={`dropzone ${dragging ? "dragging" : ""}`}
            onClick={openPrimaryPicker}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              addFiles(event.dataTransfer.files);
            }}
            role="button"
            tabIndex={0}
          >
            <Upload size={30} />
            <strong>Drop files here or click to choose</strong>
            <span>You can also paste from your clipboard · max {formatBytes(maxFileSizeBytes)} each</span>
            <div className="picker-actions">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  inputRef.current?.click();
                }}
              >
                <FileIcon size={15} />
                Files
              </button>
            </div>
          </div>
          {uploadError && (
            <div className="row-error upload-error">
              <span>{uploadError}</span>
            </div>
          )}
          {items.length > 0 && (
            <div className="upload-actions">
              <button className="button primary compact" type="button" onClick={startUploads} disabled={!uploadableCount || uploadingCount > 0}>
                <Upload size={15} />
                {uploadButtonLabel}
              </button>
            </div>
          )}
        </>
      ) : (
        <form className="paste-card" onSubmit={submitPaste}>
          <label>
            Filename
            <input value={pasteFilename} onChange={(event) => setPasteFilename(event.target.value)} placeholder="paste.txt" />
          </label>
          <label>
            Text
            <textarea value={pasteText} onChange={(event) => setPasteText(event.target.value)} placeholder="Paste text here" />
          </label>
          {pasteError && <div className="row-error paste-error">{pasteError}</div>}
          <button className="button primary" type="submit" disabled={pasteLoading}>
            <FileText size={15} />
            {pasteLoading ? "Creating..." : "Create text file"}
          </button>
          {pasteResult && (
            <div className="link-results">
              <LinkRow label="Direct" value={pasteResult.directUrl} onCopy={() => copy(pasteResult.directUrl)} />
              <LinkRow label="View" value={pasteResult.viewUrl} onCopy={() => copy(pasteResult.viewUrl)} />
            </div>
          )}
        </form>
      )}

      {items.length > 0 && (
        <div className="upload-list">
          {items.map((item) => (
            <div className="upload-item" key={item.id}>
              <div className="item-head">
                <div className="min">
                  <strong>{item.file.name}</strong>
                  <span>
                    {formatBytes(item.file.size)} of {formatBytes(maxFileSizeBytes)} max
                  </span>
                </div>
                <button className="icon-button" onClick={() => setItems((current) => current.filter((next) => next.id !== item.id))} title="Remove">
                  <X size={15} />
                </button>
              </div>
              {(item.status === "uploading" || item.status === "assembling") && (
                <div className="progress">
                  <span style={{ width: `${item.progress}%` }} />
                </div>
              )}
              {item.status === "assembling" && <div className="upload-note">Finishing upload...</div>}
              {item.status === "error" && (
                <div className="row-error">
                  <span>{item.error}</span>
                  <button onClick={() => uploadOne(item, visibility, expiry, password, setItems, onUploaded)}>Retry</button>
                </div>
              )}
              {item.status === "done" && item.result && (
                <div className="link-results">
                  <LinkRow label="Direct" value={item.result.directUrl} onCopy={() => copy(item.result!.directUrl)} />
                  <LinkRow label="View" value={item.result.viewUrl} onCopy={() => copy(item.result!.viewUrl)} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </section>
  );
}

function LinkRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="link-row">
      <span>{label}</span>
      <code>{value.replace(/^https?:\/\//, "")}</code>
      <button className="icon-button blue" onClick={onCopy} title={`Copy ${label.toLowerCase()} link`}>
        <Copy size={15} />
      </button>
    </div>
  );
}

async function uploadOne(
  item: UploadItem,
  visibility: FileVisibility,
  expiry: ExpiryPreset,
  password: string,
  setItems: React.Dispatch<React.SetStateAction<UploadItem[]>>,
  onUploaded: () => void
) {
  setItems((current) => current.map((next) => (next.id === item.id ? { ...next, status: "uploading", progress: 2, error: undefined } : next)));
  try {
    const file =
      item.file.size > chunkedUploadThresholdBytes
        ? await uploadChunkedOne(item, visibility, expiry, password, setItems)
        : await uploadMultipartOne(item, visibility, expiry, password, setItems);
    setItems((current) => current.map((next) => (next.id === item.id ? { ...next, status: "done", progress: 100, result: file } : next)));
    onUploaded();
  } catch (error) {
    setItems((current) =>
      current.map((next) => (next.id === item.id ? { ...next, status: "error", error: error instanceof Error ? error.message : "Upload failed" } : next))
    );
  }
}

function uploadMultipartOne(
  item: UploadItem,
  visibility: FileVisibility,
  expiry: ExpiryPreset,
  password: string,
  setItems: React.Dispatch<React.SetStateAction<UploadItem[]>>
): Promise<FileDto> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("visibility", visibility);
    form.append("expiry", expiry);
    if (visibility === "password") form.append("password", password);
    form.append("files", item.file);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      setItems((current) => current.map((next) => (next.id === item.id ? { ...next, progress: Math.round((event.loaded / event.total) * 100) } : next)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const result = JSON.parse(xhr.responseText) as { files: FileDto[] };
        resolve(result.files[0]);
        return;
      }
      reject(new Error(uploadErrorMessage(safeJson(xhr.responseText))));
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.open("POST", "/api/files");
    xhr.withCredentials = true;
    xhr.send(form);
  });
}

async function uploadChunkedOne(
  item: UploadItem,
  visibility: FileVisibility,
  expiry: ExpiryPreset,
  password: string,
  setItems: React.Dispatch<React.SetStateAction<UploadItem[]>>
): Promise<FileDto> {
  const session = await api<ChunkedUploadSessionResponse>("/api/uploads", {
    method: "POST",
    body: JSON.stringify({
      filename: item.file.name,
      contentType: item.file.type || "application/octet-stream",
      sizeBytes: item.file.size,
      visibility,
      expiry,
      password: visibility === "password" ? password : undefined
    })
  });

  for (let index = 0; index < session.chunkCount; index += 1) {
    const start = index * session.chunkSizeBytes;
    const end = Math.min(start + session.chunkSizeBytes, item.file.size);
    const chunk = item.file.slice(start, end);
    await uploadChunk(session.uploadId, index, chunk, (loaded) => {
      const uploadedBytes = Math.min(start + loaded, item.file.size);
      const progress = Math.max(2, Math.min(98, Math.round((uploadedBytes / item.file.size) * 98)));
      setItems((current) => current.map((next) => (next.id === item.id ? { ...next, progress } : next)));
    });
  }

  setItems((current) => current.map((next) => (next.id === item.id ? { ...next, status: "assembling", progress: 99 } : next)));
  const completed = await api<ChunkedUploadCompleteResponse>(`/api/uploads/${encodeURIComponent(session.uploadId)}/complete`, { method: "POST" });
  return completed.file;
}

function uploadChunk(uploadId: string, chunkIndex: number, chunk: Blob, onProgress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      reject(new Error(uploadErrorMessage(safeJson(xhr.responseText))));
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.open("PUT", `/api/uploads/${encodeURIComponent(uploadId)}/chunks/${chunkIndex}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.send(chunk);
  });
}

function safeJson(text: string): ErrorPayload | null {
  try {
    return JSON.parse(text) as ErrorPayload;
  } catch {
    return null;
  }
}

function uploadErrorMessage(payload: ErrorPayload | null): string {
  if (!payload) return "Upload failed";
  if (payload.code === "FILE_TOO_LARGE" && typeof payload.sizeBytes === "number" && typeof payload.maxFileSizeBytes === "number") {
    return `File is too large: ${formatBytes(payload.sizeBytes)} received, max ${formatBytes(payload.maxFileSizeBytes)}`;
  }
  return payload.error ?? "Upload failed";
}

function FilesScreen({ reloadSignal }: { reloadSignal: number }) {
  const [files, setFiles] = useState<FileDto[]>([]);
  const [storage, setStorage] = useState({ usedBytes: 0, quotaBytes: 1 });
  const [q, setQ] = useState("");
  const [type, setType] = useState("all");
  const [linkState, setLinkState] = useState<"active" | "expired">("active");
  const [visibility, setVisibility] = useState<FileVisibility | "all">("all");
  const [sort, setSort] = useState("newest");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ fileId: string; message: string } | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ q, type, visibility, sort, archived: linkState === "expired" ? "true" : "false" });
    const data = await api<{ files: FileDto[]; storage: { usedBytes: number; quotaBytes: number } }>(`/api/files?${params}`);
    setFiles(data.files);
    setStorage(data.storage);
  }, [linkState, q, sort, type, visibility]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load, reloadSignal]);

  const storagePct = Math.min(100, Math.round((storage.usedBytes / storage.quotaBytes) * 100));

  async function deleteFile(file: FileDto) {
    setDeletingFileId(file.id);
    setDeleteError(null);
    try {
      await api(`/api/files/${encodeURIComponent(file.id)}`, { method: "DELETE" });
      setConfirmingDeleteId(null);
      setFiles((current) => current.filter((item) => item.id !== file.id));
      setStorage((current) => ({ ...current, usedBytes: Math.max(0, current.usedBytes - file.sizeBytes) }));
    } catch (err) {
      setDeleteError({ fileId: file.id, message: err instanceof Error ? err.message : "Delete failed" });
    } finally {
      setDeletingFileId(null);
    }
  }

  return (
    <section className="files-view">
      <div className="storage">
        <div>
          <span>Storage</span>
          <span>
            {formatBytes(storage.usedBytes)} of {formatBytes(storage.quotaBytes)}
          </span>
        </div>
        <div className="storage-track">
          <span style={{ width: `${storagePct}%` }} />
        </div>
      </div>
      <label className="search-box">
        <Search size={15} />
        <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search files" />
      </label>
      <div className="control-row">
        {["all", "images", "docs", "video", "archives"].map((value) => (
          <Pill key={value} active={type === value} onClick={() => setType(value)}>
            {value === "all" ? "All types" : value[0].toUpperCase() + value.slice(1)}
          </Pill>
        ))}
      </div>
      <div className="filter-row">
        <div className="control-row">
          <Pill active={linkState === "active"} onClick={() => setLinkState("active")}>
            Active links
          </Pill>
          <Pill active={linkState === "expired"} onClick={() => setLinkState("expired")}>
            Expired links
          </Pill>
          <span className="divider" aria-hidden="true" />
          {(["all", "public", "private", "password"] as const).map((value) => (
            <Pill key={value} active={visibility === value} onClick={() => setVisibility(value)}>
              {value === "all" ? "All" : value[0].toUpperCase() + value.slice(1)}
            </Pill>
          ))}
        </div>
        <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort files">
          <option value="newest">Newest</option>
          <option value="name">Name</option>
          <option value="size">Size</option>
        </select>
      </div>
      <div className="file-list">
        {files.map((file) => (
          <article className="file-row" key={file.id}>
            <div className="file-info">
              <div className="file-chip">{fileKind(file)}</div>
              <div className="file-main">
                <strong>{file.originalFilename}</strong>
                <span>
                  {formatBytes(file.sizeBytes)} · {formatDate(file.createdAt)} · {plural(file.viewCount, "view")} · {plural(file.downloadCount, "download")}
                </span>
                <div className="badge-row">
                  <Badge visibility={file.visibility} />
                  <Badge expiresAt={file.expiresAt} />
                </div>
              </div>
            </div>
            <div className="file-action-buttons">
              <div className="link-action-group" aria-label="View link actions">
                <a className="icon-button" href={`/v/${encodeURIComponent(file.id)}`} title="View">
                  <Eye size={15} />
                </a>
                <button className="icon-button blue" onClick={() => navigator.clipboard.writeText(file.viewUrl)} title="Copy view link">
                  <Copy size={15} />
                </button>
              </div>
              <div className="link-action-group" aria-label="Download link actions">
                <button className="icon-button blue" onClick={() => navigator.clipboard.writeText(file.downloadUrl)} title="Copy download link">
                  <Copy size={15} />
                </button>
                <a className="icon-button" href={file.downloadUrl} title="Download now">
                  <Download size={15} />
                </a>
              </div>
              {confirmingDeleteId === file.id ? (
                <div className="link-action-group" aria-label={`Confirm delete ${file.originalFilename}`}>
                  <button className="icon-button green" onClick={() => deleteFile(file)} title="Confirm delete" disabled={deletingFileId === file.id}>
                    <Check size={15} />
                  </button>
                  <button className="icon-button red" onClick={() => setConfirmingDeleteId(null)} title="Cancel delete" disabled={deletingFileId === file.id}>
                    <X size={15} />
                  </button>
                </div>
              ) : (
                <button className="icon-button red" onClick={() => setConfirmingDeleteId(file.id)} title="Delete">
                  <Trash2 size={15} />
                </button>
              )}
            </div>
            {deleteError?.fileId === file.id && <div className="row-error file-delete-error">{deleteError.message}</div>}
          </article>
        ))}
        {files.length === 0 && <div className="empty-state">No {linkState === "expired" ? "expired" : "active"} files match these filters.</div>}
      </div>
    </section>
  );
}

function ExpirySelect({ file, onChange }: { file: FileDto; onChange: (value: string) => void }) {
  const value = expiryControlValue(file.expiresAt);
  return (
    <select className="expiry-select" value={value} onChange={(event) => onChange(event.target.value)} aria-label={`Link expiry for ${file.originalFilename}`}>
      <option value="never">No expiry</option>
      {value === "custom" && <option value="custom">Custom</option>}
      {value === "archived" && <option value="archived">Expired</option>}
      <option value="1d">1 day</option>
      <option value="7d">7 days</option>
      <option value="30d">30 days</option>
      <option value="now">Expire now</option>
    </select>
  );
}

function FileSettingsControls({ file, onUpdate }: { file: FileDto; onUpdate: (patch: FileSettingsPatch) => Promise<FileDto> }) {
  const [editingPassword, setEditingPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function update(patch: FileSettingsPatch) {
    setSaving(true);
    setError("");
    try {
      await onUpdate(patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  async function changeVisibility(nextVisibility: FileVisibility) {
    if (nextVisibility === "password") {
      setEditingPassword(true);
      return;
    }
    setEditingPassword(false);
    setPassword("");
    await update({ visibility: nextVisibility });
  }

  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    const nextPassword = password.trim();
    if (!nextPassword) {
      setError("Password is required");
      return;
    }
    await update({ visibility: "password", password: nextPassword });
    setEditingPassword(false);
    setPassword("");
  }

  return (
    <div className="settings-controls">
      <select value={file.visibility} onChange={(event) => changeVisibility(event.target.value as FileVisibility)} disabled={saving} aria-label={`Visibility for ${file.originalFilename}`}>
        <option value="public">Public</option>
        <option value="private">Private</option>
        <option value="password">Password</option>
      </select>
      <ExpirySelect file={file} onChange={(value) => update({ expiresAt: value })} />
      {file.visibility === "password" && !editingPassword && (
        <button className="icon-button" type="button" onClick={() => setEditingPassword(true)} title="Change password">
          <Lock size={15} />
        </button>
      )}
      {editingPassword && (
        <form className="password-edit" onSubmit={savePassword}>
          <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Password" aria-label={`Password for ${file.originalFilename}`} />
          <button className="icon-button blue" type="submit" title="Save password" disabled={saving}>
            <Check size={15} />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => {
              setEditingPassword(false);
              setPassword("");
              setError("");
            }}
            title="Cancel password"
          >
            <X size={15} />
          </button>
        </form>
      )}
      {error && <span className="settings-error">{error}</span>}
    </div>
  );
}

function OwnerFileSettings({
  file,
  onUpdate,
  onCopy,
  onDelete
}: {
  file: FileDto;
  onUpdate: (patch: FileSettingsPatch) => Promise<FileDto>;
  onCopy: (text: string) => void;
  onDelete: () => Promise<void>;
}) {
  const [filename, setFilename] = useState(file.originalFilename);
  const [vanityPath, setVanityPath] = useState(file.vanityPath ?? "");
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setFilename(file.originalFilename);
    setVanityPath(file.vanityPath ?? "");
  }, [file.id, file.originalFilename, file.vanityPath]);

  async function saveDetails(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await onUpdate({
        originalFilename: filename,
        vanityPath: vanityPath.trim() || null
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  async function deleteFile() {
    setSaving(true);
    setError("");
    try {
      await onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setSaving(false);
    }
  }

  return (
    <div className="owner-settings">
      <form className="owner-settings-form" onSubmit={saveDetails}>
        <label>
          Filename
          <input value={filename} onChange={(event) => setFilename(event.target.value)} />
        </label>
        <label>
          Vanity link
          <input value={vanityPath} onChange={(event) => setVanityPath(event.target.value)} placeholder="release-notes" />
        </label>
        <button className="button primary compact" type="submit" disabled={saving}>
          <Check size={15} />
          Save details
        </button>
      </form>
      {file.vanityUrl && <LinkRow label="Vanity" value={file.vanityUrl} onCopy={() => onCopy(file.vanityUrl!)} />}
      <FileSettingsControls file={file} onUpdate={onUpdate} />
      {error && <div className="inline-error">{error}</div>}
      {confirmingDelete ? (
        <div className="confirm-delete owner-delete">
          <button type="button" onClick={deleteFile} disabled={saving}>
            Delete file
          </button>
          <button type="button" onClick={() => setConfirmingDelete(false)} disabled={saving}>
            Keep
          </button>
        </div>
      ) : (
        <button className="text-danger-button" type="button" onClick={() => setConfirmingDelete(true)}>
          <Trash2 size={15} />
          Delete file
        </button>
      )}
    </div>
  );
}

function AdminScreen() {
  const [invites, setInvites] = useState<InviteDto[]>([]);
  const [latestUrl, setLatestUrl] = useState("");

  async function loadInvites() {
    const data = await api<{ invites: InviteDto[] }>("/api/invites");
    setInvites(data.invites);
  }

  useEffect(() => {
    loadInvites().catch(() => undefined);
  }, []);

  async function createInvite() {
    const data = await api<{ url: string }>("/api/invites", { method: "POST", body: JSON.stringify({ maxUses: 1 }) });
    setLatestUrl(data.url);
    await loadInvites();
  }

  async function revoke(id: string) {
    await api(`/api/invites/${id}`, { method: "DELETE" });
    await loadInvites();
  }

  return (
    <section className="admin-view">
      <button className="button primary compact" onClick={createInvite}>
        Create invite
      </button>
      {latestUrl && <LinkRow label="Invite" value={latestUrl} onCopy={() => navigator.clipboard.writeText(latestUrl)} />}
      <div className="file-list">
        {invites.map((invite) => (
          <article className="file-row" key={invite.id}>
            <div className="file-info">
              <div className="file-chip">INV</div>
              <div className="file-main">
                <strong>{invite.id}</strong>
                <span>
                  {invite.uses}
                  {invite.maxUses ? ` of ${invite.maxUses}` : ""} uses · {invite.revokedAt ? "revoked" : "active"}
                </span>
              </div>
            </div>
            {!invite.revokedAt && (
              <button className="icon-button red" onClick={() => revoke(invite.id)} title="Revoke">
                <Trash2 size={15} />
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function PublicView({ lookup }: { lookup: PublicLookup }) {
  const [data, setData] = useState<PublicFileResponse | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const publicApiPath =
    lookup.kind === "vanity"
      ? `/api/public/vanity/${encodeURIComponent(lookup.value)}`
      : `/api/public/files/${encodeURIComponent(lookup.value)}`;

  const load = useCallback(async () => {
    const publicData = await api<PublicFileResponse>(publicApiPath);
    setData(publicData);
    setCanManage(false);
    if (!publicData.file) return;
    try {
      const managedData = await api<{ file: FileDto }>(`/api/files/${encodeURIComponent(publicData.file.id)}`);
      setData((current) => (current ? { ...current, status: "available", file: managedData.file } : current));
      setCanManage(true);
    } catch {
      setCanManage(false);
    }
  }, [publicApiPath]);

  useEffect(() => {
    load().catch(() => setData({ status: "not_found" }));
  }, [load]);

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (!data?.file) return;
    try {
      await api(`/api/public/files/${encodeURIComponent(data.file.id)}/unlock`, { method: "POST", body: JSON.stringify({ password }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Incorrect password");
    }
  }

  async function updatePublicFile(patch: FileSettingsPatch) {
    if (!file) throw new Error("File is not loaded");
    const data = await api<{ file: FileDto }>(`/api/files/${encodeURIComponent(file.id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
    setData((current) => (current ? { ...current, status: "available", file: data.file } : current));
    return data.file;
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setToast("Copied");
    window.setTimeout(() => setToast(""), 1600);
  }

  const status = data?.status ?? "available";
  const file = data?.file;

  async function deletePublicFile() {
    if (!file) return;
    await api(`/api/files/${encodeURIComponent(file.id)}`, { method: "DELETE" });
    window.location.href = "/";
  }

  return (
    <main className="public-page">
      <div className="public-top">
        <a href="/">
          <span>Back</span>
        </a>
        <span>·</span>
        <span>Recipient view at {lookup.kind === "vanity" ? `/vv/${lookup.value}` : `/v/${lookup.value}`}</span>
      </div>
      <div className="public-shell">
        {status === "available" && file && (
          <div className="public-card">
            <Preview file={file} onCopyText={copy} />
            <h1>{file.originalFilename}</h1>
            <p>
              {formatBytes(file.sizeBytes)} · uploaded {formatDate(file.createdAt)}
            </p>
            <Badge expiresAt={file.expiresAt} />
            {canManage && (
              <div className="public-settings">
                <OwnerFileSettings file={file} onUpdate={updatePublicFile} onCopy={copy} onDelete={deletePublicFile} />
              </div>
            )}
            <a className="button sky" href={file.downloadUrl}>
              <Download size={15} />
              Download
            </a>
          </div>
        )}
        {status === "password_required" && file && (
          <form className="public-card centered" onSubmit={unlock}>
            <Lock className="state-icon amber" size={28} />
            <h1>Password required</h1>
            <p>{file.originalFilename} is protected. Ask the sender for the password.</p>
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Password" />
            {error && <div className="inline-error">{error}</div>}
            <button className="button primary" type="submit">
              Unlock
            </button>
          </form>
        )}
        {status === "expired" && (
          <div className="public-card centered">
            <X className="state-icon red" size={28} />
            <h1>This link has expired</h1>
            <p>{file?.originalFilename ?? "This file"} is no longer available. Ask the sender to reshare it.</p>
          </div>
        )}
        {status === "private" && (
          <div className="public-card centered">
            <Shield className="state-icon" size={28} />
            <h1>Sign in to view this file</h1>
            <p>{file?.originalFilename ?? "This file"} is private and requires an account.</p>
            <a className="button primary" href="/">
              Go to sign in
            </a>
          </div>
        )}
        {status === "not_found" && (
          <div className="public-card centered">
            <FileIcon className="state-icon muted" size={28} />
            <h1>File not found</h1>
            <p>This link is broken or the file was deleted.</p>
          </div>
        )}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

function Preview({ file, onCopyText }: { file: FileDto; onCopyText: (text: string) => void }) {
  const textKind = textDisplayKind(file);
  if (textKind) return <TextPreview file={file} kind={textKind} onCopy={onCopyText} />;
  if (file.mimeType.startsWith("image/") && file.mimeType !== "image/svg+xml") {
    return <img className="preview" src={file.previewUrl} alt="" />;
  }
  if (file.mimeType.startsWith("video/")) return <video className="preview" src={file.previewUrl} controls />;
  if (file.mimeType.startsWith("audio/")) return <audio className="audio-preview" src={file.previewUrl} controls />;
  if (file.mimeType === "application/pdf") return <iframe className="preview" src={file.previewUrl} title={file.originalFilename} />;
  return <div className="preview unavailable">preview unavailable for .{file.safeFilename.split(".").pop() ?? "file"}</div>;
}

function TextPreview({ file, kind, onCopy }: { file: FileDto; kind: "json" | "markdown" | "text"; onCopy: (text: string) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const displayText = prettyText(kind, text);

  useEffect(() => {
    let cancelled = false;
    setText("");
    setError("");
    fetch(file.previewUrl, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Preview failed: ${response.status}`);
        return response.text();
      })
      .then((body) => {
        if (!cancelled) setText(body);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Preview unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [file.previewUrl]);

  return (
    <div className={`text-preview ${kind}`}>
      <div className="text-preview-head">
        <span>{kind === "json" ? "JSON" : kind === "markdown" ? "Markdown" : "Text"}</span>
        {text && (
          <button className="icon-button blue" type="button" onClick={() => onCopy(displayText)} title="Copy text">
            <Copy size={15} />
          </button>
        )}
      </div>
      {error ? (
        <div className="preview unavailable">{error}</div>
      ) : !text ? (
        <div className="preview unavailable">Loading preview</div>
      ) : kind === "markdown" ? (
        <div className="markdown-preview">{renderMarkdown(displayText)}</div>
      ) : (
        <pre className="text-preview-body">{displayText}</pre>
      )}
    </div>
  );
}

function renderMarkdown(markdown: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const lines = markdown.split(/\r?\n/);
  let codeLines: string[] | null = null;
  let listItems: string[] = [];

  function flushList() {
    if (!listItems.length) return;
    const items = listItems;
    listItems = [];
    nodes.push(
      <ul key={`ul-${nodes.length}`}>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    );
  }

  lines.forEach((line, index) => {
    if (line.startsWith("```")) {
      if (codeLines) {
        nodes.push(
          <pre key={`code-${index}`}>
            <code>{codeLines.join("\n")}</code>
          </pre>
        );
        codeLines = null;
      } else {
        flushList();
        codeLines = [];
      }
      return;
    }
    if (codeLines) {
      codeLines.push(line);
      return;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushList();
      const level = heading[1].length;
      const Tag = `h${level + 1}` as "h2" | "h3" | "h4";
      nodes.push(<Tag key={`h-${index}`}>{heading[2]}</Tag>);
      return;
    }
    const list = line.match(/^\s*[-*]\s+(.+)$/);
    if (list) {
      listItems.push(list[1]);
      return;
    }
    flushList();
    if (!line.trim()) {
      nodes.push(<br key={`br-${index}`} />);
    } else if (line.startsWith(">")) {
      nodes.push(<blockquote key={`q-${index}`}>{line.replace(/^>\s?/, "")}</blockquote>);
    } else {
      nodes.push(<p key={`p-${index}`}>{line}</p>);
    }
  });
  flushList();
  if (codeLines) {
    const remainingCodeLines = codeLines as string[];
    nodes.push(
      <pre key="code-final">
        <code>{remainingCodeLines.join("\n")}</code>
      </pre>
    );
  }
  return nodes;
}

function AppShell({ user, maxFileSizeBytes, onLogout }: { user: UserDto; maxFileSizeBytes: number; onLogout: () => void }) {
  const [tab, setTab] = useState<TabName>("upload");
  const [menu, setMenu] = useState(false);
  const [reloadSignal, setReloadSignal] = useState(0);

  async function logout() {
    await api("/api/logout", { method: "POST" });
    onLogout();
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand-inline">
          <AppMark small />
          <span>Sharebin</span>
        </div>
        <div className="avatar-wrap">
          <button className="avatar" onClick={() => setMenu((current) => !current)}>{user.username[0]?.toUpperCase() ?? "U"}</button>
          {menu && (
            <div className="avatar-menu">
              <div>Signed in as {user.username}</div>
              <button onClick={logout}>
                <LogOut size={14} />
                Log out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="app-body">
        {tab === "upload" && <UploadScreen maxFileSizeBytes={maxFileSizeBytes} onUploaded={() => setReloadSignal((current) => current + 1)} />}
        {tab === "files" && <FilesScreen reloadSignal={reloadSignal} />}
        {tab === "admin" && <AdminScreen />}
      </main>
      <nav className="tabs" aria-label="Main navigation">
        <button className={tab === "upload" ? "selected" : ""} onClick={() => setTab("upload")}>
          <Upload size={17} />
          Upload
        </button>
        <button className={tab === "files" ? "selected" : ""} onClick={() => setTab("files")}>
          <Archive size={17} />
          Files
        </button>
        {user.role === "admin" && (
          <button className={tab === "admin" ? "selected" : ""} onClick={() => setTab("admin")}>
            <Shield size={17} />
            Admin
          </button>
        )}
      </nav>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const inviteCode = useMemo(() => {
    const match = window.location.pathname.match(/^\/invite\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }, []);
  const publicMatch = window.location.pathname.match(/^\/(v|vv)\/([^/]+)/);

  useEffect(() => {
    api<MeResponse>("/api/me")
      .then(setMe)
      .catch(() => setMe({ setupRequired: false, user: null, maxFileSizeBytes: fallbackMaxFileSizeBytes }));
  }, []);

  if (publicMatch) return <PublicView lookup={{ kind: publicMatch[1] === "vv" ? "vanity" : "id", value: decodeURIComponent(publicMatch[2]) }} />;
  if (!me) return <main className="center-page">Loading</main>;
  if (me.setupRequired || !me.user || inviteCode) {
    return <AuthCard setup={me.setupRequired} inviteCode={inviteCode} onDone={(user) => setMe({ setupRequired: false, user, maxFileSizeBytes: me.maxFileSizeBytes })} />;
  }
  return <AppShell user={me.user} maxFileSizeBytes={me.maxFileSizeBytes} onLogout={() => setMe({ setupRequired: false, user: null, maxFileSizeBytes: me.maxFileSizeBytes })} />;
}
