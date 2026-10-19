import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import {
  AML_RULE_LABEL,
  AML_STATUS_LABEL,
  KYC_FLAG_LABEL,
  KYC_ID_TYPE_LABEL,
  KYC_LEVEL_LABEL,
  KYC_STATUS_LABEL,
  type AmlAlertDTO,
  type AmlRule,
  type AmlRules,
  type KycApplicationDTO,
  type KycIdType,
  type KycLevel,
} from '@vss/shared';
import { useAdminAction, useAdminMe } from '../../lib/admin';
import { api, errMsg } from '../../lib/api';
import { cn, fmtDateTime } from '../../lib/format';
import { useAmlAlerts, useAmlReports, useAmlRulesView, useComplianceUser, useKycApplications, useRestricted } from '../../lib/kyc';
import { fmtCoin, fmtVndNum } from '../../lib/p2p';
import { Empty, Modal, Spinner, UnderlineTabs } from '../common/ui';
import { OrderStatusChip } from '../p2p/common';
import { Pill, ReasonModal, Section } from './adminUi';

type View = 'kyc' | 'alerts' | 'restricted' | 'reports' | 'rules';

/**
 * Bộ phận Tuân thủ: duyệt hồ sơ KYC, xử lý cảnh báo AML, lập báo cáo giao dịch đáng ngờ (STR), hạn chế tài khoản.
 * Kiểm toán chỉ xem (aml.view). Khách không bao giờ thấy cảnh báo / STR.
 */
export function Compliance() {
  const { can } = useAdminMe();
  const views: { value: View; label: string }[] = [
    ...(can('kyc.review') ? [{ value: 'kyc' as const, label: 'Hồ sơ KYC' }] : []),
    ...(can('aml.view')
      ? [
          { value: 'alerts' as const, label: 'Cảnh báo AML' },
          { value: 'restricted' as const, label: 'Tài khoản bị hạn chế' },
          { value: 'reports' as const, label: 'Báo cáo STR' },
          { value: 'rules' as const, label: 'Ngưỡng cảnh báo' },
        ]
      : []),
  ];
  const [view, setView] = useState<View>(views[0]?.value ?? 'alerts');
  if (!views.length) return <Empty title="Vai trò của bạn không xem được mục này" />;
  return (
    <div className="space-y-3">
      <div className="panel">
        <UnderlineTabs value={view} onChange={setView} items={views} />
      </div>
      {view === 'kyc' && <KycQueue />}
      {view === 'alerts' && <Alerts />}
      {view === 'restricted' && <Restricted />}
      {view === 'reports' && <Reports />}
      {view === 'rules' && <Rules editable={can('aml.manage')} />}
    </div>
  );
}

/* ------------------------------ KYC ------------------------------ */

function KycQueue() {
  const [status, setStatus] = useState('PENDING');
  const { data, isLoading } = useKycApplications(status);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Section
      title="Hồ sơ xác minh danh tính"
      pad={false}
      actions={
        <select className="input h-8 w-auto text-[12px]" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Lọc trạng thái">
          <option value="PENDING">Chờ duyệt</option>
          <option value="APPROVED">Đã duyệt</option>
          <option value="REJECTED">Bị từ chối</option>
          <option value="ALL">Tất cả</option>
        </select>
      }
    >
      {isLoading ? (
        <Spinner className="m-4" />
      ) : !data?.length ? (
        <Empty title="Không có hồ sơ" />
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl w-full min-w-[760px] text-[12.5px]">
            <thead>
              <tr className="h-8 text-left">
                <th className="px-4">Khách hàng</th>
                <th className="px-2">Cấp</th>
                <th className="px-2">Giấy tờ</th>
                <th className="px-2">Cờ tự kiểm tra</th>
                <th className="px-2">Nộp lúc</th>
                <th className="px-4">Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id} className="cursor-pointer border-t border-line hover:bg-bg-2" onClick={() => setOpen(a.id)}>
                  <td className="px-4 py-2">
                    <div className="font-medium">{a.accountName}</div>
                    <div className="text-[11px] text-tx-3">{a.email}</div>
                  </td>
                  <td className="px-2 py-2">Cấp {a.level}</td>
                  <td className="num px-2 py-2">{a.idLast4 ? `•••• ${a.idLast4}` : '—'}</td>
                  <td className="space-x-1 px-2 py-2">
                    {a.flags.map((f) => (
                      <Pill key={f} tone="bad">
                        {KYC_FLAG_LABEL[f]}
                      </Pill>
                    ))}
                  </td>
                  <td className="px-2 py-2">{fmtDateTime(a.createdAt)}</td>
                  <td className="px-4 py-2">
                    <Pill tone={a.status === 'PENDING' ? 'warn' : a.status === 'APPROVED' ? 'good' : 'muted'}>{KYC_STATUS_LABEL[a.status]}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <KycDetail id={open} onClose={() => setOpen(null)} />
    </Section>
  );
}

const FIELD_LABEL: Record<string, string> = {
  fullName: 'Họ tên theo giấy tờ',
  dateOfBirth: 'Ngày sinh',
  nationality: 'Quốc tịch',
  idType: 'Loại giấy tờ',
  idNumber: 'Số giấy tờ',
  idIssuedDate: 'Ngày cấp',
  isPep: 'Người có ảnh hưởng chính trị',
  address: 'Địa chỉ cư trú',
  occupation: 'Nghề nghiệp',
  fundSource: 'Nguồn tiền',
  purpose: 'Mục đích giao dịch',
};

function KycDetail({ id, onClose }: { id: number | null; onClose(): void }) {
  const act = useAdminAction();
  const [app, setApp] = useState<KycApplicationDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reject, setReject] = useState(false);
  useEffect(() => {
    setApp(null);
    setErr(null);
    if (!id) return;
    // Mỗi lần mở là 1 lần xem hồ sơ đầy đủ (máy chủ ghi KYC_VIEW)
    api<KycApplicationDTO>(`/admin/compliance/kyc/${id}`).then(setApp, (e) => setErr(errMsg(e)));
  }, [id]);
  const review = (approve: boolean, reason = '') =>
    act(`/admin/compliance/kyc/${id}/review`, 'POST', { approve, reason }, approve ? 'Đã duyệt hồ sơ' : 'Đã từ chối hồ sơ').then((r) => r && onClose());
  const show = (k: string, v: unknown) => (k === 'idType' ? KYC_ID_TYPE_LABEL[v as KycIdType] : typeof v === 'boolean' ? (v ? 'Có' : 'Không') : String(v));

  return (
    <>
      <Modal
        open={id != null && !reject}
        onClose={onClose}
        width={560}
        title={app ? `Hồ sơ KYC cấp ${app.level} · ${app.accountName}` : 'Hồ sơ KYC'}
        footer={
          app?.status === 'PENDING' && (
            <>
              <button className="btn btn-ghost text-down" onClick={() => setReject(true)}>
                Từ chối
              </button>
              <button className="btn btn-up" onClick={() => void review(true)}>
                Duyệt cấp {app.level}
              </button>
            </>
          )
        }
      >
        {err ? (
          <p className="text-[13px] text-down">{err}</p>
        ) : !app ? (
          <Spinner className="m-4" />
        ) : (
          <div className="space-y-3 text-[13px]">
            <p className="text-[12px] text-tx-3">
              {app.email} · nộp {fmtDateTime(app.createdAt)}. Lần xem này đã được ghi vào nhật ký quản trị.
            </p>
            {app.flags.length > 0 && (
              <div className="space-y-1 rounded-md bg-down/10 px-3 py-2 text-down">
                {app.flags.map((f) => (
                  <div key={f}>• {KYC_FLAG_LABEL[f]}</div>
                ))}
              </div>
            )}
            <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-1.5">
              {Object.entries(app.data ?? {}).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-tx-3">{FIELD_LABEL[k] ?? k}</dt>
                  <dd className={cn(k === 'isPep' && v === true && 'font-semibold text-down')}>{show(k, v)}</dd>
                </div>
              ))}
            </dl>
            {app.status !== 'PENDING' && (
              <p className="text-[12px] text-tx-3">
                {KYC_STATUS_LABEL[app.status]} bởi {app.reviewedBy} lúc {app.reviewedAt && fmtDateTime(app.reviewedAt)}
                {app.rejectReason && ` · Lý do: ${app.rejectReason}`}
              </p>
            )}
          </div>
        )}
      </Modal>
      <ReasonModal
        open={reject}
        title="Từ chối hồ sơ KYC"
        description="Lý do được gửi cho khách qua email để sửa và nộp lại."
        confirmLabel="Từ chối"
        danger
        placeholder="Vd. Họ tên không khớp giấy tờ, số giấy tờ trùng tài khoản khác…"
        onClose={() => setReject(false)}
        onConfirm={(reason) => review(false, reason).then(() => setReject(false))}
      />
    </>
  );
}

/* ------------------------------ cảnh báo AML ------------------------------ */

const SEV_TONE = { HIGH: 'bad', MEDIUM: 'warn', LOW: 'muted' } as const;

function alertSummary(a: AmlAlertDTO): string {
  const d = a.detail as Record<string, unknown>;
  const v = (k: string) => fmtVndNum(d[k] as string);
  switch (a.rule) {
    case 'LARGE_P2P':
      return `Đơn #${d.orderId}: ${v('fiatVnd')} ₫ (ngưỡng ${v('thresholdVnd')} ₫)`;
    case 'HIGH_DAILY_VOLUME':
      return `${d.orders} đơn, tổng ${v('totalVnd')} ₫ / 24 giờ`;
    case 'STRUCTURING':
      return `${d.orders} đơn sát ngưỡng ${v('thresholdVnd')} ₫, tổng ${v('totalVnd')} ₫`;
    case 'RAPID_IN_OUT':
      return `Mua ${v('boughtVnd')} ₫, bán ${v('soldVnd')} ₫ trong 24 giờ`;
    case 'MANY_COUNTERPARTIES':
      return `${d.counterparties} đối tác khác nhau / ${d.orders} đơn`;
    case 'DUPLICATE_ID':
      return `Số giấy tờ (•••• ${d.idLast4}) trùng ${(d.otherUserIds as string[] | undefined)?.length ?? 0} tài khoản khác`;
    case 'PEP':
      return 'Khách tự khai là người có ảnh hưởng chính trị';
  }
}

function Alerts() {
  const { can } = useAdminMe();
  const act = useAdminAction();
  const [status, setStatus] = useState('ACTIVE');
  const [rule, setRule] = useState('');
  const { data, isLoading } = useAmlAlerts(status, rule);
  const [open, setOpen] = useState<AmlAlertDTO | null>(null);
  return (
    <Section
      title="Cảnh báo chống rửa tiền"
      pad={false}
      actions={
        <div className="flex flex-wrap gap-2">
          <select className="input h-8 w-auto text-[12px]" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Lọc trạng thái">
            <option value="ACTIVE">Cần xử lý</option>
            <option value="OPEN">Mới</option>
            <option value="REVIEWING">Đang xem xét</option>
            <option value="REPORTED">Đã lập STR</option>
            <option value="CLOSED">Đã đóng</option>
            <option value="ALL">Tất cả</option>
          </select>
          <select className="input h-8 w-auto text-[12px]" value={rule} onChange={(e) => setRule(e.target.value)} aria-label="Lọc quy tắc">
            <option value="">Mọi quy tắc</option>
            {(Object.keys(AML_RULE_LABEL) as AmlRule[]).map((r) => (
              <option key={r} value={r}>
                {AML_RULE_LABEL[r]}
              </option>
            ))}
          </select>
          {can('aml.manage') && (
            <button className="btn btn-ghost h-8 text-[12px]" onClick={() => void act<{ created: number }>('/admin/compliance/scan', 'POST', {}, 'Đã quét xong')}>
              <RefreshCw size={13} /> Quét ngay
            </button>
          )}
        </div>
      }
    >
      {isLoading ? (
        <Spinner className="m-4" />
      ) : !data?.length ? (
        <Empty title="Không có cảnh báo" hint="Hệ thống tự quét đơn P2P 10 phút / lần." />
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl w-full min-w-[860px] text-[12.5px]">
            <thead>
              <tr className="h-8 text-left">
                <th className="px-4">Thời gian</th>
                <th className="px-2">Khách hàng</th>
                <th className="px-2">Quy tắc</th>
                <th className="px-2">Chi tiết</th>
                <th className="px-4">Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id} className="cursor-pointer border-t border-line align-top hover:bg-bg-2" onClick={() => setOpen(a)}>
                  <td className="whitespace-nowrap px-4 py-2">{fmtDateTime(a.createdAt)}</td>
                  <td className="px-2 py-2">
                    <div className="font-medium">{a.accountName}</div>
                    <div className="text-[11px] text-tx-3">
                      {a.email} · KYC cấp {a.kycLevel}
                    </div>
                    {a.restricted && <Pill tone="bad">Đang hạn chế</Pill>}
                  </td>
                  <td className="px-2 py-2">
                    <Pill tone={SEV_TONE[a.severity]}>{AML_RULE_LABEL[a.rule]}</Pill>
                  </td>
                  <td className="px-2 py-2 text-tx-2">{alertSummary(a)}</td>
                  <td className="px-4 py-2">
                    <Pill tone={a.status === 'OPEN' ? 'warn' : a.status === 'REVIEWING' ? 'info' : a.status === 'REPORTED' ? 'bad' : 'muted'}>{AML_STATUS_LABEL[a.status]}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AlertDetail alert={open} onClose={() => setOpen(null)} />
    </Section>
  );
}

function AlertDetail({ alert, onClose }: { alert: AmlAlertDTO | null; onClose(): void }) {
  const { can } = useAdminMe();
  const manage = can('aml.manage');
  const act = useAdminAction();
  const { data: profile } = useComplianceUser(alert?.userId ?? null);
  const { data: related } = useAmlAlerts('ACTIVE', '', !!alert);
  const [mode, setMode] = useState<'close' | 'restrict' | 'unrestrict' | 'str' | null>(null);
  const [narrative, setNarrative] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const userAlerts = (related ?? []).filter((a) => a.userId === alert?.userId);

  useEffect(() => {
    setMode(null);
    setNarrative('');
    setPicked(alert ? [alert.id] : []);
  }, [alert]);

  if (!alert) return null;
  const active = alert.status === 'OPEN' || alert.status === 'REVIEWING';
  const done = (r: unknown) => {
    if (r) {
      setMode(null);
      onClose();
    }
  };

  return (
    <>
      <Modal
        open={mode == null || mode === 'str'}
        onClose={onClose}
        width={760}
        title={`${AML_RULE_LABEL[alert.rule]} · ${alert.accountName}`}
        footer={
          manage && (
            <div className="flex w-full flex-wrap justify-end gap-2">
              {profile?.user.restricted ? (
                <button className="btn btn-ghost" onClick={() => setMode('unrestrict')}>
                  Đề xuất gỡ hạn chế
                </button>
              ) : (
                <button className="btn btn-ghost text-down" onClick={() => setMode('restrict')}>
                  Hạn chế tài khoản
                </button>
              )}
              {active && alert.status === 'OPEN' && (
                <button className="btn btn-ghost" onClick={() => void act(`/admin/compliance/alerts/${alert.id}`, 'PATCH', { status: 'REVIEWING' }, 'Đã chuyển sang đang xem xét').then(done)}>
                  Nhận xử lý
                </button>
              )}
              {active && (
                <>
                  <button className="btn btn-ghost" onClick={() => setMode('close')}>
                    Đóng (không đáng ngờ)
                  </button>
                  <button className="btn btn-down" onClick={() => setMode(mode === 'str' ? null : 'str')}>
                    Lập STR
                  </button>
                </>
              )}
            </div>
          )
        }
      >
        <div className="space-y-4 text-[13px]">
          <div className="rounded-md bg-bg-2 px-3 py-2">
            <div className="font-medium">{alertSummary(alert)}</div>
            <div className="text-[12px] text-tx-3">
              {fmtDateTime(alert.createdAt)} · {AML_STATUS_LABEL[alert.status]}
              {alert.handledBy && ` · ${alert.handledBy}`}
              {alert.notes && ` · ${alert.notes}`}
            </div>
          </div>
          {!profile ? (
            <Spinner />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="label">Khách hàng</div>
                  <div className="font-medium">
                    {profile.user.accountName} <span className="font-normal text-tx-3">{profile.user.email}</span>
                  </div>
                  <div className="text-[12px] text-tx-2">
                    KYC cấp {profile.user.kycLevel} · {KYC_LEVEL_LABEL[profile.user.kycLevel as KycLevel]}
                    {profile.user.kycName && ` · ${profile.user.kycName}`}
                  </div>
                  <div className="text-[12px] text-tx-3">
                    Mở tài khoản {profile.user.createdAt && fmtDateTime(profile.user.createdAt)}
                    {profile.user.merchantStatus && ` · Thương nhân (${profile.user.merchantStatus})`}
                  </div>
                  {profile.user.restricted && (
                    <div className="mt-1 text-[12px] text-down">
                      Đang hạn chế từ {fmtDateTime(profile.user.restricted.at)} bởi {profile.user.restricted.by}: {profile.user.restricted.reason}
                    </div>
                  )}
                </div>
                <div>
                  <div className="label">P2P 30 ngày</div>
                  <div className="num">
                    Mua {fmtVndNum(profile.p2p30d.boughtVnd)} ₫ · Bán {fmtVndNum(profile.p2p30d.soldVnd)} ₫
                  </div>
                  <div className="text-[12px] text-tx-3">
                    {profile.p2p30d.orders} đơn hoàn tất · {profile.p2p30d.counterparties} đối tác
                  </div>
                </div>
              </div>
              <div className="max-h-56 overflow-y-auto rounded-md border border-line">
                <table className="tbl w-full text-[12px]">
                  <thead>
                    <tr className="h-7 text-left">
                      <th className="px-3">Đơn</th>
                      <th className="px-2">Chiều</th>
                      <th className="px-2 text-right">Số tiền</th>
                      <th className="px-2">Đối tác</th>
                      <th className="px-3">Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profile.orders.map((o) => {
                      const buyer = o.buyer.id === alert.userId;
                      return (
                        <tr key={o.id} className="border-t border-line">
                          <td className="px-3 py-1.5">
                            #{o.id} <span className="text-tx-3">{fmtDateTime(o.createdAt)}</span>
                          </td>
                          <td className={cn('px-2', buyer ? 'text-up' : 'text-down')}>
                            {buyer ? 'Mua' : 'Bán'} {fmtCoin(o.qty)} {o.asset}
                          </td>
                          <td className="num px-2 text-right">{fmtVndNum(o.fiatAmount)} ₫</td>
                          <td className="px-2">{buyer ? o.seller.name : o.buyer.name}</td>
                          <td className="px-3">
                            <OrderStatusChip status={o.status} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!profile.orders.length && <p className="px-3 py-2 text-[12px] text-tx-3">Chưa có đơn P2P</p>}
              </div>
            </>
          )}
          {mode === 'str' && (
            <div className="space-y-2 rounded-md border border-down/30 p-3">
              <div className="font-semibold">Báo cáo giao dịch đáng ngờ (STR)</div>
              <div className="flex flex-wrap gap-2">
                {userAlerts.map((a) => (
                  <label key={a.id} className="flex items-center gap-1.5 text-[12px]">
                    <input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, a.id] : p.filter((x) => x !== a.id)))} />
                    #{a.id} {AML_RULE_LABEL[a.rule]}
                  </label>
                ))}
              </div>
              <textarea
                className="input h-28 py-2"
                placeholder="Mô tả giao dịch đáng ngờ: ai, bao nhiêu, khi nào, vì sao bất thường so với hồ sơ KYC (tối thiểu 30 ký tự)"
                value={narrative}
                onChange={(e) => setNarrative(e.target.value)}
              />
              <p className="text-[11px] text-tx-3">STR chỉ được ghi thêm, không sửa / xoá. Không thông báo cho khách (nguyên tắc không tiết lộ).</p>
              <div className="flex justify-end">
                <button
                  className="btn btn-down"
                  disabled={narrative.trim().length < 30 || !picked.length}
                  onClick={() => void act('/admin/compliance/reports', 'POST', { userId: alert.userId, alertIds: picked, narrative }, 'Đã lập STR').then(done)}
                >
                  Lưu STR
                </button>
              </div>
            </div>
          )}
        </div>
      </Modal>
      <ReasonModal
        open={mode === 'close'}
        title="Đóng cảnh báo"
        description="Ghi kết luận thẩm định (vì sao không đáng ngờ)."
        confirmLabel="Đóng cảnh báo"
        placeholder="Kết luận (tối thiểu 5 ký tự)"
        onClose={() => setMode(null)}
        onConfirm={(notes) => act(`/admin/compliance/alerts/${alert.id}`, 'PATCH', { status: 'CLOSED', notes }, 'Đã đóng cảnh báo').then(done)}
      />
      <ReasonModal
        open={mode === 'restrict'}
        title={`Hạn chế tài khoản ${alert.email}`}
        description="Khách vẫn đăng nhập được nhưng không đặt lệnh Spot / P2P mới; quảng cáo P2P bị đóng, thương nhân tạm ngừng. Khách chỉ thấy thông báo chung, không thấy lý do."
        confirmLabel="Hạn chế"
        danger
        placeholder="Lý do nội bộ (tối thiểu 5 ký tự)"
        onClose={() => setMode(null)}
        onConfirm={(reason) => act(`/admin/compliance/users/${alert.userId}/restrict`, 'POST', { reason }, 'Đã hạn chế tài khoản').then(done)}
      />
      <ReasonModal
        open={mode === 'unrestrict'}
        title={`Đề xuất gỡ hạn chế ${alert.email}`}
        description="Cần Trưởng Tuân thủ (MLRO) duyệt ở mục Hàng chờ duyệt."
        confirmLabel="Gửi đề xuất"
        placeholder="Căn cứ gỡ hạn chế"
        onClose={() => setMode(null)}
        onConfirm={(reason) => act(`/admin/compliance/users/${alert.userId}/unrestrict`, 'POST', { reason }, 'Đã gửi đề xuất').then(done)}
      />
    </>
  );
}

/* ------------------------------ hạn chế / STR / ngưỡng ------------------------------ */

function Restricted() {
  const { can } = useAdminMe();
  const act = useAdminAction();
  const { data, isLoading } = useRestricted();
  const [target, setTarget] = useState<string | null>(null);
  return (
    <Section title="Tài khoản đang bị hạn chế" pad={false}>
      {isLoading ? (
        <Spinner className="m-4" />
      ) : !data?.length ? (
        <Empty title="Không có tài khoản bị hạn chế" />
      ) : (
        <ul className="divide-y divide-line">
          {data.map((u) => (
            <li key={u.userId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
              <div>
                <div className="font-medium">
                  {u.accountName} <span className="font-normal text-tx-3">{u.email}</span>
                </div>
                <div className="text-[12px] text-tx-3">
                  {fmtDateTime(u.at)} · {u.by} · {u.reason}
                </div>
              </div>
              {can('aml.manage') && (
                <button className="btn btn-ghost h-8 text-[12px]" onClick={() => setTarget(u.userId)}>
                  Đề xuất gỡ
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ReasonModal
        open={!!target}
        title="Đề xuất gỡ hạn chế"
        description="Cần Trưởng Tuân thủ (MLRO) duyệt ở mục Hàng chờ duyệt. Tư cách thương nhân P2P (nếu có) do Vận hành P2P khôi phục riêng."
        confirmLabel="Gửi đề xuất"
        placeholder="Căn cứ gỡ hạn chế"
        onClose={() => setTarget(null)}
        onConfirm={(reason) => act(`/admin/compliance/users/${target}/unrestrict`, 'POST', { reason }, 'Đã gửi đề xuất').then(() => setTarget(null))}
      />
    </Section>
  );
}

function Reports() {
  const { data, isLoading } = useAmlReports();
  const download = (r: NonNullable<typeof data>[number]) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `str-${r.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Section title="Báo cáo giao dịch đáng ngờ (STR)" pad={false}>
      <p className="px-4 pt-3 text-[12px] text-tx-3">Sàn mô phỏng: STR chỉ lưu nội bộ (không gửi cơ quan chức năng). Không sửa / xoá được.</p>
      {isLoading ? (
        <Spinner className="m-4" />
      ) : !data?.length ? (
        <Empty title="Chưa có STR" />
      ) : (
        <ul className="divide-y divide-line">
          {data.map((r) => (
            <li key={r.id} className="px-4 py-3 text-[13px]">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium">
                  STR #{r.id} · {r.email}
                </div>
                <button className="btn btn-ghost h-7 px-2 text-[12px]" onClick={() => download(r)}>
                  <Download size={13} /> JSON
                </button>
              </div>
              <div className="text-[12px] text-tx-3">
                {fmtDateTime(r.createdAt)} · {r.createdBy} · cảnh báo {r.alertIds.map((x) => `#${x}`).join(', ')}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-tx-2">{r.narrative}</p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

const RULE_FIELDS: { key: keyof AmlRules; label: string; unit: string }[] = [
  { key: 'largeOrderVnd', label: 'Đơn P2P giá trị lớn', unit: '₫' },
  { key: 'dailyVolumeVnd', label: 'Khối lượng P2P 24 giờ', unit: '₫' },
  { key: 'structuringCount', label: 'Chia nhỏ: số đơn sát ngưỡng', unit: 'đơn' },
  { key: 'structuringLowPct', label: 'Chia nhỏ: từ % ngưỡng đơn lớn', unit: '%' },
  { key: 'rapidInOutVnd', label: 'Mua vào bán ra nhanh: mỗi chiều từ', unit: '₫' },
  { key: 'counterpartyCount', label: 'Số đối tác khác nhau / 24 giờ', unit: 'người' },
];

function Rules({ editable }: { editable: boolean }) {
  const { data } = useAmlRulesView();
  const act = useAdminAction();
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (data) setDraft(Object.fromEntries(RULE_FIELDS.map((f) => [f.key, String(data.rules[f.key])])));
  }, [data]);
  if (!data) return <Spinner className="m-4" />;
  const save = () => {
    const patch: Record<string, number> = {};
    for (const f of RULE_FIELDS) if (Number(draft[f.key]) !== data.rules[f.key]) patch[f.key] = Number(draft[f.key]);
    if (Object.keys(patch).length) void act('/admin/compliance/rules', 'PUT', patch, 'Đã lưu ngưỡng AML');
  };
  return (
    <Section
      title="Ngưỡng cảnh báo AML"
      actions={
        editable && (
          <div className="flex gap-2">
            <button className="btn btn-ghost h-8 text-[12px]" onClick={() => void act('/admin/compliance/rules', 'DELETE', undefined, 'Đã khôi phục mặc định')}>
              Mặc định
            </button>
            <button className="btn btn-brand h-8 text-[12px]" onClick={save}>
              Lưu
            </button>
          </div>
        )
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {RULE_FIELDS.map((f) => (
          <label key={f.key} className="block text-[13px]">
            <span className="label">
              {f.label} ({f.unit})
            </span>
            <input
              className="input num mt-1"
              disabled={!editable}
              value={draft[f.key] ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value.replace(/\D/g, '') }))}
            />
            {f.key in data.overrides && <span className="mt-0.5 block text-[11px] text-ref">Đã chỉnh (mặc định {fmtVndNum(data.defaults[f.key])})</span>}
          </label>
        ))}
      </div>
    </Section>
  );
}
