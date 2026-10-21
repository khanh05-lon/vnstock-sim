import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { motion, useMotionValueEvent, useReducedMotion, useScroll, useSpring, useTransform } from 'motion/react';
import { ArrowRight, BadgeCheck, Heart, MessageCircle, TrendingDown, TrendingUp } from 'lucide-react';
import type { DepthSnapshot, Kline, TradeTick } from '@vss/shared';
import { useSymbolFeed } from '../../hooks/useSymbolFeed';
import { cn, fmtCompact, fmtPct, fmtPrice, fmtQty, signTone, toneText } from '../../lib/format';
import { useP2PAds, useP2PConfig } from '../../lib/p2p';
import { useKlines } from '../../lib/queries';
import { ago, useFeed } from '../../lib/square';
import { useMarket } from '../../store/market';
import { Coin, CoinString } from '../board/CoinString';
import { CoinIcon } from '../common/CoinIcon';
import { Coin3D } from './Coin3D';
import { Reveal } from './motion';

const useAllRows = () => {
  const rows = useMarket((s) => s.rows);
  const symbols = useMarket((s) => s.symbols);
  return useMemo(() => symbols.map((s) => rows[s]!).filter(Boolean), [rows, symbols]);
};

/* =====================================================================================
 * Cảnh 1 — Xâu tiền xoắn: 30 cặp là 30 đồng xu bay xoắn ốc trong không gian, cuộn tới đâu xoắn tới đó,
 * cuối cảnh duỗi thẳng thành một xâu (xếp từ tăng mạnh nhất tới giảm mạnh nhất) và hiện số cặp đang tăng.
 * Điện thoại và giảm chuyển động: xâu tiền đứng yên dạng lưới.
 * ===================================================================================== */
export function StringScene() {
  const all = useAllRows();
  const sorted = useMemo(() => [...all].sort((a, b) => b.changePct - a.changePct), [all]);
  const up = all.filter((r) => r.changePct > 0).length;
  const ref = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  useMotionValueEvent(scrollYProgress, 'change', (p) => stage.current?.style.setProperty('--p', p.toFixed(4)));

  const heading = (
    <div className="max-w-xl">
      <h2 id="thi-truong-title" className="font-display text-[36px] font-bold leading-[1.05] tracking-[-0.03em] md:text-[56px]">
        Cả thị trường, xâu thành một quan
      </h2>
      <p className="mt-5 text-[17px] leading-relaxed text-tx-2">
        Mỗi đồng là một cặp coin trên Binance, màu theo biến động 24 giờ. Lúc này{' '}
        <b className="num text-up">
          {up} / {all.length || 30}
        </b>{' '}
        cặp đang tăng.
      </p>
    </div>
  );

  if (reduce) {
    return (
      <section id="thi-truong" className="scroll-mt-4 bg-bg-1 py-24 lg:py-32" aria-labelledby="thi-truong-title">
        <div className="mx-auto max-w-7xl space-y-10 px-4 sm:px-8">
          {heading}
          <CoinString rows={all} />
        </div>
      </section>
    );
  }

  return (
    <section id="thi-truong" ref={ref} className="relative scroll-mt-4 bg-bg-1 lg:h-[280vh]" aria-labelledby="thi-truong-title">
      {/* Điện thoại / tablet: lưới đứng yên */}
      <div className="mx-auto max-w-7xl space-y-10 px-4 py-24 sm:px-8 lg:hidden">
        {heading}
        <CoinString rows={all} />
      </div>
      <div ref={stage} className="helix sticky top-0 hidden h-screen overflow-hidden lg:block" style={{ '--p': 0, '--span': 'min(88vw, 1180px)' } as CSSProperties}>
        <div className="mx-auto max-w-7xl px-8 pt-[12vh]">{heading}</div>
        <div className="helix-track">
          {/* sợi dây chỉ hiện khi các đồng đã duỗi thẳng */}
          <span aria-hidden className="helix-thread absolute top-[-1px] h-[2px] bg-line-2" style={{ width: 'var(--span)', left: 'calc(var(--span) / -2)' }} />
          {sorted.map((r, i) => (
            <Link
              key={r.symbol}
              to={`/trade/${r.symbol}`}
              className="helix-coin flex flex-col items-center gap-1"
              style={{ '--i': i, '--n': sorted.length } as CSSProperties}
              title={`${r.baseAsset} ${fmtPct(r.changePct)}`}
            >
              <Coin pct={r.changePct} asset={r.baseAsset} className="h-11 w-11" />
              <span className="helix-reveal flex flex-col items-center">
                <span className="text-[12px] font-semibold leading-none text-tx-1">{r.baseAsset}</span>
                <span className={cn('num mt-1 text-[11px] leading-none', r.changePct >= 0 ? 'text-up' : 'text-down')}>{fmtPct(r.changePct, 1)}</span>
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

/* =====================================================================================
 * Cảnh 2 — Màn giao dịch thật: một mảnh giao diện chạy dữ liệu BTC/USDT trực tiếp (nến 1 giờ, sổ lệnh, giao dịch),
 * nghiêng nằm trong không gian rồi dựng phẳng theo cuộn.
 * ===================================================================================== */

function Candles({ klines, last }: { klines: Kline[]; last: number | null }) {
  const data = klines.slice(-56);
  if (!data.length) return <div className="h-full w-full animate-pulse rounded bg-bg-2" />;
  const bars = data.map((k, i) => (i === data.length - 1 && last ? { ...k, close: last, high: Math.max(k.high, last), low: Math.min(k.low, last) } : k));
  const hi = Math.max(...bars.map((b) => b.high));
  const lo = Math.min(...bars.map((b) => b.low));
  const W = 560;
  const H = 240;
  const y = (v: number) => ((hi - v) / (hi - lo || 1)) * (H - 16) + 8;
  const step = W / bars.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="none" aria-label="Nến 1 giờ BTC/USDT">
      {bars.map((b, i) => {
        const upBar = b.close >= b.open;
        const x = i * step + step / 2;
        const top = y(Math.max(b.open, b.close));
        const h = Math.max(1.5, Math.abs(y(b.open) - y(b.close)));
        return (
          <g key={b.time} fill={upBar ? 'var(--up)' : 'var(--down)'} stroke={upBar ? 'var(--up)' : 'var(--down)'}>
            <line x1={x} x2={x} y1={y(b.high)} y2={y(b.low)} strokeWidth="1" />
            <rect x={x - step * 0.32} y={top} width={step * 0.64} height={h} stroke="none" />
          </g>
        );
      })}
      {last != null && <line x1="0" x2={W} y1={y(last)} y2={y(last)} stroke="var(--brand)" strokeDasharray="3 4" strokeWidth="1" />}
    </svg>
  );
}

function MiniTerminal() {
  const btc = useMarket((s) => s.rows.BTCUSDT);
  const { data: klines } = useKlines('BTCUSDT', '1h');
  const [depth, setDepth] = useState<DepthSnapshot | null>(null);
  const [trades, setTrades] = useState<TradeTick[]>([]);
  useSymbolFeed('BTCUSDT', {
    onDepth: setDepth,
    onTrades: (t) => setTrades((old) => [...t.slice().reverse(), ...old].slice(0, 9)),
  });
  const tick = btc?.filters.tickSize;
  const step = btc?.filters.stepSize;
  const asks = (depth?.asks ?? []).slice(0, 7).reverse();
  const bids = (depth?.bids ?? []).slice(0, 7);
  const maxQty = Math.max(1e-9, ...[...asks, ...bids].map((l) => Number(l[1])));
  const level = (l: [string, string], side: 'ask' | 'bid') => (
    <div key={`${side}${l[0]}`} className="relative grid grid-cols-2 px-3 py-[3px] text-[12px]">
      <span aria-hidden className={cn('absolute inset-y-0 right-0', side === 'ask' ? 'bg-down/12' : 'bg-up/12')} style={{ width: `${(Number(l[1]) / maxQty) * 100}%` }} />
      <span className={cn('num relative', side === 'ask' ? 'text-down' : 'text-up')}>{fmtPrice(l[0], tick)}</span>
      <span className="num relative text-right text-tx-2">{fmtQty(l[1], step)}</span>
    </div>
  );
  return (
    <div data-ui className="overflow-hidden rounded-md bg-bg-1 text-tx-1" aria-label="Màn giao dịch BTC/USDT trực tiếp">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 bg-bg-2 px-4 py-3">
        <span className="flex items-center gap-2 text-[16px] font-bold">
          <CoinIcon asset="BTC" size={24} /> BTC/USDT
        </span>
        <span className={cn('num text-[20px] font-bold', btc && toneText[signTone(btc.changePct)])}>{btc ? fmtPrice(btc.last, tick) : '—'}</span>
        {btc && (
          <>
            <span className={cn('num text-[13px]', toneText[signTone(btc.changePct)])}>{fmtPct(btc.changePct)} 24h</span>
            <span className="num text-[13px] text-tx-2">KL {fmtCompact(btc.quoteVolume)} USDT</span>
          </>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr_190px]">
        <div className="hidden py-2 md:block">
          <div className="grid grid-cols-2 px-3 pb-1 text-[11px] text-tx-3">
            <span>Giá</span>
            <span className="text-right">Số lượng</span>
          </div>
          {asks.map((l) => level(l, 'ask'))}
          <div className={cn('num px-3 py-1.5 text-[15px] font-bold', btc && toneText[signTone(btc.changePct)])}>{btc ? fmtPrice(btc.last, tick) : '—'}</div>
          {bids.map((l) => level(l, 'bid'))}
        </div>
        <div className="h-[260px] px-2 py-3 md:h-auto">
          <Candles klines={klines ?? []} last={btc ? Number(btc.last) : null} />
        </div>
        <div className="hidden py-2 md:block">
          <div className="grid grid-cols-2 px-3 pb-1 text-[11px] text-tx-3">
            <span>Giá</span>
            <span className="text-right">Khớp</span>
          </div>
          {trades.map((t) => (
            <div key={t.id} className="grid grid-cols-2 px-3 py-[3px] text-[12px]">
              <span className={cn('num', t.buyerMaker ? 'text-down' : 'text-up')}>{fmtPrice(t.price, tick)}</span>
              <span className="num text-right text-tx-2">{fmtQty(t.qty, step)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function TradeScene() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'center center'] });
  const p = useSpring(scrollYProgress, { stiffness: 120, damping: 26, mass: 0.5 });
  const rotateX = useTransform(p, [0, 1], [38, 0]);
  const scale = useTransform(p, [0, 1], [0.8, 1]);
  const y = useTransform(p, [0, 1], [80, 0]);
  const facts = [
    { v: 'Sổ lệnh 20 mức', t: 'Mua bán ăn vào sổ lệnh thật, phần đã ăn được nhớ tới lần cập nhật sau.' },
    { v: '5 loại lệnh', t: 'Giới hạn, thị trường, post-only, stop-limit, OCO; GTC, IOC, FOK.' },
    { v: 'Phí 0,1%', t: 'Maker / taker như Binance, giảm theo cấp VIP, trả bằng BNB giảm 25%.' },
  ];
  return (
    <section id="gia-that" ref={ref} className="scroll-mt-4 bg-bg-0 py-24 text-tx-1 lg:py-36" aria-labelledby="gia-that-title">
      <div className="mx-auto max-w-7xl px-4 sm:px-8">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <Reveal className="lg:col-span-7">
            <h2 id="gia-that-title" className="font-display text-[36px] font-bold leading-[1.05] tracking-[-0.03em] md:text-[56px]">
              Màn giao dịch chạy giá thật
            </h2>
          </Reveal>
          <Reveal delay={0.08} className="lg:col-span-5 lg:pt-3">
            <p className="text-[17px] leading-relaxed text-tx-2">
              Dưới đây là BTC/USDT lúc này: nến 1 giờ, sổ lệnh và từng giao dịch khớp trên Binance, cập nhật mỗi giây. Vào sàn là đặt lệnh ngay trên đúng dữ liệu đó.
            </p>
          </Reveal>
        </div>
        <div className="tilt-stage mt-14">
          <motion.div style={reduce ? undefined : { rotateX, scale, y, transformOrigin: '50% 100%' }}>
            <MiniTerminal />
          </motion.div>
        </div>
        <dl className="mt-14 grid grid-cols-1 gap-10 md:grid-cols-3">
          {facts.map((f, i) => (
            <Reveal key={f.v} delay={i * 0.07}>
              <dt className="font-display text-[28px] font-bold text-brand">{f.v}</dt>
              <dd className="mt-2 text-[16px] leading-relaxed text-tx-2">{f.t}</dd>
            </Reveal>
          ))}
        </dl>
      </div>
    </section>
  );
}

/* =====================================================================================
 * P2P: VNĐ chạy từ người mua sang người bán, USDT nằm trong ký quỹ (đồng xu quay) rồi về người mua.
 * Bên phải: quảng cáo bán USDT thật đang có trên chợ.
 * ===================================================================================== */
export function EscrowFlow() {
  const { data: cfg } = useP2PConfig();
  const { data: ads } = useP2PAds({ side: 'SELL', asset: 'USDT' });
  const rate = cfg?.refPrices?.USDT;
  const lane = (label: string, tone: string, delay: number, mirror = false) => (
    <div className="relative h-6 overflow-hidden" aria-hidden>
      {[0, 1].map((k) => (
        <span
          key={k}
          className={cn('flow-dot absolute left-0 top-1/2 -translate-y-1/2 rounded-full px-2.5 py-0.5 text-[12px] font-bold', tone)}
          style={{ '--dist': 'calc(100% + 40px)', animationDelay: `${delay + k * 1.6}s`, width: 'max-content' } as CSSProperties}
        >
          {mirror ? <span className="inline-block -scale-x-100">{label}</span> : label}
        </span>
      ))}
    </div>
  );
  return (
    <section id="p2p" className="scroll-mt-4 bg-bg-0 py-24 text-tx-1 lg:py-36" aria-labelledby="p2p-title">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-14 px-4 sm:px-8 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-6">
          <Reveal>
            <h2 id="p2p-title" className="font-display text-[36px] font-bold leading-[1.05] tracking-[-0.03em] md:text-[56px]">
              Mua USDT bằng VNĐ, có ký quỹ
            </h2>
          </Reveal>
          <Reveal delay={0.08}>
            <p className="mt-6 max-w-[48ch] text-[17px] leading-relaxed text-tx-2">
              Chọn thương nhân đã xác minh, chuyển khoản qua ngân hàng giả lập. Coin của bên bán nằm trong ký quỹ VNCoin, chỉ được nhả khi bên bán xác nhận đã nhận tiền.
              {rate && (
                <>
                  {' '}
                  Giá tham chiếu lúc này <b className="num text-tx-1">{Number(rate).toLocaleString('vi-VN')} ₫</b> / USDT.
                </>
              )}
            </p>
          </Reveal>
        </div>
        <Reveal delay={0.1} className="lg:col-span-6">
          <div data-ui className="overflow-hidden rounded-md bg-bg-1">
            <div className="flex items-center justify-between bg-bg-2 px-4 py-3 text-[14px]">
              <b>Thương nhân bán USDT</b>
              <Link to="/p2p" className="inline-flex items-center gap-1 text-[13px] font-semibold text-brand hover:underline">
                Vào chợ P2P <ArrowRight size={14} />
              </Link>
            </div>
            {!ads ? (
              <div className="h-56 animate-pulse" />
            ) : !ads.length ? (
              <p className="px-4 py-8 text-[14px] text-tx-2">Chưa có quảng cáo bán USDT lúc này.</p>
            ) : (
              <table className="tbl w-full text-[13px]">
                <tbody>
                  {ads.slice(0, 5).map((a) => (
                    <tr key={a.id} className="border-t border-line">
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-1.5 font-semibold">
                          {a.merchant.name}
                          {a.merchant.verified && <BadgeCheck size={14} className="text-brand" aria-label="Đã xác minh" />}
                        </span>
                        <span className="text-[12px] text-tx-3">{a.banks.slice(0, 2).join(', ')}</span>
                      </td>
                      <td className="px-2 py-3 text-right">
                        <span className="num text-[15px] font-bold">{a.price ? Number(a.price).toLocaleString('vi-VN') : '—'}</span> <span className="text-tx-3">₫</span>
                      </td>
                      <td className="hidden px-4 py-3 text-right text-tx-2 sm:table-cell">
                        {Number(a.limitMin).toLocaleString('vi-VN')} – {Number(a.limitMax).toLocaleString('vi-VN')} ₫
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Reveal>
            <Reveal delay={0.12} className="lg:col-span-12">
              <div data-ui className="grid min-h-[240px] grid-cols-1 items-center gap-8 rounded-md bg-bg-1 p-6 sm:p-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]" aria-label="Sơ đồ ký quỹ P2P">
              <p className="text-[17px] leading-relaxed">VNĐ đi thẳng từ người mua sang người bán; USDT của bên bán nằm trong ký quỹ tới khi bên bán xác nhận.</p>
              {/* VNĐ: người mua → người bán (chuyển khoản). USDT: người bán → ký quỹ → người mua */}
              <div className="grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-x-3 gap-y-4">
                <span className="row-span-2 text-center text-[17px] font-semibold">
                  Người
                  <br />
                  mua
                </span>
                <div className="col-span-3">{lane('VNĐ', 'bg-ref/20 text-ref', 0)}</div>
                <span className="row-span-2 text-center text-[17px] font-semibold">
                  Người
                  <br />
                  bán
                </span>
                <div className="-scale-x-100">{lane('USDT', 'bg-up/20 text-up', 1.6, true)}</div>
                <div className="flex flex-col items-center gap-1 [perspective:600px]">
                  <Coin3D size={96} thickness={12} back={['KÝ', 'QUỸ']} />
                  <span className="text-[14px] font-semibold text-tx-2">Ký quỹ VNCoin</span>
                </div>
                <div className="-scale-x-100">{lane('USDT', 'bg-up/20 text-up', 0.4, true)}</div>
              </div>
              </div>
            </Reveal>
      </div>
    </section>
  );
}

/* =====================================================================================
 * Cộng đồng: bài viết thật đang được thích nhiều, xếp lệch trong không gian và trôi nhẹ.
 * ===================================================================================== */
export function CommunityStack() {
  const { data } = useFeed({ tab: 'foryou' });
  const posts = (data?.pages[0]?.posts ?? []).slice(0, 3);
  const poses = [
    { rx: '10deg', ry: '-14deg', x: '0%', y: '0px', dur: '7s', z: 3 },
    { rx: '6deg', ry: '-6deg', x: '18%', y: '200px', dur: '8.5s', z: 2 },
    { rx: '12deg', ry: '-18deg', x: '6%', y: '400px', dur: '9.5s', z: 1 },
  ];
  return (
    <section id="cong-dong" className="scroll-mt-4 py-24 lg:py-36" style={{ background: '#c69653', color: '#1b120a' }} aria-labelledby="cong-dong-title">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-14 px-4 sm:px-8 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-5">
          <Reveal>
            <h2 id="cong-dong-title" className="font-display text-[36px] font-bold leading-[1.05] tracking-[-0.03em] md:text-[56px]">
              Bàn coin cùng người Việt
            </h2>
          </Reveal>
          <Reveal delay={0.08}>
            <p className="mt-6 max-w-[44ch] text-[17px] leading-relaxed">
              Đăng nhận định Tăng / Giảm gắn $BTC, khoe lệnh đã khớp có nhãn xác minh, theo dõi người giao dịch giỏi. Bộ lọc chặn lừa đảo, rủ nhóm kín, lộ số tài khoản.
            </p>
          </Reveal>
          <Reveal delay={0.14}>
            <Link to="/cong-dong" className="mt-9 inline-flex h-12 items-center gap-2 rounded-full bg-[#1d1914] px-7 text-[16px] font-semibold text-[#f1ece2] hover:bg-[#33291f]">
              Vào Cộng đồng <ArrowRight size={18} />
            </Link>
          </Reveal>
        </div>
        <div className="relative flex flex-col gap-4 [perspective:1200px] lg:col-span-7 lg:block lg:min-h-[640px]">
          {posts.length === 0 && <p className="text-[16px]">Bài viết của cộng đồng sẽ hiện ở đây.</p>}
          {posts.map((p, i) => {
            const pose = poses[i]!;
            return (
              <Link
                key={p.id}
                to={`/cong-dong/bai/${p.id}`}
                data-ui
                className="drift relative flex min-h-[210px] w-full flex-col rounded-md bg-[#1a1815] p-5 text-[#eeedea] lg:absolute lg:left-[var(--x)] lg:top-[var(--y)] lg:w-[440px]"
                style={{ '--x': pose.x, '--y': pose.y, zIndex: pose.z, '--rx': pose.rx, '--ry': pose.ry, '--dur': pose.dur } as CSSProperties}
              >
                <div className="flex items-center gap-2 text-[13px]">
                  <b>{p.author.displayName}</b>
                  <span className="text-[#958d80]">@{p.author.handle} · {ago(p.createdAt)}</span>
                  {p.sentiment && (
                    <span className={cn('chip gap-1', p.sentiment === 'BULLISH' ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>
                      {p.sentiment === 'BULLISH' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                      {p.sentiment === 'BULLISH' ? 'Tăng' : 'Giảm'}
                    </span>
                  )}
                </div>
                <p className="mt-3 line-clamp-4 text-[15px] leading-relaxed">{p.body}</p>
                <div className="mt-auto flex gap-4 pt-3 text-[13px] text-[#bdb5a8]">
                  <span className="flex items-center gap-1">
                    <Heart size={13} /> {p.likeCount}
                  </span>
                  <span className="flex items-center gap-1">
                    <MessageCircle size={13} /> {p.commentCount}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}

