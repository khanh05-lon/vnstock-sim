import { useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { MAX_WATCHLISTS } from '@vss/shared';
import { cn } from '../../lib/format';
import { useWatchlists } from '../../lib/queries';

/** Thanh chọn danh sách theo dõi: chuyển danh sách, tạo mới, đổi tên, xoá (nút ☆ thêm mã vào danh sách đang chọn) */
export function WatchlistBar() {
  const w = useWatchlists();
  const [editing, setEditing] = useState<'new' | number | null>(null);
  const [name, setName] = useState('');
  if (!w.loggedIn || !w.lists.length) return null;

  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    if (editing === 'new') await w.create(n);
    else if (typeof editing === 'number') await w.rename(editing, n);
    setEditing(null);
    setName('');
  };

  const input = (
    <span className="flex items-center gap-1">
      <input
        autoFocus
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') setEditing(null);
        }}
        placeholder="Tên danh sách"
        aria-label="Tên danh sách theo dõi"
        className="h-7 w-36 rounded-md border border-brand bg-bg-3 px-2 text-[12px] outline-none"
      />
      <button onClick={() => void submit()} className="rounded p-1 text-up hover:bg-bg-3" aria-label="Lưu tên danh sách">
        <Check size={14} />
      </button>
      <button onClick={() => setEditing(null)} className="rounded p-1 text-tx-3 hover:bg-bg-3" aria-label="Huỷ">
        <X size={14} />
      </button>
    </span>
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5 text-[12px]">
      <span className="text-tx-3">Danh sách:</span>
      {w.lists.map((l) =>
        editing === l.id ? (
          <span key={l.id}>{input}</span>
        ) : (
          <span key={l.id} className="flex items-center">
            <button
              onClick={() => w.setActive(l.id)}
              className={cn(
                'h-7 rounded-md border px-2.5 font-medium transition-colors',
                w.active?.id === l.id ? 'border-brand bg-brand/10 text-brand' : 'border-line text-tx-2 hover:border-line-2',
              )}
            >
              {l.name} <span className="text-tx-3">({l.symbols.length})</span>
            </button>
            {w.active?.id === l.id && (
              <>
                <button
                  onClick={() => {
                    setEditing(l.id);
                    setName(l.name);
                  }}
                  className="ml-0.5 rounded p-1 text-tx-3 hover:bg-bg-3 hover:text-brand"
                  aria-label={`Đổi tên danh sách ${l.name}`}
                  title="Đổi tên"
                >
                  <Pencil size={12} />
                </button>
                {w.lists.length > 1 && (
                  <button
                    onClick={() => {
                      if (window.confirm(`Xoá danh sách "${l.name}" (${l.symbols.length} mã)?`)) void w.remove(l.id);
                    }}
                    className="rounded p-1 text-tx-3 hover:bg-bg-3 hover:text-down"
                    aria-label={`Xoá danh sách ${l.name}`}
                    title="Xoá danh sách"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </>
            )}
          </span>
        ),
      )}
      {editing === 'new'
        ? input
        : w.lists.length < MAX_WATCHLISTS && (
            <button
              onClick={() => {
                setEditing('new');
                setName('');
              }}
              className="flex h-7 items-center gap-1 rounded-md border border-dashed border-line px-2 text-tx-3 hover:border-brand hover:text-brand"
            >
              <Plus size={12} /> Danh sách mới
            </button>
          )}
      <span className="ml-auto text-tx-3">Bấm ☆ ở đầu dòng để thêm / bỏ mã khỏi danh sách đang chọn</span>
    </div>
  );
}
