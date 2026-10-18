import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';
import { ORDER_STATUS_LABEL, type FillDTO, type MarketStatus, type OrderDTO, type SymbolRow, type Ticker24h } from '@vss/shared';
import type { SystemStatus } from '../lib/admin';
import { api } from '../lib/api';
import { fmtPrice, fmtQty } from '../lib/format';
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

const loadSymbols = () => api<SymbolRow[]>('/market/symbols').then((rows) => useMarket.getState().setInitial(rows));

/** Kết nối realtime: ticker 24h, nguồn dữ liệu, sự kiện lệnh / khớp / ví của người dùng */
export function useRealtime() {
  const token = useAuth((s) => s.token);
  const qc = useQueryClient();

  useEffect(() => {
    let alive = true;
    const load = () => loadSymbols().catch(() => setTimeout(() => alive && load(), 3000));
    void load();
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
      void loadSymbols().catch(() => undefined);
    });
    s.on('disconnect', (reason) => {
      m.setConnected(false);
      // Máy chủ chủ động ngắt (vd. tài khoản vừa bị khoá) → kết nối lại để nhận lý do từ máy chủ
      if (reason === 'io server disconnect') s.connect();
    });
    s.on('tickers', (list: Ticker24h[]) => useMarket.getState().applyTickers(list));
    s.on('feed', (x: MarketStatus) => useMarket.getState().setStatus(x));
    // Quản trị viên đổi trạng thái vận hành (tạm ngừng nhận lệnh, thông báo) → cập nhật banner ngay
    s.on('system', (x: SystemStatus) => qc.setQueryData(['system'], x));
    // Danh sách cặp thay đổi (thêm / gỡ / tạm ngừng) → tải lại
    s.on('symbols', () => void loadSymbols().catch(() => undefined));
    // Tài khoản bị khoá: máy chủ từ chối kết nối realtime → đăng xuất
    s.on('connect_error', (err: Error) => {
      if (token && /bị khoá/.test(err.message)) {
        toast.error(err.message);
        useAuth.getState().logout();
      }
    });

    s.on('order', (o: OrderDTO) => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      const info = useMarket.getState().rows[o.symbol];
      if (o.status === 'EXPIRED' && o.reason) toast.message(`Lệnh ${o.side === 'BUY' ? 'mua' : 'bán'} ${o.symbol} hết hiệu lực`, { description: o.reason });
      if (o.status === 'CANCELED' && o.reason && !/Đã sửa lệnh/.test(o.reason)) toast.warning(`Lệnh ${o.symbol} đã bị huỷ`, { description: o.reason });
      if (o.status === 'NEW' && o.stopPrice && o.isWorking && o.executedQty === '0' && o.type !== 'LIMIT_MAKER') {
        toast.info(`Lệnh dừng ${o.symbol} đã kích hoạt`, { description: `Giá kích hoạt ${fmtPrice(o.stopPrice, info?.filters.tickSize)}` });
      }
      if (o.status === 'FILLED' && o.type === 'MARKET') {
        toast.success(`${ORDER_STATUS_LABEL.FILLED}: ${o.side === 'BUY' ? 'mua' : 'bán'} ${fmtQty(o.executedQty, info?.filters.stepSize)} ${info?.baseAsset ?? ''}`, {
          description: `Giá trung bình ${fmtPrice(o.avgPrice, info?.filters.tickSize)}`,
          id: `fill-${o.id}`,
        });
      }
    });
    s.on('fill', (f: FillDTO) => {
      const info = useMarket.getState().rows[f.symbol];
      // Lệnh khớp nhiều mức giá: cùng id thông báo → chỉ hiện 1 thông báo (lần khớp mới nhất) cho mỗi lệnh
      toast.success(`Khớp ${f.side === 'BUY' ? 'MUA' : 'BÁN'} ${fmtQty(f.qty, info?.filters.stepSize)} ${info?.baseAsset ?? f.symbol} @ ${fmtPrice(f.price, info?.filters.tickSize)}`, {
        description: `Phí ${f.commission} ${f.commissionAsset}${f.isMaker ? ' (maker)' : ' (taker)'}`,
        id: `fill-${f.orderId}`,
      });
      void qc.invalidateQueries({ queryKey: ['trades'] });
    });
    // Cảnh báo giá kích hoạt (báo 1 lần)
    s.on('alert', (ev: { alert: { symbol: string }; message: string }) => {
      toast.info(`Cảnh báo giá ${ev.alert.symbol}`, { description: ev.message, duration: 20_000 });
      void qc.invalidateQueries({ queryKey: ['alerts'] });
    });
    s.on('account', () => {
      void qc.invalidateQueries({ queryKey: ['account'] });
      void qc.invalidateQueries({ queryKey: ['ledger'] });
    });
    // Hỗ trợ khách hàng: khách nhận tin trả lời / thay đổi trạng thái yêu cầu
    s.on('support', (ev: { ticketId: number; kind: string }) => {
      void qc.invalidateQueries({ queryKey: ['support'] });
      const viewing = location.pathname === '/ho-tro' && new URLSearchParams(location.search).get('ticket') === String(ev.ticketId);
      if (ev.kind === 'message' && !viewing) toast.info(`CSKH vừa trả lời yêu cầu #${ev.ticketId}`, { description: 'Mở mục Hỗ trợ để xem', duration: 10_000 });
    });
    // Đơn P2P / quảng cáo / tư cách thương nhân thay đổi. Đang mở đúng đơn đó thì trang tự cập nhật, không cần thông báo
    s.on('p2p', (ev: { orderId?: number; kind: string }) => {
      void qc.invalidateQueries({ queryKey: ['p2p'] });
      void qc.invalidateQueries({ queryKey: ['bank'] });
      if (!ev.orderId || location.pathname === `/p2p/don/${ev.orderId}`) return;
      const text: Record<string, string> = {
        created: 'Có đơn P2P mới',
        paid: 'Người mua đã báo thanh toán, kiểm tra tiền về rồi nhả coin',
        completed: 'Đơn P2P đã hoàn tất',
        expired: 'Đơn P2P đã huỷ do hết thời hạn thanh toán',
        cancelled: 'Đơn P2P đã bị huỷ',
        appeal: 'Đơn P2P đang khiếu nại',
        resolved: 'Khiếu nại P2P đã được phân xử',
        message: 'Tin nhắn mới trong đơn P2P',
      };
      if (text[ev.kind]) {
        toast.info(`${text[ev.kind]} (#${ev.orderId})`, {
          id: `p2p-${ev.orderId}-${ev.kind}`,
          duration: 10_000,
          action: { label: 'Mở đơn', onClick: () => location.assign(`/p2p/don/${ev.orderId}`) },
        });
      }
    });
    s.on('p2p:staff', (ev: { orderId: number; kind: string }) => {
      void qc.invalidateQueries({ queryKey: ['desk-p2p'] });
      if (ev.kind === 'appeal') toast.warning(`Khiếu nại P2P mới #${ev.orderId}`, { description: 'Mở khu vực CSKH → Khiếu nại P2P', duration: 10_000 });
    });
    // Nhân viên CSKH: yêu cầu mới / tin nhắn mới của khách
    s.on('support:staff', (ev: { ticketId: number; kind: string }) => {
      void qc.invalidateQueries({ queryKey: ['desk'] });
      if (ev.kind === 'created') toast.warning(`Yêu cầu hỗ trợ mới #${ev.ticketId}`, { description: 'Mở khu vực CSKH để tiếp nhận', duration: 10_000 });
    });

    for (const fn of listeners) fn(s);
    return () => {
      s.removeAllListeners();
      s.disconnect();
      if (socket === s) socket = null;
    };
  }, [token, qc]);
}
