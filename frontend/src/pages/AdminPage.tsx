import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Activity, Database, LayoutDashboard, ListOrdered, ScrollText, ShieldCheck, Users as UsersIcon } from 'lucide-react';
import { DataStorage } from '../components/admin/DataStorage';
import { Logs } from '../components/admin/Logs';
import { MarketOps } from '../components/admin/MarketOps';
import { Orders } from '../components/admin/Orders';
import { Overview } from '../components/admin/Overview';
import { UserDetailModal, Users } from '../components/admin/Users';
import { Empty, Spinner } from '../components/common/ui';
import { useAdminMe } from '../lib/admin';
import { cn } from '../lib/format';
import { useAuth } from '../store/auth';

const TABS = [
  { id: 'overview', label: 'Tổng quan', icon: LayoutDashboard, hint: 'Chỉ số chính & sức khoẻ hệ thống' },
  { id: 'users', label: 'Người dùng', icon: UsersIcon, hint: 'Khoá, điều chỉnh vốn, phân quyền' },
  { id: 'orders', label: 'Lệnh giao dịch', icon: ListOrdered, hint: 'Theo dõi & huỷ hộ lệnh' },
  { id: 'market', label: 'Vận hành thị trường', icon: Activity, hint: 'Ngừng giao dịch, thông báo, ngày lễ' },
  { id: 'data', label: 'Dữ liệu & sao lưu', icon: Database, hint: 'Nơi lưu trữ, bảng, sao lưu' },
  { id: 'logs', label: 'Nhật ký', icon: ScrollText, hint: 'Nhật ký quản trị & log máy chủ' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export default function AdminPage() {
  const token = useAuth((s) => s.token);
  const { isAdmin, loading } = useAdminMe();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'overview') as TabId;
  const [openUser, setOpenUser] = useState<string | null>(null);
  const go = (t: string) => setParams({ tab: t }, { replace: true });

  useEffect(() => {
    document.title = 'Quản trị · VNStock';
    return () => {
      document.title = 'VNStock · Bảng giá & Giao dịch mô phỏng';
    };
  }, []);

  if (!token) return <Navigate to="/login" replace state={{ from: '/admin' }} />;
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Empty icon={<ShieldCheck size={32} strokeWidth={1.5} />} title="Bạn không có quyền truy cập khu vực quản trị" hint="Đăng nhập bằng tài khoản quản trị viên để tiếp tục." />
      </div>
    );
  }

  const current = TABS.find((t) => t.id === tab)!;
  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <aside className="shrink-0 border-b border-line bg-bg-1 lg:w-60 lg:border-b-0 lg:border-r">
        <div className="hidden items-center gap-2 px-4 pb-2 pt-4 lg:flex">
          <ShieldCheck size={18} className="text-brand" />
          <span className="font-semibold">Khu vực quản trị</span>
        </div>
        <nav className="flex gap-1 overflow-x-auto p-2 lg:flex-col" aria-label="Mục quản trị">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => go(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={cn(
                'flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] font-medium transition-colors',
                tab === t.id ? 'bg-brand/12 text-brand' : 'text-tx-2 hover:bg-bg-3 hover:text-tx-1',
              )}
            >
              <t.icon size={16} />
              {t.label}
            </button>
          ))}
        </nav>
        <p className="hidden px-4 py-3 text-[11px] text-tx-3 lg:block">Mọi thao tác thay đổi dữ liệu đều được ghi vào nhật ký quản trị kèm tên người thực hiện.</p>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-4">
        <div className="mb-3">
          <h1 className="text-[20px] font-bold">{current.label}</h1>
          <p className="text-[12px] text-tx-3">{current.hint}</p>
        </div>
        {tab === 'overview' && <Overview onOpenUser={setOpenUser} goTab={go} />}
        {tab === 'users' && <Users onOpenUser={setOpenUser} />}
        {tab === 'orders' && <Orders onOpenUser={setOpenUser} />}
        {tab === 'market' && <MarketOps />}
        {tab === 'data' && <DataStorage />}
        {tab === 'logs' && <Logs />}
      </div>
      <UserDetailModal id={openUser} onClose={() => setOpenUser(null)} />
    </div>
  );
}
