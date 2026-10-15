import type { Queryable } from '../db';
import { setHolidays } from '../lib/calendar';
import type { TradingEngine } from '../trading/engine';

/** Thông báo hệ thống hiển thị cho mọi người dùng */
export interface Announcement {
  text: string;
  level: 'info' | 'warning' | 'critical';
  updatedAt: string;
}

/** Trạng thái vận hành công khai (gửi cho mọi trình duyệt) */
export interface SystemStatus {
  announcement: Announcement | null;
  tradingHalted: boolean;
  haltReason: string;
  haltedSymbols: string[];
}

const KEY_HALT = 'admin.halt';
const KEY_SYMBOLS = 'admin.halted_symbols';
const KEY_ANNOUNCEMENT = 'admin.announcement';

/**
 * Cấu hình vận hành do quản trị viên đặt, lưu trong bảng market_meta (key → JSON)
 * và giữ bản sao trong bộ nhớ để kiểm tra nhanh ở mỗi request.
 */
export class AdminStore {
  /** userId của tài khoản đang bị khoá — kiểm tra O(1) ở mọi request đã đăng nhập */
  readonly locked = new Set<string>();
  announcement: Announcement | null = null;

  constructor(
    private db: Queryable,
    private engine: TradingEngine,
  ) {}

  async load() {
    const meta = await this.db.many<{ key: string; value: unknown }>('SELECT key, value FROM market_meta WHERE key LIKE $1', ['admin.%']);
    const get = (k: string) => meta.find((m) => m.key === k)?.value;
    const halt = get(KEY_HALT) as { halted?: boolean; reason?: string } | undefined;
    this.engine.control.haltAll = !!halt?.halted;
    this.engine.control.haltReason = halt?.reason ?? '';
    this.engine.control.haltedSymbols.clear();
    for (const s of (get(KEY_SYMBOLS) as string[] | undefined) ?? []) this.engine.control.haltedSymbols.add(s);
    this.announcement = (get(KEY_ANNOUNCEMENT) as Announcement | undefined) ?? null;

    this.locked.clear();
    for (const r of await this.db.many<{ id: string }>(`SELECT id FROM users WHERE status = 'LOCKED'`)) this.locked.add(r.id);
    await this.reloadHolidays();
  }

  async reloadHolidays() {
    const rows = await this.db.many<{ d: string }>('SELECT holiday_date::text AS d FROM market_holidays');
    setHolidays(rows.map((r) => r.d));
  }

  status(): SystemStatus {
    return {
      announcement: this.announcement,
      tradingHalted: this.engine.control.haltAll,
      haltReason: this.engine.control.haltReason,
      haltedSymbols: [...this.engine.control.haltedSymbols].sort(),
    };
  }

  private async save(key: string, value: unknown) {
    await this.db.many(
      `INSERT INTO market_meta (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  }

  async setHalt(halted: boolean, reason: string) {
    this.engine.control.haltAll = halted;
    this.engine.control.haltReason = halted ? reason : '';
    await this.save(KEY_HALT, { halted, reason: this.engine.control.haltReason });
  }

  async setSymbolHalt(symbol: string, halted: boolean) {
    if (halted) this.engine.control.haltedSymbols.add(symbol);
    else this.engine.control.haltedSymbols.delete(symbol);
    await this.save(KEY_SYMBOLS, [...this.engine.control.haltedSymbols]);
  }

  async setAnnouncement(a: Announcement | null) {
    this.announcement = a;
    await this.save(KEY_ANNOUNCEMENT, a);
  }
}
