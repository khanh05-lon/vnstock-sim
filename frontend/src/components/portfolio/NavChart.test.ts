import { describe, expect, it, vi } from 'vitest';

// Biểu đồ canvas không cần trong test hàm tính toán
vi.mock('lightweight-charts', () => ({}));

const { returnSeries } = await import('./NavChart');

describe('Tỷ suất lợi nhuận của ví so với BTC', () => {
  it('trừ phần vốn góp thêm trong kỳ, BTC tính từ cùng ngày bắt đầu', () => {
    const r = returnSeries({
      points: [
        { date: '2026-10-01', nav: 1_000, contributed: 1_000 },
        { date: '2026-10-02', nav: 1_100, contributed: 1_000 },
        // quản trị viên cộng thêm 500 → NAV 1.650 nhưng lãi thật chỉ 150
        { date: '2026-10-03', nav: 1_650, contributed: 1_500 },
      ],
      benchmark: [
        { date: '2026-09-30', value: 990 },
        { date: '2026-10-01', value: 1_000 },
        { date: '2026-10-03', value: 1_050 },
      ],
    });
    expect(r.portfolio.map((p) => Math.round(p.value * 100) / 100)).toEqual([0, 10, 10]);
    expect(r.index.map((p) => p.value)).toEqual([0, 5]);
  });

  it('không có dữ liệu → rỗng', () => {
    expect(returnSeries({ points: [], benchmark: [] })).toEqual({ portfolio: [], index: [] });
  });
});
