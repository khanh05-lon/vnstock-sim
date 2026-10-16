import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';

/** Render trong Router + React Query (mỗi test 1 QueryClient riêng, không thử lại) */
export function renderApp(ui: ReactElement, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Giả lập fetch trả JSON theo đường dẫn API; ghi lại các request */
export function mockFetch(routes: Record<string, (body: unknown) => { status?: number; json: unknown }>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key](body) : { status: 404, json: { error: { code: 'NOT_FOUND', message: 'Không tìm thấy' } } };
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  globalThis.fetch = fn as typeof fetch;
  return calls;
}
