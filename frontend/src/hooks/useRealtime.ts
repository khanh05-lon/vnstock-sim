import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';
import { conditionalLabel, type ConditionalOrderDTO, type IndexSnapshot, type OrderDTO, type SessionInfo, type StockRow, type StockSnapshot, type TradeDTO } from '@vss/shared';
import type { SystemStatus } from '../lib/admin';
import { api } from '../lib/api';
import { fmtInt, fmtPrice } from '../lib/format';
import { useAuth } from '../store/auth';
import { useMarket } from '../store/market';

let socket: Socket | null = null;
const listeners = new Set<(s: Socket) => void>();

/** Socket dùng chung toàn app */
export function getSocket(): Socket | null {
  return socket;
}

export function onSocket(fn: (s: Socket) => void): () => void {
  listeners.add(fn);
  if (socket) fn(socket);
  return () => listeners.delete(fn);
}

/** Kết nối realtime: bảng giá, chỉ số, phiên, sự kiện lệnh của người dùng */
export function useRealtime() {
  const token = useAuth((s) => s.token);
  const qc = useQueryClient();

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<StockRow[]>('/market/stocks')
        .then((rows) => alive && useMarket.getState().setInitial(rows))
        .catch(() => setTimeout(() => alive && load(), 3000));
    void load();
    api<IndexSnapshot[]>('/market/indices')
      .then((x) => useMarket.getState().setIndices(x))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const s = io({ auth: token ? { token } : {}, transports: ['websocket'] });
    socket = s;
    const m = useMarket.getState();
    s.on('connect', () => {
      m.setConnected(true);
      // đồng bộ lại toàn bảng sau khi kết nối lại
      api<StockRow[]>('/market/stocks')
        .then((rows) => useMarket.getState().setInitial(rows))
        .catch(() => undefined);
    });
    s.on('disconnect', (reason) => {
      m.setConnected(false);
      // Máy chủ chủ động ngắt (vd. tài khoản vừa bị khoá) → kết nối lại để nhận lý do từ máy chủ
      if (reason === 'io server disconnect') s.connect();
    });
    s.on('board', (rows: StockSnapshot[]) => useMarket.getState().applyBoard(rows));
    s.on('indices', (rows: IndexSnapshot[]) => useMarket.getState().setIndices(rows));
    s.on('session', (x: SessionInfo) => useMarket.getState().setSession(x));
    // Quản trị viên đổi trạng thái vận hành (tạm ngừng nhận lệnh, thông báo) → cập nhật banner ngay
    s.on('system', (x: SystemStatus) => qc.setQueryData(['system'], x));
    // Danh mục mã thay đổi (niêm yết mới / huỷ niêm yết / đổi rổ VN30) → tải lại bảng giá
    s.on('symbols', () => {
      api<StockRow[]>('/market/stocks')
        .then((rows) => useMarket.getState().setInitial(rows))
        .catch(() => undefined);
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
    });
    // Tài khoản bị khoá: máy chủ từ chối kết nối realtime → đăng xuất
    s.on('connect_error', (err: Error) => {
      if (token && /bị khoá/.test(err.message)) {
        toast.error(err.message);
        useAuth.getState().logout();
      }
    });

    s.on('order', (o: OrderDTO) => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      if (o.status === 'EXPIRED') toast.message(`Lệnh #${o.id} ${o.symbol} hết hiệu lực`);
      if (o.status === 'CANCELLED' && o.rejectReason) toast.warning(`Lệnh #${o.id}: ${o.rejectReason}`);
    });
    s.on('fill', (t: TradeDTO) => {
      const buy = t.side === 'BUY';
      toast.success(`Khớp ${buy ? 'MUA' : 'BÁN'} ${fmtInt(t.qty)} ${t.symbol} @ ${fmtPrice(t.price)}`, {
        description: `Giá trị ${fmtInt(t.value)}đ · phí ${fmtInt(t.fee)}đ${t.tax ? ` · thuế ${fmtInt(t.tax)}đ` : ''}`,
      });
      void qc.invalidateQueries({ queryKey: ['trades'] });
    });
    // Lệnh điều kiện kích hoạt / lỗi / hết hạn
    s.on('conditional', (c: ConditionalOrderDTO) => {
      void qc.invalidateQueries({ queryKey: ['conditional'] });
      const name = `${conditionalLabel(c.kind, c.side)} ${c.symbol}`;
      if (c.status === 'TRIGGERED') toast.success(`${name} đã kích hoạt`, { description: c.message ?? undefined });
      else if (c.status === 'FAILED') toast.error(`${name} kích hoạt nhưng không đặt được lệnh`, { description: c.message ?? undefined });
      else if (c.status === 'EXPIRED') toast.message(`${name} hết hiệu lực`);
      else if (c.status === 'CANCELLED' && c.message && c.message !== 'Người dùng huỷ') toast.message(`${name} đã huỷ`, { description: c.message });
    });
    // Ký quỹ: cảnh báo tỷ lệ / bán giải chấp
    s.on('margin', (ev: { status: string; message: string }) => {
      if (ev.status === 'FORCE') toast.error('Bán giải chấp ký quỹ', { description: ev.message, duration: 15_000 });
      else if (ev.status === 'CALL') toast.warning('Cảnh báo ký quỹ (margin call)', { description: ev.message, duration: 15_000 });
      else toast.success(ev.message);
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
    });
    // Cảnh báo giá kích hoạt (báo 1 lần)
    s.on('alert', (ev: { alert: { symbol: string }; message: string }) => {
      toast.info(`Cảnh báo giá ${ev.alert.symbol}`, { description: ev.message, duration: 20_000 });
      void qc.invalidateQueries({ queryKey: ['alerts'] });
    });
    s.on('account', () => {
      void qc.invalidateQueries({ queryKey: ['portfolio'] });
      void qc.invalidateQueries({ queryKey: ['ledger'] });
      void qc.invalidateQueries({ queryKey: ['entitlements'] });
      void qc.invalidateQueries({ queryKey: ['buying-power'] });
    });

    for (const fn of listeners) fn(s);
    return () => {
      s.removeAllListeners();
      s.disconnect();
      if (socket === s) socket = null;
    };
  }, [token, qc]);
}
