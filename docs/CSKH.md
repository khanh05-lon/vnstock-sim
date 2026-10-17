# Chăm sóc khách hàng và truy vết trách nhiệm

Hướng dẫn cho đội vận hành VNCoin: cách nhận và xử lý yêu cầu hỗ trợ, ai được làm gì, và tra dấu vết khi có sự cố.

## 1. Vai trò

| Vai trò | Được làm | Không được làm |
| --- | --- | --- |
| Nhà đầu tư | Gửi yêu cầu hỗ trợ (gắn lệnh liên quan), trao đổi, đánh giá; xem nhật ký lệnh và lịch sử đăng nhập của mình | — |
| Nhân viên CSKH | Khu `/cskh`: nhận và trả lời yêu cầu, ghi chú nội bộ, xem hồ sơ khách **qua yêu cầu**, huỷ hộ lệnh, khoá khẩn tài khoản, đề xuất bồi hoàn | Vào khu quản trị, mở khoá tài khoản, tự cộng / trừ số dư, duyệt bồi hoàn |
| Quản trị hệ thống | Phân quyền nhân viên, tài khoản người dùng (tạo, khoá, xác thực email, tắt 2FA, xoá), sao lưu / đề xuất khôi phục, giám sát, nhật ký; khu CSKH + giao việc | Chỉnh số dư, chỉnh giá, niêm yết, huỷ hộ lệnh; tự duyệt đề xuất của mình |
| Vận hành thị trường | Cặp giao dịch, giá, biểu phí, thông báo, tạm ngừng cặp, huỷ hộ lệnh; đề xuất niêm yết / huỷ niêm yết / chỉnh giá lớn / tạm ngừng toàn sàn; duyệt đề xuất thị trường của người khác | Xem hồ sơ người dùng, chạm vào số dư |
| Tài chính | Điều chỉnh / đặt lại số dư (lớn thì thành đề xuất), duyệt bồi hoàn của CSKH và điều chỉnh của người khác | Thay đổi thị trường, khoá tài khoản |
| Rủi ro & giám sát | Khoá / mở khoá, huỷ hộ lệnh, tạm ngừng cặp, xem nhật ký, khu CSKH; duyệt đề xuất thị trường của người khác | Chạm vào số dư, tự thay đổi cấu hình thị trường |
| Kiểm toán | Chỉ đọc: tổng quan, người dùng, lệnh, hàng chờ duyệt, nhật ký, giám sát | Mọi thao tác ghi |

Mọi vai trò: không tự điều chỉnh số dư của mình, không tự duyệt đề xuất do chính mình tạo, không sửa / xoá được nhật ký.
Cấp / đổi vai trò nhân viên và đặt lại tài khoản khách cũng phải có người thứ hai duyệt; điều chỉnh số dư nhỏ nhưng cộng dồn 24 giờ vượt ngưỡng cũng phải duyệt.

Đổi vai trò: Quản trị → Người dùng → hồ sơ → **Đổi vai trò**. Ở môi trường thật (`REQUIRE_STAFF_2FA`), nhân viên phải bật xác thực 2 lớp mới vào được khu nhân viên.

## 2. Hạn trả lời

| Mức ưu tiên | Khi nào | Hạn trả lời |
| --- | --- | --- |
| Khẩn cấp | Khách đánh dấu khẩn (nghi bị truy cập trái phép, mất tài sản) | 15 phút |
| Cao | Lệnh / khớp lệnh bất thường, số dư, bảo mật; mọi yêu cầu gửi khi tài khoản đang bị khoá | 60 phút |
| Bình thường | Tài khoản, dữ liệu cá nhân, khác | 4 giờ |

Đồng hồ chạy từ tin nhắn đầu tiên của khách chưa được trả lời, dừng khi nhân viên trả lời khách (ghi chú nội bộ không tính). Yêu cầu quá hạn được tô đỏ trong khu CSKH,
và hệ thống gửi cảnh báo `support_overdue` tới `ALERT_EMAILS` / webhook.

## 3. Quy trình xử lý

1. **Nhận xử lý** (hoặc quản trị viên **giao cho** nhân viên). Khách thấy "Nhân viên CSKH đã tiếp nhận".
2. Xem **hồ sơ khách** bên phải: ví, lệnh đang mở, nhật ký lệnh liên quan (ai đặt / sửa / huỷ, lúc nào, IP nào, các lần khớp), lịch sử đăng nhập.
3. Trả lời khách. Thông tin chỉ nội bộ cần biết → tích **Ghi chú nội bộ**.
4. Nếu cần thao tác:
   - **Huỷ hộ lệnh** — chỉ lệnh của chính khách đó, bắt buộc ghi lý do.
   - **Khoá khẩn** — khi khách báo bị truy cập trái phép. Mọi lệnh mở bị huỷ, phiên đăng nhập bị ngắt; chỉ quản trị viên mở khoá.
     Khách vẫn nhắn tiếp được (xem mục 4).
   - **Đề xuất điều chỉnh số dư** — bồi hoàn / sửa sai. Chỉ có hiệu lực khi một quản trị viên khác duyệt ở Quản trị → **Duyệt điều chỉnh**.
5. **Đã xử lý xong** — bắt buộc ghi cách đã xử lý; khách nhận email và có thể đánh giá. Khách nhắn tiếp thì yêu cầu tự mở lại; sau 7 ngày không phản hồi thì tự đóng.

## 4. Khách đang bị khoá

Khách bị khoá đăng nhập đúng mật khẩu (và đúng mã 2FA nếu đã bật) thì **không có phiên giao dịch**, chỉ nhận "vé hỗ trợ" 2 giờ để vào trang
`/ho-tro-khoa`: gửi yêu cầu, nhắn tin, nhận trả lời (kèm email). Vé không xem được ví, lệnh, không đặt lệnh được.

Người nhắn có thể là chủ tài khoản hoặc kẻ đã chiếm mật khẩu. Yêu cầu gửi theo đường này có **ghi chú nội bộ kèm IP**. Trước khi đề xuất mở khoá:

1. Yêu cầu khách **đặt lại mật khẩu qua "Quên mật khẩu"** — chứng minh còn giữ email. Đặt lại xong tài khoản vẫn khoá, vé hỗ trợ cũ bị thu hồi.
2. Đối chiếu **Đăng nhập & bảo mật**: có sự kiện "Đặt lại mật khẩu" mới, IP đăng nhập lạ đã dừng chưa.
3. Khuyên khách bật 2FA. Báo quản trị viên mở khoá (Quản trị → Người dùng), ghi lý do mở khoá.

## 5. Tra dấu vết khi có sự cố

| Câu hỏi | Xem ở đâu |
| --- | --- |
| Ai đặt / sửa / huỷ lệnh, lúc nào, từ IP nào? | Nhật ký lệnh (biểu tượng đồng hồ ở dòng lệnh; Quản trị → hồ sơ người dùng → bấm số lệnh) — bảng `order_events` |
| Ai đăng nhập vào tài khoản, có sai mật khẩu nhiều lần không? | Hồ sơ người dùng → **Đăng nhập & bảo mật**; khách tự xem ở Cài đặt → Hoạt động — bảng `auth_events` |
| Quản trị viên / CSKH đã làm gì, đã xem hồ sơ khách nào? | Quản trị → **Nhật ký** — bảng `admin_audit_log` (`USER_VIEW`, `ORDER_CANCEL`, `USER_LOCK`, `BALANCE_ADJUST_*`…) |
| Lệnh khớp lúc cặp đang dùng giá điều chỉnh? Ai chỉnh, giá bao nhiêu, lý do gì? | Quản trị → **Giá thị trường** → biểu tượng lịch sử của cặp; hoặc **Nhật ký** (`PRICE_MODE_MANUAL`, `PRICE_SET`, `PRICE_MODE_LIVE`) — so thời điểm với giờ khớp trong nhật ký lệnh |
| Ai đề xuất, ai duyệt khoản bồi hoàn? | Quản trị → **Duyệt điều chỉnh**; dòng sổ cái của khách ghi rõ số yêu cầu, người đề xuất, người duyệt |
| Đã trao đổi gì với khách? | Khu CSKH → yêu cầu hỗ trợ — bảng `support_messages` |

Nhật ký quản trị, nhật ký đăng nhập và tin nhắn hỗ trợ **chỉ được ghi thêm**: cơ sở dữ liệu chặn sửa / xoá, kể cả khi khôi phục bản sao lưu.
Xoá tài khoản chỉ xoá thông tin cá nhân (email, họ tên, mật khẩu, 2FA); lệnh, khớp lệnh, sổ cái và tin nhắn hỗ trợ được giữ ở dạng ẩn danh để đối soát.

## 6. Chống dò mật khẩu

Sai mật khẩu hoặc mã 2FA 5 lần trong 15 phút → tài khoản bị chặn đăng nhập 15 phút (kể cả đúng mật khẩu), chủ tài khoản nhận email cảnh báo kèm IP.
Khách báo không đăng nhập được: kiểm tra **Đăng nhập & bảo mật** trong hồ sơ; nếu nghi bị dò mật khẩu, hướng dẫn khách đặt lại mật khẩu và bật 2FA.
