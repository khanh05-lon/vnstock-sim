import { useState } from 'react';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { downloadBackup, fmtBytes, useAdminData } from '../../lib/admin';
import { fmtInt } from '../../lib/format';
import { Spinner } from '../common/ui';
import { KeyValue, Pill, Section } from './adminUi';

export function DataStorage() {
  const { data, isLoading } = useAdminData();
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  if (isLoading || !data) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }
  const pglite = data.db.kind !== 'postgres';
  const groups = [...new Set(data.tables.map((t) => t.group))];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Section title="Cơ sở dữ liệu đang dùng" actions={<Pill tone={pglite ? 'warn' : 'good'}>{pglite ? 'PGlite nhúng (dev / demo)' : 'PostgreSQL'}</Pill>}>
          <KeyValue
            cols={1}
            items={[
              ['Loại', pglite ? 'PostgreSQL nhúng (PGlite) chạy trong tiến trình máy chủ' : 'Máy chủ PostgreSQL riêng'],
              ['Vị trí', <span className="font-mono text-[11.5px]">{data.db.location ?? '—'}</span>],
              ['Dung lượng', fmtBytes(data.db.sizeBytes)],
              ['Bộ nhớ tiến trình', fmtBytes(data.memory.rssBytes)],
              ['Mã đang theo dõi giá', fmtInt(data.memory.stocks)],
              ['Lệnh chờ trong bộ nhớ', fmtInt(data.memory.openOrders)],
            ]}
          />
          <p className="mt-3 text-[12px] text-tx-3">
            {pglite
              ? 'PGlite lưu toàn bộ dữ liệu thành các file trong thư mục trên. Chỉ 1 tiến trình được mở thư mục này — phù hợp chạy thử. Khi đưa lên Internet, đặt DATABASE_URL để chuyển sang PostgreSQL.'
              : 'Dữ liệu nằm trên máy chủ PostgreSQL theo chuỗi kết nối DATABASE_URL (mật khẩu đã được che).'}
          </p>
        </Section>

        <Section
          title="Sao lưu"
          actions={
            <button
              className="btn btn-brand h-8"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await downloadBackup();
                  toast.success(`Đã tải ${r.name} (${fmtBytes(r.size)})`);
                  void qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : 'Không tải được bản sao lưu');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Download size={14} /> {busy ? 'Đang xuất…' : 'Tải bản sao lưu JSON'}
            </button>
          }
        >
          <ol className="list-decimal space-y-2 pl-5 text-[13px] text-tx-2">
            <li>
              <b className="text-tx-1">Bản JSON (nút bên trên):</b> người dùng (không gồm mật khẩu), tài khoản tiền, lệnh, khớp, danh mục, lô T+2, sao kê, ngày lễ, cấu hình vận hành, nhật ký quản trị. Dùng để lưu trữ, đối soát, chuyển cho kế toán. Mỗi lần xuất đều được ghi vào nhật ký quản trị.
            </li>
            <li>
              <b className="text-tx-1">Bản đầy đủ — PGlite:</b> dừng máy chủ → sao chép nguyên thư mục <code>backend/data/pgdata</code> sang nơi khác → chạy lại. Khôi phục: dừng máy chủ, thay thư mục bằng bản sao.
            </li>
            <li>
              <b className="text-tx-1">Bản đầy đủ — PostgreSQL:</b> chạy <code>pg_dump</code> theo lịch hằng ngày, giữ tối thiểu 7 bản gần nhất ở máy khác; khôi phục bằng <code>pg_restore</code>.
            </li>
          </ol>
        </Section>
      </div>

      <Section title="Dữ liệu nằm ở đâu" pad={false}>
        <div className="overflow-x-auto">
          <table className="tbl w-full min-w-[860px] text-[12.5px]">
            <thead>
              <tr className="h-9 text-left">
                <th className="px-4">Nơi lưu</th>
                <th className="px-2">Nội dung</th>
                <th className="px-2">Giữ trong bao lâu</th>
                <th className="px-4">Mất khi nào</th>
              </tr>
            </thead>
            <tbody className="align-top [&_td]:whitespace-normal [&_td]:py-2.5">
              <tr className="border-t border-line">
                <td className="px-4 font-medium">Trình duyệt của người dùng (localStorage)</td>
                <td className="px-2 text-tx-2">Phiên đăng nhập (token hạn 7 ngày), giao diện sáng / tối, khung biểu đồ, mã xem gần nhất</td>
                <td className="px-2 text-tx-2">Tới khi đăng xuất hoặc hết hạn</td>
                <td className="px-4 text-tx-2">Người dùng xoá dữ liệu trình duyệt — không ảnh hưởng tài khoản</td>
              </tr>
              <tr className="border-t border-line">
                <td className="px-4 font-medium">Bộ nhớ máy chủ (RAM)</td>
                <td className="px-2 text-tx-2">Giá realtime, sổ lệnh 3 bước giá, nến phút đang chạy, bản sao lệnh chờ để khớp nhanh, danh sách tài khoản bị khoá, 400 dòng log gần nhất</td>
                <td className="px-2 text-tx-2">Khi tiến trình đang chạy</td>
                <td className="px-4 text-tx-2">Khởi động lại — giá được khôi phục từ ảnh chụp 10 giây gần nhất trong CSDL, lệnh chờ nạp lại từ CSDL</td>
              </tr>
              <tr className="border-t border-line">
                <td className="px-4 font-medium">Cơ sở dữ liệu ({pglite ? 'PGlite' : 'PostgreSQL'})</td>
                <td className="px-2 text-tx-2">Toàn bộ dữ liệu nghiệp vụ (bảng bên dưới)</td>
                <td className="px-2 text-tx-2">Lâu dài; nến 1 phút và chỉ số theo phút giữ 7 ngày</td>
                <td className="px-4 text-tx-2">Chỉ khi xoá thư mục / CSDL — cần sao lưu định kỳ</td>
              </tr>
              <tr className="border-t border-line">
                <td className="px-4 font-medium">Log máy chủ (stdout)</td>
                <td className="px-2 text-tx-2">Khởi động, lỗi, cảnh báo nguồn giá, request API (dạng JSON khi production)</td>
                <td className="px-2 text-tx-2">Do hệ thống thu log bên ngoài quyết định (Docker, journald…)</td>
                <td className="px-4 text-tx-2">Theo chính sách xoay vòng log</td>
              </tr>
              <tr className="border-t border-line">
                <td className="px-4 font-medium">Bản sao lưu</td>
                <td className="px-2 text-tx-2">File JSON, bản sao thư mục pgdata hoặc pg_dump</td>
                <td className="px-2 text-tx-2">Do quản trị viên quản lý</td>
                <td className="px-4 text-tx-2">—</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Các bảng trong cơ sở dữ liệu" pad={false}>
        <div className="overflow-x-auto">
          <table className="tbl num w-full min-w-[720px] text-[12.5px]">
            <thead>
              <tr className="h-9 text-left">
                <th className="px-4">Nhóm</th>
                <th className="px-2">Bảng</th>
                <th className="px-2">Lưu gì</th>
                <th className="px-4 text-right">Số dòng</th>
              </tr>
            </thead>
            <tbody>
              {groups.flatMap((g) =>
                data.tables
                  .filter((t) => t.group === g)
                  .map((t, i) => (
                    <tr key={t.name} className="h-9 border-t border-line">
                      <td className="px-4 font-medium text-tx-2">{i === 0 ? g : ''}</td>
                      <td className="px-2 font-mono text-[12px]">{t.name}</td>
                      <td className="px-2 text-tx-2">{t.desc}</td>
                      <td className="px-4 text-right">{fmtInt(t.rows)}</td>
                    </tr>
                  )),
              )}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
