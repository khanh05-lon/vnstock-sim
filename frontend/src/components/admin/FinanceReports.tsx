import { useState } from 'react';
import { RECON_ISSUE_LABEL, type ReconRunDTO } from '@vss/shared';
import { useAdminAction, useFeeRevenue, useReconRuns } from '../../lib/admin';
import { cn, fmtDateTime, fmtInt, fmtUsd } from '../../lib/format';
import { Empty, Spinner } from '../common/ui';
import { Kpi, Pill, Section } from './adminUi';

function RunIssues({ run }: { run: ReconRunDTO }) {
  if (!run.issues.length) return null;
  return (
    <table className="tbl mt-2 w-full text-[12px]">
      <thead>
        <tr className="h-7 text-left">
          <th className="px-2">Loại lệch</th>
          <th className="px-2">Tài khoản</th>
          <th className="px-2">Tài sản</th>
          <th className="px-2 text-right">Đúng ra (sổ cái / khớp lệnh)</th>
          <th className="px-2 text-right">Thực tế</th>
        </tr>
      </thead>
      <tbody>
        {run.issues.map((i, k) => (
          <tr key={k} className="border-t border-line">
            <td className="px-2 py-1.5 text-down">{RECON_ISSUE_LABEL[i.kind]}</td>
            <td className="px-2">{i.email ?? 'Toàn sàn'}</td>
            <td className="px-2">{i.asset}</td>
            <td className="num px-2 text-right">{i.expected}</td>
            <td className="num px-2 text-right">{i.actual}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Doanh thu phí theo ngày / theo cặp + kết quả đối soát số dư ↔ sổ cái ↔ khớp lệnh */
export function FinanceReports() {
  const [days, setDays] = useState(30);
  const rev = useFeeRevenue(days);
  const runs = useReconRuns();
  const act = useAdminAction();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const r = rev.data;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label={`Doanh thu phí ${days} ngày (USDT)`} value={r ? fmtUsd(r.totalFeeUsdt) : '…'} sub="Quy đổi USDT tại thời điểm khớp" />
        <Kpi label={`Khối lượng ${days} ngày (USDT)`} value={r ? fmtUsd(r.totalVolumeUsdt) : '…'} />
        <Kpi
          label="Đối soát gần nhất"
          value={runs.data?.[0] ? (runs.data[0].ok ? 'Khớp' : `${runs.data[0].issueCount} chỗ lệch`) : 'Chưa chạy'}
          tone={runs.data?.[0] && !runs.data[0].ok ? 'text-down' : runs.data?.[0] ? 'text-up' : undefined}
          sub={runs.data?.[0] ? fmtDateTime(runs.data[0].startedAt) : 'Tự chạy mỗi ngày'}
        />
      </div>

      <Section
        title="Đối soát số dư ↔ sổ cái ↔ khớp lệnh"
        pad={false}
        actions={
          <button
            className="btn btn-brand h-8"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await act('/admin/finance/reconciliations', 'POST', {}, 'Đã chạy đối soát');
              setBusy(false);
            }}
          >
            {busy ? 'Đang đối soát…' : 'Chạy đối soát ngay'}
          </button>
        }
      >
        <p className="border-b border-line px-4 py-2 text-[12px] text-tx-3">
          Mỗi tài sản của mỗi tài khoản: tổng sổ cái = số dư (khả dụng + đang khoá) = số dư sau dòng sổ cái cuối; không có tiền bị khoá khi không còn lệnh mở; tổng phí ghi sổ cái
          = tổng phí trong khớp lệnh. Tự chạy mỗi ngày; có lệch thì email Tài chính và Kiểm toán.
        </p>
        {runs.isLoading ? (
          <Spinner className="m-6" />
        ) : !runs.data?.length ? (
          <Empty title="Chưa có lần đối soát nào" />
        ) : (
          <div className="divide-y divide-line">
            {runs.data.map((x) => (
              <div key={x.id} className="px-4 py-2 text-[12.5px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-tx-3">#{x.id}</span>
                  <span>{fmtDateTime(x.startedAt)}</span>
                  <span className="text-tx-3">· {x.triggeredBy}</span>
                  <span className="text-tx-3">· {fmtInt(x.balancesChecked)} số dư</span>
                  {x.ok ? <Pill tone="good">Khớp</Pill> : <Pill tone="bad">{x.issueCount} chỗ lệch</Pill>}
                  {!x.ok && (
                    <button className="ml-auto text-[12px] text-brand hover:underline" onClick={() => setOpen(open === x.id ? null : x.id)}>
                      {open === x.id ? 'Ẩn chi tiết' : 'Xem chi tiết'}
                    </button>
                  )}
                </div>
                {open === x.id && <RunIssues run={x} />}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Doanh thu phí theo ngày (UTC)"
        pad={false}
        actions={
          <select className="input h-8 w-28" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Khoảng thời gian">
            {[7, 30, 90, 365].map((d) => (
              <option key={d} value={d}>
                {d} ngày
              </option>
            ))}
          </select>
        }
      >
        {rev.isLoading || !r ? (
          <Spinner className="m-6" />
        ) : !r.days.length ? (
          <Empty title="Chưa có giao dịch trong khoảng này" />
        ) : (
          <div className="grid gap-3 p-3 xl:grid-cols-[3fr_2fr]">
            <table className="tbl num w-full text-[12.5px]">
              <thead>
                <tr className="h-8 text-right">
                  <th className="px-2 text-left">Ngày</th>
                  <th className="px-2">Lần khớp</th>
                  <th className="px-2">Khối lượng</th>
                  <th className="px-2">Phí maker</th>
                  <th className="px-2">Phí taker</th>
                  <th className="px-2">Tổng phí</th>
                </tr>
              </thead>
              <tbody>
                {r.days.map((d) => (
                  <tr key={d.day} className="border-t border-line text-right">
                    <td className="px-2 py-1.5 text-left">{d.day}</td>
                    <td className="px-2">{fmtInt(d.fills)}</td>
                    <td className="px-2">{fmtUsd(d.volumeUsdt)}</td>
                    <td className="px-2 text-tx-2">{fmtUsd(d.makerFeeUsdt)}</td>
                    <td className="px-2 text-tx-2">{fmtUsd(d.takerFeeUsdt)}</td>
                    <td className="px-2 font-semibold">{fmtUsd(d.feeUsdt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="tbl num w-full text-[12.5px]">
              <thead>
                <tr className="h-8 text-right">
                  <th className="px-2 text-left">Cặp</th>
                  <th className="px-2">Lần khớp</th>
                  <th className="px-2">Phí</th>
                </tr>
              </thead>
              <tbody>
                {r.bySymbol.map((x) => (
                  <tr key={x.symbol} className={cn('border-t border-line text-right')}>
                    <td className="px-2 py-1.5 text-left">{x.symbol}</td>
                    <td className="px-2">{fmtInt(x.fills)}</td>
                    <td className="px-2 font-semibold">{fmtUsd(x.feeUsdt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
