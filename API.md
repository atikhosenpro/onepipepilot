# Local Video Host API (v1)

Base URL: your configured public base URL, e.g. `https://media.example.com` (locally `http://localhost:3000`).

## Authentication

Upload and management endpoints need an API key (create one in the dashboard, **API keys** page):

```
Authorization: Bearer YOUR_API_KEY
```

Public video URLs and `/api/v1/health` need no authentication. The dashboard API (`/api/admin/*`) uses cookie sessions + CSRF and is not meant for external clients.

## POST /api/v1/videos : upload a video

* Content-Type: `multipart/form-data` (let your HTTP client generate the boundary)
* Exactly one file part, in the field named by Settings -> "Expected multipart file-field name" (default **`data`**)
* Optional header `Idempotency-Key: <8-128 chars: letters digits _ - . :>`. Scoped to your API key: a repeated request with the same key returns the originally stored item (`200`, `"idempotentReplay": true`) and does not store a second copy. Use a unique key per logical upload.
* Files are streamed to disk (never fully loaded in memory), hashed (SHA-256) and validated by their real content. Allowed video formats by default: MP4, MOV, WebM, MKV, AVI, M4V, MPEG, MPG, WMV, FLV, 3GP, TS, MTS (configurable in Settings). Default size limit: 1 GB (configurable up to 50 GB).

```bash
curl -X POST "https://media.example.com/api/v1/videos" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "data=@/path/to/video.mp4"
```

### Success: 201 Created

```json
{
  "success": true,
  "publicUrl": "https://media.example.com/videos/UNIQUE_VIDEO_ID.mp4",
  "item": {
    "id": "UNIQUE_VIDEO_ID",
    "originalName": "video.mp4",
    "mimeType": "video/mp4",
    "size": 245000000,
    "sha256": "ACTUAL_FILE_CHECKSUM",
    "status": "active",
    "createdAt": "2026-01-01T12:00:00.000Z",
    "publicUrl": "https://media.example.com/videos/UNIQUE_VIDEO_ID.mp4",
    "downloadUrl": "https://media.example.com/videos/UNIQUE_VIDEO_ID.mp4?download=1"
  }
}
```

(The item also contains `extension`, `updatedAt`, `trashedAt` and all the metadata fields described under *Media libraries* below.) Every upload gets a fresh random UUID, even when filename and content are identical to an earlier upload.

## n8n HTTP Request node

| Setting | Value |
| --- | --- |
| Method | `POST` |
| URL | `https://media.example.com/api/v1/videos` |
| Authentication | Generic Credential Type -> Header Auth: name `Authorization`, value `Bearer YOUR_API_KEY` (or add the header under *Send Headers*) |
| Send Body | on |
| Body Content Type | **Form-Data** |
| Parameter Type | **n8n Binary File** |
| Name | `data` (must equal the field name in Settings) |
| Input Data Field Name | `data` (the binary property on the incoming item) |

If the incoming item stores the video under another binary property (for example `video`), set **Input Data Field Name** to that name; keep **Name** = `data`. Do not set a `Content-Type` header yourself: n8n adds the multipart boundary.

Use the result in the next node:

```
{{$json.item.publicUrl}}
{{$json.publicUrl}}
```

The response is plain JSON, no HTML parsing needed. Optionally add `Idempotency-Key` as an extra header (e.g. an expression built from the source file id) so retries cannot create duplicates.

## GET /api/v1/videos : list active videos (Bearer)

Query: `page` (default 1), `limit`/`pageSize` (1-100, default 25), `search`/`q` (filename or ID substring), `sortBy`/`sort`, `order` (`asc`/`desc`), plus the filters listed under *Media libraries* below. Response: `{ "success": true, "items": [...], "page": 1, "pageSize": 25, "limit": 25, "total": 3, "totalPages": 1, "hasMore": false }`

## GET /api/v1/videos/:id (Bearer)

`{ "success": true, "item": { ... } }`, or `404` if unknown/trashed.

## DELETE /api/v1/videos/:id (Bearer)

Moves the video to the trash (restorable in the dashboard). Its public URL immediately stops working. Response: `{ "success": true, "id": "...", "status": "trashed" }`. Permanent deletion is only available in the dashboard.

## GET /api/v1/health

No authentication. `{ "status": "ok", "app": "local-video-host", "time": "2026-01-01T12:00:00.000Z" }` (`503` with `"status":"error"` if the database is unavailable).

## Public video URL

```
GET  https://media.example.com/videos/<id>.<ext>
HEAD https://media.example.com/videos/<id>.<ext>
GET  https://media.example.com/videos/<id>.<ext>?download=1
```

* No authentication, no cookies, no redirects, no HTML wrapper: the response body is the video file.
* Headers: `Content-Type` (e.g. `video/mp4`), `Content-Length`, `Accept-Ranges: bytes`, `ETag` (the SHA-256), `Last-Modified`, `Cache-Control`, `Content-Disposition` (`inline`, or `attachment` with `download=1`).
* Range requests: `Range: bytes=0-1023` -> `206 Partial Content` with `Content-Range`; suffix (`bytes=-500`) and open-ended (`bytes=100-`) ranges work; unsatisfiable ranges -> `416` with `Content-Range: bytes */<size>`; `If-Range`, `If-None-Match` (-> `304`) and `If-Modified-Since` are honoured. Multi-range requests are answered with the full file.
* Trashed videos return `410 Gone`; unknown IDs, wrong extensions and anything that is not a UUID return `404`. Always JSON errors, never an HTML page. No directory listing exists.
* These URLs are **public by design**: anyone who knows the (random, unguessable) link can fetch the file until the video is trashed.

## Errors

Every API error uses this shape and never includes file paths, stack traces or secrets:

```json
{ "success": false, "error": { "code": "invalid_api_key", "message": "The API key is not valid.", "details": {} } }
```

(`details` is optional.)

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `missing_file` | No file part was sent (message names the expected field) |
| 400 | `unexpected_field` | File arrived in a different field than the configured one |
| 400 | `multiple_files` / `invalid_multipart` / `empty_file` / `upload_aborted` | Malformed or empty upload |
| 400 | `validation_error` / `invalid_idempotency_key` | Bad parameter |
| 401 | `missing_api_key` / `invalid_api_key` / `revoked_api_key` | Authentication failed |
| 404 | `not_found` | Unknown video or endpoint |
| 409 | `idempotency_key_conflict` | The video stored under that key is in the trash |
| 410 | `gone` | Public URL of a trashed video |
| 413 | `file_too_large` | Above the maximum upload size |
| 415 | `unsupported_content_type` | Request was not `multipart/form-data` |
| 415 | `unsupported_media_type` | Not an allowed format for that library, or the extension does not match the content |
| 416 | none | Unsatisfiable `Range` on a video URL |
| 429 | `rate_limited` | Too many requests |
| 500 | `internal_error` | Unexpected failure (details only in Activity logs) |
| 507 | `insufficient_storage` | The server disk is full |


---

# Media libraries: videos, images and files

The application has three libraries that share authentication, API keys, the size limit, the multipart field name, the trash and the public base URL. Existing video endpoints and URLs are unchanged; images and files use the same pattern.

| Library | Upload / list | One item | Move to trash | Re-analyse | Public URL |
| --- | --- | --- | --- | --- | --- |
| Videos | `POST` / `GET /api/v1/videos` | `GET /api/v1/videos/:id` | `DELETE /api/v1/videos/:id` | `POST /api/v1/videos/:id/reprocess` | `/videos/<id>.<ext>` |
| Images | `POST` / `GET /api/v1/images` | `GET /api/v1/images/:id` | `DELETE /api/v1/images/:id` | `POST /api/v1/images/:id/reprocess` | `/images/<id>.<ext>` |
| Files | `POST` / `GET /api/v1/files` | `GET /api/v1/files/:id` | `DELETE /api/v1/files/:id` | (not applicable) | `/files/<id>.<ext>` |

All of them need `Authorization: Bearer YOUR_API_KEY` except the public URLs. Uploading works exactly like the video upload above (multipart/form-data, field `data` by default, optional `Idempotency-Key`); only the path changes. An ID only works under its own library (an image ID returns 404 under `/videos/` and `/files/`).

## Filters (list endpoints)

Every filter is optional. Filters combine with AND and are evaluated in SQL. Blank values are ignored; invalid values return `400 validation_error` with a message naming the parameter. A repeated parameter (`?search=a&search=b`) is rejected.

| Parameter | Libraries | Meaning |
| --- | --- | --- |
| `search` (alias `q`) | all | Filename or ID contains this text |
| `status` | all | `active` (default), `trashed` or `all`. Trashed items have `publicUrl: null` |
| `extension` | all | One or more extensions, comma separated: `mp4,mkv` |
| `type` | all | An extension (`mp4`) or a MIME type (`video/mp4`) |
| `mimeType` | all | Exact MIME type, or a prefix with `*` (`video/*`) |
| `minSizeMB`, `maxSizeMB` | all | File size range. 1 MB = 1,048,576 bytes |
| `uploadedFrom`, `uploadedTo` | all | `YYYY-MM-DD` (interpreted in the time zone set in Settings, inclusive) or a full ISO date-time |
| `metadataStatus` | video, image | `ready`, `pending`, `unavailable`, `failed` |
| `minDuration`, `maxDuration` | video | Duration in seconds. Videos with unknown duration never match |
| `videoClass` | video | `short` or `long` (threshold: Settings, default 60 s) |
| `aspectRatio` | video, image | `16:9`, `9:16`, `1:1`, `4:5` ... or a number such as `0.5625` (width / height, 1% tolerance) |
| `orientation` | video, image | `landscape`, `portrait`, `square` |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | video, image | Pixel ranges |
| `resolution` | video, image | Exact size `1920x1080` |
| `resolutionCategory` | video, image | `4K`, `1440p`, `1080p`, `720p`, `480p`, `360p`, `240p`, `below-240p` (based on the shorter side) |
| `imageFormat` | image | `JPEG`, `PNG`, `WebP`, `GIF`, `SVG` ... |
| `category` | file | `document`, `archive`, `code`, `audio`, `data`, `other` |
| `sortBy` (alias `sort`) | all | `createdAt` (alias `uploadedAt`, default), `originalName` (`fileName`), `size` (`sizeBytes`), `durationSeconds` (`duration`), `width`, `height`, `extension`, `status`, `trashedAt`, `id`. Items without a value sort last in both directions |
| `order` | all | `asc` or `desc` (default) |
| `page`, `limit` (alias `pageSize`) | all | Page (from 1) and page size (1-100, default 25) |

Example: videos between one and three minutes, 100-300 MB, vertical, active:

```
GET /api/v1/videos?minDuration=60&maxDuration=180&minSizeMB=100&maxSizeMB=300&aspectRatio=9%3A16&status=active
```

Pagination metadata: `page`, `pageSize` (also returned as `limit`), `total`, `totalPages`, `hasMore`.

## Item fields

Every item exposes its metadata as individual fields. `null` always means "not known"; values are never invented. Values below come from real uploads made against this API.

Common to all libraries: `id`, `mediaType` (`video`/`image`/`file`), `fileName` (same as `originalName`), `extension`, `mimeType`, `size` and `sizeBytes` (integer), `sizeKB`, `sizeMB`, `sizeGB` (numbers), `sizeFormatted` (`"132.4 MB"`), `sha256`, `status` (`active`/`trashed`), `createdAt` and `uploadedAt` (identical), `updatedAt`, `trashedAt`, `publicUrl`, `downloadUrl`, `metadataStatus`, `metadataSource`, `metadataError`.

Video: `durationSeconds` (number), `durationFormatted` (`"00:02:07"`), `durationMinutes` (number), `width`, `height`, `resolution` (`"1080x1920"`), `resolutionCategory`, `aspectRatio` (`"9:16"`), `aspectRatioValue` (width / height), `orientation`, `frameRate`, `videoCodec`, `audioCodec`, `videoClass` (`short`/`long`), `isShort` (boolean). Rotated phone videos report their displayed size.

Image: `width`, `height`, `resolution`, `aspectRatio`, `aspectRatioValue`, `orientation`, `imageFormat`, `hasAlpha` (boolean, `null` when not detectable), `colorSpace` (`rgb`, `srgb`, `grayscale`, `cmyk`, `indexed`, `ycbcr`; best effort).

File: `category`.

### `metadataStatus`

| Value | Meaning |
| --- | --- |
| `ready` | Analysis finished. Individual fields can still be `null` when the file does not contain that information (for example no audio track) |
| `pending` | Not analysed yet (for example videos uploaded before this feature; they are analysed automatically in the background, or from the System page) |
| `processing` | Being analysed right now |
| `unavailable` | No analyser can read this format. The file is stored unchanged. Install FFprobe and re-analyse to fill the fields |
| `failed` | The analyser reported an error (corrupt file, timeout). The file is stored unchanged; `metadataError` explains and `POST .../reprocess` retries |

Uploads are analysed before the upload response is sent, so a new MP4/WebM/image normally returns `ready` immediately. Analysis never blocks, modifies or deletes the stored file.

### Real examples

Video upload response (`POST /api/v1/videos`, 201):

```json
{
  "success": true,
  "publicUrl": "https://media.example.com/videos/5cb0974f-ae2a-4d78-85de-343d73bb017b.mp4",
  "item": {
    "id": "5cb0974f-ae2a-4d78-85de-343d73bb017b",
    "originalName": "sample-video.mp4",
    "mimeType": "video/mp4",
    "extension": "mp4",
    "size": 1500000,
    "sha256": "605778a1389a87fc635635432d97e549492e9345a9fef9d84ffda0e368192a86",
    "status": "active",
    "createdAt": "2026-10-25T10:31:05.712Z",
    "updatedAt": "2026-10-25T10:31:05.712Z",
    "trashedAt": null,
    "publicUrl": "https://media.example.com/videos/5cb0974f-ae2a-4d78-85de-343d73bb017b.mp4",
    "downloadUrl": "https://media.example.com/videos/5cb0974f-ae2a-4d78-85de-343d73bb017b.mp4?download=1",
    "mediaType": "video",
    "fileName": "sample-video.mp4",
    "sizeBytes": 1500000,
    "sizeKB": 1464.84,
    "sizeMB": 1.43,
    "sizeGB": 0.0014,
    "sizeFormatted": "1.4 MB",
    "uploadedAt": "2026-10-25T10:31:05.712Z",
    "metadataStatus": "ready",
    "metadataSource": "builtin",
    "metadataError": null,
    "durationSeconds": 127,
    "durationFormatted": "00:02:07",
    "durationMinutes": 2.1167,
    "width": 1080,
    "height": 1920,
    "resolution": "1080x1920",
    "aspectRatio": "9:16",
    "aspectRatioValue": 0.5625,
    "orientation": "portrait",
    "resolutionCategory": "1080p",
    "frameRate": 25,
    "videoCodec": "h264",
    "audioCodec": "aac",
    "videoClass": "long",
    "isShort": false
  }
}
```

Image item (`item` of `POST /api/v1/images`):

```json
{
  "id": "f40c3c50-1ad3-479c-b5bf-192c282a691d",
  "originalName": "banner.png",
  "mimeType": "image/png",
  "extension": "png",
  "size": 3011,
  "sha256": "eddca4e0de70f0422f00368d3882e1e45e1841d7afbae5d3f395877cb1262dd8",
  "status": "active",
  "createdAt": "2026-10-25T10:31:05.757Z",
  "updatedAt": "2026-10-25T10:31:05.757Z",
  "trashedAt": null,
  "publicUrl": "https://media.example.com/images/f40c3c50-1ad3-479c-b5bf-192c282a691d.png",
  "downloadUrl": "https://media.example.com/images/f40c3c50-1ad3-479c-b5bf-192c282a691d.png?download=1",
  "mediaType": "image",
  "fileName": "banner.png",
  "sizeBytes": 3011,
  "sizeKB": 2.94,
  "sizeMB": 0,
  "sizeGB": 0,
  "sizeFormatted": "2.9 KB",
  "uploadedAt": "2026-10-25T10:31:05.757Z",
  "metadataStatus": "ready",
  "metadataSource": "builtin",
  "metadataError": null,
  "width": 1200,
  "height": 630,
  "resolution": "1200x630",
  "aspectRatio": "1.90:1",
  "aspectRatioValue": 1.9048,
  "orientation": "landscape",
  "imageFormat": "PNG",
  "hasAlpha": true,
  "colorSpace": "rgb"
}
```

File item (`item` of `POST /api/v1/files`):

```json
{
  "id": "cc5a70e9-ae03-4ed2-bb20-d779b6e45891",
  "originalName": "report.pdf",
  "mimeType": "application/pdf",
  "extension": "pdf",
  "size": 2009,
  "sha256": "14178699c597e2da6530aa7ad35b5566237c97f331a7fcd635c6209f5e8e3dde",
  "status": "active",
  "createdAt": "2026-10-25T10:31:05.766Z",
  "updatedAt": "2026-10-25T10:31:05.766Z",
  "trashedAt": null,
  "publicUrl": "https://media.example.com/files/cc5a70e9-ae03-4ed2-bb20-d779b6e45891.pdf",
  "downloadUrl": "https://media.example.com/files/cc5a70e9-ae03-4ed2-bb20-d779b6e45891.pdf?download=1",
  "mediaType": "file",
  "fileName": "report.pdf",
  "sizeBytes": 2009,
  "sizeKB": 1.96,
  "sizeMB": 0,
  "sizeGB": 0,
  "sizeFormatted": "2.0 KB",
  "uploadedAt": "2026-10-25T10:31:05.766Z",
  "metadataStatus": "ready",
  "metadataSource": null,
  "metadataError": null,
  "category": "document"
}
```

## Public URLs for images and files

`GET`/`HEAD https://media.example.com/images/<id>.<ext>` and `/files/<id>.<ext>` need no authentication and return the stored bytes, with the same range, ETag and caching behaviour as videos. `?download=1` forces a download. Trashed items return `410`, unknown IDs `404`.

Delivery safety rules (all libraries send `X-Content-Type-Options: nosniff`):

* HTML, JS, PHP, CSS, XML and other code files are always sent as `application/octet-stream` with `Content-Disposition: attachment` and a sandbox Content-Security-Policy, so they can never run in a browser from your domain.
* SVG images are sent as `image/svg+xml` with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, so embedded scripts do not execute.
* PDF, TXT, CSV, JSON and audio files open inline; every other file type downloads.
* The stored MIME type of files comes from the file extension, never from what the client claims.

## What is accepted

* **Videos**: MP4, MOV, WebM, MKV, AVI, M4V, MPEG, MPG, WMV, FLV, 3GP, TS, MTS (selectable in Settings). The content is checked against the container format. A file with a recognised video extension and unrecognised binary content is still stored (metadata `unavailable`); text files, images and other known formats posing as video are refused with 415.
* **Images**: JPG/JPEG, PNG, WebP, GIF, AVIF, BMP, TIFF, ICO, SVG, plus HEIC/HEIF, JXL, JP2, PSD, TGA, DNG (stored; dimensions unavailable). The content must match the extension.
* **Files**: anything non-empty. Unknown types are stored as `application/octet-stream`, category `other`.

## Metadata tools

* **FFprobe** (part of FFmpeg) is used when installed and found on `PATH` (or at `FFPROBE_PATH` in `.env`). It covers every video format.
* Without it, a built-in reader analyses MP4/MOV/M4V/3GP, WebM/MKV and AVI videos, and all supported image formats. MPEG, WMV, FLV, TS and MTS are stored with `metadataStatus: "unavailable"` until FFprobe is installed; then use System -> Media metadata -> "Retry unavailable", or `POST .../reprocess`.
