import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { Big } from '@vss/shared';
import { CoinIcon } from '../components/common/CoinIcon';
import { Empty, Spinner } from '../components/common/ui';
import { AllocationDonut, PALETTE, type Slice } from '../components/portfolio/AllocationDonut';
import { NavChart } from '../components/portfolio/NavChart';
import { api, errMsg } from '../lib/api';
import { cn, fmtPct, fmtPrice, fmtQty, fmtUsd, signTone, toneText } from '../lib/format';
import { useAccount, useNavHistory } from '../lib/queries';
import { useMarket } from '../store/market';
import { useQueryClient } from '@tanstack/react-query';

const HIDE_KEY = 'vss-hide-balance';

/** Ví Spot: tổng tài sản ước tính, lãi/lỗ, phân bổ và số dư từng tài sản */
export default function WalletPage() {
  const { data: account, isLoading } = useAccount();
  const { data: nav } = useNavHistory('7D');
  const rows = useMarket((s) => s.rows);
  const qc = useQueryClient();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [hideSmall, setHideSmall] = useState(false);

  // Tổng tài sản quy theo giá realtime (ticker cập nhật mỗi giây)
  const live = useMemo(() => {
    if (!account) return null;
    let total = 0;
    const items = account.balances.map((b) => {
      const price = b.asset === 'USDT' ? 1 : Number(rows[`${b.asset}USDT`]?.last ?? 0);
      const value = Number(b.total) * price;
      total += value;
      const cost = b.avgCost ? Number(b.avgCost) * Number(b.total) : null;
      return { ...b, price, value, pnl: cost != null ? value - cost : null, pnlPct: cost ? ((value - cost) / cost) * 100 : null };
    });
    return { items: items.sort((a, b) => b.value - a.value), total };
  }, [account, rows]);

  const toggleHidden = () => {
    setHidden((v) => {
      try {
        localStorage.setItem(HIDE_KEY, v ? '0' : '1');
      } catch {
        /* bỏ qua */
      }
      return !v;
    });
  };

  const setBnb = async (on: boolean) => {
    try {
      await api('/account/settings', { method: 'PUT', body: { payFeeWithBnb: on } });
      toast.success(on ? 'Đã bật trả phí bằng BNB (giảm 25%)' : 'Đã tắt trả phí bằng BNB');
      void qc.invalidateQueries({ queryKey: ['account'] });
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  if (isLoading || !account || !live) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const contributed = Number(account.contributedUsdt);
  const pnl = live.total - contributed;
  const pnlPct = contributed ? (pnl / contributed) * 100 : 0;
  // Lãi/lỗ hôm nay = so với tổng tài sản chốt lúc 00:00 UTC hôm nay (điểm gần cuối của lịch sử)
  const yesterday = nav?.points.length && nav.points.length >= 2 ? nav.points[nav.points.length - 2] : null;
  const todayPnl = yesterday ? live.total - yesterday.nav - (contributed - yesterday.contributed) : null;
  const btc = Number(rows.BTCUSDT?.last ?? 0);
  const mask = (s: string) => (hidden ? '******' : s);

  const slices: Slice[] = (() => {
    const top = live.items.filter((i) => i.value > 0).slice(0, 7);
    const rest = live.items.filter((i) => i.value > 0).slice(7).reduce((s, i) => s + i.value, 0);
    const out = top.map((i, k) => ({ label: i.asset, value: i.value, color: PALETTE[k % PALETTE.length]! }));
    if (rest > 0) out.push({ label: 'Khác', value: rest, color: PALETTE[PALETTE.length - 1]! });
    return out;
  })();

  const shown = live.items.filter((i) => !hideSmall || i.value >= 1 || i.asset === 'USDT');

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 space-y-4 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-[26px] font-bold tracking-tight">Ví Spot</h1>
        <div className="flex gap-2">
          <Link to="/trade" className="btn btn-brand h-9 rounded-lg px-4">
            Giao dịch
          </Link>
          <Link to="/lich-su" className="btn btn-ghost h-9 rounded-lg px-4">
            Lịch sử
          </Link>
        </div>
      </div>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="panel p-5">
          <div className="flex items-center gap-2 text-[13px] text-tx-3">
            Tổng tài sản ước tính
            <button onClick={toggleHidden} className="text-tx-3 hover:text-tx-1" aria-label={hidden ? 'Hiện số dư' : 'Ẩn số dư'}>
              {hidden ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <div className="num mt-1 flex flex-wrap items-baseline gap-2">
            <span className="text-[32px] font-bold tracking-tight">{mask(fmtUsd(live.total))}</span>
            <span className="text-[14px] text-tx-2">USDT</span>
            {btc > 0 && <span className="text-[13px] text-tx-3">≈ {mask((live.total / btc).toFixed(8))} BTC</span>}
          </div>
          <div className="num mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <div className="label">Lãi/lỗ hôm nay</div>
              {todayPnl == null ? (
                <div className="text-tx-3">--</div>
              ) : (
                <div className={cn('text-[15px] font-semibold', toneText[signTone(todayPnl)])}>{mask(`${todayPnl > 0 ? '+' : ''}${fmtUsd(todayPnl)}`)}</div>
              )}
            </div>
            <div>
              <div className="label">Lãi/lỗ từ đầu</div>
              <div className={cn('text-[15px] font-semibold', toneText[signTone(pnl)])}>
                {mask(`${pnl > 0 ? '+' : ''}${fmtUsd(pnl)}`)} <span className="text-[12px]">({fmtPct(pnlPct)})</span>
              </div>
            </div>
            <div>
              <div className="label">Vốn ảo đã nhận</div>
              <div className="text-[15px] font-semibold">{mask(fmtUsd(contributed))} USDT</div>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-bg-2 px-4 py-3">
            <div>
              <div className="text-[13px] font-medium">Trả phí bằng BNB</div>
              <div className="text-[12px] text-tx-3">
                Giảm 25% phí giao dịch (maker {new Big(account.makerFee).times(100).toFixed()}%, taker {new Big(account.takerFee).times(100).toFixed()}%). Cần có BNB trong
                ví.
              </div>
            </div>
            <button
              role="switch"
              aria-checked={account.payFeeWithBnb}
              onClick={() => void setBnb(!account.payFeeWithBnb)}
              className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', account.payFeeWithBnb ? 'bg-brand' : 'bg-bg-4')}
              aria-label="Trả phí bằng BNB"
            >
              <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform', account.payFeeWithBnb ? 'translate-x-[22px]' : 'translate-x-0.5')} />
            </button>
          </div>
        </div>
        <div className="panel p-5">
          <div className="mb-3 text-[13px] font-semibold text-tx-2">Phân bổ tài sản</div>
          <AllocationDonut slices={slices} total={live.total} />
        </div>
      </section>

      <NavChart />

      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="font-semibold">Tài sản</h2>
          <label className="flex items-center gap-2 text-[12px] text-tx-2">
            <input type="checkbox" checked={hideSmall} onChange={(e) => setHideSmall(e.target.checked)} className="accent-[var(--brand)]" />
            Ẩn tài sản dưới 1 USDT
          </label>
        </div>
        {shown.length === 0 ? (
          <Empty title="Ví trống" />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl num w-full min-w-[760px] text-[13px]">
              <thead>
                <tr className="text-right">
                  <th className="px-4 py-2.5 text-left">Tài sản</th>
                  <th className="px-2">Tổng</th>
                  <th className="px-2">Khả dụng</th>
                  <th className="px-2">Đang khoá</th>
                  <th className="px-2">Giá vốn TB</th>
                  <th className="px-2">Giá hiện tại</th>
                  <th className="px-2">Giá trị (USDT)</th>
                  <th className="px-2">Lãi/lỗ chưa chốt</th>
                  <th className="px-4" />
                </tr>
              </thead>
              <tbody>
                {shown.map((b) => {
                  const r = rows[`${b.asset}USDT`];
                  return (
                    <tr key={b.asset} className="border-t border-line text-right hover:bg-bg-2">
                      <td className="px-4 py-3 text-left">
                        <span className="flex items-center gap-2.5">
                          <CoinIcon asset={b.asset} size={26} />
                          <span>
                            <span className="block font-semibold">{b.asset}</span>
                            <span className="block text-[11px] text-tx-3">{b.asset === 'USDT' ? 'TetherUS' : (r?.name ?? '')}</span>
                          </span>
                        </span>
                      </td>
                      <td className="px-2 font-medium">{mask(fmtQty(b.total, r?.filters.stepSize))}</td>
                      <td className="px-2">{mask(fmtQty(b.free, r?.filters.stepSize))}</td>
                      <td className="px-2 text-tx-2">{mask(fmtQty(b.locked, r?.filters.stepSize))}</td>
                      <td className="px-2 text-tx-2">{b.avgCost ? fmtPrice(b.avgCost, r?.filters.tickSize) : '--'}</td>
                      <td className="px-2">{b.asset === 'USDT' ? '1.00' : r ? fmtPrice(r.last, r.filters.tickSize) : '--'}</td>
                      <td className="px-2 font-medium">{mask(fmtUsd(b.value))}</td>
                      <td className={cn('px-2', b.pnl != null ? toneText[signTone(b.pnl)] : 'text-tx-3')}>
                        {b.pnl != null ? (
                          <>
                            {mask(`${b.pnl > 0 ? '+' : ''}${fmtUsd(b.pnl)}`)}
                            <span className="block text-[11px]">{fmtPct(b.pnlPct ?? 0)}</span>
                          </>
                        ) : (
                          '--'
                        )}
                      </td>
                      <td className="px-4">
                        {r && (
                          <Link to={`/trade/${r.symbol}`} className="text-[12px] font-semibold text-brand hover:underline">
                            Giao dịch
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
