# Cộng đồng và kiểm duyệt nội dung

Cộng đồng VNCoin (`/cong-dong`) làm theo **Binance Square**: nhà đầu tư đăng nhận định gắn coin, chia sẻ lệnh đã khớp, bình luận, theo dõi nhau. Vì là mạng xã hội trong một sàn coin nên đi kèm **Tiêu chuẩn cộng đồng** và kiểm duyệt 3 lớp, giống yêu cầu với mạng xã hội ở Việt Nam (Luật An ninh mạng 2018, Nghị định 147/2024: gỡ nội dung vi phạm, lưu vết xử lý).

## 1. Tính năng cho khách

| Mục | Mô tả |
|---|---|
| Hồ sơ | Bắt buộc trước khi đăng: `@handle` 3–20 ký tự (`a-z 0-9 _`), tên hiển thị, giới thiệu ≤ 160 ký tự; phải đồng ý Tiêu chuẩn cộng đồng. Tách khỏi tài khoản: không lộ email, họ tên thật. |
| Bài viết | ≤ 2.000 ký tự, chữ thuần. `$BTC` thành thẻ coin (chỉ coin đang niêm yết, ≤ 5) có giá + % 24h trực tiếp; `#chủ_đề` (≤ 5); nhãn **Tăng / Giảm** tuỳ chọn. Không sửa được (tránh sửa thành lừa đảo sau khi được duyệt), xoá được. |
| Chia sẻ dữ liệu thật | Đính kèm 1 lệnh đã khớp của chính mình (cặp, mua / bán, giá khớp TB, giá lúc chia sẻ, % lãi lỗ — không lộ khối lượng / số dư) hoặc ROI tài khoản. Máy chủ dựng số liệu lúc đăng, có nhãn "Xác minh từ dữ liệu VNCoin". |
| Tương tác | Bình luận ≤ 500 ký tự (trả lời 1 cấp), thích, theo dõi. |
| Bảng tin | **Dành cho bạn** (điểm = (thích × 2 + bình luận × 3 + 1) / (giờ + 2)^1,5, bài 7 ngày), **Mới nhất**, **Đang theo dõi**; lọc `?coin=BTC`, `?tag=dca`. Cột phải: coin được bàn nhiều 24h (tỷ lệ Tăng / Giảm), gợi ý theo dõi. |
| Thông báo | Thích, bình luận, trả lời, theo dõi, quyết định kiểm duyệt (realtime `square`). Quyết định kiểm duyệt có thêm email. |
| Báo cáo | Bài, bình luận, hồ sơ: Spam, Lừa đảo, Lộ thông tin cá nhân, Xúc phạm, Tục tĩu, Thao túng giá, Mạo danh, Khác. Giữ kín với người bị báo cáo. |
| Khiếu nại | Mỗi nội dung bị gỡ được khiếu nại 1 lần. |
| Trang giao dịch | Chip "Cộng đồng BTC · x% Tăng" dẫn sang bảng tin của coin. |

**Điều kiện đăng / bình luận**: khách (nhân viên chỉ đọc — tránh mạo danh, xung đột lợi ích), email đã xác thực, tài khoản tạo đủ 24 giờ, có hồ sơ, không bị cấm. Thích / theo dõi không cần đủ 24 giờ và vẫn làm được khi đang bị cấm đăng. Giới hạn: 5 bài / giờ, 20 bài / ngày, 30 bình luận / giờ, 20 báo cáo / ngày.

## 2. Kiểm duyệt 3 lớp

### Lớp 1 — bộ lọc tự động (`shared/src/squareModeration.ts`)

Dùng chung: trình duyệt chạy khi đang gõ để cảnh báo trước, máy chủ chạy lại khi gửi (thêm từ quản trị đã khai báo).

Chuẩn hoá trước khi so: chữ thường, bỏ dấu, đổi leetspeak (`d1t`, `l0z`), gộp chữ bị chèn dấu chấm / cách (`đ.m`, `o c c h o`), rút gọn chữ lặp. Từ dễ trùng nghĩa khi bỏ dấu (lồn / lớn, cặc / các, đĩ / đi, đánh đề / dành để, bố mày / bộ máy) chỉ so bản **còn dấu**.

| Quy tắc | Phát hiện | Xử lý |
|---|---|---|
| Ngôn từ tục tĩu | Từ tục tiếng Việt, teencode (`dm`, `vcl`, `clgt`, `loz`…), tiếng Anh | Chặn |
| Xúc phạm, quấy rối | "óc chó", "súc vật", "mẹ mày"… | Chặn |
| Lộ thông tin cá nhân / ví | SĐT VN, email, số tài khoản (dãy 8–19 số cạnh từ khoá ngân hàng / stk / momo), CCCD 12 số, địa chỉ ví, khoá bí mật 64 hex, seed phrase (từ khoá + ≥ 12 từ) | Chặn |
| Liên kết ngoài | URL / tên miền ngoài danh sách cho phép; link mời Telegram / Zalo / Discord, rút gọn link luôn chặn | Chặn |
| Người lớn, cờ bạc, chất cấm | | Chặn |
| Lừa đảo | Rủ nhắn riêng, nhóm kín, Zalo / Telegram, giao dịch ngoài sàn, uỷ thác | Giữ chờ duyệt |
| Thao túng giá | Hô hào cùng mua / kéo giá, "chắc chắn lên", "lãi 10%/ngày" | Giữ chờ duyệt |
| Mạo danh | Xưng admin / nhân viên / CSKH VNCoin (với @handle / tên hiển thị thì chặn) | Giữ chờ duyệt |
| Chính trị, tôn giáo | Nhiều tin hợp lệ (vd. chính phủ duyệt ETF) nên để người duyệt quyết | Giữ chờ duyệt |
| Spam | Viết hoa > 70%, ký tự lặp, > 5 thẻ, trùng bài trong 24 giờ | Giữ chờ duyệt |

- Bị chặn → lỗi `CONTENT_BLOCKED` kèm nhãn quy tắc (không nhắc lại từ vi phạm). Bị chặn 5 lần / giờ → tạm khoá đăng 60 phút (không tính vi phạm).
- Thêm từ vào từ điển gốc thì **thêm câu bình thường tương ứng vào `backend/test/square-moderation.test.ts`** (danh sách "câu bình thường phải qua") để không chặn nhầm.

### Lớp 2 — giữ chờ duyệt

Nội dung `PENDING` chỉ tác giả thấy (nhãn "Đang chờ kiểm duyệt" + lý do), vào hàng chờ của kiểm duyệt viên.

### Lớp 3 — báo cáo

Nội dung bị ≥ 3 người khác nhau báo cáo (chỉ tính tài khoản tạo ≥ 7 ngày) → tự ẩn về `PENDING` chờ xem xét.

## 3. Thang phạt

Kiểm duyệt viên gỡ nội dung có tick "Tính 1 vi phạm" → `square_strikes`, hiệu lực 90 ngày:

| Vi phạm còn hiệu lực | Hậu quả |
|---|---|
| 1 | Cảnh cáo |
| 2 | Cấm đăng 24 giờ |
| 3 | Cấm đăng 7 ngày |
| 4 trở đi | Cấm đăng 30 ngày; từ 5 thì gắn cờ "Đề xuất cấm vĩnh viễn" |

- Cấm đăng: vẫn đọc, thích, theo dõi, giao dịch; không đăng / bình luận.
- Kiểm duyệt viên cấm tay tối đa 30 ngày. **Cấm vĩnh viễn** (`SQUARE_BAN`) và **gỡ cấm khi còn ≥ 7 ngày hoặc vĩnh viễn** (`SQUARE_UNBAN`) là đề xuất, kiểm duyệt viên khác duyệt ở Hàng chờ duyệt.
- Tên / hồ sơ phản cảm, mạo danh → **Đặt lại tên** thành `user_xxxxxx` + 1 vi phạm.
- **Khiếu nại**: kiểm duyệt viên khác người đã gỡ xử lý. Chấp nhận → nội dung hiện lại, vi phạm bị thu hồi, cấm tự động (theo thang) được gỡ nếu không còn đủ vi phạm. Từ chối → ghi chú gửi khách.

Mọi tham số trên (giới hạn, ngưỡng tự ẩn, thang phạt, từ chặn / giữ lại thêm, tên miền cho phép) chỉnh ở Quản trị → Kiểm duyệt cộng đồng → Quy tắc lọc, lưu `market_meta` key `admin.squareRules`.

## 4. Vai trò Kiểm duyệt nội dung (`CONTENT_MOD`)

- Quyền `admin.view`, `square.moderate`. **Không** có `users.view`: chỉ thấy hồ sơ cộng đồng công khai (handle, nội dung, lịch sử vi phạm), không thấy email / số dư (tối thiểu dữ liệu).
- Khu làm việc: Quản trị → **Kiểm duyệt cộng đồng** (Chờ duyệt · Báo cáo · Khiếu nại · Người dùng · Quy tắc lọc).
- Tài khoản thử (dev): `mod@`, `mod2@`. Bài mẫu do các thương nhân mẫu đăng (`backend/src/square/seed.ts`).
- Nhật ký quản trị: `SQUARE_APPROVE`, `SQUARE_REMOVE`, `SQUARE_RESTORE`, `SQUARE_REPORT_DISMISS`, `SQUARE_APPEAL_ACCEPT`, `SQUARE_APPEAL_REJECT`, `SQUARE_BAN`, `SQUARE_UNBAN`, `SQUARE_HANDLE_RESET`, `SQUARE_RULES_SET`, `SQUARE_RULES_RESET`.

## 5. Dữ liệu

- Migration `290_square.sql`: `square_profiles`, `square_posts`, `square_comments`, `square_likes`, `square_follows`, `square_reports`, `square_strikes`, `square_notifications`; vai trò `CONTENT_MOD`; đề xuất `SQUARE_BAN`, `SQUARE_UNBAN`. Cả 8 bảng nằm trong sao lưu.
- Bản tải dữ liệu cá nhân có phần `community` (hồ sơ, bài, bình luận, đang theo dõi, đã thích, báo cáo đã gửi, vi phạm).
- Xoá tài khoản (DPO) xoá hồ sơ cộng đồng, đặt bài / bình luận `DELETED` và xoá nội dung, bỏ thích / theo dõi / thông báo.

## 6. API

| Phương thức | Đường dẫn | Ghi chú |
|---|---|---|
| GET | `/api/square/config` · `/square/feed?tab=&coin=&tag=&author=&before=` · `/square/trends` · `/square/suggestions` · `/square/posts/:id[/comments]` · `/square/users/:handle` | Công khai (có đăng nhập thì biết đã thích / theo dõi) |
| GET/PUT | `/api/square/me` | Tình trạng (được đăng không, vi phạm, cấm), tạo / sửa hồ sơ |
| POST/DELETE | `/api/square/posts[/:id]` · `/square/posts/:id/like` · `/square/posts/:id/comments` · `/square/comments/:id` · `/square/users/:handle/follow` | |
| POST | `/api/square/reports` · `/square/(posts\|comments)/:id/appeal` · `/square/notifications/read` | |
| * | `/api/admin/square/*` | Hàng chờ, duyệt / gỡ / khôi phục, khiếu nại, người dùng, cấm, quy tắc (`square.moderate`) |

## 7. Chưa làm

Ảnh / video, AI kiểm duyệt, @nhắc tên, phát trực tiếp, thưởng cho người viết (Write to Earn), tài khoản chính thức của sàn đăng bài, tin nhắn riêng giữa người dùng.
