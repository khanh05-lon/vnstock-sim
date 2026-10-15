import { useAuth } from '../store/auth';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function api<T>(path: string, opts: { method?: Method; body?: unknown } = {}): Promise<T> {
  const token = useAuth.getState().token;
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
    if (token && (res.status === 401 || code === 'ACCOUNT_LOCKED')) useAuth.getState().logout();
    throw new ApiError(res.status, code, data?.error?.message ?? `Lỗi ${res.status}`);
  }
  return data as T;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Đã có lỗi xảy ra');
