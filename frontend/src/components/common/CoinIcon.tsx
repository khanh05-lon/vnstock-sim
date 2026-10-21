import { useState } from 'react';
import { cn } from '../../lib/format';
import { COIN_ICONS } from './coinIcons.gen';

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

/**
 * Logo thật của tài sản (frontend/public/coins, tải bằng `npm run coins:icons -w backend`);
 * tài sản chưa có logo hoặc ảnh lỗi → chữ cái đầu trong vòng tròn màu.
 * size = "fill": lấp đầy khung cha (khung cha quyết định kích thước).
 */
export function CoinIcon({ asset, size = 24, className }: { asset: string; size?: number | 'fill'; className?: string }) {
  const [broken, setBroken] = useState(false);
  const dim = size === 'fill' ? { width: '100%', height: '100%' } : { width: size, height: size };
  if (COIN_ICONS.has(asset) && !broken) {
    return (
      <span aria-hidden className={cn('relative inline-block shrink-0 select-none overflow-hidden rounded-full', className)} style={dim}>
        {/* đĩa trắng nhỏ hơn logo: logo dạng đồng xu che kín, logo không nền (FET, SUI) vẫn nổi trên nền tối */}
        <span className="absolute inset-[7%] rounded-full bg-white" />
        <img
          src={`${import.meta.env.BASE_URL}coins/${asset}.png`}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
          className="relative block h-full w-full object-cover"
        />
      </span>
    );
  }
  const bg = BRAND[asset] ?? `hsl(${hueOf(asset)} 55% 45%)`;
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-full font-bold text-white', className)}
      style={{ ...dim, background: bg, fontSize: size === 'fill' ? 12 : Math.max(9, Math.round(size * 0.42)) }}
    >
      {asset.slice(0, 1)}
    </span>
  );
}
