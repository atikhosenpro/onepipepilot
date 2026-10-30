import { useApp } from '../App';
import { CopyButton, Notice, PageHeader } from '../ui';

function Code({ children }: { children: string }) {
  return <div className="relative"><pre className="overflow-x-auto rounded-lg bg-ink-900 p-4 text-xs leading-relaxed text-ink-100"><code>{children}</code></pre><div className="absolute right-2 top-2"><CopyButton text={children} /></div></div>;
}
const H = ({ children }: { children: string }) => <h2 className="mb-3 mt-9 font-display text-lg font-semibold text-ink-950">{children}</h2>;
const Ep = ({ m, p, children }: { m: string; p: string; children?: React.ReactNode }) => <div className="card mb-3 p-4"><div className="flex flex-wrap items-center gap-2"><span className="rounded bg-reel-100 px-2 py-0.5 font-mono text-xs font-semibold text-reel-800">{m}</span><code className="text-sm">{p}</code></div><div className="mt-2 text-sm text-ink-600">{children}</div></div>;

export default function ApiDocs() {
  const { settings } = useApp();
  const base = settings?.publicBaseUrl ?? 'https://media.example.com';
  const field = settings?.fieldName ?? 'data';
  return (
    <>
      <PageHeader title="API documentation" subtitle="Also available as API.md in the project folder." />
      <Notice>All requests below use your configured public base URL (<span className="font-mono">{base}</span>). Upload and management calls need an API key; video URLs themselves are public.</Notice>

      <H>Authentication</H>
      <p className="mb-2 text-sm text-ink-600">Send your key in every API call. Create keys on the API keys page.</p>
      <Code>{'Authorization: Bearer YOUR_API_KEY'}</Code>

      <H>Upload a video</H>
      <Ep m="POST" p="/api/v1/videos">Content-Type <span className="font-mono">multipart/form-data</span>. Exactly one file in the field <span className="font-mono">{field}</span>. Optional header <span className="font-mono">Idempotency-Key</span> (8-128 chars) makes safe retries return the original item instead of storing a duplicate.</Ep>
      <Code>{`curl -X POST "${base}/api/v1/videos" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -F "${field}=@/path/to/video.mp4"`}</Code>
      <p className="mb-2 mt-4 text-sm font-medium">Success (201)</p>
      <Code>{`{
  "success": true,
  "publicUrl": "${base}/videos/UNIQUE_VIDEO_ID.mp4",
  "item": {
    "id": "UNIQUE_VIDEO_ID",
    "originalName": "video.mp4",
    "mimeType": "video/mp4",
    "size": 245000000,
    "sha256": "ACTUAL_FILE_CHECKSUM",
    "status": "active",
    "createdAt": "2026-01-01T12:00:00.000Z",
    "publicUrl": "${base}/videos/UNIQUE_VIDEO_ID.mp4",
    "downloadUrl": "${base}/videos/UNIQUE_VIDEO_ID.mp4?download=1"
  }
}`}</Code>

      <H>n8n HTTP Request node</H>
      <ul className="mb-3 list-inside list-disc space-y-1 text-sm text-ink-700">
        <li>Method <b>POST</b>, URL <span className="font-mono">{base}/api/v1/videos</span></li>
        <li>Authentication: <b>Generic Credential Type</b> &rarr; <b>Header Auth</b>, name <span className="font-mono">Authorization</span>, value <span className="font-mono">Bearer YOUR_API_KEY</span> (or add the header under Send Headers)</li>
        <li>Send Body: on, Body Content Type: <b>Form-Data</b></li>
        <li>Parameter Type: <b>n8n Binary File</b>, Name: <span className="font-mono">{field}</span>, Input Data Field Name: <span className="font-mono">data</span> (the binary property of the incoming item; change it if yours is named differently)</li>
        <li>Do <b>not</b> set a Content-Type header manually; n8n adds the multipart boundary.</li>
      </ul>
      <p className="mb-2 text-sm text-ink-700">Use the public URL in later nodes with either expression:</p>
      <Code>{'{{$json.item.publicUrl}}\n{{$json.publicUrl}}'}</Code>

      <H>Other endpoints</H>
      <Ep m="GET" p="/api/v1/videos?page=1&pageSize=25&q=text">Lists active videos (Bearer). Returns items, page, pageSize, total, totalPages.</Ep>
      <Ep m="GET" p="/api/v1/videos/:id">One active video (Bearer).</Ep>
      <Ep m="DELETE" p="/api/v1/videos/:id">Moves a video to the trash (Bearer). Its public URL stops working immediately.</Ep>
      <Ep m="GET" p="/api/v1/health">No authentication. Returns {'{"status":"ok","app":"local-video-host","time":"..."}'}.</Ep>
      <Ep m="GET / HEAD" p="/videos/:id.:ext">Public, no authentication. Serves the raw video with correct Content-Type, Content-Length, ETag, Last-Modified and byte-range support (206). Add <span className="font-mono">?download=1</span> for an attachment.</Ep>

      <H>Image and file libraries</H>
      <p className="mb-3 text-sm text-ink-700">Images and files work exactly like videos: same key, same multipart field (<span className="font-mono">{field}</span>), same response shape. Only the path differs, and every ID works only under its own library.</p>
      <Ep m="POST" p="/api/v1/images">Upload an image (JPG, PNG, WebP, GIF, AVIF, BMP, TIFF, ICO, SVG ...). Public URL: <span className="font-mono">{base}/images/ID.ext</span></Ep>
      <Ep m="POST" p="/api/v1/files">Upload any file (PDF, DOCX, ZIP, MP3, CSV ...). Public URL: <span className="font-mono">{base}/files/ID.ext</span></Ep>
      <Ep m="GET" p="/api/v1/images  |  /api/v1/files  |  /api/v1/videos">List with filters, sorting and pagination (see below).</Ep>
      <Ep m="GET" p="/api/v1/{videos|images|files}/:id">One active item with complete metadata.</Ep>
      <Ep m="DELETE" p="/api/v1/{videos|images|files}/:id">Move to trash.</Ep>
      <Ep m="POST" p="/api/v1/{videos|images}/:id/reprocess">Re-run metadata analysis (for example after installing FFprobe).</Ep>
      <Code>{`curl -X POST "${base}/api/v1/images" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -F "${field}=@/path/to/photo.jpg"`}</Code>

      <H>Filtering, sorting and pagination</H>
      <p className="mb-2 text-sm text-ink-700">All filters are optional, combine with AND and run in the database. Invalid values return a 400 with the parameter name.</p>
      <Code>{`GET ${base}/api/v1/videos?minDuration=60&maxDuration=180&minSizeMB=100&maxSizeMB=300&aspectRatio=9%3A16&status=active`}</Code>
      <div className="card mt-3 overflow-x-auto"><table className="w-full text-sm"><thead className="border-b border-ink-100 bg-ink-50/60"><tr><th className="th">Parameter</th><th className="th">Library</th><th className="th">Meaning</th></tr></thead><tbody className="divide-y divide-ink-100">
        {[['search', 'all', 'Filename or ID contains text (alias q)'], ['status', 'all', 'active (default), trashed, all'], ['extension / type / mimeType', 'all', 'Extensions (mp4,mkv), extension or MIME type, MIME exact or prefix (video/*)'], ['minSizeMB / maxSizeMB', 'all', 'Size range (1 MB = 1,048,576 bytes)'], ['uploadedFrom / uploadedTo', 'all', 'YYYY-MM-DD or ISO date-time'],
          ['minDuration / maxDuration', 'video', 'Seconds'], ['videoClass', 'video', 'short or long (threshold in Settings)'], ['aspectRatio', 'video, image', '16:9, 9:16, 1:1, 4:5 or a number such as 0.5625'], ['orientation', 'video, image', 'landscape, portrait, square'],
          ['minWidth / maxWidth / minHeight / maxHeight', 'video, image', 'Pixels'], ['resolution / resolutionCategory', 'video, image', '1920x1080; 4K, 1440p, 1080p, 720p, 480p ...'], ['imageFormat', 'image', 'JPEG, PNG, WebP, GIF, SVG ...'], ['category', 'file', 'document, archive, code, audio, data, other'], ['metadataStatus', 'video, image', 'ready, pending, unavailable, failed'],
          ['sortBy / order', 'all', 'createdAt, fileName, size, durationSeconds, width, height, extension; asc or desc. Unknown values sort last'], ['page / limit', 'all', 'Page from 1; limit 1-100 (default 25). Response has page, pageSize, limit, total, totalPages, hasMore']].map(([a, b, c]) => <tr key={a}><td className="td font-mono text-xs">{a}</td><td className="td text-xs">{b}</td><td className="td">{c}</td></tr>)}
      </tbody></table></div>

      <H>Item fields</H>
      <p className="mb-2 text-sm text-ink-700">Every item has individual JSON fields (null means unknown; nothing is invented). Example video item:</p>
      <Code>{`{
  "id": "5cb0974f-...", "mediaType": "video", "fileName": "sample-video.mp4", "extension": "mp4", "mimeType": "video/mp4",
  "sizeBytes": 138831000, "sizeMB": 132.4, "sizeFormatted": "132.4 MB", "sha256": "...",
  "durationSeconds": 127, "durationFormatted": "00:02:07", "durationMinutes": 2.1167,
  "width": 1080, "height": 1920, "resolution": "1080x1920", "resolutionCategory": "1080p",
  "aspectRatio": "9:16", "aspectRatioValue": 0.5625, "orientation": "portrait",
  "frameRate": 25, "videoCodec": "h264", "audioCodec": "aac", "videoClass": "long", "isShort": false,
  "status": "active", "metadataStatus": "ready", "metadataSource": "builtin",
  "publicUrl": "${base}/videos/5cb0974f-....mp4", "uploadedAt": "2026-10-25T10:31:05.712Z"
}`}</Code>
      <p className="mb-2 mt-3 text-sm text-ink-700">Images add <span className="font-mono">imageFormat, hasAlpha, colorSpace</span> (plus size and ratio fields); files add <span className="font-mono">category</span>. <span className="font-mono">metadataStatus</span> is <b>ready</b>, <b>pending</b> (not analysed yet), <b>processing</b>, <b>unavailable</b> (no analyser for this format; the file is stored unchanged) or <b>failed</b> (see metadataError; retry with reprocess). Uploads are analysed before the response, so new MP4/WebM/images are normally ready immediately. API.md contains complete examples generated from real uploads.</p>
      <Notice>Without FFprobe, MPEG, WMV, FLV, TS and MTS videos are stored but their duration and size fields stay null (metadataStatus unavailable). Install FFmpeg, then use System &rarr; Media metadata &rarr; Retry unavailable.</Notice>

      <H>Public URLs and safety</H>
      <p className="text-sm text-ink-700">Videos: <span className="font-mono">/videos/ID.ext</span>, images: <span className="font-mono">/images/ID.ext</span>, files: <span className="font-mono">/files/ID.ext</span>. All support GET, HEAD, ranges and <span className="font-mono">?download=1</span>. HTML, JS, PHP, CSS and XML files are always delivered as attachments with a sandbox policy; SVG is sandboxed; PDF, text, CSV, JSON and audio open inline; everything else downloads.</p>

      <H>Google Drive import (n8n sends a link)</H>
      <p className="mb-2 text-sm text-ink-700">Send a small JSON body instead of the video. OnePipePilot downloads the file straight from Google Drive (official API), stores it like any upload and returns the same response. Connect Google Drive first on the <b>Google Drive</b> page.</p>
      <Code>{`curl -X POST "${base}/api/v1/videos" \\
  -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \\
  -d '{ "webViewLink": "https://drive.google.com/file/d/FILE_ID/view" }'`}</Code>
      <ul className="mb-3 mt-3 list-inside list-disc space-y-1 text-sm text-ink-700">
        <li>n8n HTTP Request: POST <span className="font-mono">{base}/api/v1/videos</span>, same API key, Body Content Type <b>JSON</b>, body <span className="font-mono">{'{ "webViewLink": "{{ $json.webViewLink }}" }'}</span>; raise the node timeout for big files.</li>
        <li>Also accepted: <span className="font-mono">driveUrl, fileId, driveFileId</span>, a Drive <span className="font-mono">url</span>, open?id= links, bare file IDs, nested <span className="font-mono">json/item/data</span>, or form fields. Folder links are refused.</li>
        <li>The response is the normal upload response plus <span className="font-mono">source.fileId</span> and <span className="font-mono">duplicate</span>. Read <span className="font-mono">{'{{$json.item.publicUrl}}'}</span>. <span className="font-mono">item.id</span> is OnePipePilot's ID, not the Drive ID.</li>
        <li>The same unchanged Drive file returns the existing item (HTTP 200, <span className="font-mono">duplicate: true</span>) without downloading again.</li>
        <li>Library is auto-detected on /videos and /images (<span className="font-mono">library</span> can force it); /files stores a generic file.</li>
        <li>Cloudflare answers 524 after ~100 s. For big files send <span className="font-mono">"async": true</span>, then poll <span className="font-mono">GET /api/v1/imports/&lt;jobId&gt;</span> until <span className="font-mono">job.state</span> is done and read <span className="font-mono">publicUrl</span>.</li>
        <li>Errors: invalid_drive_url (400), drive_file_not_found (404), drive_access_denied / drive_download_restricted (403), drive_not_connected / drive_reauthorization_required (409), file_too_large (413), drive_quota_exceeded (429), drive_download_failed / drive_download_incomplete (502), insufficient_storage (507).</li>
      </ul>

      <H>Errors</H>
      <Code>{`{ "success": false, "error": { "code": "invalid_api_key", "message": "The API key is not valid." } }`}</Code>
      <div className="card overflow-x-auto"><table className="w-full text-sm"><thead className="border-b border-ink-100 bg-ink-50/60"><tr><th className="th">Status</th><th className="th">Code</th><th className="th">Meaning</th></tr></thead><tbody className="divide-y divide-ink-100">
        {[['400', 'missing_file / unexpected_field / invalid_multipart / empty_file / validation_error', 'The request body is wrong; the message says which field to fix.'],
          ['401', 'missing_api_key / invalid_api_key / revoked_api_key', 'Authentication failed.'],
          ['404', 'not_found', 'Unknown video or endpoint.'],
          ['410', 'gone', 'Public URL of a trashed video.'],
          ['413', 'file_too_large', 'Above the configured maximum upload size.'],
          ['415', 'unsupported_content_type / unsupported_media_type', 'Not multipart, or not an allowed video format.'],
          ['416', '(empty body)', 'Unsatisfiable Range header on a video URL.'],
          ['429', 'rate_limited', 'Too many requests; retry later.'],
          ['507', 'insufficient_storage', 'Server disk is full.'],
          ['500', 'internal_error', 'Unexpected failure; see Activity logs.']].map(([s, c, m]) => <tr key={c}><td className="td font-mono">{s}</td><td className="td font-mono text-xs">{c}</td><td className="td">{m}</td></tr>)}
      </tbody></table></div>
    </>
  );
}
