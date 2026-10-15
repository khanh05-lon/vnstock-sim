import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import type { Candle, TradeTick } from '@vss/shared';
import { onSocket } from './useRealtime';

/** Theo dõi giao dịch khớp và nến 1 phút realtime của 1 mã */
export function useSymbolFeed(symbol: string, handlers: { onTrades?(t: TradeTick[]): void; onCandle?(c: Candle): void }) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    let current: Socket | null = null;
    const onTrades = (list: TradeTick[]) => {
      if (list[0]?.symbol === symbol) ref.current.onTrades?.(list);
    };
    const onCandle = (x: { symbol: string; candle: Candle }) => {
      if (x.symbol === symbol) ref.current.onCandle?.(x.candle);
    };
    const subscribe = () => current?.emit('symbol:subscribe', symbol);
    const detach = (s: Socket) => {
      s.off('trades', onTrades);
      s.off('candle', onCandle);
      s.off('connect', subscribe);
    };
    const off = onSocket((s) => {
      if (current && current !== s) detach(current);
      current = s;
      s.on('trades', onTrades);
      s.on('candle', onCandle);
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
