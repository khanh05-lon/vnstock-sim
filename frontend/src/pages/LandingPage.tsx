import '@fontsource/be-vietnam-pro/800.css';
import '../components/landing/landing3d.css';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MotionConfig, animate, motion, useInView, useReducedMotion, useScroll, useSpring, useTransform } from 'motion/react';
import { ArrowRight, Menu, Moon, Sun, X } from 'lucide-react';
import { RULES } from '@vss/shared';
import { LiveTicker } from '../components/auth/AuthFrame';
import { Coin3D } from '../components/landing/Coin3D';
import { Faq } from '../components/landing/Faq';
import { HeroOrbit } from '../components/landing/HeroOrbit';
import { EASE, fmtCapital, Reveal, scrollToSection } from '../components/landing/motion';
import { Rules } from '../components/landing/Rules';
import { CommunityStack, EscrowFlow, StringScene, TradeScene } from '../components/landing/Scenes';
import { CoinMark } from '../components/layout/Header';
import { useSystemStatus } from '../lib/admin';
import { cn } from '../lib/format';
import { useAuth } from '../store/auth';
import { useMarket } from '../store/market';
import { useUi } from '../store/ui';

/*
 * Trang giới thiệu "Đồng": tiền Việt gọi là đồng. Đồng xu VNCoin lỗ vuông (CSS 3D) quay giữa quỹ đạo các coin lớn với
 * giá Binance trực tiếp; cả thị trường xâu thành một quan tiền xoắn theo cuộn; một màn giao dịch thật dựng phẳng theo cuộn;
 * ký quỹ P2P chạy tiền; bài viết thật của Cộng đồng trôi trong không gian. Mọi con số là dữ liệu thật của sàn.
 * Chuyển động: transform / opacity; prefers-reduced-motion → bố cục đứng yên hoàn chỉnh.
 */

const SECTIONS = [
  { id: 'thi-truong', label: 'Thị trường' },
  { id: 'gia-that', label: 'Giao dịch' },
  { id: 'bat-dau', label: 'Bắt đầu' },
  { id: 'p2p', label: 'P2P' },
  { id: 'cong-dong', label: 'Cộng đồng' },
];

const BRONZE = { background: '#c69653', color: '#1b120a' } as const;

function PrimaryCta({ className, tone = 'bronze' }: { className?: string; tone?: 'bronze' | 'ink' }) {
  const loggedIn = useAuth((s) => !!s.token);
  return (
    <Link
      to={loggedIn ? '/trade' : '/register'}
      className={cn(
        'group inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-full px-7 text-[16px] font-semibold transition-[background-color,transform] duration-200 hover:-translate-y-0.5 active:translate-y-px',
        tone === 'bronze' ? 'bg-[#c69653] text-[#1b120a] hover:bg-[#d4a766]' : 'bg-[#1d1914] text-[#f1ece2] hover:bg-[#33291f]',
        className,
      )}
    >
      {loggedIn ? 'Vào giao dịch' : 'Mở tài khoản'}
      <ArrowRight size={18} className="transition-transform duration-200 group-hover:translate-x-0.5" />
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
      className="rounded-full p-2.5 text-tx-2 transition-colors hover:bg-bg-3 hover:text-tx-1"
      aria-label={theme === 'dark' ? 'Chuyển giao diện sáng' : 'Chuyển giao diện tối'}
    >
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

function LandingNav() {
  const loggedIn = useAuth((s) => !!s.token);
  const [menu, setMenu] = useState(false);
  const go = (id: string) => {
    setMenu(false);
    requestAnimationFrame(() => scrollToSection(id));
  };
  return (
    <header className="relative z-30 bg-bg-0">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-8">
        <Link to="/" className="flex shrink-0 items-center gap-2" aria-label="VNCoin, trang chủ">
          <CoinMark size={28} />
          <span className="text-[18px] font-bold tracking-tight">VNCoin</span>
        </Link>
        <nav className="hidden flex-1 items-center gap-1 lg:flex" aria-label="Các mục trong trang">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              onClick={(e) => {
                e.preventDefault();
                go(s.id);
              }}
              className="rounded-full px-3 py-2 text-[14px] font-medium text-tx-2 transition-colors hover:text-tx-1"
            >
              {s.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1 lg:ml-0">
          <ThemeToggle />
          {!loggedIn && (
            <Link to="/login" className="hidden rounded-full px-4 py-2.5 text-[14px] font-semibold transition-colors hover:bg-bg-3 sm:inline-flex">
              Đăng nhập
            </Link>
          )}
          <span className="hidden sm:block">
            <PrimaryCta className="h-10 px-5 text-[14px]" />
          </span>
          <button type="button" className="rounded-full p-2.5 hover:bg-bg-3 lg:hidden" onClick={() => setMenu((v) => !v)} aria-expanded={menu} aria-label={menu ? 'Đóng menu' : 'Mở menu'}>
            {menu ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>
      {menu && (
        <motion.nav
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: EASE }}
          className="absolute inset-x-0 top-full bg-bg-0 px-4 pb-5 pt-2 lg:hidden"
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
              className="block px-2 py-3 text-[16px] font-medium"
            >
              {s.label}
            </a>
          ))}
          <div className="mt-3 grid grid-cols-2 gap-2">
            {!loggedIn && (
              <Link to="/login" className="inline-flex h-12 items-center justify-center rounded-full bg-bg-3 text-[15px] font-semibold">
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

const rise = (i: number) => ({
  initial: { opacity: 0, y: 24 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.8, delay: 0.06 + i * 0.08, ease: EASE },
});

function Hero() {
  const btc = useMarket((s) => s.rows.BTCUSDT);
  return (
    <section className="relative overflow-hidden bg-bg-0" aria-labelledby="hero-title">
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-4 px-4 pb-8 pt-6 sm:px-8 lg:grid-cols-12 lg:gap-0 lg:pb-12">
        <div className="relative z-10 lg:col-span-6">
          <motion.h1 {...rise(0)} id="hero-title" className="font-display text-[46px] font-extrabold leading-[1.02] tracking-[-0.035em] sm:text-[64px] lg:text-[72px]">
            Tiền ảo,
            <br />
            thị trường thật
          </motion.h1>
          <motion.p {...rise(1)} className="mt-7 max-w-[32rem] text-[18px] leading-relaxed">
            Sàn coin mô phỏng cho người Việt. Nhận {fmtCapital(RULES.initialUsdt)} vốn ảo, giao dịch trên giá và sổ lệnh thật của Binance, 24/7.
            {btc && (
              <span className="mt-2 block text-[15px] text-tx-2">
                BTC lúc này <b className="num text-tx-1">{Number(btc.last).toLocaleString('en-US', { maximumFractionDigits: 2 })}</b> USDT
              </span>
            )}
          </motion.p>
          <motion.div {...rise(2)} className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
            <PrimaryCta />
            <Link to="/thi-truong" className="text-[16px] font-semibold underline decoration-2 underline-offset-[6px] transition-colors hover:text-brand">
              Xem thị trường
            </Link>
          </motion.div>
        </div>
        <motion.div initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 1.2, delay: 0.15, ease: EASE }} className="lg:col-span-6">
          <HeroOrbit />
        </motion.div>
      </div>
    </section>
  );
}

/** Số vốn đếm từ 0 lên khi cuộn tới (đứng yên ở số cuối khi giảm chuyển động) */
function CountUp({ to }: { to: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-15% 0px' });
  const reduce = useReducedMotion();
  const [v, setV] = useState(reduce ? to : 0);
  useEffect(() => {
    if (!inView || reduce) return;
    const c = animate(0, to, { duration: 1.6, ease: EASE, onUpdate: (x) => setV(Math.round(x)) });
    return () => c.stop();
  }, [inView, reduce, to]);
  return (
    <span ref={ref} className="num">
      {v.toLocaleString('vi-VN')}
    </span>
  );
}

function Start() {
  const steps = [
    { t: 'Mở tài khoản', b: 'Đăng ký bằng email, vốn ảo vào ví ngay. Muốn xem trước thì dùng tài khoản demo.' },
    { t: 'Đặt lệnh', b: 'Chọn coin, xem nến và sổ lệnh, đặt lệnh giới hạn, thị trường, stop-limit hoặc OCO.' },
    { t: 'Theo dõi lãi lỗ', b: 'Ví, giá vốn, lịch sử khớp và báo cáo theo tháng cập nhật sau mỗi lệnh. Lên bảng xếp hạng nếu muốn.' },
  ];
  return (
    <section id="bat-dau" className="scroll-mt-4 py-24 lg:py-36" style={BRONZE} aria-labelledby="bat-dau-title">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-14 px-4 sm:px-8 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-6">
          <Reveal>
            <h2 id="bat-dau-title" className="font-display text-[36px] font-bold leading-[1.05] tracking-[-0.03em] md:text-[56px]">
              Vốn ảo vào ví ngay khi đăng ký
            </h2>
          </Reveal>
          <Reveal delay={0.08}>
            <p className="mt-8 font-display text-[64px] font-extrabold leading-none tracking-[-0.04em] sm:text-[96px] lg:text-[120px]">
              <CountUp to={Number(RULES.initialUsdt)} />
            </p>
            <p className="mt-2 text-[20px] font-semibold">USDT, không nạp đồng nào</p>
          </Reveal>
        </div>
        <ol className="space-y-9 lg:col-span-6 lg:pl-6 lg:pt-4">
          {steps.map((s, i) => (
            <Reveal key={s.t} delay={0.06 + i * 0.08}>
              <li>
                <h3 className="text-[24px] font-bold tracking-tight">{s.t}</h3>
                <p className="mt-2 max-w-[48ch] text-[17px] leading-relaxed">{s.b}</p>
              </li>
            </Reveal>
          ))}
          <Reveal delay={0.32}>
            <PrimaryCta tone="ink" />
          </Reveal>
        </ol>
      </div>
    </section>
  );
}

/** Kết: đồng xu lật theo cuộn rồi dừng ở mặt "10.000 USDT" */
function FinalCta() {
  const loggedIn = useAuth((s) => !!s.token);
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'center center'] });
  const p = useSpring(scrollYProgress, { stiffness: 80, damping: 20 });
  const rotateY = useTransform(p, [0, 1], [0, 540]);
  const rotateX = useTransform(p, [0, 1], [24, 8]);
  return (
    <section ref={ref} className="overflow-hidden bg-bg-0 py-24 lg:py-32" aria-labelledby="final-title">
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-12 px-4 sm:px-8 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <h2 id="final-title" className="font-display text-[44px] font-extrabold leading-[1.02] tracking-[-0.035em] md:text-[72px]">
            {loggedIn ? 'Thị trường đang chạy' : 'Đặt lệnh đầu tiên hôm nay'}
          </h2>
          <p className="mt-6 max-w-[44ch] text-[18px] leading-relaxed">
            {loggedIn ? 'Ví, lệnh chờ và cảnh báo giá của bạn vẫn đang cập nhật theo giá Binance.' : `Miễn phí, ${fmtCapital(RULES.initialUsdt)} vốn ảo, giá thật. Không phải khuyến nghị đầu tư.`}
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
            <PrimaryCta />
            {!loggedIn && (
              <Link to="/login" className="text-[16px] font-semibold underline decoration-2 underline-offset-[6px] hover:text-brand">
                Dùng tài khoản demo
              </Link>
            )}
          </div>
        </div>
        <div className="flex justify-center [perspective:1200px] lg:col-span-5">
          <motion.div style={reduce ? { rotateY: 180 } : { rotateY, rotateX }} className="[transform-style:preserve-3d]">
            <Coin3D size={300} thickness={26} spin={false} />
          </motion.div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const links = [
    { to: '/thi-truong', label: 'Thị trường' },
    { to: '/trade', label: 'Giao dịch' },
    { to: '/p2p', label: 'P2P' },
    { to: '/cong-dong', label: 'Cộng đồng' },
    { to: '/xep-hang', label: 'Xếp hạng' },
    { to: '/phi', label: 'Biểu phí' },
    { to: '/dieu-khoan', label: 'Điều khoản' },
    { to: '/chinh-sach-bao-mat', label: 'Bảo mật' },
  ];
  return (
    <footer className="bg-bg-1 text-tx-1">
      <div className="mx-auto max-w-7xl px-4 pb-10 pt-20 sm:px-8">
        <nav aria-label="Chân trang" className="flex flex-wrap gap-x-7 gap-y-3 text-[15px]">
          {links.map((l) => (
            <Link key={l.to} to={l.to} className="text-tx-2 transition-colors hover:text-brand">
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="mt-16 flex items-end gap-[2vw]" aria-hidden>
          <CoinMark size={120} className="h-[12vw] max-h-[150px] w-[12vw] max-w-[150px] shrink-0" />
          <span className="font-display text-[18vw] font-extrabold leading-[0.8] tracking-[-0.06em] lg:text-[208px]">VNCoin</span>
        </div>
        <p className="mt-10 max-w-[68ch] text-[14px] leading-relaxed text-tx-2">
          Sàn giao dịch coin mô phỏng phục vụ học tập, giá thật từ Binance. Vốn, coin và lãi lỗ là ảo, không quy đổi ra tiền thật. Không phải khuyến nghị đầu tư. © {new Date().getFullYear()} VNCoin.
        </p>
      </div>
    </footer>
  );
}

export default function LandingPage() {
  useSystemStatus();
  useEffect(() => {
    const prev = document.title;
    document.title = 'VNCoin · Tiền ảo, thị trường thật';
    return () => {
      document.title = prev;
    };
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-full bg-bg-0 text-[16px] leading-normal text-tx-1">
        <LandingNav />
        <main>
          <Hero />
          <LiveTicker />
          <StringScene />
          <TradeScene />
          <Start />
          <EscrowFlow />
          <CommunityStack />
          <Rules />
          <Faq />
          <FinalCta />
        </main>
        <Footer />
      </div>
    </MotionConfig>
  );
}
