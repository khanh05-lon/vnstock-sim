import { cn } from '../../lib/format';

/** Màu nhận diện quen thuộc của một số coin lớn; còn lại sinh màu ổn định theo mã */
const BRAND: Record<string, string> = {
  BTC: '#f7931a',
  ETH: '#627eea',
  BNB: '#f0b90b',
  SOL: '#9945ff',
  XRP: '#23292f',
  DOGE: '#c2a633',
  ADA: '#0033ad',
  TRX: '#ef0027',
  AVAX: '#e84142',
  LINK: '#2a5ada',
  DOT: '#e6007a',
  TON: '#0098ea',
  LTC: '#345d9d',
  USDT: '#26a17b',
  SHIB: '#ffa409',
  PEPE: '#3d8130',
};

function hueOf(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** Biểu tượng tài sản dạng chữ cái đầu trong vòng tròn màu (không phụ thuộc ảnh bên ngoài) */
export function CoinIcon({ asset, size = 24, className }: { asset: string; size?: number; className?: string }) {
  const bg = BRAND[asset] ?? `hsl(${hueOf(asset)} 55% 45%)`;
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-full font-bold text-white', className)}
      style={{ width: size, height: size, background: bg, fontSize: Math.max(9, Math.round(size * 0.42)) }}
    >
      {asset.slice(0, asset.length > 4 ? 1 : 2).slice(0, 1)}
    </span>
  );
}
