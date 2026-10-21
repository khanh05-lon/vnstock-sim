import { Big, RULES } from '@vss/shared';
import { useSystemStatus } from '../../lib/admin';
import { fmtPrice } from '../../lib/format';
import { useMarket } from '../../store/market';
import { Reveal } from './motion';

/** Luật chơi lấy trực tiếp từ biểu phí (RULES) và bộ lọc thật của BTCUSDT */
export function Rules() {
  useSystemStatus();
  const btc = useMarket((s) => s.rows.BTCUSDT);
  const big = [
    { label: 'Phí maker', value: `${new Big(RULES.makerFee).times(100).toFixed()}%`, note: 'Lệnh nằm chờ trên sổ rồi được khớp' },
    { label: 'Phí taker', value: `${new Big(RULES.takerFee).times(100).toFixed()}%`, note: 'Lệnh khớp ngay với sổ lệnh' },
    { label: 'Trả phí bằng BNB', value: `-${new Big(RULES.bnbDiscount).times(100).toFixed()}%`, note: 'Bật trong Ví, cần có BNB' },
  ];
  const facts = [
    { label: 'Giờ giao dịch', value: '24/7', hint: 'chốt ngày theo 00:00 UTC' },
    { label: 'Giá trị tối thiểu', value: btc ? `${btc.filters.minNotional} USDT` : '5 USDT', hint: 'mỗi lệnh với cặp BTC/USDT' },
    { label: 'Bước giá BTC', value: btc ? fmtPrice(btc.filters.tickSize, btc.filters.tickSize) : '0.01', hint: 'mỗi cặp có bước riêng' },
    { label: 'Tiền về ví', value: 'Ngay', hint: 'khớp xong là dùng được' },
  ];

  return (
    <section id="luat-choi" className="scroll-mt-4 bg-bg-0 py-24 lg:py-36">
      <div className="mx-auto max-w-7xl px-4 sm:px-8">
        <Reveal className="max-w-2xl">
          <h2 className="font-display text-[36px] font-bold leading-[1.05] tracking-[-0.03em] md:text-[52px]">Luật chơi giống Binance</h2>
          <p className="mt-5 max-w-[60ch] text-[17px] leading-relaxed text-tx-2">
            Bộ lọc giá, khối lượng và giá trị tối thiểu lấy thật từ Binance cho từng cặp. Lãi lỗ bạn thấy là lãi lỗ sau phí.
          </p>
        </Reveal>

        <Reveal delay={0.08} className="mt-14 grid grid-cols-1 gap-10 md:grid-cols-3">
          {big.map((b) => (
            <div key={b.label}>
              <div className="num font-display text-[64px] font-bold leading-none tracking-tight text-brand lg:text-[84px]">{b.value}</div>
              <h3 className="mt-4 text-[22px] font-bold">{b.label}</h3>
              <p className="mt-1 text-[16px] text-tx-2">{b.note}</p>
            </div>
          ))}
        </Reveal>
        <Reveal delay={0.14} className="mt-14 rounded-md bg-bg-1 px-6 py-8 lg:px-10">
          <dl className="grid grid-cols-2 gap-x-8 gap-y-8 lg:grid-cols-4">
            {facts.map((f) => (
              <div key={f.label} className="flex flex-col-reverse">
                <dt className="mt-1 text-[16px] text-tx-2">
                  {f.label}, {f.hint}
                </dt>
                <dd className="num font-display text-[28px] font-bold">{f.value}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </div>
    </section>
  );
}
