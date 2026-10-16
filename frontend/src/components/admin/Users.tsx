import { useState } from 'react';
import { Search, UserPlus } from 'lucide-react';
import { LEDGER_LABEL, ORDER_STATUS_LABEL } from '@vss/shared';
import { AUDIT_LABEL, auditSummary, useAdminAction, useAdminUser, useAdminUsers, type AdminUserDetail } from '../../lib/admin';
import { cn, fmtCompact, fmtDateTimeVN, fmtInt, fmtPct, fmtPrice, fmtVnd, parseIntInput, signTone, toneText } from '../../lib/format';
import { useAuth } from '../../store/auth';
import { Empty, Modal, Spinner, UnderlineTabs } from '../common/ui';
import { STATUS_STYLE, SideChip } from '../trade/OrdersPanel';
import { KeyValue, Pill, ReasonModal, fmtAgo } from './adminUi';

type ActionKind = 'lock' | 'unlock' | 'adjust' | 'reset' | 'grant' | 'revoke' | 'delete' | 'verify' | 'reset2fa' | null;

function UserActions({ d, onDeleted }: { d: AdminUserDetail; onDeleted(): void }) {
  const me = useAuth((s) => s.user);
  const act = useAdminAction();
  const [kind, setKind] = useState<ActionKind>(null);
  const [amountText, setAmountText] = useState('');
  const [sign, setSign] = useState<1 | -1>(1);
  const [confirmEmail, setConfirmEmail] = useState('');
  const u = d.user;
  const self = me?.id === u.id;
  const base = `/admin/users/${u.id}`;
  const amount = parseIntInput(amountText) * sign;
  const close = () => {
    setKind(null);
    setAmountText('');
    setConfirmEmail('');
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {u.status === 'ACTIVE' ? (
          <button className="btn btn-ghost h-8 text-down" disabled={self || u.role === 'ADMIN'} onClick={() => setKind('lock')} title={u.role === 'ADMIN' ? 'Thu quyền quản trị trước' : undefined}>
            Khoá tài khoản
          </button>
        ) : (
          <button className="btn btn-ghost h-8 text-up" onClick={() => setKind('unlock')}>
            Mở khoá
          </button>
        )}
        <button className="btn btn-ghost h-8" onClick={() => setKind('adjust')}>
          Điều chỉnh vốn ảo
        </button>
        <button className="btn btn-ghost h-8" onClick={() => setKind('reset')}>
          Đặt lại tài khoản
        </button>
        {u.role === 'USER' ? (
          <button className="btn btn-ghost h-8" disabled={self || u.status === 'LOCKED'} onClick={() => setKind('grant')}>
            Cấp quyền quản trị
          </button>
        ) : (
          <button className="btn btn-ghost h-8" disabled={self} onClick={() => setKind('revoke')}>
            Thu quyền quản trị
          </button>
        )}
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
        <button className="btn btn-ghost h-8 text-down" disabled={self || u.role === 'ADMIN'} onClick={() => setKind('delete')}>
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
        title="Điều chỉnh vốn ảo"
        description={d.account ? `Tiền mặt hiện tại ${fmtVnd(d.account.cashBalance)}đ, đang phong toả ${fmtVnd(d.account.cashHold)}đ.` : undefined}
        confirmLabel={amount ? `${amount > 0 ? 'Cộng' : 'Trừ'} ${fmtVnd(Math.abs(amount))}đ` : 'Xác nhận'}
        canConfirm={amount !== 0}
        placeholder="Ví dụ: Thưởng giải đấu tháng 10, sửa sai sót…"
        extra={
          <div>
            <div className="grid grid-cols-2 rounded-md bg-bg-3 p-1">
              {([1, -1] as const).map((s) => (
                <button key={s} onClick={() => setSign(s)} className={cn('h-8 rounded text-[13px] font-semibold', sign === s ? (s === 1 ? 'bg-up text-white' : 'bg-down text-white') : 'text-tx-3')}>
                  {s === 1 ? 'Cộng tiền' : 'Trừ tiền'}
                </button>
              ))}
            </div>
            <input className="input num mt-2" placeholder="Số tiền (VNĐ)" value={amountText} onChange={(e) => setAmountText(e.target.value ? fmtInt(parseIntInput(e.target.value)) : '')} />
            <div className="mt-2 flex gap-1">
              {[10_000_000, 100_000_000, 500_000_000, 1_000_000_000].map((v) => (
                <button key={v} className="h-7 flex-1 rounded border border-line text-[11px] text-tx-2 hover:border-brand hover:text-brand" onClick={() => setAmountText(fmtInt(v))}>
                  {fmtCompact(v)}
                </button>
              ))}
            </div>
          </div>
        }
        onClose={close}
        onConfirm={async (reason) => {
          if (await act(`${base}/adjust-cash`, 'POST', { amount, reason }, 'Đã điều chỉnh vốn ảo')) close();
        }}
      />
      <ReasonModal
        open={kind === 'reset'}
        title={`Đặt lại tài khoản ${u.email}`}
        description="Xoá toàn bộ lệnh, khớp, danh mục, sao kê của người dùng; tiền mặt về vốn ban đầu. Không hoàn tác được."
        confirmLabel="Đặt lại"
        danger
        onClose={close}
        onConfirm={async (reason) => {
          if (await act(`${base}/reset`, 'POST', { reason }, 'Đã đặt lại tài khoản')) close();
        }}
      />
      <ReasonModal
        open={kind === 'grant' || kind === 'revoke'}
        title={kind === 'grant' ? `Cấp quyền quản trị cho ${u.email}` : `Thu quyền quản trị của ${u.email}`}
        description={
          kind === 'grant'
            ? 'Người này sẽ xem được dữ liệu mọi tài khoản và thực hiện mọi thao tác quản trị. Chỉ cấp cho người tin cậy.'
            : 'Người này trở về tài khoản nhà đầu tư thường.'
        }
        confirmLabel={kind === 'grant' ? 'Cấp quyền' : 'Thu quyền'}
        requireReason={false}
        onClose={close}
        onConfirm={async () => {
          if (await act(`${base}/role`, 'POST', { role: kind === 'grant' ? 'ADMIN' : 'USER' }, 'Đã cập nhật quyền')) close();
        }}
      />
      <ReasonModal
        open={kind === 'delete'}
        title={`Xoá vĩnh viễn ${u.email}`}
        description="Xoá người dùng cùng toàn bộ tài khoản tiền, lệnh, khớp, danh mục, sao kê. Không hoàn tác được — nên xuất bản sao lưu trước."
        confirmLabel="Xoá vĩnh viễn"
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
  const [tab, setTab] = useState<'holdings' | 'orders' | 'ledger' | 'audit'>('holdings');
  return (
    <Modal open={!!id} onClose={onClose} title="Hồ sơ nhà đầu tư" width={920}>
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
                {d.user.role === 'ADMIN' && <Pill tone="brand">Quản trị viên</Pill>}
                {d.user.status === 'LOCKED' ? <Pill tone="bad">Đã khoá</Pill> : <Pill tone="good">Hoạt động</Pill>}
                {d.user.online && <Pill tone="info">Đang trực tuyến</Pill>}
                {d.user.emailVerified ? <Pill tone="good">Email đã xác thực</Pill> : <Pill tone="warn">Email chưa xác thực</Pill>}
                {d.user.twoFactorEnabled && <Pill tone="info">2FA</Pill>}
              </div>
              <div className="text-[12px] text-tx-3">
                {d.user.email} · tạo {fmtDateTimeVN(d.user.createdAt)} · hoạt động {fmtAgo(d.user.lastSeenAt)}
              </div>
              {d.user.lockedReason && <div className="mt-1 text-[12px] text-down">Lý do khoá: {d.user.lockedReason}</div>}
            </div>
          </div>
          <UserActions d={d} onDeleted={onClose} />
          {d.account && (
            <KeyValue
              items={[
                ['Tài sản ròng (NAV)', `${fmtVnd(d.account.nav)}đ`],
                [
                  'Lãi / lỗ so với vốn',
                  <span className={toneText[signTone(d.account.nav - d.account.initialCapital)]}>
                    {fmtPct(((d.account.nav - d.account.initialCapital) / d.account.initialCapital) * 100)}
                  </span>,
                ],
                ['Tiền mặt', `${fmtVnd(d.account.cashBalance)}đ`],
                ['Đang phong toả', `${fmtVnd(d.account.cashHold)}đ`],
                ['Giá trị cổ phiếu', `${fmtVnd(d.account.stockValue)}đ`],
                ['Vốn ban đầu', `${fmtVnd(d.account.initialCapital)}đ`],
                ['Số lần khớp', fmtInt(d.stats.trades)],
                ['Lãi / lỗ đã thực hiện', <span className={toneText[signTone(d.stats.realized)]}>{fmtVnd(d.stats.realized)}đ</span>],
                ['Tổng phí đã trả', `${fmtVnd(d.stats.fees)}đ`],
                ['Mã đang theo dõi', fmtInt(d.stats.watch)],
              ]}
            />
          )}
          <div className="rounded-lg border border-line">
            <UnderlineTabs
              value={tab}
              onChange={setTab}
              items={[
                { value: 'holdings', label: `Danh mục (${d.holdings.length})` },
                { value: 'orders', label: 'Lệnh gần đây' },
                { value: 'ledger', label: 'Sao kê' },
                { value: 'audit', label: 'Lịch sử quản trị' },
              ]}
            />
            <div className="max-h-[320px] overflow-auto">
              {tab === 'holdings' &&
                (d.holdings.length ? (
                  <table className="tbl num w-full text-[12px]">
                    <thead>
                      <tr className="h-8 text-left">
                        <th className="px-3">Mã</th>
                        <th className="px-2 text-right">Tổng KL</th>
                        <th className="px-2 text-right">Khả dụng</th>
                        <th className="px-2 text-right">Chờ về</th>
                        <th className="px-2 text-right">Giá vốn</th>
                        <th className="px-2 text-right">Giá TT</th>
                        <th className="px-3 text-right">Giá trị TT</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.holdings.map((h) => (
                        <tr key={h.symbol} className="h-8 border-t border-line">
                          <td className="px-3 font-semibold">{h.symbol}</td>
                          <td className="px-2 text-right">{fmtInt(h.qtyTotal)}</td>
                          <td className="px-2 text-right">{fmtInt(h.qtyAvailable)}</td>
                          <td className="px-2 text-right">{fmtInt(h.qtyPending)}</td>
                          <td className="px-2 text-right">{fmtPrice(h.avgCost)}</td>
                          <td className="px-2 text-right">{fmtPrice(h.marketPrice)}</td>
                          <td className="px-3 text-right">{fmtVnd(h.marketValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Empty title="Không nắm giữ cổ phiếu" />
                ))}
              {tab === 'orders' &&
                (d.orders.length ? (
                  <table className="tbl num w-full text-[12px]">
                    <thead>
                      <tr className="h-8 text-left">
                        <th className="px-3">Số hiệu</th>
                        <th className="px-2">Thời gian</th>
                        <th className="px-2">Mã</th>
                        <th className="px-2">Lệnh</th>
                        <th className="px-2 text-right">Giá</th>
                        <th className="px-2 text-right">KL / khớp</th>
                        <th className="px-3">Trạng thái</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.orders.map((o) => (
                        <tr key={o.id} className="h-8 border-t border-line">
                          <td className="px-3 text-tx-3">#{o.id}</td>
                          <td className="px-2">{fmtDateTimeVN(o.createdAt)}</td>
                          <td className="px-2 font-semibold">{o.symbol}</td>
                          <td className="px-2">
                            <SideChip side={o.side} /> <span className="text-tx-3">{o.orderType}</span>
                          </td>
                          <td className="px-2 text-right">{o.price ? fmtPrice(o.price) : o.orderType}</td>
                          <td className="px-2 text-right">
                            {fmtInt(o.qty)} / {fmtInt(o.filledQty)}
                          </td>
                          <td className="px-3">
                            <span className={cn('chip h-5 text-[10px]', STATUS_STYLE[o.status])} title={o.rejectReason ?? undefined}>
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
                        <th className="px-2">Loại</th>
                        <th className="px-2 text-right">Phát sinh</th>
                        <th className="px-2 text-right">Số dư sau</th>
                        <th className="px-3">Diễn giải</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.ledger.map((l) => (
                        <tr key={l.id} className="h-8 border-t border-line">
                          <td className="px-3">{fmtDateTimeVN(l.createdAt)}</td>
                          <td className="px-2">{LEDGER_LABEL[l.type] ?? l.type}</td>
                          <td className={cn('px-2 text-right', toneText[signTone(l.amount)])}>
                            {l.amount > 0 ? '+' : ''}
                            {fmtVnd(l.amount)}
                          </td>
                          <td className="px-2 text-right">{fmtVnd(l.balanceAfter)}</td>
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
                        <span className="num text-tx-3">{fmtDateTimeVN(a.created_at)}</span>
                        <Pill tone="brand">{AUDIT_LABEL[a.action] ?? a.action}</Pill>
                        <span className="text-tx-2">{auditSummary(a)}</span>
                        <span className="ml-auto text-tx-3">{a.admin_email}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty title="Chưa có thao tác quản trị nào với tài khoản này" />
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
                <th className="px-2 text-right">NAV</th>
                <th className="px-2 text-right">Lãi / lỗ</th>
                <th className="px-2 text-right">Tiền mặt</th>
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
                      {u.twoFactorEnabled && <Pill tone="info">2FA</Pill>}
                      {!u.emailVerified && <Pill tone="warn">Chưa xác thực</Pill>}
                    </div>
                    <div className="text-[11px] text-tx-3">{u.email}</div>
                  </td>
                  <td className="px-2">{u.status === 'LOCKED' ? <span title={u.lockedReason ?? ''}><Pill tone="bad">Đã khoá</Pill></span> : <Pill tone="good">Hoạt động</Pill>}</td>
                  <td className="px-2 text-tx-2">{fmtDateTimeVN(u.createdAt).slice(0, 10)}</td>
                  <td className="px-2 text-tx-2">{fmtAgo(u.lastSeenAt)}</td>
                  <td className="px-2 text-right">{fmtCompact(u.nav)}</td>
                  <td className={cn('px-2 text-right font-medium', toneText[signTone(u.pnl)])}>{fmtPct(u.pnlPct)}</td>
                  <td className="px-2 text-right">{fmtCompact(u.cashBalance)}</td>
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
