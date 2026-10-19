import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, Crown } from 'lucide-react';
import { Empty, Spinner } from '../components/common/ui';
import { cn, fmtDateTime } from '../lib/format';
import { fmtFeePct, useFeeSchedule, useMyVip } from '../lib/fees';
import { useLoggedIn } from '../lib/queries';

const fmtUsdt = (v: number | string) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmtBnb = (v: number | string) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 4 });

/** Biểu phí Spot và cấp VIP (như Binance): cấp tính lại 00:00 UTC theo khối lượng 30 ngày và BNB nắm giữ */
export default function FeesPage() {
  const loggedIn = useLoggedIn();
  const { data: sched, isLoading } = useFeeSchedule();
  const { data: me } = useMyVip();

  useEffect(() => {
    document.title = 'Biểu phí & VIP · VNCoin';
    return () => void (document.title = 'VNCoin · Sàn giao dịch coin mô phỏng');
  }, []);

  if (isLoading || !sched) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const next = me ? sched.tiers.find((t) => t.level === me.level + 1) : undefined;
  const volPct = next ? Math.min(100, (Number(me!.volumeNow) / next.volumeUsdt) * 100) : 100;
  const bnbPct = next ? Math.min(100, (Number(me!.bnb) / next.bnb) * 100) : 100;

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-5 sm:px-6">
      <h1 className="text-[26px] font-bold tracking-tight">Biểu phí & cấp VIP</h1>
      <p className="mt-1 max-w-[75ch] text-[13px] text-tx-2">
        Như Binance: phí giao dịch Spot giảm theo cấp VIP. Đạt cấp khi <b>cả</b> khối lượng giao dịch Spot 30 ngày <b>và</b> số BNB bạn nắm giữ đều đủ ngưỡng. Cấp được tính lại
        mỗi ngày lúc 00:00 UTC; phí được chốt vào lệnh lúc đặt. Trả phí bằng BNB được giảm thêm {Number(sched.bnbDiscount) * 100}%.
      </p>

      {loggedIn && me && (
        <section className="mt-5 grid gap-3 md:grid-cols-[1fr_1.4fr]">
          <div className="rounded-xl border border-line bg-bg-1 p-5">
            <div className="flex items-center gap-2 text-[13px] text-tx-3">
              <Crown size={16} className="text-brand" /> Cấp hiện tại
            </div>
            <div className="mt-2 text-[28px] font-bold">VIP {me.level}</div>
            <div className="num mt-1 text-[13px] text-tx-2">
              Maker {fmtFeePct(me.maker)} · Taker {fmtFeePct(me.taker)}
            </div>
            <div className="mt-2 text-[11px] text-tx-3">{me.updatedAt ? `Chốt lúc ${fmtDateTime(me.updatedAt)}` : 'Chưa chốt cấp lần nào'}</div>
          </div>
          <div className="rounded-xl border border-line p-5">
            {next ? (
              <>
                <div className="text-[13px] text-tx-3">Lên VIP {next.level} cần cả hai điều kiện</div>
                {[
                  ['Khối lượng Spot 30 ngày', `${fmtUsdt(me.volumeNow)} / ${fmtUsdt(next.volumeUsdt)} USDT`, volPct],
                  ['BNB nắm giữ', `${fmtBnb(me.bnb)} / ${fmtBnb(next.bnb)} BNB`, bnbPct],
                ].map(([label, text, pct]) => (
                  <div key={label as string} className="mt-3">
                    <div className="flex justify-between text-[12px]">
                      <span className="text-tx-2">{label}</span>
                      <span className="num">{text}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-3">
                      <div className={cn('h-full rounded-full', Number(pct) >= 100 ? 'bg-up' : 'bg-brand')} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                ))}
                <p className="mt-3 text-[11px] text-tx-3">
                  Khối lượng tính theo giá trị USDT của mọi lần khớp Spot trong 30 ngày gần nhất. <Link to="/trade/BNBUSDT" className="text-brand hover:underline">Mua BNB</Link>
                </p>
              </>
            ) : (
              <div className="flex items-center gap-2 font-semibold">
                <BadgeCheck size={18} className="text-brand" /> Bạn đang ở cấp cao nhất
              </div>
            )}
          </div>
        </section>
      )}

      <section className="panel mt-5 overflow-x-auto">
        {!sched.tiers.length ? (
          <Empty title="Chưa có biểu phí" />
        ) : (
          <table className="tbl w-full min-w-[600px] text-[13px]">
            <thead>
              <tr className="text-left">
                <th className="px-4 py-2.5">Cấp</th>
                <th className="px-4 py-2.5 text-right">KL Spot 30 ngày (USDT)</th>
                <th className="px-4 py-2.5 text-right">và BNB nắm giữ</th>
                <th className="px-4 py-2.5 text-right">Maker</th>
                <th className="px-4 py-2.5 text-right">Taker</th>
                <th className="px-4 py-2.5 text-right">Taker trả bằng BNB</th>
              </tr>
            </thead>
            <tbody>
              {sched.tiers.map((t) => (
                <tr key={t.level} className={cn('border-t border-line', me?.level === t.level && 'bg-brand/8')}>
                  <td className="px-4 py-2.5 font-semibold">
                    VIP {t.level}
                    {me?.level === t.level && <span className="chip ml-2 bg-brand/15 text-brand">Bạn</span>}
                  </td>
                  <td className="num px-4 py-2.5 text-right">{t.level ? `≥ ${fmtUsdt(t.volumeUsdt)}` : '< ' + fmtUsdt(sched.tiers[1]?.volumeUsdt ?? 0)}</td>
                  <td className="num px-4 py-2.5 text-right">{t.level ? `≥ ${fmtBnb(t.bnb)}` : '—'}</td>
                  <td className="num px-4 py-2.5 text-right">{fmtFeePct(t.maker)}</td>
                  <td className="num px-4 py-2.5 text-right">{fmtFeePct(t.taker)}</td>
                  <td className="num px-4 py-2.5 text-right">{fmtFeePct(Number(t.taker) * (1 - Number(sched.bnbDiscount)))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p className="mt-3 text-[11px] text-tx-3">
        Biểu phí lấy theo bảng Spot VIP của Binance; ngưỡng là ngưỡng thật × {sched.scale} vì vốn ảo chỉ 10.000 USDT. Sàn mô phỏng, phí tính bằng vốn ảo.
      </p>
    </div>
  );
}
