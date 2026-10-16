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
    <section id="luat-choi" className="scroll-mt-20 py-20 lg:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <Reveal className="max-w-2xl">
          <h2 className="font-display text-[32px] font-bold leading-tight tracking-tight md:text-[42px]">Luật chơi giống Binance</h2>
          <p className="mt-4 max-w-[60ch] text-[17px] leading-relaxed text-tx-2">
            Bộ lọc giá, khối lượng và giá trị tối thiểu lấy thật từ Binance cho từng cặp. Lãi lỗ bạn thấy là lãi lỗ sau phí.
          </p>
        </Reveal>

        <Reveal delay={0.08} className="mt-12 overflow-hidden rounded-2xl border border-line bg-bg-1">
          <div className="grid grid-cols-1 divide-y divide-line md:grid-cols-3 md:divide-x md:divide-y-0">
            {big.map((b) => (
              <div key={b.label} className="p-6 lg:p-8">
                <div className="text-[13px] font-semibold text-tx-3">{b.label}</div>
                <div className="num mt-3 font-display text-[52px] font-bold leading-none tracking-tight lg:text-[64px]">{b.value}</div>
                <div className="mt-3 text-[14px] text-tx-2">{b.note}</div>
              </div>
            ))}
          </div>
          <dl className="grid grid-cols-2 gap-px border-t border-line bg-line lg:grid-cols-4">
            {facts.map((f) => (
              <div key={f.label} className="bg-bg-2 p-5 lg:p-6">
                <dt className="text-[13px] text-tx-3">{f.label}</dt>
                <dd className="num mt-1 font-display text-[24px] font-bold">{f.value}</dd>
                <dd className="text-[13px] text-tx-2">{f.hint}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </div>
    </section>
  );
}
