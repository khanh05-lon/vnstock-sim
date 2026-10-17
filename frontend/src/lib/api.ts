import { useAuth } from '../store/auth';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** Trường bổ sung máy chủ trả kèm lỗi (vd. `supportToken` khi tài khoản bị khoá) */
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** `token`: dùng token khác phiên đăng nhập (vd. vé hỗ trợ của tài khoản bị khoá) — lỗi 401 khi đó không đăng xuất */
export async function api<T>(path: string, opts: { method?: Method; body?: unknown; token?: string } = {}): Promise<T> {
  const own = opts.token === undefined;
  const token = own ? useAuth.getState().token : opts.token;
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Không kết nối được máy chủ');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const code = data?.error?.code ?? 'ERROR';
    // Hết phiên hoặc tài khoản bị quản trị viên khoá → đăng xuất ngay
    if (own && token && (res.status === 401 || code === 'ACCOUNT_LOCKED')) useAuth.getState().logout();
    const { code: _c, message: _m, ...extra } = (data?.error ?? {}) as Record<string, unknown>;
    throw new ApiError(res.status, code, data?.error?.message ?? `Lỗi ${res.status}`, extra);
  }
  return data as T;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Đã có lỗi xảy ra');

/** Vé hỗ trợ trả kèm lỗi ACCOUNT_LOCKED (đăng nhập / đặt lại mật khẩu khi tài khoản đang bị khoá) */
export const supportTokenOf = (e: unknown): string | null =>
  e instanceof ApiError && e.code === 'ACCOUNT_LOCKED' && typeof e.extra.supportToken === 'string' ? e.extra.supportToken : null;
