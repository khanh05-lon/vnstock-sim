import { describe, expect, it } from 'vitest';
import { fmtCompact, fmtPct, fmtPrice, parseIntInput, parsePriceInput, priceTone } from './format';
import { bondYield, warrantStats } from './instruments';
import { describeAction, navOfAccount } from './queries';
import type { StockRow } from '@vss/shared';

describe('Định dạng & nhập liệu', () => {
  it('giá hiển thị theo nghìn đồng như bảng điện', () => {
    expect(fmtPrice(98_500)).toBe('98.50');
    expect(fmtPrice(0)).toBe('');
    expect(fmtPct(1.234)).toBe('+1.23%');
    expect(fmtCompact(1_250_000_000)).toBe('1.25 tỷ');
    expect(fmtCompact(350_000_000)).toBe('350.0 tr');
  });

  it('nhập giá dạng nghìn đồng hoặc VNĐ đầy đủ; nhập khối lượng bỏ ký tự thừa', () => {
    expect(parsePriceInput('98.5')).toBe(98_500);
    expect(parsePriceInput('98500')).toBe(98_500);
    expect(parsePriceInput('98,500')).toBe(98_500);
    expect(parsePriceInput('abc')).toBeNull();
    expect(parsePriceInput('-5')).toBeNull();
    expect(parseIntInput('1,000 CP')).toBe(1_000);
  });

  it('màu giá theo trần / sàn / tham chiếu', () => {
    expect(priceTone(107_000, 100_000, 107_000, 93_000)).toBe('ceil');
    expect(priceTone(93_000, 100_000, 107_000, 93_000)).toBe('floor');
    expect(priceTone(100_000, 100_000, 107_000, 93_000)).toBe('ref');
    expect(priceTone(101_000, 100_000, 107_000, 93_000)).toBe('up');
    expect(priceTone(99_000, 100_000, 107_000, 93_000)).toBe('down');
  });
});

describe('Tài sản ròng & sự kiện quyền', () => {
  it('NAV = tiền mặt + chờ về + cổ phiếu + quyền − nợ ký quỹ', () => {
    const a = { cashBalance: 100, cashHold: 0, cashAvailable: 100, initialCapital: 1000, cashPending: 50, rightsValue: 10, loanBalance: 30, loanInterest: 2 };
    expect(navOfAccount(a, 900)).toBe(100 + 50 + 900 + 10 - 32);
    expect(navOfAccount({ cashBalance: 5, cashHold: 0, cashAvailable: 5, initialCapital: 5 }, 0)).toBe(5);
  });

  it('mô tả sự kiện quyền', () => {
    expect(describeAction({ type: 'CASH_DIVIDEND', cashPerShare: 2000, ratioFrom: null, ratioTo: null, issuePrice: null })).toBe('Cổ tức tiền 2,000đ/CP');
    expect(describeAction({ type: 'SPLIT', cashPerShare: null, ratioFrom: 1, ratioTo: 2, issuePrice: null })).toBe('Chia tách 1:2');
    expect(describeAction({ type: 'RIGHTS', cashPerShare: null, ratioFrom: 4, ratioTo: 1, issuePrice: 10000 })).toBe('Quyền mua 4:1 giá 10,000đ');
  });
});

describe('Chứng quyền & trái phiếu', () => {
  it('lợi suất trái phiếu mua đúng mệnh giá ≈ lãi suất coupon; mua dưới mệnh giá → lợi suất cao hơn', () => {
    const b = { parValue: 100_000, couponRate: 0.08, couponFreq: 2, maturityDate: '2029-10-16' };
    expect(bondYield(100_000, b, '2026-10-16')).toBeCloseTo(0.08, 2);
    expect(bondYield(95_000, b, '2026-10-16')).toBeGreaterThan(0.09);
  });

  it('giá trị nội tại, điểm hoà vốn của chứng quyền', () => {
    const cw = {
      volume: 1,
      last: 2_000,
      ref: 2_000,
      warrant: { underlying: 'FPT', issuer: 'X', ratio: 5, exercisePrice: 95_000, maturityDate: '2099-01-01', lastTradingDate: '2098-12-28' },
    } as StockRow;
    const st = warrantStats(cw, 105_000);
    expect(st.intrinsic).toBe(2_000);
    expect(st.breakEven).toBe(95_000 + 2_000 * 5);
    expect(st.moneyness).toBe('ITM');
    expect(warrantStats(cw, 90_000).moneyness).toBe('OTM');
  });
});
