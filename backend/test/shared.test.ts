import { describe, expect, it } from 'vitest';
import {
  adPrice,
  applyRules,
  can,
  createAdSchema,
  effectiveLimits,
  fiatForQty,
  placeP2POrderSchema,
  priceInBand,
  qtyForFiat,
  refPriceVnd,
  validateP2POrderAmount,
  bnbRate,
  ceilStep,
  commissionOf,
  decimalsOf,
  floorStep,
  isMultiple,
  maxBuyQty,
  ocoOrderSchema,
  placeOrderSchema,
  RULES,
  stopTriggered,
  str,
  validateOrder,
  type SymbolInfo,
} from '@vss/shared';

/** Bộ lọc thật của BTCUSDT trên Binance (exchangeInfo) */
const BTC: SymbolInfo = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  name: 'Bitcoin',
  status: 'TRADING',
  sortOrder: 0,
  filters: {
    tickSize: '0.01',
    minPrice: '0.01',
    maxPrice: '1000000',
    stepSize: '0.00001',
    minQty: '0.00001',
    maxQty: '9000',
    marketMaxQty: '144.10594037',
    minNotional: '5',
    maxNotional: '9000000',
    applyMinToMarket: true,
    applyMaxToMarket: false,
    bidMultiplierUp: '1.2',
    bidMultiplierDown: '0.5',
    askMultiplierUp: '2',
    askMultiplierDown: '0.8',
    maxNumOrders: 200,
    maxNumAlgoOrders: 5,
  },
};

describe('Số thập phân', () => {
  it('không sai số dấu phẩy động', () => {
    expect(str('0.1').length).toBe(3);
    expect(floorStep('0.123456789', '0.00001')).toBe('0.12345');
    expect(ceilStep('0.123451', '0.00001')).toBe('0.12346');
    expect(isMultiple('0.30000', '0.1')).toBe(true);
    expect(isMultiple('0.123455', '0.00001')).toBe(false);
    expect(decimalsOf('0.01000000')).toBe(2);
    expect(decimalsOf('1.00000000')).toBe(0);
    expect(str('0.00000409')).toBe('0.00000409');
  });

  it('khối lượng mua tối đa làm tròn xuống theo stepSize', () => {
    expect(maxBuyQty(BTC.filters, '1000', '82087.98')).toBe('0.01218');
  });
});

describe('Bộ lọc lệnh (Binance filters)', () => {
  const avg = '82000';
  const limit = (price: string, quantity: string, side: 'BUY' | 'SELL' = 'BUY') => validateOrder(BTC, { side, type: 'LIMIT', price, quantity }, avg);

  it('lệnh hợp lệ', () => {
    expect(limit('81000.5', '0.001')).toBeNull();
  });

  it('PRICE_FILTER: bước giá', () => {
    expect(limit('81000.555', '0.001')?.code).toBe('PRICE_FILTER');
  });

  it('LOT_SIZE: khối lượng tối thiểu và bước', () => {
    expect(limit('81000', '0.000001')?.code).toBe('LOT_SIZE');
    expect(limit('81000', '0.000015')?.code).toBe('LOT_SIZE');
  });

  it('NOTIONAL: giá trị tối thiểu 5 USDT', () => {
    const e = limit('81000', '0.00005');
    expect(e?.code).toBe('NOTIONAL');
    expect(e?.message).toContain('5 USDT');
  });

  it('PERCENT_PRICE_BY_SIDE: giá mua tối đa avg × 1.2, giá bán tối thiểu avg × 0.8', () => {
    expect(limit('98400', '0.001', 'BUY')).toBeNull();
    expect(limit('98400.01', '0.001', 'BUY')?.code).toBe('PERCENT_PRICE');
    expect(limit('65600', '0.001', 'SELL')).toBeNull();
    expect(limit('65599.99', '0.001', 'SELL')?.code).toBe('PERCENT_PRICE');
  });

  it('MARKET theo số tiền: áp dụng minNotional', () => {
    expect(validateOrder(BTC, { side: 'BUY', type: 'MARKET', quoteOrderQty: '4.99' }, avg)?.code).toBe('NOTIONAL');
    expect(validateOrder(BTC, { side: 'BUY', type: 'MARKET', quoteOrderQty: '10' }, avg)).toBeNull();
  });

  it('MARKET theo khối lượng: MARKET_LOT_SIZE', () => {
    expect(validateOrder(BTC, { side: 'SELL', type: 'MARKET', quantity: '150' }, avg)?.code).toBe('MARKET_LOT_SIZE');
  });

  it('cặp tạm ngừng', () => {
    expect(validateOrder({ ...BTC, status: 'HALT' }, { side: 'BUY', type: 'LIMIT', price: '81000', quantity: '0.001' }, avg)?.code).toBe('SYMBOL_STATUS');
  });
});

describe('Schema đặt lệnh', () => {
  it('LIMIT cần giá và khối lượng', () => {
    expect(placeOrderSchema.safeParse({ symbol: 'btcusdt', side: 'BUY', type: 'LIMIT', quantity: '0.001' }).success).toBe(false);
    const ok = placeOrderSchema.parse({ symbol: 'btcusdt', side: 'BUY', type: 'LIMIT', price: 81000, quantity: '0.001' });
    expect(ok.symbol).toBe('BTCUSDT');
    expect(ok.price).toBe('81000');
  });

  it('MARKET: khối lượng HOẶC số tiền', () => {
    expect(placeOrderSchema.safeParse({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET' }).success).toBe(false);
    expect(placeOrderSchema.safeParse({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '1', quoteOrderQty: '10' }).success).toBe(false);
    expect(placeOrderSchema.safeParse({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quoteOrderQty: '10' }).success).toBe(true);
  });

  it('STOP_LOSS_LIMIT cần giá kích hoạt', () => {
    expect(placeOrderSchema.safeParse({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_LOSS_LIMIT', price: '1', quantity: '1' }).success).toBe(false);
  });

  it('OCO đủ ba mức giá', () => {
    expect(ocoOrderSchema.safeParse({ symbol: 'BTCUSDT', side: 'SELL', quantity: '0.01', price: '90000', stopPrice: '78000' }).success).toBe(false);
  });
});

describe('Kích hoạt lệnh dừng', () => {
  it('cắt lỗ bán khi giá ≤ stop, mua khi giá ≥ stop; chốt lời ngược lại', () => {
    expect(stopTriggered('STOP_LOSS_LIMIT', 'SELL', 100, 99)).toBe(true);
    expect(stopTriggered('STOP_LOSS_LIMIT', 'SELL', 100, 101)).toBe(false);
    expect(stopTriggered('STOP_LOSS_LIMIT', 'BUY', 100, 100)).toBe(true);
    expect(stopTriggered('TAKE_PROFIT_LIMIT', 'SELL', 100, 101)).toBe(true);
    expect(stopTriggered('TAKE_PROFIT_LIMIT', 'BUY', 100, 101)).toBe(false);
  });
});

describe('Phí giao dịch', () => {
  it('0,1% trên tài sản nhận về, làm tròn lên 8 chữ số lẻ', () => {
    expect(commissionOf('0.01218', RULES.takerFee)).toBe('0.00001218');
    expect(commissionOf('1000.5', RULES.takerFee)).toBe('1.0005');
    expect(commissionOf('0.000000001', '0.001')).toBe('0.00000001');
  });

  it('BNB giảm 25%', () => {
    expect(bnbRate('0.001')).toBe('0.00075');
  });

  it('applyRules ghi đè và khôi phục mặc định', () => {
    applyRules({ takerFee: '0.002' });
    expect(RULES.takerFee).toBe('0.002');
    applyRules(null);
    expect(RULES.takerFee).toBe('0.001');
  });
});

describe('P2P: giá và hạn mức', () => {
  it('giá tham chiếu VNĐ: USDT theo tỷ giá, coin khác = giá USDT × tỷ giá', () => {
    expect(refPriceVnd('USDT', null, '26000')).toBe('26000');
    expect(refPriceVnd('BTC', '80000.5', '26000')).toBe('2080013000');
    expect(refPriceVnd('ETH', null, '26000')).toBeNull();
  });

  it('giá quảng cáo cố định / thả nổi và biên giá', () => {
    expect(adPrice({ priceType: 'FIXED', fixedPrice: '26500', floatRatio: null }, '26000')).toBe('26500');
    expect(adPrice({ priceType: 'FLOATING', fixedPrice: null, floatRatio: '101.5' }, '26000')).toBe('26390');
    expect(priceInBand('31200', '26000', 20)).toBe(true);
    expect(priceInBand('31201', '26000', 20)).toBe(false);
    expect(priceInBand('20799', '26000', 20)).toBe(false);
  });

  it('quy đổi VNĐ ↔ coin làm tròn theo độ chính xác của coin', () => {
    expect(qtyForFiat('1000000', '26390', 'USDT')).toBe('37.89');
    expect(qtyForFiat('1000000', '2080013000', 'BTC')).toBe('0.00048');
    expect(fiatForQty('37.89', '26390')).toBe('999918');
    expect(fiatForQty('0.1', '26390.5')).toBe('2640');
  });

  it('hạn mức thực tế bị giới hạn bởi số lượng còn lại', () => {
    const ad = { minFiat: '500000', maxFiat: '50000000', availableQty: '100' };
    expect(effectiveLimits(ad, '26000')).toEqual({ min: '500000', max: '2600000' });
    expect(validateP2POrderAmount('400000', '15.38', ad, '26000')).toMatch(/tối thiểu/);
    expect(validateP2POrderAmount('2600001', '100', ad, '26000')).toMatch(/tối đa/);
    expect(validateP2POrderAmount('1000000', '38.46', ad, '26000')).toBeNull();
  });

  it('schema quảng cáo: giá cố định bắt buộc, hạn mức tối đa ≥ tối thiểu', () => {
    const base = { side: 'SELL', asset: 'USDT', totalQty: '100', minFiat: '500000', maxFiat: '2000000', payMinutes: 15, paymentMethodIds: [1] };
    expect(createAdSchema.safeParse({ ...base, priceType: 'FIXED' }).success).toBe(false);
    expect(createAdSchema.safeParse({ ...base, priceType: 'FIXED', fixedPrice: '26300' }).success).toBe(true);
    expect(createAdSchema.safeParse({ ...base, priceType: 'FIXED', fixedPrice: '26300', maxFiat: '100000' }).success).toBe(false);
    expect(placeP2POrderSchema.safeParse({ adId: 1 }).success).toBe(false);
    expect(placeP2POrderSchema.safeParse({ adId: 1, fiatAmount: '500000', qty: '1' }).success).toBe(false);
  });

  it('quyền P2P: Rủi ro duyệt thương nhân, CSKH và Rủi ro xử lý khiếu nại', () => {
    expect(can('RISK', 'p2p.review')).toBe(true);
    expect(can('SUPPORT', 'p2p.review')).toBe(false);
    expect(can('SUPPORT', 'p2p.appeal')).toBe(true);
    expect(can('ADMIN', 'p2p.appeal')).toBe(false);
  });
});
