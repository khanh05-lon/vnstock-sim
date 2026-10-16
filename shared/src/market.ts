/* ===================== Dữ liệu thị trường (Spot) ===================== */

import type { Dec } from './decimal';

/** Trạng thái cặp giao dịch: TRADING đang giao dịch, HALT tạm ngừng (quản trị viên / nguồn báo), BREAK ngừng hẳn */
export type SymbolStatus = 'TRADING' | 'HALT' | 'BREAK';

/**
 * Bộ lọc giao dịch của cặp — cùng ý nghĩa với Binance exchangeInfo:
 * PRICE_FILTER, LOT_SIZE, MARKET_LOT_SIZE, NOTIONAL, PERCENT_PRICE_BY_SIDE, MAX_NUM_ORDERS, MAX_NUM_ALGO_ORDERS.
 * Giá trị "0" = không giới hạn.
 */
export interface SymbolFilters {
  tickSize: Dec;
  minPrice: Dec;
  maxPrice: Dec;
  stepSize: Dec;
  minQty: Dec;
  maxQty: Dec;
  /** Giới hạn khối lượng riêng cho lệnh MARKET ("0" = dùng LOT_SIZE) */
  marketMaxQty: Dec;
  minNotional: Dec;
  maxNotional: Dec;
  applyMinToMarket: boolean;
  applyMaxToMarket: boolean;
  /** Giá mua trong [avg × bidDown, avg × bidUp]; giá bán trong [avg × askDown, avg × askUp] */
  bidMultiplierUp: Dec;
  bidMultiplierDown: Dec;
  askMultiplierUp: Dec;
  askMultiplierDown: Dec;
  maxNumOrders: number;
  maxNumAlgoOrders: number;
}

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  /** Tên đầy đủ của tài sản cơ sở (Bitcoin, Ethereum...) */
  name: string;
  status: SymbolStatus;
  filters: SymbolFilters;
  sortOrder: number;
}

/** Thống kê 24 giờ trượt (rolling) — như ticker/24hr của Binance */
export interface Ticker24h {
  symbol: string;
  last: Dec;
  open: Dec;
  high: Dec;
  low: Dec;
  /** last − open */
  change: Dec;
  /** % thay đổi 24h (number, chỉ để hiển thị / sắp xếp) */
  changePct: number;
  /** Khối lượng theo tài sản cơ sở */
  volume: Dec;
  /** Khối lượng theo tài sản định giá (USDT) */
  quoteVolume: Dec;
  bid: Dec;
  ask: Dec;
  updatedAt: number;
}

export type SymbolRow = SymbolInfo & Ticker24h;

/** Một mức giá của sổ lệnh: [giá, khối lượng] (như Binance) */
export type BookLevel = [Dec, Dec];

export interface DepthSnapshot {
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  ts: number;
}

export interface TradeTick {
  id: number;
  symbol: string;
  price: Dec;
  qty: Dec;
  time: number;
  /** true = bên mua là maker (lệnh bán chủ động, hiển thị màu đỏ) */
  buyerMaker: boolean;
}

export type KlineInterval = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w' | '1M';
export const KLINE_INTERVALS: KlineInterval[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'];

/** Nến (số thực, chỉ dùng hiển thị) — time = epoch giây UTC lúc mở nến */
export interface Kline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** LIVE = dữ liệu thật từ Binance; SIM = giả lập (mất kết nối hoặc chạy offline) */
export type FeedKind = 'LIVE' | 'SIM';

export interface MarketStatus {
  feed: FeedKind;
  source: 'binance' | 'sim';
  serverTime: number;
}

/** Tên đầy đủ của các tài sản phổ biến */
export const ASSET_NAMES: Record<string, string> = {
  USDT: 'TetherUS',
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  BNB: 'BNB',
  SOL: 'Solana',
  XRP: 'XRP',
  DOGE: 'Dogecoin',
  ADA: 'Cardano',
  TRX: 'TRON',
  AVAX: 'Avalanche',
  LINK: 'Chainlink',
  DOT: 'Polkadot',
  TON: 'Toncoin',
  SUI: 'Sui',
  NEAR: 'NEAR Protocol',
  LTC: 'Litecoin',
  BCH: 'Bitcoin Cash',
  UNI: 'Uniswap',
  AAVE: 'Aave',
  ATOM: 'Cosmos',
  APT: 'Aptos',
  ARB: 'Arbitrum',
  OP: 'Optimism',
  INJ: 'Injective',
  FIL: 'Filecoin',
  PEPE: 'Pepe',
  SHIB: 'Shiba Inu',
  WLD: 'Worldcoin',
  FET: 'Artificial Superintelligence Alliance',
  HBAR: 'Hedera',
  ETC: 'Ethereum Classic',
};
