# VNStock Sim — Sàn chứng khoán Việt Nam mô phỏng

Web chứng khoán đầy đủ chức năng ở chế độ **giao dịch ảo (paper trading)**: bảng giá realtime HOSE/HNX/UPCOM (cổ phiếu, ETF, chứng quyền, trái phiếu), biểu đồ nến chuyên nghiệp, đặt lệnh LO/MP/ATO/ATC, lô lẻ, lệnh nhiều ngày, lệnh điều kiện, khớp lệnh theo sổ lệnh, phí, thuế, thanh toán T+2, ứng trước, ký quỹ, sự kiện quyền, danh mục, biểu đồ tài sản, bảng xếp hạng và trang quản trị.
Giao diện tham khảo **SSI iBoard** (màu bảng điện VN) và **Binance** (bố cục terminal giao dịch, nền tối, typography).

> ⚠️ Mặc định toàn bộ giá, chỉ số và thông tin doanh nghiệp là **dữ liệu giả lập** phục vụ học tập. Có thể bật **giá thật** (bảng giá + nến ngày HOSE/HNX/UPCOM) bằng `MARKET_PROVIDER=vnstock` — xem [Dữ liệu thị trường thật](#dữ-liệu-thị-trường-thật-vnstock). Dù dùng nguồn nào, giao dịch đều bằng vốn ảo và không phải khuyến nghị đầu tư.

## Tính năng

| Trang | Nội dung |
|---|---|
| **Bảng giá** (`/`) | 4 thẻ chỉ số (VN-Index, VN30, HNX, UPCOM) có sparkline + độ rộng thị trường; bảng điện 3 bước giá mua/bán, khớp lệnh, tổng KL, cao/thấp, khối ngoại; nháy ô khi giá đổi; tab VN30/HOSE/HNX/UPCOM/**ETF/Chứng quyền/Trái phiếu**/Theo dõi, lọc ngành, tìm mã, sắp xếp cột |
| **Giao dịch** (`/trade/:symbol`) | Header mã (TC/trần/sàn/mở/cao/thấp/KL/GT/NN) + thông tin chứng quyền (giá thực hiện, hoà vốn, ITM/OTM) hoặc trái phiếu (coupon, lợi suất); biểu đồ nến TradingView 1m→1M + MA20/MA50 + volume; sổ lệnh có thanh độ sâu; băng khớp lệnh realtime; form **lệnh thường** (lô chẵn / lô lẻ, lệnh nhiều ngày GTD, sức mua tính cả ứng trước và ký quỹ) và **lệnh điều kiện** (cắt lỗ, chốt lời, OCO, trailing stop, mua khi vượt đỉnh, bắt đáy); sửa & huỷ lệnh |
| **Thị trường** (`/market`) | Biểu đồ chỉ số trong ngày/3T/1N/tất cả; độ rộng từng sàn; **heatmap treemap** theo ngành (diện tích = vốn hoá); top tăng/giảm/GTGD/khối ngoại; hiệu suất ngành |
| **Tài sản** (`/portfolio`) | NAV (gồm tiền chờ về, quyền chờ nhận, trừ nợ vay), **biểu đồ lợi nhuận so với VN-Index**; tiền & ký quỹ (ứng trước tiền bán, bật ký quỹ, tỷ lệ ký quỹ, trả nợ); quyền cổ tức / đăng ký mua phát hành thêm; danh mục, donut phân bổ, khớp gần đây; đặt lại tài khoản |
| **Xếp hạng** (`/xep-hang`) | Bảng xếp hạng lợi nhuận 1 tuần / 1 tháng / 3 tháng / toàn thời gian, tên hiển thị tự chọn hoặc che bớt, tuỳ chọn không tham gia |
| **Lịch sử** (`/history`) | Lịch sử lệnh, lịch sử khớp (kèm tổng hợp lãi/lỗ), sao kê tiền (cổ tức, lãi tiền gửi, vay / trả nợ, phí ứng…); lọc; phân trang; xuất CSV |
| **Tài khoản** | Đăng ký nhận 1 tỷ vốn ảo + **xác thực email**; **quên / đặt lại mật khẩu** qua email; **xác thực 2 lớp** (ứng dụng TOTP + 10 mã khôi phục); email tổng hợp lệnh khớp; tài khoản demo |
| **Quản trị** (`/admin`) | Xem mục [Quản trị & vận hành](#quản-trị--vận-hành) |

Thêm: giao diện **tối/sáng**, responsive mobile, thông báo khớp lệnh / gọi ký quỹ realtime, đồng hồ & trạng thái phiên.

## Công nghệ

- **Frontend**: React 18 + Vite + TypeScript + Tailwind CSS v4, React Router, TanStack Query, Zustand, Socket.io client, TradingView Lightweight Charts v5, lucide-react, sonner
- **Backend**: Node.js + Express + TypeScript (tsx), Socket.io, Zod, JWT + bcrypt, helmet, rate limit
- **CSDL**: PostgreSQL nhúng **PGlite** cho dev (chạy ngay, không cần cài đặt); **PostgreSQL 16** thật khi đặt `DATABASE_URL` (đã chạy toàn bộ test + khảo sát tải trên Postgres 16)
- **Triển khai**: Docker Compose (app + Postgres + Caddy HTTPS), CI GitHub Actions — xem [docs/DEPLOY.md](docs/DEPLOY.md)
- **Chung**: package `@vss/shared` chứa quy tắc nghiệp vụ, kiểu dữ liệu và schema validate dùng cho cả FE và BE

## Chạy nhanh

Yêu cầu Node.js ≥ 22.

```bash
npm install
cp backend/.env.example backend/.env   # rồi đổi JWT_SECRET
npm run dev
```

- Web: http://localhost:5173 · API: http://localhost:4000
- Lần chạy đầu tự tạo dữ liệu: 92 mã, ~500 phiên lịch sử, 4 chỉ số và một tài khoản demo (email/mật khẩu nằm trong `backend/.env.example`). Ở trang đăng nhập có nút **"Trải nghiệm nhanh với tài khoản demo"**.
- Xoá thư mục `backend/data` để tạo lại dữ liệu từ đầu.

Các lệnh khác:

```bash
npm test            # test backend (khớp lệnh, ký quỹ, sự kiện quyền, bảo mật…) + frontend (vitest)
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm run test -w backend   # chạy test backend trên PostgreSQL thật
npm run test:data-service   # unit test chuẩn hoá dữ liệu của data-service (Python)
npm run typecheck   # kiểm tra kiểu FE + BE
npm run build       # build frontend production
```

## Cấu hình (`backend/.env`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `MARKET_MODE` | `SIMULATED_24_7` | `SIMULATED_24_7`: thị trường chạy liên tục; `REAL_HOURS`: theo giờ HOSE (ATO 9:00–9:15, liên tục, nghỉ trưa 11:30–13:00, ATC 14:30–14:45) |
| `MARKET_PROVIDER` | `mock` | `mock`: giá giả lập; `vnstock`: giá thật qua data-service (nên dùng cùng `MARKET_MODE=REAL_HOURS`) |
| `VNSTOCK_URL` | `http://127.0.0.1:8001` | Địa chỉ data-service |
| `VNSTOCK_POLL_MS` | `3000` | Chu kỳ lấy bảng giá trong khung 8:30–15:05 (ngoài giờ: mỗi phút) |
| `VNSTOCK_STALE_MS` | `20000` | Quá thời gian này không lấy được dữ liệu thật → tự chuyển sang giả lập |
| `VNSTOCK_HISTORY_DAYS` | `500` | Số phiên nến ngày nạp từ nguồn ở lần đầu |
| `VNSTOCK_MAX_RPM` | `120` | Giới hạn số request backend gửi tới data-service mỗi phút |
| `SETTLEMENT_DAYS` | `2` | Số ngày thanh toán T+N. Đặt `0` để bán được ngay sau khi mua (tiện test) |
| `TICK_INTERVAL_MS` | `1000` | Chu kỳ cập nhật giá |
| `JWT_SECRET` | — | Khoá ký token, đặt chuỗi ngẫu nhiên dài |
| `DATA_DIR` | `./data/pgdata` | Nơi lưu CSDL |
| `DEMO_EMAIL` / `DEMO_PASSWORD` | demo | Tài khoản demo được seed (để trống để tắt) |
| `DATABASE_URL` | — | Có giá trị → PostgreSQL thật thay PGlite |
| `PUBLIC_URL`, `SMTP_*`, `MAIL_FROM` | — | Link và máy chủ gửi email (để trống: email chỉ ghi ra log) |
| `DATA_ENCRYPTION_KEY` | — | Khoá mã hoá bí mật 2FA (≥ 32 ký tự, nên đặt khi chạy thật) |
| `REQUIRE_EMAIL_VERIFICATION` | `false` | `true` = phải xác thực email mới được đặt lệnh |
| `BACKUP_DIR`, `METRICS_TOKEN`, `ALERT_EMAILS`, `ALERT_WEBHOOK_URL` | — | Sao lưu tự động trước khi khôi phục, endpoint Prometheus, nơi nhận cảnh báo |

Danh sách đầy đủ và giải thích: [`backend/.env.example`](backend/.env.example).

## Dữ liệu thị trường thật (vnstock)

Backend có 2 nguồn dữ liệu cài đặt cùng interface `MarketDataProvider` ([`backend/src/market/types.ts`](backend/src/market/types.ts)):

- **`MockProvider`** — giả lập (mặc định).
- **`RealProvider`** ([`backend/src/market/vnstock`](backend/src/market/vnstock)) — lấy bảng giá thật định kỳ từ **data-service** (FastAPI, thư mục [`data-service/`](data-service)).

Chạy (cần Python ≥ 3.10):

```bash
# trong backend/.env:  MARKET_PROVIDER=vnstock  và  MARKET_MODE=REAL_HOURS
npm run data-service:setup   # lần đầu: tạo data-service/.venv, cài fastapi + uvicorn + httpx
npm run dev:vnstock          # data-service :8001 + API :4000 + web :5173
```

Hoặc chạy riêng `npm run data-service` rồi `npm run dev`. Khi đang hiển thị giá thật, header có nhãn **"Giá thật"**; khi chạy giả lập là **"Giả lập"**. `GET /api/health` trả thêm `provider` và `feed` (`LIVE`/`SIM`).

**Nguồn dữ liệu.** data-service gọi trực tiếp API công khai của VCI (trading.vietcap.com.vn) — chính là nguồn mặc định mà thư viện Python [vnstock](https://github.com/thinh-vu/vnstock) dùng, miễn phí, không cần key. Không cài gói `vnstock` vì dự án này trên PyPI đang ở trạng thái *quarantined* (không tải được). Muốn đổi nguồn chỉ cần sửa `data-service/app/vci.py` + `normalize.py`, schema trả cho backend giữ nguyên.

| Endpoint data-service | Nội dung | Cache |
|---|---|---|
| `GET /board?symbols=FPT,HPG,…` | Bảng giá: TC/trần/sàn, mở/cao/thấp/khớp, KL & GT luỹ kế (khớp lệnh), 3 bước giá mua/bán, giá khớp ATO/ATC, khối ngoại, KL niêm yết | 2 giây |
| `GET /history?symbols=FPT,VNINDEX&days=500` | Nến ngày cổ phiếu và chỉ số (`VNINDEX`, `VN30`, `HNXINDEX`, `UPCOMINDEX`) | 30 phút |
| `GET /indices` | Giá trị 4 chỉ số (nến ngày gần nhất) | 10 giây |
| `GET /health` | Trạng thái nguồn, số request tới nguồn trong 1 phút | — |

data-service giới hạn ≤ 120 request/phút tới nguồn (`UPSTREAM_RPM`) và gộp các request trùng; backend chỉ gửi 1 request bảng giá mỗi `VNSTOCK_POLL_MS` (≈ 20 request/phút trong giờ giao dịch, 1 request/phút ngoài giờ).

**Cách RealProvider dùng dữ liệu thật**

- Lần đầu chạy (hoặc khi CSDL đang chứa lịch sử giả lập) nạp ~500 phiên nến ngày thật cho 92 mã + 4 chỉ số, thay toàn bộ lịch sử giả lập; các lần sau chỉ tải bù vài phiên (đánh dấu trong bảng `market_meta`). KL niêm yết cũng cập nhật theo nguồn.
- Khởi động giữa phiên: đồng bộ thẳng trạng thái hiện tại của nguồn, không mô phỏng phần phiên đã qua. Sau đó mỗi lần KL luỹ kế tăng Δ → 1 giao dịch Δ tại giá khớp cuối (vẽ nến 1 phút, băng khớp lệnh, khớp lệnh LO của người dùng); tổng GT luôn khớp với nguồn.
- Sổ lệnh lấy từ nguồn. Lệnh người dùng "ăn" thanh khoản thì phần đã ăn được trừ khỏi các bản cập nhật sau cho tới khi mức giá đó rời sổ lệnh.
- ATO/ATC: không sinh KL giả; lệnh ATO/ATC của người dùng khớp theo giá khớp thật khi nguồn công bố (chờ tối đa 30 giây).
- TC/trần/sàn theo nguồn (đã điều chỉnh khi có quyền); VN-Index, VN30, HNX-Index, UPCOM-Index lấy giá trị thật.
- **Tự chuyển về giả lập** khi data-service lỗi hoặc quá `VNSTOCK_STALE_MS` không có dữ liệu (mô phỏng tiếp từ giá thật hiện tại); khi nguồn có lại thì đồng bộ về giá thật. Với `MARKET_MODE=SIMULATED_24_7`, ngoài giờ giao dịch (kể cả nghỉ trưa) cũng chạy giả lập.

**Giới hạn**: chỉ 92 mã trong danh mục seed (độ rộng thị trường, tổng KL/GT trên thẻ chỉ số tính theo rổ này); tên, ngành, EPS/BVPS vẫn là số liệu seed; nến 1 phút chỉ có từ lúc server chạy; dữ liệu trễ vài giây; API của VCI là API web không chính thức nên có thể thay đổi. Khi chuyển một CSDL đang dùng giả lập sang `vnstock`, nên xoá `backend/data` để danh mục/giá vốn của tài khoản cũng theo giá thật.

## Quản trị & vận hành

- Trang **Quản trị** (`/admin`, chỉ hiện với tài khoản quản trị viên) gồm 10 mục: Tổng quan · Người dùng · Lệnh giao dịch · Thị trường (tạm ngừng, ngày nghỉ, **tham số giao dịch**: phí, thuế, biên độ, tỷ lệ ký quỹ…) · Mã chứng khoán (niêm yết / huỷ niêm yết, tỷ lệ ký quỹ từng mã) · Sự kiện quyền · Ký quỹ (hạn mức vay, tài khoản bị gọi ký quỹ) · Dữ liệu & sao lưu (tải và **khôi phục** JSON, có chạy thử) · Giám sát (chỉ số theo phút, cảnh báo) · Nhật ký.
- Tài khoản quản trị đầu tiên được tạo lúc khởi động từ `ADMIN_EMAIL` / `ADMIN_PASSWORD` (giá trị mẫu cho dev nằm trong `backend/.env.example`; khi `NODE_ENV=production` bắt buộc tự đặt).
- Quản trị viên có thể: tạo / khoá / mở khoá / xoá tài khoản, cấp hoặc thu quyền, xác thực email hộ, tắt 2FA khi người dùng mất thiết bị, điều chỉnh vốn ảo, đặt lại tài khoản, huỷ hộ lệnh, tạm ngừng nhận lệnh (toàn hệ thống hoặc theo mã), đăng thông báo hệ thống, khai báo ngày nghỉ lễ, sửa tham số giao dịch (áp dụng ngay, lưu bền), thêm / huỷ niêm yết mã, nhập sự kiện quyền, cấp hạn mức ký quỹ, sao lưu / khôi phục dữ liệu, xem giám sát, nhật ký quản trị và log máy chủ. Mọi thao tác đều được ghi vào bảng `admin_audit_log`.
- Giám sát: `GET /api/health`, `GET /api/metrics` (Prometheus, cần `METRICS_TOKEN`), cảnh báo tự động 30 giây/lần gửi email + webhook. Triển khai, sao lưu, danh sách kiểm tra bảo mật: [docs/DEPLOY.md](docs/DEPLOY.md).
- Trang pháp lý mẫu: `/dieu-khoan`, `/chinh-sach-bao-mat` (bản demo, cần luật sư rà soát trước khi dùng thật).
- Khảo sát chịu tải (máy chủ local đang chạy): `npm run loadtest -w backend -- --users 30 --orders 20`. Báo cáo JSON được ghi vào `backend/data/loadtest-*.json`. PGlite đạt khoảng 26–33 thao tác lệnh / giây; PostgreSQL 16 đạt ≈ 200 thao tác / giây, 0% lỗi với 100 người dùng đồng thời (chi tiết trong [docs/DEPLOY.md](docs/DEPLOY.md#sức-chịu-tải-đã-đo)).

## Quy tắc nghiệp vụ

Định nghĩa trong [`shared/src/index.ts`](shared/src/index.ts) (cần đối chiếu quy định hiện hành nếu dùng cho mục đích khác):

- Biên độ: HOSE ±7%, HNX ±10%, UPCOM ±15% — trần làm tròn xuống, sàn làm tròn lên theo bước giá
- Bước giá cổ phiếu HOSE: < 10.000 → 10đ; 10.000–49.950 → 50đ; ≥ 50.000 → 100đ. HNX/UPCOM: 100đ. ETF / chứng quyền HOSE: 10đ; trái phiếu: 1đ
- Biên độ chứng quyền tính theo biên độ của chứng khoán cơ sở chia tỷ lệ chuyển đổi; trái phiếu ±10%
- Lô chẵn 100 CP; **lô lẻ** 1–99 CP chỉ đặt LO, khớp trên bảng lô lẻ riêng (không ăn sổ lệnh lô chẵn, không tham gia ATO/ATC); tối đa 500.000 CP/lệnh (HOSE), 1.000.000 (HNX/UPCOM)
- **Lệnh nhiều ngày (GTD)**: chỉ LO, tối đa 30 ngày; đầu mỗi ngày kiểm tra lại biên độ mới, ngoài biên độ thì huỷ
- **Lệnh điều kiện**: dừng (STOP), chạm giá (LIT), trailing stop theo %, cặp OCO; kiểm tra theo giá khớp trong phiên liên tục, kích hoạt thì đặt lệnh thật (MP, hoặc LO trần/sàn với UPCOM và lô lẻ); hiệu lực tối đa 90 ngày
- Loại lệnh: HOSE `LO/MP/ATO/ATC`, HNX `LO/MP/ATC`, UPCOM `LO`
- Phí 0,15% mỗi chiều, thuế TNCN 0,1% khi bán; giá vốn bao gồm phí mua. Phí / thuế được chốt theo từng lệnh lúc đặt, đổi tham số không ảnh hưởng lệnh đang chờ
- Lệnh mua phong toả `giá × KL + phí` (MP/ATO/ATC phong toả theo giá trần); lệnh bán phong toả cổ phiếu
- Lệnh MP quét tối đa 3 bước giá, phần dư chuyển thành LO cao/thấp hơn 1 bước giá; không có đối ứng thì huỷ
- Cuối phiên, lệnh chưa khớp hết hiệu lực và được giải phóng phong toả
- **Tiền bán về T+2** (`cash_pending`); **ứng trước** tính phí 0,04%/ngày; lệnh mua dùng lần lượt: tiền mặt → tự ứng trước (bật mặc định) → vay ký quỹ
- **Ký quỹ** (phải tự bật + xác nhận rủi ro): chỉ mã có tỷ lệ cho vay, trong hạn mức; lãi 13%/năm tính hằng ngày; tỷ lệ ký quỹ < 40% → gọi ký quỹ (email + thông báo), < 30% → huỷ lệnh mua và bán giải chấp về 50%; tiền về tự trả lãi trước, gốc sau
- **Lãi tiền gửi** 0,5%/năm trên tiền nhàn rỗi, trả vào ngày giao dịch đầu tháng
- **Sự kiện quyền**: cổ tức tiền (thuế 5%), cổ tức cổ phiếu, chia tách, quyền mua — điều chỉnh giá tham chiếu và lịch sử giá ở ngày GDKHQ, huỷ lệnh GTD / điều kiện của mã, trả vào ngày thanh toán. Chứng quyền đáo hạn thanh toán bằng tiền theo giá cơ sở bình quân 5 phiên; trái phiếu trả coupon định kỳ và gốc khi đáo hạn
- Tất cả tham số trên chỉnh được ở trang Quản trị
- Không bán khống. Tiền dùng số nguyên VNĐ (BIGINT), mọi thay đổi tiền/CP nằm trong 1 transaction có khoá dòng

## Kiến trúc

```
MockProvider ──poll()──▶ MarketService ──events──▶ Socket.io ──▶ React (Zustand store)
 (giá giả lập)     ▲     │ trạng thái giá, nến 1m,        board / indices / trades / candle
RealProvider ──────┘     │
 │ (giá thật, tự về Mock khi lỗi)
 └─HTTP─▶ data-service (FastAPI) ──▶ VCI
                         │ chỉ số, phiên, rollover ngày
                         └─hooks──▶ TradingEngine ──▶ PGlite / PostgreSQL
                                    │ đặt/sửa/huỷ, khớp lệnh, T+2      ▲
                                    ├ ConditionalEngine (lệnh điều kiện)│
                                    ├ MarginService (ký quỹ, lãi, giải chấp)
                                    ├ CorporateService (sự kiện quyền, CW, TP)
                                    └ NavService (NAV cuối ngày, xếp hạng)
Express REST /api/* ─────────────────────────────────────────────────┘
```

- **Nguồn dữ liệu**: chọn bằng `MARKET_PROVIDER` (`createProvider` trong `backend/src/index.ts`). Muốn thêm nguồn khác (SSI FastConnect, DNSE…) chỉ cần cài đặt `MarketDataProvider` hoặc thay phần gọi nguồn trong data-service.
- **PostgreSQL thật / Supabase**: đặt `DATABASE_URL` — `Database` trong `backend/src/db.ts` tự dùng client `pg` (giao diện `many/one/exec/tx` giữ nguyên), migration `backend/migrations/*.sql` tự chạy khi khởi động.

### Sơ đồ dữ liệu

```mermaid
erDiagram
  users ||--|| accounts : has
  users ||--o{ orders : places
  users ||--o{ trades : owns
  users ||--o{ holdings : holds
  users ||--o{ settlement_lots : awaits
  users ||--o{ transactions_ledger : records
  users ||--o{ watchlists : watches
  users ||--o{ conditional_orders : sets
  users ||--o{ cash_settlements : awaits
  users ||--o{ nav_daily : snapshots
  users ||--o{ ca_entitlements : entitled
  corporate_actions ||--o{ ca_entitlements : creates
  stocks ||--o| warrants : "CW"
  stocks ||--o| bonds : "BOND"
  orders ||--o{ trades : fills
  stocks ||--o{ ohlcv_daily : has
  stocks ||--o{ ohlcv_intraday : has
  stocks ||--|| price_snapshots : state
  accounts { bigint cash_balance bigint cash_hold bigint cash_pending bigint loan_balance bigint loan_interest bigint initial_capital }
  orders { text side text order_type bigint price int qty int filled_qty text status bigint hold_amount }
  holdings { int qty_total int qty_available int qty_hold int qty_pending bigint total_cost }
```

## API

| Method | Đường dẫn | Mô tả |
|---|---|---|
| POST | `/api/auth/register` · `/login` · `/login/2fa` · `/demo` | Đăng ký / đăng nhập (có 2FA → `{ mfaRequired, mfaToken }`, gửi tiếp mã ở `/login/2fa`) / tài khoản demo → `{ token, user }` |
| GET | `/api/auth/me` · PUT `/api/auth/preferences` · POST `/api/auth/change-password` | Thông tin / tuỳ chọn (email khớp lệnh, tên hiển thị, xếp hạng) / đổi mật khẩu |
| POST | `/api/auth/forgot-password` · `/reset-password` · `/verify-email` · `/resend-verification` | Quên mật khẩu, xác thực email |
| GET/POST | `/api/auth/2fa` · `/2fa/setup` · `/2fa/enable` · `/2fa/disable` · `/2fa/recovery-codes` | Xác thực 2 lớp |
| GET | `/api/market/session` · `/stocks` · `/stocks/:symbol` · `/indices` | Phiên, bảng giá, chi tiết mã (kèm khớp gần nhất), chỉ số |
| GET | `/api/market/stocks/:symbol/candles?tf=1m\|5m\|15m\|1h\|1D\|1W\|1M` | Nến |
| GET | `/api/market/indices/:code/history?tf=1m\|1D` | Lịch sử chỉ số |
| GET | `/api/account` · `/api/portfolio` · `/api/portfolio/nav?range=` · POST `/api/account/reset` | Tài khoản, danh mục, lịch sử NAV + VN-Index, đặt lại |
| GET/POST | `/api/account/advance` · PUT `/api/account/settings` | Xem / ứng trước tiền bán, bật tắt tự ứng |
| POST | `/api/account/margin` · `/api/account/margin/repay` · GET `/api/account/buying-power?symbol&price` | Bật ký quỹ, trả nợ, sức mua theo mã |
| GET/POST | `/api/orders?scope=open\|today\|all` | Danh sách / đặt lệnh (`validUntil` cho lệnh nhiều ngày) |
| PATCH/DELETE | `/api/orders/:id` | Sửa / huỷ lệnh |
| GET/POST/DELETE | `/api/conditional-orders` | Lệnh điều kiện |
| GET | `/api/corporate-actions` · `/api/entitlements` · POST `/api/corporate-actions/:id/subscribe` | Sự kiện quyền, quyền được nhận, đăng ký mua |
| GET | `/api/leaderboard?period=1W\|1M\|3M\|ALL` | Bảng xếp hạng (công khai) |
| GET | `/api/health` · `/api/metrics` · `/api/system` | Sức khoẻ, Prometheus, trạng thái hệ thống + tham số giao dịch |
| * | `/api/admin/*` | Quản trị (chỉ ADMIN) |
| GET | `/api/trades` · `/api/ledger` | Lịch sử khớp, sao kê (lọc `from`, `to`, `symbol`, `side`) |
| GET/POST/DELETE | `/api/watchlist` | Danh sách theo dõi |

Socket.io: `board`, `indices`, `session`, `symbols`, `system` (mọi client); `trades`, `candle` (sau khi `symbol:subscribe`); `order`, `fill`, `account`, `conditional`, `margin` (riêng người dùng, xác thực bằng `auth.token`).

## Cấu trúc thư mục

```
vnstock-sim/
├─ data-service/              FastAPI lấy bảng giá + nến ngày thật (app/vci.py, app/normalize.py, tests/)
├─ shared/src/index.ts        quy tắc giá, kiểu, schema zod dùng chung
├─ backend/
│  ├─ migrations/             001_init … 080_margin_cash (tự chạy khi khởi động)
│  ├─ src/market/             MockProvider, MarketService (giá, nến, chỉ số, phiên); instruments.ts (ETF/CW/TP); vnstock/ = RealProvider
│  ├─ src/trading/            TradingEngine (khớp lệnh, lô lẻ, GTD, T+2), conditional.ts, margin.ts, cash.ts, DTO
│  ├─ src/corporate/          sự kiện quyền, đáo hạn chứng quyền / trái phiếu
│  ├─ src/portfolio/          NAV hằng ngày, bảng xếp hạng
│  ├─ src/ops/                metrics, cảnh báo, email tổng hợp khớp lệnh
│  ├─ src/admin/              API quản trị, sao lưu / khôi phục
│  ├─ src/lib/                auth, totp (2FA), mã hoá, email, lịch nghỉ
│  ├─ src/routes/             auth, market, trading, corporate, community
│  ├─ src/seed/               danh sách mã, sinh lịch sử, tài khoản demo
│  ├─ scripts/                loadtest.ts, backup.ts (sao lưu / khôi phục bằng dòng lệnh)
│  └─ test/                   vitest (PGlite hoặc TEST_DATABASE_URL)
├─ frontend/src/
│  ├─ pages/                  Board, Trade, Market, Portfolio, History, Leaderboard, Admin, Auth, quên / đặt lại mật khẩu, xác thực email, pháp lý
│  ├─ components/             board, trade, chart, market, portfolio, admin, auth, layout, common
│  ├─ store/                  zustand (market, auth, ui/ticket)
│  ├─ hooks/ lib/             realtime socket, api, queries, format, instruments
│  └─ **/*.test.ts(x)         vitest + Testing Library (jsdom)
├─ deploy/ Dockerfile docker-compose.yml   triển khai (xem docs/DEPLOY.md)
└─ .github/workflows/ci.yml   test PGlite + PostgreSQL 16, data-service, build Docker
```
