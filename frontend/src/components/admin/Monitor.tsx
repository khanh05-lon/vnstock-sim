import { BellRing, CircleCheck, OctagonAlert, TriangleAlert } from 'lucide-react';
import { fmtDuration, useAdminAction, useAdminMonitor, type MonitorSample } from '../../lib/admin';
import { cn, fmtCompact, fmtDateTimeVN, fmtInt } from '../../lib/format';
import { Empty, Sparkline, Spinner } from '../common/ui';
import { Kpi, Pill, Section } from './adminUi';

function Trend({ label, data, unit, color, threshold }: { label: string; data: number[]; unit: string; color: string; threshold?: number }) {
  const last = data.at(-1) ?? 0;
  const max = data.length ? Math.max(...data) : 0;
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] text-tx-3">{label}</span>
        <span className="num text-[15px] font-semibold">
          {fmtInt(Math.round(last * 100) / 100)}
          <span className="ml-0.5 text-[11px] font-normal text-tx-3">{unit}</span>
        </span>
      </div>
      <Sparkline data={data.length > 1 ? data : [0, 0]} color={color} width={260} height={46} className="mt-2 w-full" baseline={threshold} />
      <div className="num mt-1 text-[11px] text-tx-3">
        Cao nhất 3 giờ: {fmtInt(Math.round(max * 100) / 100)} {unit}
        {threshold != null && ` · ngưỡng ${fmtInt(threshold)} ${unit}`}
      </div>
    </div>
  );
}

const pick = (s: MonitorSample[], k: keyof MonitorSample) => s.map((x) => Number(x[k] ?? 0));

export function Monitor() {
  const { data, isLoading } = useAdminMonitor();
  const act = useAdminAction();
  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }
  const n = data.now;
  const th = data.thresholds;
  const s = data.series;
  const crit = data.alerts.some((a) => a.level === 'critical');

  return (
    <div className="space-y-3">
      <div
        className={cn(
          'flex items-center gap-3 rounded-lg border px-4 py-3 text-[13px]',
          !data.alerts.length ? 'border-up/30 bg-up/10 text-up' : crit ? 'border-down/30 bg-down/10 text-down' : 'border-ref/30 bg-ref/10 text-ref',
        )}
      >
        {!data.alerts.length ? <CircleCheck size={18} /> : crit ? <OctagonAlert size={18} /> : <TriangleAlert size={18} />}
        <b>{!data.alerts.length ? 'Hệ thống hoạt động bình thường' : `${data.alerts.length} cảnh báo đang bật`}</b>
        <span className="text-tx-3">Tự kiểm tra mỗi 30 giây · đã chạy {fmtDuration(n.uptimeSec)}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Request / giây (5 phút)" value={n.rps.toFixed(2)} sub={`${fmtInt(n.requests5m)} request · ${n.errors5m} lỗi 5xx`} />
        <Kpi label="Độ trễ API p95" value={`${n.p95} ms`} sub={`p50 ${n.p50} ms · p99 ${n.p99} ms`} tone={n.p95 > th.p95Ms ? 'text-down' : undefined} />
        <Kpi label="CSDL" value={n.dbOk ? `${n.dbMs ?? '—'} ms` : 'MẤT KẾT NỐI'} sub="thời gian ping" tone={!n.dbOk ? 'text-down' : undefined} />
        <Kpi label="Kết nối realtime" value={fmtInt(n.sockets)} sub={`Nhịp giá gần nhất ${n.tickAgeSec ?? '—'} giây trước`} />
        <Kpi label="Event loop p99" value={`${n.eventLoopMs} ms`} sub={`ngưỡng ${th.eventLoopMs} ms`} tone={n.eventLoopMs > th.eventLoopMs ? 'text-down' : undefined} />
        <Kpi label="Bộ nhớ (RSS)" value={`${fmtInt(n.rssMb)} MB`} sub={`heap ${fmtInt(n.heapMb)} MB · ngưỡng ${fmtInt(th.rssMb)} MB`} />
        <Kpi label="Lệnh từ lúc khởi động" value={fmtInt(n.orders.placed)} sub={`huỷ ${fmtInt(n.orders.cancelled)} · đang chờ ${fmtInt(n.openOrders)}`} />
        <Kpi label="Khớp lệnh" value={fmtInt(n.orders.fills)} sub={`giá trị ${fmtCompact(n.orders.fillValue)}`} />
      </div>

      <Section title="Diễn biến 3 giờ gần nhất (mẫu mỗi phút)">
        {s.length < 2 ? (
          <Empty title="Đang thu thập số liệu" hint="Biểu đồ có dữ liệu sau vài phút máy chủ chạy." />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Trend label="Request / giây" data={pick(s, 'rps')} unit="req/s" color="var(--brand)" />
            <Trend label="Độ trễ API p95" data={pick(s, 'p95')} unit="ms" color="var(--info)" threshold={th.p95Ms} />
            <Trend label="Lỗi 5xx (5 phút)" data={pick(s, 'errors')} unit="lỗi" color="var(--down)" />
            <Trend label="Event loop p99" data={pick(s, 'eventLoopMs')} unit="ms" color="var(--ref)" />
            <Trend label="Bộ nhớ" data={pick(s, 'rssMb')} unit="MB" color="var(--ceil)" />
            <Trend label="Kết nối realtime" data={pick(s, 'sockets')} unit="" color="var(--up)" />
          </div>
        )}
      </Section>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Section
          title="Kênh nhận cảnh báo"
          actions={
            <button className="btn btn-ghost h-8" onClick={() => void act('/admin/monitor/test', 'POST', {}, 'Đã gửi cảnh báo thử')}>
              <BellRing size={14} /> Gửi thử
            </button>
          }
        >
          <ul className="space-y-1.5 text-[13px] text-tx-2">
            <li>
              Email:{' '}
              {data.channels.emails.length ? <b className="text-tx-1">{data.channels.emails.join(', ')}</b> : <span className="text-ref">chưa cấu hình (ALERT_EMAILS)</span>}
            </li>
            <li>
              Webhook: {data.channels.webhook ? <b className="break-all text-tx-1">{data.channels.webhook}</b> : <span className="text-ref">chưa cấu hình (ALERT_WEBHOOK_URL)</span>}
            </li>
            <li>
              /api/metrics (Prometheus):{' '}
              <b className="text-tx-1">{data.metricsEndpoint === 'token' ? 'bật, cần METRICS_TOKEN' : data.metricsEndpoint === 'open' ? 'mở (môi trường dev)' : 'tắt (đặt METRICS_TOKEN để bật)'}</b>
            </li>
          </ul>
          <p className="mt-3 text-[12px] text-tx-3">
            Quy tắc: mất CSDL (báo ngay), CSDL chậm &gt; {th.dbSlowMs} ms, event loop &gt; {th.eventLoopMs} ms, lỗi 5xx &gt; {Math.round(th.errorRate * 100)}%, p95 &gt; {th.p95Ms}{' '}
            ms, bộ nhớ &gt; {th.rssMb} MB, vòng lặp thị trường ngừng &gt; 30 giây, mất nguồn giá thật trong giờ giao dịch. Phải lỗi 2 lần kiểm tra liên tiếp mới báo.
          </p>
        </Section>

        <Section title="Cảnh báo đang bật & lịch sử" pad={false}>
          {data.history.length ? (
            <ul className="max-h-80 divide-y divide-line overflow-y-auto">
              {data.history.map((a) => (
                <li key={a.id} className="flex flex-wrap items-start gap-x-3 gap-y-0.5 px-4 py-2 text-[12.5px]">
                  <span className="num w-32 shrink-0 text-tx-3">{a.started_at ? fmtDateTimeVN(a.started_at) : ''}</span>
                  <Pill tone={a.resolved_at ? 'muted' : a.level === 'critical' ? 'bad' : 'warn'}>{a.resolved_at ? 'Đã hết' : a.level === 'critical' ? 'Nghiêm trọng' : 'Cảnh báo'}</Pill>
                  <span className="min-w-0 flex-1">
                    <b>{a.title}</b>
                    <span className="block text-tx-3">{a.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="Chưa có cảnh báo nào" />
          )}
        </Section>
      </div>
    </div>
  );
}
