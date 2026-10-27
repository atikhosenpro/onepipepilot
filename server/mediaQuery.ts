/** Query-string schema shared by the automation API and the dashboard. Accepts the documented names plus the legacy ones (q, sort, pageSize). */
import { z } from 'zod';
import { SORT_KEYS, type ListOpts } from './videos';
import { FILE_CATEGORIES, RESOLUTION_CATEGORIES, type MediaType } from './mediaTypes';

const blank = (v: unknown) => (v === '' || v === undefined || v === null ? undefined : v);
const num = (max = 1e12) => z.preprocess(blank, z.coerce.number({ error: 'must be a number' }).min(0, 'must be 0 or greater').max(max).optional());
const int = (min: number, max: number, def?: number) => z.preprocess(blank, z.coerce.number({ error: 'must be a whole number' }).int('must be a whole number').min(min).max(max).default(def as number).optional());
const str = (max = 200) => z.preprocess(blank, z.string().max(max).optional());
const exact = <T extends [string, ...string[]]>(vals: T) => z.preprocess(blank, z.enum(vals).optional());
const oneOf = <T extends [string, ...string[]]>(vals: T) => z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase() : blank(v)), z.enum(vals).optional());

export const mediaQuerySchema = z.object({
  mediaType: oneOf(['video', 'image', 'file', 'all']),
  status: oneOf(['active', 'trashed', 'all']),
  search: str(), q: str(),
  type: str(60), extension: str(60), mimeType: str(100), category: oneOf(FILE_CATEGORIES as [string, ...string[]]), imageFormat: str(20),
  minSizeMB: num(), maxSizeMB: num(), minDuration: num(), maxDuration: num(),
  minWidth: num(100_000), maxWidth: num(100_000), minHeight: num(100_000), maxHeight: num(100_000),
  aspectRatio: str(30), orientation: oneOf(['landscape', 'portrait', 'square']),
  resolution: str(20), resolutionCategory: z.preprocess(blank, z.enum(RESOLUTION_CATEGORIES as [string, ...string[]]).optional()),
  videoClass: oneOf(['short', 'long']), metadataStatus: oneOf(['pending', 'processing', 'ready', 'unavailable', 'failed']),
  uploadedFrom: str(40), uploadedTo: str(40),
  sortBy: exact(SORT_KEYS as [string, ...string[]]), sort: exact(SORT_KEYS as [string, ...string[]]),
  order: oneOf(['asc', 'desc']),
  page: int(1, 1_000_000, 1), limit: int(1, 100), pageSize: int(1, 100),
}).passthrough();

export type MediaQuery = z.infer<typeof mediaQuerySchema>;

export function toListOpts(q: MediaQuery, forced: { mediaType?: MediaType | 'all'; defaultStatus?: 'active' | 'trashed' | 'all' } = {}): ListOpts {
  const { search, q: legacyQ, sortBy, sort, limit, pageSize, status, mediaType, ...rest } = q;
  return {
    ...(rest as ListOpts),
    mediaType: (forced.mediaType ?? mediaType ?? 'video') as ListOpts['mediaType'],
    status: (status ?? forced.defaultStatus ?? 'active') as ListOpts['status'],
    q: search ?? legacyQ, sort: sortBy ?? sort, pageSize: limit ?? pageSize ?? 25,
  } as ListOpts;
}
