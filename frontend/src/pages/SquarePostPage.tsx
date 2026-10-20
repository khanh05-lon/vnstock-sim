import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { CommentThread } from '../components/square/Comments';
import { PostCard } from '../components/square/PostCard';
import { GuidelinesCard, TrendingCoins } from '../components/square/Sidebar';
import { Empty, Spinner } from '../components/common/ui';
import { usePost } from '../lib/square';

export default function SquarePostPage() {
  const id = Number(useParams().id);
  const { data, isLoading, isError } = usePost(id);

  useEffect(() => {
    if (data) document.title = `${data.author.displayName}: ${data.body.slice(0, 50)} · VNCoin`;
    return () => void (document.title = 'VNCoin · Sàn giao dịch coin mô phỏng');
  }, [data]);

  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-4 p-3 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0">
        <Link to="/cong-dong" className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-tx-2 hover:text-tx-1">
          <ArrowLeft size={15} /> Cộng đồng
        </Link>
        <div className="panel overflow-hidden">
          {isLoading ? (
            <Spinner className="m-8" />
          ) : isError || !data ? (
            <Empty title="Bài viết không tồn tại hoặc đã bị gỡ" />
          ) : (
            <>
              <PostCard post={data} detail />
              {data.status === 'PUBLISHED' && <CommentThread postId={data.id} />}
            </>
          )}
        </div>
      </div>
      <aside className="space-y-3">
        <TrendingCoins />
        <GuidelinesCard />
      </aside>
    </div>
  );
}
