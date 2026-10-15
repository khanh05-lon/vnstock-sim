import clsx, { type ClassValue } from 'clsx';

export const cn = (...v: ClassValue[]) => clsx(v);

/** Giá hiển thị theo đơn vị nghìn đồng như bảng điện (98500 → 98.50) */
export const fmtPrice = (v?: number | null) => (v ? (v / 1000).toFixed(2) : '');

/** Giá đầy đủ VNĐ (98500 → 98,500) */
export const fmtVnd = (v?: number | null) => (v == null ? '' : Math.round(v).toLocaleString('en-US'));

export const fmtVol = (v?: number | null) => (v ? v.toLocaleString('en-US') : '');

export const fmtInt = (v?: number | null) => (v == null ? '' : v.toLocaleString('en-US'));

export const fmtSigned = (v: number, digits = 2) => `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;

export const fmtPct = (v: number, digits = 2) => `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;

/** Thay đổi giá theo nghìn đồng (+0.90) */
export const fmtChange = (v: number) => (v === 0 ? '0.00' : fmtSigned(v / 1000));

/** Số tiền rút gọn: 1.25 tỷ, 350 tr */
export function fmtCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)} nghìn tỷ`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)} tỷ`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)} tr`;
  return fmtVnd(v);
}

export const fmtBillion = (v: number) => `${(v / 1e9).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

export type Tone = 'ceil' | 'floor' | 'ref' | 'up' | 'down' | 'none';

export function priceTone(price: number, ref: number, ceil: number, floor: number): Tone {
  if (!price) return 'none';
  if (price >= ceil) return 'ceil';
  if (price <= floor) return 'floor';
  if (price === ref) return 'ref';
  return price > ref ? 'up' : 'down';
}

export function signTone(v: number): Tone {
  if (v > 0) return 'up';
  if (v < 0) return 'down';
  return 'ref';
}

export const toneText: Record<Tone, string> = {
  ceil: 'text-ceil',
  floor: 'text-floor',
  ref: 'text-ref',
  up: 'text-up',
  down: 'text-down',
  none: 'text-tx-2',
};

export const toneBg: Record<Tone, string> = {
  ceil: 'bg-ceil',
  floor: 'bg-floor',
  ref: 'bg-ref',
  up: 'bg-up',
  down: 'bg-down',
  none: 'bg-tx-3',
};

export const toneVar: Record<Tone, string> = {
  ceil: 'var(--ceil)',
  floor: 'var(--floor)',
  ref: 'var(--ref)',
  up: 'var(--up)',
  down: 'var(--down)',
  none: 'var(--tx-3)',
};

const VN_OFFSET = 7 * 3600 * 1000;

/** HH:mm:ss theo giờ VN */
export function fmtTimeVN(ms: number | string): string {
  const t = typeof ms === 'string' ? Date.parse(ms) : ms;
  return new Date(t + VN_OFFSET).toISOString().slice(11, 19);
}

/** dd/MM/yyyy HH:mm theo giờ VN */
export function fmtDateTimeVN(ms: number | string): string {
  const t = typeof ms === 'string' ? Date.parse(ms) : ms;
  const iso = new Date(t + VN_OFFSET).toISOString();
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${iso.slice(11, 16)}`;
}

export function fmtDateVN(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

/** YYYY-MM-DD theo giờ VN, lùi n ngày */
export function vnDateISO(daysAgo = 0): string {
  return new Date(Date.now() + VN_OFFSET - daysAgo * 86400_000).toISOString().slice(0, 10);
}

/** Nhập giá dạng "99.5" (nghìn đồng) hoặc "99500" → VNĐ */
export function parsePriceInput(s: string): number | null {
  const clean = s.replace(/,/g, '').trim();
  if (!clean) return null;
  const n = Number(clean);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1000 ? Math.round(n * 1000) : Math.round(n);
}

export function parseIntInput(s: string): number {
  const n = Number(s.replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : 0;
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
