import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, Store } from 'lucide-react';
import { BANK_NAMES, P2P_ASSETS, type P2PAdDTO, type P2PAsset } from '@vss/shared';
import { CoinIcon } from '../components/common/CoinIcon';
import { Empty, Spinner } from '../components/common/ui';
import { OrderDialog } from '../components/p2p/OrderDialog';
import { P2PNav, TraderCell } from '../components/p2p/common';
import { cleanDecimal, cn } from '../lib/format';
import { fmtCoin, fmtVndNum, useMyMerchant, useP2PAds, useP2PConfig } from '../lib/p2p';
import { useLoggedIn } from '../lib/queries';
import { useAuth } from '../store/auth';
import { useMyKyc } from '../lib/kyc';

/** Chợ P2P kiểu Binance: mua / bán coin với thương nhân đã xác minh bằng VNĐ (ngân hàng giả lập) */
export default function P2PPage() {
  const loggedIn = useLoggedIn();
  // Nhân viên không giao dịch P2P (tránh xung đột lợi ích khi xử lý khiếu nại); máy chủ cũng chặn
  const staff = useAuth((s) => !!s.user?.role && s.user.role !== 'USER');
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [asset, setAsset] = useState<P2PAsset>('USDT');
  const [amount, setAmount] = useState('');
  const [bank, setBank] = useState('');
  const [open, setOpen] = useState<P2PAdDTO | null>(null);
  const { data: config } = useP2PConfig();
  const { data: me } = useMyMerchant();
  const { data: kyc } = useMyKyc();
  const fiat = amount ? String(Math.floor(Number(amount))) : undefined;
  const { data: ads, isLoading } = useP2PAds({ side, asset, fiatAmount: fiat, bank: bank || undefined });

  useEffect(() => {
    document.title = 'P2P · VNCoin';
    return () => void (document.title = 'VNCoin · Sàn giao dịch coin mô phỏng');
  }, []);

  const ref = config?.refPrices[asset];
  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-bold tracking-tight">Giao dịch P2P</h1>
          <p className="mt-1 max-w-[70ch] text-[13px] text-tx-2">
            Mua bán coin trực tiếp với thương nhân đã được sàn xác minh. Coin của bên bán được sàn giữ ký quỹ tới khi bên bán xác nhận đã nhận tiền. Tiền VNĐ
            chuyển qua ngân hàng giả lập.
          </p>
        </div>
        <P2PNav />
      </div>

      {loggedIn && !staff && kyc && kyc.level === 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-brand/30 bg-brand/8 px-4 py-2.5 text-[13px]">
          <ShieldCheck size={16} className="shrink-0 text-brand" />
          <span>Xác minh danh tính (KYC cấp 1) để mua bán P2P. Thông tin khai báo giả lập, duyệt bởi bộ phận Tuân thủ.</span>
          <Link to="/xac-minh" className="font-semibold text-brand hover:underline">
            Xác minh ngay
          </Link>
        </div>
      )}
      {loggedIn && !staff && kyc && kyc.level > 0 && (
        <p className="mt-3 text-[12px] text-tx-3">
          Hạn mức P2P hôm nay theo KYC cấp {kyc.level}: đã dùng <span className="num text-tx-2">{fmtVndNum(kyc.p2pUsedToday)}</span> /{' '}
          <span className="num text-tx-2">{fmtVndNum(kyc.p2pDailyLimit)} ₫</span>
          {kyc.level < 2 && (
            <>
              {' · '}
              <Link to="/xac-minh" className="text-brand hover:underline">
                Tăng hạn mức
              </Link>
            </>
          )}
        </p>
      )}
      {me?.blockedUntil && (
        <div role="alert" className="mt-4 rounded-md border border-down/30 bg-down/10 px-4 py-2.5 text-[13px] text-down">
          Bạn đã huỷ {me.cancelsToday} đơn hôm nay. Chức năng P2P bị khoá tới {new Date(me.blockedUntil).toLocaleString('vi-VN')}.
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg bg-bg-2 p-1" role="tablist" aria-label="Mua hoặc bán">
          {(['BUY', 'SELL'] as const).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={side === s}
              onClick={() => setSide(s)}
              className={cn(
                'h-8 rounded-md px-5 text-[13px] font-semibold transition-colors',
                side === s ? (s === 'BUY' ? 'bg-up text-white' : 'bg-down text-white') : 'text-tx-2 hover:text-tx-1',
              )}
            >
              {s === 'BUY' ? 'Mua' : 'Bán'}
            </button>
          ))}
        </div>
        <div className="flex gap-1" role="tablist" aria-label="Chọn coin">
          {P2P_ASSETS.map((a) => (
            <button
              key={a}
              role="tab"
              aria-selected={asset === a}
              onClick={() => setAsset(a)}
              className={cn('flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium', asset === a ? 'bg-bg-3 text-tx-1' : 'text-tx-3 hover:text-tx-1')}
            >
              <CoinIcon asset={a} size={16} />
              {a}
            </button>
          ))}
        </div>
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          <div className="relative w-full sm:w-56">
            <input
              className="input num pr-12"
              inputMode="numeric"
              placeholder="Số tiền muốn giao dịch"
              aria-label="Lọc theo số tiền VNĐ"
              value={amount}
              onChange={(e) => setAmount(cleanDecimal(e.target.value).split('.')[0]!)}
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-tx-3">VNĐ</span>
          </div>
          <select className="input w-full sm:w-44" value={bank} onChange={(e) => setBank(e.target.value)} aria-label="Lọc theo ngân hàng">
            <option value="">Mọi ngân hàng</option>
            {BANK_NAMES.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </div>
      </div>

      {ref && (
        <p className="mt-3 text-[12px] text-tx-3">
          Giá tham chiếu: <span className="num text-tx-2">{fmtVndNum(ref)} ₫</span> / {asset} (giá Binance × tỷ giá {fmtVndNum(config?.rules.usdtVnd)} ₫ / USDT do sàn đặt)
        </p>
      )}

      <div className="panel mt-3 overflow-hidden">
        <div className="hidden grid-cols-[minmax(0,2.2fr)_1.2fr_1.8fr_1.4fr_auto] gap-4 border-b border-line px-4 py-2.5 text-[12px] text-tx-3 md:grid">
          <span>Thương nhân</span>
          <span>Giá</span>
          <span>Khả dụng / Hạn mức</span>
          <span>Thanh toán</span>
          <span className="w-24 text-right">Giao dịch</span>
        </div>
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : !ads?.length ? (
          <Empty
            icon={<Store size={28} strokeWidth={1.5} />}
            title="Chưa có quảng cáo phù hợp"
            hint={fiat || bank ? 'Thử bỏ lọc số tiền hoặc ngân hàng.' : 'Thương nhân chưa đăng quảng cáo cho coin này.'}
          />
        ) : (
          <ul className="divide-y divide-line">
            {ads.map((ad) => (
              <li key={ad.id} className="grid grid-cols-1 gap-3 px-4 py-3.5 hover:bg-bg-2 md:grid-cols-[minmax(0,2.2fr)_1.2fr_1.8fr_1.4fr_auto] md:items-center md:gap-4">
                <TraderCell t={ad.merchant} />
                <div>
                  <span className="num text-[17px] font-semibold">{fmtVndNum(ad.price)}</span> <span className="text-[12px] text-tx-3">₫</span>
                  {ad.priceType === 'FLOATING' && <div className="text-[11px] text-tx-3">Thả nổi {ad.floatRatio}%</div>}
                </div>
                <div className="text-[12px]">
                  <div>
                    <span className="text-tx-3">Khả dụng </span>
                    <span className="num">
                      {fmtCoin(ad.availableQty)} {ad.asset}
                    </span>
                  </div>
                  <div>
                    <span className="text-tx-3">Hạn mức </span>
                    <span className="num">
                      {fmtVndNum(ad.limitMin)} – {fmtVndNum(ad.limitMax)} ₫
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {ad.banks.map((b) => (
                    <span key={b} className="chip bg-bg-3 text-tx-2">
                      {b}
                    </span>
                  ))}
                </div>
                <div className="md:w-24 md:text-right">
                  {staff ? (
                    <span className="text-[11px] text-tx-3">Nhân viên không giao dịch P2P</span>
                  ) : loggedIn ? (
                    <button className={cn('btn h-8 w-full md:w-auto', side === 'BUY' ? 'btn-up' : 'btn-down')} disabled={!!me?.blockedUntil} onClick={() => setOpen(ad)}>
                      {side === 'BUY' ? 'Mua' : 'Bán'} {ad.asset}
                    </button>
                  ) : (
                    <Link to="/login" state={{ from: '/p2p' }} className="btn btn-ghost h-8 w-full md:w-auto">
                      Đăng nhập
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-3">
        {[
          ['1. Đặt đơn', 'Chọn quảng cáo, nhập số tiền. Coin của bên bán lập tức được sàn giữ ký quỹ.'],
          ['2. Chuyển khoản', 'Người mua chuyển đúng số tiền, ghi mã đơn trong nội dung, rồi bấm "Tôi đã thanh toán".'],
          ['3. Nhận coin', 'Bên bán kiểm tra tiền về và nhả coin. Có tranh chấp thì khiếu nại để nhân viên phân xử.'],
        ].map(([t, d]) => (
          <div key={t} className="rounded-lg border border-line p-4">
            <div className="font-semibold">{t}</div>
            <p className="mt-1 text-[12px] text-tx-2">{d}</p>
          </div>
        ))}
      </div>
      {loggedIn && me && me.status !== 'ACTIVE' && (
        <Link to="/p2p/thuong-nhan" className="mt-4 flex items-center gap-2 text-[13px] font-semibold text-brand hover:underline">
          <ShieldCheck size={16} /> Muốn tự đăng quảng cáo? Đăng ký trở thành thương nhân
        </Link>
      )}

      <OrderDialog ad={open} onClose={() => setOpen(null)} />
    </div>
  );
}
