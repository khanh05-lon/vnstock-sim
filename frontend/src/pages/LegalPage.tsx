import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { RULES } from '@vss/shared';
import { fmtInt } from '../lib/format';

const UPDATED = '15/10/2026';

function Block({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="text-[16px] font-semibold">
        {n}. {title}
      </h2>
      <div className="mt-2 space-y-2 text-[14px] leading-relaxed text-tx-2">{children}</div>
    </section>
  );
}

function Terms() {
  return (
    <>
      <Block n={1} title="Dịch vụ là gì">
        <p>
          VNStock Sim là <b className="text-tx-1">sàn giao dịch chứng khoán mô phỏng</b> phục vụ học tập. Mỗi tài khoản được cấp {fmtInt(RULES.initialCapital)}đ vốn ảo. Vốn ảo,
          cổ phiếu ảo và lãi / lỗ trên hệ thống <b className="text-tx-1">không có giá trị quy đổi</b> ra tiền thật hay tài sản thật.
        </p>
        <p>VNStock Sim không phải công ty chứng khoán, không nhận tiền của nhà đầu tư và không chuyển lệnh tới Sở Giao dịch Chứng khoán.</p>
      </Block>
      <Block n={2} title="Tài khoản">
        <ul className="list-disc space-y-1 pl-5">
          <li>Thông tin đăng ký phải chính xác; mỗi người dùng một tài khoản.</li>
          <li>Bạn tự bảo mật mật khẩu và chịu trách nhiệm về mọi thao tác thực hiện bằng tài khoản của mình.</li>
          <li>Phát hiện tài khoản bị sử dụng trái phép, hãy đổi mật khẩu và báo ngay cho ban quản trị.</li>
        </ul>
      </Block>
      <Block n={3} title="Dữ liệu giá và thông tin thị trường">
        <p>
          Giá, chỉ số và số liệu doanh nghiệp là dữ liệu giả lập, hoặc dữ liệu thị trường có độ trễ khi hệ thống dùng nguồn giá thật. Chúng tôi không bảo đảm dữ liệu
          chính xác, đầy đủ hay kịp thời. Mọi nội dung trên hệ thống <b className="text-tx-1">không phải khuyến nghị đầu tư</b>.
        </p>
      </Block>
      <Block n={4} title="Hành vi bị cấm">
        <ul className="list-disc space-y-1 pl-5">
          <li>Tấn công, dò quét, làm quá tải hoặc truy cập trái phép hệ thống.</li>
          <li>Dùng công cụ tự động gửi lệnh vượt giới hạn tần suất cho phép.</li>
          <li>Tạo nhiều tài khoản để thao túng bảng xếp hạng hoặc chuyển vốn ảo giữa các tài khoản.</li>
          <li>Khai thác lỗi phần mềm để tăng vốn ảo — lỗi phát hiện được phải báo cho ban quản trị.</li>
          <li>Mạo danh người khác, đăng nội dung vi phạm pháp luật.</li>
        </ul>
      </Block>
      <Block n={5} title="Quyền của ban quản trị">
        <p>Để bảo đảm hệ thống hoạt động công bằng, ban quản trị có quyền:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Khoá tài khoản vi phạm điều khoản (các lệnh đang chờ sẽ bị huỷ).</li>
          <li>Huỷ lệnh bất thường, điều chỉnh hoặc đặt lại vốn ảo khi có sai sót, giải thưởng hay vi phạm.</li>
          <li>Tạm ngừng nhận lệnh toàn hệ thống hoặc theo mã để bảo trì, xử lý sự cố.</li>
        </ul>
        <p>Mọi thao tác quản trị đều được ghi vào nhật ký kèm thời điểm, người thực hiện và lý do.</p>
      </Block>
      <Block n={6} title="Giới hạn trách nhiệm">
        <p>
          Dịch vụ được cung cấp &quot;nguyên trạng&quot;. Chúng tôi không chịu trách nhiệm cho thiệt hại phát sinh từ việc dùng kết quả mô phỏng để ra quyết định đầu tư
          thật, hoặc từ việc hệ thống tạm ngừng, gián đoạn, mất dữ liệu mô phỏng.
        </p>
      </Block>
      <Block n={7} title="Thay đổi điều khoản">
        <p>Điều khoản có thể được cập nhật; thay đổi quan trọng sẽ được thông báo trên banner hệ thống. Tiếp tục sử dụng nghĩa là bạn đồng ý với bản cập nhật.</p>
      </Block>
    </>
  );
}

function Privacy() {
  return (
    <>
      <Block n={1} title="Chúng tôi thu thập dữ liệu gì">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <b className="text-tx-1">Khi đăng ký:</b> họ tên, email, mật khẩu. Mật khẩu chỉ được lưu ở dạng băm một chiều (bcrypt) — kể cả quản trị viên cũng không đọc
            được.
          </li>
          <li>
            <b className="text-tx-1">Khi sử dụng:</b> lệnh, kết quả khớp, danh mục, sao kê vốn ảo, danh sách theo dõi, thời điểm hoạt động gần nhất.
          </li>
          <li>
            <b className="text-tx-1">Nhật ký kỹ thuật:</b> địa chỉ IP, thời điểm, đường dẫn và kết quả request, phục vụ bảo mật và xử lý sự cố.
          </li>
          <li>
            <b className="text-tx-1">Trên trình duyệt của bạn:</b> phiên đăng nhập và tuỳ chọn giao diện (sáng / tối, khung biểu đồ) lưu trong localStorage. Không dùng cookie
            quảng cáo hay theo dõi.
          </li>
        </ul>
      </Block>
      <Block n={2} title="Dùng dữ liệu để làm gì">
        <ul className="list-disc space-y-1 pl-5">
          <li>Vận hành tài khoản, khớp lệnh, tính tài sản và lãi / lỗ mô phỏng.</li>
          <li>Gửi email đặt lại mật khẩu khi bạn yêu cầu.</li>
          <li>Bảo mật: giới hạn tần suất, phát hiện lạm dụng, điều tra sự cố.</li>
          <li>Thống kê tổng hợp (không định danh) để cải thiện dịch vụ.</li>
        </ul>
        <p>Chúng tôi không bán, không cho thuê dữ liệu cá nhân và không chia sẻ cho bên thứ ba, trừ khi có yêu cầu hợp pháp của cơ quan nhà nước có thẩm quyền.</p>
      </Block>
      <Block n={3} title="Lưu ở đâu, trong bao lâu">
        <p>
          Dữ liệu nằm trong cơ sở dữ liệu trên máy chủ của hệ thống và các bản sao lưu định kỳ. Dữ liệu tài khoản được giữ đến khi tài khoản bị xoá; nhật ký kỹ thuật được
          giữ theo chính sách xoay vòng log của máy chủ. Chỉ quản trị viên được cấp quyền mới truy cập được, và mọi thao tác của họ đều được ghi nhật ký.
        </p>
      </Block>
      <Block n={4} title="Quyền của bạn">
        <ul className="list-disc space-y-1 pl-5">
          <li>Xem và tải về lịch sử lệnh, khớp, sao kê của mình (trang Lịch sử → Xuất CSV).</li>
          <li>Đổi mật khẩu bất cứ lúc nào trong Cài đặt tài khoản.</li>
          <li>Yêu cầu xoá tài khoản và toàn bộ dữ liệu liên quan bằng cách liên hệ ban quản trị.</li>
          <li>Rút lại đồng ý xử lý dữ liệu — đồng nghĩa ngừng sử dụng dịch vụ và xoá tài khoản.</li>
        </ul>
      </Block>
      <Block n={5} title="Bảo vệ dữ liệu">
        <p>
          Kết nối được mã hoá HTTPS khi triển khai trên Internet, mật khẩu được băm, quyền quản trị được phân tách và ghi nhật ký, cơ sở dữ liệu được sao lưu định kỳ.
        </p>
      </Block>
    </>
  );
}

export default function LegalPage({ kind }: { kind: 'terms' | 'privacy' }) {
  const title = kind === 'terms' ? 'Điều khoản sử dụng' : 'Chính sách bảo mật dữ liệu';
  useEffect(() => {
    document.title = `${title} · VNStock`;
    window.scrollTo(0, 0);
  }, [title]);
  return (
    <div className="flex-1 overflow-y-auto">
      <article className="mx-auto max-w-3xl px-4 py-8">
        <div className="rounded-lg border border-ref/40 bg-ref/10 px-4 py-3 text-[13px] text-ref">
          Bản mẫu phục vụ demo. Trước khi đưa dịch vụ ra công chúng cần luật sư rà soát, điền thông tin đơn vị vận hành, kênh liên hệ và đối chiếu quy định hiện hành về
          bảo vệ dữ liệu cá nhân.
        </div>
        <h1 className="mt-6 text-[26px] font-extrabold tracking-tight">{title}</h1>
        <p className="mt-1 text-[13px] text-tx-3">Cập nhật lần cuối: {UPDATED}</p>
        {kind === 'terms' ? <Terms /> : <Privacy />}
        <div className="mt-8 flex gap-4 border-t border-line pt-4 text-[13px]">
          <Link to={kind === 'terms' ? '/chinh-sach-bao-mat' : '/dieu-khoan'} className="text-brand hover:underline">
            {kind === 'terms' ? 'Chính sách bảo mật dữ liệu →' : 'Điều khoản sử dụng →'}
          </Link>
          <Link to="/" className="text-tx-3 hover:text-tx-1">
            Về bảng giá
          </Link>
        </div>
      </article>
    </div>
  );
}
