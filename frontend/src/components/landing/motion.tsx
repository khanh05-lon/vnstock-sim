import type { ReactNode } from 'react';
import { motion } from 'motion/react';

/** Đường cong chung cho mọi chuyển động của trang giới thiệu */
export const EASE = [0.16, 1, 0.3, 1] as const;

/** Hiện dần khi phần tử cuộn vào khung nhìn (chỉ chạy một lần) */
export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.7, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/** Cuộn mượt tới một mục trong trang (tôn trọng prefers-reduced-motion) */
export function scrollToSection(id: string) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.getElementById(id)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

/** 1_000_000_000 → "1 tỷ đồng" */
export function fmtCapital(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ đồng`;
  return `${(v / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 0 })} triệu đồng`;
}

/** 0.0015 → "0,15%" */
export const fmtRate = (v: number) => `${(v * 100).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%`;
