import clsx, { type ClassValue } from 'clsx';
import { Big, decimalsOf, type Dec } from '@vss/shared';

export const cn = (...v: ClassValue[]) => clsx(v);

/*
 * Định dạng số kiểu sàn coin (Binance): dấu phẩy ngăn hàng nghìn, dấu chấm thập phân.
 * Giá / khối lượng hiển thị đúng số chữ số lẻ của bước giá (tickSize) / bước khối lượng (stepSize).
 */

const nf = new Map<string, Intl.NumberFormat>();
function formatter(min: number, max: number) {
  const key = `${min}:${max}`;
  let f = nf.get(key);
  if (!f) nf.set(key, (f = new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max })));
  return f;
}

/** Số chữ số lẻ hiển thị cho giá khi chưa biết tickSize: giá càng nhỏ càng nhiều chữ số */
export function autoDp(price: number): number {
  const a = Math.abs(price);
  if (a >= 1000) return 2;
  if (a >= 1) return 4;
  if (a >= 0.01) return 6;
  return 8;
}

/** Giá theo tickSize ("0.01" → 2 chữ số): 82035.1 → "82,035.10" */
export function fmtPrice(v: Dec | number | null | undefined, tick?: Dec): string {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const dp = tick ? decimalsOf(tick) : autoDp(n);
  // Định dạng chuỗi để không mất chữ số lẻ của giá rất nhỏ (PEPE 0.00000409)
  if (dp > 8) return new Big(v).toFixed(dp);
  // Có tickSize: cố định số chữ số lẻ như sàn; không có: bỏ số 0 thừa (tối thiểu 2 chữ số)
  return formatter(tick ? dp : Math.min(2, dp), dp).format(n);
}

/** Khối lượng theo stepSize (tối đa 8 chữ số lẻ, bỏ số 0 thừa nếu không có step) */
export function fmtQty(v: Dec | number | null | undefined, step?: Dec): string {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  if (step) {
    // Làm tròn xuống (như Binance): không hiển thị nhiều hơn số coin thực có
    const dp = decimalsOf(step);
    return formatter(dp, dp).format(Number(new Big(v).round(dp, Big.roundDown).toFixed()));
  }
  return formatter(0, 8).format(n);
}

/** Số tiền USDT: 2 chữ số lẻ (số nhỏ hơn 1 hiện tới 6 chữ số) */
export function fmtUsd(v: Dec | number | null | undefined, dp?: number): string {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const d = dp ?? (Math.abs(n) > 0 && Math.abs(n) < 1 ? 6 : 2);
  return formatter(d === 6 ? 2 : d, d).format(n);
}

/** Số rút gọn: 1.23B, 456.70M, 12.30K */
export function fmtCompact(v: Dec | number): string {
  const n = Number(v);
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return formatter(0, 2).format(n);
}

/** Số nguyên có dấu phẩy ngăn hàng nghìn */
export const fmtInt = (v: number | null | undefined) => (v == null ? '' : Math.round(v).toLocaleString('en-US'));

export const fmtPct = (v: number, digits = 2) =>`${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;

export const fmtSigned = (v: number, digits = 2) => `${v > 0 ? '+' : ''}${formatter(digits, digits).format(v)}`;

export type Tone = 'up' | 'down' | 'flat';

export function signTone(v: number | Dec): Tone {
  const n = Number(v);
  if (n > 0) return 'up';
  if (n < 0) return 'down';
  return 'flat';
}

export const toneText: Record<Tone, string> = { up: 'text-up', down: 'text-down', flat: 'text-tx-2' };
export const toneBg: Record<Tone, string> = { up: 'bg-up', down: 'bg-down', flat: 'bg-tx-3' };
export const toneVar: Record<Tone, string> = { up: 'var(--up)', down: 'var(--down)', flat: 'var(--tx-3)' };

/** HH:mm:ss theo giờ máy người dùng */
export function fmtTime(ms: number | string): string {
  const d = new Date(typeof ms === 'string' ? Date.parse(ms) : ms);
  return d.toLocaleTimeString('vi-VN', { hour12: false });
}

/** dd/MM/yyyy HH:mm theo giờ máy người dùng */
export function fmtDateTime(ms: number | string): string {
  const d = new Date(typeof ms === 'string' ? Date.parse(ms) : ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDate(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

/** YYYY-MM-DD (giờ máy), lùi n ngày */
export function dateISO(daysAgo = 0): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Ô nhập số thập phân: bỏ dấu phẩy, chỉ giữ chữ số và 1 dấu chấm; "" nếu không hợp lệ */
export function cleanDecimal(s: string): string {
  const t = s.replace(/,/g, '').replace(/[^\d.]/g, '');
  const i = t.indexOf('.');
  return i < 0 ? t : `${t.slice(0, i + 1)}${t.slice(i + 1).replace(/\./g, '')}`;
}

/** Chuỗi số dương hợp lệ để gửi API (bỏ "." ở cuối) */
export function decOrNull(s: string): string | null {
  const t = cleanDecimal(s).replace(/\.$/, '');
  return t && Number(t) > 0 && /^\d+(\.\d+)?$/.test(t) ? t : null;
}

export function downloadCsv(filename: string, header: string[], rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '﻿' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
