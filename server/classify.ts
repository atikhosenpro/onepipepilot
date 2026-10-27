/** Decides what an upload is (extension, MIME, category) for each library. Video rules keep the original strictness against mislabelled content. */
import { AppError } from './errors';
import { FILE_CATEGORIES, IMAGE_EXTRA_EXTS, IMAGE_MIME, VIDEO_EXTS, VIDEO_MIME, fileCategory, mimeForFileExt, safeExtension, type MediaType } from './mediaTypes';
import type { Settings } from './settings';
import { extensionCompatible, looksLikeOtherFormat, looksLikeText, sniffImage, sniffVideo } from './sniff';

export interface Classified { ext: string; mime: string; category: string | null }
type Fail = (e: AppError, extra?: Record<string, unknown>) => AppError;
interface Parsed { head: Buffer; filename: string; clientMime: string }

const unsupported = (fail: Fail, message: string, extra?: Record<string, unknown>) => fail(new AppError(415, 'unsupported_media_type', message, extra));

export function classifyUpload(kind: MediaType, p: Parsed, settings: Settings, fail: Fail): Classified {
  const declared = safeExtension(p.filename);
  if (kind === 'video') return classifyVideo(p, declared, settings, fail);
  if (kind === 'image') return classifyImage(p, declared, fail);
  const ext = declared || 'bin';
  const cat = fileCategory(ext);
  return { ext, mime: mimeForFileExt(ext), category: FILE_CATEGORIES.includes(cat) ? cat : 'other' };
}

function classifyVideo(p: Parsed, declared: string, settings: Settings, fail: Fail): Classified {
  if (p.clientMime && !/^(video\/|application\/octet-stream$|binary\/octet-stream$|application\/(mp4|x-matroska|mpeg|vnd\.rn-realmedia)$|model\/vnd\.mts$)/i.test(p.clientMime)) {
    throw unsupported(fail, `The part was sent as "${p.clientMime}", which is not a video type.`);
  }
  const sniffed = sniffVideo(p.head);
  let ext: string, mime: string;
  if (sniffed) {
    if (declared && VIDEO_EXTS.includes(declared) && !extensionCompatible(declared, sniffed)) {
      throw unsupported(fail, `The file extension ".${declared}" does not match its actual content (${sniffed.mime}).`);
    }
    // keep the declared name for multi-extension families (mpg/mpeg, ts/mts); otherwise use the detected container
    ext = ['mpg', 'ts', 'mts'].includes(sniffed.ext) && declared && sniffed.group.includes(declared) ? declared : sniffed.ext;
    mime = VIDEO_MIME[ext] ?? sniffed.mime;
  } else {
    // Unknown binary content: store it only when the extension says "video" and it is clearly not text or another known format.
    if (!declared || !VIDEO_EXTS.includes(declared) || looksLikeText(p.head) || looksLikeOtherFormat(p.head)) {
      throw unsupported(fail, 'The file content is not a recognised video format (supported: ' + settings.allowedTypes.join(', ') + ').', { allowed: settings.allowedTypes });
    }
    ext = declared; mime = VIDEO_MIME[declared];
  }
  if (!settings.allowedTypes.includes(ext)) throw unsupported(fail, `${ext.toUpperCase()} uploads are disabled in Settings.`, { allowed: settings.allowedTypes });
  return { ext, mime, category: null };
}

function classifyImage(p: Parsed, declared: string, fail: Fail): Classified {
  if (p.clientMime && !/^(image\/|application\/octet-stream$|binary\/octet-stream$)/i.test(p.clientMime)) {
    throw unsupported(fail, `The part was sent as "${p.clientMime}", which is not an image type.`);
  }
  const s = sniffImage(p.head);
  if (s) {
    if (declared && IMAGE_MIME[declared] && !extensionCompatible(declared, s)) throw unsupported(fail, `The file extension ".${declared}" does not match its actual content (${s.mime}).`);
    const ext = declared && s.group.includes(declared) ? declared : s.ext;
    return { ext, mime: IMAGE_MIME[ext] ?? s.mime, category: null };
  }
  if (declared && IMAGE_EXTRA_EXTS.includes(declared) && !looksLikeText(p.head) && !looksLikeOtherFormat(p.head)) return { ext: declared, mime: IMAGE_MIME[declared], category: null };
  throw unsupported(fail, 'The file content is not a recognised image format (JPG, PNG, WebP, GIF, AVIF, BMP, TIFF, ICO, SVG, HEIC ...).');
}
