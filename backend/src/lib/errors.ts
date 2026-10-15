import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
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

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    res.status(400).json({ error: { code: 'VALIDATION', message: issue?.message ?? 'Dữ liệu không hợp lệ', field: issue?.path.join('.') } });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof SyntaxError && 'body' in (err as object)) {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'JSON không hợp lệ' } });
    return;
  }
  console.error('[error]', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Lỗi hệ thống, vui lòng thử lại' } });
}
