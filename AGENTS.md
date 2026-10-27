# Project rules for coding agents (AGENTS.md; identical to CLAUDE.md)

This is **Local Video Host**: a self-hosted, local-disk video storage API with an admin dashboard (Node/Express/SQLite + React/Vite/Tailwind, TypeScript). Read `README.md` and `API.md` first.

Rules:

1. **Preserve the architecture and security boundaries**: Express API + SQLite metadata + local filesystem storage + React dashboard on one origin. Uploads/management need API keys (Bearer) or admin sessions (cookie + CSRF + Origin check). The only deliberately unauthenticated file access is `GET/HEAD /videos/:id.:ext`.
2. **Never connect this website's tunnel configuration to n8n.** This app is independent of n8n and Cloudflare Tunnel: do not add tunnel management, Cloudflare credentials, or n8n installation/configuration code. The tunnel is configured externally; only the Public base URL setting knows its hostname.
3. **Never add a paid cloud storage dependency** (S3, R2, Cloudinary, Firebase, ...). Local video storage stays the default and only backend.
4. **Never expose secrets or include them in the ZIP**: no `.env`, API keys, admin passwords, setup tokens, session data, databases, uploads, trash or logs. Never log passwords, API keys, tokens or cookies. `scripts/package-zip.mjs` enforces an exclusion list; keep it strict.
5. **Preserve unique video IDs and prevent file collisions**: random UUID per upload, server-generated storage name, original filename only as sanitised metadata, no overwrite, unique DB constraints, temp file -> atomic rename -> transactional insert with cleanup on failure.
6. **Keep binary uploads disk-streamed** (busboy -> temp file with hashing). Never buffer a whole upload in memory.
7. **Keep direct public video URLs working**: raw bytes, correct `Content-Type`/`Content-Length`, HEAD, byte ranges (206/416), ETag/Last-Modified/If-Range, JSON (never HTML) errors, 410 for trashed. Never build file paths from request input; look files up by DB ID. Never build public URLs from the `Host` header.
8. **No arbitrary URL fetching and no filesystem browser APIs.** The only outbound requests are fixed ones: the admin-triggered check of `<publicBaseUrl>/api/v1/health`, (the onboarding form is posted by the **browser** to `https://formsubmit.co/ajax/atikwebpro@gmail.com`; that host is the only external entry in the production CSP `connect-src`; the server just records `kv.onboarding_done`). Never make either endpoint configurable from user input.
8c. **Route collisions**: `/videos`, `/images` and `/files` are both dashboard pages and public media prefixes. Only exact `GET/HEAD` of the bare path falls through to the dashboard; anything deeper must stay a JSON 404 or a media response. Keep `tests/spa.test.ts` passing.
8a. **Libraries**: videos, images and files share the `videos` table (`media_type`) and the `uploads`/`trash` folders. Keep migrations additive, keep `/videos` URLs and the original item fields unchanged, deliver active content (HTML/JS/PHP/XML/SVG) sandboxed or as attachments, and never let metadata extraction modify, move or delete a stored file (a failed analysis only sets `metadata_status`).
8b. **Onboarding** is shown once before the first admin exists (`onboardingDone` in `/api/admin/session`; also true whenever an admin already exists). Do not show it again after submit, skip, setup or login.
9. **Update tests and documentation when API behaviour changes** (`tests/`, `README.md`, `API.md`, `web/src/pages/ApiDocs.tsx`).
10. **Run `npm run lint`, `npm run test` and `npm run build` before finishing.** Re-package with `npm run package:zip` when asked to deliver.
11. **Avoid unnecessary rewrites** of modules that already work; make focused changes.

Layout: `server/` (API, storage, auth, maintenance), `web/` (dashboard; Vite root, so the dev server can never serve `data/` or `storage/`), `scripts/` (dev/start/package), `tests/`. Runtime data goes to `data/` and `storage/` (git-ignored).
