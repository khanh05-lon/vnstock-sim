import '@fontsource/be-vietnam-pro/400.css';
import '@fontsource/be-vietnam-pro/500.css';
import '@fontsource/be-vietnam-pro/600.css';
import '@fontsource/be-vietnam-pro/700.css';
import '@fontsource/be-vietnam-pro/800.css';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MotionConfig, motion, useMotionValueEvent, useScroll } from 'motion/react';
import { ArrowRight, Menu, Moon, Sun, X } from 'lucide-react';
import { PHASE_LABEL, RULES } from '@vss/shared';
import { LiveTicker } from '../components/auth/AuthFrame';
import { Faq } from '../components/landing/Faq';
import { Features } from '../components/landing/Features';
import { LivePreview } from '../components/landing/LivePreview';
import { EASE, fmtCapital, Reveal, scrollToSection } from '../components/landing/motion';
import { Rules } from '../components/landing/Rules';
import { Steps } from '../components/landing/Steps';
import { Logo } from '../components/layout/Header';
import { useSystemStatus } from '../lib/admin';
import { cn } from '../lib/format';
import { useAuth } from '../store/auth';
import { useMarket } from '../store/market';
import { useUi } from '../store/ui';

const SECTIONS = [
  { id: 'tinh-nang', label: 'Tính năng' },
  { id: 'bat-dau', label: 'Bắt đầu' },
  { id: 'luat-choi', label: 'Luật chơi' },
  { id: 'hoi-dap', label: 'Hỏi đáp' },
];

/* Mỗi ý định chỉ một nhãn trên toàn trang: "Mở tài khoản" (đăng ký), "Xem bảng giá", "Đăng nhập". */

function PrimaryCta({ className }: { className?: string }) {
  const loggedIn = useAuth((s) => !!s.token);
  return (
    <Link
      to={loggedIn ? '/trade' : '/register'}
      className={cn(
        'group inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-brand px-6 text-[15px] font-semibold text-brand-ink transition-[background-color,transform] duration-200 hover:bg-brand-2 active:scale-[0.98]',
        className,
      )}
    >
      {loggedIn ? 'Vào giao dịch' : 'Mở tài khoản'}
      <ArrowRight size={18} className="transition-transform duration-200 group-hover:translate-x-0.5" />
    </Link>
  );
}

function SecondaryCta({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex h-12 items-center justify-center whitespace-nowrap rounded-xl border border-line-2 bg-bg-1/60 px-6 text-[15px] font-semibold text-tx-1 transition-[background-color,transform] duration-200 hover:bg-bg-3 active:scale-[0.98]"
    >
      {children}
    </Link>
  );
}

function ThemeToggle() {
  const theme = useUi((s) => s.theme);
  const toggle = useUi((s) => s.toggleTheme);
  return (
    <button
      type="button"
      onClick={toggle}
      className="rounded-xl p-2.5 text-tx-2 transition-colors hover:bg-bg-3 hover:text-tx-1"
      aria-label={theme === 'dark' ? 'Chuyển giao diện sáng' : 'Chuyển giao diện tối'}
    >
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

function LandingNav() {
  const loggedIn = useAuth((s) => !!s.token);
  const [menu, setMenu] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { scrollY } = useScroll();
  useMotionValueEvent(scrollY, 'change', (y) => {
    const next = y > 8;
    if (next !== scrolled) setScrolled(next);
  });

  const go = (id: string) => {
    // Đóng menu trước rồi mới cuộn, để khoảng cách không bị lệch khi menu thu lại
    setMenu(false);
    requestAnimationFrame(() => scrollToSection(id));
  };

  return (
    <header
      className={cn(
        'sticky top-0 z-30 border-b backdrop-blur-xl transition-colors duration-300',
        scrolled || menu ? 'border-line bg-bg-0/85' : 'border-transparent bg-bg-0/40',
      )}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Logo />
        <nav className="hidden flex-1 items-center gap-1 md:flex" aria-label="Các mục trong trang">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              onClick={(e) => {
                e.preventDefault();
                go(s.id);
              }}
              className="rounded-lg px-3 py-2 text-[14px] font-medium text-tx-2 transition-colors hover:text-tx-1"
            >
              {s.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <ThemeToggle />
          {!loggedIn && (
            <Link to="/login" className="hidden rounded-xl px-4 py-2.5 text-[14px] font-semibold text-tx-1 transition-colors hover:bg-bg-3 sm:inline-flex">
              Đăng nhập
            </Link>
          )}
          <span className="hidden sm:block">
            <PrimaryCta className="h-10 px-4 text-[14px]" />
          </span>
          <button
            type="button"
            className="rounded-xl p-2.5 text-tx-1 hover:bg-bg-3 md:hidden"
            onClick={() => setMenu((v) => !v)}
            aria-expanded={menu}
            aria-label={menu ? 'Đóng menu' : 'Mở menu'}
          >
            {menu ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>
      {menu && (
        <motion.nav
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: EASE }}
          className="border-t border-line px-4 pb-5 pt-2 md:hidden"
          aria-label="Các mục trong trang"
        >
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              onClick={(e) => {
                e.preventDefault();
                go(s.id);
              }}
              className="block rounded-lg px-2 py-3 text-[16px] font-medium text-tx-1"
            >
              {s.label}
            </a>
          ))}
          <div className="mt-3 grid grid-cols-2 gap-2">
            {!loggedIn && (
              <Link to="/login" className="inline-flex h-12 items-center justify-center rounded-xl border border-line-2 text-[15px] font-semibold">
                Đăng nhập
              </Link>
            )}
            <PrimaryCta className={loggedIn ? 'col-span-2' : ''} />
          </div>
        </motion.nav>
      )}
    </header>
  );
}

function SessionPill() {
  const session = useMarket((s) => s.session);
  const connected = useMarket((s) => s.connected);
  const open = session?.phase === 'CONTINUOUS' || session?.phase === 'ATO' || session?.phase === 'ATC';
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line-2 bg-bg-1/70 px-3 py-1.5 text-[13px] text-tx-2">
      <span className={cn('h-2 w-2 rounded-full', !connected ? 'bg-tx-3' : open ? 'bg-up pulse-dot' : 'bg-ref')} aria-hidden />
      {session ? `${PHASE_LABEL[session.phase]}, ${session.feed === 'LIVE' ? 'giá thị trường thật' : 'giá mô phỏng'}` : 'Đang kết nối thị trường'}
    </span>
  );
}

function Hero() {
  const item = (i: number) => ({
    initial: { opacity: 0, y: 20 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.8, delay: 0.08 + i * 0.08, ease: EASE },
  });
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(55% 60% at 78% 40%, color-mix(in srgb, var(--brand) 13%, transparent) 0%, transparent 70%), radial-gradient(40% 40% at 10% 0%, color-mix(in srgb, var(--brand) 6%, transparent) 0%, transparent 70%)',
        }}
      />
      <div className="relative mx-auto grid max-w-7xl grid-cols-1 items-center gap-12 px-4 pb-16 pt-10 sm:px-6 lg:min-h-[calc(100dvh-6.5rem)] lg:grid-cols-12 lg:gap-10 lg:pb-20 lg:pt-12">
        <div className="lg:col-span-6">
          <motion.div {...item(0)}>
            <SessionPill />
          </motion.div>
          <motion.h1
            {...item(1)}
            className="mt-6 font-display text-[40px] font-bold leading-[1.1] tracking-tight sm:text-[52px] lg:text-[60px]"
          >
            Tập đầu tư với <span className="whitespace-nowrap text-brand">{fmtCapital(RULES.initialCapital)}</span> vốn ảo
          </motion.h1>
          <motion.p {...item(2)} className="mt-6 max-w-[34rem] text-[18px] leading-relaxed text-tx-2">
            Bảng giá realtime, đặt lệnh như trên sàn HOSE, HNX, UPCOM. Sai thì rút kinh nghiệm, không mất tiền thật.
          </motion.p>
          <motion.div {...item(3)} className="mt-9 flex flex-col gap-3 sm:flex-row">
            <PrimaryCta />
            <SecondaryCta to="/bang-gia">Xem bảng giá</SecondaryCta>
          </motion.div>
        </div>
        <motion.div
          initial={{ opacity: 0, y: 32, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 1, delay: 0.25, ease: EASE }}
          className="lg:col-span-6 lg:pl-6"
        >
          <LivePreview />
        </motion.div>
      </div>
    </section>
  );
}

function Stats() {
  const total = useMarket((s) => s.symbols.length);
  const orderTypes = new Set(Object.values(RULES.orderTypes).flat());
  const stats = [
    { value: total ? String(total) : '...', label: 'mã cổ phiếu, ETF, chứng quyền và trái phiếu' },
    { value: '3', label: 'sàn giao dịch HOSE, HNX và UPCOM' },
    { value: String(orderTypes.size), label: `loại lệnh: ${[...orderTypes].join(', ')}` },
    { value: '24/7', label: 'thị trường mô phỏng luôn mở để bạn luyện tập' },
  ];
  return (
    <section className="py-16 lg:py-20">
      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-x-6 gap-y-10 px-4 sm:px-6 lg:grid-cols-4">
        {stats.map((s, i) => (
          <Reveal key={s.label} delay={i * 0.06} className="lg:border-l lg:border-line lg:pl-8 lg:first:border-l-0 lg:first:pl-0">
            <div className="num font-display text-[44px] font-bold leading-none tracking-tight lg:text-[56px]">{s.value}</div>
            <p className="mt-3 max-w-[24ch] text-[15px] leading-snug text-tx-2">{s.label}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  const loggedIn = useAuth((s) => !!s.token);
  return (
    <section className="py-20 lg:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <Reveal className="relative overflow-hidden rounded-2xl border border-brand/25 bg-bg-1 px-6 py-14 sm:px-12 lg:py-20">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(70% 90% at 100% 100%, color-mix(in srgb, var(--brand) 18%, transparent) 0%, transparent 65%)' }}
          />
          <div className="relative max-w-2xl">
            <h2 className="font-display text-[32px] font-bold leading-tight tracking-tight md:text-[46px]">
              {loggedIn ? 'Thị trường đang chạy, vào đặt lệnh thôi' : 'Sẵn sàng đặt lệnh đầu tiên?'}
            </h2>
            <p className="mt-4 max-w-[52ch] text-[17px] leading-relaxed text-tx-2">
              {loggedIn
                ? 'Danh mục, lệnh chờ và cảnh báo giá của bạn vẫn đang được cập nhật.'
                : `Mở tài khoản miễn phí, nhận ${fmtCapital(RULES.initialCapital)} vốn ảo và giao dịch ngay hôm nay.`}
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <PrimaryCta />
              {!loggedIn && <SecondaryCta to="/login">Dùng tài khoản demo</SecondaryCta>}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Footer() {
  const product = [
    { to: '/bang-gia', label: 'Bảng giá' },
    { to: '/trade', label: 'Giao dịch' },
    { to: '/market', label: 'Thị trường' },
    { to: '/bo-loc', label: 'Bộ lọc' },
    { to: '/xep-hang', label: 'Xếp hạng' },
  ];
  const legal = [
    { to: '/dieu-khoan', label: 'Điều khoản sử dụng' },
    { to: '/chinh-sach-bao-mat', label: 'Chính sách bảo mật' },
  ];
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-10 px-4 py-14 sm:px-6 md:grid-cols-12">
        <div className="md:col-span-6">
          <Logo />
          <p className="mt-4 max-w-[46ch] text-[14px] leading-relaxed text-tx-3">
            Sàn giao dịch chứng khoán Việt Nam mô phỏng, phục vụ học tập. Dữ liệu và kết quả không phải khuyến nghị đầu tư.
          </p>
        </div>
        <FooterCol title="Sản phẩm" links={product} className="md:col-span-3" />
        <FooterCol title="Pháp lý" links={legal} className="md:col-span-3" />
      </div>
      <div className="border-t border-line">
        <div className="mx-auto max-w-7xl px-4 py-6 text-[13px] text-tx-3 sm:px-6">© {new Date().getFullYear()} VNStock SIM</div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links, className }: { title: string; links: { to: string; label: string }[]; className?: string }) {
  return (
    <div className={className}>
      <div className="text-[14px] font-semibold text-tx-1">{title}</div>
      <ul className="mt-4 flex flex-col gap-3">
        {links.map((l) => (
          <li key={l.to}>
            <Link to={l.to} className="text-[14px] text-tx-2 transition-colors hover:text-brand">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function LandingPage() {
  useSystemStatus();
  useEffect(() => {
    const prev = document.title;
    document.title = 'VNStock SIM · Tập đầu tư chứng khoán bằng vốn ảo';
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-full bg-bg-0 text-[15px] leading-normal text-tx-1">
        <LandingNav />
        <main>
          <Hero />
          <LiveTicker />
          <Stats />
          <Features />
          <Steps cta={<PrimaryCta />} />
          <Rules />
          <Faq />
          <FinalCta />
        </main>
        <Footer />
      </div>
    </MotionConfig>
  );
}
