import { useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { Activity, CheckCheck, Coins, Database, Gauge, Headset, LayoutDashboard, ListOrdered, ScrollText, ShieldCheck, SlidersHorizontal, Users as UsersIcon } from 'lucide-react';
import { AdjustRequests } from '../components/admin/AdjustRequests';
import { OperationApprovals } from '../components/admin/OperationApprovals';
import { DataStorage } from '../components/admin/DataStorage';
import { Logs } from '../components/admin/Logs';
import { MarketOps } from '../components/admin/MarketOps';
import { Monitor } from '../components/admin/Monitor';
import { Orders } from '../components/admin/Orders';
import { Overview } from '../components/admin/Overview';
import { PriceControl } from '../components/admin/PriceControl';
import { Symbols } from '../components/admin/Symbols';
import { UserDetailModal, Users } from '../components/admin/Users';
import { Empty, Spinner } from '../components/common/ui';
import { useAdminMe, useApprovals } from '../lib/admin';
import { useAdjustRequests } from '../lib/support';
import { ROLE_LABEL } from '@vss/shared';
import { cn } from '../lib/format';
import { useAuth } from '../store/auth';

const TABS = [
  { id: 'overview', label: 'Tổng quan', icon: LayoutDashboard, hint: 'Chỉ số chính & sức khoẻ hệ thống', perms: ['admin.view'] },
  { id: 'users', label: 'Người dùng', icon: UsersIcon, hint: 'Khoá, điều chỉnh số dư, phân quyền nhân viên', perms: ['users.view'] },
  { id: 'orders', label: 'Lệnh giao dịch', icon: ListOrdered, hint: 'Theo dõi & huỷ hộ lệnh', perms: ['admin.view'] },
  { id: 'approvals', label: 'Hàng chờ duyệt', icon: CheckCheck, hint: 'Thao tác lớn và điều chỉnh số dư — người thứ hai có thẩm quyền duyệt rồi mới thực hiện', perms: ['admin.view'] },
  { id: 'market', label: 'Vận hành thị trường', icon: Activity, hint: 'Nguồn giá, tạm ngừng giao dịch, thông báo, biểu phí', perms: ['admin.view'] },
  { id: 'prices', label: 'Giá thị trường', icon: SlidersHorizontal, hint: 'Giá thực tế (Binance) hoặc giá điều chỉnh cho từng cặp: đặt giá, chạy kịch bản', perms: ['admin.view'] },
  { id: 'symbols', label: 'Cặp giao dịch', icon: Coins, hint: 'Đề xuất niêm yết / huỷ niêm yết, tạm ngừng cặp', perms: ['admin.view'] },
  { id: 'data', label: 'Dữ liệu & sao lưu', icon: Database, hint: 'Nơi lưu trữ, bảng, sao lưu, khôi phục', perms: ['system.view'] },
  { id: 'monitor', label: 'Giám sát', icon: Gauge, hint: 'Chỉ số vận hành, cảnh báo tự động', perms: ['system.view'] },
  { id: 'logs', label: 'Nhật ký', icon: ScrollText, hint: 'Nhật ký quản trị & log máy chủ', perms: ['audit.view', 'system.view'] },
] as const;
type TabId = (typeof TABS)[number]['id'];

/** Số việc đang chờ duyệt (hiện cạnh mục Hàng chờ duyệt) */
function PendingBadge() {
  const ops = useApprovals('PENDING');
  const money = useAdjustRequests('PENDING');
  const n = (ops.data?.length ?? 0) + (money.data?.length ?? 0);
  return n ? <span className="ml-auto rounded-full bg-ref px-1.5 text-[10px] font-bold text-white">{n}</span> : null;
}

export default function AdminPage() {
  const token = useAuth((s) => s.token);
  const me = useAdminMe();
  const { isAdmin, loading } = me;
  const [params, setParams] = useSearchParams();
  // Chỉ hiện mục vai trò hiện tại được xem
  const tabs = TABS.filter((t) => t.perms.some((p) => me.can(p)));
  const tab = (tabs.some((t) => t.id === params.get('tab')) ? params.get('tab') : (tabs[0]?.id ?? 'overview')) as TabId;
  const [openUser, setOpenUser] = useState<string | null>(null);
  const go = (t: string) => setParams({ tab: t }, { replace: true });

  useEffect(() => {
    document.title = 'Quản trị · VNCoin';
    return () => {
      document.title = 'VNCoin · Sàn giao dịch coin mô phỏng';
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

  const current = tabs.find((t) => t.id === tab) ?? TABS[0];
  // Vai trò không xem được hồ sơ người dùng → không mở hồ sơ từ các bảng
  const openUserIf = me.can('users.view') ? setOpenUser : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <aside className="shrink-0 border-b border-line bg-bg-1 lg:w-60 lg:border-b-0 lg:border-r">
        <div className="hidden items-center gap-2 px-4 pb-2 pt-4 lg:flex">
          <ShieldCheck size={18} className="text-brand" />
          <span className="font-semibold">Khu vực quản trị</span>
        </div>
        {me.role && <div className="hidden px-4 pb-2 text-[12px] text-tx-3 lg:block">Vai trò: {ROLE_LABEL[me.role]}</div>}
        <nav className="flex gap-1 overflow-x-auto p-2 lg:flex-col" aria-label="Mục quản trị">
          {tabs.map((t) => (
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
              {t.id === 'approvals' && <PendingBadge />}
            </button>
          ))}
        </nav>
        {me.can('support.desk') && (
        <Link to="/cskh" className="mx-2 mb-1 hidden items-center gap-2 rounded-md px-3 py-2 text-[13px] font-medium text-tx-2 hover:bg-bg-3 hover:text-tx-1 lg:flex">
          <Headset size={16} /> Hỗ trợ khách hàng ↗
        </Link>
        )}
        <p className="hidden px-4 py-3 text-[11px] text-tx-3 lg:block">Mọi thao tác thay đổi dữ liệu đều được ghi vào nhật ký quản trị (chỉ ghi thêm, không sửa / xoá được) kèm tên người thực hiện.</p>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-4">
        <div className="mb-3">
          <h1 className="text-[20px] font-bold">{current.label}</h1>
          <p className="text-[12px] text-tx-3">{current.hint}</p>
        </div>
        {tab === 'overview' && <Overview onOpenUser={openUserIf ?? (() => undefined)} goTab={go} />}
        {tab === 'users' && <Users onOpenUser={setOpenUser} />}
        {tab === 'orders' && <Orders onOpenUser={openUserIf ?? (() => undefined)} />}
        {tab === 'approvals' && (
          <div className="space-y-3">
            <OperationApprovals />
            <AdjustRequests />
          </div>
        )}
        {tab === 'market' && <MarketOps />}
        {tab === 'prices' && <PriceControl />}
        {tab === 'symbols' && <Symbols />}
        {tab === 'data' && <DataStorage />}
        {tab === 'monitor' && <Monitor />}
        {tab === 'logs' && <Logs />}
      </div>
      <UserDetailModal id={openUser} onClose={() => setOpenUser(null)} />
    </div>
  );
}
