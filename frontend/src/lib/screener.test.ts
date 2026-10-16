import { describe, expect, it } from 'vitest';
import type { StockRow } from '@vss/shared';
import { EMPTY_FILTER, PRESETS, screen } from './screener';

const row = (symbol: string, p: Partial<StockRow>): StockRow =>
  ({
    symbol,
    name: symbol,
    exchange: 'HOSE',
    type: 'STOCK',
    industry: 'Ngân hàng',
    listedShares: 1_000_000_000,
    eps: 5_000,
    bvps: 30_000,
    isVn30: false,
    marginRatio: 0,
    ref: 40_000,
    last: 40_000,
    volume: 0,
    value: 0,
    ...p,
  }) as StockRow;

const rows = [
  row('VCB', { ref: 60_000, last: 63_000, volume: 1, value: 300e9, eps: 6_000, bvps: 40_000, isVn30: true, marginRatio: 0.5, listedShares: 5_589_000_000 }),
  row('HPG', { industry: 'Thép', ref: 25_000, last: 24_000, volume: 1, value: 150e9, eps: 3_000, bvps: 20_000, marginRatio: 0.5 }),
  row('LOSS', { exchange: 'UPCOM', eps: -500, bvps: 8_000, ref: 5_000, last: 5_000 }),
  row('E1VFVN30', { type: 'ETF', eps: 0, bvps: 0 }),
];

describe('Bộ lọc cổ phiếu', () => {
  it('mặc định chỉ cổ phiếu; P/E dùng giá khớp (chưa khớp thì tham chiếu), bỏ qua mã EPS âm khi lọc P/E', () => {
    expect(screen(rows, EMPTY_FILTER).map((r) => r.symbol)).toEqual(['VCB', 'HPG', 'LOSS']);
    const vcb = screen(rows, EMPTY_FILTER)[0];
    expect(vcb.pe).toBeCloseTo(63_000 / 6_000);
    expect(vcb.change).toBeCloseTo(5);
    expect(screen(rows, { ...EMPTY_FILTER, peMax: 20 }).map((r) => r.symbol)).toEqual(['VCB', 'HPG']);
  });

  it('bộ lọc mẫu và lọc kết hợp', () => {
    const preset = (id: string) => ({ ...EMPTY_FILTER, ...PRESETS.find((p) => p.id === id)!.filter });
    expect(screen(rows, preset('value')).map((r) => r.symbol)).toEqual(['HPG']);
    expect(screen(rows, preset('bluechip')).map((r) => r.symbol)).toEqual(['VCB']);
    expect(screen(rows, preset('liquid')).map((r) => r.symbol)).toEqual(['VCB', 'HPG']);
    expect(screen(rows, preset('gainers')).map((r) => r.symbol)).toEqual(['VCB']);
    expect(screen(rows, preset('losers')).map((r) => r.symbol)).toEqual(['HPG']);
    expect(screen(rows, { ...preset('margin'), industry: 'Thép' }).map((r) => r.symbol)).toEqual(['HPG']);
    expect(screen(rows, { ...EMPTY_FILTER, vn30: true, exchange: 'HOSE' }).map((r) => r.symbol)).toEqual(['VCB']);
    expect(screen(rows, { ...EMPTY_FILTER, type: 'ETF' }).map((r) => r.symbol)).toEqual(['E1VFVN30']);
  });
});
