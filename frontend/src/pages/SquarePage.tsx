import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Hash, MessagesSquare, PenLine, ShieldAlert, X } from 'lucide-react';
import { Composer } from '../components/square/Composer';
import { ProfileModal } from '../components/square/Modals';
import { Avatar, CoinChips, PostCard } from '../components/square/PostCard';
import { GuidelinesCard, NotificationList, Suggestions, TrendingCoins } from '../components/square/Sidebar';
import { Empty, Spinner, UnderlineTabs } from '../components/common/ui';
import { fmtDateTime } from '../lib/format';
import { useLoggedIn } from '../lib/queries';
import { useFeed, useSquareMe, useTrends, type FeedTab } from '../lib/square';

type Tab = FeedTab | 'notifications';

export function Feed({ tab, coin, tag, author }: { tab: FeedTab; coin?: string; tag?: string; author?: string }) {
  const nav = useNavigate();
  const q = useFeed({ tab, coin, tag, author });
  const posts = q.data?.pages.flatMap((p) => p.posts) ?? [];
  if (q.isLoading) return <Spinner className="m-8" />;
  if (!posts.length)
    return (
      <Empty
        title={tab === 'following' && !author ? 'Chưa có bài từ người bạn theo dõi' : 'Chưa có bài viết'}
        hint={tab === 'following' && !author ? 'Theo dõi nhà đầu tư ở mục Gợi ý theo dõi để thấy bài của họ ở đây.' : undefined}
      />
    );
  return (
    <div>
      {posts.map((p) => (
        <PostCard key={p.id} post={p} onOpen={() => nav(`/cong-dong/bai/${p.id}`)} />
      ))}
      {q.hasNextPage && (
        <div className="p-3 text-center">
          <button className="btn btn-ghost" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? 'Đang tải…' : 'Xem thêm'}
          </button>
        </div>
      )}
    </div>
  );
}

function CoinSentiment({ coin }: { coin: string }) {
  const { data } = useTrends(coin);
  const t = data?.[0];
  const voted = t ? t.bullish + t.bearish : 0;
  return (
    <div className="space-y-2 border-b border-line px-4 py-3">
      <CoinChips assets={[coin]} />
      <p className="text-[12px] text-tx-3">
        {t ? `${t.posts} bài về $${coin} trong 24 giờ` : `Chưa có bài về $${coin} trong 24 giờ`}
        {voted > 0 && ` · ${Math.round((t!.bullish / voted) * 100)}% nhận định Tăng`}
      </p>
    </div>
  );
}

/** Cộng đồng VNCoin (kiểu Binance Square) */
export default function SquarePage() {
  const [params, setParams] = useSearchParams();
  const coin = params.get('coin')?.toUpperCase() || undefined;
  const tag = params.get('tag') || undefined;
  const loggedIn = useLoggedIn();
  const { data: me } = useSquareMe();
  const [tab, setTab] = useState<Tab>(coin || tag ? 'latest' : 'foryou');
  const [editProfile, setEditProfile] = useState(false);

  useEffect(() => {
    document.title = 'Cộng đồng · VNCoin';
    return () => void (document.title = 'VNCoin · Sàn giao dịch coin mô phỏng');
  }, []);
  useEffect(() => {
    if (coin || tag) setTab('latest');
  }, [coin, tag]);

  const clearFilter = () => setParams({});
  const tabs: { value: Tab; label: string }[] = [
    { value: 'foryou', label: 'Dành cho bạn' },
    { value: 'latest', label: 'Mới nhất' },
    ...(loggedIn ? [{ value: 'following' as Tab, label: 'Đang theo dõi' }, { value: 'notifications' as Tab, label: me?.unread ? `Thông báo (${me.unread})` : 'Thông báo' }] : []),
  ];

  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-4 p-3 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="flex items-center gap-2 text-[20px] font-bold">
              <MessagesSquare size={20} className="text-brand" /> Cộng đồng
            </h1>
            <p className="text-[12px] text-tx-3">Trao đổi nhận định, chia sẻ lệnh đã khớp. Quan điểm cá nhân, không phải khuyến nghị đầu tư.</p>
          </div>
        </div>
        <div className="panel overflow-hidden">
          {(coin || tag) && (
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[13px]">
              {coin ? <span className="font-semibold">${coin}</span> : <span className="flex items-center gap-1 font-semibold"><Hash size={14} />{tag}</span>}
              <button className="ml-auto flex items-center gap-1 text-[12px] text-tx-3 hover:text-tx-1" onClick={clearFilter}>
                <X size={13} /> Bỏ lọc
              </button>
            </div>
          )}
          {coin && <CoinSentiment coin={coin} />}
          <UnderlineTabs value={tab} onChange={setTab} items={tabs.filter((t) => !(coin || tag) || t.value === 'latest' || t.value === 'foryou')} />
          {tab === 'notifications' ? (
            <NotificationList />
          ) : (
            <>
              <Composer key={coin ?? tag ?? 'all'} defaultCoin={coin} />
              <Feed tab={coin || tag ? 'latest' : tab} coin={coin} tag={tag} />
            </>
          )}
        </div>
      </div>

      <aside className="space-y-3">
        {me?.profile && (
          <section className="panel p-4">
            <div className="flex items-center gap-2.5">
              <Avatar name={me.profile.displayName} handle={me.profile.handle} size={40} />
              <div className="min-w-0 flex-1">
                <Link to={`/cong-dong/u/${me.profile.handle}`} className="block truncate text-[14px] font-semibold hover:underline">
                  {me.profile.displayName}
                </Link>
                <span className="text-[12px] text-tx-3">@{me.profile.handle}</span>
              </div>
              <button className="rounded p-1.5 text-tx-3 hover:bg-bg-3 hover:text-tx-1" aria-label="Sửa hồ sơ" onClick={() => setEditProfile(true)}>
                <PenLine size={15} />
              </button>
            </div>
            <div className="mt-3 grid grid-cols-3 text-center text-[12px]">
              {[
                ['Bài viết', me.profile.posts],
                ['Theo dõi', me.profile.following],
                ['Người theo dõi', me.profile.followers],
              ].map(([l, v]) => (
                <div key={l as string}>
                  <div className="num text-[15px] font-semibold">{v}</div>
                  <div className="text-tx-3">{l}</div>
                </div>
              ))}
            </div>
            {(me.activeStrikes > 0 || !me.canPost) && (
              <div className="mt-3 flex gap-2 rounded-md bg-down/10 px-3 py-2 text-[12px] text-down">
                <ShieldAlert size={14} className="mt-0.5 shrink-0" />
                <div>
                  {me.activeStrikes > 0 && <div>{me.activeStrikes} vi phạm còn hiệu lực</div>}
                  {me.banPermanent ? <div>Bị cấm đăng vĩnh viễn</div> : me.banUntil && <div>Cấm đăng tới {fmtDateTime(me.banUntil)}</div>}
                </div>
              </div>
            )}
            <ProfileModal open={editProfile} onClose={() => setEditProfile(false)} current={me.profile} />
          </section>
        )}
        <TrendingCoins />
        <Suggestions />
        <GuidelinesCard />
      </aside>
    </div>
  );
}
