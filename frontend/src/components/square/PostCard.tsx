import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, Clock3, Flag, Heart, Link2, MessageCircle, MoreHorizontal, ShieldAlert, Trash2, TrendingDown, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { MOD_RULE_LABEL, SENTIMENT_LABEL, type SquarePostDTO, type SquareSentiment, type SquareShareDTO } from '@vss/shared';
import { cn, fmtPct, fmtPrice, signTone, toneText } from '../../lib/format';
import { ago, hueOf, initials, useSquareAction } from '../../lib/square';
import { useLoggedIn } from '../../lib/queries';
import { useMarket } from '../../store/market';
import { CoinIcon } from '../common/CoinIcon';
import { AppealModal, ReportModal } from './Modals';

export function Avatar({ name, handle, size = 36 }: { name: string; handle: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: `hsl(${hueOf(handle)} 45% 42%)`, fontSize: Math.round(size * 0.38) }}
    >
      {initials(name)}
    </span>
  );
}

export function SentimentBadge({ s }: { s: SquareSentiment }) {
  const up = s === 'BULLISH';
  return (
    <span className={cn('chip gap-1', up ? 'bg-up/12 text-up' : 'bg-down/12 text-down')}>
      {up ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {SENTIMENT_LABEL[s]}
    </span>
  );
}

/** Chữ thuần + $COIN / #chủ_đề thành liên kết (không render HTML của người dùng) */
export function RichText({ text, assets, className }: { text: string; assets: string[]; className?: string }) {
  const listed = new Set(assets);
  const parts = text.split(/(\$[A-Za-z][A-Za-z0-9]{1,9}\b|#[\p{L}\p{N}_]{2,30})/u);
  return (
    <p className={cn('whitespace-pre-wrap break-words text-[14px] leading-relaxed', className)}>
      {parts.map((p, i) => {
        if (p.startsWith('$') && listed.has(p.slice(1).toUpperCase()))
          return (
            <Link key={i} to={`/cong-dong?coin=${p.slice(1).toUpperCase()}`} className="font-semibold text-brand hover:underline" onClick={(e) => e.stopPropagation()}>
              {p.toUpperCase()}
            </Link>
          );
        if (p.startsWith('#') && p.length > 2)
          return (
            <Link key={i} to={`/cong-dong?tag=${encodeURIComponent(p.slice(1).toLowerCase())}`} className="text-brand hover:underline" onClick={(e) => e.stopPropagation()}>
              {p}
            </Link>
          );
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </p>
  );
}

/** Thẻ coin dưới bài: giá + % 24h trực tiếp */
export function CoinChips({ assets }: { assets: string[] }) {
  const rows = useMarket((s) => s.rows);
  if (!assets.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {assets.map((a) => {
        const r = rows[`${a}USDT`];
        const pct = r ? Number(r.changePct) : 0;
        return (
          <Link
            key={a}
            to={`/trade/${a}USDT`}
            className="flex items-center gap-1.5 rounded-md border border-line bg-bg-2 px-2 py-1 text-[12px] hover:border-brand/60"
            onClick={(e) => e.stopPropagation()}
          >
            <CoinIcon asset={a} size={16} />
            <span className="font-semibold">{a}</span>
            {r && (
              <>
                <span className="num text-tx-2">{fmtPrice(r.last, r.filters.tickSize)}</span>
                <span className={cn('num', toneText[signTone(pct)])}>{fmtPct(pct)}</span>
              </>
            )}
          </Link>
        );
      })}
    </div>
  );
}

/** Số liệu chia sẻ do máy chủ dựng từ dữ liệu thật */
export function ShareCard({ share }: { share: SquareShareDTO }) {
  const pct = share.type === 'ORDER' ? share.pnlPct : share.returnPct;
  return (
    <div className="rounded-lg border border-line bg-bg-2 px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1 text-[11px] text-tx-3">
        <BadgeCheck size={13} className="text-brand" /> Xác minh từ dữ liệu VNCoin
      </div>
      {share.type === 'ORDER' ? (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex items-center gap-2">
            <CoinIcon asset={share.base} size={28} />
            <div>
              <div className="text-[13px] font-semibold">
                {share.base}/USDT{' '}
                <span className={cn('ml-1 text-[12px]', share.side === 'BUY' ? 'text-up' : 'text-down')}>{share.side === 'BUY' ? 'Mua' : 'Bán'}</span>
              </div>
              <div className="num text-[11px] text-tx-3">
                Giá khớp TB {fmtPrice(share.avgPrice)} · Lúc chia sẻ {fmtPrice(share.priceAtShare)}
              </div>
            </div>
          </div>
          <div className={cn('num text-[22px] font-bold', toneText[signTone(pct)])}>{fmtPct(pct)}</div>
        </div>
      ) : (
        <div className="flex items-end justify-between gap-3">
          <div className="text-[13px] text-tx-2">Tỷ suất lợi nhuận tài khoản (từ đầu)</div>
          <div className={cn('num text-[22px] font-bold', toneText[signTone(pct)])}>{fmtPct(pct)}</div>
        </div>
      )}
    </div>
  );
}

export function PostCard({ post, detail = false, onOpen }: { post: SquarePostDTO; detail?: boolean; onOpen?: () => void }) {
  const loggedIn = useLoggedIn();
  const act = useSquareAction();
  const [menu, setMenu] = useState(false);
  const [report, setReport] = useState(false);
  const [appeal, setAppeal] = useState(false);
  const [liked, setLiked] = useState(post.liked);
  const [likes, setLikes] = useState(post.likeCount);
  const live = post.status === 'PUBLISHED';

  const toggleLike = async () => {
    if (!loggedIn) return toast.info('Đăng nhập để thích bài viết');
    const next = !liked;
    setLiked(next);
    setLikes((n) => n + (next ? 1 : -1));
    const r = await act<{ liked: boolean; likeCount: number }>(`/square/posts/${post.id}/like`, next ? 'POST' : 'DELETE');
    if (r) setLikes(r.likeCount);
    else {
      setLiked(!next);
      setLikes((n) => n + (next ? -1 : 1));
    }
  };

  const copyLink = () => {
    void navigator.clipboard?.writeText(`${location.origin}/cong-dong/bai/${post.id}`);
    toast.success('Đã sao chép liên kết');
  };

  return (
    <>
      <article
        className={cn('border-b border-line px-4 py-3.5', !detail && 'cursor-pointer hover:bg-bg-2/40')}
        onClick={() => !detail && live && onOpen?.()}
        aria-label={`Bài viết của ${post.author.displayName}`}
      >
        <header className="flex items-start gap-2.5">
          <Link to={`/cong-dong/u/${post.author.handle}`} onClick={(e) => e.stopPropagation()}>
            <Avatar name={post.author.displayName} handle={post.author.handle} />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px]">
              <Link to={`/cong-dong/u/${post.author.handle}`} className="truncate font-semibold hover:underline" onClick={(e) => e.stopPropagation()}>
                {post.author.displayName}
              </Link>
              <span className="truncate text-tx-3">@{post.author.handle}</span>
              <span className="text-tx-3">· {ago(post.createdAt)}</span>
              {post.sentiment && <SentimentBadge s={post.sentiment} />}
            </div>
          </div>
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button className="rounded p-1 text-tx-3 hover:bg-bg-3 hover:text-tx-1" aria-label="Tuỳ chọn bài viết" onClick={() => setMenu((v) => !v)}>
              <MoreHorizontal size={16} />
            </button>
            {menu && (
              <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-md border border-line bg-bg-1 py-1 text-[13px]" style={{ boxShadow: 'var(--shadow)' }} onMouseLeave={() => setMenu(false)}>
                <button className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-bg-2" onClick={copyLink}>
                  <Link2 size={14} /> Sao chép liên kết
                </button>
                {post.mine ? (
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-down hover:bg-bg-2"
                    onClick={() => {
                      setMenu(false);
                      if (confirm('Xoá bài viết này?')) void act(`/square/posts/${post.id}`, 'DELETE', undefined, 'Đã xoá bài viết');
                    }}
                  >
                    <Trash2 size={14} /> Xoá bài
                  </button>
                ) : (
                  loggedIn &&
                  live && (
                    <button
                      className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-bg-2"
                      onClick={() => {
                        setMenu(false);
                        setReport(true);
                      }}
                    >
                      <Flag size={14} /> Báo cáo
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        </header>

        <div className="mt-2 space-y-2.5 pl-[46px]">
          {post.status === 'PENDING' && (
            <div className="flex items-start gap-2 rounded-md bg-ref/10 px-3 py-2 text-[12px] text-ref">
              <Clock3 size={14} className="mt-0.5 shrink-0" />
              <span>
                Đang chờ kiểm duyệt — chỉ bạn thấy bài này.
                {!!post.hits?.length && ` Lý do: ${[...new Set(post.hits.map((h) => MOD_RULE_LABEL[h.rule]))].join(', ')}.`}
              </span>
            </div>
          )}
          {post.removed && (
            <div className="flex flex-wrap items-start gap-2 rounded-md bg-down/10 px-3 py-2 text-[12px] text-down">
              <ShieldAlert size={14} className="mt-0.5 shrink-0" />
              <span className="flex-1">
                Bài đã bị gỡ: {MOD_RULE_LABEL[post.removed.rule]}
                {post.removed.note && ` — ${post.removed.note}`}
                {post.removed.appealStatus === 'PENDING' && ' · Khiếu nại đang được xem xét'}
                {post.removed.appealStatus === 'REJECTED' && ' · Khiếu nại không được chấp nhận'}
              </span>
              {post.removed.canAppeal && (
                <button className="font-semibold underline-offset-2 hover:underline" onClick={(e) => (e.stopPropagation(), setAppeal(true))}>
                  Khiếu nại
                </button>
              )}
            </div>
          )}
          <RichText text={post.body} assets={post.assets} className={cn(!detail && 'line-clamp-[10]')} />
          {post.share && <ShareCard share={post.share} />}
          <CoinChips assets={post.assets} />
          {live && (
            <div className="flex items-center gap-5 pt-0.5 text-[12px] text-tx-3" onClick={(e) => e.stopPropagation()}>
              <button className={cn('flex items-center gap-1.5 hover:text-down', liked && 'text-down')} onClick={() => void toggleLike()} aria-pressed={liked} aria-label="Thích">
                <Heart size={15} fill={liked ? 'currentColor' : 'none'} /> <span className="num">{likes}</span>
              </button>
              {detail ? (
                <span className="flex items-center gap-1.5">
                  <MessageCircle size={15} /> <span className="num">{post.commentCount}</span>
                </span>
              ) : (
                <Link to={`/cong-dong/bai/${post.id}`} className="flex items-center gap-1.5 hover:text-tx-1" aria-label="Bình luận">
                  <MessageCircle size={15} /> <span className="num">{post.commentCount}</span>
                </Link>
              )}
            </div>
          )}
        </div>
      </article>
      {/* Ngoài <article>: sự kiện trong portal vẫn nổi lên cây React, tránh mở bài khi bấm trong hộp thoại */}
      <ReportModal open={report} onClose={() => setReport(false)} targetType="POST" targetId={String(post.id)} />
      <AppealModal open={appeal} onClose={() => setAppeal(false)} path={`/square/posts/${post.id}/appeal`} />
    </>
  );
}
