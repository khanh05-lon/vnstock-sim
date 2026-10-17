import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AdminPriceRow, ApprovalDTO, UserRole } from '@vss/shared';
import { useAuth } from '../../store/auth';
import { mockFetch, renderApp } from '../../test/render';
import { OperationApprovals } from './OperationApprovals';
import { PriceControl } from './PriceControl';

/** Đăng nhập giả lập với vai trò nhân viên; /api/admin/me trả vai trò đó */
const loginAs = (role: UserRole, email = `${role.toLowerCase()}@x.test`) => {
  useAuth.getState().setAuth('t', { id: email, email, fullName: role, createdAt: '', role });
  return { '/api/admin/me': () => ({ json: { ok: true, admin: { id: email, email, role } } }) };
};

afterEach(() => useAuth.getState().logout());

const row = (over: Partial<AdminPriceRow>): AdminPriceRow => ({
  symbol: 'BTCUSDT',
  name: 'Bitcoin',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  tickSize: '0.01',
  minPrice: '0.01',
  maxPrice: '1000000',
  mode: 'LIVE',
  last: '100000',
  ref: '100000',
  diffPct: 0,
  control: null,
  ...over,
});

describe('Quản trị: giá thị trường', () => {
  it('liệt kê chế độ từng cặp; cặp điều chỉnh hiện kịch bản và chênh lệch với Binance', async () => {
    mockFetch({
      ...loginAs('MARKET_OPS'),
      '/api/admin/prices': () => ({
        json: [
          row({}),
          row({
            symbol: 'ETHUSDT',
            name: 'Ethereum',
            baseAsset: 'ETH',
            mode: 'MANUAL',
            last: '2200',
            ref: '2000',
            diffPct: 10,
            control: { since: 1, from: '2000', to: '2400', startAt: 1, endAt: Date.now() + 10 * 60_000, volatilityPct: 0.3, reason: 'Kịch bản lớp học', by: 'admin@x', progress: 0.5, pathPrice: '2200' },
          }),
        ],
      }),
    });
    renderApp(<PriceControl />);
    expect(await screen.findByText('Thực tế')).toBeTruthy();
    expect(screen.getByText('Điều chỉnh')).toBeTruthy();
    expect(screen.getByText('+10.00%')).toBeTruthy();
    expect(screen.getByText(/còn 10 phút/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Về giá thực tế' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Chuyển sang điều chỉnh' })).toBeTruthy();
  });

  it('đặt giá lệch trên 20% phải tích xác nhận; gửi giá, thời gian, dao động, lý do', async () => {
    const calls = mockFetch({
      ...loginAs('MARKET_OPS'),
      '/api/admin/prices/BTCUSDT/set': () => ({ json: { ok: true } }),
      '/api/admin/prices': () => ({ json: [row({})] }),
    });
    renderApp(<PriceControl />);
    fireEvent.click(await screen.findByRole('button', { name: 'Đặt giá' }));
    const dialog = await screen.findByRole('dialog');
    const [priceInput] = dialog.querySelectorAll('input');
    fireEvent.change(priceInput!, { target: { value: '70000' } });
    expect(await screen.findByText('(-30.00%)')).toBeTruthy();
    fireEvent.change(dialog.querySelector('select')!, { target: { value: '15' } });
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'Mô phỏng sập giá' } });
    const submit = screen.getByRole('button', { name: 'Chạy kịch bản' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /tôi xác nhận/i }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/api/admin/prices/BTCUSDT/set',
      body: { price: '70000', durationMin: 15, volatilityPct: 0.2, reason: 'Mô phỏng sập giá' },
    });
  });

  it('kiểm toán (chỉ đọc) thấy bảng giá nhưng không có nút thao tác nào ngoài xem lịch sử', async () => {
    mockFetch({ ...loginAs('AUDITOR'), '/api/admin/prices': () => ({ json: [row({})] }) });
    renderApp(<PriceControl />);
    expect(await screen.findByText('Thực tế')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: /lịch sử chỉnh giá BTCUSDT/i })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Đặt giá' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Chuyển sang điều chỉnh' })).toBeNull();
  });
});

describe('Quản trị: hàng chờ duyệt', () => {
  const req = (over: Partial<ApprovalDTO>): ApprovalDTO => ({
    id: 7,
    kind: 'SYMBOL_DELIST',
    target: 'DOGEUSDT',
    payload: {},
    summary: 'Gỡ cặp DOGEUSDT khỏi sàn — huỷ 3 lệnh đang mở',
    reason: 'Thanh khoản thấp',
    status: 'PENDING',
    requestedByEmail: 'ops@x.test',
    requestedRole: 'MARKET_OPS',
    decidedByEmail: null,
    decisionNote: null,
    decidedAt: null,
    result: null,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...over,
  });

  it('người có thẩm quyền khác thấy Duyệt / Từ chối và duyệt gửi đúng đề xuất', async () => {
    const calls = mockFetch({
      ...loginAs('RISK'),
      '/api/admin/approvals/7/approve': () => ({ json: { ...req({ status: 'APPROVED' }) } }),
      '/api/admin/approvals': () => ({ json: [req({})] }),
    });
    renderApp(<OperationApprovals />);
    expect(await screen.findByText('Huỷ niêm yết cặp')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Duyệt' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Duyệt và thực hiện' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.url).toBe('/api/admin/approvals/7/approve');
  });

  it('người đề xuất chỉ thấy Rút đề xuất; vai trò không có thẩm quyền chỉ thấy chờ ai duyệt', async () => {
    mockFetch({ ...loginAs('MARKET_OPS', 'ops@x.test'), '/api/admin/approvals': () => ({ json: [req({})] }) });
    const first = renderApp(<OperationApprovals />);
    expect(await screen.findByRole('button', { name: 'Rút đề xuất' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Duyệt' })).toBeNull();
    first.unmount();
    useAuth.getState().logout();

    mockFetch({ ...loginAs('FINANCE'), '/api/admin/approvals': () => ({ json: [req({})] }) });
    renderApp(<OperationApprovals />);
    expect(await screen.findByText(/Chờ Vận hành thị trường hoặc Rủi ro & giám sát duyệt/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Duyệt' })).toBeNull();
  });
});
