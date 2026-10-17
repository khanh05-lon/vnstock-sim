import { useMemo, useState } from 'react';
import { AUDIT_LABEL, auditSummary, useAdminAudit, useAdminLogs, useAdminMe } from '../../lib/admin';
import { cn, downloadCsv, fmtDateTime, fmtTime } from '../../lib/format';
import { Empty, Spinner, UnderlineTabs } from '../common/ui';
import { Pill } from './adminUi';

function AuditLog() {
  const [action, setAction] = useState('');
  const { data, isLoading } = useAdminAudit(action || undefined);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <select className="input h-8 w-56" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Lọc thao tác">
          <option value="">Mọi thao tác</option>
          {Object.entries(AUDIT_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <span className="text-[12px] text-tx-3">Nhật ký chỉ ghi thêm, không sửa / xoá được từ ứng dụng.</span>
        <button
          className="btn btn-ghost ml-auto h-8"
          disabled={!data?.length}
          onClick={() =>
            downloadCsv(
              'nhat-ky-quan-tri.csv',
              ['Thời gian', 'Quản trị viên', 'Thao tác', 'Đối tượng', 'Chi tiết'],
              (data ?? []).map((a) => [fmtDateTime(a.created_at), a.admin_email, AUDIT_LABEL[a.action] ?? a.action, `${a.target_type ?? ''} ${a.target_id ?? ''}`.trim(), auditSummary(a)]),
            )
          }
        >
          Xuất CSV
        </button>
      </div>
      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !data?.length ? (
        <Empty title="Chưa có thao tác quản trị nào" />
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl num w-full min-w-[860px] text-[12.5px]">
            <thead>
              <tr className="h-9 text-left">
                <th className="px-4">Thời gian</th>
                <th className="px-2">Quản trị viên</th>
                <th className="px-2">Thao tác</th>
                <th className="px-4">Chi tiết</th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id} className="h-10 border-t border-line">
                  <td className="px-4 text-tx-2">{fmtDateTime(a.created_at)}</td>
                  <td className="px-2">{a.admin_email}</td>
                  <td className="px-2">
                    <Pill tone={/LOCK$|DELETE|HALT$|CANCEL/.test(a.action) ? 'bad' : 'brand'}>{AUDIT_LABEL[a.action] ?? a.action}</Pill>
                  </td>
                  <td className="max-w-[520px] truncate whitespace-normal px-4 text-tx-2">{auditSummary(a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ServerLog() {
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState('');
  const { data, isLoading } = useAdminLogs(live);
  const lines = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return [...(data ?? [])].reverse().filter((l) => !f || l.text.toLowerCase().includes(f));
  }, [data, filter]);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <input className="input h-8 w-64" placeholder="Lọc theo chữ, ví dụ: lỗi, vnstock, admin" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="flex items-center gap-1.5 text-[12px] text-tx-2">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} className="accent-[var(--brand)]" /> Tự làm mới mỗi 3 giây
        </label>
        <span className="ml-auto text-[12px] text-tx-3">400 dòng gần nhất trong bộ nhớ máy chủ (mới nhất ở trên)</span>
      </div>
      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !lines.length ? (
        <Empty title="Không có dòng log phù hợp" />
      ) : (
        <div className="max-h-[560px] overflow-auto bg-bg-0 px-4 py-2 font-mono text-[11.5px] leading-5">
          {lines.map((l, i) => {
            const bad = l.stream === 'err' || /lỗi|error|"level":"error"/i.test(l.text);
            const warn = !bad && /warn|cảnh báo|"level":"warn"/i.test(l.text);
            return (
              <div key={`${l.time}-${i}`} className={cn('whitespace-pre-wrap break-all', bad ? 'text-down' : warn ? 'text-ref' : 'text-tx-2')}>
                <span className="text-tx-3">{fmtTime(l.time)} </span>
                {l.text}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export function Logs() {
  const { can } = useAdminMe();
  const items = [
    ...(can('audit.view') ? [{ value: 'audit' as const, label: 'Nhật ký quản trị' }] : []),
    ...(can('system.view') ? [{ value: 'server' as const, label: 'Log máy chủ' }] : []),
  ];
  const [picked, setTab] = useState<'audit' | 'server'>('audit');
  const tab = items.some((i) => i.value === picked) ? picked : (items[0]?.value ?? 'audit');
  return (
    <section className="panel overflow-hidden">
      <UnderlineTabs value={tab} onChange={setTab} items={items} />
      {tab === 'audit' ? <AuditLog /> : <ServerLog />}
    </section>
  );
}
