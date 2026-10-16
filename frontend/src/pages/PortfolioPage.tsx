import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, RotateCcw } from 'lucide-react';
import { Empty, Spinner } from '../components/common/ui';
import { AccountSettingsModal } from '../components/layout/AccountSettingsModal';
import { AllocationDonut, PALETTE, type Slice } from '../components/portfolio/AllocationDonut';
import { EntitlementsPanel } from '../components/portfolio/Entitlements';
import { NavChart } from '../components/portfolio/NavChart';
import { SideChip } from '../components/trade/OrdersPanel';
import { cn, fmtCompact, fmtDateTimeVN, fmtInt, fmtPct, fmtPrice, fmtVnd, priceTone, signTone, toneText } from '../lib/format';
import { navOfAccount, usePortfolio, useTrades } from '../lib/queries';
import { CashMarginPanel } from '../components/portfolio/CashMargin';
import { useMarket } from '../store/market';

function Card({ label, value, sub, tone, big }: { label: string; value: string; sub?: string; tone?: string; big?: boolean }) {
  return (
    <div className="panel p-4">
      <div className="label">{label}</div>
      <div className={cn('num mt-1 font-bold', big ? 'text-[24px]' : 'text-[18px]', tone)}>{value}</div>
      {sub && <div className={cn('num mt-0.5 text-[12px]', tone ?? 'text-tx-3')}>{sub}</div>}
    </div>
  );
}

export default function PortfolioPage() {
  const { data, isLoading } = usePortfolio();
  const { data: trades } = useTrades();
  const rows = useMarket((s) => s.rows);
  const nav = useNavigate();
  const [resetOpen, setResetOpen] = useState(false);

  const view = useMemo(() => {
    if (!data) return null;
    const items = data.holdings.map((h) => {
      const r = rows[h.symbol];
      const price = r ? (r.volume ? r.last : r.ref) : h.marketPrice;
      const value = price * h.qtyTotal;
      const pnl = value - h.totalCost;
      const dayChange = r && r.volume ? (r.last - r.ref) * h.qtyTotal : 0;
      return { ...h, r, price, value, pnl, pnlPct: h.totalCost ? (pnl / h.totalCost) * 100 : 0, dayChange };
    });
    const stockValue = items.reduce((a, x) => a + x.value, 0);
    const unrealized = items.reduce((a, x) => a + x.pnl, 0);
    const dayChange = items.reduce((a, x) => a + x.dayChange, 0);
    const nav_ = navOfAccount(data.account, stockValue);
    const totalPnl = nav_ - (data.account.contributed ?? data.account.initialCapital);
    return { items: items.sort((a, b) => b.value - a.value), stockValue, unrealized, dayChange, nav: nav_, totalPnl };
  }, [data, rows]);

  if (isLoading || !data || !view) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const { account } = data;
  const slices: Slice[] = view.items.slice(0, 9).map((x, i) => ({ label: x.symbol, value: x.value, color: PALETTE[i] }));
  const others = view.items.slice(9).reduce((a, x) => a + x.value, 0);
  if (others > 0) slices.push({ label: 'Khác', value: others, color: PALETTE[9] });
  slices.push({ label: 'Tiền mặt & chờ về', value: account.cashBalance + (account.cashPending ?? 0), color: PALETTE[10] });
  const totalTone = toneText[signTone(view.totalPnl)];

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-[20px] font-bold">Tài sản của tôi</h1>
          <p className="text-[12px] text-tx-3">Định giá theo giá khớp gần nhất, cập nhật realtime</p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-ghost" onClick={() => setResetOpen(true)}>
            <RotateCcw size={15} /> Đặt lại tài khoản
          </button>
          <Link to="/trade" className="btn btn-brand">
            Giao dịch ngay
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card
          label="Tài sản ròng (NAV)"
          value={`${fmtVnd(view.nav)}đ`}
          sub={`${view.totalPnl >= 0 ? '+' : ''}${fmtVnd(view.totalPnl)}đ (${fmtPct((view.totalPnl / (account.contributed ?? account.initialCapital)) * 100)}) so với vốn đã góp`}
          tone={totalTone}
          big
        />
        <Card label="Giá trị cổ phiếu" value={`${fmtVnd(view.stockValue)}đ`} sub={`Biến động hôm nay ${view.dayChange >= 0 ? '+' : ''}${fmtVnd(view.dayChange)}đ`} />
        <Card label="Tiền mặt" value={`${fmtVnd(account.cashBalance)}đ`} sub={`Phong toả ${fmtVnd(account.cashHold)}đ · chờ về ${fmtVnd(account.cashPending ?? 0)}đ`} />
        <Card
          label="Sức mua"
          value={`${fmtVnd(account.cashAvailable + (account.autoAdvance ? (account.advanceable ?? 0) : 0))}đ`}
          sub={account.marginEnabled ? 'Tiền khả dụng + ứng trước; cộng thêm vay ký quỹ theo từng mã' : 'Tiền mặt khả dụng + có thể ứng trước'}
        />
        <Card label="Lãi/lỗ chưa thực hiện" value={`${view.unrealized >= 0 ? '+' : ''}${fmtVnd(view.unrealized)}đ`} tone={toneText[signTone(view.unrealized)]} />
        <Card label="Lãi/lỗ đã thực hiện" value={`${data.realizedPnl >= 0 ? '+' : ''}${fmtVnd(data.realizedPnl)}đ`} tone={toneText[signTone(data.realizedPnl)]} />
        <Card label="Tổng phí giao dịch" value={`${fmtVnd(data.totalFees)}đ`} />
        <Card label="Tổng thuế bán" value={`${fmtVnd(data.totalTaxes)}đ`} />
      </div>

      <NavChart />

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="panel min-w-0 overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="font-semibold">Danh mục nắm giữ ({view.items.length})</h2>
            <span className="text-[12px] text-tx-3">Giá vốn đã bao gồm phí mua</span>
          </div>
          {view.items.length === 0 ? (
            <Empty title="Bạn chưa nắm giữ cổ phiếu nào" hint={<Link to="/trade" className="text-brand hover:underline">Đặt lệnh mua đầu tiên</Link>} />
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl num w-full min-w-[980px] text-[13px]">
                <thead>
                  <tr className="h-9 text-left">
                    <th className="px-4">Mã</th>
                    <th className="px-2 text-right">Tổng KL</th>
                    <th className="px-2 text-right">Khả dụng</th>
                    <th className="px-2 text-right">Chờ về</th>
                    <th className="px-2 text-right">Chờ bán</th>
                    <th className="px-2 text-right">Giá vốn</th>
                    <th className="px-2 text-right">Giá TT</th>
                    <th className="px-2 text-right">Giá trị vốn</th>
                    <th className="px-2 text-right">Giá trị TT</th>
                    <th className="px-2 text-right">Lãi/lỗ</th>
                    <th className="px-2 text-right">%</th>
                    <th className="px-4 text-right" />
                  </tr>
                </thead>
                <tbody>
                  {view.items.map((x) => {
                    const t = toneText[signTone(x.pnl)];
                    return (
                      <tr key={x.symbol} className="h-11 border-t border-line hover:bg-bg-2">
                        <td className="px-4">
                          <button className="text-left" onClick={() => nav(`/trade/${x.symbol}`)}>
                            <div className="font-semibold hover:text-brand">{x.symbol}</div>
                            <div className="max-w-[160px] truncate text-[11px] text-tx-3">{x.r?.name}</div>
                          </button>
                        </td>
                        <td className="px-2 text-right">{fmtInt(x.qtyTotal)}</td>
                        <td className="px-2 text-right">{fmtInt(x.qtyAvailable)}</td>
                        <td className="px-2 text-right text-tx-3">{fmtInt(x.qtyPending)}</td>
                        <td className="px-2 text-right text-tx-3">{fmtInt(x.qtyHold)}</td>
                        <td className="px-2 text-right">{fmtPrice(x.avgCost)}</td>
                        <td className={cn('px-2 text-right font-medium', x.r && toneText[priceTone(x.price, x.r.ref, x.r.ceil, x.r.floor)])}>{fmtPrice(x.price)}</td>
                        <td className="px-2 text-right">{fmtVnd(x.totalCost)}</td>
                        <td className="px-2 text-right">{fmtVnd(x.value)}</td>
                        <td className={cn('px-2 text-right font-medium', t)}>
                          {x.pnl >= 0 ? '+' : ''}
                          {fmtVnd(x.pnl)}
                        </td>
                        <td className={cn('px-2 text-right font-medium', t)}>{fmtPct(x.pnlPct)}</td>
                        <td className="px-4 text-right">
                          <span className="inline-flex gap-1">
                            <button onClick={() => nav(`/trade/${x.symbol}?side=BUY`)} className="chip bg-up/15 text-up hover:bg-up/25">
                              Mua
                            </button>
                            <button onClick={() => nav(`/trade/${x.symbol}?side=SELL`)} className="chip bg-down/15 text-down hover:bg-down/25">
                              Bán
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="space-y-3">
          <section className="panel p-4">
            <h2 className="mb-3 font-semibold">Phân bổ tài sản</h2>
            <AllocationDonut slices={slices} total={view.nav} />
          </section>
          <CashMarginPanel a={account} />
          <EntitlementsPanel />
          <section className="panel overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="font-semibold">Khớp lệnh gần đây</h2>
              <Link to="/history" className="text-[12px] text-brand hover:underline">
                Xem tất cả
              </Link>
            </div>
            {trades?.length ? (
              <ul className="divide-y divide-line">
                {trades.slice(0, 8).map((t) => (
                  <li key={t.id} className="num flex items-center gap-3 px-4 py-2.5">
                    <span className={cn('flex h-8 w-8 items-center justify-center rounded-full', t.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>
                      {t.side === 'BUY' ? <ArrowDownRight size={16} /> : <ArrowUpRight size={16} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <b>{t.symbol}</b> <SideChip side={t.side} />
                      </div>
                      <div className="text-[11px] text-tx-3">{fmtDateTimeVN(t.executedAt)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[13px] font-medium">
                        {fmtInt(t.qty)} @ {fmtPrice(t.price)}
                      </div>
                      <div className={cn('text-[11px]', t.realizedPnl != null ? toneText[signTone(t.realizedPnl)] : 'text-tx-3')}>
                        {t.realizedPnl != null ? `${t.realizedPnl >= 0 ? '+' : ''}${fmtCompact(t.realizedPnl)}` : fmtCompact(t.value)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="Chưa có giao dịch" />
            )}
          </section>
        </div>
      </div>
      <AccountSettingsModal open={resetOpen} onClose={() => setResetOpen(false)} initialTab="reset" />
    </div>
  );
}
