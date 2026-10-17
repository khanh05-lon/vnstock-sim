# VNStock Sim — ghi chú cho AI

Monorepo npm workspaces: `shared/` (quy tắc + zod), `backend/` (Express + Socket.io + PGlite), `frontend/` (React + Vite + Tailwind v4).

> Từ migration `200_crypto_spot.sql` dự án là **sàn coin Spot (VNCoin)**, giá từ Binance, số tiền dạng chuỗi thập phân (NUMERIC). Các ghi chú bên dưới
> về VNĐ, HOSE/HNX, T+2, ký quỹ, sự kiện quyền là của phiên bản sàn chứng khoán cũ — đối chiếu code trước khi làm theo.

## Trách nhiệm, dấu vết & CSKH (migration 210)

- Bảng **chỉ được ghi thêm** (trigger `append_only_guard`): `admin_audit_log`, `auth_events`, `support_messages`. Không viết code UPDATE / DELETE các bảng này; test muốn dọn thì tạo CSDL mới. Riêng xoá hẳn tài khoản thử (chỉ ngoài production) dùng `SET LOCAL vss.purge = 'on'`.
- `admin_audit_log` không có khoá ngoại và trong sao lưu là `replace: false` → khôi phục sao lưu chỉ gộp thêm, không xoá nhật ký hiện có. Bảng mới có khoá ngoại tới `users` phải nằm trong `BACKUP_TABLES` (vì khôi phục `TRUNCATE users CASCADE`).
- Nhật ký lệnh `order_events`: mọi hàm đổi trạng thái lệnh trong `SpotEngine` nhận `by: OrderActor` (`userActor(req.ip)` cho khách, `{ actor: email }` cho nhân viên, `SYSTEM_ACTOR` mặc định). Thêm đường huỷ / sửa lệnh mới phải truyền `by` và để `finish()` ghi sự kiện.
- Nhật ký đăng nhập `auth_events` qua `recordAuthEvent()` (`lib/authEvents.ts`); đăng nhập sai 5 lần / 15 phút → chặn theo tài khoản (`LOGIN_BLOCKED`).
- Vai trò `USER | SUPPORT | ADMIN | MARKET_OPS | FINANCE | RISK | AUDITOR` (migration 230); quyền chi tiết ở `shared/src/permissions.ts` (`ROLE_PERMISSIONS`, `can()`). `/api/admin` qua `staffGuard(db, 'admin.view')` rồi mỗi route `need('quyền')` (`admin/common.ts`); `/api/support-desk` qua `staffGuard(db, 'support.desk')`. Khu quản trị MẶC ĐỊNH CẤM: route mới PHẢI gắn `need()` (chỉ đọc chung thì `need('admin.view')`), thiếu thì `assertRoutesGuarded` làm server không khởi động. ADMIN = quản trị hệ thống, không có quyền tiền / giá. FE ẩn nút theo `useAdminMe().can()`. Nhân viên chỉ xem dữ liệu khách qua yêu cầu hỗ trợ, mỗi lần xem ghi `USER_VIEW`.
- Duyệt 2 người cho thao tác lớn: `admin/approvals.ts` (`approval_requests`, `Approvals.register(kind, executor)`); route tạo đề xuất trả 202 `{ pending, request }`, người duyệt (≠ người đề xuất, có `APPROVAL_PERMISSION[kind]`) bấm duyệt thì executor chạy với ctx người duyệt. Loại: PRICE_SET (lệch > `PRICE_APPROVAL_PCT`), SYMBOL_LIST / SYMBOL_DELIST, MARKET_HALT, ROLE_SET (cấp / đổi vai trò nhân viên, thu quyền ADMIN; chỉ 1 ADMIN thì áp dụng ngay — bootstrap), ACCOUNT_RESET, DATA_RESTORE (file ở `BACKUP_DIR/pending-restore`, kiểm sha256 lúc duyệt, `registerCleanup` xoá file khi đề xuất kết thúc; khôi phục xong thì `invalidatePending` mọi đề xuất khác). Điều chỉnh số dư trực tiếp cộng dồn 24 giờ theo người làm (từng khách và tổng × `ADJUST_DAILY_TOTAL_MULTIPLIER`), vượt ngưỡng thì thành yêu cầu. Điều chỉnh số dư vẫn dùng `balance_adjust_requests` riêng (duyệt: `finance.approve`). Tạo đề xuất / yêu cầu điều chỉnh → email mọi người có quyền duyệt (`admin/notify.ts`, trừ người đề xuất); đổi vai trò → email chính chủ + các ADMIN khác.
- Điều chỉnh số dư: không tự điều chỉnh / tự duyệt; từ `ADJUST_APPROVAL_USDT` trở lên và mọi đề xuất của CSKH thành `balance_adjust_requests`, quản trị viên khác duyệt (`applyBalanceAdjust`).
- Xoá người dùng = ẩn danh (`status = 'DELETED'`), giữ lệnh / khớp / sổ cái / tin nhắn hỗ trợ; đặt `password_changed_at` để thu hồi mọi phiên cũ (dòng users vẫn còn nên token cũ không tự mất hiệu lực). `loadTarget` / `lockUser` từ chối tài khoản đã xoá.
- Tài khoản bị khoá đăng nhập đúng (mật khẩu + 2FA) chỉ nhận **vé hỗ trợ** (JWT `purpose: 'support'`, trả trong `error.supportToken` của lỗi 403 `ACCOUNT_LOCKED`) — chỉ `requireAuthOrSupportTicket` của `/api/support/*` nhận vé này. FE lưu ở `useSupportPass` (sessionStorage), trang `/ho-tro-khoa`; `api(path, { token })` dùng token thay phiên.
- Hỗ trợ khách hàng: `support/service.ts` (hạn trả lời `SUPPORT_SLA_MINUTES` tính từ `customer_waiting_since`, tự đóng sau 7 ngày), realtime `support` (phòng `user:<id>`) và `support:staff` (phòng `staff`); cảnh báo vận hành `support_overdue`.
- Giá điều chỉnh (migration 220): `symbols.price_mode` LIVE | MANUAL + `price_control` (kịch bản `{since, from, to, startAt, endAt, volatilityPct, reason, by}`). `MarketService.setPriceControl()` chỉ đổi bộ nhớ — route `admin/priceControl.ts` lưu CSDL + `audit()` (PRICE_MODE_MANUAL / PRICE_SET / PRICE_MODE_LIVE). Cặp MANUAL bỏ qua mọi dữ liệu luồng Binance (chỉ cập nhật `ref`), `manualStep` sinh giá theo `priceOnPath` (shared) + dao động; thêm xử lý luồng Binance mới phải kiểm `s.control`. Nhà đầu tư thấy nhãn qua `SymbolInfo.priceMode`. Chống giao dịch nội gián: `assertNotInsider` (routes/trading.ts) chặn mọi vai trò nhân viên đặt / sửa lệnh cặp MANUAL; chỉnh giá thì huỷ lệnh mở của nhân viên trên cặp (`engine.cancelForUserOnSymbol`); có nhân viên đặt lệnh cặp đó trong 60 phút → chỉnh giá dù nhỏ cũng thành đề xuất.
- Dừng khẩn (`/admin/market/emergency-halt`): 1 người (`market.halt`), lưu `store.emergency` trong `admin.halt`; người khác xác nhận → tạm ngừng chính thức; không ai xác nhận thì `expireEmergencyIfDue` (gọi mỗi 15 giây trong installAdmin + khi xem /admin/market) tự mở lại. Mở lại sàn = đề xuất MARKET_RESUME.
- Giám sát gian lận: `admin/fraud.ts` (chung IP từ auth_events, tự đặt lại ≥ 3 lần, spam từ order_events — ngưỡng `FRAUD_RULES`), loại khỏi bảng xếp hạng = `users.leaderboard_banned_at` (routes/community.ts lọc). Bảng xếp hạng vốn chỉ lấy role USER.
- Đối soát: `admin/reconcile.ts` — mỗi (user, asset): tổng `ledger.amount` = free + locked = balance_after dòng cuối; locked > 0 phải có lệnh mở; phí ledger FEE = phí fills. Mọi chỗ cộng / trừ số dư PHẢI ghi ledger, không thì đối soát báo lệch. Tự chạy mỗi 24 giờ (`startReconcileSchedule`), lệch → email `finance.view`.
- Router `supportRoutes`, `watchlistRoutes`, `alertRoutes` phải `app.use` trước `tradingRoutes` (router đó gắn `requireAuth` cho cả `/api`).

## Lệnh

- `npm run dev` (root) — chạy API :4000 và web :5173 (Vite proxy `/api`, `/socket.io` sang :4000)
- `npm test` — vitest backend (`backend/test`, PGlite in-memory, ~50s) rồi frontend (`frontend/src/**/*.test.ts(x)`, jsdom)
- Test backend trên PostgreSQL thật: `TEST_DATABASE_URL=postgres://... npm run test -w backend` (mỗi test 1 schema riêng; 3 test chỉ chạy khi có Postgres). Không có Postgres cài sẵn thì dùng gói npm `embedded-postgres` ngoài repo.
- `npm run typecheck` — tsc FE + BE
- `npm run dev:vnstock` — như `dev` + data-service :8001 (cần `MARKET_PROVIDER=vnstock` trong `backend/.env`); `npm run test:data-service` — unittest Python
- Xoá `backend/data/` để seed lại toàn bộ dữ liệu

## Quy ước quan trọng

- Tiền và giá là **số nguyên VNĐ** (BIGINT). FE hiển thị giá theo nghìn đồng (`fmtPrice`: 98500 → "98.50"); input giá nhận "98.5" hoặc "98500" (`parsePriceInput`).
- Mọi quy tắc giao dịch (biên độ, bước giá, lô, phí, thuế, loại lệnh theo sàn) nằm trong `shared/src/index.ts` — sửa ở đó, không hard-code ở FE/BE.
- `Database` (`backend/src/db.ts`) tuần tự hoá mọi truy vấn bằng mutex. Trong `db.tx(fn)` chỉ dùng `tx`, **không gọi `db.*`** (sẽ deadlock).
- PGlite trả INT8 dạng number (khi an toàn), DATE dạng chuỗi `YYYY-MM-DD`, TIMESTAMPTZ dạng `Date`.
- Thời gian nến trả về là epoch giây UTC; FE cộng +7h cho khung trong ngày (lightweight-charts hiển thị theo UTC).
- Bất biến danh mục: `qty_total = qty_available + qty_hold + qty_pending` (có CHECK constraint).
- `MarketService` phát sự kiện `board/indices/trades/candles/session`; `TradingEngine` gắn qua `market.hooks`. Lệnh của người dùng ăn thanh khoản sổ lệnh qua `consumeBook` và ghi nhận vào thị trường qua `recordTrade`.
- Màu bảng điện dùng token Tailwind: `text-ceil/up/ref/down/floor`; theme tối/sáng bằng `data-theme` trên `<html>` (biến CSS trong `frontend/src/index.css`). Class động phải lấy từ map có sẵn (`toneText`, `toneBg`) để Tailwind quét được.
- Generic `Tabs`/`UnderlineTabs` dùng `NoInfer<T>` — truyền `value` có kiểu union cụ thể.
- Nguồn giá: `MARKET_PROVIDER=mock|vnstock`. `RealProvider` (`backend/src/market/vnstock/`) có `live` thay đổi động: khi `live`, MarketService poll cả ngoài phiên liên tục, không warm-up mô phỏng, phiên ATO/ATC chờ giá khớp thật (`pendingAuction`). Mất nguồn → tự uỷ quyền cho MockProvider. GT của VCI tính theo triệu đồng (data-service đổi sang đồng).
- `Database.open()` không truyền thư mục (PGlite in-memory, dùng trong test) trả cột DATE dạng `Date` thay vì chuỗi — trong test dùng `::text` khi so ngày.
- Quản trị: `backend/src/admin/` — `installAdmin()` phải gọi TRƯỚC các route `/api` khác (middleware chặn tài khoản bị khoá + cập nhật `last_seen_at`). `AdminStore` giữ trong RAM danh sách TK bị khoá, cờ tạm ngừng (`engine.control`), thông báo; lưu bền trong `market_meta` (key `admin.*`). Mọi thao tác quản trị phải gọi `audit()`.
- Ngày nghỉ lễ là trạng thái module trong `lib/calendar.ts` (`setHolidays`) — test dùng lịch phải tự `setHolidays([])`.
- JWT có claim `ms` (thời điểm cấp, mili-giây) để thu hồi đúng token cấp cùng giây với lần đổi mật khẩu.
- Vé tạm đăng nhập 2FA là JWT có claim `purpose: 'mfa'`; `verifyToken` từ chối mọi token có `purpose` — token mục đích khác không bao giờ dùng làm phiên đăng nhập.
- `RULES` sửa được lúc chạy: `applyRules(patch)` ghi đè tại chỗ (giữ tham chiếu), mặc định trong `DEFAULT_RULES`, bản quản trị lưu ở `market_meta` key `admin.rules`, FE nhận qua `/api/system`. Phí / thuế được chốt vào từng lệnh (`orders.fee_rate`, `tax_rate`) — tính tiền của lệnh cũ phải dùng giá trị chốt, không dùng `RULES` hiện tại.
- Hàm bước giá / biên độ (`tickSize`, `priceBand`, `roundToTick`…) nhận `Exchange | {exchange, type}` — với ETF / CW / BOND phải truyền cả `type`. Chỉ số chỉ tính mã `type = 'STOCK'`.
- Tiền bán về T+2 nằm ở `accounts.cash_pending` + bảng `cash_settlements`, không cộng thẳng vào `cash_balance`. Nợ ký quỹ: `loan_balance` + `loan_interest`; NAV = tiền + chờ về + CK + quyền − nợ (`navOf` ở BE, `navOfAccount` ở FE).
- Hook ngày mới của `MarketService`: settle → `engine.carryOver()` (lệnh GTD) → `corp.processDay()` → `margin.accrueInterest()`; cuối ngày: `expireAll` → `cond.expire` → `nav.snapshotAll`. Thêm nghiệp vụ theo ngày thì gắn vào đây trong `index.ts`.
- Với Postgres thật (pool nhiều kết nối) các UPDATE bắn không chờ (`void db.many(...)`) có thể về đích lệch thứ tự — luôn `await`, và cập nhật một chiều dùng `GREATEST`/`LEAST` (PGlite tuần tự hoá nên không lộ lỗi này).
- Tham số SQL số thực (tỷ lệ chia tách…) phải ép `$n::float8`, nếu không Postgres suy ra BIGINT từ cột và báo lỗi.
- Sao lưu JSON (`admin/backup.ts`, `BACKUP_TABLES`): thêm bảng dữ liệu người dùng mới thì phải thêm vào danh sách này (theo thứ tự khoá ngoại). Đổi cấu trúc bảng thì thêm bước chuyển đổi cho bản sao lưu cũ trong `restoreBackup` (xem ví dụ `watchlist_lists`).
- Loại lệnh theo sàn nằm trong `RULES.orderTypes` (HOSE MP, HNX MTL/MOK/MAK). Kiểm tra "lệnh thị trường" bằng `isMarketOrder()`, chọn lệnh thị trường của sàn bằng `marketOrderTypeFor()` — không so sánh cứng `=== 'MP'`. CSDL có CHECK `orders_order_type_check`: thêm loại lệnh phải có migration.
- Mọi khoản tiền cộng vào `cash_balance` (cổ tức, coupon, đáo hạn, lãi tiền gửi, quản trị viên cộng vốn) phải gọi `repayDebt(tx, userId)` trong cùng transaction.
- `tradingRoutes` gắn `requireAuth` cho cả router ở `/api` → router công khai hoặc router mới phải `app.use` TRƯỚC nó trong `index.ts` (xem `communityRoutes`, `watchlistRoutes`, `alertRoutes`).
