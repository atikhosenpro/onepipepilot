# OnePipePilot

A self-hosted media storage server for your own computer. A client such as n8n uploads the actual video, image or file (multipart/form-data) with an API key; the app saves it to local disk and returns a **public direct URL** that Buffer, browsers or other services can fetch. It includes an admin dashboard (video, image and file libraries with filters, trash, storage, API keys, settings, activity logs, API docs, diagnostics) and automatic metadata (duration, resolution, aspect ratio, orientation ...).

* Backend: Node.js + Express + SQLite (`better-sqlite3`), TypeScript
* Frontend: React + Vite + Tailwind CSS
* Storage: local folders only. No Docker, no cloud storage, no paid services.
* Independent of n8n and of Cloudflare Tunnel (both are configured separately, see below).

## Requirements

* Windows 11 (also works on macOS/Linux)
* **Node.js 22 or newer (LTS)** from <https://nodejs.org> (npm is included)
* Internet access the first time, to install packages

## Install and start (Windows)

1. Right-click `onepipepilot.zip` and choose **Extract All...**
2. Open the extracted folder, click the address bar, type `cmd` and press Enter (or open a terminal there).
3. Run:

   ```
   npm run dev
   ```

   The first run installs dependencies automatically (using `package-lock.json`) and prints a clear message while doing so. When it is ready it prints the address to open, normally **http://localhost:3000**.

`npm run dev` is for local setup and testing. **Before exposing the app to the internet, use production mode:**

```
npm run build
npm run start
```

(`npm run start` builds automatically if you have not built yet.)

## Welcome survey (first visit only)

The very first time the site is opened (before any admin exists) a short multi-step welcome survey is shown. Submitting it sends the answers to the app developer's inbox through FormSubmit. Your browser posts them directly (AJAX), so the page does not reload or redirect. You can also skip it. It is shown **once**: after it is submitted or skipped, after the admin account exists, and on every later visit or login, it never appears again. Existing installations that already have an admin never see it.

* The answers (never your videos, files or API keys) go to `https://formsubmit.co/ajax/atikwebpro@gmail.com`. FormSubmit requires the receiving inbox to confirm the address once (a one-time activation e-mail) before the first message is delivered.
* Needs internet access *in your browser* (the app's server is not involved in sending). If delivery fails, the survey tells you the exact reason (device offline, formsubmit.co blocked by a firewall/VPN/ad-blocker, or FormSubmit's own message) and you can retry or skip.

## First-time admin setup

1. On the very first start the terminal prints a **setup token** inside a framed box (shown only once). It is also saved in `data/setup-token.txt`.
2. Open the dashboard URL. You will see the "Create the admin account" screen.
3. Paste the token, choose your own username and a password (at least 12 characters with letters and digits) and submit.
4. The token is deleted and first-time setup is permanently disabled. There is no default username or password.

Lost the token before finishing setup? Open `data/setup-token.txt`. If you deleted `data/` completely you simply get a new token on the next start.

## Where data lives

| What | Default location |
| --- | --- |
| Active videos | `storage/uploads/` |
| Trashed videos | `storage/trash/` |
| In-progress uploads | `storage/temp/` |
| Logs | `storage/logs/` |
| SQLite database | `data/app.db` |

The Storage page of the dashboard shows the exact resolved paths, file counts, sizes and write checks. Change the locations with `STORAGE_ROOT` and `DATA_DIR` in a `.env` file (copy `.env.example`). To move storage, stop the app, move the folder, set `STORAGE_ROOT`, start again. Back up both `data/` and `storage/`.

Videos are stored under random server-generated names (`<uuid>.<ext>`); the original filename is kept only as sanitised metadata. Uploads never overwrite each other.

## Public base URL

Settings -> **Public base URL** is used for every link the API returns, for example `https://media.example.com`. It must be a bare origin (no path, query or credentials). Links are never built from the request's `Host` header. Changing it affects future responses immediately; stored videos are untouched. "Verify saved URL" checks that `<base>/api/v1/health` reaches this app.

### Cloudflare Tunnel (external, not managed by this app)

Cloudflare Tunnel is a separate reverse proxy that you configure yourself (outside this project). Point your tunnel's public hostname at the app's local address (`http://127.0.0.1:3000`), then:

1. Enter that hostname as the **Public base URL** in Settings.
2. Add `TRUST_PROXY=1` to `.env` and restart, so rate limits and logs see the real client IP and cookies get the Secure flag.
3. Run in production mode (`npm run build`, `npm run start`).

The app never talks to Cloudflare, stores no Cloudflare credentials and does not touch your n8n instance.

## Libraries: videos, images and files

* **Video library**: MP4, MOV, WebM, MKV, AVI, M4V, MPEG/MPG, WMV, FLV, 3GP, TS, MTS. Shows duration, resolution, aspect ratio, orientation, frame rate, codecs and a short/long label (short = up to 60 s by default, configurable).
* **Image library**: JPG, PNG, WebP, GIF, AVIF, BMP, TIFF, ICO, SVG (plus HEIC/HEIF, JXL, JP2, PSD stored without dimensions). Shows dimensions, ratio, orientation, format, transparency and colour space.
* **File library**: any file (documents, archives, audio, data, code ...), grouped into categories. HTML/JS/PHP/XML files are always delivered as downloads so they cannot run from your domain.
* Each library has its own API endpoints (`/api/v1/videos`, `/images`, `/files`), public URLs (`/videos/...`, `/images/...`, `/files/...`) and a dashboard page with search, filters, sorting and pagination. All three share one trash, API keys and settings. See `API.md` for filters and fields.

### Metadata and FFprobe

A built-in reader analyses MP4/MOV/M4V/3GP, WebM/MKV, AVI and all supported images without any extra software. For **every other video format** (MPEG, WMV, FLV, TS, MTS) install **FFmpeg** (it includes FFprobe) and make sure `ffprobe` is on your PATH (Windows: `winget install Gyan.FFmpeg`, then reopen the terminal), or set `FFPROBE_PATH` in `.env`. Without it those videos are still stored and served; their duration/size fields show "unavailable". After installing FFprobe use **System -> Media metadata -> Retry unavailable**.

Videos uploaded with the previous version are analysed once, automatically, in the background (or press "Analyse pending files" on the System page). Analysis only reads files; it never modifies them.

## Upgrading from the previous version

Replace the program files (keep your `data/` and `storage/` folders and `.env`) and start the app. The database migrates itself on start: every existing video, ID, public URL and API key keeps working, and your videos simply gain metadata fields. Back up `data/` and `storage/` first if you want to be extra safe.

## Google Drive import (send a link, not a video)

Instead of n8n downloading a big video from Google Drive and uploading the whole binary through your tunnel, n8n now sends only a small JSON message containing the Drive link (`webViewLink`). OnePipePilot downloads the file **directly from Google Drive to its own disk** using the official Google Drive API, registers it exactly like a normal upload, and returns the usual public URL.

```
Before:  Google Drive -> n8n (full video) -> tunnel -> OnePipePilot -> public URL
Now:     n8n sends {"webViewLink": "..."}  ->  OnePipePilot <== (streams the file) == Google Drive  ->  public URL
```

Normal binary uploads are unchanged and keep working side by side.

### 1. Create the Google credentials (one time, free)

1. Open <https://console.cloud.google.com/>, create (or choose) a project.
2. **APIs & Services -> Library -> Google Drive API -> Enable.**
3. **APIs & Services -> OAuth consent screen**: user type *External*, fill in the app name and your e-mail, add the scope `https://www.googleapis.com/auth/drive.readonly` (read-only), and add your Google account under **Test users**.
4. **APIs & Services -> Credentials -> Create credentials -> OAuth client ID -> Web application.**
5. Under **Authorised redirect URIs** add the address shown on the dashboard's **Google Drive** page. It is your Public base URL plus `/api/admin/drive/callback`, for example `http://localhost:3100/api/admin/drive/callback` or `https://media.example.com/api/admin/drive/callback`. It must match exactly. (Google only allows `http://` redirect URIs for `localhost`; any other host needs `https://`.)
6. Copy the **Client ID** and **Client secret**.

> While the consent screen is in *Testing* mode, Google expires the authorisation after 7 days. Either click **Publish app** (no review is needed for personal use of a read-only scope; Google just shows an "unverified app" screen) or reconnect weekly.

### 2. Connect it in the dashboard

Open **Google Drive** in the sidebar, paste the Client ID and Client secret, click **Save credentials**, then **Connect Google account** and approve access. When you return, the status shows **Connected** with the account e-mail. **Test connection** checks it at any time; **Disconnect** revokes the tokens and erases them.

* The app asks for **read-only** access. It can never change, move or delete anything in your Drive, and it never modifies the original file after importing.
* Connecting an account does **not** give access to every file on Drive. OnePipePilot can only read what that Google account can open. For files owned by someone else, they must be shared with the connected account (or be visible to it).

### 3. Browse and import by hand

The Google Drive page has a file browser: **My Drive** and **Shared with me**, folders (open, go up, breadcrumb path), search by name, paging ("Load more", it never loads a whole Drive), sizes, dates and icons for videos and images. For any file you can **Inspect** its details (including whether it is already imported), **Copy link / ID**, or **Import**. Imports show live progress, and the result links to the right library. Videos go to the Video library, images to the Image library, everything else to the File library (the type is checked from Google's metadata and again from the downloaded content). Google Docs, Sheets and Slides are exported (PDF/XLSX), up to Google's 10 MB export limit.

### 4. n8n: send the existing `webViewLink`

Use the same endpoint and API key as before, but send JSON instead of the binary:

* HTTP Request node, **POST** `https://YOUR-HOST/api/v1/videos` (works for images too)
* Authentication: Header `Authorization: Bearer YOUR_API_KEY` (unchanged)
* Send Body: on, Body Content Type **JSON**, body: `{ "webViewLink": "{{ $json.webViewLink }}" }`
* Options -> **Timeout**: raise it (for example 600000 ms) for large files.

OnePipePilot accepts the item's `webViewLink` (also `driveUrl`, `fileId`/`driveFileId`, or a Drive `url`), so you can even send the whole item. The response has the same shape as an upload; use `{{$json.item.publicUrl}}` (or `{{$json.publicUrl}}`) in the next node:

```json
{ "success": true, "publicUrl": "https://media.example.com/videos/<id>.mp4", "item": { "id": "<id>", "mediaType": "video", "durationSeconds": 127, "...": "..." },
  "source": { "type": "gdrive", "fileId": "<Drive file ID>" }, "duplicate": false }
```

* The Drive file ID identifies the **source**; `item.id` is OnePipePilot's own ID. They are different.
* **Repeated requests are safe.** Importing the same unchanged Drive file again returns the existing item (`"duplicate": true`, HTTP 200) without downloading again. If the file changed in Drive, a new copy is created.
* **Cloudflare's 100-second limit:** a request through Cloudflare must answer within about 100 seconds. Most files finish well within that. For very large files add `"async": true`: OnePipePilot answers immediately with `202` and a `statusUrl`; poll it (`GET /api/v1/imports/<jobId>`, same API key) until `job.state` is `done`, then read `publicUrl`.
* Optional `"library": "auto" | "video" | "image" | "file"`. `/videos` and `/images` auto-detect by default; `/files` always stores a generic file.

### 5. Security and storage of the credentials

* The Client secret, the refresh token and the access token are **encrypted at rest** (AES-256-GCM) in the database and are never sent to the browser, never logged and never returned by any API. The encryption key is stored **outside** the database: `data/drive-encryption.key` (created automatically, excluded from the ZIP), or your own `DRIVE_ENCRYPTION_KEY` in `.env`. Keep a copy: without the key the saved tokens cannot be read (you would just reconnect).
* The Google sign-in uses OAuth with PKCE and a one-time, 10-minute `state` value that is checked on return.
* Only a validated Google file ID is ever used: OnePipePilot never fetches the pasted link, and only talks to Google's own API hosts.
* Everything needs your existing admin login (dashboard) or API key (n8n). Imports are limited to the configured maximum upload size and to 2 downloads at a time.

### 6. Troubleshooting

| You see | Meaning and fix |
| --- | --- |
| `drive_not_connected` | Connect Google Drive on the dashboard first |
| `drive_reauthorization_required` | Google revoked or expired the access (common after 7 days in Testing mode). Click **Reconnect** |
| `drive_file_not_found` | The file does not exist, is in the Drive trash, or the connected account has no access. Share it with that account |
| `drive_access_denied` / `drive_download_restricted` | The account may not read it, or the owner disabled downloading |
| `drive_quota_exceeded` | Google's rate or daily quota was hit. Wait and retry |
| `file_too_large` | Above the maximum upload size (Settings) |
| `insufficient_storage` | Not enough free disk space |
| `drive_download_failed` / `drive_download_incomplete` | The transfer was interrupted. Nothing was stored; retry |
| `unsupported_media_type` | The downloaded content is not a valid file of that library (for example a text file named `.mp4`) |
| `invalid_drive_url` | Use a link like `https://drive.google.com/file/d/FILE_ID/view`, an `open?id=` link, or the bare file ID |
| `redirect_uri_mismatch` (at Google) | The redirect URI in Google Cloud does not exactly match the one on the Google Drive page |

Every import step is recorded in **Activity logs** (`drive_*` events) without any secrets, and **System** shows the Drive connection status.

## Using the dashboard

* **Video library**: search by filename or ID, sort, paginate, preview, copy the public/download URL, view metadata (including SHA-256), move to trash (single or bulk).
* **Trash**: restore (same ID and URL), delete permanently, or empty the trash (you must type `EMPTY TRASH`). Auto-delete after N days is configured in Settings.
* **API keys**: generate a key with a label, copy it (shown once, only a hash is stored), revoke it at any time.
* **Settings**: public base URL, max upload size (default 1 GB, up to 50 GB), allowed types (MP4, M4V, MOV, WebM), the multipart field name (default `data`), retention, disk warning threshold, log level, time zone.
* **Activity logs**, **System** (diagnostics, cleanup now), **Account** (change password, sign out other sessions), **API docs**.

## Uploading from n8n

See `API.md` for the full reference. In short: HTTP Request node, POST `https://YOUR-HOST/api/v1/videos`, header `Authorization: Bearer YOUR_API_KEY`, body Form-Data, parameter type **n8n Binary File**, name `data`, Input Data Field Name `data`. Use `{{$json.item.publicUrl}}` (or `{{$json.publicUrl}}`) afterwards.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Installs dependencies if missing, then runs API + dashboard on one port with hot reload |
| `npm run build` | Builds the dashboard (`dist/web`) and compiles the server (`dist/server`) |
| `npm run start` | Production mode (builds first if needed) |
| `npm run test` | Runs the automated tests (Vitest + Supertest) |
| `npm run lint` | ESLint plus TypeScript checks for server and dashboard |
| `npm run package:zip` | Creates `release/onepipepilot.zip` (excludes secrets, database, uploads, `node_modules`) |

## Configuration (.env, all optional)

`HOST` (default `127.0.0.1`), `PORT` (`3000`), `STORAGE_ROOT`, `DATA_DIR`, `DRIVE_ENCRYPTION_KEY` (optional, see Google Drive), `PUBLIC_BASE_URL` (initial value only), `TRUST_PROXY` (`false`, a hop count like `1`, or `loopback`), `COOKIE_SECURE` (`auto`, `true`, `false`). Everything else is changed in the dashboard Settings.

## Security checklist before exposing to the internet

* Run `npm run build && npm run start`, not `npm run dev`.
* Keep `HOST=127.0.0.1` and expose it only through your tunnel/reverse proxy.
* Use HTTPS only for the public URL; set `TRUST_PROXY=1` behind a local proxy.
* Use a long unique admin password; revoke API keys you no longer use; one key per client.
* Remember **public video URLs need no login by design**. The IDs are random UUIDs but anyone with a link can watch the video until it is trashed.
* Keep the upload size limit sensible and watch free disk space (System page).
* Never commit or share `.env`, `data/` or `storage/`.

What the app implements: Bearer API keys (hashed), scrypt password hashing, server-side sessions in HttpOnly SameSite=Strict cookies with rotation on login, CSRF tokens + Origin checks on admin mutations, login/upload rate limiting, strict content-based file validation, path-traversal-safe lookups by database ID, atomic temp-file-to-final moves, Helmet security headers (strict CSP in production), audit logs without secrets.

## Limitations

* A single admin account; no multi-user roles.
* Videos, images and files are stored exactly as uploaded; nothing is transcoded, resized or re-encoded. Video/image formats are identified from their headers.
* Moving storage to a new folder is a manual, offline step (documented above) by design.
* Free-disk numbers need an OS that reports them (Windows, macOS and Linux with Node 18.15+ do).

## Troubleshooting

* **"Port 3000 is already in use"**: stop the other program or set `PORT=3100` in `.env`.
* **Dependency install failed**: check your internet connection, make sure Node.js 22+ is installed (`node -v`), then run `npm install` and retry. `better-sqlite3` ships prebuilt Windows binaries (the bundled `.npmrc` disables compile-on-install), so no C++ build tools are needed; if it still fails, install the current Node.js LTS.
* **Upload returns 401**: the `Authorization: Bearer ...` header is missing or the key was revoked.
* **Upload returns 400 `unexpected_field`**: the n8n parameter name must equal the field name in Settings (default `data`).
* **Upload returns 415**: the file is not a real video/image of an allowed type (or the extension does not match its content), or the video type is disabled in Settings.
* **Upload returns 413**: the file exceeds the maximum upload size in Settings.
* **Links point to localhost**: set the Public base URL in Settings.
* **Can't sign in after the first setup**: there is no password reset by email. Stop the app and delete `data/app.db*` only if you accept losing the video index (files in `storage/` remain but are no longer tracked), then run setup again.
