# VNStock Sim — ghi chú cho AI

Monorepo npm workspaces: `shared/` (quy tắc + zod), `backend/` (Express + Socket.io + PGlite), `frontend/` (React + Vite + Tailwind v4).

## Lệnh

- `npm run dev` (root) — chạy API :4000 và web :5173 (Vite proxy `/api`, `/socket.io` sang :4000)
- `npm test` — vitest backend (`backend/test`), dùng PGlite in-memory, ~15s
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
