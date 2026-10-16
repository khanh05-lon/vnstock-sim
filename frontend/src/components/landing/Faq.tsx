import { useId, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Plus } from 'lucide-react';
import { RULES } from '@vss/shared';
import { cn } from '../../lib/format';
import { EASE, fmtCapital, Reveal } from './motion';

function Item({ q, a, open, onToggle }: { q: string; a: string; open: boolean; onToggle(): void }) {
  const id = useId();
  return (
    <div className="border-b border-line">
      <h3>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={id}
          className="flex w-full items-center justify-between gap-6 py-5 text-left font-display text-[17px] font-semibold transition-colors hover:text-brand"
        >
          {q}
          <Plus size={20} className={cn('shrink-0 text-tx-3 transition-transform duration-300', open && 'rotate-45 text-brand')} />
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={id}
            role="region"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="overflow-hidden"
          >
            <p className="max-w-[65ch] pb-5 text-[16px] leading-relaxed text-tx-2">{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  const items = [
    {
      q: 'Tôi có mất tiền thật không?',
      a: `Không. Mỗi tài khoản nhận ${fmtCapital(RULES.initialUsdt)} vốn ảo, hệ thống không có nạp hay rút tiền hoặc coin thật. Lãi lỗ chỉ tồn tại trong mô phỏng.`,
    },
    {
      q: 'Giá trên bảng là giá thật hay giả lập?',
      a: 'Giá, sổ lệnh và giao dịch lấy thật từ Binance, trễ dưới 1 giây. Nếu mất kết nối, hệ thống tự chuyển sang giá giả lập và hiện nhãn "Giả lập" trên thanh trạng thái.',
    },
    {
      q: 'Lệnh của tôi được khớp như thế nào?',
      a: 'Lệnh khớp với sổ lệnh thật của Binance nhưng không được gửi lên Binance. Lệnh lớn ăn dần nhiều mức giá nên có trượt giá; lệnh chờ khớp ở đúng giá đặt khi thị trường giao dịch qua mức giá đó.',
    },
    {
      q: 'Thua hết vốn ảo thì làm sao?',
      a: 'Vào Cài đặt tài khoản, chọn Đặt lại vốn ảo để bắt đầu lại từ đầu. Lịch sử cũ sẽ được xoá để bạn tập lại chiến lược mới.',
    },
    {
      q: 'Thông tin ở đây có phải khuyến nghị đầu tư không?',
      a: 'Không. Đây là công cụ học tập. Dữ liệu và kết quả mô phỏng không phải lời khuyên mua bán tài sản mã hoá.',
    },
  ];

  return (
    <section id="hoi-dap" className="scroll-mt-20 border-t border-line bg-bg-1 py-20 lg:py-28">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <Reveal>
          <h2 className="font-display text-[32px] font-bold leading-tight tracking-tight md:text-[42px]">Câu hỏi thường gặp</h2>
        </Reveal>
        <Reveal delay={0.06} className="mt-8 border-t border-line">
          {items.map((it, i) => (
            <Item key={it.q} q={it.q} a={it.a} open={open === i} onToggle={() => setOpen(open === i ? null : i)} />
          ))}
        </Reveal>
      </div>
    </section>
  );
}
