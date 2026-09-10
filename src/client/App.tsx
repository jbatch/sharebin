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
  Pencil,
  Search,
  Shield,
  Trash2,
  Upload,
  User,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileDto, FileVisibility, InviteDto, MeResponse, PublicFileResponse, UserDto } from "../shared/types.js";

type UploadItem = {
  id: string;
  file: File;
  progress: number;
  status: "queued" | "uploading" | "done" | "error";
  error?: string;
  result?: FileDto;
};

type TabName = "upload" | "files" | "admin";
type ExpiryPreset = "never" | "1d" | "7d" | "30d";
type UploadMode = "file" | "text";
type FileSettingsPatch = {
  originalFilename?: string;
  visibility?: FileVisibility;
  expiresAt?: string | null;
  password?: string;
};

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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
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

function UploadScreen({ onUploaded }: { onUploaded: () => void }) {
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
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState("");

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const incoming = Array.from(files).map((file) => ({
        id: crypto.randomUUID(),
        file,
        progress: 0,
        status: "queued" as const
      }));
      setItems((current) => [...incoming, ...current]);
      incoming.forEach((item) => uploadOne(item, visibility, expiry, password, setItems, onUploaded));
    },
    [expiry, onUploaded, password, visibility]
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
          <span>You can also paste from your clipboard</span>
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
                  <span>{formatBytes(item.file.size)}</span>
                </div>
                <button className="icon-button" onClick={() => setItems((current) => current.filter((next) => next.id !== item.id))} title="Remove">
                  <X size={15} />
                </button>
              </div>
              {item.status === "uploading" && (
                <div className="progress">
                  <span style={{ width: `${item.progress}%` }} />
                </div>
              )}
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

function uploadOne(
  item: UploadItem,
  visibility: FileVisibility,
  expiry: ExpiryPreset,
  password: string,
  setItems: React.Dispatch<React.SetStateAction<UploadItem[]>>,
  onUploaded: () => void
) {
  const xhr = new XMLHttpRequest();
  const form = new FormData();
  form.append("visibility", visibility);
  form.append("expiry", expiry);
  if (visibility === "password") form.append("password", password);
  form.append("files", item.file);
  setItems((current) => current.map((next) => (next.id === item.id ? { ...next, status: "uploading", progress: 2, error: undefined } : next)));
  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable) return;
    setItems((current) => current.map((next) => (next.id === item.id ? { ...next, progress: Math.round((event.loaded / event.total) * 100) } : next)));
  };
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      const result = JSON.parse(xhr.responseText) as { files: FileDto[] };
      setItems((current) => current.map((next) => (next.id === item.id ? { ...next, status: "done", progress: 100, result: result.files[0] } : next)));
      onUploaded();
    } else {
      const payload = safeJson(xhr.responseText);
      setItems((current) => current.map((next) => (next.id === item.id ? { ...next, status: "error", error: payload?.error ?? "Upload failed" } : next)));
    }
  };
  xhr.onerror = () => {
    setItems((current) => current.map((next) => (next.id === item.id ? { ...next, status: "error", error: "Upload failed" } : next)));
  };
  xhr.open("POST", "/api/files");
  xhr.withCredentials = true;
  xhr.send(form);
}

function safeJson(text: string): { error?: string } | null {
  try {
    return JSON.parse(text) as { error?: string };
  } catch {
    return null;
  }
}

function FilesScreen({ reloadSignal }: { reloadSignal: number }) {
  const [files, setFiles] = useState<FileDto[]>([]);
  const [storage, setStorage] = useState({ usedBytes: 0, quotaBytes: 1 });
  const [q, setQ] = useState("");
  const [type, setType] = useState("all");
  const [linkState, setLinkState] = useState<"active" | "expired">("active");
  const [visibility, setVisibility] = useState<FileVisibility | "all">("all");
  const [sort, setSort] = useState("newest");
  const [deleteId, setDeleteId] = useState("");
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ q, type, visibility, sort, archived: linkState === "expired" ? "true" : "false" });
    const data = await api<{ files: FileDto[]; storage: { usedBytes: number; quotaBytes: number } }>(`/api/files?${params}`);
    setFiles(data.files);
    setStorage(data.storage);
  }, [linkState, q, sort, type, visibility]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load, reloadSignal]);

  async function remove(file: FileDto) {
    await api(`/api/files/${file.id}`, { method: "DELETE" });
    setDeleteId("");
    await load();
  }

  async function updateFilename(file: FileDto) {
    const nextName = rename?.name.trim();
    if (!nextName) return;
    await updateFile(file, { originalFilename: nextName });
    setRename(null);
  }

  const storagePct = Math.min(100, Math.round((storage.usedBytes / storage.quotaBytes) * 100));

  function keepInCurrentFilter(file: FileDto): boolean {
    if ((expiryControlValue(file.expiresAt) === "archived") !== (linkState === "expired")) return false;
    return visibility === "all" || file.visibility === visibility;
  }

  async function updateFile(file: FileDto, patch: FileSettingsPatch) {
    const data = await api<{ file: FileDto }>(`/api/files/${file.id}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
    setFiles((current) => current.map((item) => (item.id === file.id ? data.file : item)).filter(keepInCurrentFilter));
    return data.file;
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
                {rename?.id === file.id ? (
                  <form
                    className="rename-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      updateFilename(file).catch(() => undefined);
                    }}
                  >
                    <input value={rename.name} onChange={(event) => setRename({ id: file.id, name: event.target.value })} aria-label={`Filename for ${file.originalFilename}`} autoFocus />
                    <button className="icon-button blue" type="submit" title="Save filename">
                      <Check size={15} />
                    </button>
                    <button className="icon-button" type="button" onClick={() => setRename(null)} title="Cancel rename">
                      <X size={15} />
                    </button>
                  </form>
                ) : (
                  <strong>{file.originalFilename}</strong>
                )}
                <span>
                  {formatBytes(file.sizeBytes)} · {formatDate(file.createdAt)} · {plural(file.viewCount, "view")} · {plural(file.downloadCount, "download")}
                </span>
                <div className="badge-row">
                  <Badge visibility={file.visibility} />
                  <Badge expiresAt={file.expiresAt} />
                </div>
              </div>
            </div>
            {deleteId === file.id ? (
              <div className="confirm-delete">
                <button onClick={() => remove(file)}>Delete</button>
                <button onClick={() => setDeleteId("")}>Keep</button>
              </div>
            ) : (
              <div className="file-actions">
                <FileSettingsControls file={file} onUpdate={(patch) => updateFile(file, patch)} />
                <div className="file-action-buttons">
                  <button className="icon-button" onClick={() => setRename({ id: file.id, name: file.originalFilename })} title="Rename">
                    <Pencil size={15} />
                  </button>
                  <a className="icon-button" href={`/v/${encodeURIComponent(file.id)}`} title="View">
                    <Eye size={15} />
                  </a>
                  <button className="icon-button blue" onClick={() => navigator.clipboard.writeText(file.viewUrl)} title="Copy view link">
                    <Copy size={15} />
                  </button>
                  <button className="icon-button red" onClick={() => setDeleteId(file.id)} title="Delete">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            )}
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

function PublicView({ fileId }: { fileId: string }) {
  const [data, setData] = useState<PublicFileResponse | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const publicData = await api<PublicFileResponse>(`/api/public/files/${encodeURIComponent(fileId)}`);
    setData(publicData);
    setCanManage(false);
    if (!publicData.file) return;
    try {
      const managedData = await api<{ file: FileDto }>(`/api/files/${encodeURIComponent(fileId)}`);
      setData((current) => (current ? { ...current, status: "available", file: managedData.file } : current));
      setCanManage(true);
    } catch {
      setCanManage(false);
    }
  }, [fileId]);

  useEffect(() => {
    load().catch(() => setData({ status: "not_found" }));
  }, [load]);

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api(`/api/public/files/${encodeURIComponent(fileId)}/unlock`, { method: "POST", body: JSON.stringify({ password }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Incorrect password");
    }
  }

  async function updatePublicFile(patch: FileSettingsPatch) {
    const data = await api<{ file: FileDto }>(`/api/files/${encodeURIComponent(fileId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
    setData((current) => (current ? { ...current, status: "available", file: data.file } : current));
    return data.file;
  }

  const status = data?.status ?? "available";
  const file = data?.file;

  return (
    <main className="public-page">
      <div className="public-top">
        <a href="/">
          <span>Back</span>
        </a>
        <span>·</span>
        <span>Recipient view at share.jbat.ch/v/{fileId}</span>
      </div>
      <div className="public-shell">
        {status === "available" && file && (
          <div className="public-card">
            <Preview file={file} />
            <h1>{file.originalFilename}</h1>
            <p>
              {formatBytes(file.sizeBytes)} · uploaded {formatDate(file.createdAt)}
            </p>
            <Badge expiresAt={file.expiresAt} />
            {canManage && (
              <div className="public-settings">
                <FileSettingsControls file={file} onUpdate={updatePublicFile} />
              </div>
            )}
            <a className="button sky" href={file.directUrl}>
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
    </main>
  );
}

function Preview({ file }: { file: FileDto }) {
  if (file.mimeType.startsWith("image/") && file.mimeType !== "image/svg+xml") {
    return <img className="preview" src={file.previewUrl} alt="" />;
  }
  if (file.mimeType.startsWith("video/")) return <video className="preview" src={file.previewUrl} controls />;
  if (file.mimeType.startsWith("audio/")) return <audio className="audio-preview" src={file.previewUrl} controls />;
  if (file.mimeType === "application/pdf") return <iframe className="preview" src={file.previewUrl} title={file.originalFilename} />;
  return <div className="preview unavailable">preview unavailable for .{file.safeFilename.split(".").pop() ?? "file"}</div>;
}

function AppShell({ user, onLogout }: { user: UserDto; onLogout: () => void }) {
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
        {tab === "upload" && <UploadScreen onUploaded={() => setReloadSignal((current) => current + 1)} />}
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
  const publicMatch = window.location.pathname.match(/^\/v\/([^/]+)/);

  useEffect(() => {
    api<MeResponse>("/api/me")
      .then(setMe)
      .catch(() => setMe({ setupRequired: false, user: null }));
  }, []);

  if (publicMatch) return <PublicView fileId={decodeURIComponent(publicMatch[1])} />;
  if (!me) return <main className="center-page">Loading</main>;
  if (me.setupRequired || !me.user || inviteCode) {
    return <AuthCard setup={me.setupRequired} inviteCode={inviteCode} onDone={(user) => setMe({ setupRequired: false, user })} />;
  }
  return <AppShell user={me.user} onLogout={() => setMe({ setupRequired: false, user: null })} />;
}
