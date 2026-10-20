import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MOD_RULE_LABEL,
  REPORT_REASON_LABEL,
  SQUARE_BIO_MAX,
  SQUARE_REPORT_REASONS,
  moderateName,
  moderateText,
  type SquareProfileDTO,
  type SquareReportReason,
  type SquareTargetType,
} from '@vss/shared';
import { cn } from '../../lib/format';
import { useSquareAction } from '../../lib/square';
import { Modal } from '../common/ui';

export function ReportModal({ open, onClose, targetType, targetId }: { open: boolean; onClose(): void; targetType: SquareTargetType; targetId: string }) {
  const act = useSquareAction();
  const [reason, setReason] = useState<SquareReportReason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setReason(null);
      setNote('');
    }
  }, [open]);
  const what = targetType === 'POST' ? 'bài viết' : targetType === 'COMMENT' ? 'bình luận' : 'hồ sơ';
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Báo cáo ${what}`}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Huỷ
          </button>
          <button
            className="btn btn-brand"
            disabled={!reason || busy}
            onClick={async () => {
              setBusy(true);
              const r = await act('/square/reports', 'POST', { targetType, targetId, reason, note }, 'Đã gửi báo cáo — cảm ơn bạn');
              setBusy(false);
              if (r) onClose();
            }}
          >
            Gửi báo cáo
          </button>
        </>
      }
    >
      <p className="mb-3 text-[12px] text-tx-3">Báo cáo được giữ kín với người đăng. Nội dung bị nhiều người báo cáo sẽ tạm ẩn chờ kiểm duyệt.</p>
      <div className="grid gap-1.5" role="radiogroup" aria-label="Lý do báo cáo">
        {SQUARE_REPORT_REASONS.map((r) => (
          <label key={r} className={cn('flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-[13px]', reason === r ? 'border-brand bg-brand/8' : 'border-line hover:bg-bg-2')}>
            <input type="radio" name="reason" className="accent-[var(--brand)]" checked={reason === r} onChange={() => setReason(r)} />
            {REPORT_REASON_LABEL[r]}
          </label>
        ))}
      </div>
      <label className="mt-3 block text-[13px]">
        <span className="label">Ghi chú thêm (không bắt buộc)</span>
        <textarea className="input mt-1 h-20 py-2" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
    </Modal>
  );
}

export function AppealModal({ open, onClose, path }: { open: boolean; onClose(): void; path: string }) {
  const act = useSquareAction();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Khiếu nại quyết định gỡ"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Huỷ
          </button>
          <button
            className="btn btn-brand"
            disabled={note.trim().length < 10 || busy}
            onClick={async () => {
              setBusy(true);
              const r = await act(path, 'POST', { note }, 'Đã gửi khiếu nại');
              setBusy(false);
              if (r) onClose();
            }}
          >
            Gửi khiếu nại
          </button>
        </>
      }
    >
      <p className="mb-3 text-[12px] text-tx-3">Mỗi nội dung được khiếu nại 1 lần. Một kiểm duyệt viên khác người đã gỡ sẽ xem lại; nếu chấp nhận, nội dung hiện lại và vi phạm được xoá.</p>
      <label className="block text-[13px]">
        <span className="label">Vì sao bạn cho rằng nội dung không vi phạm? (tối thiểu 10 ký tự)</span>
        <textarea className="input mt-1 h-24 py-2" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
    </Modal>
  );
}

/** Tạo / sửa hồ sơ Cộng đồng. Tạo mới phải đồng ý Tiêu chuẩn cộng đồng */
export function ProfileModal({ open, onClose, current }: { open: boolean; onClose(): void; current: SquareProfileDTO | null }) {
  const act = useSquareAction();
  const [handle, setHandle] = useState('');
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setHandle(current?.handle ?? '');
    setName(current?.displayName ?? '');
    setBio(current?.bio ?? '');
    setAgree(!!current);
  }, [open, current]);

  const issues = useMemo(() => {
    const out: string[] = [];
    if (handle && !/^[a-z0-9_]{3,20}$/.test(handle)) out.push('Tên người dùng 3–20 ký tự: chữ thường không dấu, số, gạch dưới');
    for (const [label, r] of [
      ['Tên người dùng', handle ? moderateName(handle) : null],
      ['Tên hiển thị', name ? moderateName(name) : null],
      ['Giới thiệu', bio ? moderateText(bio) : null],
    ] as const)
      if (r && r.verdict !== 'ALLOW') out.push(`${label}: ${[...new Set(r.hits.map((h) => MOD_RULE_LABEL[h.rule]))].join(', ')}`);
    return out;
  }, [handle, name, bio]);

  const ok = /^[a-z0-9_]{3,20}$/.test(handle) && name.trim().length >= 2 && !issues.length && agree;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={current ? 'Sửa hồ sơ Cộng đồng' : 'Tạo hồ sơ Cộng đồng'}
      width={480}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Huỷ
          </button>
          <button
            className="btn btn-brand"
            disabled={!ok || busy}
            onClick={async () => {
              setBusy(true);
              const r = await act('/square/me', 'PUT', { handle, displayName: name.trim(), bio: bio.trim(), acceptGuidelines: agree }, current ? 'Đã lưu hồ sơ' : 'Đã tạo hồ sơ');
              setBusy(false);
              if (r) onClose();
            }}
          >
            {current ? 'Lưu' : 'Tạo hồ sơ'}
          </button>
        </>
      }
    >
      <p className="mb-3 text-[12px] text-tx-3">Hồ sơ Cộng đồng là công khai và tách khỏi tài khoản: không hiện email hay họ tên thật của bạn.</p>
      <div className="grid gap-3 text-[13px]">
        <label>
          <span className="label">Tên người dùng</span>
          <div className="relative mt-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tx-3">@</span>
            <input
              className="input pl-7"
              value={handle}
              maxLength={20}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
              placeholder="vd. trader_hcm"
            />
          </div>
        </label>
        <label>
          <span className="label">Tên hiển thị</span>
          <input className="input mt-1" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span className="label">Giới thiệu (tối đa {SQUARE_BIO_MAX} ký tự)</span>
          <textarea className="input mt-1 h-16 py-2" value={bio} maxLength={SQUARE_BIO_MAX} onChange={(e) => setBio(e.target.value)} />
        </label>
        {!current && (
          <label className="flex items-start gap-2 text-[12px] text-tx-2">
            <input type="checkbox" className="mt-0.5 accent-[var(--brand)]" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>
              Tôi đã đọc và đồng ý{' '}
              <Link to="/cong-dong/quy-tac" target="_blank" className="text-brand hover:underline">
                Tiêu chuẩn cộng đồng
              </Link>
              . Vi phạm có thể bị gỡ bài, cảnh cáo hoặc cấm đăng.
            </span>
          </label>
        )}
        {!!issues.length && (
          <ul className="space-y-0.5 rounded-md bg-down/10 px-3 py-2 text-[12px] text-down">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
