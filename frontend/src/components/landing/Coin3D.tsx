import type { CSSProperties } from 'react';
import { cn } from '../../lib/format';

/** Mặt đồng xu: đĩa đồng thau, vành nổi, lỗ vuông khoét thủng (nhìn xuyên qua được) */
function Face({ top, bottom }: { top: string; bottom: string }) {
  return (
    <svg viewBox="0 0 200 200" className="h-full w-full" aria-hidden>
      <path fillRule="evenodd" d="M100 2a98 98 0 1 1 0 196a98 98 0 1 1 0-196zM78 78v44h44V78z" fill="#c69653" />
      {/* vành ngoài và khung quanh lỗ: một bậc tông đậm hơn, phẳng */}
      <path fillRule="evenodd" d="M100 2a98 98 0 1 1 0 196a98 98 0 1 1 0-196zM100 14a86 86 0 1 0 0 172a86 86 0 1 0 0-172z" fill="#a77a3f" />
      <path fillRule="evenodd" d="M70 70h60v60H70zM78 78v44h44V78z" fill="#a77a3f" />
      <text x="100" y="56" textAnchor="middle" fontFamily="Be Vietnam Pro, sans-serif" fontWeight="800" fontSize="26" fill="#4a3212">
        {top}
      </text>
      <text x="100" y="164" textAnchor="middle" fontFamily="Be Vietnam Pro, sans-serif" fontWeight="800" fontSize="22" letterSpacing="1" fill="#4a3212">
        {bottom}
      </text>
    </svg>
  );
}

const EDGES = 40;

/**
 * Đồng xu VNCoin dựng bằng CSS 3D: hai mặt + 40 dải viền. Mặt trước tên sàn, mặt sau số vốn ảo mỗi tài khoản nhận.
 * `spin` quay liên tục quanh trục dọc (tắt khi người dùng giảm chuyển động).
 */
export function Coin3D({
  size = 260,
  thickness = 22,
  spin = true,
  back = ['10.000', 'USDT'],
  className,
  style,
}: {
  size?: number;
  thickness?: number;
  spin?: boolean;
  back?: [string, string];
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={cn('coin3d', spin && 'coin3d-spin', className)} style={{ '--d': `${size}px`, '--t': `${thickness}px`, '--n': EDGES, ...style } as CSSProperties}>
      <div className="face front">
        <Face top="VN" bottom="COIN" />
      </div>
      <div className="face back">
        <Face top={back[0]} bottom={back[1]} />
      </div>
      {Array.from({ length: EDGES }, (_, i) => (
        <div key={i} className="edge" style={{ '--i': i } as CSSProperties} />
      ))}
    </div>
  );
}
