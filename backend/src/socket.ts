import type { Server } from 'socket.io';
import type { Candle, IndexSnapshot, SessionInfo, StockSnapshot, TradeDTO, TradeTick } from '@vss/shared';
import { isTokenCurrent, verifyToken } from './lib/auth';
import type { MarketService } from './market/marketService';
import type { Notifier } from './trading/engine';

/**
 * Sự kiện realtime:
 *  - board    : StockSnapshot[] các mã thay đổi (gửi tất cả client)
 *  - indices  : IndexSnapshot[]
 *  - session  : SessionInfo
 *  - trades   : TradeTick[] của mã đang theo dõi (room sym:XXX)
 *  - candles  : { symbol, candle } nến 1 phút đang chạy (room sym:XXX)
 *  - order / fill / account : sự kiện riêng của người dùng (room user:ID)
 */
export function attachSocket(io: Server, market: MarketService) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const user = typeof token === 'string' && token ? verifyToken(token) : null;
    if (!user) return next();
    // Token phát hành trước lần đổi mật khẩu gần nhất → kết nối như khách (không nhận sự kiện riêng)
    isTokenCurrent(user).then(
      (ok) => {
        if (ok) socket.data.user = { id: user.id, email: user.email };
        next();
      },
      () => next(),
    );
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as { id: string } | undefined;
    if (user) void socket.join(`user:${user.id}`);
    socket.emit('session', market.session());

    socket.on('symbol:subscribe', (sym: unknown) => {
      if (typeof sym !== 'string') return;
      const s = sym.toUpperCase();
      if (market.quote(s)) void socket.join(`sym:${s}`);
    });
    socket.on('symbol:unsubscribe', (sym: unknown) => {
      if (typeof sym === 'string') void socket.leave(`sym:${sym.toUpperCase()}`);
    });
  });

  market.on('board', (rows: StockSnapshot[]) => io.emit('board', rows));
  market.on('indices', (rows: IndexSnapshot[]) => io.emit('indices', rows));
  market.on('session', (s: SessionInfo) => io.emit('session', s));
  // Danh mục mã thay đổi (niêm yết mới, huỷ niêm yết, đổi rổ VN30...) → client tải lại bảng giá
  market.on('symbols', () => io.emit('symbols'));
  market.on('trades', (ticks: TradeTick[]) => {
    const by = new Map<string, TradeTick[]>();
    for (const t of ticks) {
      const list = by.get(t.symbol);
      if (list) list.push(t);
      else by.set(t.symbol, [t]);
    }
    for (const [sym, list] of by) io.to(`sym:${sym}`).emit('trades', list);
  });
  market.on('candles', (items: { symbol: string; candle: Candle }[]) => {
    for (const it of items) io.to(`sym:${it.symbol}`).emit('candle', it);
  });
}

export function socketNotifier(io: Server, onFill?: (userId: string, trade: TradeDTO) => void): Notifier {
  return {
    order: (userId, order) => io.to(`user:${userId}`).emit('order', order),
    trade: (userId, trade) => {
      io.to(`user:${userId}`).emit('fill', trade);
      onFill?.(userId, trade);
    },
    account: (userId) => io.to(`user:${userId}`).emit('account'),
  };
}
