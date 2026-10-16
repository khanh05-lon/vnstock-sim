import { describe, expect, it } from 'vitest';
import { cleanDecimal, decOrNull, fmtCompact, fmtPct, fmtPrice, fmtQty, fmtUsd, signTone } from './format';

describe('Định dạng số kiểu sàn coin', () => {
  it('giá theo bước giá của cặp, giá rất nhỏ giữ đủ chữ số lẻ', () => {
    expect(fmtPrice('82035.1', '0.01')).toBe('82,035.10');
    expect(fmtPrice('0.00000409', '0.00000001')).toBe('0.00000409');
    expect(fmtPrice('2453.02')).toBe('2,453.02');
    expect(fmtPrice('0.2313')).toBe('0.2313');
    expect(fmtPrice(null)).toBe('');
  });

  it('khối lượng theo bước khối lượng, tiền USDT, số rút gọn, phần trăm', () => {
    expect(fmtQty('0.01217781', '0.00001')).toBe('0.01217');
    expect(fmtQty('1500000', '1')).toBe('1,500,000');
    expect(fmtUsd('9999.00028347')).toBe('9,999.00');
    expect(fmtUsd('0.5')).toBe('0.50');
    expect(fmtCompact('1234567890')).toBe('1.23B');
    expect(fmtCompact(45_600)).toBe('45.60K');
    expect(fmtPct(1.234)).toBe('+1.23%');
    expect(signTone('-0.5')).toBe('down');
  });

  it('ô nhập số thập phân', () => {
    expect(cleanDecimal('82,035.1')).toBe('82035.1');
    expect(cleanDecimal('1.2.3abc')).toBe('1.23');
    expect(decOrNull('0.')).toBeNull();
    expect(decOrNull('0.001')).toBe('0.001');
    expect(decOrNull('-5')).toBe('5');
  });
});
