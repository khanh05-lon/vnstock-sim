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
