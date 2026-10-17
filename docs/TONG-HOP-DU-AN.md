# VNCoin (vnstock-sim): tổng hợp toàn bộ dự án

> Cập nhật: 18/10/2026. Nhánh `main`, commit mới nhất `dbd867a`.
> Repo: https://github.com/khanh05-lon/vnstock-sim · Thư mục máy: `D:\VS-CODE\vnstock-sim`

File này gom toàn bộ quá trình làm dự án, từ commit đầu tiên đến hiện tại:
- kiến trúc, cách chạy;
- từng đợt tính năng, phân quyền, quy tắc bắt buộc;
- những chỗ còn thiếu.

Muốn tra chi tiết kỹ thuật cho người viết code thì xem thêm [CLAUDE.md](../CLAUDE.md). Vận hành CSKH xem [CSKH.md](CSKH.md), triển khai xem [DEPLOY.md](DEPLOY.md).

---

## 1. Dự án là gì

**VNCoin** là sàn giao dịch coin **Spot mô phỏng**:
- Giá lấy thật từ **Binance**, tiền trong tài khoản là tiền ảo (USDT ảo) để tập giao dịch, không có tiền thật.
- Nhà đầu tư: đăng ký, nhận vốn ảo, đặt lệnh, xem ví / lãi lỗ, lên bảng xếp hạng, nhắn CSKH.
- Nhân viên: trang `/admin` (quản trị theo vai trò) và `/cskh` (chăm sóc khách hàng).

Lúc đầu dự án là **VNStock Sim**, một sàn chứng khoán Việt Nam mô phỏng (HOSE/HNX, VNĐ, T+2, ký quỹ). Từ migration `200_crypto_spot.sql` dự án chuyển hẳn sang sàn coin. Một số ghi chú cũ trong README và CLAUDE.md vẫn nói về chứng khoán, cần đối chiếu code.

## 2. Kiến trúc

Monorepo dùng npm workspaces:

| Thư mục | Vai trò | Công nghệ |
|---|---|---|
| `shared/` | Quy tắc chung FE + BE: số thập phân, bộ lọc Binance, lệnh, phí, phân quyền, giá điều chỉnh, CSKH | TypeScript, zod |
| `backend/` | API `:4000`, realtime, khớp lệnh, quản trị | Express, Socket.io, PGlite (dev/test) hoặc PostgreSQL (`DATABASE_URL`) |
| `frontend/` | Web `:5173` | React 18, Vite, Tailwind v4, TanStack Query, Zustand, lightweight-charts |
| `data-service/` | Dịch vụ giá chứng khoán (di sản bản cũ) | Python |
| `deploy/`, `Dockerfile`, `docker-compose.yml` | Triển khai: Docker Compose + Caddy HTTPS | |
| `.github/workflows` | CI: typecheck + test PGlite + build; test data-service; build Docker; test PostgreSQL 16 | GitHub Actions |

### Backend, các module chính

- `market/`: `marketService.ts` nhận giá Binance (`binance/`), phát sự kiện realtime; giả lập khi mất nguồn (`simFeed.ts`); giá điều chỉnh (`manualStep`).
- `trading/`: `engine.ts` (SpotEngine khớp lệnh), `wallet.ts`, `account.ts`, `orderEvents.ts` (nhật ký lệnh), `priceAlerts.ts`.
- `routes/`: `auth`, `market`, `trading`, `watchlists`, `alerts`, `community` (bảng xếp hạng), `support`.
- `support/`: dịch vụ CSKH (hạn trả lời SLA, tự đóng) và trợ lý AI `ai.ts` (Claude API).
- `admin/`: khu quản trị.

| File | Chức năng |
|---|---|
| `common.ts` | `staffGuard`, `need()`, `assertRoutesGuarded` |
| `routes.ts` | Route quản trị chung, tạm ngừng, dừng khẩn |
| `approvals.ts` | Hàng chờ duyệt 2 người |
| `priceControl.ts` | Giá thực tế / giá điều chỉnh |
| `marketAdmin.ts` | Cặp giao dịch, biểu phí |
| `staff.ts` | Phân quyền nhân viên |
| `backup.ts` | Sao lưu / khôi phục JSON |
| `emergency.ts` | Tự hết hạn dừng khẩn |
| `fraud.ts` | Giám sát gian lận |
| `reconcile.ts` | Đối soát + doanh thu phí |
| `notify.ts` | Email báo người duyệt |
| `store.ts` | Trạng thái quản trị trong RAM, lưu bền ở `market_meta` |
| `logBuffer.ts` | Log máy chủ xem trên web |

### Migration (`backend/migrations`)

| Số | Nội dung |
|---|---|
| 001 → 100 | Bản sàn chứng khoán cũ: khởi tạo, quên mật khẩu, quản trị, bảo mật đăng nhập, ký quỹ, sự kiện quyền, lệnh HNX, danh sách theo dõi, cảnh báo giá |
| **200** | Chuyển sang sàn coin Spot: xoá bảng chứng khoán, số tiền `NUMERIC(36,18)` |
| **210** | Trách nhiệm & CSKH: bảng chỉ ghi thêm, `order_events`, vai trò, `balance_adjust_requests`, tin nhắn hỗ trợ |
| **220** | Giá điều chỉnh: `symbols.price_mode`, `price_control` |
| **230** | Vai trò chi tiết + `approval_requests` (duyệt 2 người) |
| **240** | Duyệt 2 người cho đổi vai trò (ROLE_SET) và đặt lại tài khoản (ACCOUNT_RESET) |
| **250** | MARKET_RESUME, `users.leaderboard_banned_at`, bảng `reconciliation_runs` |

### Các trang web

| Đường dẫn | Trang |
|---|---|
| `/gioi-thieu` | Trang giới thiệu |
| `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email` | Tài khoản |
| `/thi-truong` | Danh sách cặp coin |
| `/trade/:symbol` | Giao dịch (biểu đồ, sổ lệnh, đặt lệnh) |
| `/vi` | Ví, số dư, lãi lỗ |
| `/lich-su` | Lịch sử lệnh / khớp |
| `/xep-hang` | Bảng xếp hạng |
| `/ho-tro` | Chat CSKH cho khách |
| `/ho-tro-khoa` | Hỗ trợ cho tài khoản bị khoá (vé hỗ trợ) |
| `/cskh` | Bàn làm việc nhân viên CSKH |
| `/admin` | Khu quản trị (tab theo vai trò) |
| `/dieu-khoan`, `/chinh-sach-bao-mat` | Pháp lý |

## 3. Cách chạy

```bash
npm install
npm run dev          # API :4000 + web :5173
npm test             # test backend (PGlite) rồi frontend
npm run typecheck    # kiểm kiểu FE + BE
```

Ghi chú:
- Cấu hình nằm ở `backend/.env`, chép từ `backend/.env.example`.
- Tài khoản dev (admin, demo, nhân viên thử từng vai trò qua `DEV_STAFF_PASSWORD`) và mật khẩu mẫu xem trong `.env.example`. Các tài khoản này chỉ dùng ở máy dev.
- Xoá `backend/data/` để seed lại dữ liệu.
- Test trên PostgreSQL thật: `TEST_DATABASE_URL=postgres://... npm run test -w backend`. Máy không cài Postgres thì dùng gói `embedded-postgres` ngoài repo, và dừng bằng `pg_ctl stop -m fast` (kill thẳng sẽ hỏng thư mục data).

## 4. Lịch sử các đợt làm

| Ngày | Commit | Nội dung |
|---|---|---|
| 15/10 | `6b5892f` | Khởi tạo VNStock Sim: sàn chứng khoán VN mô phỏng |
| 15/10 | `7547ca2` | Nguồn giá thật qua data-service (VCI) |
| 15/10 | `5da05e9` | Chuẩn bị triển khai: PostgreSQL, quên mật khẩu, log, rate limit |
| 15/10 | `b5f65dc` | Quản trị & vận hành: `/admin`, khoá tài khoản, tạm ngừng, sao lưu |
| 16/10 | `47cb4b7` | Bảo mật, loại lệnh, ký quỹ, sự kiện quyền, xếp hạng, giám sát |
| 16/10 | `2006632` | Docker Compose, Caddy HTTPS, CI GitHub Actions |
| 16/10 | `a2ddac3`, `c4ec742` | Tài liệu và điều khoản |
| 16/10 | `326d3d4` | Lệnh HNX, nhiều danh sách theo dõi, cảnh báo giá, báo cáo lãi lỗ, bộ lọc |
| 16/10 | `2bb1271` | Sửa launch.json dùng đường dẫn tương đối |
| 16/10 | `951050e` | Trang giới thiệu, đường dẫn `/bang-gia` |
| 16/10 | `28da9cf`, `24b9d7c`, `45ef329` | **Chuyển sang sàn coin Spot VNCoin**: shared, backend giá Binance, giao diện ví / thị trường / giao dịch |
| 17/10 | `42318ce`, `df1fc88` | **Đợt 3: trách nhiệm, dấu vết, chatbox CSKH** |
| 17/10 | `d8b2675` | **Đợt 4: quản trị giá 2 chế độ** |
| 17/10 | `7d8da4d` | **Đợt 5: phân quyền theo chức năng + duyệt 2 người** |
| 17/10 | `f1d7954` | **Đợt 6: vá lỗ hổng lách luật duyệt 2 người** |
| 17/10 | `36aee71` | **Đợt 7: chặn nhân viên giao dịch cặp chỉnh giá, email báo người duyệt** |
| 17/10 | `dbd867a` | **Đợt 8: dừng khẩn, giám sát gian lận, đối soát hằng ngày** |

### Sàn coin Spot (nền tảng)

- Số tiền dạng chuỗi thập phân (Big.js, `NUMERIC(36,18)`), không dùng số thực.
- Bộ lọc giống Binance: bước giá, bước khối lượng, giá trị tối thiểu, lệch giá tối đa.
- Loại lệnh: LIMIT, MARKET, LIMIT_MAKER, STOP_LOSS_LIMIT, TAKE_PROFIT_LIMIT, OCO.
- Phí maker / taker; mỗi thay đổi số dư ghi sổ cái (`ledger`).
- Mất kết nối Binance thì tự giả lập để sàn không đứng.

### Đợt 3: trách nhiệm, dấu vết, CSKH

Mục tiêu: việc gì xảy ra cũng phải biết ai làm, lúc nào, từ đâu.

- **Bảng chỉ ghi thêm**: `admin_audit_log`, `auth_events`, `support_messages`. Trigger `append_only_guard` chặn UPDATE / DELETE.
- **Nhật ký lệnh** `order_events`: ai đặt / sửa / huỷ lệnh, có IP. Khách, nhân viên hay hệ thống đều phân biệt được.
- **Nhật ký đăng nhập**. Sai mật khẩu 5 lần trong 15 phút thì tạm chặn.
- **Xoá tài khoản = ẩn danh**: giữ lại lệnh, sổ cái, tin nhắn; thu hồi mọi phiên đăng nhập.
- **Điều chỉnh số dư**:
  - không ai được tự điều chỉnh hoặc tự duyệt cho mình;
  - từ `ADJUST_APPROVAL_USDT` trở lên phải có người thứ hai duyệt;
  - mọi đề xuất bồi hoàn của CSKH cũng phải qua duyệt.
- **CSKH**:
  - khách chat ở `/ho-tro`, nhân viên trả lời ở `/cskh`;
  - hạn trả lời (SLA), cảnh báo quá hạn, tự đóng sau 7 ngày;
  - nhân viên xem hồ sơ khách chỉ qua yêu cầu hỗ trợ, và mỗi lần xem đều ghi nhật ký.
- **Tài khoản bị khoá**: đăng nhập đúng chỉ nhận "vé hỗ trợ" để vào `/ho-tro-khoa` nhắn CSKH, không giao dịch được.

### Đợt 4: quản trị giá 2 chế độ cho từng cặp

- **Giá thực tế (LIVE)**: theo Binance.
- **Giá điều chỉnh (MANUAL)**, có hai cách:
  - đặt giá ngay;
  - chạy **kịch bản**: đi từ giá hiện tại tới giá đích trong N phút, dao động ±%.
- Nhà đầu tư thấy nhãn "Giá điều chỉnh" trên cặp đó.
- Mọi thao tác ghi nhật ký `PRICE_MODE_MANUAL / PRICE_SET / PRICE_MODE_LIVE`.

### Đợt 5: phân quyền theo chức năng + duyệt 2 người

Vai trò (quyền chi tiết ở `shared/src/permissions.ts`):

| Vai trò | Được làm | Không được làm |
|---|---|---|
| USER | Giao dịch tài khoản của mình | Mọi thứ quản trị |
| SUPPORT (CSKH) | Trả lời yêu cầu, xem hồ sơ khách qua yêu cầu, huỷ hộ lệnh, khoá khẩn, đề xuất bồi hoàn | Duyệt, chỉnh giá |
| ADMIN (quản trị hệ thống) | Nhân viên & phân quyền, tài khoản người dùng, sao lưu / khôi phục, giám sát, nhật ký | **Chỉnh tiền, chỉnh giá** |
| MARKET_OPS (vận hành thị trường) | Cặp giao dịch, giá, biểu phí, thông báo, tạm ngừng, dừng khẩn; duyệt đề xuất thị trường của người khác | Tiền |
| FINANCE (tài chính) | Điều chỉnh / đặt lại số dư, duyệt bồi hoàn & điều chỉnh lớn; xem doanh thu, đối soát | Giá, thị trường |
| RISK (rủi ro & giám sát) | Khoá tài khoản, huỷ hộ lệnh, tạm ngừng cặp, dừng khẩn, xem nhật ký, giám sát gian lận; duyệt đề xuất thị trường | Tiền, giá |
| AUDITOR (kiểm toán) | **Chỉ đọc**: tổng quan, người dùng, lệnh, nhật ký, giám sát, gian lận, tài chính | Mọi thao tác |

**Duyệt 2 người** (`approval_requests`):
- Người duyệt phải khác người đề xuất và phải có quyền duyệt tương ứng.
- Đề xuất có thời hạn; quá hạn thì phải đề xuất lại.

| Loại đề xuất | Khi nào | Ai duyệt |
|---|---|---|
| PRICE_SET | Chỉnh giá lệch > `PRICE_APPROVAL_PCT` (5%) | market.approve |
| SYMBOL_LIST / SYMBOL_DELIST | Niêm yết / huỷ niêm yết | market.approve |
| MARKET_HALT | Tạm ngừng toàn sàn (thông thường) | market.approve |
| MARKET_RESUME | Mở lại toàn sàn | market.approve |
| DATA_RESTORE | Khôi phục dữ liệu (kiểm sha256 lúc duyệt) | data.approve |
| ROLE_SET | Cấp / đổi vai trò nhân viên, thu quyền ADMIN | staff.manage |
| ACCOUNT_RESET | Đặt lại tài khoản khách | finance.approve |

Riêng điều chỉnh số dư dùng bảng `balance_adjust_requests`, người duyệt cần quyền `finance.approve`.

**Khu quản trị mặc định cấm**: route nào thiếu `need('quyền')` thì `assertRoutesGuarded` làm server **không khởi động**.

### Đợt 6: vá lỗ hổng lách luật

- Cấp / đổi vai trò cần ADMIN khác duyệt. Ngoại lệ: khi chỉ có 1 ADMIN thì áp dụng ngay để khởi tạo hệ thống.
- Đặt lại tài khoản khách phải qua Tài chính duyệt.
- Điều chỉnh số dư trực tiếp được **cộng dồn 24 giờ** theo từng người làm, tính cả theo từng khách lẫn tổng. Vượt ngưỡng thì tự thành yêu cầu duyệt, nên không chia nhỏ để lách được.
- Khôi phục dữ liệu xong thì huỷ mọi đề xuất đang chờ. File khôi phục tự xoá khi đề xuất kết thúc.

### Đợt 7: chống giao dịch nội gián

- Nhân viên (mọi vai trò) **không được đặt / sửa lệnh** trên cặp đang ở giá điều chỉnh.
- Khi chỉnh giá: huỷ mọi lệnh mở của nhân viên trên cặp đó.
- Nếu có nhân viên vừa đặt lệnh cặp đó trong 60 phút, chỉnh giá dù nhỏ cũng phải qua duyệt.
- **Email**:
  - báo mọi người có quyền duyệt khi có đề xuất mới (trừ người đề xuất);
  - khi đổi vai trò, báo chính chủ và các ADMIN khác.
- Bài học: gọi `db.*` bên trong `db.tx` làm PGlite khoá chết (từng dính ở route chỉnh giá). Đã sửa và có test.

### Đợt 8: dừng khẩn, giám sát gian lận, đối soát

- **Dừng khẩn toàn sàn** (`market.halt`):
  - 1 người bấm là có hiệu lực ngay; email báo người có quyền xác nhận.
  - Người thứ hai xác nhận thì thành tạm ngừng chính thức.
  - **Không ai xác nhận thì sau 15 phút sàn tự mở lại**.
  - Báo nhầm thì huỷ ngay.
  - Mở lại sàn (khi đã tạm ngừng chính thức) cần đề xuất MARKET_RESUME.
- **Giám sát gian lận bảng xếp hạng** (tab "Giám sát gian lận"; Rủi ro và Kiểm toán xem được):
  - nhiều tài khoản đăng nhập cùng IP;
  - tự đặt lại tài khoản ≥ 3 lần;
  - đặt / huỷ lệnh dồn dập (ngưỡng ở `FRAUD_RULES`);
  - loại / đưa lại tài khoản khỏi bảng xếp hạng, bắt buộc ghi lý do và ghi nhật ký;
  - tài khoản nhân viên vốn không có trên bảng xếp hạng.
- **Đối soát tự động hằng ngày** (tab "Tài chính & đối soát"):
  - với mỗi tài sản của mỗi tài khoản: tổng sổ cái = khả dụng + đang khoá = số dư sau dòng sổ cái cuối;
  - có tiền đang khoá thì phải có lệnh mở;
  - tổng phí ghi sổ cái phải bằng tổng phí khớp lệnh;
  - lệch thì email Tài chính và Kiểm toán; chạy tay được;
  - kèm **báo cáo doanh thu phí** theo ngày, maker / taker, theo cặp.

### Đợt 9: hộp chat nổi + trợ lý AI (Claude)

- Nút chat tròn góc phải mọi trang cho khách đã đăng nhập; tab **Trợ lý AI** và tab **Nhân viên**.
- Trợ lý trả lời dạng chữ chạy dần (stream). Nó biết biểu phí hiện hành, loại lệnh, và số dư / lệnh của chính khách.
- Trợ lý không thao tác được tài khoản, không khuyến nghị đầu tư, không hỏi mật khẩu.
- **Gặp nhân viên**: tạo yêu cầu hỗ trợ kèm đoạn hội thoại với AI.
- Bật bằng `ANTHROPIC_API_KEY` trong `backend/.env`; không có khoá thì chỉ nhắn nhân viên.
- Giới hạn 15 câu / 10 phút, 80 câu / ngày mỗi khách.

## 5. Tab quản trị (`/admin`)

| Tab | Quyền cần |
|---|---|
| Tổng quan | admin.view |
| Người dùng (khoá, điều chỉnh số dư, phân quyền) | users.view |
| Lệnh giao dịch (theo dõi, huỷ hộ) | admin.view |
| Hàng chờ duyệt | admin.view |
| Vận hành thị trường (nguồn giá, tạm ngừng, dừng khẩn, thông báo, biểu phí) | admin.view |
| Giá thị trường (LIVE / MANUAL, kịch bản) | admin.view |
| Cặp giao dịch (niêm yết, huỷ niêm yết, tạm ngừng cặp) | admin.view |
| Giám sát gian lận | risk.monitor |
| Tài chính & đối soát | finance.view |
| Dữ liệu & sao lưu | system.view |
| Giám sát (chỉ số vận hành, cảnh báo) | system.view |
| Nhật ký (nhật ký quản trị, log máy chủ) | audit.view / system.view |

Nút thao tác trong từng tab ẩn / hiện theo quyền của người đang đăng nhập (`useAdminMe().can()`).

## 6. Quy tắc bắt buộc khi sửa code

1. **Không UPDATE / DELETE** các bảng chỉ ghi thêm (`admin_audit_log`, `auth_events`, `support_messages`).
2. **Mọi thao tác quản trị phải gọi `audit()`**.
3. **Route quản trị mới phải có `need('quyền')`**, không thì server không chạy.
4. **Trong `db.tx(fn)` chỉ dùng `tx`, không gọi `db.*`** (khoá chết PGlite).
5. Mọi đường đổi trạng thái lệnh phải truyền `by: OrderActor` để ghi `order_events`.
6. **Mọi chỗ cộng / trừ số dư phải ghi `ledger`**, không thì đối soát báo lệch.
7. Bảng mới có khoá ngoại tới `users` phải thêm vào `BACKUP_TABLES` (đúng thứ tự khoá ngoại).
8. Thêm xử lý luồng giá Binance mới thì phải kiểm `s.control` (cặp MANUAL bỏ qua giá Binance).
9. Router công khai / router mới phải `app.use` **trước** `tradingRoutes` (router đó gắn `requireAuth` cho cả `/api`).
10. Với Postgres thật: luôn `await` các UPDATE, cập nhật một chiều dùng `GREATEST` / `LEAST`.
11. Không chạy prettier lên cả file (repo không có cấu hình, sẽ định dạng lại toàn bộ).
12. Không commit `package-lock.json` khi nó chỉ khác ký tự xuống dòng (CRLF).

## 7. Kiểm thử hiện tại

| Bộ test | Kết quả |
|---|---|
| Backend trên PGlite | 113 đạt, 3 bỏ qua (chỉ chạy khi có Postgres) |
| Backend trên PostgreSQL 16 | 111/111 (đợt 8, chưa chạy lại cho đợt 9) |
| Frontend | 19/19 |
| CI GitHub Actions (4 bước) | Đạt cho mọi lần đẩy |

File test backend:
- `spot-engine`, `market`, `auth`, `db`, `shared`, `watchlists-alerts`, `ops`;
- `accountability-support`, `price-control`, `roles-approvals`, `admin-ops`, `support-ai`.

## 8. Còn thiếu / việc nên làm tiếp

- **Độ lệch giá tích luỹ khi mất kết nối Binance**: cặp giả lập có thể trôi xa giá thật, cần cơ chế kéo về khi có lại nguồn.
- **Bảo mật nhân viên**: giới hạn IP được vào `/admin`, phiên đăng nhập nhân viên ngắn hơn.
- **README và tài liệu nghiệp vụ** (Claude Doc "Tài liệu nghiệp vụ VNStock Sim") vẫn mô tả sàn chứng khoán cũ.
- **Nến của giá điều chỉnh** chỉ giữ trong bộ nhớ; khởi động lại máy chủ thì mất.
- **Khởi tạo khi chỉ có 1 ADMIN**: cấp vai trò không cần duyệt. Đây là cố ý, nhưng nên có 2 ADMIN sớm.
- **Khôi phục dữ liệu bằng dòng lệnh (CLI)** bỏ qua duyệt 2 người; chỉ người có quyền máy chủ mới chạy được.
- **Hai người thông đồng** thì phần mềm không ngăn được. Chỉ dựa vào nhật ký, email cảnh báo và kiểm toán.
