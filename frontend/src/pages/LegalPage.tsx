import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CONDITIONAL_MAX_DAYS, EMAIL_VERIFY_TTL_HOURS, GTD_MAX_DAYS, PASSWORD_RESET_TTL_MIN, RULES } from '@vss/shared';
import { fmtInt } from '../lib/format';

const UPDATED = '16/10/2026';

/** Tỷ lệ → "%" kiểu Việt Nam (0,04%); lấy từ RULES đang hiệu lực nên khớp tham số quản trị đặt */
const pct = (v: number, digits = 2) => `${(v * 100).toLocaleString('vi-VN', { maximumFractionDigits: digits })}%`;

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
  const m = RULES.margin;
  return (
    <>
      <Block n={1} title="Dịch vụ là gì">
        <p>
          VNStock Sim là <b className="text-tx-1">sàn giao dịch chứng khoán mô phỏng</b> phục vụ học tập. Mỗi tài khoản được cấp {fmtInt(RULES.initialCapital)}đ vốn ảo. Vốn ảo,
          chứng khoán ảo, khoản vay ký quỹ ảo và lãi / lỗ trên hệ thống <b className="text-tx-1">không có giá trị quy đổi</b> ra tiền thật hay tài sản thật.
        </p>
        <p>
          VNStock Sim không phải công ty chứng khoán, không nhận tiền của nhà đầu tư, không cho vay tiền thật và không chuyển lệnh tới Sở Giao dịch Chứng khoán. Muốn giao
          dịch thật, bạn phải mở tài khoản tại một công ty chứng khoán được Uỷ ban Chứng khoán Nhà nước cấp phép.
        </p>
      </Block>
      <Block n={2} title="Tài khoản và bảo mật">
        <ul className="list-disc space-y-1 pl-5">
          <li>Thông tin đăng ký phải chính xác; mỗi người dùng một tài khoản. Hệ thống có thể yêu cầu xác thực email trước khi cho đặt lệnh.</li>
          <li>Bạn tự bảo mật mật khẩu, ứng dụng xác thực 2 lớp (2FA) và mã khôi phục, đồng thời chịu trách nhiệm về mọi thao tác thực hiện bằng tài khoản của mình.</li>
          <li>Mất cả thiết bị 2FA lẫn mã khôi phục: ban quản trị chỉ tắt 2FA sau khi xác minh bạn là chủ tài khoản qua email đã đăng ký.</li>
          <li>Phát hiện tài khoản bị sử dụng trái phép, hãy đổi mật khẩu (mọi phiên đăng nhập khác sẽ bị đăng xuất) và báo ngay cho ban quản trị.</li>
        </ul>
      </Block>
      <Block n={3} title="Dữ liệu giá và thông tin thị trường">
        <p>
          Giá, chỉ số, sự kiện quyền và số liệu của cổ phiếu, chứng chỉ quỹ ETF, chứng quyền, trái phiếu là dữ liệu giả lập, hoặc dữ liệu thị trường có độ trễ khi hệ thống
          dùng nguồn giá thật. Chúng tôi không bảo đảm dữ liệu chính xác, đầy đủ hay kịp thời. Mọi nội dung trên hệ thống — kể cả bảng xếp hạng —{' '}
          <b className="text-tx-1">không phải khuyến nghị đầu tư</b>.
        </p>
      </Block>
      <Block n={4} title="Lệnh, lệnh điều kiện và lệnh nhiều ngày">
        <ul className="list-disc space-y-1 pl-5">
          <li>Lệnh được khớp theo quy tắc mô phỏng (bước giá, biên độ, lô, phiên) gần giống sàn thật nhưng không giống hoàn toàn; kết quả khớp có thể khác thị trường thật.</li>
          <li>
            Lệnh điều kiện (cắt lỗ, chốt lời, OCO, xu hướng) chỉ là yêu cầu hệ thống <b className="text-tx-1">tự đặt lệnh khi giá chạm ngưỡng</b>. Hệ thống không bảo đảm
            lệnh được kích hoạt hay khớp đúng giá ngưỡng — giá có thể vượt qua ngưỡng, lệnh sinh ra có thể bị từ chối do thiếu tiền, ngoài phiên hoặc mã bị tạm ngừng.
          </li>
          <li>
            Lệnh nhiều ngày (tối đa {GTD_MAX_DAYS} ngày) và lệnh điều kiện (tối đa {CONDITIONAL_MAX_DAYS} ngày) bị huỷ khi hết hạn, khi giá vượt biên độ ngày mới, khi mã có
            sự kiện quyền điều chỉnh giá hoặc bị huỷ niêm yết.
          </li>
        </ul>
      </Block>
      <Block n={5} title="Ứng trước tiền bán và giao dịch ký quỹ mô phỏng">
        <p>
          Tiền bán chứng khoán về tài khoản sau T+2. Ứng trước tiền bán tính phí {pct(RULES.advanceFeeRateDaily, 3)}/ngày trên số tiền ứng. Ký quỹ (margin) là khoản vay ảo
          với lãi {pct(m.interestRateYear)}/năm, chỉ áp dụng cho mã được phép ký quỹ và trong hạn mức do ban quản trị cấp; bạn phải chủ động bật và xác nhận đã hiểu rủi ro.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Tỷ lệ ký quỹ = (giá trị chứng khoán − nợ ròng) / giá trị chứng khoán. Dưới {pct(m.callRatio, 0)} hệ thống <b className="text-tx-1">gọi ký quỹ</b>; dưới{' '}
            {pct(m.forceRatio, 0)} hệ thống <b className="text-tx-1">tự huỷ lệnh mua và bán giải chấp</b> mà không cần bạn đồng ý, kể cả ở giá bất lợi.
          </li>
          <li>Đòn bẩy làm khoản lỗ lớn hơn so với chỉ dùng vốn tự có; bạn có thể mất toàn bộ vốn ảo. Hãy tìm hiểu kỹ trước khi dùng ký quỹ trên tài khoản thật.</li>
          <li>Tiền về tài khoản được tự động dùng trả lãi vay trước, rồi trả gốc.</li>
        </ul>
      </Block>
      <Block n={6} title="Sự kiện quyền, chứng quyền, trái phiếu">
        <p>
          Cổ tức, chia tách, phát hành thêm, quyền mua, đáo hạn chứng quyền và trả lãi / gốc trái phiếu được mô phỏng theo dữ liệu do ban quản trị nhập. Cổ tức tiền và lãi
          trái phiếu được khấu trừ thuế {pct(RULES.dividendTaxRate, 0)}. Chứng quyền đáo hạn được thanh toán bằng tiền theo giá đóng cửa bình quân 5 phiên của chứng khoán
          cơ sở; chứng quyền không có lãi sẽ mất toàn bộ giá trị. Tiền nhàn rỗi được tính lãi {pct(RULES.depositRateYear)}/năm, trả vào ngày giao dịch đầu tháng.
        </p>
      </Block>
      <Block n={7} title="Bảng xếp hạng">
        <p>
          Tài khoản tham gia bảng xếp hạng theo mặc định, hiển thị bằng tên hiển thị bạn chọn hoặc họ tên đã che bớt. Bạn có thể rút khỏi bảng xếp hạng bất cứ lúc nào trong
          Cài đặt tài khoản. Ban quản trị có quyền loại khỏi bảng xếp hạng tài khoản có dấu hiệu gian lận; giải thưởng (nếu có) theo thể lệ riêng của từng cuộc thi.
        </p>
      </Block>
      <Block n={8} title="Hành vi bị cấm">
        <ul className="list-disc space-y-1 pl-5">
          <li>Tấn công, dò quét, làm quá tải hoặc truy cập trái phép hệ thống.</li>
          <li>Dùng công cụ tự động gửi lệnh vượt giới hạn tần suất cho phép.</li>
          <li>Tạo nhiều tài khoản để thao túng bảng xếp hạng hoặc chuyển vốn ảo giữa các tài khoản.</li>
          <li>Khai thác lỗi phần mềm để tăng vốn ảo — lỗi phát hiện được phải báo cho ban quản trị.</li>
          <li>Mạo danh người khác, đặt tên hiển thị hoặc đăng nội dung vi phạm pháp luật.</li>
        </ul>
      </Block>
      <Block n={9} title="Quyền của ban quản trị">
        <p>Để bảo đảm hệ thống hoạt động công bằng, ban quản trị có quyền:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Khoá tài khoản vi phạm điều khoản (các lệnh đang chờ sẽ bị huỷ).</li>
          <li>Huỷ lệnh bất thường, điều chỉnh hoặc đặt lại vốn ảo khi có sai sót, giải thưởng hay vi phạm.</li>
          <li>Thay đổi tham số giao dịch (phí, thuế, biên độ, tỷ lệ ký quỹ, hạn mức vay), niêm yết / huỷ niêm yết mã, nhập sự kiện quyền.</li>
          <li>
            Tạm ngừng nhận lệnh toàn hệ thống hoặc theo mã, và khôi phục dữ liệu từ bản sao lưu khi có sự cố — dữ liệu phát sinh sau thời điểm sao lưu có thể bị mất.
          </li>
        </ul>
        <p>Mọi thao tác quản trị đều được ghi vào nhật ký kèm thời điểm, người thực hiện và lý do.</p>
      </Block>
      <Block n={10} title="Giới hạn trách nhiệm">
        <p>
          Dịch vụ được cung cấp &quot;nguyên trạng&quot;. Chúng tôi không chịu trách nhiệm cho thiệt hại phát sinh từ việc dùng kết quả mô phỏng để ra quyết định đầu tư
          thật, hoặc từ việc hệ thống tạm ngừng, gián đoạn, gửi email chậm / thất bại, mất dữ liệu mô phỏng.
        </p>
      </Block>
      <Block n={11} title="Thay đổi điều khoản">
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
            <b className="text-tx-1">Bảo mật tài khoản:</b> trạng thái xác thực email; khoá bí mật 2FA được <b className="text-tx-1">mã hoá</b> (AES-256-GCM) trước khi lưu;
            mã khôi phục và token trong link email chỉ lưu ở dạng băm, token hết hạn sau thời gian ngắn.
          </li>
          <li>
            <b className="text-tx-1">Khi sử dụng:</b> lệnh, lệnh điều kiện, kết quả khớp, danh mục, sao kê vốn ảo, khoản vay ký quỹ ảo, quyền nhận cổ tức, lịch sử tài sản
            theo ngày, danh sách theo dõi, tuỳ chọn thông báo và bảng xếp hạng, thời điểm hoạt động gần nhất.
          </li>
          <li>
            <b className="text-tx-1">Nhật ký kỹ thuật:</b> địa chỉ IP, thời điểm, đường dẫn và kết quả request, phục vụ bảo mật và xử lý sự cố. Số liệu giám sát hệ thống
            (thời gian phản hồi, tỷ lệ lỗi, bộ nhớ) chỉ ở dạng tổng hợp, không gắn với người dùng.
          </li>
          <li>
            <b className="text-tx-1">Trên trình duyệt của bạn:</b> phiên đăng nhập và tuỳ chọn giao diện (sáng / tối, khung biểu đồ) lưu trong localStorage. Không dùng cookie
            quảng cáo hay theo dõi.
          </li>
        </ul>
      </Block>
      <Block n={2} title="Dùng dữ liệu để làm gì">
        <ul className="list-disc space-y-1 pl-5">
          <li>Vận hành tài khoản, khớp lệnh, tính tài sản, lãi / lỗ, ký quỹ và sự kiện quyền mô phỏng.</li>
          <li>
            Gửi email: xác thực địa chỉ, đặt lại mật khẩu, cảnh báo bảo mật (đổi mật khẩu, bật / tắt 2FA, dùng mã khôi phục, khoá tài khoản), gọi ký quỹ và bán giải chấp.
            Email tổng hợp lệnh khớp <b className="text-tx-1">chỉ gửi khi bạn bật</b> trong Cài đặt.
          </li>
          <li>
            Bảng xếp hạng công khai: <b className="text-tx-1">tên hiển thị</b> bạn chọn (hoặc họ tên đã che bớt) và tỷ suất lợi nhuận. Email, số dư và danh mục không bao giờ
            được công khai. Bạn có thể rút khỏi bảng xếp hạng trong Cài đặt.
          </li>
          <li>Bảo mật: giới hạn tần suất, phát hiện lạm dụng, điều tra sự cố.</li>
          <li>Thống kê tổng hợp (không định danh) để cải thiện dịch vụ.</li>
        </ul>
        <p>
          Chúng tôi không bán, không cho thuê dữ liệu cá nhân. Bên xử lý dữ liệu thay chúng tôi chỉ gồm nhà cung cấp máy chủ và dịch vụ gửi email (nếu được cấu hình). Cảnh
          báo vận hành gửi cho quản trị viên không chứa dữ liệu cá nhân. Ngoài ra chúng tôi chỉ cung cấp dữ liệu khi có yêu cầu hợp pháp của cơ quan nhà nước có thẩm quyền.
        </p>
      </Block>
      <Block n={3} title="Lưu ở đâu, trong bao lâu">
        <ul className="list-disc space-y-1 pl-5">
          <li>Dữ liệu tài khoản và giao dịch mô phỏng: giữ đến khi tài khoản bị xoá.</li>
          <li>
            Link xác thực email hết hạn sau {EMAIL_VERIFY_TTL_HOURS} giờ; link đặt lại mật khẩu hết hạn sau {PASSWORD_RESET_TTL_MIN} phút; link đã dùng là hết hiệu lực.
          </li>
          <li>
            Bản sao lưu cơ sở dữ liệu: giữ theo chu kỳ xoay vòng của đơn vị vận hành (đề xuất 30 ngày); dữ liệu đã xoá có thể còn trong bản sao lưu cho tới khi bản đó hết
            hạn.
          </li>
          <li>Nhật ký kỹ thuật: theo chính sách xoay vòng log của máy chủ; nhật ký thao tác quản trị: giữ lâu dài để phục vụ kiểm tra.</li>
        </ul>
        <p>Chỉ quản trị viên được cấp quyền mới truy cập được dữ liệu, và mọi thao tác của họ đều được ghi nhật ký.</p>
      </Block>
      <Block n={4} title="Quyền của bạn">
        <ul className="list-disc space-y-1 pl-5">
          <li>Xem và tải về lịch sử lệnh, khớp, sao kê của mình (trang Lịch sử → Xuất CSV).</li>
          <li>Đổi mật khẩu, bật / tắt 2FA, bật / tắt email thông báo, đổi tên hiển thị và rút khỏi bảng xếp hạng bất cứ lúc nào trong Cài đặt tài khoản.</li>
          <li>Yêu cầu chỉnh sửa, xoá tài khoản và toàn bộ dữ liệu liên quan bằng cách liên hệ ban quản trị.</li>
          <li>Rút lại đồng ý xử lý dữ liệu — đồng nghĩa ngừng sử dụng dịch vụ và xoá tài khoản.</li>
        </ul>
      </Block>
      <Block n={5} title="Bảo vệ dữ liệu">
        <p>
          Kết nối được mã hoá HTTPS khi triển khai trên Internet; mật khẩu và mã khôi phục được băm; khoá 2FA được mã hoá; hỗ trợ xác thực 2 lớp; quyền quản trị được phân
          tách và ghi nhật ký; cơ sở dữ liệu được sao lưu định kỳ; hệ thống được giám sát và tự cảnh báo sự cố. Khi xảy ra sự cố lộ lọt dữ liệu, chúng tôi sẽ thông báo cho
          người dùng bị ảnh hưởng và cơ quan có thẩm quyền theo quy định.
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
          Bản mẫu phục vụ demo. Trước khi đưa dịch vụ ra công chúng cần luật sư rà soát, điền thông tin đơn vị vận hành, kênh liên hệ, thời hạn lưu trữ cụ thể; đối chiếu
          quy định hiện hành về bảo vệ dữ liệu cá nhân, giao dịch điện tử, quảng cáo; xin ý kiến chuyên môn nếu tổ chức cuộc thi có giải thưởng.
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
