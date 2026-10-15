import { useEffect, useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { CandleChart } from '../components/chart/CandleChart';
import { Spinner, UnderlineTabs } from '../components/common/ui';
import { OrderBook, TradeTape } from '../components/trade/OrderBook';
import { OrderForm } from '../components/trade/OrderForm';
import { OrdersPanel } from '../components/trade/OrdersPanel';
import { SymbolHeader } from '../components/trade/SymbolHeader';
import { SymbolList } from '../components/trade/SymbolList';
import { useMarket } from '../store/market';
import { useTicket } from '../store/ui';

const LAST_KEY = 'vss-last-symbol';

export default function TradePage() {
  const { symbol: raw } = useParams();
  const [params] = useSearchParams();
  const symbol = raw?.toUpperCase();
  const loaded = useMarket((s) => s.loaded);
  const exists = useMarket((s) => (symbol ? !!s.rows[symbol] : false));
  const [rightTab, setRightTab] = useState<'book' | 'tape'>('book');

  useEffect(() => {
    if (symbol && exists) {
      try {
        localStorage.setItem(LAST_KEY, symbol);
      } catch {
        /* bỏ qua */
      }
      document.title = `${symbol} · Giao dịch · VNStock`;
    }
    return () => {
      document.title = 'VNStock · Bảng giá & Giao dịch mô phỏng';
    };
  }, [symbol, exists]);

  useEffect(() => {
    const side = params.get('side');
    if (side === 'BUY' || side === 'SELL') useTicket.getState().setSide(side);
  }, [params, symbol]);

  if (!symbol) {
    let last = 'FPT';
    try {
      last = localStorage.getItem(LAST_KEY) || 'FPT';
    } catch {
      /* bỏ qua */
    }
    return <Navigate to={`/trade/${last}`} replace />;
  }
  if (!loaded) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!exists) return <Navigate to="/trade/FPT" replace />;

  return (
    <div className="grid flex-1 grid-cols-1 gap-2 p-2 xl:h-[calc(100vh-56px-28px)] xl:min-h-[720px] xl:grid-cols-[minmax(0,1fr)_300px_330px] xl:grid-rows-[auto_minmax(0,1fr)_280px]">
      <section className="panel xl:col-span-3" aria-label="Thông tin mã">
        <SymbolHeader symbol={symbol} />
      </section>

      <section className="panel flex h-[480px] min-h-0 flex-col xl:h-auto" aria-label="Biểu đồ">
        <CandleChart symbol={symbol} className="flex-1" />
      </section>

      <section className="panel flex min-h-0 flex-col xl:row-span-2" aria-label="Sổ lệnh và khớp lệnh">
        <UnderlineTabs
          value={rightTab}
          onChange={setRightTab}
          items={[
            { value: 'book', label: 'Sổ lệnh' },
            { value: 'tape', label: 'Khớp lệnh' },
          ]}
        />
        {rightTab === 'book' ? (
          <>
            <OrderBook symbol={symbol} />
            <div className="border-t border-line text-[12px] font-medium text-tx-2">
              <div className="px-3 pt-2">Khớp gần nhất</div>
            </div>
            <div className="flex min-h-[200px] flex-1 flex-col">
              <TradeTape symbol={symbol} />
            </div>
          </>
        ) : (
          <div className="flex min-h-[400px] flex-1 flex-col">
            <TradeTape symbol={symbol} />
          </div>
        )}
      </section>

      <section className="panel flex min-h-0 flex-col xl:row-span-2" aria-label="Đặt lệnh">
        <OrderForm symbol={symbol} />
        <div className="flex min-h-[260px] flex-1 flex-col border-t border-line">
          <SymbolList current={symbol} />
        </div>
      </section>

      <section className="panel flex min-h-[280px] flex-col" aria-label="Lệnh và danh mục">
        <OrdersPanel symbol={symbol} />
      </section>
    </div>
  );
}
