import type { Server } from 'socket.io';
import type { DepthSnapshot, FillDTO, Kline, MarketStatus, OrderDTO, Ticker24h, TradeTick } from '@vss/shared';
import { isTokenCurrent, verifyToken } from './lib/auth';
import type { MarketService } from './market/marketService';

/**
 * Sự kiện realtime:
 *  - tickers : Ticker24h[] các cặp thay đổi (mọi client, tối đa 1 lần / giây)
 *  - feed    : MarketStatus (LIVE ⇄ SIM)
 *  - symbols : danh sách cặp thay đổi → client tải lại
 *  - depth / trades / kline : của cặp đang xem (room sym:XXX, client gửi 'symbol:subscribe')
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
    socket.emit('feed', market.status());

    socket.on('symbol:subscribe', (sym: unknown) => {
      if (typeof sym !== 'string') return;
      const s = sym.toUpperCase();
      if (!market.info(s)) return;
      void socket.join(`sym:${s}`);
      const d = market.depth(s);
      if (d) socket.emit('depth', d);
    });
    socket.on('symbol:unsubscribe', (sym: unknown) => {
      if (typeof sym === 'string') void socket.leave(`sym:${sym.toUpperCase()}`);
    });
  });

  market.on('tickers', (list: Ticker24h[]) => io.emit('tickers', list));
  market.on('feed', (s: MarketStatus) => io.emit('feed', s));
  market.on('symbols', () => io.emit('symbols'));
  market.on('depth', (d: DepthSnapshot) => io.to(`sym:${d.symbol}`).emit('depth', d));
  market.on('trades', (ticks: TradeTick[]) => {
    const by = new Map<string, TradeTick[]>();
    for (const t of ticks) {
      const list = by.get(t.symbol);
      if (list) list.push(t);
      else by.set(t.symbol, [t]);
    }
    for (const [sym, list] of by) io.to(`sym:${sym}`).emit('trades', list);
  });
  market.on('klines', (items: { symbol: string; kline: Kline }[]) => {
    for (const it of items) io.to(`sym:${it.symbol}`).emit('kline', it);
  });
}

export interface Notifier {
  order(userId: string, order: OrderDTO): void;
  fill(userId: string, fill: FillDTO): void;
  account(userId: string): void;
}

export const noopNotifier: Notifier = { order() {}, fill() {}, account() {} };

export function socketNotifier(io: Server, onFill?: (userId: string, fill: FillDTO) => void): Notifier {
  return {
    order: (userId, order) => io.to(`user:${userId}`).emit('order', order),
    fill: (userId, fill) => {
      io.to(`user:${userId}`).emit('fill', fill);
      onFill?.(userId, fill);
    },
    account: (userId) => io.to(`user:${userId}`).emit('account'),
  };
}
