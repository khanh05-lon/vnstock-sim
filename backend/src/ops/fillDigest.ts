import type { TradeDTO } from '@vss/shared';
import type { Database } from '../db';
import { fillDigestEmail, type FillLine } from '../lib/emails';
import { log } from '../lib/logger';
import type { Mailer } from '../lib/mailer';

/**
 * Email thông báo khớp lệnh (người dùng bật trong Cài đặt): gom các lần khớp trong 1 phút thành 1 email
 * để không gửi hàng chục email khi lệnh khớp làm nhiều lần.
 */
export class FillDigest {
  private buf = new Map<string, FillLine[]>();
  private timer: NodeJS.Timeout | null = null;
  /** userId → { bật?, email, tên, thời điểm đọc } */
  private prefs = new Map<string, { on: boolean; email: string; name: string; at: number }>();

  constructor(
    private db: Database,
    private mailer: Mailer,
    private windowMs = 60_000,
  ) {}

  push(userId: string, t: TradeDTO) {
    let list = this.buf.get(userId);
    if (!list) this.buf.set(userId, (list = []));
    list.push({ symbol: t.symbol, side: t.side, qty: t.qty, price: t.price, orderId: t.orderId });
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.windowMs);
      this.timer.unref?.();
    }
  }

  private async pref(userId: string) {
    const c = this.prefs.get(userId);
    if (c && Date.now() - c.at < 60_000) return c;
    const row = await this.db.one<{ notify_fills: boolean; email: string; full_name: string }>('SELECT notify_fills, email, full_name FROM users WHERE id = $1', [userId]);
    const v = { on: !!row?.notify_fills, email: row?.email ?? '', name: row?.full_name ?? '', at: Date.now() };
    if (this.prefs.size > 50_000) this.prefs.clear();
    this.prefs.set(userId, v);
    return v;
  }

  async flush(): Promise<number> {
    this.timer = null;
    const batch = [...this.buf.entries()];
    this.buf.clear();
    let sent = 0;
    for (const [userId, fills] of batch) {
      try {
        const p = await this.pref(userId);
        if (!p.on || !p.email) continue;
        await this.mailer.send({ to: p.email, ...fillDigestEmail(p.name, fills) });
        sent++;
      } catch (err) {
        log.error('[mail] gửi email khớp lệnh thất bại', { err, userId });
      }
    }
    return sent;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
