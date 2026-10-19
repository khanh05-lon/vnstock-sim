# Xác minh danh tính (KYC) và chống rửa tiền (AML)

VNCoin làm KYC theo cấp và có bộ phận **Tuân thủ** giống các sàn thật (Binance, OKX). Vì là sàn mô phỏng nên hồ sơ KYC là **khai báo giả lập** (không tải ảnh giấy tờ), nhưng quy trình duyệt, hạn mức, giám sát và lưu vết làm như thật.

## 1. Cấp KYC

| Cấp | Khách khai báo | Được dùng |
|---|---|---|
| 0 · Chưa xác minh | — | Giao dịch Spot bằng vốn ảo, xem chợ P2P |
| 1 · Xác minh danh tính | Họ tên theo giấy tờ, ngày sinh (≥ 18 tuổi), quốc tịch, CCCD (12 số) hoặc hộ chiếu, ngày cấp, có phải PEP | P2P, hạn mức 200.000.000 ₫ / ngày |
| 2 · Xác minh nâng cao | Địa chỉ cư trú, nghề nghiệp, nguồn tiền, mục đích (cần cấp 1) | P2P 2.000.000.000 ₫ / ngày, được xin làm thương nhân |

- Hạn mức tính trên tổng tiền các đơn P2P chưa huỷ trong ngày UTC, áp cho **cả hai bên** của đơn. Nếu thương nhân hết hạn mức, khách được báo "chọn quảng cáo khác".
- Hạn mức và cấp tối thiểu để làm thương nhân chỉnh được ở Quản trị → Thương nhân P2P → Tham số P2P.
- **Chính chủ**: khi duyệt cấp 1, tên chủ tài khoản ngân hàng giả lập và mọi phương thức thanh toán P2P đổi theo họ tên KYC (in hoa, bỏ dấu). Khách không tự gõ tên chủ tài khoản; phải đạt cấp 1 mới thêm được tài khoản nhận tiền.
- **Bảo vệ dữ liệu**:
  - Hồ sơ lưu mã hoá AES-256-GCM (`DATA_ENCRYPTION_KEY`).
  - Số giấy tờ chỉ giữ mã băm HMAC (để dò trùng) và 4 số cuối. Nhân viên cũng chỉ thấy 4 số cuối.
  - Mỗi lần mở hồ sơ đầy đủ ghi `KYC_VIEW` vào nhật ký quản trị.
- **Tự kiểm tra khi nộp**:
  - Số giấy tờ trùng tài khoản khác → cờ `DUPLICATE_ID` và cảnh báo AML.
  - Khai là PEP → cờ và cảnh báo `PEP`, cần thẩm định tăng cường.
- Bị từ chối thì khách thấy lý do (kèm email) và nộp lại được.

Khách xác minh ở `/xac-minh` (menu tài khoản → Xác minh danh tính).

## 2. Vai trò Tuân thủ (`COMPLIANCE`) và Trưởng Tuân thủ (`MLRO`)

| Quyền | Ai có | Dùng để |
|---|---|---|
| `kyc.review` | Tuân thủ | Duyệt / từ chối hồ sơ KYC, xem hồ sơ đầy đủ |
| `aml.view` | Tuân thủ, Kiểm toán | Xem cảnh báo AML, hồ sơ hoạt động P2P của khách, STR, tài khoản bị hạn chế, ngưỡng |
| `aml.manage` | Tuân thủ, MLRO | Xử lý cảnh báo, lập STR, hạn chế tài khoản, đề xuất gỡ, chỉnh ngưỡng, quét ngay |
| `aml.report` | MLRO | Nộp STR (tự lập thì nộp ngay, chuyên viên lập thì duyệt đề xuất `STR_FILE`), duyệt gỡ hạn chế `AML_UNFREEZE` |

Như luật phòng, chống rửa tiền: chuyên viên phát hiện và lập hồ sơ, **người phụ trách PCRT (MLRO)** quyết định nộp báo cáo và chịu trách nhiệm chấp nhận rủi ro khi gỡ hạn chế.

Khu làm việc: Quản trị → **Tuân thủ (KYC/AML)**. Tài khoản thử ở môi trường dev là `compliance@`, `compliance2@` (chuyên viên) và `mlro@` (Trưởng Tuân thủ) (cùng tên miền với `ADMIN_EMAIL`, mật khẩu `DEV_STAFF_PASSWORD`).

## 3. Cảnh báo AML

Hệ thống quét đơn P2P hoàn tất trong 24 giờ, 10 phút / lần (nút "Quét ngay" để chạy tay). Mỗi quy tắc chỉ tạo 1 cảnh báo cho mỗi người mỗi ngày UTC. Ngưỡng mặc định (chỉnh ở mục Ngưỡng cảnh báo):

| Quy tắc | Điều kiện | Mức |
|---|---|---|
| Giao dịch P2P giá trị lớn | 1 đơn ≥ 400.000.000 ₫ | Trung bình |
| Khối lượng P2P 24 giờ cao | Tổng ≥ 1.000.000.000 ₫ | Trung bình |
| Chia nhỏ để né ngưỡng | ≥ 3 đơn, mỗi đơn từ 80% đến dưới ngưỡng đơn lớn | Cao |
| Mua vào bán ra nhanh | Mua và bán qua P2P mỗi chiều ≥ 100.000.000 ₫ trong 24 giờ (không xét thương nhân) | Cao |
| Nhiều đối tác lạ | ≥ 5 đối tác khác nhau trong 24 giờ (không xét thương nhân) | Trung bình |
| Trùng số giấy tờ / PEP | Lúc nộp KYC | Cao / Trung bình |

Quy trình xử lý:

1. Mở cảnh báo để xem hồ sơ khách (KYC, P2P 30 ngày, 30 đơn gần nhất). Mỗi lần xem ghi `USER_VIEW`.
2. **Nhận xử lý** → Đang xem xét.
3. Kết luận theo một trong hai hướng:
   - **Đóng (không đáng ngờ)**: bắt buộc ghi kết luận.
   - **Lập STR**: chọn các cảnh báo của cùng khách và viết mô tả (≥ 30 ký tự). Chuyên viên lập thì thành đề xuất `STR_FILE` (hạn 3 ngày) trong Hàng chờ duyệt, các cảnh báo chuyển "Đang xem xét"; MLRO duyệt thì STR mới vào sổ. STR chỉ được ghi thêm, không sửa / xoá; tải JSON được. Sàn mô phỏng không gửi STR đi đâu.
4. Nếu cần, **hạn chế tài khoản** ngay.

Nguyên tắc **không tiết lộ**: khách không bao giờ thấy cảnh báo, STR hay lý do bị hạn chế.

## 4. Hạn chế tài khoản

- Hạn chế (`aml.manage`, bắt buộc lý do nội bộ):
  - Khách vẫn đăng nhập, xem ví, huỷ lệnh được.
  - Khách **không đặt / sửa lệnh Spot**, không đặt đơn hay đăng quảng cáo P2P (lỗi `ACCOUNT_RESTRICTED`).
  - Quảng cáo P2P bị đóng, thương nhân chuyển sang tạm ngừng với ghi chú chung.
  - Đơn P2P đang chạy vẫn xử lý tiếp để không giam coin của người khác.
- Khách chỉ thấy banner "Tài khoản đang bị hạn chế giao dịch… Liên hệ CSKH".
- **Gỡ hạn chế** là đề xuất `AML_UNFREEZE` trong Hàng chờ duyệt. Phải có **Trưởng Tuân thủ (MLRO)** duyệt (người đề xuất không tự duyệt được). Tư cách thương nhân do Vận hành P2P khôi phục riêng.

## 5. Dữ liệu

- Migration `270_kyc_aml.sql`:
  - `users.kyc_level`, `kyc_name`, `aml_restricted_at` / `_reason` / `_by`;
  - các bảng `kyc_applications`, `aml_alerts`, `aml_reports` (trigger `append_only_guard`).
- Ngưỡng AML lưu ở `market_meta` key `admin.amlRules`.
- Nhật ký quản trị: `KYC_VIEW`, `KYC_APPROVE`, `KYC_REJECT`, `AML_ALERT_UPDATE`, `AML_STR_FILE`, `AML_RESTRICT`, `AML_UNRESTRICT`, `AML_SCAN`, `AML_RULES_SET`.

## 6. Chưa làm

Tải ảnh giấy tờ / nhận diện khuôn mặt, sàng lọc danh sách cấm vận thật, gửi STR tới cơ quan chức năng, Travel Rule (không có nạp rút on-chain), xác minh tổ chức (KYB), thẩm định định kỳ lại KYC.
