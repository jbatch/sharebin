# Sharebin

Sharebin is a small self-hosted file bin for authenticated uploads and public, private, password-protected, or expiring links.

## Local Development

```bash
pnpm install
pnpm run dev
```

The Vite app runs on `http://localhost:3000` and proxies API/file requests to the Fastify server on `http://localhost:8080`.

The development data directory defaults to `.data/`:

- `.data/app.db`
- `.data/files`
- `.data/tmp`

On first run, the app shows setup and creates the first admin user.

Expired links are archived, not deleted: the public direct/view links return expired states, while signed-in users can still see the records from the Files tab's Expired links filter. Delete removes the stored file bytes and the database record.

To test from a phone on the same Wi-Fi, open the Vite network URL shown by `pnpm run dev`, such as `http://192.168.20.16:3000/`. Development mode accepts private LAN origins for state-changing requests; production still requires `APP_BASE_URL` to match the deployed origin.

For HTTPS mobile/PWA testing through a local proxy such as `dev.jbat.ch`, point the proxy at your machine's LAN IP on port `3000` and start dev with the public origin:

```bash
APP_BASE_URL=https://dev.jbat.ch pnpm run dev
```

## Configuration

Production requires `SESSION_SECRET` with at least 32 characters.

| Variable | Default |
| --- | --- |
| `APP_BASE_URL` | `http://localhost:8080` |
| `DATABASE_PATH` | `/data/app.db` in production, `.data/app.db` in development |
| `FILES_DIR` | `/data/files` in production, `.data/files` in development |
| `TMP_DIR` | `/data/tmp` in production, `.data/tmp` in development |
| `MAX_FILE_SIZE_BYTES` | `209715200` |
| `DEFAULT_USER_QUOTA_BYTES` | `10737418240` |
| `UPLOAD_RATE_LIMIT` | `60` |
| `TRUST_PROXY` | `false` |
| `PORT` | `8080` |

## Docker

```bash
docker build -t sharebin .
docker run --rm -p 8080:8080 \
  -e APP_BASE_URL=http://localhost:8080 \
  -e SESSION_SECRET=replace-with-at-least-32-random-characters \
  -v "$PWD/.data:/data" \
  sharebin
```

For a home server, start from `docker-compose.example.yml` and bind mount `./data` or your preferred persistent host directory to `/data`.

## Backup

Pause writes or stop the container, then back up `/data/app.db` and `/data/files` together. Restore both from the same point in time.

## Design Reference

The implementation follows [DESIGN_GUIDELINES.md](./DESIGN_GUIDELINES.md) and the screenshots in [ui-mockup](./ui-mockup).
