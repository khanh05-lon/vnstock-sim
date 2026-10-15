import type { Exchange } from '@vss/shared';

/**
 * Danh sách mã mô phỏng. Giá tham chiếu, EPS, BVPS… là SỐ LIỆU GIẢ LẬP gần với
 * mặt bằng thị trường, không phải dữ liệu thật — chỉ dùng cho mục đích học tập.
 */
export interface SeedStock {
  symbol: string;
  exchange: Exchange;
  name: string;
  industry: string;
  ref: number; // giá tham chiếu khởi điểm (VNĐ)
  sharesM: number; // KL niêm yết (triệu CP)
  eps: number;
  bvps: number;
  liq: number; // thanh khoản tương đối 0..1
}

const I = {
  BANK: 'Ngân hàng',
  RE: 'Bất động sản',
  SEC: 'Chứng khoán',
  STEEL: 'Thép & Vật liệu',
  RETAIL: 'Bán lẻ',
  TECH: 'Công nghệ & Viễn thông',
  OIL: 'Dầu khí',
  FOOD: 'Thực phẩm & Đồ uống',
  AIR: 'Hàng không & Logistics',
  POWER: 'Điện & Năng lượng',
  CHEM: 'Hoá chất & Phân bón',
  CONS: 'Xây dựng',
  INS: 'Bảo hiểm',
  IP: 'KCN & Cao su',
  AGRI: 'Nông nghiệp & Thuỷ sản',
  TEXT: 'Dệt may',
  IND: 'Công nghiệp',
};

type Row = [string, string, string, number, number, number, number, number];

const HOSE: Row[] = [
  ['ACB', 'Ngân hàng TMCP Á Châu', I.BANK, 25_500, 4466, 3800, 17500, 0.85],
  ['BCM', 'Tổng Công ty Đầu tư và Phát triển Công nghiệp', I.IP, 68_000, 1035, 1700, 18000, 0.3],
  ['BID', 'Ngân hàng TMCP Đầu tư và Phát triển Việt Nam', I.BANK, 38_500, 6970, 3450, 22000, 0.6],
  ['BVH', 'Tập đoàn Bảo Việt', I.INS, 52_000, 742, 2300, 31000, 0.35],
  ['CTG', 'Ngân hàng TMCP Công Thương Việt Nam', I.BANK, 41_000, 5370, 4200, 24500, 0.75],
  ['FPT', 'Công ty Cổ phần FPT', I.TECH, 98_500, 1471, 5900, 22000, 0.9],
  ['GAS', 'Tổng Công ty Khí Việt Nam', I.OIL, 66_500, 2342, 4600, 28500, 0.45],
  ['GVR', 'Tập đoàn Công nghiệp Cao su Việt Nam', I.IP, 29_800, 4000, 1000, 11500, 0.55],
  ['HDB', 'Ngân hàng TMCP Phát triển TP.HCM', I.BANK, 27_350, 3500, 4100, 17000, 0.65],
  ['HPG', 'Công ty Cổ phần Tập đoàn Hoà Phát', I.STEEL, 26_800, 7675, 1900, 16500, 1],
  ['LPB', 'Ngân hàng TMCP Lộc Phát Việt Nam', I.BANK, 34_500, 2987, 3600, 16000, 0.5],
  ['MBB', 'Ngân hàng TMCP Quân Đội', I.BANK, 24_600, 6105, 3700, 17800, 0.95],
  ['MSN', 'Công ty Cổ phần Tập đoàn Masan', I.FOOD, 76_200, 1438, 1500, 30000, 0.6],
  ['MWG', 'Công ty Cổ phần Đầu tư Thế Giới Di Động', I.RETAIL, 68_900, 1478, 2700, 18000, 0.8],
  ['PLX', 'Tập đoàn Xăng dầu Việt Nam', I.OIL, 36_450, 1270, 2400, 19500, 0.35],
  ['SAB', 'Tổng Công ty CP Bia - Rượu - Nước giải khát Sài Gòn', I.FOOD, 47_800, 1282, 3400, 13000, 0.3],
  ['SHB', 'Ngân hàng TMCP Sài Gòn - Hà Nội', I.BANK, 13_250, 4019, 2000, 13000, 0.95],
  ['SSB', 'Ngân hàng TMCP Đông Nam Á', I.BANK, 17_800, 2830, 1900, 15000, 0.35],
  ['SSI', 'Công ty Cổ phần Chứng khoán SSI', I.SEC, 32_650, 1966, 1550, 14000, 0.9],
  ['STB', 'Ngân hàng TMCP Sài Gòn Thương Tín', I.BANK, 44_300, 1885, 5200, 26000, 0.85],
  ['TCB', 'Ngân hàng TMCP Kỹ Thương Việt Nam', I.BANK, 33_900, 7065, 3100, 20000, 0.8],
  ['TPB', 'Ngân hàng TMCP Tiên Phong', I.BANK, 15_950, 2642, 2300, 14500, 0.55],
  ['VCB', 'Ngân hàng TMCP Ngoại thương Việt Nam', I.BANK, 63_800, 8356, 4100, 24000, 0.55],
  ['VHM', 'Công ty Cổ phần Vinhomes', I.RE, 72_400, 4107, 7200, 52000, 0.85],
  ['VIB', 'Ngân hàng TMCP Quốc tế Việt Nam', I.BANK, 19_850, 2979, 2800, 13000, 0.6],
  ['VIC', 'Tập đoàn Vingroup', I.RE, 98_000, 3823, 1100, 40000, 0.75],
  ['VJC', 'Công ty Cổ phần Hàng không VietJet', I.AIR, 101_500, 541, 3000, 32000, 0.35],
  ['VNM', 'Công ty Cổ phần Sữa Việt Nam', I.FOOD, 61_300, 2090, 4300, 13500, 0.6],
  ['VPB', 'Ngân hàng TMCP Việt Nam Thịnh Vượng', I.BANK, 19_600, 7934, 2500, 18500, 0.9],
  ['VRE', 'Công ty Cổ phần Vincom Retail', I.RE, 26_150, 2272, 1900, 16500, 0.6],
  // Ngoài VN30
  ['DGC', 'Công ty Cổ phần Tập đoàn Hoá chất Đức Giang', I.CHEM, 98_600, 380, 8100, 33000, 0.5],
  ['DIG', 'Tổng Công ty CP Đầu tư Phát triển Xây dựng', I.RE, 18_650, 610, 200, 13000, 0.75],
  ['DXG', 'Công ty Cổ phần Tập đoàn Đất Xanh', I.RE, 16_900, 870, 300, 14500, 0.8],
  ['GMD', 'Công ty Cổ phần Gemadept', I.AIR, 55_700, 414, 3000, 25000, 0.4],
  ['HSG', 'Công ty Cổ phần Tập đoàn Hoa Sen', I.STEEL, 17_250, 616, 900, 18000, 0.6],
  ['KBC', 'Tổng Công ty Phát triển Đô thị Kinh Bắc', I.IP, 28_400, 768, 1300, 24000, 0.65],
  ['KDH', 'Công ty CP Đầu tư và Kinh doanh Nhà Khang Điền', I.RE, 31_500, 1010, 900, 15500, 0.45],
  ['NLG', 'Công ty Cổ phần Đầu tư Nam Long', I.RE, 37_600, 385, 1800, 26000, 0.4],
  ['NVL', 'Công ty CP Tập đoàn Đầu tư Địa ốc No Va', I.RE, 11_350, 1950, -2500, 22000, 0.85],
  ['PDR', 'Công ty Cổ phần Phát triển Bất động sản Phát Đạt', I.RE, 19_400, 873, 350, 11500, 0.7],
  ['PNJ', 'Công ty Cổ phần Vàng bạc Đá quý Phú Nhuận', I.RETAIL, 82_300, 338, 6100, 32000, 0.4],
  ['POW', 'Tổng Công ty Điện lực Dầu khí Việt Nam', I.POWER, 12_750, 2342, 500, 13000, 0.6],
  ['REE', 'Công ty Cổ phần Cơ Điện Lạnh', I.POWER, 66_800, 471, 4600, 46000, 0.3],
  ['VHC', 'Công ty Cổ phần Vĩnh Hoàn', I.AGRI, 58_900, 224, 5300, 38000, 0.35],
  ['VND', 'Công ty Cổ phần Chứng khoán VNDIRECT', I.SEC, 15_350, 1521, 900, 12000, 0.8],
  ['VCI', 'Công ty Cổ phần Chứng khoán Vietcap', I.SEC, 36_800, 718, 1200, 16500, 0.55],
  ['HCM', 'Công ty Cổ phần Chứng khoán TP.HCM', I.SEC, 25_650, 720, 1000, 13000, 0.5],
  ['EIB', 'Ngân hàng TMCP Xuất Nhập khẩu Việt Nam', I.BANK, 21_450, 1863, 1500, 13800, 0.55],
  ['MSB', 'Ngân hàng TMCP Hàng Hải Việt Nam', I.BANK, 12_900, 2600, 1900, 13500, 0.5],
  ['DPM', 'Tổng Công ty Phân bón và Hoá chất Dầu khí', I.CHEM, 33_750, 391, 1200, 26000, 0.4],
  ['DCM', 'Công ty Cổ phần Phân bón Dầu khí Cà Mau', I.CHEM, 36_200, 529, 2400, 18000, 0.4],
  ['PVD', 'Tổng Công ty CP Khoan và Dịch vụ Khoan Dầu khí', I.OIL, 22_600, 556, 1300, 31000, 0.5],
  ['PVT', 'Tổng Công ty Cổ phần Vận tải Dầu khí', I.OIL, 25_300, 356, 3000, 25000, 0.35],
  ['FRT', 'Công ty Cổ phần Bán lẻ Kỹ thuật số FPT', I.RETAIL, 168_000, 136, 3500, 22000, 0.25],
  ['CTD', 'Công ty Cổ phần Xây dựng Coteccons', I.CONS, 76_500, 100, 3200, 87000, 0.25],
  ['VCG', 'Tổng Công ty CP Xuất nhập khẩu và Xây dựng Việt Nam', I.CONS, 22_850, 598, 1700, 16000, 0.5],
  ['HHV', 'Công ty CP Đầu tư Hạ tầng Giao thông Đèo Cả', I.CONS, 12_450, 432, 800, 15500, 0.55],
  ['GEX', 'Công ty Cổ phần Tập đoàn GELEX', I.IND, 38_900, 859, 1600, 18000, 0.65],
  ['VIX', 'Công ty Cổ phần Chứng khoán VIX', I.SEC, 13_600, 1529, 1000, 12500, 0.75],
  ['HAG', 'Công ty Cổ phần Hoàng Anh Gia Lai', I.AGRI, 13_950, 1057, 1100, 6500, 0.6],
  ['DBC', 'Công ty Cổ phần Tập đoàn Dabaco Việt Nam', I.AGRI, 27_150, 334, 2300, 22000, 0.4],
  ['VTP', 'Tổng Công ty Cổ phần Bưu chính Viettel', I.AIR, 118_600, 122, 3200, 13000, 0.25],
];

const HNX: Row[] = [
  ['SHS', 'Công ty CP Chứng khoán Sài Gòn - Hà Nội', I.SEC, 13_400, 813, 900, 12500, 0.8],
  ['PVS', 'Tổng Công ty CP Dịch vụ Kỹ thuật Dầu khí Việt Nam', I.OIL, 33_800, 478, 2300, 26000, 0.6],
  ['CEO', 'Công ty Cổ phần Tập đoàn C.E.O', I.RE, 21_700, 515, 500, 11500, 0.55],
  ['IDC', 'Tổng Công ty IDICO', I.IP, 41_500, 330, 5000, 15000, 0.4],
  ['MBS', 'Công ty Cổ phần Chứng khoán MB', I.SEC, 27_600, 572, 1500, 12000, 0.45],
  ['TNG', 'Công ty CP Đầu tư và Thương mại TNG', I.TEXT, 21_900, 123, 2600, 17000, 0.3],
  ['HUT', 'Công ty Cổ phần Tasco', I.CONS, 17_200, 892, 150, 11500, 0.4],
  ['VCS', 'Công ty Cổ phần Vicostone', I.STEEL, 58_300, 160, 5500, 34000, 0.15],
  ['DTD', 'Công ty CP Đầu tư Phát triển Thành Đạt', I.RE, 26_500, 74, 2200, 18000, 0.15],
  ['BVS', 'Công ty CP Chứng khoán Bảo Việt', I.SEC, 33_400, 72, 2000, 25000, 0.2],
  ['NVB', 'Ngân hàng TMCP Quốc Dân', I.BANK, 9_800, 1846, 50, 10000, 0.3],
  ['TIG', 'Công ty CP Tập đoàn Đầu tư Thăng Long', I.RE, 11_600, 180, 400, 12000, 0.3],
  ['LAS', 'Công ty CP Supe Phốt phát và Hoá chất Lâm Thao', I.CHEM, 21_300, 113, 1700, 14000, 0.2],
  ['PLC', 'Tổng Công ty Hoá dầu Petrolimex', I.CHEM, 24_700, 81, 600, 16000, 0.15],
  ['NTP', 'Công ty CP Nhựa Thiếu niên Tiền Phong', I.STEEL, 61_200, 141, 4500, 21000, 0.15],
  ['BAB', 'Ngân hàng TMCP Bắc Á', I.BANK, 11_300, 897, 600, 12500, 0.15],
];

const UPCOM: Row[] = [
  ['ACV', 'Tổng Công ty Cảng hàng không Việt Nam', I.AIR, 108_900, 2177, 4100, 26000, 0.3],
  ['VEA', 'Tổng Công ty Máy động lực và Máy nông nghiệp', I.IND, 41_700, 1329, 4800, 16000, 0.2],
  ['MCH', 'Công ty Cổ phần Hàng tiêu dùng Masan', I.FOOD, 128_400, 727, 7600, 21000, 0.2],
  ['OIL', 'Tổng Công ty Dầu Việt Nam', I.OIL, 11_800, 1034, 300, 10500, 0.35],
  ['QNS', 'Công ty Cổ phần Đường Quảng Ngãi', I.FOOD, 48_600, 368, 6200, 26000, 0.2],
  ['VGI', 'Tổng Công ty CP Đầu tư Quốc tế Viettel', I.TECH, 72_300, 3044, 1100, 11000, 0.25],
  ['FOX', 'Công ty Cổ phần Viễn thông FPT', I.TECH, 61_500, 495, 4000, 15000, 0.15],
  ['ABB', 'Ngân hàng TMCP An Bình', I.BANK, 8_900, 1035, 800, 12000, 0.3],
  ['VGT', 'Tập đoàn Dệt May Việt Nam', I.TEXT, 12_100, 500, 600, 11500, 0.2],
  ['MSR', 'Công ty Cổ phần Masan High-Tech Materials', I.CHEM, 15_800, 1099, -900, 9500, 0.2],
  ['HNG', 'Công ty CP Nông nghiệp Quốc tế Hoàng Anh Gia Lai', I.AGRI, 5_600, 1108, -200, 4500, 0.4],
  ['LTG', 'Công ty CP Tập đoàn Lộc Trời', I.AGRI, 31_200, 80, 1500, 30000, 0.1],
  ['MML', 'Công ty Cổ phần Masan MEATLife', I.FOOD, 45_300, 327, 500, 23000, 0.1],
  ['BVB', 'Ngân hàng TMCP Bản Việt', I.BANK, 12_700, 553, 900, 11800, 0.2],
];

export const VN30 = new Set(HOSE.slice(0, 30).map((r) => r[0]));

function toSeed(exchange: Exchange, rows: Row[]): SeedStock[] {
  return rows.map(([symbol, name, industry, ref, sharesM, eps, bvps, liq]) => ({
    symbol,
    exchange,
    name,
    industry,
    ref,
    sharesM,
    eps,
    bvps,
    liq,
  }));
}

export const SEED_STOCKS: SeedStock[] = [...toSeed('HOSE', HOSE), ...toSeed('HNX', HNX), ...toSeed('UPCOM', UPCOM)];

const HIGH_VOL = new Set<string>([I.RE, I.SEC, I.STEEL, I.CHEM]);
export function volatilityOf(s: SeedStock): number {
  if (HIGH_VOL.has(s.industry)) return 0.026;
  if (s.industry === I.BANK) return 0.017;
  if (s.exchange !== 'HOSE') return 0.024;
  return 0.019;
}

export const INDEX_DEFS = [
  { code: 'VNINDEX', name: 'VN-Index', base: 1_682.45 },
  { code: 'VN30', name: 'VN30', base: 1_826.17 },
  { code: 'HNXINDEX', name: 'HNX-Index', base: 271.38 },
  { code: 'UPCOMINDEX', name: 'UPCOM-Index', base: 108.62 },
] as const;
