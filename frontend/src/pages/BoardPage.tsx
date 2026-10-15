import { PriceBoard } from '../components/board/PriceBoard';
import { IndexBar } from '../components/layout/IndexBar';

export function BoardPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <IndexBar />
      <div className="mx-3 mb-3 flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-lg border border-line bg-bg-1">
        <PriceBoard />
      </div>
    </div>
  );
}
