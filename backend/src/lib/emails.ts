import { PASSWORD_RESET_TTL_MIN } from '@vss/shared';
import { config } from '../config';

/** Nội dung email: bản text (bắt buộc) + bản HTML */
export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

const BRAND = 'VNCoin';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const FOOTER = `${BRAND}: sàn giao dịch coin mô phỏng, dùng vốn ảo. Đây không phải khuyến nghị đầu tư.`;

/** Khung email chung: các đoạn văn + nút bấm (tuỳ chọn) */
function layout(subject: string, greet: string, paragraphs: string[], button?: { label: string; url: string }, note?: string): EmailContent {
  const text = [
    greet,
    '',
    ...paragraphs.flatMap((p) => [p, '']),
    ...(button ? [`${button.label}: ${button.url}`, ''] : []),
    ...(note ? [note, ''] : []),
    '--',
    FOOTER,
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#111;max-width:560px">
<p>${esc(greet)}</p>
${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('\n')}
${
  button
    ? `<p><a href="${esc(button.url)}" style="display:inline-block;padding:10px 18px;background:#f0b90b;color:#181a20;border-radius:8px;text-decoration:none;font-weight:bold">${esc(button.label)}</a></p>
<p style="color:#555">Nếu nút không bấm được, mở link: <br><span style="word-break:break-all">${esc(button.url)}</span></p>`
    : ''
}
${note ? `<p style="color:#666">${esc(note)}</p>` : ''}
<p style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:8px">${esc(FOOTER)}</p>
</div>`;
  return { subject, text, html };
}

const hello = (name: string) => `Chào ${name},`;

export function resetPasswordEmail(name: string, link: string): EmailContent {
  return layout(
    `Đặt lại mật khẩu ${BRAND}`,
    hello(name),
    [
      `Bạn (hoặc ai đó) vừa yêu cầu đặt lại mật khẩu tài khoản ${BRAND}.`,
      `Mở link sau trong ${PASSWORD_RESET_TTL_MIN} phút để đặt mật khẩu mới (link chỉ dùng được 1 lần).`,
    ],
    { label: 'Đặt mật khẩu mới', url: link },
    'Nếu bạn không yêu cầu, hãy bỏ qua email này. Mật khẩu của bạn không thay đổi.',
  );
}

export function verifyEmailEmail(name: string, link: string, ttlHours: number): EmailContent {
  return layout(
    `Xác thực email tài khoản ${BRAND}`,
    hello(name),
    [`Cảm ơn bạn đã mở tài khoản ${BRAND}. Hãy xác nhận đây là email của bạn để bảo vệ tài khoản và nhận được email đặt lại mật khẩu khi cần.`],
    { label: 'Xác thực email', url: link },
    `Link có hiệu lực trong ${ttlHours} giờ. Nếu bạn không đăng ký, hãy bỏ qua email này.`,
  );
}

export function passwordChangedEmail(name: string, how: 'change' | 'reset'): EmailContent {
  return layout(
    `Mật khẩu ${BRAND} vừa được thay đổi`,
    hello(name),
    [
      how === 'reset' ? 'Mật khẩu tài khoản của bạn vừa được đặt lại qua link quên mật khẩu.' : 'Mật khẩu tài khoản của bạn vừa được đổi.',
      'Mọi phiên đăng nhập cũ đã bị đăng xuất.',
    ],
    { label: 'Đăng nhập', url: `${config.publicUrl}/login` },
    'Nếu không phải bạn thực hiện, hãy dùng chức năng "Quên mật khẩu" ngay và liên hệ quản trị viên.',
  );
}

export function twoFactorChangedEmail(name: string, enabled: boolean, by: 'user' | 'admin' | 'recovery'): EmailContent {
  const what = enabled ? 'đã được BẬT' : 'đã bị TẮT';
  const who = by === 'admin' ? ' bởi quản trị viên' : by === 'recovery' ? ' sau khi dùng mã khôi phục' : '';
  return layout(
    `Xác thực 2 lớp ${enabled ? 'đã bật' : 'đã tắt'} (${BRAND})`,
    hello(name),
    [`Xác thực 2 lớp (2FA) cho tài khoản của bạn ${what}${who}.`],
    undefined,
    'Nếu không phải bạn thực hiện, hãy đổi mật khẩu ngay và liên hệ quản trị viên.',
  );
}

export function recoveryCodeUsedEmail(name: string, left: number): EmailContent {
  return layout(
    `Mã khôi phục 2FA vừa được sử dụng (${BRAND})`,
    hello(name),
    [`Một mã khôi phục 2FA vừa được dùng để đăng nhập. Bạn còn ${left} mã chưa dùng.`, 'Hãy tạo bộ mã mới trong Cài đặt tài khoản nếu sắp hết.'],
    undefined,
    'Nếu không phải bạn đăng nhập, hãy đổi mật khẩu ngay và liên hệ quản trị viên.',
  );
}

export function accountLockedEmail(name: string, locked: boolean, reason?: string): EmailContent {
  return layout(
    locked ? `Tài khoản ${BRAND} đã bị khoá` : `Tài khoản ${BRAND} đã được mở khoá`,
    hello(name),
    locked
      ? [
          'Tài khoản của bạn đã bị quản trị viên khoá. Các lệnh đang mở đã được huỷ.',
          ...(reason ? [`Lý do: ${reason}`] : []),
          'Vui lòng liên hệ quản trị viên nếu cần hỗ trợ.',
        ]
      : ['Tài khoản của bạn đã được mở khoá, bạn có thể đăng nhập và giao dịch bình thường.'],
    locked ? undefined : { label: 'Đăng nhập', url: `${config.publicUrl}/login` },
  );
}

export interface FillLine {
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: string;
  price: string;
  orderId: number;
}

export function fillDigestEmail(name: string, fills: FillLine[]): EmailContent {
  const lines = fills.map((f) => `• ${f.side === 'BUY' ? 'MUA' : 'BÁN'} ${f.qty} ${f.symbol} giá ${f.price} (lệnh #${f.orderId})`);
  return layout(
    `Thông báo khớp lệnh: ${fills.length} giao dịch (${BRAND})`,
    hello(name),
    ['Các lệnh sau của bạn vừa khớp:', ...lines],
    { label: 'Xem lịch sử giao dịch', url: `${config.publicUrl}/lich-su` },
    'Bạn nhận email này vì đã bật "Email thông báo khớp lệnh" trong Cài đặt tài khoản.',
  );
}

export function alertEmail(level: string, title: string, detail: string, resolved: boolean): EmailContent {
  return layout(
    `[${resolved ? 'ĐÃ XỬ LÝ' : level.toUpperCase()}] ${title} (${BRAND})`,
    'Gửi quản trị viên,',
    [resolved ? `Cảnh báo đã hết: ${title}.` : `Cảnh báo mới (${level}): ${title}.`, detail],
    { label: 'Mở trang Giám sát', url: `${config.publicUrl}/admin?tab=monitor` },
  );
}

export function priceAlertEmail(name: string, symbol: string, condition: string, detail: string): EmailContent {
  return layout(
    `Cảnh báo ${symbol}: ${condition} (${BRAND})`,
    hello(name),
    [`Cảnh báo bạn đặt cho cặp ${symbol} đã thoả điều kiện "${condition}".`, detail, 'Cảnh báo chỉ báo 1 lần; muốn theo dõi tiếp hãy tạo cảnh báo mới.'],
    { label: `Mở ${symbol}`, url: `${config.publicUrl}/trade/${symbol}` },
  );
}

export function loginBlockedEmail(name: string, fails: number, minutes: number, ip: string): EmailContent {
  return layout(
    `Cảnh báo: đăng nhập sai nhiều lần — ${BRAND}`,
    hello(name),
    [
      `Tài khoản của bạn vừa bị nhập sai mật khẩu ${fails} lần liên tiếp${ip ? ` (lần gần nhất từ địa chỉ IP ${ip})` : ''}.`,
      `Để bảo vệ tài khoản, hệ thống tạm chặn đăng nhập trong ${minutes} phút.`,
      'Nếu không phải bạn, hãy đổi mật khẩu ngay, bật xác thực 2 lớp và báo cho bộ phận chăm sóc khách hàng.',
    ],
    { label: 'Đặt lại mật khẩu', url: `${config.publicUrl}/forgot-password` },
  );
}

export function supportReplyEmail(name: string, ticketId: number, subject: string, preview: string): EmailContent {
  return layout(
    `Phản hồi yêu cầu hỗ trợ #${ticketId} — ${BRAND}`,
    hello(name),
    [`Bộ phận chăm sóc khách hàng vừa trả lời yêu cầu "${subject}":`, preview.length > 300 ? `${preview.slice(0, 300)}…` : preview],
    { label: 'Xem và trả lời', url: `${config.publicUrl}/ho-tro?ticket=${ticketId}` },
  );
}

export function supportResolvedEmail(name: string, ticketId: number, subject: string, resolution: string): EmailContent {
  return layout(
    `Yêu cầu hỗ trợ #${ticketId} đã được xử lý — ${BRAND}`,
    hello(name),
    [`Yêu cầu "${subject}" đã được xử lý.`, `Kết quả: ${resolution}`, 'Nếu chưa hài lòng, bạn có thể trả lời ngay trong yêu cầu để mở lại, hoặc đánh giá chất lượng hỗ trợ.'],
    { label: 'Xem yêu cầu', url: `${config.publicUrl}/ho-tro?ticket=${ticketId}` },
  );
}

const vnTime = (iso: string) => new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });

/** Báo người có thẩm quyền: có đề xuất thao tác lớn / điều chỉnh số dư cần duyệt */
export function approvalRequestEmail(
  name: string,
  a: { id: number; kindLabel: string; summary: string; reason: string; requestedBy: string; expiresAt?: string | null },
): EmailContent {
  return layout(
    `Cần duyệt: ${a.kindLabel} #${a.id} — ${BRAND}`,
    hello(name),
    [
      `${a.requestedBy} vừa đề xuất "${a.kindLabel}" và cần một người có thẩm quyền KHÁC duyệt thì mới được thực hiện.`,
      `Nội dung: ${a.summary}`,
      `Lý do: ${a.reason}`,
      ...(a.expiresAt ? [`Hạn duyệt: ${vnTime(a.expiresAt)} (giờ Việt Nam) — quá hạn phải đề xuất lại.`] : []),
    ],
    { label: 'Mở hàng chờ duyệt', url: `${config.publicUrl}/admin?tab=approvals` },
    'Chỉ duyệt khi đã kiểm tra kỹ. Thấy bất thường (không rõ lý do, người đề xuất lạ, giao dịch đáng ngờ trước đó) thì từ chối và báo Rủi ro & giám sát.',
  );
}

/** Báo khi vai trò nhân viên thay đổi: cho chính người được đổi và các Quản trị hệ thống khác */
export function roleChangedEmail(
  name: string,
  a: { email: string; from: string; to: string; by: string; requestedBy?: string | null; self: boolean; bootstrap?: boolean },
): EmailContent {
  const who = a.requestedBy ? `đề xuất bởi ${a.requestedBy}, duyệt bởi ${a.by}` : `thực hiện bởi ${a.by}`;
  return layout(
    `${a.self ? 'Vai trò tài khoản của bạn' : `Vai trò của ${a.email}`} đã thay đổi — ${BRAND}`,
    hello(name),
    [
      `${a.self ? 'Tài khoản của bạn' : `Tài khoản ${a.email}`} vừa được đổi vai trò: ${a.from} → ${a.to} (${who}).`,
      ...(a.bootstrap ? ['Thay đổi có hiệu lực ngay vì hệ thống đang chỉ có 1 Quản trị hệ thống — nên tạo thêm Quản trị hệ thống thứ hai.'] : []),
      a.self
        ? 'Nếu bạn không biết về thay đổi này, hãy báo ngay cho Quản trị hệ thống.'
        : 'Nếu thay đổi này không đúng kế hoạch, hãy thu quyền và kiểm tra nhật ký quản trị ngay.',
    ],
    { label: 'Xem nhật ký quản trị', url: `${config.publicUrl}/admin?tab=logs` },
  );
}

/** Báo người có thể xác nhận: có người vừa dừng khẩn toàn sàn */
export function emergencyHaltEmail(name: string, e: { by: string; reason: string; expiresAt: string }): EmailContent {
  return layout(
    `KHẨN: sàn vừa bị dừng khẩn, cần xác nhận — ${BRAND}`,
    hello(name),
    [
      `${e.by} vừa dừng khẩn toàn sàn. Lý do: ${e.reason}.`,
      `Nếu không có người thứ hai xác nhận, sàn sẽ tự mở lại lúc ${vnTime(e.expiresAt)} (giờ Việt Nam).`,
      'Kiểm tra sự cố: đúng là cần dừng thì bấm "Xác nhận dừng"; báo động nhầm thì bấm "Huỷ dừng khẩn".',
    ],
    { label: 'Mở trang vận hành thị trường', url: `${config.publicUrl}/admin?tab=market` },
  );
}

/** Báo Tài chính / Kiểm toán: đối soát phát hiện lệch số dư */
export function reconIssuesEmail(name: string, run: { id: number; issueCount: number; balancesChecked: number; startedAt: string }): EmailContent {
  return layout(
    `Đối soát #${run.id} phát hiện ${run.issueCount} chỗ lệch — ${BRAND}`,
    hello(name),
    [
      `Lần đối soát lúc ${vnTime(run.startedAt)} (giờ Việt Nam) kiểm tra ${run.balancesChecked} số dư và phát hiện ${run.issueCount} chỗ lệch giữa số dư, sổ cái và khớp lệnh.`,
      'Lệch nghĩa là có khoản tiền được cộng / trừ mà không ghi sổ (lỗi bộ khớp lệnh hoặc sửa trực tiếp CSDL). Kiểm tra ngay, đối chiếu nhật ký quản trị trước khi điều chỉnh.',
    ],
    { label: 'Xem kết quả đối soát', url: `${config.publicUrl}/admin?tab=finance` },
  );
}

export function kycResultEmail(name: string, level: 1 | 2, approved: boolean, reason?: string): EmailContent {
  const what = level === 1 ? 'xác minh danh tính (cấp 1)' : 'xác minh nâng cao (cấp 2)';
  return layout(
    approved ? `Hồ sơ ${what} đã được duyệt` : `Hồ sơ ${what} chưa được duyệt`,
    hello(name),
    approved
      ? [`Hồ sơ ${what} của bạn đã được duyệt. Hạn mức giao dịch P2P của bạn đã tăng theo cấp mới.`]
      : [`Hồ sơ ${what} của bạn chưa được duyệt.`, ...(reason ? [`Lý do: ${reason}`] : []), 'Bạn có thể sửa thông tin và nộp lại.'],
    { label: 'Xem trạng thái xác minh', url: `${config.publicUrl}/xac-minh` },
  );
}

export function privacyResultEmail(name: string, approved: boolean, note?: string): EmailContent {
  return layout(
    approved ? `Tài khoản ${BRAND} của bạn đã được xoá` : `Yêu cầu xoá tài khoản ${BRAND} chưa được xử lý`,
    hello(name),
    approved
      ? [
          'Theo yêu cầu của bạn, thông tin cá nhân (email, họ tên, hồ sơ xác minh) đã được ẩn danh và tài khoản không còn đăng nhập được.',
          'Dữ liệu giao dịch được giữ lại ở dạng ẩn danh theo nghĩa vụ lưu trữ (đối soát, phòng chống rửa tiền).',
        ]
      : ['Yêu cầu xoá tài khoản của bạn chưa được chấp thuận.', ...(note ? [`Lý do: ${note}`] : []), 'Liên hệ CSKH nếu cần hỗ trợ thêm.'],
  );
}
