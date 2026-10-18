import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Clock, Headset, History, Lock, Search, ShieldCheck, UserRound, Wallet, X } from 'lucide-react';
import { ORDER_STATUS_LABEL, TICKET_CATEGORY_LABEL, can, isTicketActive, type OrderDTO, type TicketPriority } from '@vss/shared';
import { Pill, ReasonModal } from '../components/admin/adminUi';
import { Empty, Modal, Spinner } from '../components/common/ui';
import { P2PAppeals } from '../components/support/P2PAppeals';
import { ChatThread, Composer, OrderTimeline, OrderTimelineModal, PriorityPill, TicketStatusPill } from '../components/support/SupportUi';
import { cn, fmtDateTime, fmtPrice, fmtQty, fmtUsd } from '../lib/format';
import { useDeskStaff, useDeskStats, useDeskTicket, useDeskTickets, useIsStaff, useSupportCall, type DeskScope } from '../lib/support';
import { useAuth } from '../store/auth';

const SCOPES: { id: DeskScope; label: string }[] = [
  { id: 'active', label: 'Đang mở' },
  { id: 'unassigned', label: 'Chưa ai nhận' },
  { id: 'mine', label: 'Của tôi' },
  { id: 'overdue', label: 'Quá hạn' },
  { id: 'all', label: 'Tất cả' },
];

/** "còn 12 phút" / "quá 5 phút" */
function dueText(dueAt: string | null | undefined) {
  if (!dueAt) return null;
  const min = Math.round((Date.parse(dueAt) - Date.now()) / 60_000);
  return min >= 0 ? `còn ${min} phút` : `quá ${-min} phút`;
}

function ResolveModal({ open, onClose, onConfirm }: { open: boolean; onClose(): void; onConfirm(resolution: string): Promise<unknown> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setText('');
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Đóng yêu cầu (đã xử lý)"
      width={480}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Huỷ
          </button>
          <button
            className="btn btn-brand"
            disabled={text.trim().length < 5 || busy}
            onClick={async () => {
              setBusy(true);
              await onConfirm(text.trim());
              setBusy(false);
            }}
          >
            Đóng yêu cầu
          </button>
        </>
      }
    >
      <label className="block">
        <span className="label">Cách đã xử lý (khách hàng sẽ thấy và nhận email, tối thiểu 5 ký tự)</span>
        <textarea className="input mt-1 h-28 w-full resize-none py-2" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
    </Modal>
  );
}

function AdjustModal({ open, onClose, onConfirm }: { open: boolean; onClose(): void; onConfirm(v: { asset: string; amount: string; reason: string }): Promise<unknown> }) {
  const [asset, setAsset] = useState('USDT');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) {
      setAmount('');
      setReason('');
    }
  }, [open]);
  const ok = /^-?\d+(\.\d+)?$/.test(amount) && Number(amount) !== 0 && reason.trim().length >= 3;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Đề xuất điều chỉnh số dư"
      width={460}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn btn-brand" disabled={!ok} onClick={() => void onConfirm({ asset: asset.trim().toUpperCase(), amount, reason: reason.trim() })}>
            Gửi đề xuất
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[12px] text-tx-3">Đề xuất chỉ có hiệu lực khi một quản trị viên khác duyệt (nguyên tắc 2 người). Số âm = trừ số dư.</p>
        <div className="grid grid-cols-[100px_1fr] gap-2">
          <label className="block">
            <span className="label">Tài sản</span>
            <input className="input mt-1 h-9 w-full uppercase" value={asset} maxLength={15} onChange={(e) => setAsset(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">Số lượng</span>
            <input className="input mt-1 h-9 w-full" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.-]/g, ''))} placeholder="vd 20 hoặc -5" />
          </label>
        </div>
        <label className="block">
          <span className="label">Lý do (ghi vào sổ cái và nhật ký)</span>
          <textarea className="input mt-1 h-20 w-full resize-none py-2" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

function CustomerPanel({ id, onTimeline, onCancelOrder }: { id: number; onTimeline(o: number): void; onCancelOrder(o: OrderDTO): void }) {
  const { data } = useDeskTicket(id);
  if (!data) return <Spinner className="m-4" />;
  const c = data.customer;
  const cust = data.ticket.customer!;
  return (
    <div className="space-y-3 p-3 text-[12px]">
      <div>
        <div className="font-semibold">{cust.fullName}</div>
        <div className="text-tx-3">{cust.email}</div>
        {cust.status !== 'ACTIVE' && (
          <div className="mt-1">
            <Pill tone="bad">{cust.status === 'LOCKED' ? 'Đang bị khoá' : 'Đã xoá'}</Pill>
          </div>
        )}
      </div>
      {data.linkedOrder && (
        <section>
          <div className="label mb-1 flex items-center gap-1">
            <History size={12} /> Lệnh liên quan #{data.ticket.orderId}
          </div>
          {data.linkedOrder.order && (
            <div className="mb-1 rounded-md bg-bg-2 px-2 py-1.5">
              {data.linkedOrder.order.side === 'BUY' ? 'Mua' : 'Bán'} {data.linkedOrder.order.symbol} {fmtQty(data.linkedOrder.order.origQty)}
              {data.linkedOrder.order.price ? ` @ ${fmtPrice(data.linkedOrder.order.price)}` : ''} · {ORDER_STATUS_LABEL[data.linkedOrder.order.status]}
              {data.linkedOrder.order.reason ? ` · ${data.linkedOrder.order.reason}` : ''}
            </div>
          )}
          <OrderTimeline path={`/support-desk/tickets/${id}/orders/${data.ticket.orderId}/events`} />
        </section>
      )}
      <section>
        <div className="label mb-1 flex items-center gap-1">
          <Wallet size={12} /> Ví {c.account ? `≈ ${fmtUsd(c.account.totalUsdt)} USDT` : ''}
        </div>
        <div className="flex flex-wrap gap-1">
          {(c.account?.balances ?? [])
            .filter((b) => Number(b.total) > 0)
            .slice(0, 8)
            .map((b) => (
              <span key={b.asset} className="rounded bg-bg-2 px-1.5 py-0.5">
                {b.asset} {fmtQty(b.total)}
                {Number(b.locked) > 0 ? ` (khoá ${fmtQty(b.locked)})` : ''}
              </span>
            ))}
        </div>
      </section>
      <section>
        <div className="label mb-1">Lệnh đang mở ({c.openOrders.length})</div>
        {c.openOrders.slice(0, 10).map((o) => (
          <div key={o.id} className="flex items-center gap-1.5 border-b border-line py-1">
            <span className="flex-1">
              #{o.id} {o.side === 'BUY' ? 'Mua' : 'Bán'} {o.symbol} {fmtQty(o.origQty)} {o.price ? `@ ${fmtPrice(o.price)}` : ''}
            </span>
            <button className="text-tx-3 hover:text-brand" title="Nhật ký lệnh" aria-label={`Nhật ký lệnh ${o.id}`} onClick={() => onTimeline(o.id)}>
              <History size={13} />
            </button>
            <button className="text-tx-3 hover:text-down" title="Huỷ hộ lệnh" aria-label={`Huỷ hộ lệnh ${o.id}`} onClick={() => onCancelOrder(o)}>
              <X size={13} />
            </button>
          </div>
        ))}
      </section>
      <section>
        <div className="label mb-1">Lệnh gần đây</div>
        {c.recentOrders.slice(0, 10).map((o) => (
          <button key={o.id} onClick={() => onTimeline(o.id)} className="flex w-full gap-1.5 border-b border-line py-1 text-left hover:bg-bg-2">
            <span className="flex-1">
              #{o.id} {o.side === 'BUY' ? 'Mua' : 'Bán'} {o.symbol} · {ORDER_STATUS_LABEL[o.status]}
            </span>
            <span className="text-tx-3">{fmtDateTime(o.createdAt)}</span>
          </button>
        ))}
      </section>
      <section>
        <div className="label mb-1 flex items-center gap-1">
          <ShieldCheck size={12} /> Đăng nhập & bảo mật gần đây
        </div>
        {c.authEvents.slice(0, 10).map((e) => (
          <div key={e.id} className={cn('border-b border-line py-1', /FAIL|BLOCKED|LOCKED/.test(e.event) && 'text-down')}>
            {e.label} · {fmtDateTime(e.createdAt)} {e.ip ? `· IP ${e.ip}` : ''}
          </div>
        ))}
      </section>
    </div>
  );
}

function TicketView({ id }: { id: number }) {
  const { data, isLoading } = useDeskTicket(id);
  const { data: staffList } = useDeskStaff();
  const me = useAuth((s) => s.user);
  const call = useSupportCall();
  const [resolve, setResolve] = useState(false);
  const [lock, setLock] = useState(false);
  const [adjust, setAdjust] = useState(false);
  const [cancelOrder, setCancelOrder] = useState<OrderDTO | null>(null);
  const [timeline, setTimeline] = useState<number | null>(null);
  // Màn hình hẹp: hồ sơ khách mở dạng ngăn trượt bên phải
  const [panel, setPanel] = useState(false);
  if (isLoading || !data) return <Spinner className="m-6" />;
  const t = data.ticket;
  const active = isTicketActive(t.status);
  const base = `/support-desk/tickets/${t.id}`;
  // Trưởng nhóm (Quản trị hệ thống) giao được yêu cầu cho nhân viên khác
  const isAdmin = can(me?.role, 'support.lead');

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="space-y-1.5 border-b border-line px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">
              #{t.id} · {t.subject}
            </span>
            <TicketStatusPill status={t.status} />
            <PriorityPill priority={t.priority} />
            <button className="btn btn-ghost ml-auto h-7 text-[12px] xl:hidden" onClick={() => setPanel(true)}>
              <UserRound size={13} /> Hồ sơ khách
            </button>
            {t.overdue && (
              <span className="chip h-5 bg-down/15 text-[10px] text-down">
                <AlertTriangle size={10} className="mr-0.5" /> Quá hạn
              </span>
            )}
          </div>
          <div className="text-[12px] text-tx-3">
            {TICKET_CATEGORY_LABEL[t.category]} · {t.customer?.email} · gửi {fmtDateTime(t.createdAt)} · {t.assigneeEmail ? `phụ trách: ${t.assigneeEmail}` : 'chưa ai nhận'}
            {t.dueAt && <span className={cn('ml-1', t.overdue ? 'text-down' : 'text-ref')}>· hạn trả lời {dueText(t.dueAt)}</span>}
          </div>
          {active && (
            <div className="flex flex-wrap items-center gap-1.5">
              {t.assigneeEmail !== me?.email && (
                <button className="btn btn-brand h-7 text-[12px]" onClick={() => void call(`${base}/assign`, {}, 'Đã nhận xử lý')}>
                  Nhận xử lý
                </button>
              )}
              {isAdmin && (
                <select
                  className="input h-7 w-44 text-[12px]"
                  value=""
                  onChange={(e) => e.target.value && void call(`${base}/assign`, { assigneeId: e.target.value }, 'Đã giao việc')}
                  aria-label="Giao cho nhân viên"
                >
                  <option value="">Giao cho…</option>
                  {(staffList ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.email}
                    </option>
                  ))}
                </select>
              )}
              <select
                className="input h-7 w-32 text-[12px]"
                value={t.priority}
                onChange={(e) => void call(`${base}/update`, { priority: e.target.value as TicketPriority }, 'Đã đổi mức ưu tiên')}
                aria-label="Mức ưu tiên"
              >
                <option value="NORMAL">Bình thường</option>
                <option value="HIGH">Cao</option>
                <option value="URGENT">Khẩn cấp</option>
              </select>
              {t.status !== 'WAITING_CUSTOMER' && (
                <button className="btn btn-ghost h-7 text-[12px]" onClick={() => void call(`${base}/update`, { status: 'WAITING_CUSTOMER' }, 'Đã chuyển sang chờ khách')}>
                  <Clock size={12} /> Chờ khách
                </button>
              )}
              <button className="btn btn-ghost h-7 text-[12px]" onClick={() => setAdjust(true)}>
                Đề xuất điều chỉnh số dư
              </button>
              {t.customer?.status === 'ACTIVE' && (
                <button className="btn btn-ghost h-7 text-[12px] text-down" onClick={() => setLock(true)}>
                  <Lock size={12} /> Khoá khẩn
                </button>
              )}
              <button className="btn btn-up ml-auto h-7 text-[12px]" onClick={() => setResolve(true)}>
                Đã xử lý xong
              </button>
            </div>
          )}
          {t.resolution && <div className="rounded-md bg-up/10 px-2.5 py-1.5 text-[12px] text-up">Kết quả: {t.resolution}</div>}
          {t.rating && (
            <div className="text-[12px] text-tx-2">
              Khách đánh giá {t.rating}/5{t.ratingComment ? ` — "${t.ratingComment}"` : ''}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <ChatThread messages={data.messages} viewer="STAFF" />
        </div>
        <Composer
          allowInternal
          disabled={t.status === 'CLOSED' ? 'Yêu cầu đã đóng' : null}
          onSend={(body, internal) => call(`${base}/messages`, { body, internal })}
        />
      </div>
      {panel && <div className="fixed inset-0 z-30 bg-black/40 xl:hidden" onClick={() => setPanel(false)} />}
      <aside
        className={cn(
          'w-80 shrink-0 overflow-auto border-l border-line bg-bg-1',
          panel ? 'fixed inset-y-0 right-0 z-40 block xl:static xl:z-auto' : 'hidden xl:block',
        )}
        aria-label="Hồ sơ khách hàng"
      >
        <div className="flex items-center justify-between border-b border-line px-3 py-2 xl:hidden">
          <span className="font-semibold">Hồ sơ khách</span>
          <button className="rounded p-1 text-tx-3 hover:bg-bg-3" onClick={() => setPanel(false)} aria-label="Đóng hồ sơ khách">
            <X size={16} />
          </button>
        </div>
        <CustomerPanel id={t.id} onTimeline={setTimeline} onCancelOrder={setCancelOrder} />
      </aside>

      <ResolveModal
        open={resolve}
        onClose={() => setResolve(false)}
        onConfirm={async (resolution) => {
          if (await call(`${base}/update`, { status: 'RESOLVED', resolution }, 'Đã đóng yêu cầu')) setResolve(false);
        }}
      />
      <ReasonModal
        open={lock}
        danger
        title="Khoá khẩn tài khoản khách"
        description="Dùng khi khách báo bị truy cập trái phép. Mọi lệnh mở bị huỷ, phiên đăng nhập bị ngắt. Chỉ quản trị viên mở khoá được."
        confirmLabel="Khoá tài khoản"
        onClose={() => setLock(false)}
        onConfirm={async (reason) => {
          if (await call(`${base}/lock-user`, { reason }, 'Đã khoá tài khoản')) setLock(false);
        }}
      />
      <ReasonModal
        open={!!cancelOrder}
        danger
        title={`Huỷ hộ lệnh #${cancelOrder?.id ?? ''}`}
        description={cancelOrder ? `${cancelOrder.side === 'BUY' ? 'Mua' : 'Bán'} ${cancelOrder.symbol} ${fmtQty(cancelOrder.origQty)}` : ''}
        confirmLabel="Huỷ lệnh"
        onClose={() => setCancelOrder(null)}
        onConfirm={async (reason) => {
          if (await call(`${base}/cancel-order`, { orderId: cancelOrder!.id, reason }, 'Đã huỷ hộ lệnh')) setCancelOrder(null);
        }}
      />
      <AdjustModal
        open={adjust}
        onClose={() => setAdjust(false)}
        onConfirm={async (v) => {
          if (await call(`${base}/adjust-request`, v, 'Đã gửi đề xuất, chờ quản trị viên duyệt')) setAdjust(false);
        }}
      />
      <OrderTimelineModal orderId={timeline} path={timeline ? `${base}/orders/${timeline}/events` : undefined} onClose={() => setTimeline(null)} />
    </div>
  );
}

export default function SupportDeskPage() {
  const token = useAuth((s) => s.token);
  const staff = useIsStaff();
  const [params, setParams] = useSearchParams();
  const [scope, setScope] = useState<DeskScope>('active');
  const [q, setQ] = useState('');
  const { data: stats } = useDeskStats();
  const { data, isLoading, error } = useDeskTickets(scope, q.trim());
  const selected = Number(params.get('ticket')) || null;
  const role = useAuth((s) => s.user?.role);
  // Khiếu nại P2P (quyền p2p.appeal): ?view=p2p
  const canAppeal = can(role, 'p2p.appeal');
  const view = canAppeal && params.get('view') === 'p2p' ? 'p2p' : 'tickets';

  useEffect(() => {
    document.title = 'Chăm sóc khách hàng · VNCoin';
  }, []);

  if (!token) return <Navigate to="/login" replace state={{ from: '/cskh' }} />;
  if (!staff) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Empty icon={<ShieldCheck size={32} strokeWidth={1.5} />} title="Khu vực dành cho nhân viên chăm sóc khách hàng" hint="Cần tài khoản có vai trò Nhân viên CSKH hoặc Quản trị viên." />
      </div>
    );
  }
  if (error) return <Empty title="Không vào được khu vực CSKH" hint={(error as Error).message} />;

  const switcher = canAppeal && (
    <div className="flex gap-0.5 rounded-md bg-bg-2 p-0.5" role="tablist" aria-label="Loại công việc">
      {(
        [
          ['tickets', 'Yêu cầu hỗ trợ'],
          ['p2p', 'Khiếu nại P2P'],
        ] as const
      ).map(([v, label]) => (
        <button
          key={v}
          role="tab"
          aria-selected={view === v}
          onClick={() => setParams(v === 'p2p' ? { view: 'p2p' } : {}, { replace: true })}
          className={cn('h-7 rounded px-2.5 text-[12px] font-medium', view === v ? 'bg-bg-1 text-tx-1' : 'text-tx-3 hover:text-tx-1')}
        >
          {label}
        </button>
      ))}
    </div>
  );
  if (view === 'p2p') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <Headset size={18} className="text-brand" />
          <span className="font-semibold">Chăm sóc khách hàng</span>
          {switcher}
        </div>
        <P2PAppeals />
      </div>
    );
  }

  const counts: Partial<Record<DeskScope, number>> = { active: stats?.open, unassigned: stats?.unassigned, mine: stats?.mine, overdue: stats?.overdue };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Headset size={18} className="text-brand" />
        <span className="font-semibold">Chăm sóc khách hàng</span>
        {switcher}
        <div className="flex gap-1">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              onClick={() => setScope(s.id)}
              className={cn(
                'h-7 rounded-md px-2.5 text-[12px] font-medium',
                scope === s.id ? 'bg-brand/12 text-brand' : 'text-tx-2 hover:bg-bg-3',
                s.id === 'overdue' && (stats?.overdue ?? 0) > 0 && scope !== s.id && 'text-down',
              )}
            >
              {s.label}
              {counts[s.id] ? ` (${counts[s.id]})` : ''}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-tx-3" />
          <input className="input h-8 w-60 pl-7 text-[12px]" placeholder="Email, tiêu đề, #yêu cầu, #lệnh" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Tìm yêu cầu" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="w-80 shrink-0 overflow-auto border-r border-line">
          {isLoading ? (
            <Spinner className="m-4" />
          ) : !data?.length ? (
            <Empty title="Không có yêu cầu nào" />
          ) : (
            data.map((t) => (
              <button
                key={t.id}
                onClick={() => setParams({ ticket: String(t.id) })}
                className={cn('block w-full border-b border-line px-3 py-2.5 text-left hover:bg-bg-2', selected === t.id && 'bg-brand/8', t.overdue && 'border-l-2 border-l-down')}
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium">
                    #{t.id} {t.subject}
                  </span>
                  {t.unread > 0 && <span className="ml-auto rounded-full bg-brand px-1.5 text-[10px] font-bold text-white">{t.unread}</span>}
                </div>
                <div className="truncate text-[11px] text-tx-3">{t.customer?.email}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
                  <PriorityPill priority={t.priority} />
                  <TicketStatusPill status={t.status} />
                  {t.dueAt && <span className={t.overdue ? 'text-down' : 'text-tx-3'}>{dueText(t.dueAt)}</span>}
                  {!t.assigneeEmail && isTicketActive(t.status) && <span className="text-ref">chưa ai nhận</span>}
                </div>
              </button>
            ))
          )}
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">{selected ? <TicketView key={selected} id={selected} /> : <Empty title="Chọn một yêu cầu để xử lý" />}</section>
      </div>
    </div>
  );
}
