import { RULES, type Exchange } from '@vss/shared';
import { useSystemStatus } from '../../lib/admin';
import { fmtRate, Reveal } from './motion';

const fmtPctNum = (v: number) => v.toLocaleString('vi-VN', { maximumFractionDigits: 2 });

/** Tham số giao dịch lấy trực tiếp từ RULES (đã ghép bản quản trị viên chỉnh) */
export function Rules() {
  useSystemStatus();
  const venues: { ex: Exchange; note: string }[] = [
    { ex: 'HOSE', note: 'Sở Giao dịch Chứng khoán TP.HCM' },
    { ex: 'HNX', note: 'Sở Giao dịch Chứng khoán Hà Nội' },
    { ex: 'UPCOM', note: 'Công ty đại chúng chưa niêm yết' },
  ];
  const facts = [
    { label: 'Phí giao dịch', value: fmtRate(RULES.feeRate), hint: 'mỗi chiều mua hoặc bán' },
    { label: 'Thuế khi bán', value: fmtRate(RULES.sellTaxRate), hint: 'tính trên giá trị bán' },
    { label: 'Lô chẵn', value: `${RULES.lotSize} CP`, hint: 'dưới một lô là lô lẻ' },
    { label: 'Thanh toán', value: 'T+2', hint: 'tiền bán về sau hai ngày' },
  ];

  return (
    <section id="luat-choi" className="scroll-mt-20 py-20 lg:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <Reveal className="max-w-2xl">
          <h2 className="font-display text-[32px] font-bold leading-tight tracking-tight md:text-[42px]">Luật chơi giống sàn thật</h2>
          <p className="mt-4 max-w-[60ch] text-[17px] leading-relaxed text-tx-2">
            Biên độ, bước giá, phí và thuế theo quy định HOSE, HNX, UPCOM. Lãi lỗ bạn thấy là lãi lỗ sau phí.
          </p>
        </Reveal>

        <Reveal delay={0.08} className="mt-12 overflow-hidden rounded-2xl border border-line bg-bg-1">
          <div className="grid grid-cols-1 divide-y divide-line md:grid-cols-3 md:divide-x md:divide-y-0">
            {venues.map((v) => (
              <div key={v.ex} className="p-6 lg:p-8">
                <div className="text-[13px] font-semibold text-tx-3">Biên độ {v.ex}</div>
                <div className="num mt-3 font-display text-[52px] font-bold leading-none tracking-tight lg:text-[64px]">
                  <span className="text-brand">±</span>
                  {fmtPctNum(RULES.priceLimitPct[v.ex])}%
                </div>
                <div className="mt-3 text-[14px] text-tx-2">{v.note}</div>
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
