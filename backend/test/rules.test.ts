import { describe, expect, it } from 'vitest';
import { isValidTick, priceBand, stepPrice, tickSize } from '@vss/shared';
import { generateHistory } from '../src/seed/seed';
import { SEED_STOCKS } from '../src/seed/stocks';

describe('Quy tắc giá', () => {
  it('bước giá HOSE theo vùng giá, HNX/UPCOM 100đ', () => {
    expect(tickSize('HOSE', 9_990)).toBe(10);
    expect(tickSize('HOSE', 10_000)).toBe(50);
    expect(tickSize('HOSE', 49_950)).toBe(50);
    expect(tickSize('HOSE', 50_000)).toBe(100);
    expect(tickSize('HNX', 9_000)).toBe(100);
    expect(tickSize('UPCOM', 120_000)).toBe(100);
  });

  it('giá trần/sàn làm tròn vào trong biên độ và đúng bước giá', () => {
    expect(priceBand('HOSE', 98_500)).toEqual({ ceil: 105_300, floor: 91_700 });
    expect(priceBand('HNX', 13_400)).toEqual({ ceil: 14_700, floor: 12_100 });
    expect(priceBand('UPCOM', 8_900)).toEqual({ ceil: 10_200, floor: 7_600 });
    for (const s of SEED_STOCKS) {
      const b = priceBand(s.exchange, s.ref);
      expect(isValidTick(s.exchange, b.ceil)).toBe(true);
      expect(isValidTick(s.exchange, b.floor)).toBe(true);
      expect(b.ceil).toBeGreaterThan(s.ref);
      expect(b.floor).toBeLessThan(s.ref);
    }
  });

  it('bước giá qua ngưỡng 10.000 / 50.000', () => {
    expect(stepPrice('HOSE', 10_000, -1)).toBe(9_990);
    expect(stepPrice('HOSE', 9_990, 1)).toBe(10_000);
    expect(stepPrice('HOSE', 50_000, -1)).toBe(49_950);
    expect(stepPrice('HOSE', 49_950, 1)).toBe(50_000);
  });

  it('lịch sử sinh ra hợp lệ: đúng bước giá, trong biên độ, phiên cuối = giá tham chiếu', () => {
    const dates = Array.from({ length: 120 }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, '0')}`);
    for (const s of SEED_STOCKS) {
      const bars = generateHistory(s, dates);
      expect(bars[bars.length - 1].close).toBe(s.ref);
      for (let i = 1; i < bars.length; i++) {
        const band = priceBand(s.exchange, bars[i - 1].close);
        const b = bars[i];
        for (const p of [b.open, b.high, b.low, b.close]) {
          expect(isValidTick(s.exchange, p)).toBe(true);
          expect(p).toBeGreaterThanOrEqual(band.floor);
          expect(p).toBeLessThanOrEqual(band.ceil);
        }
        expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
        expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
      }
    }
  });
});
