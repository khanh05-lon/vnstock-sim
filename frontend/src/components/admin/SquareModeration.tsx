import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Ban, CheckCircle2, Eye, FlaskConical, Gavel, RotateCcw, Search, ShieldOff, UserX } from 'lucide-react';
import {
  MOD_RULE_LABEL,
  MOD_RULES,
  REPORT_REASON_LABEL,
  type ModResult,
  type ModRule,
  type SquareModUserDTO,
  type SquareQueueItemDTO,
  type SquareReportReason,
  type SquareRules,
} from '@vss/shared';
import { useAdminAction } from '../../lib/admin';
import { api } from '../../lib/api';
import { cn, fmtDateTime } from '../../lib/format';
import { Empty, Modal, Spinner, Tabs } from '../common/ui';
import { Kpi, Pill, ReasonModal, Section } from './adminUi';

type View = 'pending' | 'reports' | 'appeals' | 'users' | 'rules';

/**
 * Kiểm duyệt Cộng đồng (vai trò Kiểm duyệt nội dung — quyền square.moderate).
 * Chỉ thấy hồ sơ cộng đồng công khai (handle, nội dung, vi phạm) — không có email / số dư của khách.
 */
export function SquareModeration() {
  const [view, setView] = useState<View>('pending');
  const { data: stats } = useQuery({
    queryKey: ['admin', 'square', 'stats'],
    queryFn: () => api<{ pending: number; reports: number; appeals: number; posts24h: number; removed24h: number; banned: number }>('/admin/square/stats'),
    refetchInterval: 30_000,
  });
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Kpi label="Chờ duyệt" value={stats?.pending ?? '—'} tone={stats?.pending ? 'text-ref' : undefined} />
        <Kpi label="Nội dung bị báo cáo" value={stats?.reports ?? '—'} tone={stats?.reports ? 'text-ref' : undefined} />
        <Kpi label="Khiếu nại" value={stats?.appeals ?? '—'} />
        <Kpi label="Bài mới 24h" value={stats?.posts24h ?? '—'} />
        <Kpi label="Gỡ 24h" value={stats?.removed24h ?? '—'} />
        <Kpi label="Đang bị cấm" value={stats?.banned ?? '—'} />
      </div>
      <Tabs
        value={view}
        onChange={setView}
        items={[
          { value: 'pending', label: `Chờ duyệt${stats?.pending ? ` (${stats.pending})` : ''}` },
          { value: 'reports', label: `Báo cáo${stats?.reports ? ` (${stats.reports})` : ''}` },
          { value: 'appeals', label: `Khiếu nại${stats?.appeals ? ` (${stats.appeals})` : ''}` },
          { value: 'users', label: 'Người dùng' },
          { value: 'rules', label: 'Quy tắc lọc' },
        ]}
      />
      {view === 'users' ? <ModUsers /> : view === 'rules' ? <RulesEditor /> : <Queue view={view} />}
    </div>
  );
}

const pathOf = (it: SquareQueueItemDTO) => `/admin/square/${it.type === 'POST' ? 'posts' : 'comments'}/${it.id}`;

function Queue({ view }: { view: 'pending' | 'reports' | 'appeals' }) {
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'square', 'queue', view], queryFn: () => api<SquareQueueItemDTO[]>(`/admin/square/queue?view=${view}`) });
  const act = useAdminAction();
  const [remove, setRemove] = useState<SquareQueueItemDTO | null>(null);
  const [dismiss, setDismiss] = useState<SquareQueueItemDTO | null>(null);
  const [appeal, setAppeal] = useState<{ it: SquareQueueItemDTO; accept: boolean } | null>(null);
  const [resetName, setResetName] = useState<SquareQueueItemDTO | null>(null);
  const title = { pending: 'Nội dung chờ duyệt (bộ lọc giữ lại hoặc bị báo cáo nhiều)', reports: 'Nội dung đang hiển thị bị báo cáo', appeals: 'Khiếu nại quyết định gỡ' }[view];

  return (
    <Section title={title} pad={false}>
      {isLoading ? (
        <Spinner className="m-6" />
      ) : !data?.length ? (
        <Empty title="Không có mục nào" />
      ) : (
        <ul className="divide-y divide-line">
          {data.map((it) => (
            <li key={`${it.type}-${it.id}`} className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <Pill tone="muted">{it.type === 'POST' ? 'Bài viết' : it.type === 'COMMENT' ? 'Bình luận' : 'Hồ sơ'}</Pill>
                <span className="font-semibold">@{it.author.handle}</span>
                <span className="text-tx-3">{it.author.displayName}</span>
                {it.author.activeStrikes > 0 && <Pill tone="warn">{it.author.activeStrikes} vi phạm</Pill>}
                {it.author.banned && <Pill tone="bad">Đang bị cấm</Pill>}
                <span className="text-tx-3">· {fmtDateTime(it.createdAt)}</span>
                {it.type !== 'PROFILE' && it.status === 'PUBLISHED' && it.postId && (
                  <Link to={`/cong-dong/bai/${it.postId}`} target="_blank" className="ml-auto flex items-center gap-1 text-tx-3 hover:text-tx-1">
                    <Eye size={13} /> Xem
                  </Link>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words rounded-md bg-bg-2 px-3 py-2 text-[13px]">{it.body || <i className="text-tx-3">(trống)</i>}</p>
              {!!it.hits.length && (
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {it.hits.map((h, i) => (
                    <span key={i} className={cn('chip', h.action === 'BLOCK' ? 'bg-down/12 text-down' : 'bg-ref/12 text-ref')}>
                      {MOD_RULE_LABEL[h.rule]}
                      {h.excerpt && `: "${h.excerpt}"`}
                    </span>
                  ))}
                </div>
              )}
              {it.reports && (
                <div className="text-[12px] text-tx-2">
                  <b>{it.reports.count} báo cáo</b>:{' '}
                  {Object.entries(it.reports.reasons)
                    .map(([r, n]) => `${REPORT_REASON_LABEL[r as SquareReportReason]} (${n})`)
                    .join(', ')}
                  {!!it.reports.notes.length && <div className="mt-0.5 text-tx-3">Ghi chú: {it.reports.notes.slice(0, 3).join(' · ')}</div>}
                </div>
              )}
              {it.appeal && (
                <div className="rounded-md border border-line px-3 py-2 text-[12px]">
                  <div className="text-tx-3">
                    Gỡ bởi {it.appeal.removedBy} — {it.appeal.rule ? MOD_RULE_LABEL[it.appeal.rule] : ''}
                    {it.appeal.removedNote && `: ${it.appeal.removedNote}`}
                  </div>
                  <div className="mt-1">
                    <b>Khiếu nại</b> ({fmtDateTime(it.appeal.at)}): {it.appeal.note}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {view === 'pending' && it.type !== 'PROFILE' && (
                  <button className="btn btn-up h-7 px-2.5 text-[12px]" onClick={() => void act(`${pathOf(it)}/approve`, 'POST', {}, 'Đã duyệt — nội dung hiển thị')}>
                    <CheckCircle2 size={14} /> Duyệt hiển thị
                  </button>
                )}
                {view !== 'appeals' && it.type !== 'PROFILE' && (
                  <button className="btn btn-ghost h-7 px-2.5 text-[12px] text-down" onClick={() => setRemove(it)}>
                    <Gavel size={14} /> Gỡ
                  </button>
                )}
                {it.type === 'PROFILE' && (
                  <button className="btn btn-ghost h-7 px-2.5 text-[12px] text-down" onClick={() => setResetName(it)}>
                    <UserX size={14} /> Đặt lại tên
                  </button>
                )}
                {view === 'reports' && (
                  <button className="btn btn-ghost h-7 px-2.5 text-[12px]" onClick={() => setDismiss(it)}>
                    Bỏ qua báo cáo
                  </button>
                )}
                {view === 'appeals' && (
                  <>
                    <button className="btn btn-up h-7 px-2.5 text-[12px]" onClick={() => setAppeal({ it, accept: true })}>
                      <RotateCcw size={14} /> Chấp nhận, hiện lại
                    </button>
                    <button className="btn btn-ghost h-7 px-2.5 text-[12px]" onClick={() => setAppeal({ it, accept: false })}>
                      Giữ quyết định gỡ
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <RemoveModal
        item={remove}
        onClose={() => setRemove(null)}
        onConfirm={async (rule, note, strike) => {
          if (remove && (await act(`${pathOf(remove)}/remove`, 'POST', { rule, note, strike }, 'Đã gỡ nội dung'))) setRemove(null);
        }}
      />
      <ReasonModal
        open={!!dismiss}
        title="Bỏ qua báo cáo"
        description="Nội dung không vi phạm — đóng mọi báo cáo đang mở của nội dung này."
        confirmLabel="Bỏ qua"
        onClose={() => setDismiss(null)}
        onConfirm={async (note) => {
          if (dismiss && (await act('/admin/square/reports/dismiss', 'POST', { targetType: dismiss.type, targetId: dismiss.id, note }, 'Đã đóng báo cáo'))) setDismiss(null);
        }}
      />
      <ReasonModal
        open={!!appeal}
        title={appeal?.accept ? 'Chấp nhận khiếu nại' : 'Giữ quyết định gỡ'}
        description={appeal?.accept ? 'Nội dung hiện lại, vi phạm liên quan được xoá (cấm đăng tự động cũng được gỡ nếu không còn đủ vi phạm).' : 'Ghi chú này được gửi cho người dùng.'}
        confirmLabel={appeal?.accept ? 'Chấp nhận' : 'Giữ quyết định'}
        onClose={() => setAppeal(null)}
        onConfirm={async (note) => {
          if (appeal && (await act(`${pathOf(appeal.it)}/appeal`, 'POST', { accept: appeal.accept, note }, 'Đã xử lý khiếu nại'))) setAppeal(null);
        }}
      />
      <ReasonModal
        open={!!resetName}
        title={`Đặt lại tên @${resetName?.author.handle ?? ''}`}
        description="Tên, tên hiển thị và giới thiệu bị đặt lại; tính 1 vi phạm (Mạo danh)."
        confirmLabel="Đặt lại"
        danger
        onClose={() => setResetName(null)}
        onConfirm={async (note) => {
          if (resetName && (await act(`/admin/square/users/${resetName.author.userId}/reset-handle`, 'POST', { rule: 'IMPERSONATION', note }, 'Đã đặt lại tên'))) setResetName(null);
        }}
      />
    </Section>
  );
}

function RemoveModal({ item, onClose, onConfirm }: { item: SquareQueueItemDTO | null; onClose(): void; onConfirm(rule: ModRule, note: string, strike: boolean): Promise<void> }) {
  const [rule, setRule] = useState<ModRule>('SPAM');
  const [note, setNote] = useState('');
  const [strike, setStrike] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!item) return;
    setRule(item.hits[0]?.rule ?? 'SPAM');
    setNote('');
    setStrike(true);
  }, [item]);
  return (
    <Modal
      open={!!item}
      onClose={onClose}
      title="Gỡ nội dung"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Huỷ
          </button>
          <button
            className="btn btn-down"
            disabled={note.trim().length < 3 || busy}
            onClick={async () => {
              setBusy(true);
              await onConfirm(rule, note.trim(), strike);
              setBusy(false);
            }}
          >
            Gỡ
          </button>
        </>
      }
    >
      <div className="grid gap-3 text-[13px]">
        <label>
          <span className="label">Quy tắc vi phạm</span>
          <select className="input mt-1" value={rule} onChange={(e) => setRule(e.target.value as ModRule)}>
            {MOD_RULES.map((r) => (
              <option key={r} value={r}>
                {MOD_RULE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Lý do (gửi cho người dùng)</span>
          <textarea className="input mt-1 h-20 py-2" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <label className="flex items-start gap-2 text-[12px] text-tx-2">
          <input type="checkbox" className="mt-0.5 accent-[var(--brand)]" checked={strike} onChange={(e) => setStrike(e.target.checked)} />
          <span>Tính 1 vi phạm cho tác giả (bỏ chọn nếu gỡ vì lý do khác như trùng lặp, sai chủ đề). Vi phạm thứ 2 trở đi tự động cấm đăng theo thang phạt.</span>
        </label>
      </div>
    </Modal>
  );
}

function ModUsers() {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['admin', 'square', 'users', term], queryFn: () => api<SquareModUserDTO[]>(`/admin/square/users?q=${encodeURIComponent(term)}`) });
  const detail = data?.find((u) => u.userId === sel) ?? null;
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <Section
        title={term ? `Kết quả cho "${term}"` : 'Đang bị cấm / có vi phạm'}
        pad={false}
        actions={
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              setTerm(q.trim());
            }}
          >
            <input className="input h-8 w-44 text-[12px]" placeholder="@handle hoặc tên" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Tìm người dùng" />
            <button className="btn btn-ghost h-8 px-2" aria-label="Tìm">
              <Search size={14} />
            </button>
          </form>
        }
      >
        {isLoading ? (
          <Spinner className="m-6" />
        ) : !data?.length ? (
          <Empty title="Không có ai" />
        ) : (
          <ul className="divide-y divide-line">
            {data.map((u) => (
              <li key={u.userId}>
                <button className={cn('flex w-full flex-wrap items-center gap-2 px-4 py-2.5 text-left text-[13px] hover:bg-bg-2', sel === u.userId && 'bg-brand/8')} onClick={() => setSel(u.userId)}>
                  <span className="font-semibold">@{u.handle}</span>
                  <span className="truncate text-tx-3">{u.displayName}</span>
                  <span className="ml-auto flex gap-1.5">
                    {u.activeStrikes > 0 && <Pill tone="warn">{u.activeStrikes} vi phạm</Pill>}
                    {u.banPermanent ? <Pill tone="bad">Cấm vĩnh viễn</Pill> : u.banUntil && <Pill tone="bad">Cấm tới {fmtDateTime(u.banUntil)}</Pill>}
                    {u.flagPermanent && <Pill tone="bad">Đề xuất cấm vĩnh viễn</Pill>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {detail ? <ModUserDetail u={detail} /> : <Section title="Chi tiết">{<Empty title="Chọn một người dùng" />}</Section>}
    </div>
  );
}

function ModUserDetail({ u }: { u: SquareModUserDTO }) {
  const act = useAdminAction();
  const [ban, setBan] = useState<'temp' | 'perm' | null>(null);
  const [days, setDays] = useState(7);
  const [unban, setUnban] = useState(false);
  const [reset, setReset] = useState(false);
  return (
    <Section title={`@${u.handle}`}>
      <div className="space-y-3 text-[13px]">
        <div className="text-tx-2">
          {u.displayName} · tham gia {fmtDateTime(u.joinedAt)} · {u.posts} bài đang hiển thị · {u.removedPosts} bài bị gỡ
          {u.bio && <p className="mt-1 text-tx-3">{u.bio}</p>}
        </div>
        <div>
          {u.banPermanent ? (
            <Pill tone="bad">Cấm vĩnh viễn</Pill>
          ) : u.banUntil ? (
            <Pill tone="bad">Cấm đăng tới {fmtDateTime(u.banUntil)}</Pill>
          ) : (
            <Pill tone="good">Được đăng bài</Pill>
          )}
          {u.banReason && <span className="ml-2 text-[12px] text-tx-3">{u.banReason}</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost h-8 px-3 text-[12px] text-down" onClick={() => setBan('temp')}>
            <Ban size={14} /> Cấm tạm thời
          </button>
          {!u.banPermanent && (
            <button className="btn btn-ghost h-8 px-3 text-[12px] text-down" onClick={() => setBan('perm')}>
              <Ban size={14} /> Đề xuất cấm vĩnh viễn
            </button>
          )}
          {u.banned && (
            <button className="btn btn-ghost h-8 px-3 text-[12px]" onClick={() => setUnban(true)}>
              <ShieldOff size={14} /> Gỡ cấm
            </button>
          )}
          <button className="btn btn-ghost h-8 px-3 text-[12px]" onClick={() => setReset(true)}>
            <UserX size={14} /> Đặt lại tên
          </button>
        </div>
        <div>
          <h3 className="mb-1.5 text-[12px] font-semibold text-tx-3">Lịch sử vi phạm</h3>
          {!u.strikes.length ? (
            <p className="text-[12px] text-tx-3">Chưa có vi phạm.</p>
          ) : (
            <table className="tbl w-full text-[12px]">
              <tbody>
                {u.strikes.map((s) => {
                  const active = !s.revoked && new Date(s.expiresAt).getTime() > Date.now();
                  return (
                    <tr key={s.id} className={cn('border-t border-line', !active && 'text-tx-3')}>
                      <td className="py-1.5 pr-2">{fmtDateTime(s.createdAt)}</td>
                      <td className="pr-2">{MOD_RULE_LABEL[s.rule]}</td>
                      <td className="pr-2">{s.by}</td>
                      <td>{s.revoked ? 'Đã gỡ (khiếu nại)' : active ? `Hết hạn ${fmtDateTime(s.expiresAt)}` : 'Hết hiệu lực'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <ReasonModal
        open={!!ban}
        title={ban === 'perm' ? `Đề xuất cấm vĩnh viễn @${u.handle}` : `Cấm @${u.handle} đăng bài`}
        description={ban === 'perm' ? 'Cần một kiểm duyệt viên khác duyệt ở Hàng chờ duyệt.' : 'Tối đa 30 ngày; dài hơn hãy đề xuất cấm vĩnh viễn.'}
        confirmLabel={ban === 'perm' ? 'Gửi đề xuất' : 'Cấm'}
        danger
        extra={
          ban === 'temp' && (
            <label className="block text-[13px]">
              <span className="label">Số ngày</span>
              <input type="number" min={1} max={30} className="input mt-1 w-28" value={days} onChange={(e) => setDays(Number(e.target.value))} />
            </label>
          )
        }
        onClose={() => setBan(null)}
        onConfirm={async (reason) => {
          const body = ban === 'perm' ? { permanent: true, reason } : { days, reason };
          if (await act(`/admin/square/users/${u.userId}/ban`, 'POST', body, `Đã cấm @${u.handle}`)) setBan(null);
        }}
      />
      <ReasonModal
        open={unban}
        title={`Gỡ cấm @${u.handle}`}
        description="Cấm vĩnh viễn hoặc còn từ 7 ngày trở lên thì thành đề xuất, cần người thứ hai duyệt."
        confirmLabel="Gỡ cấm"
        onClose={() => setUnban(false)}
        onConfirm={async (note) => {
          if (await act(`/admin/square/users/${u.userId}/unban`, 'POST', { note }, `Đã gỡ cấm @${u.handle}`)) setUnban(false);
        }}
      />
      <ReasonModal
        open={reset}
        title={`Đặt lại tên @${u.handle}`}
        description="Tên, tên hiển thị và giới thiệu bị đặt lại; tính 1 vi phạm (Mạo danh)."
        confirmLabel="Đặt lại"
        danger
        onClose={() => setReset(false)}
        onConfirm={async (note) => {
          if (await act(`/admin/square/users/${u.userId}/reset-handle`, 'POST', { rule: 'IMPERSONATION', note }, 'Đã đặt lại tên')) setReset(false);
        }}
      />
    </Section>
  );
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

function RulesEditor() {
  const { data } = useQuery({ queryKey: ['admin', 'square', 'rules'], queryFn: () => api<{ rules: SquareRules; defaults: SquareRules }>('/admin/square/rules') });
  const act = useAdminAction();
  const [block, setBlock] = useState('');
  const [review, setReview] = useState('');
  const [domains, setDomains] = useState('');
  const [nums, setNums] = useState<Record<string, number>>({});
  const [ladder, setLadder] = useState('');
  const [text, setText] = useState('');
  const [test, setTest] = useState<ModResult | null>(null);
  useEffect(() => {
    if (!data) return;
    const r = data.rules;
    setBlock(r.extraBlockWords.join('\n'));
    setReview(r.extraReviewWords.join('\n'));
    setDomains(r.allowedDomains.join('\n'));
    setLadder(r.strikeBanHours.join(', '));
    setNums({
      minAccountAgeHours: r.minAccountAgeHours,
      postsPerHour: r.postsPerHour,
      postsPerDay: r.postsPerDay,
      commentsPerHour: r.commentsPerHour,
      reportsPerDay: r.reportsPerDay,
      autoHideReports: r.autoHideReports,
      reporterMinAgeDays: r.reporterMinAgeDays,
      strikeExpiryDays: r.strikeExpiryDays,
      permanentFlagAt: r.permanentFlagAt,
      maxManualBanDays: r.maxManualBanDays,
      unbanApprovalDays: r.unbanApprovalDays,
    });
  }, [data]);
  const NUM_LABEL: Record<string, string> = {
    minAccountAgeHours: 'Tuổi tài khoản tối thiểu để đăng (giờ)',
    postsPerHour: 'Bài / giờ',
    postsPerDay: 'Bài / ngày',
    commentsPerHour: 'Bình luận / giờ',
    reportsPerDay: 'Báo cáo / ngày mỗi người',
    autoHideReports: 'Số người báo cáo để tự ẩn',
    reporterMinAgeDays: 'Tuổi tài khoản báo cáo được tính (ngày)',
    strikeExpiryDays: 'Vi phạm hết hiệu lực sau (ngày)',
    permanentFlagAt: 'Gắn cờ đề xuất cấm vĩnh viễn từ (vi phạm)',
    maxManualBanDays: 'Cấm tay tối đa (ngày)',
    unbanApprovalDays: 'Gỡ cấm còn từ (ngày) cần người thứ hai',
  };
  if (!data) return <Spinner className="m-6" />;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Section title="Từ ngữ và liên kết">
        <div className="grid gap-3 text-[13px]">
          <label>
            <span className="label">Từ / cụm từ CHẶN thêm (mỗi dòng 1 mục, so không dấu)</span>
            <textarea className="input mt-1 h-28 py-2 font-mono text-[12px]" value={block} onChange={(e) => setBlock(e.target.value)} />
          </label>
          <label>
            <span className="label">Từ / cụm từ GIỮ LẠI chờ duyệt thêm</span>
            <textarea className="input mt-1 h-24 py-2 font-mono text-[12px]" value={review} onChange={(e) => setReview(e.target.value)} />
          </label>
          <label>
            <span className="label">Tên miền được dẫn liên kết (gồm tên miền con)</span>
            <textarea className="input mt-1 h-24 py-2 font-mono text-[12px]" value={domains} onChange={(e) => setDomains(e.target.value)} />
          </label>
          <p className="text-[11px] text-tx-3">Danh sách từ thêm chỉ áp dụng ở máy chủ, không gửi xuống trình duyệt của khách (tránh bị dò để lách).</p>
        </div>
      </Section>
      <div className="space-y-3">
        <Section title="Giới hạn và thang phạt">
          <div className="grid gap-2 text-[12px] sm:grid-cols-2">
            {Object.entries(nums).map(([k, v]) => (
              <label key={k}>
                <span className="label">{NUM_LABEL[k]}</span>
                <input type="number" min={0} className="input mt-1 h-8" value={v} onChange={(e) => setNums({ ...nums, [k]: Number(e.target.value) })} />
              </label>
            ))}
            <label className="sm:col-span-2">
              <span className="label">Giờ cấm theo lần vi phạm (0 = cảnh cáo), cách nhau dấu phẩy</span>
              <input className="input mt-1 h-8" value={ladder} onChange={(e) => setLadder(e.target.value)} />
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              className="btn btn-brand"
              onClick={() =>
                void act(
                  '/admin/square/rules',
                  'PUT',
                  {
                    extraBlockWords: lines(block),
                    extraReviewWords: lines(review),
                    allowedDomains: lines(domains),
                    strikeBanHours: ladder
                      .split(',')
                      .map((x) => Number(x.trim()))
                      .filter((x) => Number.isFinite(x)),
                    ...nums,
                  },
                  'Đã lưu quy tắc lọc',
                )
              }
            >
              Lưu
            </button>
            <button className="btn btn-ghost" onClick={() => confirm('Khôi phục toàn bộ quy tắc mặc định?') && void act('/admin/square/rules', 'DELETE', undefined, 'Đã khôi phục mặc định')}>
              Khôi phục mặc định
            </button>
          </div>
        </Section>
        <Section title="Thử bộ lọc">
          <textarea className="input h-20 py-2 text-[13px]" placeholder="Nhập câu để xem bộ lọc xử lý thế nào" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn btn-ghost mt-2 h-8 px-3 text-[12px]" disabled={!text.trim()} onClick={async () => setTest(await api<ModResult>('/admin/square/rules/test', { method: 'POST', body: { text } }))}>
            <FlaskConical size={14} /> Thử
          </button>
          {test && (
            <div className="mt-2 text-[12px]">
              <Pill tone={test.verdict === 'ALLOW' ? 'good' : test.verdict === 'BLOCK' ? 'bad' : 'warn'}>
                {test.verdict === 'ALLOW' ? 'Cho đăng' : test.verdict === 'BLOCK' ? 'Chặn' : 'Giữ lại chờ duyệt'}
              </Pill>
              <ul className="mt-1.5 space-y-0.5 text-tx-2">
                {test.hits.map((h, i) => (
                  <li key={i}>
                    {MOD_RULE_LABEL[h.rule]} ({h.action === 'BLOCK' ? 'chặn' : 'giữ lại'}): "{h.excerpt}"
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
