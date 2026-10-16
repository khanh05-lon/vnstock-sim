import { useRef, type ReactNode } from 'react';
import { motion, useScroll, useSpring } from 'motion/react';
import { CandlestickChart, PieChart, UserPlus, type LucideIcon } from 'lucide-react';
import { RULES } from '@vss/shared';
import { fmtCapital, Reveal } from './motion';

interface Step {
  icon: LucideIcon;
  title: string;
  body: string;
}

/** Ba bước bắt đầu: cột trái dính khi cuộn, cột phải là dòng thời gian có thanh tiến trình theo cuộn */
export function Steps({ cta }: { cta: ReactNode }) {
  const listRef = useRef<HTMLOListElement>(null);
  const { scrollYProgress } = useScroll({ target: listRef, offset: ['start 75%', 'end 55%'] });
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 24, mass: 0.4 });

  const steps: Step[] = [
    {
      icon: UserPlus,
      title: 'Mở tài khoản',
      body: `Đăng ký bằng email và nhận ngay ${fmtCapital(RULES.initialUsdt)} vốn ảo. Muốn xem trước thì dùng tài khoản demo.`,
    },
    {
      icon: CandlestickChart,
      title: 'Đặt lệnh mua bán',
      body: 'Chọn coin, xem biểu đồ nến và sổ lệnh 20 mức giá, rồi đặt lệnh giới hạn, thị trường, stop-limit hoặc OCO.',
    },
    {
      icon: PieChart,
      title: 'Theo dõi lãi lỗ',
      body: 'Ví, giá vốn bình quân, lịch sử khớp lệnh và báo cáo lãi lỗ theo tháng cập nhật ngay sau mỗi lệnh khớp.',
    },
  ];

  return (
    <section id="bat-dau" className="scroll-mt-20 border-y border-line bg-bg-1 py-20 lg:py-28">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-12 px-4 sm:px-6 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-5">
          <Reveal className="lg:sticky lg:top-28">
            <h2 className="font-display text-[32px] font-bold leading-tight tracking-tight md:text-[42px]">Bắt đầu trong ba bước</h2>
            <p className="mt-4 max-w-[46ch] text-[17px] leading-relaxed text-tx-2">Không nạp tiền, không cài đặt. Chỉ cần một địa chỉ email và trình duyệt.</p>
            <div className="mt-8">{cta}</div>
          </Reveal>
        </div>

        <ol ref={listRef} className="relative flex flex-col gap-12 lg:col-span-7">
          {/* Thanh dọc nối các bước, lấp đầy theo tiến độ cuộn */}
          <div aria-hidden className="absolute bottom-6 left-[23px] top-6 w-px bg-line-2" />
          <motion.div aria-hidden style={{ scaleY: progress }} className="absolute bottom-6 left-[23px] top-6 w-px origin-top bg-brand" />
          {steps.map((s, i) => (
            <li key={s.title}>
              <Reveal delay={i * 0.06} className="relative flex gap-6">
                <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-line-2 bg-bg-0 text-brand">
                  <s.icon size={22} strokeWidth={1.75} />
                </span>
                <div className="pt-1">
                  <h3 className="font-display text-[22px] font-semibold tracking-tight">{s.title}</h3>
                  <p className="mt-2 max-w-[52ch] text-[16px] leading-relaxed text-tx-2">{s.body}</p>
                </div>
              </Reveal>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
