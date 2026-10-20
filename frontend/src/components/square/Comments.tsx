import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Clock3, Flag, Reply, ShieldAlert, Trash2 } from 'lucide-react';
import { MOD_RULE_LABEL, SQUARE_COMMENT_MAX, moderateText, type SquareCommentDTO } from '@vss/shared';
import { cn } from '../../lib/format';
import { useLoggedIn } from '../../lib/queries';
import { ago, useComments, useSquareAction, useSquareConfig, useSquareMe } from '../../lib/square';
import { Spinner } from '../common/ui';
import { ModHints } from './Composer';
import { AppealModal, ReportModal } from './Modals';
import { Avatar } from './PostCard';

function CommentBox({ postId, parentId, onDone, autoFocus }: { postId: number; parentId?: number; onDone?: () => void; autoFocus?: boolean }) {
  const { data: cfg } = useSquareConfig();
  const act = useSquareAction();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const check = useMemo(() => moderateText(body, { allowedDomains: cfg?.allowedDomains }), [body, cfg?.allowedDomains]);
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <input
          className="input h-9 flex-1 text-[13px]"
          placeholder={parentId ? 'Viết trả lời…' : 'Viết bình luận…'}
          value={body}
          maxLength={SQUARE_COMMENT_MAX}
          autoFocus={autoFocus}
          aria-label={parentId ? 'Trả lời bình luận' : 'Bình luận'}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), (e.currentTarget.nextSibling as HTMLButtonElement | null)?.click())}
        />
        <button
          className="btn btn-brand h-9 px-3 text-[13px]"
          disabled={!body.trim() || check.verdict === 'BLOCK' || busy}
          onClick={async () => {
            setBusy(true);
            const r = await act<SquareCommentDTO>(`/square/posts/${postId}/comments`, 'POST', { body, parentId: parentId ?? null });
            setBusy(false);
            if (!r) return;
            setBody('');
            onDone?.();
            if (r.status === 'PENDING') toast.info('Bình luận đang chờ kiểm duyệt — chỉ bạn thấy cho tới khi được duyệt');
          }}
        >
          Gửi
        </button>
      </div>
      <ModHints result={check} />
    </div>
  );
}

function CommentItem({ c, canReply, onReply }: { c: SquareCommentDTO; canReply: boolean; onReply?: () => void }) {
  const loggedIn = useLoggedIn();
  const act = useSquareAction();
  const [report, setReport] = useState(false);
  const [appeal, setAppeal] = useState(false);
  return (
    <div className="flex gap-2.5">
      <Link to={`/cong-dong/u/${c.author.handle}`}>
        <Avatar name={c.author.displayName} handle={c.author.handle} size={28} />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="rounded-lg bg-bg-2 px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-1.5 text-[12px]">
            <Link to={`/cong-dong/u/${c.author.handle}`} className="font-semibold hover:underline">
              {c.author.displayName}
            </Link>
            <span className="text-tx-3">@{c.author.handle}</span>
          </div>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px]">{c.body}</p>
        </div>
        {c.status === 'PENDING' && (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-ref">
            <Clock3 size={12} /> Đang chờ kiểm duyệt — chỉ bạn thấy
          </div>
        )}
        {c.removed && (
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-down">
            <ShieldAlert size={12} /> Đã bị gỡ: {MOD_RULE_LABEL[c.removed.rule]}
            {c.removed.appealStatus === 'PENDING' && ' · Khiếu nại đang được xem xét'}
            {c.removed.canAppeal && (
              <button className="ml-1 font-semibold hover:underline" onClick={() => setAppeal(true)}>
                Khiếu nại
              </button>
            )}
          </div>
        )}
        <div className="mt-1 flex items-center gap-3 px-1 text-[11px] text-tx-3">
          <span>{ago(c.createdAt)}</span>
          {canReply && c.status === 'PUBLISHED' && (
            <button className="flex items-center gap-1 hover:text-tx-1" onClick={onReply}>
              <Reply size={12} /> Trả lời
            </button>
          )}
          {c.mine ? (
            <button
              className="flex items-center gap-1 hover:text-down"
              onClick={() => confirm('Xoá bình luận này?') && void act(`/square/comments/${c.id}`, 'DELETE', undefined, 'Đã xoá bình luận')}
            >
              <Trash2 size={12} /> Xoá
            </button>
          ) : (
            loggedIn &&
            c.status === 'PUBLISHED' && (
              <button className="flex items-center gap-1 hover:text-tx-1" onClick={() => setReport(true)}>
                <Flag size={12} /> Báo cáo
              </button>
            )
          )}
        </div>
      </div>
      <ReportModal open={report} onClose={() => setReport(false)} targetType="COMMENT" targetId={String(c.id)} />
      <AppealModal open={appeal} onClose={() => setAppeal(false)} path={`/square/comments/${c.id}/appeal`} />
    </div>
  );
}

export function CommentThread({ postId }: { postId: number }) {
  const { data, isLoading } = useComments(postId);
  const { data: me } = useSquareMe();
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const canWrite = !!me?.canPost;
  const top = (data ?? []).filter((c) => !c.parentId);
  const replies = (id: number) => (data ?? []).filter((c) => c.parentId === id);

  return (
    <section className="space-y-4 px-4 py-4" aria-label="Bình luận">
      <h2 className="text-[14px] font-semibold">Bình luận</h2>
      {canWrite ? (
        <CommentBox postId={postId} />
      ) : (
        me && <p className="text-[12px] text-tx-3">{me.profile ? me.blockedReason : 'Tạo hồ sơ Cộng đồng để bình luận.'}</p>
      )}
      {isLoading ? (
        <Spinner />
      ) : !top.length ? (
        <p className="text-[13px] text-tx-3">Chưa có bình luận.</p>
      ) : (
        <div className="space-y-4">
          {top.map((c) => (
            <div key={c.id} className="space-y-3">
              <CommentItem c={c} canReply={canWrite} onReply={() => setReplyTo(replyTo === c.id ? null : c.id)} />
              <div className={cn('space-y-3 pl-9', !replies(c.id).length && replyTo !== c.id && 'hidden')}>
                {replies(c.id).map((r) => (
                  <CommentItem key={r.id} c={r} canReply={canWrite} onReply={() => setReplyTo(c.id)} />
                ))}
                {replyTo === c.id && <CommentBox postId={postId} parentId={c.id} autoFocus onDone={() => setReplyTo(null)} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
