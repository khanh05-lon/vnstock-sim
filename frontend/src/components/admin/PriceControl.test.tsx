import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AdminPriceRow } from '@vss/shared';
import { mockFetch, renderApp } from '../../test/render';
import { PriceControl } from './PriceControl';

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
});
