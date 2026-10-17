import { useState } from 'react';
import { Search, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { LEDGER_LABEL, ORDER_STATUS_LABEL, ROLE_LABEL, type UserRole } from '@vss/shared';
import { OrderTimelineModal } from '../support/SupportUi';
import { AUDIT_LABEL, auditSummary, useAdminAction, useAdminUser, useAdminUsers, type AdminUserDetail } from '../../lib/admin';
import { cleanDecimal, cn, decOrNull, fmtDateTime, fmtInt, fmtPct, fmtPrice, fmtQty, fmtUsd, signTone, toneText } from '../../lib/format';
import { useAuth } from '../../store/auth';
import { Empty, Modal, Spinner, UnderlineTabs } from '../common/ui';
import { STATUS_STYLE, SideChip, typeLabel } from '../trade/OrdersPanel';
import { KeyValue, Pill, ReasonModal, fmtAgo } from './adminUi';

type ActionKind = 'lock' | 'unlock' | 'adjust' | 'reset' | 'role' | 'delete' | 'verify' | 'reset2fa' | null;

function UserActions({ d, onDeleted }: { d: AdminUserDetail; onDeleted(): void }) {
  const me = useAuth((s) => s.user);
  const act = useAdminAction();
  const [kind, setKind] = useState<ActionKind>(null);
  const [amountText, setAmountText] = useState('');
  const [asset, setAsset] = useState('USDT');
  const [sign, setSign] = useState<1 | -1>(1);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [role, setRole] = useState<UserRole>(d.user.role);
  const u = d.user;
  const self = me?.id === u.id;
  const base = `/admin/users/${u.id}`;
  const amount = decOrNull(amountText);
  const close = () => {
    setKind(null);
    setAmountText('');
    setConfirmEmail('');
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {u.status === 'ACTIVE' ? (
          <button className="btn btn-ghost h-8 text-down" disabled={self || u.role !== 'USER'} onClick={() => setKind('lock')} title={u.role !== 'USER' ? 'Thu quyền nhân viên trước' : undefined}>
            Khoá tài khoản
          </button>
        ) : (
          <button className="btn btn-ghost h-8 text-up" onClick={() => setKind('unlock')}>
            Mở khoá
          </button>
        )}
        <button className="btn btn-ghost h-8" disabled={self} onClick={() => setKind('adjust')} title={self ? 'Không tự điều chỉnh số dư của mình' : undefined}>
          Điều chỉnh số dư
        </button>
        <button className="btn btn-ghost h-8" disabled={self} onClick={() => setKind('reset')}>
          Đặt lại tài khoản
        </button>
        <button
          className="btn btn-ghost h-8"
          disabled={self}
          onClick={() => {
            setRole(u.role);
            setKind('role');
          }}
        >
          Đổi vai trò ({ROLE_LABEL[u.role]})
        </button>
        {!u.emailVerified && (
          <button className="btn btn-ghost h-8" onClick={() => setKind('verify')}>
            Xác thực email hộ
          </button>
        )}
        {u.twoFactorEnabled && (
          <button className="btn btn-ghost h-8" onClick={() => setKind('reset2fa')}>
            Tắt 2FA hộ
          </button>
        )}
        <button className="btn btn-ghost h-8 text-down" disabled={self || u.role !== 'USER'} onClick={() => setKind('delete')}>
          Xoá tài khoản
        </button>
      </div>

      <ReasonModal
        open={kind === 'verify'}
        title={`Xác thực email ${u.email}`}
        description="Chỉ dùng khi đã xác minh người dùng sở hữu email này qua kênh khác (vd. người dùng không nhận được email)."
        confirmLabel="Đánh dấu đã xác thực"
        requireReason={false}
        onClose={close}
        onConfirm={async () => {
          if (await act(`${base}/verify-email`, 'POST', {}, 'Đã xác thực email')) close();
        }}
      />
      <ReasonModal
        open={kind === 'reset2fa'}
        title={`Tắt xác thực 2 lớp của ${u.email}`}
        description="Dùng khi người dùng mất điện thoại và hết mã khôi phục. Hãy xác minh danh tính trước — người dùng sẽ nhận email thông báo."
        confirmLabel="Tắt 2FA"
        danger
        placeholder="Ví dụ: Đã xác minh qua cuộc gọi, mất điện thoại…"
        onClose={close}
        onConfirm={async (reason) => {
          if (await act(`${base}/reset-2fa`, 'POST', { reason }, 'Đã tắt 2FA')) close();
        }}
      />

      <ReasonModal
        open={kind === 'lock'}
        title={`Khoá tài khoản ${u.email}`}
        description="Người dùng bị đăng xuất ngay, mọi lệnh đang chờ bị huỷ và không thể đăng nhập dùng tiếp cho tới khi được mở khoá."
        confirmLabel="Khoá tài khoản"
        danger
        placeholder="Ví dụ: Gian lận, spam lệnh, theo yêu cầu người dùng…"
        onClose={close}
        onConfirm={async (reason) => {
          if (await act(`${base}/lock`, 'POST', { reason }, `Đã khoá ${u.email}`)) close();
        }}
      />
      <ReasonModal
        open={kind === 'unlock'}
        title={`Mở khoá ${u.email}`}
        description={u.lockedReason ? `Lý do khoá trước đó: ${u.lockedReason}` : undefined}
        confirmLabel="Mở khoá"
        requireReason={false}
        onClose={close}
        onConfirm={async () => {
          if (await act(`${base}/unlock`, 'POST', {}, `Đã mở khoá ${u.email}`)) close();
        }}
      />
      <ReasonModal
        open={kind === 'adjust'}
        title="Điều chỉnh số dư"
        description={(() => {
          const b = d.account.balances.find((x) => x.asset === asset);
          return `Số dư ${asset} hiện tại: khả dụng ${b ? fmtQty(b.free) : '0'}, đang khoá ${b ? fmtQty(b.locked) : '0'}. Giá trị quy USDT được cộng vào vốn đã góp để lãi/lỗ và bảng xếp hạng không bị sai lệch. Từ ngưỡng phê duyệt trở lên sẽ thành yêu cầu, cần một quản trị viên khác duyệt.`;
        })()}
        confirmLabel={amount ? `${sign > 0 ? 'Cộng' : 'Trừ'} ${amount} ${asset}` : 'Xác nhận'}
        canConfirm={!!amount}
        placeholder="Ví dụ: Thưởng giải đấu tháng 10, sửa sai sót..."
        extra={
          <div>
            <div className="grid grid-cols-2 rounded-md bg-bg-3 p-1">
              {([1, -1] as const).map((s) => (
                <button key={s} onClick={() => setSign(s)} className={cn('h-8 rounded text-[13px] font-semibold', sign === s ? (s === 1 ? 'bg-up text-white' : 'bg-down text-white') : 'text-tx-3')}>
                  {s === 1 ? 'Cộng' : 'Trừ'}
                </button>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                className="input num flex-1"
                placeholder="Số lượng"
                inputMode="decimal"
                value={amountText}
                onChange={(e) => setAmountText(cleanDecimal(e.target.value))}
              />
              <input className="input w-24 uppercase" value={asset} onChange={(e) => setAsset(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} aria-label="Tài sản" />
            </div>
            {asset === 'USDT' && (
              <div className="mt-2 flex gap-1">
                {[100, 1_000, 5_000, 10_000].map((v) => (
                  <button key={v} className="h-7 flex-1 rounded border border-line text-[11px] text-tx-2 hover:border-brand hover:text-brand" onClick={() => setAmountText(String(v))}>
                    {fmtInt(v)}
                  </button>
                ))}
              </div>
            )}
          </div>
        }
        onClose={close}
        onConfirm={async (reason) => {
          if (!amount) return;
          const r = await act<{ pending?: boolean; request?: { id: number } }>(
            `${base}/adjust-balance`,
            'POST',
            { asset, amount: sign > 0 ? amount : `-${amount}`, reason },
            'Đã gửi điều chỉnh',
          );
          if (r?.pending) toast.info(`Giá trị lớn: đã tạo yêu cầu #${r.request?.id}, chờ quản trị viên khác duyệt (mục Duyệt điều chỉnh)`, { duration: 10_000 });
          if (r) close();
        }}
      />
      <ReasonModal
        open={kind === 'reset'}
        title={`Đặt lại tài khoản ${u.email}`}
        description="Xoá toàn bộ lệnh, khớp lệnh, số dư coin và sổ cái của người dùng; ví về vốn ảo ban đầu (USDT). Không hoàn tác được."
        confirmLabel="Đặt lại"
        danger
        onClose={close}
        onConfirm={async (reason) => {
          if (await act(`${base}/reset`, 'POST', { reason }, 'Đã đặt lại tài khoản')) close();
        }}
      />
      <ReasonModal
        open={kind === 'role'}
        title={`Đổi vai trò của ${u.email}`}
        description="Nhân viên CSKH: trả lời khách, xem hồ sơ khách qua yêu cầu hỗ trợ, huỷ hộ lệnh, khoá khẩn, đề xuất điều chỉnh (cần quản trị viên duyệt). Quản trị viên: toàn quyền. Ở môi trường thật nhân viên phải bật 2FA."
        confirmLabel="Lưu vai trò"
        requireReason={false}
        canConfirm={role !== u.role}
        extra={
          <select className="input h-9 w-full" value={role} onChange={(e) => setRole(e.target.value as UserRole)} aria-label="Vai trò">
            {(['USER', 'SUPPORT', 'ADMIN'] as UserRole[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        }
        onClose={close}
        onConfirm={async () => {
          if (await act(`${base}/role`, 'POST', { role }, 'Đã cập nhật vai trò')) close();
        }}
      />
      <ReasonModal
        open={kind === 'delete'}
        title={`Xoá tài khoản ${u.email}`}
        description="Xoá thông tin cá nhân (email, họ tên, mật khẩu, 2FA) và chặn đăng nhập. Lệnh, khớp lệnh, sổ cái, tin nhắn hỗ trợ được GIỮ LẠI ở dạng ẩn danh để đối soát và giải quyết khiếu nại. Không hoàn tác được."
        confirmLabel="Xoá tài khoản"
        danger
        requireReason={false}
        canConfirm={confirmEmail.trim().toLowerCase() === u.email}
        extra={
          <label className="block">
            <span className="label">
              Gõ lại email <b className="text-tx-1">{u.email}</b> để xác nhận
            </span>
            <input className="input mt-1" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} />
          </label>
        }
        onClose={close}
        onConfirm={async () => {
          if (await act(base, 'DELETE', { confirmEmail: confirmEmail.trim().toLowerCase() }, `Đã xoá ${u.email}`)) {
            close();
            onDeleted();
          }
        }}
      />
    </>
  );
}

export function UserDetailModal({ id, onClose }: { id: string | null; onClose(): void }) {
  const { data: d, isLoading } = useAdminUser(id);
  const [tab, setTab] = useState<'balances' | 'orders' | 'ledger' | 'audit' | 'logins'>('balances');
  const [timeline, setTimeline] = useState<number | null>(null);
  return (
    <Modal open={!!id} onClose={onClose} title="Hồ sơ người dùng" width={920}>
      {isLoading || !d ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[17px] font-bold">{d.user.fullName}</span>
                {d.user.role !== 'USER' && <Pill tone="brand">{ROLE_LABEL[d.user.role]}</Pill>}
                {d.user.status === 'LOCKED' ? <Pill tone="bad">Đã khoá</Pill> : d.user.status === 'DELETED' ? <Pill tone="muted">Đã xoá (ẩn danh)</Pill> : <Pill tone="good">Hoạt động</Pill>}
                {d.user.online && <Pill tone="info">Đang trực tuyến</Pill>}
                {d.user.emailVerified ? <Pill tone="good">Email đã xác thực</Pill> : <Pill tone="warn">Email chưa xác thực</Pill>}
                {d.user.twoFactorEnabled && <Pill tone="info">2FA</Pill>}
              </div>
              <div className="text-[12px] text-tx-3">
                {d.user.email} · tạo {fmtDateTime(d.user.createdAt)} · hoạt động {fmtAgo(d.user.lastSeenAt)}
              </div>
              {d.user.lockedReason && <div className="mt-1 text-[12px] text-down">Lý do khoá: {d.user.lockedReason}</div>}
            </div>
          </div>
          {d.user.status !== 'DELETED' && <UserActions d={d} onDeleted={onClose} />}
          <OrderTimelineModal orderId={timeline} path={timeline ? `/admin/orders/${timeline}/events` : undefined} onClose={() => setTimeline(null)} />
          {(() => {
            const nav = Number(d.account.totalUsdt);
            const base = Number(d.account.contributedUsdt);
            const usdt = d.account.balances.find((b) => b.asset === 'USDT');
            return (
              <KeyValue
                items={[
                  ['Tổng tài sản', `${fmtUsd(nav)} USDT`],
                  ['Lãi / lỗ so với vốn', <span className={toneText[signTone(nav - base)]}>{fmtPct(base ? ((nav - base) / base) * 100 : 0)}</span>],
                  ['USDT khả dụng', fmtUsd(usdt?.free ?? 0)],
                  ['USDT đang khoá', fmtUsd(usdt?.locked ?? 0)],
                  ['Vốn đã góp', `${fmtUsd(base)} USDT`],
                  ['Trả phí bằng BNB', d.account.payFeeWithBnb ? 'Bật' : 'Tắt'],
                  ['Số lần khớp', fmtInt(d.stats.trades)],
                  ['Lãi / lỗ đã thực hiện', <span className={toneText[signTone(d.stats.realized)]}>{fmtUsd(d.stats.realized)} USDT</span>],
                  ['Tổng phí đã trả', `${fmtUsd(d.stats.fees)} USDT`],
                  ['Cặp đang theo dõi', fmtInt(d.stats.watch)],
                ]}
              />
            );
          })()}
          <div className="rounded-lg border border-line">
            <UnderlineTabs
              value={tab}
              onChange={setTab}
              items={[
                { value: 'balances', label: `Ví (${d.account.balances.length})` },
                { value: 'orders', label: 'Lệnh gần đây' },
                { value: 'ledger', label: 'Sổ cái' },
                { value: 'audit', label: 'Lịch sử quản trị' },
                { value: 'logins', label: 'Đăng nhập & bảo mật' },
              ]}
            />
            <div className="max-h-[320px] overflow-auto">
              {tab === 'balances' &&
                (d.account.balances.length ? (
                  <table className="tbl num w-full text-[12px]">
                    <thead>
                      <tr className="h-8 text-left">
                        <th className="px-3">Tài sản</th>
                        <th className="px-2 text-right">Tổng</th>
                        <th className="px-2 text-right">Khả dụng</th>
                        <th className="px-2 text-right">Đang khoá</th>
                        <th className="px-2 text-right">Giá vốn TB</th>
                        <th className="px-3 text-right">Giá trị (USDT)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.account.balances.map((b) => (
                        <tr key={b.asset} className="h-8 border-t border-line">
                          <td className="px-3 font-semibold">{b.asset}</td>
                          <td className="px-2 text-right">{fmtQty(b.total)}</td>
                          <td className="px-2 text-right">{fmtQty(b.free)}</td>
                          <td className="px-2 text-right">{fmtQty(b.locked)}</td>
                          <td className="px-2 text-right">{b.avgCost ? fmtPrice(b.avgCost) : '--'}</td>
                          <td className="px-3 text-right">{fmtUsd(b.usdtValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Empty title="Ví trống" />
                ))}
              {tab === 'orders' &&
                (d.orders.length ? (
                  <table className="tbl num w-full text-[12px]">
                    <thead>
                      <tr className="h-8 text-left">
                        <th className="px-3">Số hiệu</th>
                        <th className="px-2">Thời gian</th>
                        <th className="px-2">Cặp</th>
                        <th className="px-2">Lệnh</th>
                        <th className="px-2 text-right">Giá</th>
                        <th className="px-2 text-right">KL / khớp</th>
                        <th className="px-3">Trạng thái</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.orders.map((o) => (
                        <tr key={o.id} className="h-8 border-t border-line">
                          <td className="px-3 text-tx-3">
                            <button className="hover:text-brand hover:underline" onClick={() => setTimeline(o.id)} title="Xem nhật ký lệnh">
                              #{o.id}
                            </button>
                          </td>
                          <td className="px-2">{fmtDateTime(o.createdAt)}</td>
                          <td className="px-2 font-semibold">{o.symbol}</td>
                          <td className="px-2">
                            <SideChip side={o.side} /> <span className="text-tx-3">{typeLabel(o)}</span>
                          </td>
                          <td className="px-2 text-right">{o.price ? fmtPrice(o.price) : 'Thị trường'}</td>
                          <td className="px-2 text-right">
                            {fmtQty(o.origQty)} / {fmtQty(o.executedQty)}
                          </td>
                          <td className="px-3">
                            <span className={cn('chip h-5 text-[10px]', STATUS_STYLE[o.status])} title={o.reason ?? undefined}>
                              {ORDER_STATUS_LABEL[o.status]}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Empty title="Chưa có lệnh" />
                ))}
              {tab === 'ledger' &&
                (d.ledger.length ? (
                  <table className="tbl num w-full text-[12px]">
                    <thead>
                      <tr className="h-8 text-left">
                        <th className="px-3">Thời gian</th>
                        <th className="px-2">Tài sản</th>
                        <th className="px-2">Loại</th>
                        <th className="px-2 text-right">Phát sinh</th>
                        <th className="px-2 text-right">Số dư sau</th>
                        <th className="px-3">Diễn giải</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.ledger.map((l) => (
                        <tr key={l.id} className="h-8 border-t border-line">
                          <td className="px-3">{fmtDateTime(l.createdAt)}</td>
                          <td className="px-2 font-medium">{l.asset}</td>
                          <td className="px-2">{LEDGER_LABEL[l.type] ?? l.type}</td>
                          <td className={cn('px-2 text-right', toneText[signTone(l.amount)])}>
                            {Number(l.amount) > 0 ? '+' : ''}
                            {fmtQty(l.amount)}
                          </td>
                          <td className="px-2 text-right">{fmtQty(l.balanceAfter)}</td>
                          <td className="max-w-[280px] truncate px-3 text-tx-2">{l.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Empty title="Chưa có phát sinh" />
                ))}
              {tab === 'audit' &&
                (d.audit.length ? (
                  <ul className="divide-y divide-line">
                    {d.audit.map((a) => (
                      <li key={a.id} className="flex flex-wrap gap-x-3 px-3 py-2 text-[12px]">
                        <span className="num text-tx-3">{fmtDateTime(a.created_at)}</span>
                        <Pill tone="brand">{AUDIT_LABEL[a.action] ?? a.action}</Pill>
                        <span className="text-tx-2">{auditSummary(a)}</span>
                        <span className="ml-auto text-tx-3">{a.admin_email}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty title="Chưa có thao tác quản trị nào với tài khoản này" />
                ))}
              {tab === 'logins' &&
                (d.authEvents.length ? (
                  <ul className="divide-y divide-line">
                    {d.authEvents.map((e) => (
                      <li key={e.id} className={cn('flex flex-wrap gap-x-3 px-3 py-2 text-[12px]', /FAIL|BLOCKED|LOCKED/.test(e.event) && 'text-down')}>
                        <span className="num text-tx-3">{fmtDateTime(e.createdAt)}</span>
                        <span className="font-medium">{e.label}</span>
                        {e.ip && <span className="text-tx-3">IP {e.ip}</span>}
                        {e.userAgent && <span className="max-w-[360px] truncate text-tx-3">{e.userAgent}</span>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty title="Chưa có nhật ký đăng nhập" />
                ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CreateUserModal({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(id: string): void }) {
  const act = useAdminAction();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const gen = () => setPassword(`Vss${Math.random().toString(36).slice(2, 8)}${Math.floor(10 + Math.random() * 89)}`);
  const ok = fullName.trim().length >= 2 && /\S+@\S+\.\S+/.test(email) && password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="Tạo tài khoản nhà đầu tư"
      width={440}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Huỷ
          </button>
          <button
            className="btn btn-brand"
            disabled={!ok || busy}
            onClick={async () => {
              setBusy(true);
              const r = await act<{ id: string }>('/admin/users', 'POST', { fullName: fullName.trim(), email: email.trim(), password }, `Đã tạo ${email.trim()}`);
              setBusy(false);
              if (r) {
                setFullName('');
                setEmail('');
                setPassword('');
                onCreated(r.id);
              }
            }}
          >
            Tạo tài khoản
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[12px] text-tx-3">Dùng khi mở tài khoản cho một lớp học hoặc giải đấu. Tài khoản mới được cấp vốn ảo như khi tự đăng ký; hãy gửi mật khẩu cho người dùng và nhắc họ đổi ngay.</p>
        <label className="block">
          <span className="label">Họ và tên</span>
          <input className="input mt-1" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Email</span>
          <input className="input mt-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Mật khẩu ban đầu (≥ 8 ký tự, có chữ và số)</span>
          <div className="mt-1 flex gap-2">
            <input className="input font-mono" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="btn btn-ghost h-9 shrink-0" onClick={gen}>
              Tạo ngẫu nhiên
            </button>
          </div>
        </label>
      </div>
    </Modal>
  );
}

export function Users({ onOpenUser }: { onOpenUser(id: string): void }) {
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const { data, isLoading } = useAdminUsers({ q: q.trim() || undefined, status: status || undefined, role: role || undefined });

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="mr-auto font-semibold">Người dùng {data ? `(${data.length})` : ''}</h2>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx-3" />
          <input className="input h-8 w-64 pl-8" placeholder="Tìm email hoặc họ tên" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input h-8 w-36" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Lọc trạng thái">
          <option value="">Mọi trạng thái</option>
          <option value="ACTIVE">Hoạt động</option>
          <option value="LOCKED">Đã khoá</option>
        </select>
        <select className="input h-8 w-36" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Lọc vai trò">
          <option value="">Mọi vai trò</option>
          <option value="USER">Nhà đầu tư</option>
          <option value="ADMIN">Quản trị viên</option>
        </select>
        <button className="btn btn-brand h-8" onClick={() => setCreating(true)}>
          <UserPlus size={14} /> Tạo tài khoản
        </button>
      </div>
      <CreateUserModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          onOpenUser(id);
        }}
      />
      <div className="overflow-x-auto">
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : !data?.length ? (
          <Empty title="Không có người dùng phù hợp" />
        ) : (
          <table className="tbl num w-full min-w-[980px] text-[12.5px]">
            <thead>
              <tr className="h-9 text-left">
                <th className="px-4">Người dùng</th>
                <th className="px-2">Trạng thái</th>
                <th className="px-2">Ngày tạo</th>
                <th className="px-2">Hoạt động</th>
                <th className="px-2 text-right">Tổng tài sản</th>
                <th className="px-2 text-right">Lãi / lỗ</th>
                <th className="px-2 text-right">USDT</th>
                <th className="px-2 text-right">Lệnh</th>
                <th className="px-4 text-right" />
              </tr>
            </thead>
            <tbody>
              {data.map((u) => (
                <tr key={u.id} className="h-12 cursor-pointer border-t border-line hover:bg-bg-2" onClick={() => onOpenUser(u.id)}>
                  <td className="px-4">
                    <div className="flex items-center gap-1.5 font-medium">
                      <span className={cn('h-1.5 w-1.5 rounded-full', u.online ? 'bg-up' : 'bg-bg-4')} title={u.online ? 'Đang trực tuyến' : 'Ngoại tuyến'} />
                      {u.fullName}
                      {u.role === 'ADMIN' && <Pill tone="brand">QTV</Pill>}
                      {u.role === 'SUPPORT' && <Pill tone="info">CSKH</Pill>}
                      {u.twoFactorEnabled && <Pill tone="info">2FA</Pill>}
                      {!u.emailVerified && <Pill tone="warn">Chưa xác thực</Pill>}
                    </div>
                    <div className="text-[11px] text-tx-3">{u.email}</div>
                  </td>
                  <td className="px-2">{u.status === 'LOCKED' ? <span title={u.lockedReason ?? ''}><Pill tone="bad">Đã khoá</Pill></span> : <Pill tone="good">Hoạt động</Pill>}</td>
                  <td className="px-2 text-tx-2">{fmtDateTime(u.createdAt).slice(0, 10)}</td>
                  <td className="px-2 text-tx-2">{fmtAgo(u.lastSeenAt)}</td>
                  <td className="px-2 text-right">{fmtUsd(u.nav)}</td>
                  <td className={cn('px-2 text-right font-medium', toneText[signTone(u.pnl)])}>{fmtPct(u.pnlPct)}</td>
                  <td className="px-2 text-right">{fmtUsd(u.usdt)}</td>
                  <td className="px-2 text-right">
                    {fmtInt(u.ordersCount)}
                    <span className="text-tx-3"> / {fmtInt(u.tradesCount)} khớp</span>
                  </td>
                  <td className="px-4 text-right text-brand">Chi tiết →</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
