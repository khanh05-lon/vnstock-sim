import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, BadgeCheck, Ban, PenLine, TrendingDown, TrendingUp, X } from 'lucide-react';
import { MOD_RULE_HINT, MOD_RULE_LABEL, SQUARE_POST_MAX, moderateText, type ModResult, type SquareSentiment } from '@vss/shared';
import { cn, fmtDateTime } from '../../lib/format';
import { useLoggedIn, useOrderHistory } from '../../lib/queries';
import { useSquareAction, useSquareConfig, useSquareMe } from '../../lib/square';
import { Avatar } from './PostCard';
import { ProfileModal } from './Modals';

/** Cảnh báo bộ lọc khi đang gõ (cùng bộ lọc với máy chủ, trừ từ quản trị thêm) */
export function ModHints({ result }: { result: ModResult }) {
  if (result.verdict === 'ALLOW') return null;
  const block = result.verdict === 'BLOCK';
  const rules = [...new Map(result.hits.map((h) => [h.rule, h])).values()];
  return (
    <div role="status" className={cn('rounded-md px-3 py-2 text-[12px]', block ? 'bg-down/10 text-down' : 'bg-ref/10 text-ref')}>
      <div className="flex items-center gap-1.5 font-semibold">
        {block ? <Ban size={14} /> : <AlertTriangle size={14} />}
        {block ? 'Không đăng được — vi phạm Tiêu chuẩn cộng đồng' : 'Sẽ chờ kiểm duyệt trước khi hiển thị'}
      </div>
      <ul className="mt-1 space-y-0.5">
        {rules.map((h) => (
          <li key={h.rule}>
            <b>{MOD_RULE_LABEL[h.rule]}</b>
            {h.excerpt && ` ("${h.excerpt}")`}: {MOD_RULE_HINT[h.rule]}
          </li>
        ))}
      </ul>
    </div>
  );
}

type ShareChoice = { type: 'ORDER'; orderId: number; label: string } | { type: 'ROI'; label: string } | null;

export function Composer({ defaultCoin, onPosted }: { defaultCoin?: string; onPosted?: () => void }) {
  const loggedIn = useLoggedIn();
  const { data: me } = useSquareMe();
  const { data: cfg } = useSquareConfig();
  const act = useSquareAction();
  const [body, setBody] = useState(defaultCoin ? `$${defaultCoin} ` : '');
  const [sentiment, setSentiment] = useState<SquareSentiment | null>(null);
  const [share, setShare] = useState<ShareChoice>(null);
  const [picker, setPicker] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data: orders } = useOrderHistory({}, 100);
  const filled = useMemo(() => (orders ?? []).filter((o) => Number(o.executedQty) > 0).slice(0, 15), [orders]);
  const check = useMemo(() => moderateText(body, { allowedDomains: cfg?.allowedDomains }), [body, cfg?.allowedDomains]);

  if (!loggedIn)
    return (
      <div className="border-b border-line px-4 py-4 text-[13px] text-tx-2">
        <Link to="/login" className="font-semibold text-brand hover:underline">
          Đăng nhập
        </Link>{' '}
        để đăng bài, bình luận và theo dõi nhà đầu tư khác.
      </div>
    );
  if (!me) return <div className="h-24 border-b border-line" />;
  if (!me.profile)
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-4">
        <div className="text-[13px] text-tx-2">
          Tạo hồ sơ Cộng đồng (tên @ công khai, không lộ email) để bắt đầu đăng bài.
          {me.blockedReason && me.blockedReason !== 'Tạo hồ sơ Cộng đồng trước khi đăng' && <div className="mt-1 text-[12px] text-tx-3">{me.blockedReason}</div>}
        </div>
        <button className="btn btn-brand" onClick={() => setProfileOpen(true)} disabled={me.blockedReason?.startsWith('Tài khoản nhân viên')}>
          <PenLine size={15} /> Tạo hồ sơ
        </button>
        <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} current={null} />
      </div>
    );

  const submit = async () => {
    setBusy(true);
    const r = await act<{ status: string }>('/square/posts', 'POST', {
      body,
      sentiment,
      share: share ? (share.type === 'ORDER' ? { type: 'ORDER', orderId: share.orderId } : { type: 'ROI' }) : null,
    });
    setBusy(false);
    if (!r) return;
    setBody('');
    setSentiment(null);
    setShare(null);
    onPosted?.();
    if (r.status === 'PENDING') toast.info('Bài đang chờ kiểm duyệt — chỉ bạn thấy cho tới khi được duyệt', { duration: 8000 });
    else toast.success('Đã đăng bài');
  };

  return (
    <div className="border-b border-line px-4 py-3">
      <div className="flex gap-2.5">
        <Avatar name={me.profile.displayName} handle={me.profile.handle} />
        <div className="min-w-0 flex-1 space-y-2">
          {!me.canPost ? (
            <div className="rounded-md bg-down/10 px-3 py-2.5 text-[13px] text-down">{me.blockedReason}</div>
          ) : (
            <>
              <textarea
                className="input min-h-[84px] resize-y py-2 text-[14px]"
                placeholder={`Bạn nghĩ gì về thị trường? Gắn coin bằng $BTC, chủ đề bằng #phantich`}
                value={body}
                maxLength={SQUARE_POST_MAX}
                onChange={(e) => setBody(e.target.value)}
                aria-label="Nội dung bài viết"
              />
              <ModHints result={check} />
              {share && (
                <div className="flex items-center gap-2 rounded-md border border-line bg-bg-2 px-3 py-1.5 text-[12px]">
                  <BadgeCheck size={14} className="text-brand" />
                  <span className="flex-1 truncate">Đính kèm: {share.label}</span>
                  <button aria-label="Bỏ đính kèm" className="text-tx-3 hover:text-tx-1" onClick={() => setShare(null)}>
                    <X size={14} />
                  </button>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex overflow-hidden rounded-md border border-line text-[12px]" role="group" aria-label="Nhận định">
                  {(['BULLISH', 'BEARISH'] as const).map((s) => (
                    <button
                      key={s}
                      aria-pressed={sentiment === s}
                      className={cn(
                        'flex items-center gap-1 px-2.5 py-1.5',
                        sentiment === s ? (s === 'BULLISH' ? 'bg-up/15 text-up' : 'bg-down/15 text-down') : 'text-tx-2 hover:bg-bg-2',
                      )}
                      onClick={() => setSentiment(sentiment === s ? null : s)}
                    >
                      {s === 'BULLISH' ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                      {s === 'BULLISH' ? 'Tăng' : 'Giảm'}
                    </button>
                  ))}
                </div>
                <div className="relative">
                  <button className="btn btn-ghost h-8 px-2.5 text-[12px]" onClick={() => setPicker((v) => !v)} aria-expanded={picker}>
                    <BadgeCheck size={14} /> Chia sẻ lệnh / ROI
                  </button>
                  {picker && (
                    <div
                      className="absolute left-0 z-20 mt-1 max-h-72 w-72 overflow-y-auto rounded-md border border-line bg-bg-1 py-1 text-[12px]"
                      style={{ boxShadow: 'var(--shadow)' }}
                      onMouseLeave={() => setPicker(false)}
                    >
                      <button
                        className="block w-full px-3 py-2 text-left hover:bg-bg-2"
                        onClick={() => {
                          setShare({ type: 'ROI', label: 'ROI tài khoản (từ đầu)' });
                          setPicker(false);
                        }}
                      >
                        ROI tài khoản (từ đầu)
                      </button>
                      <div className="border-t border-line px-3 pb-1 pt-2 text-[11px] text-tx-3">Lệnh đã khớp gần đây</div>
                      {!filled.length && <div className="px-3 py-2 text-tx-3">Chưa có lệnh khớp</div>}
                      {filled.map((o) => {
                        const label = `${o.side === 'BUY' ? 'Mua' : 'Bán'} ${o.symbol.replace('USDT', '/USDT')} · ${fmtDateTime(o.updatedAt)}`;
                        return (
                          <button
                            key={o.id}
                            className="block w-full px-3 py-1.5 text-left hover:bg-bg-2"
                            onClick={() => {
                              setShare({ type: 'ORDER', orderId: o.id, label });
                              setPicker(false);
                            }}
                          >
                            <span className={o.side === 'BUY' ? 'text-up' : 'text-down'}>{o.side === 'BUY' ? 'Mua' : 'Bán'}</span> {o.symbol.replace('USDT', '/USDT')}
                            <span className="ml-1 text-tx-3">{fmtDateTime(o.updatedAt)}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <span className="num ml-auto text-[11px] text-tx-3">
                  {body.length}/{SQUARE_POST_MAX}
                </span>
                <button className="btn btn-brand h-8 px-4" disabled={!body.trim() || check.verdict === 'BLOCK' || busy} onClick={() => void submit()}>
                  Đăng
                </button>
              </div>
              <p className="text-[11px] text-tx-3">
                Nhận định là quan điểm cá nhân, không phải khuyến nghị đầu tư.{' '}
                <Link to="/cong-dong/quy-tac" className="text-brand hover:underline">
                  Tiêu chuẩn cộng đồng
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
