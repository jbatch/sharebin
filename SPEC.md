# Sharebin Spec

## Summary

Build Sharebin, a simple self-hosted file sharing app inspired by Catbox: authenticated users can upload files and receive short links for direct download or a richer view page. Downloads are public by default, but individual files can be made private, password protected, or expiring.

The intended personal domain is `share.jbat.ch`. The first implementation should prioritize a clean local developer experience, easy Docker deployment on a home server, SQLite persistence, and server/NAS-backed disk storage.

## Product Identity

- App name: Sharebin.
- Primary domain: `share.jbat.ch`.
- Core metaphor: a simple bin for dropping files into and turning them into links.
- Design direction: utilitarian but playful, with visual elements based on bins, drops, file slips, labels, locks, and expiry tags.
- Tone: small, fast, personal, and self-hostable rather than enterprise storage.

## Goals

- Let trusted users upload files through a web UI.
- Return stable, shareable links immediately after upload.
- Support two link styles:
  - Direct file link for download or inline browser rendering.
  - View page link with metadata, preview, and sharing controls.
- Require authentication for uploading.
- Allow unauthenticated downloading for public files.
- Allow files to be marked private, password protected, or expiring.
- Provide a PWA with mobile share sheet integration.
- Package the app as a Docker image suitable for home-server deployment.
- Support GitHub Actions image builds pushed to GitHub Container Registry.
- Start with SQLite and local disk storage, with storage paths configurable for NAS-mounted volumes.

## Non-Goals For MVP

- Multi-tenant public hosting.
- Anonymous uploads.
- Billing.
- Full moderation workflow.
- Distributed storage.
- Object storage support in the first pass.
- End-to-end encryption.
- Social features.
- Rich collaborative albums.

## Target Stack

Recommended stack:

- Frontend: Vite, React, TypeScript.
- Backend: Node.js, TypeScript, Fastify or Hono.
- Database: SQLite.
- ORM/query layer: Drizzle, Kysely, or direct SQLite migrations.
- File storage: local filesystem path mounted into the container, for example `/data/files`.
- Auth: server-managed sessions using secure cookies.
- Packaging: single Docker image serving both API and built frontend.
- CI: GitHub Actions builds and publishes image to `ghcr.io/<owner>/<repo>:<tag>`.

The implementer can choose equivalent tools, but should preserve the deployment and data model assumptions.

## Core User Flows

### 1. First Run Setup

When the app starts with no users:

- Show a setup screen.
- Create the first admin account.
- Store admin credentials securely.
- Disable setup after the first account exists.

### 2. Invite-Only Account Creation

Admin can:

- Create invite links.
- Set optional invite expiry.
- Set optional max uses.
- Revoke unused invites.

Invite recipient can:

- Open invite link.
- Create account with username/email and password.
- Log in after account creation.

MVP can allow username-only accounts, but email should be supported as an optional field.

### 3. Upload File

Authenticated user can:

- Drag and drop one or more files.
- Pick files from file input.
- Paste files from clipboard.
- Use the mobile PWA share target.
- See upload progress.
- Receive generated links after upload.

Upload defaults:

- Visibility: public unlisted.
- Expiry: never.
- Password: none.
- Direct download enabled.
- View page enabled.

### 4. Direct File Link

A direct file link should look like:

```text
/f/:fileId/:safeFilename
```

Behavior:

- Public file: accessible without auth.
- Private file: requires owner/admin auth.
- Password-protected file: requires password token or password entry flow.
- Expired file: returns `410 Gone`.
- Deleted file: returns `404 Not Found`.

For browser-safe types, the file may render inline. For risky types, force download or serve as plain text.

### 5. View Page Link

A view page link should look like:

```text
/v/:fileId
```

The view page should show:

- File name.
- File type.
- File size.
- Upload date.
- Expiry state.
- Download button.
- Preview, where supported.
- Password prompt, if required.
- Private/auth-required state, if required.

Owner/admin should additionally see:

- Visibility controls.
- Expiry controls.
- Password controls.
- Delete button.
- Copy direct link.
- Copy view link.

### 6. File Privacy

Each file should support one visibility mode:

- `public`: anyone with the link can access.
- `private`: only owner and admin can access.
- `password`: anyone with the password can access.

Files should also support independent expiry:

- No expiry.
- Expire at a specific timestamp.
- Optional future enhancement: expire after N downloads.

### 7. File Management

Authenticated users can view their files:

- List recent uploads.
- Search by filename.
- Filter by type and visibility.
- Sort by created date, size, or name.
- Delete files they own.
- Update visibility.
- Update expiry.
- Set, change, or remove password.

Admin can:

- View all files.
- Delete any file.
- Disable a user.
- Revoke invites.

## Preview Support

MVP preview types:

- Images: show inline preview.
- Video/audio: native browser player.
- PDF: browser embed where supported.
- Text/code: syntax-highlighted or plain text preview with max byte limit.
- Other files: metadata-only view.

Preview constraints:

- Never execute uploaded HTML, SVG with scripts, PHP, or similar active content.
- Do not trust client-supplied MIME type.
- Sniff MIME type server-side.
- Apply a max preview size for text files.
- For SVG, either force download or sanitize before inline rendering. MVP should force download.

## Security Requirements

### Authentication

- Passwords hashed with Argon2id or bcrypt.
- Session cookies must be `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
- CSRF protection for mutating browser requests, unless using same-origin JSON with robust origin checks.
- API tokens should be separate from web sessions if implemented.

### Upload Safety

- Enforce max upload size.
- Enforce per-user storage quota.
- Enforce server-wide storage limit or at least expose storage metrics.
- Generate server-side file IDs.
- Store original filename separately from storage filename.
- Sanitize filenames used in URLs and headers.
- Never place uploaded files in the app source/public directory.
- Store files under a configured data directory.
- Prevent path traversal.
- Validate file existence against database record before serving.

### Serving Safety

- Use explicit `Content-Type` based on server-side detection.
- Use safe `Content-Disposition`:
  - Inline for known-safe preview types.
  - Attachment for risky or unknown types.
- Set `X-Content-Type-Options: nosniff`.
- Consider `Content-Security-Policy` on view pages.
- Do not execute server-side uploaded content.

### Abuse Controls

- Rate limit login attempts.
- Rate limit uploads per user/IP.
- Rate limit password-protected link attempts.
- Add basic audit logs for upload, delete, login failure, and admin actions.
- Provide a simple admin abuse-delete path.

## Storage Model

Use SQLite for metadata and local filesystem for file bytes.

Recommended container paths:

```text
/app        application code
/data/app.db
/data/files
/data/tmp
```

Deployment should allow a NAS-backed bind mount:

```yaml
volumes:
  - /mnt/nas/file-share:/data
```

Files should be stored using generated paths, not user filenames. Example:

```text
/data/files/ab/cd/abcdef1234567890
```

Store original filename and MIME metadata in SQLite.

## Data Model

Suggested tables:

### users

- `id`
- `username`
- `email`
- `password_hash`
- `role` enum: `admin`, `user`
- `disabled_at`
- `created_at`
- `updated_at`

### invites

- `id`
- `code_hash`
- `created_by_user_id`
- `max_uses`
- `uses`
- `expires_at`
- `revoked_at`
- `created_at`

### files

- `id`
- `owner_user_id`
- `storage_path`
- `original_filename`
- `safe_filename`
- `mime_type`
- `detected_type`
- `size_bytes`
- `sha256`
- `visibility` enum: `public`, `private`, `password`
- `password_hash`
- `expires_at`
- `deleted_at`
- `created_at`
- `updated_at`

### file_access_tokens

Used for password-protected files after successful password entry.

- `id`
- `file_id`
- `token_hash`
- `expires_at`
- `created_at`

### audit_events

- `id`
- `actor_user_id`
- `event_type`
- `target_type`
- `target_id`
- `ip_address`
- `user_agent`
- `metadata_json`
- `created_at`

## API Shape

Exact routing can change, but the implementation should support this shape.

### Auth

- `POST /api/setup`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/me`
- `POST /api/invites`
- `GET /api/invites`
- `DELETE /api/invites/:id`
- `POST /api/invites/:code/accept`

### Files

- `POST /api/files`
- `GET /api/files`
- `GET /api/files/:id`
- `PATCH /api/files/:id`
- `DELETE /api/files/:id`
- `POST /api/files/:id/password`

### Public Access

- `GET /v/:fileId`
- `GET /f/:fileId/:safeFilename`
- `POST /api/public/files/:fileId/unlock`

### Health

- `GET /healthz`
- `GET /readyz`

## Frontend Requirements

### Main Screens

- Setup screen.
- Login screen.
- Upload screen.
- File list/dashboard.
- File detail owner view.
- Public file view page.
- Admin users/invites screen.

### Upload Experience

- Drag/drop zone.
- File picker.
- Clipboard paste upload.
- Multi-file queue.
- Progress per file.
- Error state per file.
- Copy links after each upload.

### PWA Requirements

- `manifest.webmanifest`.
- Service worker.
- Installable app metadata.
- Mobile-friendly upload screen.
- Web Share Target API support:

```json
{
  "share_target": {
    "action": "/share",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": {
      "files": [
        {
          "name": "files",
          "accept": ["*/*"]
        }
      ]
    }
  }
}
```

The `/share` route should require auth. If the user is not logged in, save enough state to complete the upload after login where feasible.

## Configuration

Use environment variables:

- `APP_BASE_URL`
- `DATABASE_PATH`, default `/data/app.db`
- `FILES_DIR`, default `/data/files`
- `TMP_DIR`, default `/data/tmp`
- `SESSION_SECRET`
- `MAX_FILE_SIZE_BYTES`
- `DEFAULT_USER_QUOTA_BYTES`
- `UPLOAD_RATE_LIMIT`
- `TRUST_PROXY`
- `NODE_ENV`

App should fail fast on unsafe production config, especially missing `SESSION_SECRET`.

## Docker Requirements

Provide:

- `Dockerfile`
- `.dockerignore`
- `docker-compose.example.yml`
- Healthcheck
- Non-root runtime user where practical
- Persistent `/data` volume

Example compose shape:

```yaml
services:
  fileshare:
    image: ghcr.io/OWNER/REPO:latest
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      APP_BASE_URL: "https://files.example.com"
      SESSION_SECRET: "replace-me"
      DATABASE_PATH: "/data/app.db"
      FILES_DIR: "/data/files"
      TMP_DIR: "/data/tmp"
      MAX_FILE_SIZE_BYTES: "209715200"
      DEFAULT_USER_QUOTA_BYTES: "10737418240"
    volumes:
      - /mnt/nas/file-share:/data
```

## GitHub Actions Requirements

Add a workflow that:

- Runs typecheck.
- Runs tests.
- Builds frontend and backend.
- Builds Docker image.
- Pushes to GitHub Container Registry on `main` and tags.

Image tags:

- `latest` for default branch.
- Git SHA tag.
- Semver tag when pushing release tags.

## Operational Requirements

- Structured logs.
- Health endpoint verifies process is alive.
- Readiness endpoint verifies SQLite can be opened and files directory is writable.
- Startup migration runner.
- Periodic cleanup job for expired files.
- Admin-visible storage usage.
- Basic backup instructions:
  - Stop container or pause writes.
  - Back up `/data/app.db`.
  - Back up `/data/files`.
  - Restore both together.

## Testing Requirements

### Unit Tests

- Auth password hashing and verification.
- Invite creation/acceptance.
- File visibility decisions.
- Expiry decisions.
- Filename sanitization.
- MIME/type handling.

### Integration Tests

- Upload creates DB row and stored file.
- Public file can be downloaded without auth.
- Private file cannot be downloaded without auth.
- Owner can download private file.
- Password file requires password.
- Expired file returns `410`.
- Delete removes or tombstones file and prevents access.

### Frontend Tests

- Login flow.
- Upload flow.
- Copy links.
- Visibility change.
- Public view page states.

## Suggested Milestones

### Milestone 1: Skeleton

- Vite frontend.
- Backend server.
- SQLite migrations.
- Dockerfile.
- Health endpoints.

### Milestone 2: Auth And Invites

- First-run admin setup.
- Login/logout/session.
- Invite create/accept/revoke.

### Milestone 3: Upload And Public Links

- Authenticated upload.
- Local disk storage.
- File metadata records.
- Direct file links.
- View page with basic metadata.

### Milestone 4: Privacy And Expiry

- Private files.
- Password-protected files.
- Expiring files.
- Cleanup job.

### Milestone 5: File Manager

- User dashboard.
- Search/filter/sort.
- Owner controls.
- Delete.
- Admin basic controls.

### Milestone 6: PWA And Share Target

- Manifest.
- Service worker.
- Mobile share target.
- Mobile upload flow.

### Milestone 7: CI And Deployment

- GitHub Actions image build.
- GHCR push.
- Compose example.
- Deployment docs.

## Acceptance Criteria For MVP

- A fresh deploy can create an admin account from the browser.
- Admin can create an invite.
- Invited user can create an account.
- Authenticated user can upload a file.
- Upload returns both direct and view links.
- Public direct link works without login.
- Private direct link requires login as owner/admin.
- Password-protected file can be unlocked by someone without an account.
- Expired file is inaccessible.
- Owner can delete uploaded file.
- App runs from Docker with `/data` mounted from host/NAS.
- SQLite database and files persist across container restarts.
- GitHub Actions can build and publish the Docker image.
- PWA can be installed and can receive files from mobile share sheet on supported platforms.

## Open Product Decisions

- Should public files be immutable after upload, or can the owner replace file bytes while keeping the same links?
- Should deleting a file physically delete bytes immediately, or tombstone first and clean later?
- Should anonymous read access be logged per file?
- Should password-protected links use one password per file or multiple named share links?
- Should the app support URL uploads in the first non-MVP release?
- Should the app generate ShareX config files once API tokens exist?
- Should upload deduplication by SHA-256 be visible to users or purely internal?

## Future Enhancements

- API tokens.
- ShareX configuration export.
- Browser extension.
- URL upload.
- Albums/collections.
- S3/R2/MinIO storage backend.
- Optional thumbnail generation.
- Optional antivirus scanner integration.
- Optional EXIF stripping.
- Public abuse report form.
- Per-file download counters.
- One-time links.
- WebDAV or CLI client.
- Import/export tool for backup migration.
