import type { BookLevel, StockInfo } from '@vss/shared';

/** Trạng thái đầy đủ của 1 mã trong bộ nhớ */
export interface StockState {
  info: StockInfo;
  liq: number;
  volatility: number;
  ref: number;
  ceil: number;
  floor: number;
  open: number;
  high: number;
  low: number;
  last: number;
  lastVol: number;
  lastSide: 'B' | 'S';
  volume: number;
  value: number;
  bids: BookLevel[];
  asks: BookLevel[];
  foreignBuy: number;
  foreignSell: number;
  updatedAt: number;
  /** Tham số nội bộ của bộ mô phỏng */
  sim: { fair: number; target: number; bp: number };
}

export interface ProviderTrade {
  symbol: string;
  price: number;
  vol: number;
  side: 'B' | 'S';
  foreign: boolean;
}

export interface ProviderPoll {
  trades: ProviderTrade[];
  /** mã có sổ lệnh thay đổi (kể cả không có giao dịch) */
  touched: string[];
}

/**
 * Nguồn dữ liệu thị trường. MockProvider sinh dữ liệu giả lập; RealProvider (market/vnstock)
 * đệm dữ liệu thật lấy định kỳ từ data-service và trả ra ở mỗi lần poll().
 */
export interface MarketDataProvider {
  readonly name: string;
  /**
   * true khi trạng thái đang lấy từ nguồn thật: MarketService không mô phỏng phần phiên đã qua,
   * không sinh KL khớp ATO/ATC giả và vẫn poll() ngoài phiên liên tục để đồng bộ với nguồn.
   */
  readonly live?: boolean;
  /** Kết nối nguồn (gọi 1 lần trong MarketService.init, trước onNewDay/resume) */
  start?(states: StockState[]): Promise<void>;
  stop?(): void;
  /** Khởi tạo ngày giao dịch mới (giá tham chiếu đã được cập nhật) */
  onNewDay(states: StockState[]): void;
  /** Tiếp tục ngày giao dịch đang dở sau khi khởi động lại */
  resume(states: StockState[]): void;
  /** Lấy các sự kiện thị trường xảy ra trong khoảng dtMs */
  poll(states: StockState[], nowMs: number, dtMs: number): ProviderPoll;
  /** Giá khớp phiên định kỳ (ATO/ATC); 0 = chưa có/không có giá khớp */
  auctionPrice(state: StockState, kind?: 'ATO' | 'ATC'): number;
  /** Dựng lại sổ lệnh sau khi bị lệnh người dùng "ăn" thanh khoản */
  rebuildBook(state: StockState): void;
  /** Giá trị chỉ số thật của ngày giao dịch tradeDate (null → MarketService tự tính theo vốn hoá rổ mã) */
  indexValue?(code: string, tradeDate: string): number | null;
}
