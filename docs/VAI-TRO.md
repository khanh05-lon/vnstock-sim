# Vai trò và phân tách trách nhiệm

VNCoin chia nhân viên theo bộ phận giống các sàn thật (Binance, OKX): mỗi người chỉ có quyền đủ cho việc của mình (*least privilege*), và việc nào có thể gây thiệt hại thì tách người làm với người duyệt (*phân tách trách nhiệm*, SoD). Ma trận nằm ở `shared/src/permissions.ts` (`ROLE_PERMISSIONS`, `can()`); thêm quyền thì sửa ở đó, không hard-code ở FE / BE.

## 1. Ma trận vai trò

| Vai trò | Mã | Quyền chính | Không được |
|---|---|---|---|
| Nhà đầu tư | `USER` | Giao dịch Spot, P2P (cần KYC), gửi hỗ trợ, tải dữ liệu cá nhân, yêu cầu xoá tài khoản | — |
| Thương nhân P2P | `USER` + `p2p_merchants` | Đăng quảng cáo P2P (không phải vai trò nhân viên) | — |
| Nhân viên CSKH | `SUPPORT` | `support.desk`: trả lời yêu cầu, xem hồ sơ khách **qua yêu cầu**, huỷ hộ lệnh, khoá khẩn, đề xuất bồi hoàn | Giao việc cho người khác, duyệt bồi hoàn, tắt 2FA, khiếu nại P2P |
| Trưởng nhóm CSKH | `SUPPORT_LEAD` | + `support.lead` (giao / chuyển yêu cầu), `account.recovery` (khôi phục 2FA), `support.compensate` (duyệt bồi hoàn nhỏ) | Duyệt bồi hoàn của chính mình hoặc vượt hạn mức |
| Quản trị hệ thống (IT) | `ADMIN` | Phân quyền nhân viên, tài khoản (tạo, khoá, xác thực email), sao lưu, giám sát, thông báo, nhật ký | Khu CSKH, tắt 2FA hộ khách, xoá khách, số dư, giá, niêm yết |
| Vận hành thị trường | `MARKET_OPS` | Cặp, giá, biểu phí, hệ số VIP, tham số P2P, tạm ngừng cặp; đề xuất niêm yết / chỉnh giá lớn / tạm ngừng sàn | Hồ sơ khách, số dư |
| Tài chính | `FINANCE` | Điều chỉnh / đặt lại số dư, duyệt điều chỉnh của người khác, đối soát | Thị trường, khoá tài khoản |
| Rủi ro & giám sát | `RISK` | Giám sát gian lận, khoá / mở khoá, huỷ hộ lệnh, tạm ngừng / dừng khẩn, duyệt đề xuất thị trường | Số dư, P2P, cấu hình thị trường |
| Vận hành P2P | `P2P_OPS` | `p2p.review` (duyệt / tạm ngừng thương nhân, trừ cọc), `p2p.appeal` (phân xử khiếu nại ở `/cskh`) | Số dư ngoài P2P, KYC |
| Tuân thủ (chuyên viên) | `COMPLIANCE` | `kyc.review`, `aml.view`, `aml.manage`: duyệt KYC, xử lý cảnh báo, **lập** STR, hạn chế tài khoản, đề xuất gỡ | Nộp STR, gỡ hạn chế |
| Trưởng Tuân thủ | `MLRO` | + `aml.report`: nộp STR (tự lập hoặc duyệt đề xuất `STR_FILE`), duyệt gỡ hạn chế `AML_UNFREEZE` | Tự duyệt đề xuất của chính mình |
| Bảo vệ dữ liệu cá nhân | `DPO` | `privacy.manage`: xử lý yêu cầu xoá tài khoản (ẩn danh hoá), xem nhật ký truy cập dữ liệu | Mọi thao tác giao dịch / số dư |
| Kiểm toán | `AUDITOR` | Chỉ đọc: tổng quan, người dùng, lệnh, hàng chờ duyệt, nhật ký, giám sát, AML | Mọi thao tác ghi |

Tài khoản thử (chỉ dev, cùng tên miền với `ADMIN_EMAIL`, mật khẩu `DEV_STAFF_PASSWORD`): `admin2@`, `ops@`, `finance@`, `finance2@`, `risk@`, `compliance@`, `compliance2@`, `mlro@`, `p2p@`, `dpo@`, `cskh@`, `cskhlead@`, `audit@`.

## 2. Vì sao chia như vậy

- **IT không đụng vào khách**: quản trị hệ thống có quyền kỹ thuật rất rộng (phân quyền, sao lưu). Nếu thêm quyền tắt 2FA / xoá khách / xem hội thoại thì một người đủ để chiếm tài khoản khách. Sàn thật để việc này cho CSKH có quy trình xác minh.
- **Trưởng nhóm CSKH**: giao việc và các thao tác nhạy cảm của CSKH (khôi phục 2FA, bồi hoàn) cần một cấp trên trực tiếp, không cần lên tới Tài chính với khoản nhỏ.
- **MLRO**: luật phòng, chống rửa tiền yêu cầu người phụ trách PCRT chịu trách nhiệm báo cáo giao dịch đáng ngờ. Chuyên viên phát hiện, MLRO quyết định nộp. Gỡ hạn chế cũng do MLRO vì đó là quyết định "chấp nhận rủi ro".
- **Vận hành P2P tách khỏi Rủi ro**: P2P có nghiệp vụ riêng (thương nhân, tiền cọc, khiếu nại có sao kê); Binance có đội P2P riêng. Rủi ro tập trung giám sát gian lận và dừng thị trường.
- **DPO**: Luật bảo vệ dữ liệu cá nhân (Nghị định 13/2023, GDPR) cho chủ thể dữ liệu quyền truy cập và yêu cầu xoá; việc xoá phải cân với nghĩa vụ lưu trữ AML, nên cần người phụ trách riêng chứ không để IT xoá tuỳ ý.

## 3. Trưởng nhóm CSKH

- **Giao / chuyển yêu cầu** cho nhân viên khác (nhân viên thường chỉ tự nhận).
- **Duyệt bồi hoàn nhỏ** ở `/cskh` → Duyệt bồi hoàn: yêu cầu điều chỉnh số dư do CSKH tạo từ yêu cầu hỗ trợ, cộng tiền, quy đổi ≤ `SUPPORT_COMP_LIMIT_USDT` (mặc định 100 USDT). Lớn hơn thì chỉ Tài chính duyệt. Người đề xuất không tự duyệt; duyệt / từ chối ghi tin nhắn hệ thống vào yêu cầu hỗ trợ.
- **Khôi phục 2FA** (khách mất điện thoại) trong yêu cầu hỗ trợ của chính khách:
  1. Khách phải đã KYC cấp 1 (không có thì `NO_KYC`, hướng dẫn khách xác minh trước).
  2. Trưởng nhóm hỏi khách 4 số cuối giấy tờ, nhập vào và tick "đã đối chiếu họ tên theo KYC".
  3. Sai 4 số → `IDENTITY_MISMATCH`, ghi `USER_RECOVERY_FAILED`. Đúng → tắt 2FA, ghi `USER_2FA_RESET`, tin nhắn hệ thống vào yêu cầu, email cho khách.

## 4. MLRO

- Chuyên viên bấm **Lập STR** → đề xuất `STR_FILE` trong Hàng chờ duyệt (hạn 3 ngày), các cảnh báo chuyển "Đang xem xét".
- MLRO duyệt → STR ghi vào `aml_reports`, cảnh báo thành "Đã báo cáo". MLRO tự lập STR thì nộp ngay.
- Gỡ hạn chế (`AML_UNFREEZE`) chỉ MLRO duyệt.

## 5. Dữ liệu cá nhân (khách và DPO)

Khách ở `/du-lieu-ca-nhan` (menu tài khoản):

- **Tải dữ liệu của tôi** (JSON): hồ sơ, KYC (số giấy tờ chỉ 4 số cuối), số dư, lệnh, khớp, sổ cái, đơn P2P, sao kê ngân hàng giả lập, yêu cầu hỗ trợ, lịch sử đăng nhập. Tối đa 3 lần / ngày.
- **Yêu cầu xoá tài khoản** kèm lý do; rút lại được khi còn chờ.

DPO ở Quản trị → **Dữ liệu cá nhân**: mỗi yêu cầu có kiểm tra tự động (còn đơn P2P dở dang, đang là thương nhân, đang có nghĩa vụ giữ tài khoản — chỉ hiện chung chung, không lộ chi tiết AML cho DPO). Chấp thuận → ẩn danh hoá (`anonymizeUser`: huỷ lệnh, ngắt phiên, xoá email / họ tên / KYC / 2FA, giữ giao dịch), email kết quả. Từ chối phải ghi lý do gửi khách.

`DELETE /api/admin/users/:id`: ẩn danh cần `privacy.manage`; xoá hẳn tài khoản thử (ngoài production) cần `users.manage`.

## 6. Cấp VIP phí (khách)

Như Binance: phí Spot giảm theo cấp, đạt cấp khi **cả** khối lượng Spot 30 ngày (tổng `fills.quote_qty`) **và** số BNB đang giữ đủ ngưỡng. Ngưỡng = ngưỡng thật × `VIP_RULES.scale` (mặc định 0,01 vì vốn ảo 10.000 USDT), Vận hành thị trường chỉnh ở Quản trị → Vận hành thị trường → Cấp VIP.

| Cấp | KL 30 ngày thật (USDT) | BNB thật | Maker | Taker |
|---|---|---|---|---|
| 0 | — | — | 0,100% | 0,100% |
| 1 | 1.000.000 | 25 | 0,090% | 0,100% |
| 2 | 5.000.000 | 100 | 0,080% | 0,100% |
| 3 | 20.000.000 | 250 | 0,040% | 0,060% |
| 4 | 75.000.000 | 500 | 0,040% | 0,052% |
| 5 | 150.000.000 | 1.000 | 0,025% | 0,031% |
| 6 | 400.000.000 | 1.750 | 0,020% | 0,029% |
| 7 | 800.000.000 | 3.000 | 0,019% | 0,028% |
| 8 | 2.000.000.000 | 4.500 | 0,016% | 0,025% |
| 9 | 4.000.000.000 | 5.500 | 0,011% | 0,023% |

- Cấp tính lại mỗi ngày lúc 00:00 UTC (`VipService`, lưu `users.vip_level`, `vip_volume_30d`, `vip_updated_at`); có nút "Tính lại ngay".
- Phí chốt vào lệnh lúc đặt theo cấp hiện tại (`feesFor(vipLevelOf(...))` trong `engine.placeInTx` / `placeOco`); trả phí bằng BNB vẫn giảm thêm 25%.
- Khách xem ở `/phi`: cấp hiện tại, tiến độ lên cấp kế, bảng đầy đủ.

## 7. Duyệt 2 người

| Đề xuất | Ai tạo | Ai duyệt (quyền) |
|---|---|---|
| Điều chỉnh số dư lớn / bồi hoàn | Tài chính, CSKH | Tài chính (`finance.approve`); bồi hoàn nhỏ: Trưởng nhóm CSKH |
| Đặt lại tài khoản khách | Tài chính | Tài chính khác |
| Chỉnh giá lệch lớn, niêm yết / huỷ niêm yết, tạm ngừng / mở lại sàn | Vận hành thị trường, Rủi ro | `market.approve` (người khác) |
| Cấp / đổi vai trò nhân viên | Quản trị hệ thống | Quản trị hệ thống khác |
| Khôi phục dữ liệu | Quản trị hệ thống | `data.approve` (người khác) |
| Nộp STR (`STR_FILE`), gỡ hạn chế AML (`AML_UNFREEZE`) | Tuân thủ | MLRO (`aml.report`) |

Người đề xuất không bao giờ tự duyệt được, kể cả khi có quyền duyệt.

## 8. Chưa làm

Chương trình giới thiệu, nhà tạo lập thị trường (khách không khớp với nhau), tài khoản tổ chức / tài khoản phụ / API key, VIP theo Futures, khôi phục 2FA bằng video / khuôn mặt.
