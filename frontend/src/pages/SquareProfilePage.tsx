import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, Flag, PenLine } from 'lucide-react';
import { ProfileModal, ReportModal } from '../components/square/Modals';
import { Avatar } from '../components/square/PostCard';
import { Empty, Spinner } from '../components/common/ui';
import { useLoggedIn } from '../lib/queries';
import { useSquareAction, useSquareProfile } from '../lib/square';
import { Feed } from './SquarePage';

export default function SquareProfilePage() {
  const handle = (useParams().handle ?? '').toLowerCase();
  const { data: p, isLoading, isError } = useSquareProfile(handle);
  const loggedIn = useLoggedIn();
  const act = useSquareAction();
  const [edit, setEdit] = useState(false);
  const [report, setReport] = useState(false);

  useEffect(() => {
    if (p) document.title = `${p.displayName} (@${p.handle}) · Cộng đồng VNCoin`;
    return () => void (document.title = 'VNCoin · Sàn giao dịch coin mô phỏng');
  }, [p]);

  return (
    <div className="mx-auto w-full max-w-[760px] p-3">
      <Link to="/cong-dong" className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-tx-2 hover:text-tx-1">
        <ArrowLeft size={15} /> Cộng đồng
      </Link>
      <div className="panel overflow-hidden">
        {isLoading ? (
          <Spinner className="m-8" />
        ) : isError || !p ? (
          <Empty title="Không tìm thấy người dùng" />
        ) : (
          <>
            <section className="border-b border-line px-4 py-4">
              <div className="flex flex-wrap items-start gap-3">
                <Avatar name={p.displayName} handle={p.handle} size={56} />
                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-[18px] font-bold">{p.displayName}</h1>
                  <div className="text-[13px] text-tx-3">@{p.handle}</div>
                  {p.bio && <p className="mt-2 whitespace-pre-wrap text-[13px] text-tx-2">{p.bio}</p>}
                  <div className="mt-2 flex items-center gap-1 text-[12px] text-tx-3">
                    <CalendarDays size={13} /> Tham gia {new Date(p.joinedAt).toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' })}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {p.isMe ? (
                    <button className="btn btn-ghost h-8 px-3 text-[13px]" onClick={() => setEdit(true)}>
                      <PenLine size={14} /> Sửa hồ sơ
                    </button>
                  ) : (
                    loggedIn && (
                      <>
                        <button
                          className={p.followed ? 'btn btn-ghost h-8 px-3 text-[13px]' : 'btn btn-brand h-8 px-3 text-[13px]'}
                          onClick={() => void act(`/square/users/${p.handle}/follow`, p.followed ? 'DELETE' : 'POST')}
                        >
                          {p.followed ? 'Đang theo dõi' : 'Theo dõi'}
                        </button>
                        <button className="rounded p-1.5 text-tx-3 hover:bg-bg-3 hover:text-tx-1" aria-label="Báo cáo hồ sơ" onClick={() => setReport(true)}>
                          <Flag size={15} />
                        </button>
                      </>
                    )
                  )}
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
                {[
                  [p.posts, 'bài viết'],
                  [p.followers, 'người theo dõi'],
                  [p.following, 'đang theo dõi'],
                  [p.likesReceived, 'lượt thích'],
                ].map(([v, l]) => (
                  <span key={l as string}>
                    <b className="num">{v}</b> <span className="text-tx-3">{l}</span>
                  </span>
                ))}
              </div>
              {p.banned && <p className="mt-3 rounded-md bg-down/10 px-3 py-2 text-[12px] text-down">Tài khoản đang bị hạn chế đăng bài do vi phạm Tiêu chuẩn cộng đồng.</p>}
            </section>
            <Feed tab="latest" author={p.handle} />
            {p.isMe && <ProfileModal open={edit} onClose={() => setEdit(false)} current={p} />}
            <ReportModal open={report} onClose={() => setReport(false)} targetType="PROFILE" targetId={p.handle} />
          </>
        )}
      </div>
    </div>
  );
}
