import { RULES, applyRules, type RulesPatch, type TradingRules } from '@vss/shared';
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
  /** Đang bảo trì (vd. khôi phục dữ liệu): API tạm từ chối mọi thao tác */
  maintenance: string | null;
  /** Quy tắc giao dịch đang áp dụng (phí, thuế, biên độ...) — giao diện dùng để tính trước */
  rules: TradingRules;
}

const KEY_HALT = 'admin.halt';
const KEY_SYMBOLS = 'admin.halted_symbols';
const KEY_ANNOUNCEMENT = 'admin.announcement';
const KEY_RULES = 'admin.rules';

/** Ghép 2 bản chỉnh quy tắc (các nhóm con như biên độ theo sàn được ghép từng khoá) */
export function mergeRulesPatch(a: RulesPatch, b: RulesPatch): RulesPatch {
  return {
    ...a,
    ...b,
    ...(a.priceLimitPct || b.priceLimitPct ? { priceLimitPct: { ...a.priceLimitPct, ...b.priceLimitPct } } : {}),
    ...(a.maxOrderQty || b.maxOrderQty ? { maxOrderQty: { ...a.maxOrderQty, ...b.maxOrderQty } } : {}),
    ...(a.margin || b.margin ? { margin: { ...a.margin, ...b.margin } } : {}),
  };
}

/**
 * Cấu hình vận hành do quản trị viên đặt, lưu trong bảng market_meta (key → JSON)
 * và giữ bản sao trong bộ nhớ để kiểm tra nhanh ở mỗi request.
 */
export class AdminStore {
  /** userId của tài khoản đang bị khoá — kiểm tra O(1) ở mọi request đã đăng nhập */
  readonly locked = new Set<string>();
  announcement: Announcement | null = null;
  /** Các tham số quản trị viên đã chỉnh so với mặc định */
  rulesPatch: RulesPatch = {};
  /** Lý do bảo trì (chỉ trong bộ nhớ — khởi động lại là hết) */
  maintenance: string | null = null;

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
    this.rulesPatch = (get(KEY_RULES) as RulesPatch | undefined) ?? {};
    try {
      applyRules(this.rulesPatch);
    } catch (err) {
      console.error('[admin] tham số giao dịch đã lưu không hợp lệ — dùng mặc định', err);
      this.rulesPatch = {};
      applyRules({});
    }

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
      maintenance: this.maintenance,
      rules: JSON.parse(JSON.stringify(RULES)),
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

  /** Chỉnh tham số giao dịch (ném lỗi nếu kết quả không hợp lệ — khi đó giữ nguyên tham số cũ) */
  async setRules(patch: RulesPatch | null) {
    const next = patch == null ? {} : mergeRulesPatch(this.rulesPatch, patch);
    applyRules(next);
    this.rulesPatch = next;
    await this.save(KEY_RULES, next);
  }
}
