import 'dotenv/config';
import crypto from 'node:crypto';
import util from 'node:util';
import type { NextFunction, Request, Response } from 'express';

/**
 * Log có cấu trúc.
 *  - LOG_FORMAT=json (mặc định khi NODE_ENV=production): mỗi dòng 1 JSON {time, level, mod, msg, ...}
 *  - LOG_FORMAT=pretty (mặc định khi dev): dòng chữ dễ đọc như console.
 * Ở chế độ json, console.* cũng được chuyển sang JSON để log cũ (vd. "[vnstock] ...") vẫn có cấu trúc;
 * tiền tố "[xxx]" ở đầu thông điệp được tách thành trường `mod`.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const format = process.env.LOG_FORMAT === 'json' || process.env.LOG_FORMAT === 'pretty'
  ? process.env.LOG_FORMAT
  : process.env.NODE_ENV === 'production'
    ? 'json'
    : 'pretty';
const minRank = RANK[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? RANK.info;

const original = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function serializeError(e: unknown) {
  if (!(e instanceof Error)) return e;
  const out: Fields = { type: e.name, message: e.message };
  const code = (e as { code?: unknown }).code;
  if (code != null) out.code = code;
  if (e.stack) out.stack = e.stack;
  return out;
}

function write(level: Level, msg: string, fields?: Fields) {
  if (RANK[level] < minRank) return;
  if (format === 'json') {
    const m = /^\[([\w-]+)\]\s*/.exec(msg);
    const rec: Fields = { time: new Date().toISOString(), level };
    if (m) rec.mod = m[1];
    rec.msg = m ? msg.slice(m[0].length) : msg;
    if (fields) for (const [k, v] of Object.entries(fields)) rec[k] = k === 'err' ? serializeError(v) : v;
    let line: string;
    try {
      line = JSON.stringify(rec, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    } catch {
      line = JSON.stringify({ time: rec.time, level, msg: rec.msg });
    }
    process.stdout.write(`${line}\n`);
    return;
  }
  const out = level === 'debug' ? original.log : original[level];
  if (!fields || !Object.keys(fields).length) return out(msg);
  const { err, ...rest } = fields;
  const kv = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' ? v : util.inspect(v, { breakLength: Infinity })}`);
  if (err !== undefined) out(kv.length ? `${msg} ${kv.join(' ')}` : msg, err);
  else out(`${msg} ${kv.join(' ')}`);
}

export const log = {
  format,
  debug: (msg: string, fields?: Fields) => write('debug', msg, fields),
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
};

/** Chuyển console.* sang log JSON (Error trong tham số → trường err) */
function bridgeConsole() {
  const make =
    (level: Level) =>
    (...args: unknown[]) => {
      const err = args.find((a) => a instanceof Error);
      const rest = args.filter((a) => a !== err);
      write(level, util.format(...rest), err ? { err } : undefined);
    };
  console.log = make('info');
  console.info = make('info');
  console.warn = make('warn');
  console.error = make('error');
  console.debug = make('debug');
}
if (format === 'json') bridgeConsole();

const logRequests = process.env.LOG_REQUESTS ? process.env.LOG_REQUESTS === 'true' : format === 'json';

/** Gắn X-Request-Id và (tuỳ cấu hình) ghi log mỗi request /api khi trả lời xong */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const incoming = req.get('x-request-id');
  const id = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.locals.reqId = id;
  res.setHeader('X-Request-Id', id);
  if (!logRequests || !req.originalUrl.startsWith('/api')) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const path = req.originalUrl.split('?')[0];
    if (path === '/api/health' && res.statusCode < 400) return;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const user = (req as Request & { user?: { id: string } }).user;
    const level: Level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    write(level, '[http] request', {
      reqId: id,
      method: req.method,
      path,
      status: res.statusCode,
      ms: Math.round(ms * 10) / 10,
      ip: req.ip,
      userId: user?.id,
    });
  });
  next();
}
