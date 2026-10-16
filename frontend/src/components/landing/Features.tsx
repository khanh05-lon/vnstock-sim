import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BellRing, Landmark, Trophy } from 'lucide-react';
import { RULES, type Exchange } from '@vss/shared';
import { cn, fmtPct, priceTone, signTone, toneText, toneVar } from '../../lib/format';
import { useSystemStatus } from '../../lib/admin';
import { useLeaderboard } from '../../lib/queries';
import { useMarket } from '../../store/market';
import { fmtRate, Reveal } from './motion';

/*
 * Bento 5 ô: hàng 1-2 [A A B] [A A C], hàng 3 [D E E].
 * Bo góc thống nhất toàn trang: khối nội dung 16px (rounded-2xl), nút 12px (rounded-xl), nhãn nhỏ 6px (rounded-md).
 */

function Cell({ className, children, delay = 0 }: { className?: string; children: ReactNode; delay?: number }) {
  return (
    <Reveal delay={delay} className={cn('relative flex flex-col overflow-hidden rounded-2xl border border-line p-6', className)}>
      {children}
    </Reveal>
  );
}

function CellTitle({ children }: { children: ReactNode }) {
  return <h3 className="font-display text-[20px] font-semibold leading-snug tracking-tight">{children}</h3>;
}

/** Bản đồ nhiệt rổ VN30 từ dữ liệu realtime */
function Vn30Heat() {
  const rows = useMarket((s) => s.rows);
  const list = useMemo(
    () =>
      Object.values(rows)
        .filter((r) => r.isVn30)
        .sort((a, b) => a.symbol.localeCompare(b.symbol)),
    [rows],
  );
  if (!list.length) {
    return (
      <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-6">
        {Array.from({ length: 30 }, (_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-md bg-bg-3" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-6">
      {list.map((r) => {
        const traded = r.volume > 0;
        const tone = traded ? priceTone(r.last, r.ref, r.ceil, r.floor) : 'ref';
        const strength = Math.round(14 + Math.min(Math.abs(r.changePct) / 4, 1) * 46);
        return (
          <Link
            key={r.symbol}
            to={`/trade/${r.symbol}`}
            className="flex h-14 flex-col items-center justify-center rounded-md transition-transform duration-200 hover:-translate-y-0.5"
            style={{ background: `color-mix(in srgb, ${toneVar[tone]} ${strength}%, var(--bg-2))` }}
            title={r.name}
          >
            <span className="text-[12px] font-bold text-tx-1">{r.symbol}</span>
            <span className="num text-[11px] font-medium text-tx-1/75">{fmtPct(r.changePct)}</span>
          </Link>
        );
      })}
    </div>
  );
}

function OrderTypes() {
  const venues: Exchange[] = ['HOSE', 'HNX', 'UPCOM'];
  return (
    <div className="mt-5 flex flex-col gap-3">
      {venues.map((ex) => (
        <div key={ex} className="flex flex-wrap items-center gap-1.5">
          <span className="w-16 text-[12px] font-semibold text-tx-3">{ex}</span>
          {RULES.orderTypes[ex].map((t) => (
            <span key={t} className="chip rounded-md bg-bg-3 text-tx-1">
              {t}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

function TopMovers() {
  const rows = useMarket((s) => s.rows);
  const top = useMemo(
    () =>
      Object.values(rows)
        .filter((r) => r.type === 'STOCK' && r.volume > 0)
        .sort((a, b) => b.changePct - a.changePct)
        .slice(0, 3),
    [rows],
  );
  return (
    <div className="mt-5 rounded-xl bg-bg-2 p-3">
      <div className="mb-2 text-[12px] text-tx-3">Tăng mạnh nhất lúc này</div>
      {top.length ? (
        <ul className="flex flex-col gap-1.5">
          {top.map((r) => {
            const tone = priceTone(r.last, r.ref, r.ceil, r.floor);
            return (
              <li key={r.symbol} className="flex items-center justify-between text-[13px]">
                <span className="font-semibold">{r.symbol}</span>
                <span className={cn('num font-medium', toneText[tone])}>{fmtPct(r.changePct)}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="h-4 animate-pulse rounded bg-bg-3" />
          ))}
        </div>
      )}
    </div>
  );
}

/** Top 3 bảng xếp hạng 30 ngày (dữ liệu thật từ máy chủ) */
function LeaderTop() {
  const { data, isLoading, isError } = useLeaderboard('1M');
  const top = data?.rows.slice(0, 3) ?? [];
  return (
    <div className="self-end rounded-xl border border-line bg-bg-1 p-4">
      <div className="mb-3 text-[12px] text-tx-3">Dẫn đầu 30 ngày qua</div>
      {isLoading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="h-5 animate-pulse rounded bg-bg-3" />
          ))}
        </div>
      ) : isError || !top.length ? (
        <p className="text-[13px] leading-relaxed text-tx-2">Chưa có ai trên bảng xếp hạng. Đặt lệnh đầu tiên để ghi tên mình.</p>
      ) : (
        <ol className="flex flex-col gap-2.5">
          {top.map((r) => (
            <li key={r.rank} className="flex items-center gap-3 text-[14px]">
              <span
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[12px] font-bold',
                  r.rank === 1 ? 'bg-brand text-brand-ink' : 'bg-bg-3 text-tx-2',
                )}
              >
                {r.rank}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
              <span className={cn('num font-semibold', toneText[signTone(r.returnPct)])}>{fmtPct(r.returnPct)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function Features() {
  // Tải trạng thái hệ thống để tham số (lãi vay, tỷ lệ ký quỹ) phản ánh bản quản trị viên đã chỉnh
  useSystemStatus();
  const total = useMarket((s) => s.symbols.length);
  const m = RULES.margin;
  return (
    <section id="tinh-nang" className="scroll-mt-20 py-20 lg:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <Reveal className="max-w-2xl">
          <h2 className="font-display text-[32px] font-bold leading-tight tracking-tight md:text-[42px]">Đủ công cụ để luyện như nhà đầu tư thật</h2>
          <p className="mt-4 max-w-[60ch] text-[17px] leading-relaxed text-tx-2">
            Từ bảng điện, sổ lệnh đến ký quỹ và báo cáo lãi lỗ, mọi thứ vận hành theo quy tắc của sàn Việt Nam.
          </p>
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Cell className="bg-bg-1 md:col-span-2 lg:row-span-2">
            <CellTitle>Bảng giá nhảy theo từng lệnh khớp</CellTitle>
            <p className="mt-2 max-w-[52ch] text-tx-2">
              Giá, khối lượng, dư mua và dư bán của {total || 'hơn 90'} mã cập nhật liên tục. Bấm vào một mã để mở màn hình đặt lệnh.
            </p>
            <div className="mt-6 flex-1">
              <Vn30Heat />
            </div>
            <Link to="/bang-gia" className="group mt-5 inline-flex items-center gap-1.5 self-start text-[14px] font-semibold text-brand">
              Xem bảng giá <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Cell>

          <Cell className="bg-bg-1" delay={0.08}>
            <CellTitle>Đặt lệnh đúng luật từng sàn</CellTitle>
            <p className="mt-2 text-tx-2">Mỗi sàn chỉ nhận các loại lệnh được phép, kiểm tra bước giá và biên độ trước khi gửi.</p>
            <OrderTypes />
          </Cell>

          <Cell
            className="border-brand/25"
            delay={0.14}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{ background: 'linear-gradient(140deg, color-mix(in srgb, var(--brand) 16%, var(--bg-1)) 0%, var(--bg-1) 70%)' }}
            />
            <div className="relative">
              <Landmark size={22} className="text-brand" strokeWidth={1.75} />
              <CellTitle>
                <span className="mt-4 block">Ký quỹ và tiền về T+2</span>
              </CellTitle>
              <p className="mt-2 text-tx-2">
                Vay ký quỹ lãi {fmtRate(m.interestRateYear)} mỗi năm. Hệ thống cảnh báo khi tỷ lệ tài sản ròng xuống dưới {fmtRate(m.callRatio)}.
              </p>
              <div className="mt-5 flex items-baseline gap-2">
                <span className="num font-display text-[40px] font-bold leading-none">{fmtRate(m.initialRatio)}</span>
                <span className="text-[13px] text-tx-3">tỷ lệ ký quỹ ban đầu</span>
              </div>
            </div>
          </Cell>

          <Cell className="bg-bg-1" delay={0.06}>
            <BellRing size={22} className="text-brand" strokeWidth={1.75} />
            <div className="mt-4">
              <CellTitle>Bộ lọc và cảnh báo giá</CellTitle>
            </div>
            <p className="mt-2 text-tx-2">Lọc cổ phiếu theo P/E, vốn hoá, thanh khoản. Đặt cảnh báo giá để không lỡ điểm mua.</p>
            <TopMovers />
          </Cell>

          <Cell className="bg-bg-2 md:col-span-1 lg:col-span-2" delay={0.12}>
            <div className="grid h-full grid-cols-1 gap-6 sm:grid-cols-2 sm:gap-8">
              <div className="flex flex-col">
                <Trophy size={22} className="text-brand" strokeWidth={1.75} />
                <div className="mt-4">
                  <CellTitle>Đua hạng cùng nhà đầu tư khác</CellTitle>
                </div>
                <p className="mt-2 text-tx-2">Bảng xếp hạng lợi nhuận theo 7 ngày, 30 ngày, 3 tháng và từ đầu.</p>
                <Link to="/xep-hang" className="group mt-auto inline-flex items-center gap-1.5 self-start pt-5 text-[14px] font-semibold text-brand">
                  Xem bảng xếp hạng <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>
              <LeaderTop />
            </div>
          </Cell>
        </div>
      </div>
    </section>
  );
}
