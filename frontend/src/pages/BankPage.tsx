import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Landmark, Send } from 'lucide-react';
import { CopyButton, P2PNav } from '../components/p2p/common';
import { TransferDialog } from '../components/p2p/TransferDialog';
import { Empty, Spinner } from '../components/common/ui';
import { cn, fmtDateTime } from '../lib/format';
import { fmtVndNum, useBank, useBankStatement } from '../lib/p2p';

/** Ngân hàng giả lập: tiền VNĐ ảo nằm ngoài sàn, dùng để thanh toán đơn P2P */
export default function BankPage() {
  const { data: bank, isLoading } = useBank();
  const { data: rows } = useBankStatement();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    document.title = 'Ngân hàng giả lập · VNCoin';
    return () => void (document.title = 'VNCoin · Sàn giao dịch coin mô phỏng');
  }, []);

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-[26px] font-bold tracking-tight">Ngân hàng giả lập</h1>
        <P2PNav />
      </div>
      <p className="mt-1 max-w-[75ch] text-[13px] text-tx-2">
        Tài khoản VNĐ ảo bên ngoài sàn, giống app ngân hàng của bạn. Mua coin P2P thì chuyển khoản từ đây cho thương nhân; bán coin thì tiền về đây. Sàn
        không tự trừ hay cộng tiền ở đây.
      </p>

      {isLoading || !bank ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="mt-5 grid gap-3 md:grid-cols-[1.4fr_1fr]">
            <div className="rounded-xl border border-line bg-bg-1 p-5">
              <div className="flex items-center gap-2 text-[13px] text-tx-2">
                <Landmark size={16} className="text-brand" /> {bank.bankName}
              </div>
              <div className="num mt-3 text-[30px] font-bold leading-none">
                {fmtVndNum(bank.balanceVnd)} <span className="text-[16px] font-medium text-tx-3">₫</span>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px]">
                <div className="flex items-center gap-1">
                  <span className="text-tx-3">Số tài khoản</span>
                  <span className="num font-semibold">{bank.accountNo}</span>
                  <CopyButton value={bank.accountNo} label="số tài khoản" />
                </div>
                <div>
                  <span className="text-tx-3">Chủ tài khoản </span>
                  <span className="font-semibold">{bank.holderName}</span>
                </div>
              </div>
            </div>
            <div className="flex flex-col justify-between rounded-xl border border-line p-5">
              <p className="text-[13px] text-tx-2">Chuyển tiền cho tài khoản khác trong ngân hàng giả lập (vd. thanh toán đơn P2P).</p>
              <button className="btn btn-brand mt-3 self-start" onClick={() => setOpen(true)}>
                <Send size={15} /> Chuyển khoản
              </button>
            </div>
          </div>

          <h2 className="mt-7 text-[16px] font-semibold">Sao kê</h2>
          <div className="panel mt-2 overflow-x-auto">
            {!rows?.length ? (
              <Empty title="Chưa có giao dịch" />
            ) : (
              <table className="tbl w-full min-w-[640px] text-[13px]">
                <thead>
                  <tr className="text-left">
                    <th className="px-4 py-2.5">Thời gian</th>
                    <th className="px-4 py-2.5">Đối tác</th>
                    <th className="px-4 py-2.5">Nội dung</th>
                    <th className="px-4 py-2.5 text-right">Số tiền</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.id} className="border-t border-line">
                      <td className="whitespace-nowrap px-4 py-2.5 text-tx-2">{fmtDateTime(t.createdAt)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          {t.direction === 'IN' ? <ArrowDownLeft size={14} className="text-up" /> : <ArrowUpRight size={14} className="text-down" />}
                          <span>{t.counterpartyName}</span>
                          {t.counterpartyAccount && <span className="num text-[12px] text-tx-3">{t.counterpartyAccount}</span>}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-tx-2">{t.memo || '—'}</td>
                      <td className={cn('num whitespace-nowrap px-4 py-2.5 text-right font-semibold', t.direction === 'IN' ? 'text-up' : 'text-down')}>
                        {t.direction === 'IN' ? '+' : '−'}
                        {fmtVndNum(t.amount)} ₫
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
      <TransferDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
