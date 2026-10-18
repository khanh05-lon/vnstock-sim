import { useEffect, useState } from 'react';
import { CheckCircle2, CircleX } from 'lucide-react';
import { MERCHANT_STATUS_LABEL, type MerchantAdminDTO, type MerchantStatus, type P2PRules } from '@vss/shared';
import { useAdminAction, useAdminMe } from '../../lib/admin';
import { cleanDecimal, fmtDateTime } from '../../lib/format';
import { fmtCoin, fmtDuration, fmtRate, fmtVndNum, useAdminMerchants, useAdminP2POrders, useAdminP2PRules } from '../../lib/p2p';
import { Empty, Modal, Spinner } from '../common/ui';
import { OrderStatusChip } from '../p2p/common';
import { Pill, ReasonModal, Section } from './adminUi';

const TONE: Record<MerchantStatus, 'good' | 'warn' | 'bad' | 'info' | 'muted'> = {
  PENDING: 'warn',
  ACTIVE: 'good',
  SUSPENDED: 'bad',
  REJECTED: 'muted',
  RESIGNED: 'muted',
};

type Action = { kind: 'approve' | 'reject' | 'suspend' | 'restore'; m: MerchantAdminDTO };

/** Quản trị thương nhân P2P: duyệt đơn xin (Rủi ro & giám sát), tạm ngừng, trừ cọc; tham số P2P (Vận hành thị trường) */
export function P2PMerchants() {
  const { can } = useAdminMe();
  const review = can('p2p.review');
  const [filter, setFilter] = useState<MerchantStatus | 'ALL'>('ACTIVE');
  const { data: pending, isLoading } = useAdminMerchants('PENDING', review);
  const { data: list } = useAdminMerchants(filter, review);
  const { data: orders } = useAdminP2POrders('OPEN', review);
  const act = useAdminAction();
  const [action, setAction] = useState<Action | null>(null);
  const [penalty, setPenalty] = useState<MerchantAdminDTO | null>(null);

  const run = (a: Action, reason: string) => {
    const body = a.kind === 'suspend' ? { reason } : { note: reason };
    const ok = { approve: 'Đã duyệt thương nhân', reject: 'Đã từ chối, trả tiền cọc', suspend: 'Đã tạm ngừng thương nhân', restore: 'Đã khôi phục thương nhân' }[a.kind];
    return act(`/admin/p2p/merchants/${a.m.userId}/${a.kind}`, 'POST', body, ok).then(() => setAction(null));
  };

  return (
    <div className="space-y-3">
      {review && (
        <>
          <Section title={`Đơn xin làm thương nhân chờ duyệt${pending?.length ? ` (${pending.length})` : ''}`} pad={false}>
            {isLoading ? (
              <Spinner className="m-4" />
            ) : !pending?.length ? (
              <Empty title="Không có đơn chờ duyệt" />
            ) : (
              <ul className="divide-y divide-line">
                {pending.map((m) => (
                  <li key={m.userId} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-[13px]">
                    <div className="min-w-0">
                      <div className="font-semibold">
                        {m.name} <span className="font-normal text-tx-3">{m.email}</span>
                      </div>
                      <div className="text-[12px] text-tx-3">
                        Nộp lúc {fmtDateTime(m.appliedAt)} · cọc {fmtCoin(m.depositUsdt)} USDT · {m.stats.totalCompleted} đơn P2P · hoàn tất 30 ngày {fmtRate(m.stats.completionRate30d)}
                      </div>
                      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
                        {m.requirements.map((r) => (
                          <li key={r.key} className="flex items-center gap-1">
                            {r.ok ? <CheckCircle2 size={13} className="text-up" /> : <CircleX size={13} className="text-down" />}
                            {r.label} <span className="text-tx-3">({r.detail})</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="flex gap-2">
                      <button className="btn btn-up h-8" onClick={() => setAction({ kind: 'approve', m })}>
                        Duyệt
                      </button>
                      <button className="btn btn-ghost h-8 text-down" onClick={() => setAction({ kind: 'reject', m })}>
                        Từ chối
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="Thương nhân"
            pad={false}
            actions={
              <select className="input h-8 w-auto text-[12px]" value={filter} onChange={(e) => setFilter(e.target.value as MerchantStatus | 'ALL')} aria-label="Lọc trạng thái">
                {(['ACTIVE', 'SUSPENDED', 'REJECTED', 'RESIGNED', 'ALL'] as const).map((s) => (
                  <option key={s} value={s}>
                    {s === 'ALL' ? 'Tất cả' : MERCHANT_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            }
          >
            {!list?.length ? (
              <Empty title="Không có thương nhân" />
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl w-full min-w-[860px] text-[12.5px]">
                  <thead>
                    <tr className="h-8 text-left">
                      <th className="px-4">Thương nhân</th>
                      <th className="px-2">Trạng thái</th>
                      <th className="px-2 text-right">Cọc (USDT)</th>
                      <th className="px-2 text-right">Đơn 30 ngày</th>
                      <th className="px-2 text-right">Hoàn tất</th>
                      <th className="px-2 text-right">Nhả coin TB</th>
                      <th className="px-2 text-right">QC / đơn mở</th>
                      <th className="px-4 text-right">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((m) => (
                      <tr key={m.userId} className="border-t border-line">
                        <td className="px-4 py-2">
                          <div className="font-medium">{m.name}</div>
                          <div className="text-[11px] text-tx-3">{m.email}</div>
                          {m.note && <div className="text-[11px] text-tx-3">Ghi chú: {m.note}</div>}
                        </td>
                        <td className="px-2 py-2">
                          <Pill tone={TONE[m.status]}>{MERCHANT_STATUS_LABEL[m.status]}</Pill>
                        </td>
                        <td className="num px-2 py-2 text-right">{fmtCoin(m.depositUsdt)}</td>
                        <td className="num px-2 py-2 text-right">{m.stats.orders30d}</td>
                        <td className="num px-2 py-2 text-right">{fmtRate(m.stats.completionRate30d)}</td>
                        <td className="px-2 py-2 text-right">{fmtDuration(m.stats.avgReleaseSec)}</td>
                        <td className="num px-2 py-2 text-right">
                          {m.openAds} / {m.openOrders}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <div className="flex justify-end gap-1">
                            {m.status === 'ACTIVE' && (
                              <button className="btn btn-ghost h-7 px-2 text-[12px] text-down" onClick={() => setAction({ kind: 'suspend', m })}>
                                Tạm ngừng
                              </button>
                            )}
                            {m.status === 'SUSPENDED' && (
                              <button className="btn btn-ghost h-7 px-2 text-[12px]" onClick={() => setAction({ kind: 'restore', m })}>
                                Khôi phục
                              </button>
                            )}
                            {Number(m.depositUsdt) > 0 && (
                              <button className="btn btn-ghost h-7 px-2 text-[12px]" onClick={() => setPenalty(m)}>
                                Trừ cọc
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title={`Đơn P2P đang chạy${orders?.length ? ` (${orders.length})` : ''}`} pad={false}>
            {!orders?.length ? (
              <Empty title="Không có đơn đang chạy" />
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl w-full min-w-[720px] text-[12.5px]">
                  <thead>
                    <tr className="h-8 text-left">
                      <th className="px-4">Đơn</th>
                      <th className="px-2">Người mua → bên bán</th>
                      <th className="px-2 text-right">Số lượng</th>
                      <th className="px-2 text-right">Số tiền</th>
                      <th className="px-4">Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr key={o.id} className="border-t border-line">
                        <td className="px-4 py-2">
                          #{o.id} <span className="text-[11px] text-tx-3">{fmtDateTime(o.createdAt)}</span>
                        </td>
                        <td className="px-2 py-2">
                          {o.buyer.name} → {o.seller.name}
                        </td>
                        <td className="num px-2 py-2 text-right">
                          {fmtCoin(o.qty)} {o.asset}
                        </td>
                        <td className="num px-2 py-2 text-right">{fmtVndNum(o.fiatAmount)} ₫</td>
                        <td className="px-4 py-2">
                          <OrderStatusChip status={o.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}

      <RulesSection editable={can('market.manage')} />

      <ReasonModal
        open={!!action}
        title={
          action
            ? { approve: `Duyệt ${action.m.name}`, reject: `Từ chối ${action.m.name}`, suspend: `Tạm ngừng ${action.m.name}`, restore: `Khôi phục ${action.m.name}` }[action.kind]
            : ''
        }
        description={
          action?.kind === 'suspend'
            ? 'Mọi quảng cáo chuyển offline (coin vẫn khoá), đơn đang chạy vẫn xử lý tiếp. Tiền cọc giữ lại.'
            : action?.kind === 'reject'
              ? 'Tiền cọc được trả lại cho người dùng.'
              : action?.kind === 'approve'
                ? 'Người dùng được đăng quảng cáo và có huy hiệu "Thương nhân đã xác minh".'
                : undefined
        }
        confirmLabel={action ? { approve: 'Duyệt', reject: 'Từ chối', suspend: 'Tạm ngừng', restore: 'Khôi phục' }[action.kind] : ''}
        danger={action?.kind === 'reject' || action?.kind === 'suspend'}
        requireReason={action?.kind === 'suspend' || action?.kind === 'reject'}
        placeholder={action?.kind === 'suspend' ? 'Lý do tạm ngừng (tối thiểu 5 ký tự)' : 'Ghi chú'}
        onClose={() => setAction(null)}
        onConfirm={(reason) => (action ? run(action, reason) : undefined)}
      />
      <PenaltyModal m={penalty} onClose={() => setPenalty(null)} />
    </div>
  );
}

function PenaltyModal({ m, onClose }: { m: MerchantAdminDTO | null; onClose(): void }) {
  const act = useAdminAction();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    setAmount('');
    setReason('');
  }, [m]);
  const over = !!m && Number(amount) > Number(m.depositUsdt);
  return (
    <Modal
      open={!!m}
      onClose={onClose}
      title={m ? `Trừ tiền cọc · ${m.name}` : ''}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Huỷ
          </button>
          <button
            className="btn btn-down"
            disabled={!(Number(amount) > 0) || over || reason.trim().length < 5}
            onClick={() => m && void act(`/admin/p2p/merchants/${m.userId}/penalty`, 'POST', { amountUsdt: amount, reason }, 'Đã trừ tiền cọc').then((r) => r && onClose())}
          >
            Trừ cọc
          </button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <p className="text-tx-2">Khoản trừ thu về sàn (không bồi thường ai). Bồi thường cho khách trong khiếu nại thì phân xử ở khu CSKH → Khiếu nại P2P.</p>
        <label className="block">
          <span className="label">Số USDT (cọc hiện có {m ? fmtCoin(m.depositUsdt) : 0})</span>
          <input className="input num mt-1" inputMode="decimal" value={amount} aria-invalid={over} onChange={(e) => setAmount(cleanDecimal(e.target.value))} />
        </label>
        <label className="block">
          <span className="label">Lý do (ghi vào nhật ký)</span>
          <input className="input mt-1" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </label>
      </div>
    </Modal>
  );
}

type FieldKind = 'int' | 'dec' | 'pct' | 'bool';
const FIELDS: { key: keyof P2PRules; label: string; kind: FieldKind; hint?: string }[] = [
  { key: 'usdtVnd', label: 'Tỷ giá tham chiếu USDT / VNĐ', kind: 'int', hint: 'Giá tham chiếu coin khác = giá Binance theo USDT × tỷ giá này' },
  { key: 'makerFee', label: 'Phí thương nhân (%)', kind: 'pct', hint: 'Thu bằng coin của đơn. Khách luôn miễn phí' },
  { key: 'merchantDepositUsdt', label: 'Tiền cọc thương nhân (USDT)', kind: 'dec' },
  { key: 'minAccountDays', label: 'Tuổi tài khoản tối thiểu (ngày)', kind: 'int' },
  { key: 'minCompletedOrders', label: 'Số đơn P2P hoàn tất tối thiểu', kind: 'int' },
  { key: 'minCompletionRate', label: 'Tỷ lệ hoàn tất tối thiểu (%)', kind: 'pct' },
  { key: 'requireEmailVerified', label: 'Bắt buộc xác thực email', kind: 'bool' },
  { key: 'require2fa', label: 'Bắt buộc bật 2FA', kind: 'bool' },
  { key: 'maxOpenAds', label: 'Số quảng cáo đang mở tối đa', kind: 'int' },
  { key: 'priceBandPct', label: 'Biên giá so với tham chiếu (±%)', kind: 'int' },
  { key: 'minOrderVnd', label: 'Đơn tối thiểu (VNĐ)', kind: 'int' },
  { key: 'takerCancelLimit', label: 'Số lần khách huỷ / ngày trước khi bị khoá', kind: 'int' },
  { key: 'appealAfterMinutes', label: 'Được khiếu nại sau khi thanh toán (phút)', kind: 'int' },
  { key: 'initialBankVnd', label: 'Số dư ngân hàng giả lập cấp ban đầu (VNĐ)', kind: 'int' },
];

/** Tham số P2P: ai có admin.view được xem, Vận hành thị trường (market.manage) được sửa */
function RulesSection({ editable }: { editable: boolean }) {
  const { data } = useAdminP2PRules();
  const act = useAdminAction();
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});

  useEffect(() => {
    if (!data) return;
    const d: Record<string, string | boolean> = {};
    for (const f of FIELDS) {
      const v = data.rules[f.key];
      d[f.key] = f.kind === 'bool' ? !!v : f.kind === 'pct' ? String(+(Number(v) * 100).toFixed(4)) : String(v);
    }
    setDraft(d);
  }, [data]);

  if (!data) return <Spinner className="m-4" />;
  const save = () => {
    const patch: Record<string, unknown> = {};
    for (const f of FIELDS) {
      const v = draft[f.key];
      const cur = data.rules[f.key];
      let next: unknown;
      if (f.kind === 'bool') next = !!v;
      else if (f.kind === 'pct') next = f.key === 'makerFee' ? String(Number(v) / 100) : Number(v) / 100;
      else if (typeof cur === 'number') next = Number(v);
      else next = String(v);
      if (String(next) !== String(cur)) patch[f.key] = next;
    }
    if (!Object.keys(patch).length) return;
    void act('/admin/p2p/rules', 'PUT', patch, 'Đã lưu tham số P2P');
  };

  return (
    <Section
      title="Tham số P2P"
      actions={
        editable && (
          <div className="flex gap-2">
            <button className="btn btn-ghost h-8 text-[12px]" onClick={() => void act('/admin/p2p/rules', 'DELETE', undefined, 'Đã khôi phục mặc định')}>
              Mặc định
            </button>
            <button className="btn btn-brand h-8 text-[12px]" onClick={save}>
              Lưu
            </button>
          </div>
        )
      }
    >
      {!editable && <p className="mb-3 text-[12px] text-tx-3">Chỉ Vận hành thị trường được sửa tham số P2P.</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="block text-[13px]">
            <span className="label">{f.label}</span>
            {f.kind === 'bool' ? (
              <div className="mt-1">
                <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" disabled={!editable} checked={!!draft[f.key]} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.checked }))} />
              </div>
            ) : (
              <input
                className="input num mt-1"
                disabled={!editable}
                value={String(draft[f.key] ?? '')}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: cleanDecimal(e.target.value) }))}
              />
            )}
            {f.hint && <span className="mt-0.5 block text-[11px] text-tx-3">{f.hint}</span>}
            {f.key in data.overrides && <span className="mt-0.5 block text-[11px] text-ref">Đã chỉnh (mặc định {String(data.defaults[f.key])})</span>}
          </label>
        ))}
      </div>
    </Section>
  );
}
