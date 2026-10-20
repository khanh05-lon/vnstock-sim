import { describe, expect, it } from 'vitest';
import { moderateName, moderateText, parseTags, strikePenaltyHours, type ModRule } from '@vss/shared';

const rulesOf = (text: string, extra = {}) => moderateText(text, extra).hits.map((h) => h.rule);
const verdict = (text: string, extra = {}) => moderateText(text, extra).verdict;
const expectRule = (text: string, rule: ModRule, v: 'BLOCK' | 'REVIEW') => {
  const r = moderateText(text);
  expect(r.hits.map((h) => h.rule), text).toContain(rule);
  expect(r.verdict, text).toBe(v);
};

describe('bộ lọc Cộng đồng — câu bình thường phải qua', () => {
  const clean = [
    'BTC đang tích luỹ, mình nghĩ sẽ lên lớn trong tuần này',
    'Các bạn thấy $ETH thế nào? Mình mua thêm ở 3.200',
    'Đi ngang quá lâu rồi, đúng là thị trường chán',
    'Giá 65.000.000 VNĐ một ETH thì quá đắt',
    'Mình dành để mua BNB cho được giảm phí',
    'Nhớ báo lại cho mọi người nếu thấy lỗi nhé',
    'Bộ máy khớp lệnh của sàn chạy nhanh thật',
    'Chuyển thẳng cho ví Spot là xong',
    'Máy chết pin nên mình không vào lệnh kịp',
    'Chế độ giá điều chỉnh có nhãn rõ ràng',
    'Lỗ 5% rồi, cắt lỗ thôi #quanlyvon',
    'Shiba và Doge là meme coin, đừng all-in nha',
    'Đọc thêm phân tích trên https://www.tradingview.com/chart/ nhé',
    'Giá hiện tại 0.351234567 USDT',
    'Đừng bao giờ đưa seed phrase cho bất kỳ ai',
    'Mua 100x BTC thì làm sao được, vốn có 10k',
    'Dù mà giảm thì mình vẫn giữ',
    'Hôm nay lãi 3% rồi, chốt thôi',
  ];
  for (const s of clean) it(s, () => expect(moderateText(s)).toEqual({ verdict: 'ALLOW', hits: [] }));
});

describe('bộ lọc Cộng đồng — chặn', () => {
  it('tục tĩu có dấu, bỏ dấu, teencode, leetspeak, chèn dấu chấm', () => {
    for (const s of ['đm thằng này', 'vcl luôn', 'clgt vậy', 'đ.m giá xuống', 'd m m', 'ditme', 'd1t m3 sàn', 'cái lồn gì vậy', 'đéo hiểu', 'what the fuck', 'loz'])
      expectRule(s, 'PROFANITY', 'BLOCK');
  });
  it('xúc phạm', () => {
    for (const s of ['óc chó à', 'ngu như bò', 'đồ súc vật', 'mẹ mày', 'o c c h o']) expectRule(s, 'HARASSMENT', 'BLOCK');
  });
  it('thông tin cá nhân', () => {
    for (const s of [
      'gọi mình 0912 345 678',
      'sđt 0987.654.321',
      '+84912345678',
      'email mình là abc.def@gmail.com',
      'STK vietcombank 0123456789012',
      'CCCD 001099012345',
      'ví nhận 0x52908400098527886E0F7030069857D2E4169EE7',
      'seed phrase của mình: apple banana cherry dog eagle fish grape house igloo jacket kite lemon',
      '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
    ])
      expectRule(s, 'PII', 'BLOCK');
  });
  it('liên kết ngoài danh sách cho phép, link mời nhóm', () => {
    for (const s of ['vào t.me/keobtc nhé', 'https://bit.ly/abc', 'xem ở pump-signal.xyz', 'zalo.me/0912', 'http://binance.com.scam.io/login'])
      expectRule(s, 'LINK', 'BLOCK');
    expect(verdict('xem coingecko.com/en/coins/bitcoin')).toBe('ALLOW');
    expect(verdict('xem x.com/abc', { allowedDomains: ['x.com'] })).toBe('ALLOW');
  });
  it('người lớn, cờ bạc, chất cấm', () => {
    expectRule('phim sex mới', 'ADULT', 'BLOCK');
    expectRule('nhà cái uy tín, cá độ bóng đá', 'GAMBLING', 'BLOCK');
    expectRule('bán cần sa', 'DRUGS', 'BLOCK');
  });
});

describe('bộ lọc Cộng đồng — giữ lại chờ duyệt', () => {
  it('lừa đảo / kéo ra ngoài sàn', () => {
    for (const s of ['ib mình để nhận kèo', 'vào nhóm kín telegram', 'giao dịch ngoài sàn giá tốt', 'kết bạn zalo nhé']) expectRule(s, 'SCAM', 'REVIEW');
  });
  it('kéo giá, cam kết lãi', () => {
    for (const s of ['anh em cùng nhau mua $PEPE kéo giá', 'đảm bảo lãi 10%/ngày', 'lãi 5% mỗi ngày', 'chắc chắn lên x100']) expectRule(s, 'MANIPULATION', 'REVIEW');
  });
  it('mạo danh, chính trị, spam', () => {
    expectRule('Mình là admin VNCoin, cần hỗ trợ thì nhắn', 'IMPERSONATION', 'REVIEW');
    expectRule('Chính phủ Mỹ vừa duyệt ETF Bitcoin', 'POLITICS', 'REVIEW');
    expectRule('MUA NGAY ĐI ANH EM ƠI GIÁ SẮP BAY RỒI ĐÓ', 'SPAM', 'REVIEW');
    expectRule('$BTC $ETH $BNB $SOL $XRP $DOGE lên hết', 'SPAM', 'REVIEW');
  });
  it('chặn thắng giữ lại khi có cả hai', () => {
    const r = moderateText('ib mình 0912345678');
    expect(r.verdict).toBe('BLOCK');
    expect(r.hits.map((h) => h.rule).sort()).toEqual(['PII', 'SCAM']);
  });
  it('từ quản trị thêm', () => {
    expect(rulesOf('coin rác XYZ', { blockWords: ['coin rác'] })).toEqual(['CUSTOM']);
    expect(verdict('coin rác XYZ', { blockWords: ['coin rác'] })).toBe('BLOCK');
    expect(verdict('shill dự án', { reviewWords: ['shill'] })).toBe('REVIEW');
  });
});

describe('tên / thẻ / thang phạt', () => {
  it('tên mạo danh và tên tục bị từ chối', () => {
    for (const n of ['vncoin_support', 'Admin123', 'CSKH VNCoin', 'thang_vcl', 'Binance Official']) expect(moderateName(n).verdict, n).toBe('BLOCK');
    for (const n of ['trader_hcm', 'Nguyễn Văn A', 'btc_hodler']) expect(moderateName(n).verdict, n).toBe('ALLOW');
  });
  it('parseTags', () => {
    expect(parseTags('$btc lên, $ETH xuống, $btc #DCA #Đầu_tư a#b')).toEqual({ cashtags: ['BTC', 'ETH'], hashtags: ['dca', 'đầu_tư'] });
  });
  it('strikePenaltyHours', () => {
    const ladder = [0, 24, 168, 720];
    expect([0, 1, 2, 3, 4, 9].map((n) => strikePenaltyHours(n, ladder))).toEqual([0, 0, 24, 168, 720, 720]);
  });
});
