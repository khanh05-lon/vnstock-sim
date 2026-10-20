import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Flame, ShieldCheck, UserPlus } from 'lucide-react';
import { MOD_RULE_LABEL, type ModRule, type SquareNotificationDTO } from '@vss/shared';
import { cn, fmtDateTime } from '../../lib/format';
import { useLoggedIn } from '../../lib/queries';
import { ago, useSquareAction, useSquareNotifications, useSuggestions, useTrends } from '../../lib/square';
import { CoinIcon } from '../common/CoinIcon';
import { Empty, Spinner } from '../common/ui';
import { Avatar } from './PostCard';

export function TrendingCoins() {
  const { data } = useTrends();
  return (
    <section className="panel p-4">
      <h2 className="mb-2.5 flex items-center gap-1.5 text-[13px] font-semibold">
        <Flame size={15} className="text-brand" /> Coin được bàn nhiều 24h
      </h2>
      {!data?.length ? (
        <p className="text-[12px] text-tx-3">Chưa có bài gắn coin trong 24 giờ.</p>
      ) : (
        <ul className="space-y-2.5">
          {data.map((t) => {
            const voted = t.bullish + t.bearish;
            const bull = voted ? Math.round((t.bullish / voted) * 100) : null;
            return (
              <li key={t.asset}>
                <Link to={`/cong-dong?coin=${t.asset}`} className="block rounded-md hover:bg-bg-2">
                  <div className="flex items-center gap-2 text-[13px]">
                    <CoinIcon asset={t.asset} size={18} />
                    <span className="font-semibold">${t.asset}</span>
                    <span className="ml-auto text-[11px] text-tx-3">{t.posts} bài</span>
                  </div>
                  {bull != null && (
                    <div className="mt-1 flex items-center gap-2 text-[10px]">
                      <span className="num text-up">{bull}% Tăng</span>
                      <div className="flex h-1 flex-1 overflow-hidden rounded-full bg-down/60" aria-hidden>
                        <div className="h-full bg-up" style={{ width: `${bull}%` }} />
                      </div>
                      <span className="num text-down">{100 - bull}%</span>
                    </div>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function Suggestions() {
  const { data } = useSuggestions();
  const loggedIn = useLoggedIn();
  const act = useSquareAction();
  if (!data?.length) return null;
  return (
    <section className="panel p-4">
      <h2 className="mb-2.5 flex items-center gap-1.5 text-[13px] font-semibold">
        <UserPlus size={15} className="text-brand" /> Gợi ý theo dõi
      </h2>
      <ul className="space-y-2.5">
        {data.map((u) => (
          <li key={u.handle} className="flex items-center gap-2">
            <Link to={`/cong-dong/u/${u.handle}`} className="flex min-w-0 flex-1 items-center gap-2">
              <Avatar name={u.displayName} handle={u.handle} size={30} />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold">{u.displayName}</span>
                <span className="block truncate text-[11px] text-tx-3">
                  @{u.handle} · {u.likes} lượt thích
                </span>
              </span>
            </Link>
            {loggedIn && (
              <button className="btn btn-ghost h-7 px-2.5 text-[12px]" onClick={() => void act(`/square/users/${u.handle}/follow`, 'POST', undefined, `Đã theo dõi @${u.handle}`)}>
                Theo dõi
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function GuidelinesCard() {
  return (
    <section className="panel p-4 text-[12px] text-tx-2">
      <h2 className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-tx-1">
        <ShieldCheck size={15} className="text-brand" /> An toàn khi trao đổi
      </h2>
      <p>VNCoin không bao giờ nhắn riêng hỏi mật khẩu hay bảo chuyển tiền. Không giao dịch ngoài sàn, không đăng thông tin cá nhân.</p>
      <Link to="/cong-dong/quy-tac" className="mt-2 inline-block font-semibold text-brand hover:underline">
        Tiêu chuẩn cộng đồng
      </Link>
    </section>
  );
}

function notificationText(n: SquareNotificationDTO): string {
  const who = n.actor ? n.actor.displayName : '';
  const d = n.detail as { rule?: ModRule; note?: string; banUntil?: string | null; until?: string | null; permanent?: boolean; reason?: string; handle?: string; strike?: boolean; strikes?: number };
  switch (n.kind) {
    case 'LIKE':
      return `${who} đã thích bài viết của bạn`;
    case 'COMMENT':
      return `${who} đã bình luận bài viết của bạn`;
    case 'REPLY':
      return `${who} đã trả lời bình luận của bạn`;
    case 'FOLLOW':
      return `${who} đã theo dõi bạn`;
    case 'APPROVED':
      return n.commentId ? 'Bình luận của bạn đã được duyệt và hiển thị' : 'Bài viết của bạn đã được duyệt và hiển thị';
    case 'REMOVED':
      return `${n.commentId ? 'Bình luận' : 'Bài viết'} của bạn đã bị gỡ: ${d.rule ? MOD_RULE_LABEL[d.rule] : ''}${d.note ? ` — ${d.note}` : ''}${
        d.strike ? `. Vi phạm thứ ${d.strikes}${d.banUntil ? `, cấm đăng tới ${fmtDateTime(d.banUntil)}` : ' (cảnh cáo)'}` : ''
      }`;
    case 'BANNED':
      return d.permanent ? `Bạn bị cấm vĩnh viễn đăng bài: ${d.reason}` : `Bạn bị cấm đăng bài tới ${d.until ? fmtDateTime(d.until) : ''}: ${d.reason}`;
    case 'UNBANNED':
      return 'Bạn đã được gỡ cấm đăng bài';
    case 'APPEAL_ACCEPTED':
      return 'Khiếu nại được chấp nhận — nội dung đã hiển thị lại';
    case 'APPEAL_REJECTED':
      return `Khiếu nại không được chấp nhận${d.note ? `: ${d.note}` : ''}`;
    case 'HANDLE_RESET':
      return `Tên của bạn bị đặt lại thành @${d.handle} vì vi phạm Tiêu chuẩn cộng đồng`;
    default:
      return 'Thông báo';
  }
}

const MOD_KINDS = new Set(['REMOVED', 'BANNED', 'APPEAL_REJECTED', 'HANDLE_RESET']);

export function NotificationList() {
  const { data, isLoading } = useSquareNotifications(true);
  const act = useSquareAction();
  const unread = data?.some((n) => !n.read);
  useEffect(() => {
    if (unread) void act('/square/notifications/read', 'POST');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread]);
  if (isLoading) return <Spinner className="m-6" />;
  if (!data?.length) return <Empty title="Chưa có thông báo" />;
  return (
    <ul>
      {data.map((n) => {
        const to = n.postId ? `/cong-dong/bai/${n.postId}` : n.actor ? `/cong-dong/u/${n.actor.handle}` : null;
        const inner = (
          <div className={cn('flex gap-2.5 border-b border-line px-4 py-3 text-[13px]', !n.read && 'bg-brand/5')}>
            {n.actor ? <Avatar name={n.actor.displayName} handle={n.actor.handle} size={30} /> : <ShieldCheck size={22} className={cn('mt-1 shrink-0', MOD_KINDS.has(n.kind) ? 'text-down' : 'text-up')} />}
            <div className="min-w-0 flex-1">
              <p>{notificationText(n)}</p>
              <p className="mt-0.5 text-[11px] text-tx-3">{ago(n.createdAt)}</p>
            </div>
          </div>
        );
        return <li key={n.id}>{to ? <Link to={to}>{inner}</Link> : inner}</li>;
      })}
    </ul>
  );
}
