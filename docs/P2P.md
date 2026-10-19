# Chợ P2P và thương nhân

VNCoin có chợ P2P theo mô hình Binance P2P / OKX P2P: người dùng mua bán coin trực tiếp với **thương nhân** bằng VNĐ. Mọi thứ vẫn là vốn ảo; tiền VNĐ đi qua **ngân hàng giả lập** nằm ngoài sàn.

## 1. Vai trò

| Ai | Làm gì |
|---|---|
| Khách (taker) | Mua / bán theo quảng cáo có sẵn. Miễn phí. Không đăng quảng cáo được. |
| Thương nhân (maker) | Khách hàng đã được sàn duyệt, đặt cọc USDT. Đăng quảng cáo mua / bán, có huy hiệu "Thương nhân đã xác minh". Trả phí 0,2% số coin của mỗi đơn. |
| Vận hành P2P `P2P_OPS` (`p2p.review`) | Duyệt / từ chối đơn xin làm thương nhân, tạm ngừng / khôi phục, trừ tiền cọc. |
| Vận hành P2P (`p2p.appeal`) | Xử lý khiếu nại đơn P2P ở `/cskh` → Khiếu nại P2P. Tài khoản thử dev: `p2p@`. |
| Vận hành thị trường (`market.manage`) | Chỉnh tham số P2P: tỷ giá tham chiếu, phí, tiền cọc, điều kiện, giới hạn. |

Thương nhân **không phải vai trò nhân viên**: `users.role` vẫn là `USER`, trạng thái nằm ở bảng `p2p_merchants` (`PENDING`, `ACTIVE`, `SUSPENDED`, `REJECTED`, `RESIGNED`). Tài khoản nhân viên không dùng được P2P, để tránh xung đột lợi ích khi xử lý khiếu nại.

## 2. Trở thành thương nhân

Điều kiện mặc định (Quản trị → Thương nhân P2P → Tham số P2P):

- **xác minh danh tính (KYC) cấp 2** (xem [KYC-AML.md](KYC-AML.md));
- đã xác thực email, đã bật 2FA;
- tài khoản mở từ 3 ngày;
- đã hoàn tất ít nhất 5 đơn P2P, tỷ lệ hoàn tất 30 ngày từ 90%;
- đủ **2.000 USDT** khả dụng để đặt cọc.

Nộp đơn ở `/p2p/thuong-nhan` thì tiền cọc bị khoá ngay. Rủi ro & giám sát duyệt thì thành `ACTIVE`, còn từ chối thì trả cọc. Thương nhân nghỉ (phải hết đơn dang dở) thì mọi quảng cáo đóng, cọc được mở khoá.

## 2b. KYC và hạn mức

- Giao dịch P2P (đặt đơn, thêm tài khoản nhận tiền) cần **KYC cấp 1**. Hạn mức / ngày UTC theo cấp: cấp 1 là 200.000.000 ₫, cấp 2 là 2.000.000.000 ₫. Hạn mức áp cho cả hai bên của đơn.
- Tên chủ tài khoản nhận tiền luôn là họ tên KYC (chính chủ), không tự gõ.
- Tài khoản bị bộ phận Tuân thủ hạn chế thì không đặt đơn / đăng quảng cáo được; đơn đang chạy vẫn xử lý tiếp.

## 3. Quảng cáo

- **Chiều** theo góc nhìn thương nhân: `SELL` (khách mua) hoặc `BUY` (khách bán). Coin: USDT, BTC, ETH, BNB. Tiền: VNĐ.
- **Giá**: cố định, hoặc thả nổi = giá tham chiếu × tỷ lệ (80% → 120%). Giá tham chiếu = giá Binance theo USDT × tỷ giá USDT/VNĐ của sàn (mặc định 26.000). Giá phải trong ±20% giá tham chiếu.
- **Hạn mức** mỗi đơn (tối thiểu từ 100.000 ₫), tổng số lượng, 1–5 phương thức thanh toán, thời hạn thanh toán 15 / 30 / 45 / 60 phút, điều khoản, điều kiện tuổi tài khoản của khách.
- Quảng cáo bán **khoá ngay** số coin cộng phí. Đóng quảng cáo thì mở khoá phần chưa bán.
- Tối đa 10 quảng cáo đang mở. Tạm ngừng thương nhân thì mọi quảng cáo chuyển offline.

## 4. Vòng đời đơn

```
PENDING_PAYMENT ──người mua bấm "Tôi đã thanh toán"──▶ PAID ──bên bán nhả coin──▶ COMPLETED
      │                                                 │
      ├─ hết thời hạn / người mua huỷ ─▶ CANCELLED       └─ sau 10 phút, một bên khiếu nại ─▶ APPEAL ─▶ nhân viên phân xử
```

1. **Đặt đơn**: coin của bên bán vào ký quỹ (`p2p_orders.escrow_amount`). Với quảng cáo bán, coin lấy từ phần quảng cáo đã khoá. Với quảng cáo mua, sàn khoá coin của khách bán.
2. **Thanh toán**: người mua tự chuyển khoản ở `/ngan-hang` (hoặc nút "Chuyển khoản" trong đơn), nội dung ghi `P2P <mã đơn>`, rồi bấm "Tôi đã thanh toán". Sàn **không** tự kiểm tra lệnh chuyển: bấm mà chưa chuyển là vi phạm.
3. **Nhả coin**: bên bán kiểm tra sao kê ngân hàng, thấy đủ tiền thì nhả coin. Không hoàn tác được. Đơn đã `PAID` thì không tự huỷ, không tự nhả.
4. **Huỷ**: người mua huỷ được trước khi coin được nhả. Khách mua huỷ hoặc để hết hạn quá **3 lần / ngày** thì bị khoá P2P tới 00:00 UTC.
5. **Hoàn tất**: người mua nhận coin, giá vốn tính bằng số tiền đã trả quy ra USDT. Người mua được cộng `contributed_usdt`, người bán bị trừ cùng giá trị, coi như nạp / rút vốn. Nhờ vậy ROI bảng xếp hạng không lệch, còn chênh lệch giá của thương nhân trở thành lãi thật.

Thống kê hiển thị trên quảng cáo: số đơn 30 ngày, tỷ lệ hoàn tất 30 ngày (lỗi tính cho người mua khi huỷ / hết hạn / bị trả coin), thời gian nhả coin và thanh toán trung bình.

## 5. Xử lý khiếu nại (Vận hành P2P)

Mở `/cskh` → **Khiếu nại P2P**. Mỗi đơn có:

- thông tin đơn, hai bên (email, số tài khoản), lý do và mô tả khiếu nại;
- **sao kê chuyển khoản giữa hai bên** từ 1 giờ trước khi tạo đơn, có so tổng đã chuyển với số tiền phải trả;
- chat trong đơn (nhân viên gửi tin được, tin hiện nhãn "Nhân viên VNCoin").

Phân xử:

| Tình huống | Chọn | Ghi chú |
|---|---|---|
| Sao kê có đủ tiền, bên bán không nhả | **Nhả coin cho người mua** | Nếu bên bán là thương nhân, có thể trừ cọc để bồi thường người mua |
| Không có / thiếu lệnh chuyển | **Trả coin về bên bán, huỷ đơn** | Nếu người mua là thương nhân (quảng cáo mua), có thể trừ cọc bồi thường bên bán |

Bắt buộc ghi căn cứ phân xử. Mọi lần mở chi tiết ghi `USER_VIEW` cho cả hai bên, còn phân xử ghi `P2P_APPEAL_RESOLVE` vào nhật ký quản trị. Bên bán vẫn tự nhả coin được trong lúc khiếu nại.

## 6. Ngân hàng giả lập

- Mỗi tài khoản có 1 tài khoản VNĐ 10 chữ số, cấp 100.000.000 ₫ khi mở / đặt lại tài khoản.
- Chuyển khoản tra tên chủ tài khoản trước (như app ngân hàng). Nếu tên khác thông tin trên đơn thì có cảnh báo.
- Bất biến: số dư = tổng nhận − tổng chuyển trong `bank_transfers`. Cấp vốn hay đặt lại ghi 1 dòng của ngân hàng (`from_user` / `to_user` NULL).

## 7. Đối soát và dữ liệu

- `balances.locked` = khoá của lệnh Spot + `p2p_ads.locked_amount` + `p2p_orders.escrow_amount` (đơn đang chạy) + `p2p_merchants.deposit_usdt`. Đối soát hằng ngày báo `LOCKED_MISMATCH` nếu lệch.
- Phí P2P (`p2p_orders.fee` của đơn hoàn tất) cộng vào đối soát phí. Ngân hàng báo `BANK_MISMATCH` khi số dư khác sao kê.
- Sổ cái: loại `P2P` (coin vào / ra, trừ cọc, bồi thường) và `FEE`, gắn `ledger.p2p_order_id`.
- Đặt lại tài khoản bị chặn khi còn đơn P2P dang dở. Khoá / xoá tài khoản thì đóng quảng cáo và tạm ngừng thương nhân, tiền cọc giữ lại để xử lý khiếu nại.

## 8. Dữ liệu mẫu (dev)

Khi đặt `DEV_STAFF_PASSWORD` (không có tác dụng ở production), máy chủ tạo 3 thương nhân `merchant1@`, `merchant2@`, `merchant3@` (cùng tên miền với `ADMIN_EMAIL`). Mỗi thương nhân có quảng cáo bán và mua USDT; `merchant1` có thêm quảng cáo bán BTC nếu lúc khởi động đã có giá BTC.

## 9. Chưa làm

KYC giấy tờ thật, nhiều loại tiền pháp định, quảng cáo khối lớn, thanh toán tiền mặt, ưu tiên hiển thị trả phí, xác thực 2FA khi nhả coin, trả cọc chậm 7 ngày như Binance (ở đây trả ngay khi đủ điều kiện).
