import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { log } from './logger';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** Trường bổ sung trả kèm trong `error` (vd. vé hỗ trợ khi tài khoản bị khoá) */
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string) => new AppError(400, code, message);
export const notFound = (message = 'Không tìm thấy') => new AppError(404, 'NOT_FOUND', message);
export const unauthorized = (message = 'Bạn cần đăng nhập') => new AppError(401, 'UNAUTHORIZED', message);

/** Bọc handler async để lỗi được chuyển tới error middleware */
export const ah =
  <R extends Request>(fn: (req: R, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: R, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    res.status(400).json({ error: { code: 'VALIDATION', message: issue?.message ?? 'Dữ liệu không hợp lệ', field: issue?.path.join('.') } });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { ...err.extra, code: err.code, message: err.message } });
    return;
  }
  if (err instanceof SyntaxError && 'body' in (err as object)) {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'JSON không hợp lệ' } });
    return;
  }
  // Lỗi 4xx của middleware (vd. body quá lớn → 413)
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: { code: 'BAD_REQUEST', message: status === 413 ? 'Dữ liệu gửi lên quá lớn' : 'Yêu cầu không hợp lệ' } });
    return;
  }
  log.error('[http] lỗi không xử lý được', { err, reqId: res.locals.reqId, method: req.method, path: req.originalUrl.split('?')[0] });
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Lỗi hệ thống, vui lòng thử lại' } });
}
