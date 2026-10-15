import { PHASE_LABEL, type SessionPhase } from '@vss/shared';
import { AUDIT_LABEL, auditSummary, fmtBytes, fmtDuration, useAdminOverview } from '../../lib/admin';
import { cn, fmtCompact, fmtDateTimeVN, fmtInt, fmtPct, fmtVnd, signTone, toneText } from '../../lib/format';
import { Empty, Spinner } from '../common/ui';
import { KeyValue, Kpi, Pill, Section } from './adminUi';

export function Overview({ onOpenUser, goTab }: { onOpenUser(id: string): void; goTab(t: string): void }) {
  const { data, isLoading } = useAdminOverview();
  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }
  const o = data.orders;
  const totalOrders = Object.values(o).reduce((a, b) => a + b, 0);
  const h = data.health;
  return (
    <div className="space-y-3">
      {(data.status.tradingHalted || data.status.announcement) && (
        <div className="panel flex flex-wrap items-center gap-3 border-ref/40 p-3 text-[13px]">
          {data.status.tradingHalted && (
            <span className="text-down">
              <b>Đang tạm ngừng nhận lệnh</b> — {data.status.haltReason}
            </span>
          )}
          {data.status.announcement && <span className="text-tx-2">Thông báo đang hiển thị: “{data.status.announcement.text}”</span>}
          <button className="ml-auto text-brand hover:underline" onClick={() => goTab('market')}>
            Quản lý vận hành →
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        <Kpi label="Người dùng" value={fmtInt(data.users.total)} sub={`+${data.users.new7d} trong 7 ngày · ${data.users.admins} quản trị`} />
        <Kpi label="Đang trực tuyến" value={fmtInt(data.users.online)} sub={`${data.users.connections} kết nối · ${data.users.active15m} hoạt động 15 phút`} tone="text-up" />
        <Kpi label="Lệnh hôm nay" value={fmtInt(totalOrders)} sub={`khớp ${o.FILLED ?? 0} · chờ ${(o.PENDING ?? 0) + (o.PARTIAL ?? 0)} · huỷ ${o.CANCELLED ?? 0}`} />
        <Kpi label="Giá trị khớp hôm nay" value={fmtCompact(data.trades.value)} sub={`${fmtInt(data.trades.n)} lần khớp`} />
        <Kpi label="Phí + thuế thu (ảo)" value={fmtCompact(data.trades.fee + data.trades.tax)} sub={`phí ${fmtVnd(data.trades.fee)} · thuế ${fmtVnd(data.trades.tax)}`} />
        <Kpi
          label="Tài khoản bị khoá"
          value={fmtInt(data.users.locked)}
          sub="bấm mục Người dùng để xem"
          tone={data.users.locked ? 'text-down' : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Section title={`Xếp hạng nhà đầu tư theo % lãi/lỗ · tổng NAV hệ thống ${fmtCompact(data.totalNav)}`} pad={false}>
          {data.topInvestors.length === 0 ? (
            <Empty title="Chưa có nhà đầu tư" />
          ) : (
            <table className="tbl num w-full text-[12.5px]">
              <thead>
                <tr className="h-9 text-left">
                  <th className="px-4">#</th>
                  <th className="px-2">Nhà đầu tư</th>
                  <th className="px-2 text-right">NAV</th>
                  <th className="px-2 text-right">Lãi / lỗ</th>
                  <th className="px-4 text-right">%</th>
                </tr>
              </thead>
              <tbody>
                {data.topInvestors.map((u, i) => (
                  <tr key={u.id} className="h-10 cursor-pointer border-t border-line hover:bg-bg-2" onClick={() => onOpenUser(u.id)}>
                    <td className="px-4 text-tx-3">{i + 1}</td>
                    <td className="px-2">
                      <div className="font-medium">{u.fullName}</div>
                      <div className="text-[11px] text-tx-3">{u.email}</div>
                    </td>
                    <td className="px-2 text-right">{fmtVnd(u.nav)}</td>
                    <td className={cn('px-2 text-right', toneText[signTone(u.pnl)])}>
                      {u.pnl > 0 ? '+' : ''}
                      {fmtVnd(u.pnl)}
                    </td>
                    <td className={cn('px-4 text-right font-semibold', toneText[signTone(u.pnl)])}>{fmtPct(u.pnlPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section
          title="Sức khoẻ hệ thống"
          actions={h.phase === 'CONTINUOUS' ? <Pill tone="good">Đang giao dịch</Pill> : <Pill tone="warn">{PHASE_LABEL[h.phase as SessionPhase] ?? h.phase}</Pill>}
        >
          <KeyValue
            cols={1}
            items={[
              ['Trạng thái phiên', PHASE_LABEL[h.phase as SessionPhase] ?? h.phase],
              ['Chế độ thị trường', h.mode === 'REAL_HOURS' ? 'Theo giờ thật' : 'Mô phỏng 24/7'],
              ['Nguồn giá', `${h.provider} · ${h.feed === 'LIVE' ? 'giá thật' : 'giả lập'}`],
              ['Ngày giao dịch', data.tradeDate],
              ['Thời gian chạy', fmtDuration(h.uptimeSec)],
              ['Bộ nhớ tiến trình', fmtBytes(h.rssBytes)],
              ['Cơ sở dữ liệu', `${h.dbKind === 'postgres' ? 'PostgreSQL' : 'PGlite nhúng'} · ${fmtBytes(h.dbBytes)}`],
              ['Lệnh đang chờ khớp', fmtInt(h.openOrders)],
              ['Node.js', h.node],
              ['Nhận lệnh', data.status.tradingHalted ? <span className="text-down">Tạm ngừng</span> : <span className="text-up">Bình thường</span>],
            ]}
          />
        </Section>
      </div>

      <Section
        title="Thao tác quản trị gần đây"
        actions={
          <button className="text-[12px] text-brand hover:underline" onClick={() => goTab('logs')}>
            Xem toàn bộ nhật ký →
          </button>
        }
        pad={false}
      >
        {data.recentAudit.length === 0 ? (
          <Empty title="Chưa có thao tác nào" />
        ) : (
          <ul className="divide-y divide-line">
            {data.recentAudit.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-[12.5px]">
                <span className="num w-32 text-tx-3">{fmtDateTimeVN(a.created_at)}</span>
                <Pill tone="brand">{AUDIT_LABEL[a.action] ?? a.action}</Pill>
                <span className="min-w-0 flex-1 truncate text-tx-2">{auditSummary(a)}</span>
                <span className="text-[11px] text-tx-3">{a.admin_email}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
