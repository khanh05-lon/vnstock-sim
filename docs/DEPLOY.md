# Triển khai VNStock Sim lên Internet

Tài liệu này hướng dẫn đưa VNStock Sim (sàn **mô phỏng**, vốn ảo) lên một máy chủ có tên miền và HTTPS.
Cách khuyến nghị: **1 VPS + Docker Compose** (PostgreSQL + app + Caddy tự cấp chứng chỉ HTTPS).

> ⚠️ VNStock Sim chỉ dùng vốn ảo. Không dùng để nhận tiền thật của nhà đầu tư — muốn giao dịch tiền thật phải là
> công ty chứng khoán được Uỷ ban Chứng khoán Nhà nước cấp phép và kết nối hệ thống của Sở giao dịch.

## 1. Kiến trúc khi chạy thật

```
Người dùng ──HTTPS 443──▶ Caddy (tự xin/gia hạn chứng chỉ Let's Encrypt)
                              │  reverse proxy (HTTP + WebSocket)
                              ▼
                         app :4000  (Node: API + Socket.io + giao diện đã build)
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
        PostgreSQL 16 (volume pgdata)   data-service :8001 (tuỳ chọn, giá thật)
                ▲
        backup (tuỳ chọn): pg_dump mỗi ngày → ./backups
```

- Chỉ chạy **1 bản app** (trạng thái bảng giá và bộ khớp lệnh nằm trong bộ nhớ). Muốn chịu tải lớn hơn thì tăng CPU/RAM.
- Khảo sát tải (xem mục 22 tài liệu nghiệp vụ): PGlite nhúng chỉ chịu ~26–33 thao tác lệnh/giây — **production phải dùng PostgreSQL** (docker compose đã cấu hình sẵn).

## 2. Chuẩn bị

| Hạng mục | Gợi ý |
| --- | --- |
| VPS | 2 vCPU, 2–4 GB RAM, 30 GB SSD, Ubuntu 22.04/24.04 (Viettel IDC, VNPT, FPT Cloud, DigitalOcean, Vultr…) |
| Tên miền | Tạo bản ghi **A** trỏ `vnstock.ten-mien.vn` → IP của VPS (chờ DNS cập nhật vài phút) |
| Cổng mở | 22 (SSH), 80 và 443 (web). **Không** mở 4000, 5432 ra Internet |
| Email gửi đi (SMTP) | Gmail + Mật khẩu ứng dụng, Brevo, Amazon SES, Mailgun… — cần cho quên mật khẩu, xác thực email, cảnh báo |

## 3. Cài đặt lần đầu

```bash
# 1) Cài Docker trên VPS
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # đăng xuất / đăng nhập lại để có hiệu lực

# 2) Tường lửa
sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable

# 3) Lấy mã nguồn
git clone https://github.com/khanh05-lon/vnstock-sim.git && cd vnstock-sim

# 4) Cấu hình
cp .env.docker.example .env
openssl rand -hex 32   # chạy 3 lần, dán vào POSTGRES_PASSWORD, JWT_SECRET, DATA_ENCRYPTION_KEY
nano .env              # sửa DOMAIN, PUBLIC_URL, ADMIN_EMAIL, ADMIN_PASSWORD, SMTP_...

# 5) Chạy
docker compose up -d --build
docker compose ps                     # db, app, caddy đều "healthy"/"running"
curl https://vnstock.ten-mien.vn/api/health
```

Sau khi chạy:

1. Đăng nhập bằng `ADMIN_EMAIL` / `ADMIN_PASSWORD` → **đổi mật khẩu** và **bật xác thực 2 lớp** (Cài đặt tài khoản).
2. Vào **Quản trị → Thị trường**: khai báo ngày nghỉ lễ của năm, kiểm tra tham số giao dịch (phí, biên độ).
3. Thử luồng người dùng: đăng ký → nhận email xác thực → quên mật khẩu → đặt lệnh.

### Biến môi trường chính (`.env`)

| Biến | Bắt buộc | Ý nghĩa |
| --- | --- | --- |
| `DOMAIN`, `PUBLIC_URL`, `CORS_ORIGIN` | ✔ | Tên miền; `PUBLIC_URL` dùng để tạo link trong email |
| `POSTGRES_PASSWORD` | ✔ | Mật khẩu CSDL (chỉ dùng nội bộ giữa các container) |
| `JWT_SECRET` | ✔ | Khoá ký phiên đăng nhập (≥ 32 ký tự). Đổi khoá = mọi người phải đăng nhập lại |
| `DATA_ENCRYPTION_KEY` | nên có | Mã hoá khoá 2FA trong CSDL. **Mất khoá → người dùng phải bật lại 2FA** |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | ✔ | Tài khoản quản trị tạo ở lần chạy đầu |
| `MARKET_MODE` | | `REAL_HOURS` (theo giờ HOSE) hoặc `SIMULATED_24_7` |
| `MARKET_PROVIDER` | | `mock` (giả lập) hoặc `vnstock` (giá thật, xem mục 7) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | nên có | Gửi email. Để trống → nội dung email chỉ ghi ra log |
| `REQUIRE_EMAIL_VERIFICATION` | | `true` = phải xác thực email mới được đặt lệnh |
| `REQUIRE_STAFF_2FA` | | Nhân viên (quản trị, CSKH) phải bật 2FA mới vào khu vực nhân viên — mặc định bật khi `NODE_ENV=production` |
| `ADJUST_APPROVAL_USDT` | | Điều chỉnh số dư từ mức này (USDT, mặc định 1000) trở lên cần quản trị viên thứ hai duyệt |
| `METRICS_TOKEN` | | Bật `/api/metrics` (Prometheus) với header `Authorization: Bearer <token>` |
| `ALERT_EMAILS`, `ALERT_WEBHOOK_URL` | | Nơi nhận cảnh báo vận hành (mục 6); ngưỡng chỉnh bằng `ALERT_*_MS`, `ALERT_RSS_MB`, `ALERT_ERROR_RATE_PCT` |
| `BACKUP_DIR` | | Nơi ghi bản sao lưu tự động trước mỗi lần khôi phục từ trang Quản trị (mặc định `./data/backups`, trong Docker nằm trong volume `appdata`) |
| `RATE_LIMIT_API_PER_MIN`, `RATE_LIMIT_ORDERS_PER_MIN` | | Giới hạn tần suất (mặc định 600 request và 120 lệnh / phút) |
| `DEMO_EMAIL`, `DEMO_PASSWORD` | | Tài khoản demo dùng chung — để trống khi chạy thật |

Danh sách đầy đủ kèm giá trị mặc định: [`backend/.env.example`](../backend/.env.example).

### Sức chịu tải đã đo

Máy dev Windows, PostgreSQL 16, 1 tiến trình app, chế độ mô phỏng 24/7 (`npm run loadtest -w backend`):

| Người dùng đồng thời × lệnh | Thông lượng | Đặt lệnh p50 / p95 / p99 | Lỗi |
| --- | --- | --- | --- |
| 30 × 20 (900 request) | ≈ 198 request/giây | 186 / 282 / 362 ms | 0% |
| 100 × 20 (3.000 request) | ≈ 206 request/giây | 594 / 865 / 922 ms | 0% |

Thông lượng dừng ở khoảng 200 thao tác lệnh / giây vì bộ khớp lệnh xử lý tuần tự để giữ đúng thứ tự giá – thời gian;
đông người hơn thì độ trễ tăng dần chứ không lỗi. Đủ cho vài nghìn người dùng mô phỏng thông thường (mỗi người vài lệnh / phút).
PGlite (không có `DATABASE_URL`) chỉ đạt khoảng 30 thao tác / giây — chỉ dùng cho dev / demo.

## 4. Cập nhật phiên bản

```bash
cd vnstock-sim
git pull
docker compose up -d --build     # migration CSDL tự chạy khi app khởi động
docker compose logs -f app       # theo dõi tới khi thấy "[api] http://localhost:4000 ..."
```

Nên **sao lưu trước khi cập nhật** (mục 5). Quay về bản cũ: `git checkout <commit-cu> && docker compose up -d --build`
(nếu bản mới đã chạy migration thêm cột/bảng thì bản cũ vẫn chạy được; nếu không, khôi phục từ bản sao lưu).

Trong lúc app khởi động lại (~10–20 giây) Caddy giữ kết nối chờ thay vì báo lỗi; người dùng chỉ thấy bảng giá kết nối lại.

## 5. Sao lưu & khôi phục

**Tự động mỗi ngày** (khuyến nghị):

```bash
docker compose --profile backup up -d     # file ./backups/vnstock-YYYYMMDD-HHMMSS.dump, giữ BACKUP_KEEP_DAYS ngày
```

Bản sao lưu nằm cùng máy với CSDL — hãy **chép thêm ra ngoài** (Google Drive / S3 / máy khác), ví dụ bằng `rclone`
chạy theo cron: `rclone copy ./backups remote:vnstock-backups`.

**Thủ công:**

```bash
docker compose exec db pg_dump -U vnstock -Fc vnstock > vnstock-$(date +%F).dump
```

**Khôi phục toàn bộ CSDL** (mất dữ liệu phát sinh sau thời điểm sao lưu):

```bash
docker compose stop app
docker compose exec -T db pg_restore -U vnstock -d vnstock --clean --if-exists --no-owner < vnstock-2026-10-16.dump
docker compose start app
```

**Sao lưu nghiệp vụ trong trang Quản trị → Dữ liệu**: tải file JSON (người dùng, tài khoản, lệnh, khớp, danh mục, sao kê…)
và khôi phục lại từ file đó ngay trên giao diện (có chạy thử trước, tự sao lưu dữ liệu hiện tại trước khi ghi đè).
File JSON chứa mật khẩu đã băm — bảo quản như dữ liệu mật.

## 6. Giám sát & cảnh báo

| Công cụ | Cách dùng |
| --- | --- |
| `GET /api/health` | 200 = ổn, 503 = mất kết nối CSDL. Gắn vào UptimeRobot / Better Stack (miễn phí) để nhận cảnh báo khi web sập |
| `GET /api/metrics` | Định dạng Prometheus (request/giây, độ trễ, lệnh, kết nối realtime, bộ nhớ, độ trễ event loop…). Cần `METRICS_TOKEN` |
| Cảnh báo tự động | App tự kiểm tra 30 giây/lần (CSDL chậm/mất, event loop nghẽn, tỷ lệ lỗi 5xx, độ trễ cao, bộ nhớ cao, vòng lặp thị trường ngừng, mất nguồn giá thật) → gửi email `ALERT_EMAILS` và webhook `ALERT_WEBHOOK_URL` (Slack, Discord, Telegram) |
| Trang Quản trị → Giám sát | Biểu đồ chỉ số theo phút, danh sách cảnh báo đang bật / đã xử lý, nút gửi thử cảnh báo |
| Log | `docker compose logs -f app` (JSON mỗi dòng), hoặc Quản trị → Nhật ký |

Webhook Telegram: tạo bot với @BotFather, đặt
`ALERT_WEBHOOK_URL=https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>`.

## 7. Giá thật (tuỳ chọn)

```bash
# .env: MARKET_PROVIDER=vnstock, MARKET_MODE=REAL_HOURS
docker compose --profile vnstock up -d --build
```

data-service gọi API web công khai của VCI. Trước khi mở cho đông người dùng, hãy **xin phép / mua gói dữ liệu**
từ nhà cung cấp (điều khoản sử dụng dữ liệu giá là trách nhiệm của đơn vị vận hành). Mất nguồn → app tự chuyển sang giả lập
và gửi cảnh báo.

## 8. Danh sách kiểm tra bảo mật

- [ ] `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, `POSTGRES_PASSWORD` là chuỗi ngẫu nhiên, không commit lên Git (`.env` đã nằm trong `.gitignore`)
- [ ] Quản trị viên đã đổi mật khẩu mặc định và bật 2FA; có ít nhất 2 quản trị viên để duyệt điều chỉnh số dư (nguyên tắc 2 người)
- [ ] Nhân viên CSKH dùng vai trò "Nhân viên CSKH" (không cấp quyền quản trị), đã bật 2FA; có người trực khu CSKH và nhận cảnh báo "yêu cầu hỗ trợ quá hạn" qua `ALERT_EMAILS`
- [ ] Tường lửa chỉ mở 22/80/443; SSH đăng nhập bằng khoá, tắt đăng nhập mật khẩu
- [ ] SMTP thật đã cấu hình, `REQUIRE_EMAIL_VERIFICATION=true`
- [ ] Sao lưu tự động + bản chép ra ngoài máy; đã thử khôi phục ít nhất 1 lần
- [ ] Gắn giám sát `/api/health` từ bên ngoài + cấu hình `ALERT_EMAILS`
- [ ] Cập nhật hệ điều hành định kỳ (`sudo apt update && sudo apt upgrade`), cập nhật image (`docker compose pull`)
- [ ] Trang Điều khoản / Chính sách bảo mật đã được luật sư rà soát và điền thông tin đơn vị vận hành

## 9. Không dùng Docker

Cần Node ≥ 22, PostgreSQL 16, một reverse proxy (Caddy/Nginx):

```bash
npm ci && npm run build                     # build giao diện
cd backend
export NODE_ENV=production DATABASE_URL=postgres://... JWT_SECRET=... PUBLIC_URL=https://... FRONTEND_DIST=../frontend/dist TRUST_PROXY=1
npm start                                    # = node --import tsx src/index.ts
```

Chạy nền bằng systemd hoặc pm2 (`pm2 start "npm start" --name vnstock`), proxy cổng 443 → 4000 (nhớ bật WebSocket cho `/socket.io`).

## 10. Những việc cần chủ dự án quyết định

| Việc | Ghi chú |
| --- | --- |
| Tên miền, nhà cung cấp VPS | Chi phí ~150.000–400.000đ/tháng cho cấu hình gợi ý |
| Nhà cung cấp email (SMTP) | Gmail giới hạn ~500 email/ngày; dịch vụ chuyên dụng ổn định hơn |
| Chế độ thị trường | Mô phỏng 24/7 (luyện tập mọi lúc) hay theo giờ HOSE (giống thật) |
| Dùng giá thật | Cần thoả thuận sử dụng dữ liệu với nhà cung cấp |
| Pháp lý | Điều khoản, chính sách bảo mật dữ liệu cá nhân (Nghị định 13/2023/NĐ-CP) cần luật sư rà soát |
