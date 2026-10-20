# VNCoin — Sàn giao dịch coin Spot mô phỏng

Web giao dịch coin kiểu **Binance Spot** ở chế độ **giao dịch ảo (paper trading)**: giá, sổ lệnh, giao dịch và nến lấy **thật từ Binance** (trễ dưới 1 giây), mỗi tài khoản nhận **10.000 USDT ảo** để tập mua bán 30 cặp USDT lớn với đúng bộ lọc, loại lệnh, trạng thái lệnh và biểu phí của Binance.

> ⚠️ Không có tiền hay coin thật, không nạp rút on-chain. Lệnh khớp với sổ lệnh thật của Binance nhưng **không được gửi lên Binance**. Mất kết nối Binance thì hệ thống tự chuyển sang giá giả lập (nhãn "Giả lập"). Nội dung không phải khuyến nghị đầu tư.

Dự án khởi đầu là **VNStock Sim** (sàn chứng khoán Việt Nam mô phỏng). Từ migration `200_crypto_spot.sql` đã chuyển hẳn sang sàn coin; toàn bộ nghiệp vụ chứng khoán (HOSE/HNX, VNĐ, T+2, ký quỹ, sự kiện quyền, data-service Python) đã gỡ bỏ. Tổng hợp quá trình làm: [docs/TONG-HOP-DU-AN.md](docs/TONG-HOP-DU-AN.md).

## Tính năng

| Trang | Nội dung |
|---|---|
| **Giới thiệu** (`/gioi-thieu`, khách vào `/` cũng thấy) | Landing page có bảng giá xem trước chạy dữ liệu thật, luật chơi theo phí và bộ lọc thật, hỏi đáp |
| **Thị trường** (`/`, `/thi-truong`) | Danh sách cặp: giá, % 24h, cao / thấp, khối lượng, sparkline; tab Yêu thích (nhiều danh sách theo dõi), USDT, Tăng mạnh, Giảm mạnh, Khối lượng lớn; tìm kiếm |
| **Giao dịch** (`/trade/:symbol`) | Bố cục kiểu Binance: header cặp (giá, % 24h, cao / thấp, KL 24h), biểu đồ nến TradingView 1m → 1M + MA7/25/99 + khối lượng, sổ lệnh 20 mức có gộp giá theo bội số tick, giao dịch thị trường realtime, danh sách cặp; form đặt lệnh **Giới hạn / Thị trường / Stop-limit / OCO** với cột Mua và Bán song song, thanh trượt 25–100% số dư, TIF (GTC / IOC / FOK), Post-only; lỗi bộ lọc báo ngay khi nhập; cảnh báo giá; tab Lệnh mở, Lịch sử lệnh, Lịch sử khớp, Tài sản |
| **Ví** (`/vi`) | Tổng tài sản ước tính (USDT và BTC), lãi / lỗ hôm nay, bảng tài sản (khả dụng / đang khoá / giá vốn bình quân / giá trị USDT), biểu đồ NAV so với BTC, donut phân bổ, trả phí bằng BNB, đặt lại vốn ảo |
| **Lịch sử** (`/lich-su`) | Lịch sử lệnh, lịch sử khớp (phí, lãi lỗ đã thực hiện), biến động số dư, báo cáo lãi lỗ theo tháng; lọc theo cặp và thời gian; xuất CSV |
| **P2P** (`/p2p`, `/p2p/don`, `/p2p/thuong-nhan`, `/ngan-hang`) | Chợ P2P kiểu Binance: mua / bán USDT, BTC, ETH, BNB bằng VNĐ với **thương nhân đã xác minh** (đặt cọc 2.000 USDT, được bộ phận Vận hành P2P duyệt). Coin của bên bán nằm trong ký quỹ; người mua chuyển khoản qua **ngân hàng giả lập**, bên bán xác nhận rồi nhả coin; quá hạn tự huỷ; khiếu nại có nhân viên phân xử, trừ cọc bồi thường. Xem [docs/P2P.md](docs/P2P.md) |
| **Cộng đồng** (`/cong-dong`) | Như Binance Square: bài viết gắn `$coin` (giá trực tiếp), nhận định Tăng / Giảm, chia sẻ lệnh đã khớp / ROI có nhãn xác minh, bình luận, thích, theo dõi, coin được bàn nhiều 24h. Bộ lọc tự động chặn tục tĩu / thông tin cá nhân / link lạ, giữ lại bài lừa đảo / kéo giá chờ duyệt; báo cáo, cảnh cáo / cấm đăng, khiếu nại. Xem [docs/CONG-DONG.md](docs/CONG-DONG.md) |
| **Xếp hạng** (`/xep-hang`) | ROI theo NAV USDT: 7 ngày / 30 ngày / 3 tháng / từ đầu; tên hiển thị tự chọn hoặc che bớt; tuỳ chọn không tham gia |
| **Hỗ trợ** (`/ho-tro`, `/cskh`) | Hộp chat nổi với trợ lý AI (Claude) và nhân viên CSKH, vé hỗ trợ cho tài khoản bị khoá (`/ho-tro-khoa`); bàn làm việc CSKH cho nhân viên. Xem [docs/CSKH.md](docs/CSKH.md) |
| **Xác minh danh tính** (`/xac-minh`) | KYC theo cấp như sàn thật: cấp 0 giao dịch Spot; cấp 1 (danh tính) mở P2P hạn mức 200 triệu ₫ / ngày; cấp 2 (nâng cao) hạn mức 2 tỷ ₫ / ngày và được làm thương nhân. Hồ sơ khai báo giả lập, mã hoá, bộ phận Tuân thủ duyệt. Xem [docs/KYC-AML.md](docs/KYC-AML.md) |
| **Biểu phí & VIP** (`/phi`) | Phí Spot giảm theo cấp VIP 0 → 9 như Binance: đạt cấp khi cả khối lượng 30 ngày và số BNB nắm giữ đủ ngưỡng (ngưỡng thật × 1/100), tính lại 00:00 UTC, phí chốt vào lệnh lúc đặt |
| **Dữ liệu cá nhân** (`/du-lieu-ca-nhan`) | Tải toàn bộ dữ liệu của mình (JSON), yêu cầu xoá tài khoản; người phụ trách bảo vệ dữ liệu (DPO) xử lý, giao dịch được giữ ẩn danh |
| **Tài khoản** | Đăng ký nhận 10.000 USDT ảo, xác thực email, quên / đặt lại mật khẩu, xác thực 2 lớp (TOTP + mã khôi phục), lịch sử đăng nhập, tài khoản demo |
| **Quản trị** (`/admin`) | Xem mục [Quản trị & vận hành](#quản-trị--vận-hành) |

Thêm: giao diện tối / sáng, responsive mobile, tiêu đề tab hiển thị giá như Binance, thông báo khớp lệnh realtime.

## Công nghệ

- **Frontend**: React 18 + Vite + TypeScript + Tailwind CSS v4, React Router, TanStack Query, Zustand, Socket.io client, TradingView Lightweight Charts v5, motion, lucide-react, sonner
- **Backend**: Node.js 24 + Express + TypeScript (tsx), Socket.io, Zod, JWT + bcrypt, helmet, rate limit; WebSocket có sẵn của Node để nhận luồng Binance (không thêm thư viện)
- **CSDL**: PostgreSQL nhúng **PGlite** cho dev / test (chạy ngay, không cần cài); **PostgreSQL 16** khi đặt `DATABASE_URL`
- **Số thập phân**: `big.js` trong `@vss/shared`; CSDL `NUMERIC(36,18)`; API truyền số dạng chuỗi như Binance (`"0.00012000"`)
- **Triển khai**: Docker Compose (app + Postgres + Caddy HTTPS), CI GitHub Actions — xem [docs/DEPLOY.md](docs/DEPLOY.md)
- **Chung**: package `@vss/shared` chứa bộ lọc, phí, kiểu dữ liệu, phân quyền và schema validate dùng cho cả FE và BE

## Chạy nhanh

Yêu cầu Node.js ≥ 22 (khuyến nghị 24) và máy gọi được `data-api.binance.vision` (không được thì vẫn chạy bằng giá giả lập).

```bash
npm install
cp backend/.env.example backend/.env   # rồi đổi JWT_SECRET
npm run dev
```

- Web: http://localhost:5173 · API: http://localhost:4000. Mở web trên điện thoại cùng mạng LAN: `npm run dev:mobile`.
- Lần chạy đầu tự tạo 30 cặp USDT (bộ lọc lấy thật từ `exchangeInfo`, offline thì dùng file dự phòng `backend/src/market/fallbackSymbols.json`), tài khoản demo, tài khoản quản trị và ở dev cả tài khoản nhân viên thử từng vai trò (email / mật khẩu mẫu trong `backend/.env.example`). Trang đăng nhập có nút **"Trải nghiệm nhanh với tài khoản demo"**.
- Xoá thư mục `backend/data` để tạo lại dữ liệu từ đầu.

Các lệnh khác:

```bash
npm test            # test backend (bộ lọc, phí, khớp lệnh Spot, OCO, phân quyền, đối soát…) + frontend (vitest)
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm run test -w backend   # test backend trên PostgreSQL thật
npm run typecheck   # kiểm tra kiểu FE + BE
npm run build       # build frontend production
npm run symbols:update -w backend   # cập nhật file bộ lọc dự phòng từ Binance
npm run loadtest -w backend -- --users 30 --orders 20   # khảo sát tải máy chủ đang chạy
```

## Cấu hình (`backend/.env`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `MARKET_FEED` | `binance` | `binance`: dữ liệu thật, mất kết nối thì tự giả lập; `sim`: chỉ giả lập (offline, test) |
| `BINANCE_REST_URLS` | `https://data-api.binance.vision,https://api.binance.com` | REST công khai, thử lần lượt |
| `BINANCE_WS_URL` | `wss://data-stream.binance.vision` | WebSocket dữ liệu thị trường |
| `BINANCE_SIM_AFTER_MS` | `5000` | Mất dữ liệu thật quá lâu thì chuyển sang giả lập |
| `MARKET_FLUSH_MS` | `200` | Chu kỳ khớp lệnh chờ và phát dữ liệu cho client |
| `JWT_SECRET` | — | Khoá ký token, đặt chuỗi ngẫu nhiên dài |
| `DATA_DIR` | `./data/pgdata` | Nơi lưu CSDL PGlite |
| `DATABASE_URL` | — | Có giá trị → PostgreSQL thật thay PGlite |
| `DEMO_EMAIL` / `DEMO_PASSWORD` | demo | Tài khoản demo được seed (để trống để tắt) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@vncoin.local` (dev) | Quản trị viên đầu tiên; bắt buộc tự đặt khi `NODE_ENV=production` |
| `PUBLIC_URL`, `SMTP_*`, `MAIL_FROM` | — | Link và máy chủ gửi email (để trống: email chỉ ghi ra log) |
| `DATA_ENCRYPTION_KEY` | — | Khoá mã hoá bí mật 2FA (≥ 32 ký tự, nên đặt khi chạy thật) |
| `REQUIRE_EMAIL_VERIFICATION` | `false` | `true` = phải xác thực email mới được đặt lệnh |
| `ADJUST_APPROVAL_USDT`, `PRICE_APPROVAL_PCT` | `1000`, `5` | Ngưỡng điều chỉnh số dư / chỉnh giá cần người thứ hai duyệt |
| `ANTHROPIC_API_KEY`, `AI_MODEL` | —, `claude-haiku-5-5` | Trợ lý AI trong hộp chat (để trống: tắt) |
| `BACKUP_DIR`, `METRICS_TOKEN`, `ALERT_EMAILS`, `ALERT_WEBHOOK_URL` | — | Sao lưu tự động trước khi khôi phục, endpoint Prometheus, nơi nhận cảnh báo |

Danh sách đầy đủ và giải thích: [`backend/.env.example`](backend/.env.example).

## Dữ liệu thị trường

- **REST** ([`backend/src/market/binance/rest.ts`](backend/src/market/binance/rest.ts)): `exchangeInfo` (bộ lọc), `ticker/24hr`, `depth`, `klines`, `avgPrice`. Ưu tiên `data-api.binance.vision`, dự phòng `api.binance.com`; đếm trọng số request để không vượt giới hạn 6000 / phút.
- **WebSocket** ([`binance/stream.ts`](backend/src/market/binance/stream.ts)): ghép luồng `!miniTicker@arr`, `<sym>@depth20@100ms`, `<sym>@aggTrade`, `<sym>@kline_1m` cho các cặp đang bật; tự nối lại với backoff, chủ động nối lại trước mốc ngắt 24 giờ của Binance.
- **Giả lập** ([`simFeed.ts`](backend/src/market/simFeed.ts)): random walk quanh giá thật cuối cùng, sinh sổ lệnh đúng `tickSize` / `stepSize`. Chạy khi mất dữ liệu quá `BINANCE_SIM_AFTER_MS` hoặc khi `MARKET_FEED=sim`; có lại nguồn thì tự quay về giá thật. `GET /api/market/status` và sự kiện `feed` báo `LIVE` / `SIM`.
- **Giá điều chỉnh**: quản trị viên có thể chuyển từng cặp sang chế độ `MANUAL` (giá do sàn điều chỉnh, có kịch bản) thay cho giá Binance; chỉnh lệch lớn cần người thứ hai duyệt.
- **Nến**: có nguồn thật thì proxy `klines` của Binance (cache ngắn) và ghép nến đang chạy; giả lập thì tự tổng hợp từ nến 1 phút trong bộ nhớ.
- **Danh sách cặp mặc định** (`DEFAULT_SYMBOLS` trong `shared`): BTC, ETH, BNB, SOL, XRP, DOGE, ADA, TRX, AVAX, LINK, DOT, TON, SUI, NEAR, LTC, BCH, UNI, AAVE, ATOM, APT, ARB, OP, INJ, FIL, PEPE, SHIB, WLD, FET, HBAR, ETC (cặp với USDT). Quản trị viên niêm yết thêm hoặc huỷ niêm yết được.

## Quy tắc nghiệp vụ

Định nghĩa trong [`shared/src/`](shared/src) (`filters.ts`, `orders.ts`, `rules.ts`), dùng chung cho FE (báo lỗi khi nhập) và BE (từ chối lệnh). Theo tài liệu Binance Spot API:

- **Bộ lọc từng cặp** lấy thật từ `exchangeInfo`: `PRICE_FILTER` (giá là bội số `tickSize`), `LOT_SIZE` / `MARKET_LOT_SIZE` (`minQty`, `maxQty`, bội số `stepSize`), `NOTIONAL` (`minNotional`, ví dụ 5 USDT, áp dụng cả lệnh market), `PERCENT_PRICE_BY_SIDE` (giá lệnh trong khoảng hệ số so với giá trung bình 5 phút), `MAX_NUM_ORDERS` 200 và `MAX_NUM_ALGO_ORDERS` 5 mỗi cặp.
- **Giao dịch 24/7**, không phiên, không biên độ, không T+2: khớp xong tài sản về ví ngay. Ngày chốt NAV và lãi lỗ theo **00:00 UTC**.
- **Loại lệnh**: `LIMIT` (TIF `GTC` / `IOC` / `FOK`), `LIMIT_MAKER` (post-only, bị từ chối nếu khớp ngay), `MARKET` theo khối lượng coin hoặc theo số USDT (`quoteOrderQty`), `STOP_LOSS_LIMIT` và `TAKE_PROFIT_LIMIT` (kích hoạt theo giá khớp gần nhất), **OCO** (một chân `LIMIT_MAKER` + một chân `STOP_LOSS_LIMIT`; một chân khớp hoặc kích hoạt thì chân kia tự huỷ, số dư chỉ khoá một lần). Sửa lệnh theo kiểu cancel-replace (mất thứ tự hàng đợi).
- **Trạng thái lệnh**: `NEW`, `PARTIALLY_FILLED`, `FILLED`, `CANCELED`, `EXPIRED`, `REJECTED`.
- **Ví**: số dư theo từng tài sản gồm `free` và `locked`. Lệnh mua khoá USDT theo `giá × khối lượng` (market theo `quoteOrderQty` khoá đúng số USDT đó), lệnh bán khoá coin. Không bán khống, số dư luôn ≥ 0 (CHECK trong CSDL).
- **Phí**: maker / taker 0,1%, thu bằng **tài sản nhận về** (mua BTC trừ phí bằng BTC, bán trừ bằng USDT); bật "trả phí bằng BNB" và đủ BNB thì giảm 25%. Phí chốt vào từng lệnh lúc đặt, đổi biểu phí không ảnh hưởng lệnh đang chờ.
- **Cách khớp mô phỏng**: lệnh vào là taker, ăn dần từng mức giá của sổ lệnh thật (có trượt giá; phần đã ăn được nhớ tới khi sổ lệnh cập nhật). Lệnh limit đang chờ là maker: khớp ở đúng giá đặt khi sổ lệnh cắt qua hoặc giao dịch thật đi qua mức giá đó, khối lượng tối đa bằng khối lượng giao dịch thật lúc đó. Người dùng không khớp với nhau nên không cần chống tự khớp (STP). Lệnh của người dùng không làm thay đổi thị trường thật.
- **Lãi lỗ** tính theo giá vốn bình quân từng coin (`balances.cost_usdt`), quy đổi USDT.
- **Cảnh báo giá**: giá vượt lên, giá xuống dưới, % thay đổi 24h tăng / giảm; báo 1 lần rồi dừng.
- **Đặt lại tài khoản**: huỷ lệnh, xoá số dư, cấp lại 10.000 USDT.
- Biểu phí và danh sách cặp chỉnh được ở trang Quản trị (lưu bền trong `market_meta`).

## Quản trị & vận hành

- Trang **Quản trị** (`/admin`) chia tab theo **vai trò nhân viên** (Quản trị hệ thống, Vận hành thị trường, Tài chính, Rủi ro & giám sát, Vận hành P2P, Tuân thủ + Trưởng Tuân thủ (MLRO), Bảo vệ dữ liệu cá nhân (DPO), Kiểm duyệt nội dung, Kiểm toán, CSKH + Trưởng nhóm CSKH; ma trận và lý do phân tách: [docs/VAI-TRO.md](docs/VAI-TRO.md)): tổng quan, người dùng (khoá / mở khoá, đổi vai trò, điều chỉnh số dư theo tài sản), lệnh, hàng chờ duyệt 2 người, tạm ngừng / dừng khẩn, giá thị trường (LIVE / MANUAL), cặp giao dịch, biểu phí, giám sát gian lận bảng xếp hạng, tài chính & đối soát, dữ liệu & sao lưu, giám sát vận hành, nhật ký. Bảng quyền chi tiết: [docs/TONG-HOP-DU-AN.md](docs/TONG-HOP-DU-AN.md#5-tab-quản-trị-admin).
- **Tuân thủ (KYC/AML)**: duyệt hồ sơ KYC, cảnh báo chống rửa tiền quét tự động trên đơn P2P (đơn lớn, khối lượng cao, chia nhỏ, mua vào bán ra nhanh, nhiều đối tác), báo cáo giao dịch đáng ngờ (STR, chỉ ghi thêm; chuyên viên lập, Trưởng Tuân thủ / MLRO duyệt nộp), hạn chế tài khoản; gỡ hạn chế cần MLRO duyệt. Kiểm toán xem được. Chi tiết: [docs/KYC-AML.md](docs/KYC-AML.md).
- **Thương nhân P2P**: Vận hành P2P duyệt đơn xin, tạm ngừng, trừ cọc (Quản trị → Thương nhân P2P) và xử lý khiếu nại đơn P2P (`/cskh` → Khiếu nại P2P); Vận hành thị trường chỉnh tham số P2P (tỷ giá tham chiếu, phí, cọc, điều kiện). Chi tiết: [docs/P2P.md](docs/P2P.md).
- Thao tác lớn (điều chỉnh số dư lớn, chỉnh giá lệch nhiều, niêm yết / tạm ngừng cặp, đổi vai trò, khôi phục dữ liệu, mở lại sàn) cần **người thứ hai duyệt**. Mọi thao tác ghi vào `admin_audit_log` (chỉ ghi thêm); mọi thay đổi trạng thái lệnh ghi vào `order_events`.
- Tài khoản quản trị đầu tiên tạo lúc khởi động từ `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
- Giám sát: `GET /api/health`, `GET /api/metrics` (Prometheus, cần `METRICS_TOKEN`), cảnh báo tự động 30 giây / lần (kể cả mất nguồn giá Binance) gửi email + webhook. Triển khai, sao lưu, danh sách kiểm tra bảo mật: [docs/DEPLOY.md](docs/DEPLOY.md).
- Trang pháp lý mẫu: `/dieu-khoan`, `/chinh-sach-bao-mat` (bản demo, cần luật sư rà soát trước khi dùng thật).

## Kiến trúc

```
Binance REST + WS ──▶ MarketService ──events──▶ Socket.io ──▶ React (Zustand store)
 (exchangeInfo,        │ sổ lệnh, ticker 24h, giá TB 5 phút,     tickers / feed / symbols
  depth, aggTrade,     │ giao dịch, nến; SimFeed khi mất nguồn   depth / trades / kline (theo cặp)
  kline, miniTicker)   │                                         order / fill / account (theo người dùng)
                       └─hooks.onTick──▶ SpotEngine ──▶ PGlite / PostgreSQL
                                         │ đặt / sửa / huỷ, khớp taker + maker,  ▲
                                         │ stop, OCO, phí, ví (free / locked)    │
                                         ├ PriceAlerts, NAV 00:00 UTC, xếp hạng  │
                                         └ order_events, ledger                  │
Express REST /api/* ─────────────────────────────────────────────────────────────┘
```

- `MarketService` chạy vòng flush mỗi `MARKET_FLUSH_MS`: gọi `hooks.onTick(changed, trades)` để engine kích hoạt stop và khớp lệnh chờ, rồi phát dữ liệu cho client.
- **PostgreSQL thật**: đặt `DATABASE_URL` — `Database` trong `backend/src/db.ts` tự dùng client `pg` (giao diện `many/one/exec/tx` giữ nguyên), migration `backend/migrations/*.sql` tự chạy khi khởi động.

### Sơ đồ dữ liệu (rút gọn)

```mermaid
erDiagram
  users ||--|| accounts : has
  users ||--o{ balances : holds
  users ||--o{ orders : places
  users ||--o{ fills : owns
  users ||--o{ ledger : records
  users ||--o{ nav_daily : snapshots
  users ||--o{ watchlist_lists : owns
  watchlist_lists ||--o{ watchlists : contains
  users ||--o{ price_alerts : sets
  order_lists ||--o{ orders : "OCO"
  orders ||--o{ fills : fills
  orders ||--o{ order_events : logs
  symbols ||--o{ orders : trades
  accounts { numeric initial_usdt numeric contributed_usdt bool pay_fee_with_bnb }
  balances { text asset numeric free numeric locked numeric cost_usdt }
  orders { text type text side text time_in_force numeric price numeric stop_price numeric orig_qty numeric executed_qty text status text locked_asset numeric locked_amount }
  fills { numeric price numeric qty numeric quote_qty numeric commission text commission_asset bool is_maker numeric realized_pnl }
  symbols { text symbol text base_asset text quote_asset jsonb filters text status text price_mode }
```

## API

| Method | Đường dẫn | Mô tả |
|---|---|---|
| POST | `/api/auth/register` · `/login` · `/login/2fa` · `/demo` | Đăng ký / đăng nhập (có 2FA → `{ mfaRequired, mfaToken }`) / tài khoản demo → `{ token, user }` |
| GET | `/api/auth/me` · `/activity` · PUT `/preferences` · POST `/change-password` | Thông tin, lịch sử đăng nhập, tuỳ chọn, đổi mật khẩu |
| POST | `/api/auth/forgot-password` · `/reset-password` · `/verify-email` · `/resend-verification` | Quên mật khẩu, xác thực email |
| GET/POST | `/api/auth/2fa` · `/2fa/setup` · `/2fa/enable` · `/2fa/disable` · `/2fa/recovery-codes` | Xác thực 2 lớp |
| GET | `/api/market/status` · `/symbols` · `/symbols/:symbol` · `/tickers` | Nguồn giá (LIVE / SIM), danh sách cặp + bộ lọc, ticker 24h |
| GET | `/api/market/depth/:symbol` · `/trades/:symbol` · `/klines/:symbol?interval=1m\|…\|1M` | Sổ lệnh, giao dịch gần nhất, nến |
| GET | `/api/account` · `/account/nav?range=7D\|1M\|3M\|1Y\|ALL` · PUT `/account/settings` · POST `/account/reset` | Số dư + tổng tài sản ước tính, lịch sử NAV so với BTC, trả phí bằng BNB, đặt lại |
| POST | `/api/orders` · `/api/orders/oco` | Đặt lệnh (LIMIT / MARKET / LIMIT_MAKER / STOP_LOSS_LIMIT / TAKE_PROFIT_LIMIT), đặt OCO |
| GET | `/api/openOrders` · `/api/orders` · `/api/orderLists/:id` · `/api/orders/:id/events` | Lệnh mở, lịch sử lệnh, OCO, nhật ký một lệnh |
| PUT/DELETE | `/api/orders/:id` · DELETE `/api/orderLists/:id` · DELETE `/api/openOrders?symbol=` | Sửa (cancel-replace) / huỷ lệnh, huỷ OCO, huỷ tất cả theo cặp |
| GET | `/api/myTrades` · `/api/ledger` · `/api/reports/monthly?year=` | Lịch sử khớp, biến động số dư, báo cáo lãi lỗ theo tháng |
| GET/POST/PATCH/DELETE | `/api/watchlists` · `/api/watchlists/:id` · `/api/watchlists/:id/symbols[/:symbol]` | Danh sách theo dõi |
| GET/POST/DELETE | `/api/alerts` · `/api/alerts/:id` | Cảnh báo giá |
| GET | `/api/leaderboard?period=1W\|1M\|3M\|ALL` | Bảng xếp hạng (công khai) |
| GET | `/api/p2p/config` · `/api/p2p/ads?side=BUY|SELL&asset=&fiatAmount=&bank=` | Tham số + giá tham chiếu VNĐ, chợ quảng cáo (công khai) |
| GET/POST | `/api/p2p/merchant` · `/merchant/apply` · `/merchant/resign` · `/p2p/payment-methods` | Trạng thái + điều kiện thương nhân, nộp đơn / nghỉ, tài khoản nhận tiền |
| GET/POST/PATCH/DELETE | `/api/p2p/my-ads[/:id[/online]]` | Quảng cáo của thương nhân |
| GET/POST | `/api/p2p/orders[/:id[/paid|release|cancel|appeal|messages]]` | Đơn P2P và chat trong đơn |
| GET/POST | `/api/kyc` · `/kyc/level1` · `/kyc/level2` | Trạng thái KYC + hạn mức P2P, nộp hồ sơ cấp 1 / 2 |
| * | `/api/square/*` | Cộng đồng: bảng tin, bài viết, bình luận, thích, theo dõi, báo cáo, khiếu nại, thông báo ([docs/CONG-DONG.md](docs/CONG-DONG.md#6-api)) |
| GET | `/api/fees` · `/api/vip` | Biểu phí VIP (công khai), cấp VIP + tiến độ của mình |
| GET/POST/DELETE | `/api/privacy/export` · `/privacy/requests[/:id]` | Tải dữ liệu cá nhân, yêu cầu xoá tài khoản |
| GET/POST | `/api/bank` · `/bank/statement` · `/bank/lookup/:accountNo` · `/bank/transfers` | Ngân hàng giả lập |
| GET/POST | `/api/support/ai` · `/support/ai/chat` · `/support/tickets[/:id[/messages\|rate\|close]]` | Trợ lý AI, vé hỗ trợ |
| GET | `/api/health` · `/api/metrics` · `/api/system` | Sức khoẻ, Prometheus, trạng thái hệ thống + biểu phí |
| * | `/api/admin/*` | Quản trị (theo quyền nhân viên) |

Socket.io: `tickers`, `feed`, `symbols`, `system` (mọi client); `depth`, `trades`, `kline` (sau khi gửi `symbol:subscribe`); `order`, `fill`, `account`, `alert`, `support`, `p2p` (riêng người dùng, xác thực bằng `auth.token`); `support:staff`, `p2p:staff` (nhân viên).

## Cấu trúc thư mục

```
vnstock-sim/
├─ shared/src/                decimal, market, orders, filters, rules (phí), account, permissions, priceControl, support
├─ backend/
│  ├─ migrations/             001 … 100 (bản chứng khoán cũ), 200_crypto_spot … 250 (tự chạy khi khởi động)
│  ├─ src/market/             binance/ (REST, WS), simFeed, marketService, symbols (+ fallbackSymbols.json)
│  ├─ src/trading/            SpotEngine, wallet, account, orderEvents, priceAlerts, DTO
│  ├─ src/portfolio/          NAV hằng ngày (USDT), bảng xếp hạng, báo cáo lãi lỗ theo tháng
│  ├─ src/kyc/                KYC theo cấp (KycService), quét AML, route khách
│  ├─ src/p2p/                chợ P2P (P2PService), ngân hàng giả lập, khiếu nại ở khu CSKH, thương nhân mẫu (dev)
│  ├─ src/support/            CSKH, trợ lý AI (Claude API)
│  ├─ src/admin/              API quản trị, phân quyền, duyệt 2 người, giá điều chỉnh, đối soát, sao lưu / khôi phục
│  ├─ src/ops/                metrics, cảnh báo, email tổng hợp khớp lệnh
│  ├─ src/lib/                auth, totp (2FA), mã hoá, email
│  ├─ src/routes/             auth, market, trading, community, watchlists, alerts, support
│  ├─ scripts/                loadtest.ts, backup.ts, update-symbols.ts
│  └─ test/                   vitest (PGlite hoặc TEST_DATABASE_URL)
├─ frontend/src/
│  ├─ pages/                  Landing, Markets, Trade, Wallet, History, Leaderboard, Support, SupportDesk, Admin, Auth, pháp lý
│  ├─ components/             trade, chart, portfolio, landing, support, admin, auth, layout, common
│  ├─ store/                  zustand (market, auth, ui)
│  ├─ hooks/ lib/             realtime socket, api, queries, format
│  └─ **/*.test.ts(x)         vitest + Testing Library (jsdom)
├─ deploy/ Dockerfile docker-compose.yml   triển khai (xem docs/DEPLOY.md)
└─ .github/workflows/ci.yml   test PGlite + PostgreSQL 16, build Docker
```
