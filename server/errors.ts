import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError, type ZodType } from 'zod';

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export function parseWith<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw validationError(r.error);
}

export function validationError(err: ZodError): AppError {
  const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  return new AppError(400, 'validation_error', issues[0] ? `${issues[0].path ? issues[0].path + ': ' : ''}${issues[0].message}` : 'Invalid request.', issues);
}

export const asyncHandler = (fn: (...a: Parameters<RequestHandler>) => Promise<unknown>): RequestHandler => (req, res, next) => {
  fn(req, res, next).catch(next);
};

export function errorBody(code: string, message: string, details?: unknown) {
  return { success: false, error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

export function createErrorHandler(log: (msg: string, meta?: Record<string, unknown>) => void): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (res.headersSent) { res.destroy(); return; }
    if (err instanceof AppError) {
      if (err.status === 413 || err.status === 507) res.set('Connection', 'close');
      res.status(err.status).json(errorBody(err.code, err.message, err.details));
      return;
    }
    if (err instanceof ZodError) {
      const e = validationError(err);
      res.status(400).json(errorBody(e.code, e.message, e.details));
      return;
    }
    const anyErr = err as { type?: string; status?: number };
    if (anyErr?.type === 'entity.parse.failed') { res.status(400).json(errorBody('invalid_json', 'Request body is not valid JSON.')); return; }
    if (anyErr?.type === 'entity.too.large') { res.status(413).json(errorBody('payload_too_large', 'Request body is too large.')); return; }
    log('Unhandled error', { path: req.path, method: req.method, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json(errorBody('internal_error', 'An unexpected error occurred.'));
  };
}
