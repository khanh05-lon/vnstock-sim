import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import type { DepthSnapshot, Kline, TradeTick } from '@vss/shared';
import { onSocket } from './useRealtime';

/** Theo dõi realtime 1 cặp: sổ lệnh 20 mức, giao dịch thị trường, nến 1 phút đang chạy */
export function useSymbolFeed(
  symbol: string,
  handlers: { onDepth?(d: DepthSnapshot): void; onTrades?(t: TradeTick[]): void; onKline?(k: Kline): void },
) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    let current: Socket | null = null;
    const onDepth = (d: DepthSnapshot) => {
      if (d.symbol === symbol) ref.current.onDepth?.(d);
    };
    const onTrades = (list: TradeTick[]) => {
      if (list[0]?.symbol === symbol) ref.current.onTrades?.(list);
    };
    const onKline = (x: { symbol: string; kline: Kline }) => {
      if (x.symbol === symbol) ref.current.onKline?.(x.kline);
    };
    const subscribe = () => current?.emit('symbol:subscribe', symbol);
    const detach = (s: Socket) => {
      s.off('depth', onDepth);
      s.off('trades', onTrades);
      s.off('kline', onKline);
      s.off('connect', subscribe);
    };
    const off = onSocket((s) => {
      if (current && current !== s) detach(current);
      current = s;
      s.on('depth', onDepth);
      s.on('trades', onTrades);
      s.on('kline', onKline);
      s.on('connect', subscribe);
      if (s.connected) subscribe();
    });
    return () => {
      off();
      if (current) {
        current.emit('symbol:unsubscribe', symbol);
        detach(current);
      }
    };
  }, [symbol]);
}
