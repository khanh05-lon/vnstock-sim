-- Lệnh thị trường của HNX: MTL (phần dư thành LO), MOK (khớp toàn bộ hoặc huỷ), MAK (khớp và huỷ phần dư)
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
ALTER TABLE orders ADD CONSTRAINT orders_order_type_check CHECK (order_type IN ('LO', 'MP', 'MTL', 'MOK', 'MAK', 'ATO', 'ATC'));

-- Lệnh MP trên HNX còn đang chờ (phần dư đã chuyển thành LO có giá) đổi tên thành MTL cho đúng quy định HNX
UPDATE orders SET order_type = 'MTL'
WHERE order_type = 'MP' AND status IN ('PENDING', 'PARTIAL') AND symbol IN (SELECT symbol FROM stocks WHERE exchange = 'HNX');
