import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const port = await getFreePort();
const tempDir = mkdtempSync(join(tmpdir(), "sharebin-"));
const serverOutput = [];
const server = spawn(process.execPath, ["dist/server/index.js"], {
  env: {
    ...process.env,
    NODE_ENV: "test",
    APP_BASE_URL: `http://127.0.0.1:${port}`,
    SESSION_SECRET: "smoke-test-session-secret-with-enough-length",
    PORT: String(port),
    DATABASE_PATH: join(tempDir, "app.db"),
    FILES_DIR: join(tempDir, "files"),
    TMP_DIR: join(tempDir, "tmp")
  },
  stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", (chunk) => serverOutput.push(chunk.toString()));
server.stderr.on("data", (chunk) => serverOutput.push(chunk.toString()));
const serverExit = new Promise((resolve) => {
  server.once("exit", (code, signal) => resolve({ code, signal }));
});

try {
  await waitForServer(port);
  await expectJson("/healthz", 200);
  const home = await fetch(`http://127.0.0.1:${port}/`);
  if (home.status !== 200) throw new Error(`home page failed: ${home.status}`);
  if (!(await home.text()).includes("Sharebin")) throw new Error("home page did not include Sharebin");
  const firstMe = await expectJson("/api/me", 200);
  if (firstMe.setupRequired !== true) throw new Error("first run did not require setup");

  const setup = await fetchJson("/api/setup", {
    method: "POST",
    body: JSON.stringify({ username: "admin", password: "password123" })
  });
  const cookie = setup.cookie;
  if (!cookie) throw new Error("setup did not set a session cookie");

  const uploadPath = join(tempDir, "hello.txt");
  writeFileSync(uploadPath, "hello sharebin\n", "utf8");
  const form = new FormData();
  form.append("visibility", "public");
  form.append("expiry", "never");
  form.append("files", new Blob(["hello sharebin\n"], { type: "text/plain" }), "hello.txt");

  const upload = await fetch(`http://127.0.0.1:${port}/api/files`, {
    method: "POST",
    headers: { cookie },
    body: form
  });
  if (upload.status !== 200) throw new Error(`upload failed: ${upload.status} ${await upload.text()}`);
  const uploaded = await upload.json();
  const file = uploaded.files?.[0];
  if (!file?.id || !file.directUrl || !file.downloadUrl || !file.previewUrl || !file.viewUrl) throw new Error("upload response missed file links");
  if (file.viewCount !== 0 || file.downloadCount !== 0) throw new Error("new upload should start with zero metrics");

  const listed = await fetchJson("/api/files", { headers: { cookie } });
  if (!listed.files.some((item) => item.id === file.id)) throw new Error("uploaded file missing from list");

  const publicFile = await fetchJson(`/api/public/files/${file.id}`);
  if (publicFile.status !== "available") throw new Error(`expected public file available, got ${publicFile.status}`);
  if (publicFile.file.viewCount !== 1 || publicFile.file.downloadCount !== 0) {
    throw new Error("public view did not update aggregate view metrics");
  }

  const preview = await fetch(publicFile.file.previewUrl);
  if (preview.status !== 200) throw new Error(`preview failed: ${preview.status}`);
  const afterPreview = await fetchJson("/api/files", { headers: { cookie } });
  const previewedFile = afterPreview.files.find((item) => item.id === file.id);
  if (!previewedFile || previewedFile.viewCount !== 1 || previewedFile.downloadCount !== 0) {
    throw new Error("preview should not increment aggregate download metrics");
  }

  const download = await fetch(file.directUrl);
  if (download.status !== 200) throw new Error(`download failed: ${download.status}`);
  if ((await download.text()) !== "hello sharebin\n") throw new Error("download body mismatch");
  const afterDownload = await fetchJson("/api/files", { headers: { cookie } });
  const downloadedFile = afterDownload.files.find((item) => item.id === file.id);
  if (!downloadedFile || downloadedFile.viewCount !== 1 || downloadedFile.downloadCount !== 1) {
    throw new Error("direct download did not update aggregate download metrics");
  }

  const rename = await fetchJson(`/api/files/${file.id}`, {
    method: "PATCH",
    headers: { cookie },
    body: JSON.stringify({ originalFilename: "renamed report.txt" })
  });
  if (rename.file.originalFilename !== "renamed report.txt" || !rename.file.directUrl.endsWith("/renamed-report.txt")) {
    throw new Error("rename did not update file metadata and direct URL");
  }
  const renamedPublic = await fetchJson(`/api/public/files/${file.id}`, { headers: { cookie } });
  if (renamedPublic.file.originalFilename !== "renamed report.txt") throw new Error("renamed public metadata did not update");
  const renamedDownload = await fetch(rename.file.directUrl);
  if (renamedDownload.status !== 200) throw new Error(`renamed download failed: ${renamedDownload.status}`);
  if (!renamedDownload.headers.get("content-disposition")?.includes('filename="renamed-report.txt"')) {
    throw new Error("renamed download did not use updated content disposition filename");
  }
  const forcedDownload = await fetch(rename.file.downloadUrl);
  if (forcedDownload.status !== 200) throw new Error(`forced download failed: ${forcedDownload.status}`);
  if (!forcedDownload.headers.get("content-disposition")?.startsWith("attachment;")) {
    throw new Error("forced download route did not use attachment disposition");
  }
  const vanityUpdate = await fetchJson(`/api/files/${file.id}`, {
    method: "PATCH",
    headers: { cookie },
    body: JSON.stringify({ vanityPath: "Smoke-Link" })
  });
  if (vanityUpdate.file.vanityPath !== "smoke-link" || !vanityUpdate.file.vanityUrl.endsWith("/vv/smoke-link")) {
    throw new Error("vanity link update did not normalize expected metadata");
  }
  const vanityPublic = await fetchJson("/api/public/vanity/smoke-link", { headers: { cookie } });
  if (vanityPublic.status !== "available" || vanityPublic.file.id !== file.id) {
    throw new Error("vanity public lookup did not resolve to the file");
  }
  const privateUpdate = await fetchJson(`/api/files/${file.id}`, {
    method: "PATCH",
    headers: { cookie },
    body: JSON.stringify({ visibility: "private" })
  });
  if (privateUpdate.file.visibility !== "private") throw new Error("visibility update to private failed");
  const privatePublic = await fetchJson(`/api/public/files/${file.id}`);
  if (privatePublic.status !== "private") throw new Error(`expected private status, got ${privatePublic.status}`);
  await expectStatus(fetch(privateUpdate.file.directUrl), 401);

  const passwordUpdate = await fetchJson(`/api/files/${file.id}`, {
    method: "PATCH",
    headers: { cookie },
    body: JSON.stringify({ visibility: "password", password: "secret123" })
  });
  if (passwordUpdate.file.visibility !== "password") throw new Error("visibility update to password failed");
  const passwordPublic = await fetchJson(`/api/public/files/${file.id}`);
  if (passwordPublic.status !== "password_required") throw new Error(`expected password_required status, got ${passwordPublic.status}`);
  await expectStatus(fetch(passwordUpdate.file.directUrl), 401);

  const publicUpdate = await fetchJson(`/api/files/${file.id}`, {
    method: "PATCH",
    headers: { cookie },
    body: JSON.stringify({ visibility: "public" })
  });
  if (publicUpdate.file.visibility !== "public") throw new Error("visibility update back to public failed");

  const paste = await fetchJson("/api/pastes", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({
      filename: "note-from-smoke",
      content: "pasted smoke text\n",
      visibility: "public",
      expiry: "never"
    })
  });
  if (!paste.file?.directUrl || paste.file.originalFilename !== "note-from-smoke.txt") {
    throw new Error("paste response missed expected text file metadata");
  }
  const pastedDownload = await fetch(paste.file.directUrl);
  if (pastedDownload.status !== 200) throw new Error(`paste download failed: ${pastedDownload.status}`);
  if ((await pastedDownload.text()) !== "pasted smoke text\n") throw new Error("paste download body mismatch");

  const shareForm = new FormData();
  shareForm.append("visibility", "public");
  shareForm.append("expiry", "never");
  shareForm.append("files", new Blob(["shared from pwa\n"], { type: "text/plain" }), "shared.txt");
  const shareUpload = await fetch(`http://127.0.0.1:${port}/share`, {
    method: "POST",
    headers: { cookie },
    body: shareForm,
    redirect: "manual"
  });
  if (shareUpload.status !== 302) throw new Error(`share upload did not redirect: ${shareUpload.status}`);
  const shareLocation = shareUpload.headers.get("location") ?? "";
  if (!shareLocation.startsWith("/v/")) throw new Error(`share upload redirected to ${shareLocation || "missing location"}`);
  const sharedFileId = decodeURIComponent(shareLocation.slice("/v/".length));
  const sharedPublic = await fetchJson(`/api/public/files/${sharedFileId}`, { headers: { cookie } });
  if (sharedPublic.status !== "available" || sharedPublic.file.originalFilename !== "shared.txt") {
    throw new Error("share upload view target did not resolve to uploaded file");
  }

  const expire = await fetch(`http://127.0.0.1:${port}/api/files/${paste.file.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ expiresAt: "now" })
  });
  if (expire.status !== 200) throw new Error(`expire failed: ${expire.status} ${await expire.text()}`);
  const expiredPublic = await fetchJson(`/api/public/files/${paste.file.id}`);
  if (expiredPublic.status !== "expired") throw new Error(`expected paste link expired, got ${expiredPublic.status}`);
  if (expiredPublic.file.viewCount !== 1 || expiredPublic.file.downloadCount !== 1) {
    throw new Error("expired link view did not update aggregate view metrics");
  }
  await expectStatus(fetch(paste.file.directUrl), 410);
  const expiredOwnerView = await fetchJson(`/api/public/files/${paste.file.id}`, { headers: { cookie } });
  if (expiredOwnerView.status !== "available") throw new Error(`expected owner to inspect expired paste, got ${expiredOwnerView.status}`);
  if (expiredOwnerView.file.viewCount !== 1) throw new Error("owner inspection should not increment aggregate view metrics");
  const ownerDownload = await fetch(paste.file.directUrl, { headers: { cookie } });
  if (ownerDownload.status !== 200) throw new Error(`owner download of expired paste failed: ${ownerDownload.status}`);

  const activeAfterExpire = await fetchJson("/api/files", { headers: { cookie } });
  if (activeAfterExpire.files.some((item) => item.id === paste.file.id)) throw new Error("expired paste remained in active files");
  const archived = await fetchJson("/api/files?archived=true", { headers: { cookie } });
  if (!archived.files.some((item) => item.id === paste.file.id)) throw new Error("expired paste missing from expired files filter");
  const archivedPaste = archived.files.find((item) => item.id === paste.file.id);
  if (!archivedPaste || archivedPaste.viewCount !== 1 || archivedPaste.downloadCount !== 2) {
    throw new Error("expired files filter missed aggregate metrics");
  }

  const deletePaste = await fetch(`http://127.0.0.1:${port}/api/files/${paste.file.id}`, { method: "DELETE", headers: { cookie } });
  if (deletePaste.status !== 200) throw new Error(`delete paste failed: ${deletePaste.status}`);
  const archivedAfterDelete = await fetchJson("/api/files?archived=true", { headers: { cookie } });
  if (archivedAfterDelete.files.some((item) => item.id === paste.file.id)) throw new Error("hard-deleted paste remained in expired files filter");
  await expectStatus(fetch(paste.file.directUrl), 404);

  const del = await fetch(`http://127.0.0.1:${port}/api/files/${file.id}`, { method: "DELETE", headers: { cookie } });
  if (del.status !== 200) throw new Error(`delete failed: ${del.status}`);
  await expectStatus(fetch(file.directUrl), 404);

  console.log("smoke ok");
} finally {
  server.kill();
  rmSync(tempDir, { recursive: true, force: true });
}

async function fetchJson(path, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers }
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  return Object.assign(await response.json(), { cookie: response.headers.get("set-cookie")?.split(";")[0] });
}

async function expectJson(path, status) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (response.status !== status) throw new Error(`expected ${status}, got ${response.status}`);
  return response.json();
}

async function expectStatus(promise, status) {
  const response = await promise;
  if (response.status !== status) throw new Error(`expected ${status}, got ${response.status}`);
}

async function waitForServer(portNumber) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`server exited before startup with code ${server.exitCode}\n${readServerOutput()}`);
    }
    try {
      await fetch(`http://127.0.0.1:${portNumber}/healthz`);
      return;
    } catch {
      const exited = await Promise.race([serverExit, new Promise((resolve) => setTimeout(() => resolve(null), 100))]);
      if (exited) {
        throw new Error(`server exited before startup with ${JSON.stringify(exited)}\n${readServerOutput()}`);
      }
    }
  }
  throw new Error(`server did not start within 30s on port ${portNumber}\n${readServerOutput()}`);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

function readServerOutput() {
  return serverOutput.join("").trim();
}
