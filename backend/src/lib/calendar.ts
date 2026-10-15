import type { MarketMode, SessionPhase } from '@vss/shared';

/** Việt Nam: UTC+7, không có giờ mùa hè */
export const VN_OFFSET_MS = 7 * 3600 * 1000;

export interface VnParts {
  date: string; // YYYY-MM-DD theo giờ VN
  minutes: number; // phút trong ngày (0..1439)
  weekday: number; // 0 = CN ... 6 = T7
}

export function vnParts(ms = Date.now()): VnParts {
  const d = new Date(ms + VN_OFFSET_MS);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isWeekend(date: string): boolean {
  const w = weekdayOf(date);
  return w === 0 || w === 6;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Cộng n ngày giao dịch (bỏ T7, CN nếu skipWeekends) */
export function addTradingDays(date: string, n: number, skipWeekends: boolean): string {
  let d = date;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (!skipWeekends || !isWeekend(d)) left--;
  }
  return d;
}

export function prevTradingDay(date: string, skipWeekends: boolean): string {
  let d = addDays(date, -1);
  while (skipWeekends && isWeekend(d)) d = addDays(d, -1);
  return d;
}

/** Mốc thời gian (epoch ms) của 1 thời điểm giờ VN */
export function vnTimeToMs(date: string, minutes: number): number {
  return Date.parse(`${date}T00:00:00Z`) + minutes * 60_000 - VN_OFFSET_MS;
}

/** Lịch phiên HOSE (phút trong ngày, giờ VN) */
export const SESSION = {
  preOpen: 8 * 60 + 30,
  atoStart: 9 * 60,
  continuousStart: 9 * 60 + 15,
  lunchStart: 11 * 60 + 30,
  afternoonStart: 13 * 60,
  atcStart: 14 * 60 + 30,
  putThroughStart: 14 * 60 + 45,
  close: 15 * 60,
};

export function phaseAt(ms: number, mode: MarketMode): SessionPhase {
  if (mode === 'SIMULATED_24_7') return 'CONTINUOUS';
  const { minutes: m, weekday } = vnParts(ms);
  if (weekday === 0 || weekday === 6) return 'CLOSED';
  if (m < SESSION.preOpen) return 'CLOSED';
  if (m < SESSION.atoStart) return 'PRE_OPEN';
  if (m < SESSION.continuousStart) return 'ATO';
  if (m < SESSION.lunchStart) return 'CONTINUOUS';
  if (m < SESSION.afternoonStart) return 'LUNCH';
  if (m < SESSION.atcStart) return 'CONTINUOUS';
  if (m < SESSION.putThroughStart) return 'ATC';
  if (m < SESSION.close) return 'PUT_THROUGH';
  return 'CLOSED';
}

/** Ngày giao dịch hiện hành: chế độ giờ thật lấy phiên gần nhất (trước 8:30 / cuối tuần → phiên trước) */
export function currentTradeDate(ms: number, mode: MarketMode): string {
  const p = vnParts(ms);
  if (mode === 'SIMULATED_24_7') return p.date;
  const weekend = p.weekday === 0 || p.weekday === 6;
  if (!weekend && p.minutes >= SESSION.preOpen) return p.date;
  return prevTradingDay(p.date, true);
}

export const skipWeekendsFor = (mode: MarketMode) => mode === 'REAL_HOURS';
