import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { CandleChart } from '../components/chart/CandleChart';
import { Spinner, UnderlineTabs } from '../components/common/ui';
import { OrderBook, TradeTape } from '../components/trade/OrderBook';
import { OrderForm } from '../components/trade/OrderForm';
import { OrdersPanel } from '../components/trade/OrdersPanel';
import { AlertButton } from '../components/trade/PriceAlerts';
import { SymbolHeader } from '../components/trade/SymbolHeader';
import { SymbolList } from '../components/trade/SymbolList';
import { fmtPrice } from '../lib/format';
import { useMarket } from '../store/market';

const LAST_KEY = 'vss-last-symbol';
const DEFAULT = 'BTCUSDT';

/** Màn giao dịch Spot bố cục kiểu Binance: sổ lệnh | biểu đồ + đặt lệnh | danh sách cặp + giao dịch thị trường */
export default function TradePage() {
  const { symbol: raw } = useParams();
  const symbol = raw?.toUpperCase();
  const loaded = useMarket((s) => s.loaded);
  const row = useMarket((s) => (symbol ? s.rows[symbol] : undefined));
  const [mobileTab, setMobileTab] = useState<'chart' | 'book' | 'trades'>('chart');

  useEffect(() => {
    if (symbol && row) {
      try {
        localStorage.setItem(LAST_KEY, symbol);
      } catch {
        /* bỏ qua */
      }
    }
  }, [symbol, row]);

  // Tiêu đề tab hiển thị giá như Binance: "82,035.10 | BTCUSDT | VNCoin"
  useEffect(() => {
    if (!row) return;
    document.title = `${fmtPrice(row.last, row.filters.tickSize)} | ${row.baseAsset}/${row.quoteAsset} | VNCoin`;
  }, [row?.last, row]);
  useEffect(() => () => void (document.title = 'VNCoin · Sàn giao dịch coin mô phỏng'), []);

  if (!symbol) {
    let last = DEFAULT;
    try {
      last = localStorage.getItem(LAST_KEY) || DEFAULT;
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
  if (!row) return <Navigate to={`/trade/${DEFAULT}`} replace />;

  return (
    <div className="grid flex-1 grid-cols-1 gap-1 bg-bg-0 p-1 xl:grid-cols-[300px_minmax(0,1fr)_310px] xl:grid-rows-[auto_520px_auto_minmax(280px,auto)]">
      <section className="panel flex items-center pr-3 xl:col-span-3" aria-label="Thông tin cặp">
        <div className="min-w-0 flex-1">
          <SymbolHeader symbol={symbol} />
        </div>
        <AlertButton symbol={symbol} />
      </section>

      {/* Màn hẹp: chuyển tab Biểu đồ / Sổ lệnh / Giao dịch */}
      <div className="panel xl:hidden">
        <UnderlineTabs
          value={mobileTab}
          onChange={setMobileTab}
          items={[
            { value: 'chart', label: 'Biểu đồ' },
            { value: 'book', label: 'Sổ lệnh' },
            { value: 'trades', label: 'Giao dịch' },
          ]}
        />
      </div>

      <section className={`panel min-h-0 flex-col xl:row-span-2 xl:flex ${mobileTab === 'book' ? 'flex' : 'hidden'}`} aria-label="Sổ lệnh">
        <OrderBook symbol={symbol} />
      </section>

      <section className={`panel h-[440px] min-h-0 flex-col xl:flex xl:h-auto ${mobileTab === 'chart' ? 'flex' : 'hidden'}`} aria-label="Biểu đồ">
        <CandleChart symbol={symbol} className="flex-1" />
      </section>

      <section className="panel hidden min-h-0 flex-col xl:flex" aria-label="Danh sách cặp">
        <SymbolList current={symbol} />
      </section>

      <section className="panel" aria-label="Đặt lệnh">
        <OrderForm symbol={symbol} />
      </section>

      <section className={`panel min-h-[320px] flex-col xl:flex ${mobileTab === 'trades' ? 'flex' : 'hidden'}`} aria-label="Giao dịch thị trường">
        <div className="px-3 pt-2 text-[13px] font-semibold">Giao dịch thị trường</div>
        <TradeTape symbol={symbol} />
      </section>

      <section className="panel flex min-h-[280px] flex-col xl:col-span-3" aria-label="Lệnh và tài sản">
        <OrdersPanel symbol={symbol} />
      </section>
    </div>
  );
}
