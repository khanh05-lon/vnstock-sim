import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Gavel, ShieldCheck } from 'lucide-react';
import { MOD_RULE_ACTION, MOD_RULE_LABEL, MOD_RULES, SQUARE_GUIDELINES, describeStrikeLadder } from '@vss/shared';
import { cn } from '../lib/format';
import { useSquareConfig } from '../lib/square';

/** Tiêu chuẩn cộng đồng: quy tắc, cách bộ lọc xử lý, thang phạt, khiếu nại */
export default function SquareGuidelinesPage() {
  const { data: cfg } = useSquareConfig();
  useEffect(() => {
    document.title = 'Tiêu chuẩn cộng đồng · VNCoin';
    return () => void (document.title = 'VNCoin · Sàn giao dịch coin mô phỏng');
  }, []);
  const ladder = describeStrikeLadder(cfg?.strikeBanHours ?? [0, 24, 168, 720], cfg?.strikeExpiryDays ?? 90);

  return (
    <div className="mx-auto w-full max-w-[820px] space-y-4 p-3">
      <Link to="/cong-dong" className="inline-flex items-center gap-1.5 text-[13px] text-tx-2 hover:text-tx-1">
        <ArrowLeft size={15} /> Cộng đồng
      </Link>
      <div>
        <h1 className="flex items-center gap-2 text-[22px] font-bold">
          <ShieldCheck size={22} className="text-brand" /> Tiêu chuẩn cộng đồng
        </h1>
        <p className="mt-1 max-w-[70ch] text-[13px] text-tx-2">
          Cộng đồng VNCoin là nơi trao đổi nhận định thị trường một cách tôn trọng và an toàn. Mọi bài viết, bình luận và hồ sơ đều phải tuân thủ các quy tắc dưới đây.
        </p>
      </div>

      {SQUARE_GUIDELINES.map((g) => (
        <section key={g.title} className="panel p-4">
          <h2 className="text-[15px] font-semibold">{g.title}</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[13px] text-tx-2">
            {g.items.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </section>
      ))}

      <section className="panel p-4">
        <h2 className="text-[15px] font-semibold">Kiểm duyệt nội dung</h2>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[13px] text-tx-2">
          <li>
            <b>Bộ lọc tự động</b> kiểm tra mọi bài, bình luận và hồ sơ khi gửi. Vi phạm rõ ràng bị chặn ngay; nội dung có dấu hiệu nhạy cảm được giữ lại chờ kiểm duyệt
            viên xem (chỉ bạn thấy trong lúc chờ).
          </li>
          <li>
            <b>Báo cáo</b> từ người dùng: nội dung bị từ {cfg?.autoHideReports ?? 3} người trở lên báo cáo được tạm ẩn chờ xem xét.
          </li>
          <li>
            <b>Kiểm duyệt viên</b> quyết định giữ hay gỡ. Gỡ do vi phạm được tính là 1 lần vi phạm.
          </li>
        </ol>
        <div className="mt-3 overflow-x-auto">
          <table className="tbl w-full min-w-[420px] text-[12px]">
            <thead>
              <tr className="text-left">
                <th className="px-3 py-2">Nội dung</th>
                <th className="px-3 py-2">Bộ lọc tự động</th>
              </tr>
            </thead>
            <tbody>
              {MOD_RULES.filter((r) => r !== 'CUSTOM').map((r) => (
                <tr key={r} className="border-t border-line">
                  <td className="px-3 py-2">{MOD_RULE_LABEL[r]}</td>
                  <td className={cn('px-3 py-2', MOD_RULE_ACTION[r] === 'BLOCK' ? 'text-down' : 'text-ref')}>{MOD_RULE_ACTION[r] === 'BLOCK' ? 'Chặn' : 'Giữ lại chờ duyệt'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel p-4">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <Gavel size={16} className="text-brand" /> Thang phạt và khiếu nại
        </h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[13px] text-tx-2">
          {ladder.map((l) => (
            <li key={l}>{l}</li>
          ))}
          <li>Bị cấm đăng: bạn vẫn đọc, thích, theo dõi và giao dịch bình thường, chỉ không đăng bài / bình luận.</li>
          <li>Mỗi nội dung bị gỡ được khiếu nại 1 lần; một kiểm duyệt viên khác người đã gỡ sẽ xem lại. Khiếu nại thành công thì nội dung hiện lại và vi phạm được xoá.</li>
          <li>Cấm vĩnh viễn và gỡ cấm dài hạn đều cần hai kiểm duyệt viên đồng ý.</li>
        </ul>
      </section>
      <p className="text-[11px] text-tx-3">
        Điều kiện đăng bài: đã xác thực email và tài khoản tạo từ {cfg?.minAccountAgeHours ?? 24} giờ trước. Tối đa {cfg?.postsPerHour ?? 5} bài / giờ, {cfg?.postsPerDay ?? 20} bài /
        ngày, {cfg?.commentsPerHour ?? 30} bình luận / giờ.
      </p>
    </div>
  );
}
